/**
 * Геометрия светофоров: шаблоны, слоты линз по аспекту, разбор `MobilitySignalNode`
 * с учётом `facing` и fallback на красный без runtime-состояния.
 */

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { MobilitySignalNode } from '../../../src/shared/mobility';
import {
  SIGNAL_ASPECT_COLORS,
  SIGNAL_HEAD_GEOMETRY,
  SIGNAL_PALETTE,
  collectSignalHeadInstances,
  createSignalGeometryTemplates,
  disposeSignalGeometryTemplates,
  signalGeometryBytes,
  signalHeadCentreY,
  signalLensSlot,
  signalPoleHeight,
} from '../../../src/city/mobility/signalGeometry';
import { geometryTriangleCount } from '../../../src/city/mobility/lowPoly';

function nodeFixture(): MobilitySignalNode {
  return {
    id: 'j:1',
    kind: 'junction',
    x: 100,
    y: 200,
    groups: [
      { id: 'g0', kind: 'vehicle', aspects: ['red', 'yellow', 'green'] },
      { id: 'ped0', kind: 'pedestrian', aspects: ['red', 'green'] },
      { id: 'tram0', kind: 'tram', aspects: ['red', 'yellow', 'green'] },
    ],
    movements: [],
    stopLines: [],
    heads: [
      { id: 'h0', group: 0, x: 101, y: 200, facing: Math.PI / 2, kind: 'vehicle', heightM: 2.7 },
      { id: 'h1', group: 1, x: 102, y: 201, facing: 0, kind: 'pedestrian', heightM: 2.2 },
      { id: 'h2', group: 2, x: 103, y: 202, facing: -Math.PI / 2, kind: 'tram', heightM: 3.1 },
    ],
    program: { id: 'test-v1', phases: [], offsetS: 0 },
    conflicts: [],
  };
}

function signalVolume(geometry: THREE.BufferGeometry): number {
  const positions = geometry.getAttribute('position').array as Float32Array;
  let volume = 0;
  for (let index = 0; index + 8 < positions.length; index += 9) {
    const ax = positions[index];
    const ay = positions[index + 1];
    const az = positions[index + 2];
    const bx = positions[index + 3];
    const by = positions[index + 4];
    const bz = positions[index + 5];
    const cx = positions[index + 6];
    const cy = positions[index + 7];
    const cz = positions[index + 8];
    volume +=
      ax * (by * cz - bz * cy) -
      ay * (bx * cz - bz * cx) +
      az * (bx * cy - by * cx);
  }
  return volume / 6;
}

