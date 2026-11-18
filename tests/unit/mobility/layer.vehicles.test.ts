/**
 * Слой транспорта на фейковых снимках симуляции: бюджет видимых единиц,
 * экранный LOD с гистерезисом, интерполяция между шагами, корректные bounds
 * после перемещения, настройки видимости и dispose без утечек.
 */

import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import type { MobilityTripSnapshot } from '../../../src/shared/mobility';
import {
  MOBILITY_LOD,
  MOBILITY_VEHICLE_LIFT_M,
  MobilityLayer,
  type MobilityLayerOptions,
  type MobilityView,
} from '../../../src/engine/mobility/mobilityLayer';
import { VEHICLE_DIMENSIONS } from '../../../src/city/mobility/vehicleGeometry';

function trip(overrides: Partial<MobilityTripSnapshot> = {}): MobilityTripSnapshot {
  return {
    tripId: 't1',
    variantId: 'v1',
    mode: 'bus',
    ref: '1',
    phase: 'moving',
    x: 0,
    y: 0,
    h: 0,
    heading: 0,
    speed: 8,
    delayS: 0,
    nextStop: 0,
    routeVariant: 'v1',
    drawn: false,
    ...overrides,
  };
}

function view(overrides: Partial<MobilityView> = {}): MobilityView {
  return {
    rect: { minX: -200, maxX: 200, minZ: -200, maxZ: 200 },
    time: 36000,
    worldPerPixel: 2.3,
    trips: [trip()],
    signals: [],
    step: 1,
    ...overrides,
  };
}

function vehicleMesh(layer: MobilityLayer, name: string): THREE.InstancedMesh {
  const mesh = layer.root.getObjectByName(`mobility-vehicle-${name}`);
  if (!(mesh instanceof THREE.InstancedMesh)) throw new Error(`нет батча ${name}`);
  return mesh;
}

function strideWorldPerPixel(projectedPx: number): number {
  return VEHICLE_DIMENSIONS.bus.lengthM / projectedPx;
}

describe('MobilityLayer vehicles', () => {
  it('caps visible trips at the desktop budget, keeping the nearest ones', () => {
    const trips: MobilityTripSnapshot[] = [];
    for (let index = 0; index < 25; index += 1) {
      trips.push(trip({ tripId: `t${String(index).padStart(2, '0')}`, x: -24 + index * 2, y: 0 }));
    }
    const expectedOrder = [...trips].sort((a, b) => {
      const distance = Math.abs(a.x) - Math.abs(b.x);
      if (distance !== 0) return distance;
      return a.tripId < b.tripId ? -1 : a.tripId > b.tripId ? 1 : 0;
    });
    const expected = new Set(expectedOrder.slice(0, 20).map((entry) => entry.tripId));

    const layer = new MobilityLayer();
    try {
      layer.update(0, view({ trips }));
      const stats = layer.getStats();
      expect(stats.budget).toBe(20);
      expect(stats.drawnTrips).toBe(20);
      expect(stats.hiddenByBudget).toBe(5);
      expect(new Set(stats.drawnTripIds)).toEqual(expected);
      expect(vehicleMesh(layer, 'bus').count).toBe(20);
      expect(vehicleMesh(layer, 'tram').count).toBe(0);
    } finally {
      layer.dispose();
    }
  });

  it('uses the mobile budget of 8 and can disable shadows', () => {
    const trips = Array.from({ length: 12 }, (_, index) =>
      trip({ tripId: `t${index}`, x: index * 3, y: 0 }),
    );
    const layer = new MobilityLayer({ mobile: true, shadows: false });
    try {
      layer.update(0, view({ trips }));
      const stats = layer.getStats();
      expect(stats.budget).toBe(8);
      expect(stats.drawnTrips).toBe(8);
      expect(stats.shadowsEnabled).toBe(false);
      expect(stats.shadowInstances).toBe(0);
      expect(vehicleMesh(layer, 'bus').count).toBe(8);
    } finally {
      layer.dispose();
    }
  });

  it('applies screen LOD with hysteresis instead of flickering at the threshold', () => {
    const layer = new MobilityLayer({ stepSeconds: 0.1 });
    try {
      const frame = (worldPerPixel: number) =>
        layer.update(0, view({ worldPerPixel, step: 1 }));

      // 12 м / 3.7 = 3.24 px >= enter (3.2) — показан.
      frame(strideWorldPerPixel(MOBILITY_LOD.vehicleEnterPx + 0.04));
      expect(layer.getStats().drawnTrips).toBe(1);

      // 2.67 px: между exit (2.2) и enter (3.2) — остаётся видимым (гистерезис).
      frame(strideWorldPerPixel(2.67));
      expect(layer.getStats().drawnTrips).toBe(1);

      // 2.0 px < exit — модель скрыта, но рейс виден точкой (город живой на обзоре).
      frame(strideWorldPerPixel(2.0));
      expect(vehicleMesh(layer, 'bus').count).toBe(0);
      expect(layer.getStats().dots).toBe(1);
      expect(layer.getStats().hiddenByLod).toBe(1);

      // 2.86 px: между порогами, но после скрытия не возвращается раньше enter.
      frame(strideWorldPerPixel(2.86));
      expect(vehicleMesh(layer, 'bus').count).toBe(0);
      expect(layer.getStats().dots).toBe(1);

      // 3.24 px >= enter — снова показан моделью, точка убрана.
      frame(strideWorldPerPixel(MOBILITY_LOD.vehicleEnterPx + 0.04));
      expect(vehicleMesh(layer, 'bus').count).toBe(1);
      expect(layer.getStats().dots).toBe(0);
    } finally {
      layer.dispose();
    }
  });

  it('interpolates position and heading between simulation steps', () => {
    const layer = new MobilityLayer({ stepSeconds: 0.1 });
    try {
      layer.update(0, view({ step: 1, trips: [trip({ x: 0, heading: 0 })] }));
      let matrix = new THREE.Matrix4();
      layer.update(0, view({ step: 2, trips: [trip({ x: 10, heading: Math.PI / 2 })] }));
      vehicleMesh(layer, 'bus').getMatrixAt(0, matrix);
      // Новый шаг получен, но alpha = 0: показываем предыдущую позу.
      expect(matrix.elements[12]).toBeCloseTo(0, 5);

      layer.update(0.05, view({ step: 2, trips: [trip({ x: 10, heading: Math.PI / 2 })] }));
      vehicleMesh(layer, 'bus').getMatrixAt(0, matrix);
      expect(matrix.elements[12]).toBeCloseTo(5, 3);
      expect(matrix.elements[14]).toBeCloseTo(0, 5);
      expect(matrix.elements[0]).toBeCloseTo(Math.cos(Math.PI / 4), 3);
      expect(layer.getStats().drawnTrips).toBe(1);
    } finally {
      layer.dispose();
    }
  });

  it('recomputes instanced bounds after a long move so objects are not culled away', () => {
    const layer = new MobilityLayer({ stepSeconds: 0.1 });
    const rect = { minX: -100, maxX: 900, minZ: -100, maxZ: 100 };
    try {
      layer.update(0, view({ rect, worldPerPixel: 1, step: 1, trips: [trip({ x: 0 })] }));
      layer.update(0.2, view({ rect, worldPerPixel: 1, step: 2, trips: [trip({ x: 800 })] }));
      expect(layer.getStats().drawnTrips).toBe(1);
      const mesh = vehicleMesh(layer, 'bus');
      expect(mesh.count).toBe(1);
      const bounds = mesh.boundingSphere;
      expect(bounds).not.toBeNull();
      if (!bounds) return;
      expect(bounds.containsPoint(new THREE.Vector3(800, MOBILITY_VEHICLE_LIFT_M, 0))).toBe(true);
      expect(bounds.center.x).toBeGreaterThan(780);
      expect(mesh.boundingBox?.containsPoint(new THREE.Vector3(800, MOBILITY_VEHICLE_LIFT_M, 0))).toBe(true);
    } finally {
      layer.dispose();
    }
  });

  it('hides vehicles without breaking the update loop and restores them', () => {
    const layer = new MobilityLayer();
    try {
      layer.update(0, view());
      expect(layer.getStats().drawnTrips).toBe(1);
      layer.setSettings({ vehiclesVisible: false, signalsVisible: true, debug: false, paused: false });
      layer.update(0, view());
      expect(layer.getStats().drawnTrips).toBe(0);
      const root = layer.root.getObjectByName('mobility-vehicles');
      expect(root?.visible).toBe(false);
      layer.setSettings({ vehiclesVisible: true, signalsVisible: true, debug: false, paused: false });
      layer.update(0, view());
      expect(layer.getStats().drawnTrips).toBe(1);
    } finally {
      layer.dispose();
    }
  });

  it('disposes geometries and materials and is idempotent', () => {
    const geometryDispose = vi.spyOn(THREE.BufferGeometry.prototype, 'dispose');
    const materialDispose = vi.spyOn(THREE.Material.prototype, 'dispose');
    const layer = new MobilityLayer();
    layer.update(0, view());
    layer.dispose();
    expect(geometryDispose.mock.calls.length).toBeGreaterThanOrEqual(8);
    expect(materialDispose.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(layer.root.children).toHaveLength(0);
    expect(() => layer.dispose()).not.toThrow();
    expect(() => layer.update(0.016, view())).not.toThrow();
    expect(layer.getStats().drawnTrips).toBe(0);
    geometryDispose.mockRestore();
    materialDispose.mockRestore();
  });

  it('accepts unknown trip modes and invalid snapshots without throwing', () => {
    const layer = new MobilityLayer();
    try {
      const bad = [
        trip({ tripId: 'bad-mode', mode: 'metro' as unknown as MobilityTripSnapshot['mode'] }),
        { ...trip({ tripId: 'nan' }), x: Number.NaN },
      ];
      layer.update(0, view({ trips: bad }));
      expect(layer.getStats().drawnTrips).toBe(0);
      layer.update(0, view({ trips: [trip({ phase: 'finished' })] }));
      expect(layer.getStats().finishedTrips).toBe(1);
      expect(layer.getStats().drawnTrips).toBe(0);
    } finally {
      layer.dispose();
    }
  });

  it('keeps the options open for tests without a DOM (no WebGL context required)', () => {
    const options: MobilityLayerOptions = { maxVisibleTrips: 4 };
    const layer = new MobilityLayer(options);
    try {
      layer.update(0, view({ trips: Array.from({ length: 6 }, (_, index) => trip({ tripId: `x${index}` })) }));
      expect(layer.getStats().drawnTrips).toBe(4);
    } finally {
      layer.dispose();
    }
  });
});