describe('signal geometry', () => {
  it('builds small housing templates for all traffic kinds', () => {
    const templates = createSignalGeometryTemplates();
    try {
      for (const kind of ['vehicle', 'pedestrian', 'tram'] as const) {
        const geometry = templates.housing[kind];
        const triangles = geometry.getAttribute('position').count / 3;
        expect(triangles, kind).toBeGreaterThan(8);
        expect(triangles, kind).toBeLessThanOrEqual(40);
        expect(geometry.getAttribute('color').count, kind).toBeGreaterThan(0);
        // Корпус закрыт и ориентирован наружу: положительный объём.
        expect(signalVolume(geometry), kind).toBeGreaterThan(0.005);
      }
      const poleTriangles = templates.pole.getAttribute('position').count / 3;
      expect(poleTriangles).toBeGreaterThan(8);
      expect(poleTriangles).toBeLessThanOrEqual(40);
      expect(signalVolume(templates.pole)).toBeGreaterThan(0.002);
      // Стойка единичной высоты: масштабируется по heightM экземпляра.
      expect(templates.pole.boundingBox?.max.y).toBeCloseTo(1, 5);
      // Линза — единичный квадрат в плоскости (Z, Y) с нормалью −X.
      expect(templates.lens.boundingBox?.max.x).toBeCloseTo(0, 5);
      expect(templates.lens.boundingBox?.min.x).toBeCloseTo(0, 5);
      // Линза индексирована: треугольники считаем по index, а не по позициям.
      expect(geometryTriangleCount(templates.lens)).toBe(2);
      expect(signalGeometryBytes(templates)).toBeGreaterThan(0);
    } finally {
      disposeSignalGeometryTemplates(templates);
    }
  });

  it('places lenses in aspect order and keeps pedestrian signals two-lamp', () => {
    const vehicle = SIGNAL_HEAD_GEOMETRY.vehicle;
    expect(signalLensSlot('vehicle', 'red').y).toBeGreaterThan(signalLensSlot('vehicle', 'yellow').y);
    expect(signalLensSlot('vehicle', 'yellow').y).toBeGreaterThan(signalLensSlot('vehicle', 'green').y);
    expect(signalLensSlot('pedestrian', 'red').y).toBeGreaterThan(signalLensSlot('pedestrian', 'green').y);
    for (const kind of ['vehicle', 'pedestrian', 'tram'] as const) {
      for (const aspect of ['red', 'yellow', 'green'] as const) {
        const slot = signalLensSlot(kind, aspect);
        expect(slot.size).toBeGreaterThan(0.1);
        expect(slot.size).toBeLessThan(SIGNAL_HEAD_GEOMETRY[kind].widthM);
      }
    }
    expect(vehicle.heightM).toBeGreaterThan(SIGNAL_HEAD_GEOMETRY.pedestrian.heightM);
    expect(new Set(Object.values(SIGNAL_ASPECT_COLORS)).size).toBe(3);
    expect(SIGNAL_PALETTE.red).toBe(SIGNAL_ASPECT_COLORS.red);
  });

  it('raises a too-short pole above the ground instead of sinking the head', () => {
    expect(signalPoleHeight('vehicle', 0.1)).toBeGreaterThan(SIGNAL_HEAD_GEOMETRY.vehicle.heightM);
    expect(signalHeadCentreY('vehicle', 0.1)).toBeGreaterThan(0);
    expect(signalPoleHeight('vehicle', 2.7)).toBeCloseTo(2.7, 5);
    expect(signalHeadCentreY('vehicle', 2.7)).toBeCloseTo(2.7 - SIGNAL_HEAD_GEOMETRY.vehicle.heightM / 2, 5);
  });

  it('resolves head aspects from node groups and preserves facing', () => {
    const aspects = new Map<string, Record<string, 'red' | 'yellow' | 'green'>>([
      ['j:1', { g0: 'green', ped0: 'red', tram0: 'yellow' }],
    ]);
    const instances = collectSignalHeadInstances([nodeFixture()], aspects);
    expect(instances).toHaveLength(3);
    expect(instances[0]).toMatchObject({
      nodeId: 'j:1',
      headId: 'h0',
      kind: 'vehicle',
      groupId: 'g0',
      x: 101,
      y: 200,
      facing: Math.PI / 2,
      aspect: 'green',
      aspectKnown: true,
    });
    expect(instances[1].aspect).toBe('red');
    expect(instances[2]).toMatchObject({ kind: 'tram', aspect: 'yellow', facing: -Math.PI / 2 });
    // Повторный вызов с переиспользованием массива даёт тот же результат.
    const reused = collectSignalHeadInstances([nodeFixture()], aspects, instances);
    expect(reused).toBe(instances);
    expect(reused).toHaveLength(3);
  });

  it('falls back to red when runtime state is missing, deterministically', () => {
    const instances = collectSignalHeadInstances([nodeFixture()], undefined);
    expect(instances.every((instance) => instance.aspect === 'red')).toBe(true);
    expect(instances.every((instance) => instance.aspectKnown === false)).toBe(true);
    const again = collectSignalHeadInstances([nodeFixture()], new Map());
    expect(again.map((instance) => instance.headId)).toEqual(['h0', 'h1', 'h2']);
  });

  it('skips heads with non-finite coordinates and tolerates a broken group index', () => {
    const node = nodeFixture();
    node.heads = [
      { id: 'bad', group: 0, x: Number.NaN, y: 0, facing: 0, kind: 'vehicle', heightM: 2.5 },
      { id: 'orphan', group: 99, x: 1, y: 2, facing: 0.5, kind: 'vehicle', heightM: 2.5 },
    ];
    const instances = collectSignalHeadInstances([node], new Map([['j:1', { g0: 'green' }]]));
    expect(instances).toHaveLength(1);
    expect(instances[0]).toMatchObject({ headId: 'orphan', groupId: '', aspect: 'red', aspectKnown: false });
  });

  it('disposes every template geometry', () => {
    const templates = createSignalGeometryTemplates();
    const disposed: string[] = [];
    const track = (geometry: THREE.BufferGeometry, name: string): void => {
      const original = geometry.dispose.bind(geometry);
      geometry.dispose = () => {
        disposed.push(name);
        original();
      };
    };
    track(templates.pole, 'pole');
    track(templates.lens, 'lens');
    for (const [kind, geometry] of Object.entries(templates.housing)) track(geometry, kind);
    disposeSignalGeometryTemplates(templates);
    expect(disposed.sort()).toEqual(['lens', 'pedestrian', 'pole', 'tram', 'vehicle']);
  });
});
