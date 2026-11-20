/**
 * Фоновое движение поездов: чистая логика сети и lifecycle слоя.
 *
 * WebGL не нужен: three.js создаёт InstancedMesh в Node, а реальные модели
 * подменяются процедурными fallback-шаблонами. Проверяются сэмплирование,
 * составы, заворот, пауза, видимость и dispose.
 */

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  advanceRailTrain,
  buildRailTrains,
  commuterConsist,
  consistLength,
  freightConsist,
  parseRailNetwork,
  polylineLength,
  railUnitPose,
  sampleRailSegment,
  type RailNetwork,
  type RailNetworkSegment,
} from '../../../src/city/rail/railNetwork';
import { RailTrafficLayer } from '../../../src/engine/rail/railTrafficLayer';

function straightSegment(id: string, lengthM = 1000, y = 0): RailNetworkSegment {
  return {
    id,
    lengthM,
    points: [0, y, lengthM, y],
    bounds: [0, y, lengthM, y],
  };
}

function networkOf(segments: RailNetworkSegment[]): RailNetwork {
  return {
    version: 1,
    generatedAt: '2026-11-18T00:00:00Z',
    source: 'test',
    licence: 'test',
    note: 'test',
    segments,
  };
}

function view(overrides: Partial<{ visible: boolean; paused: boolean }> = {}) {
  return {
    rect: { minX: -500, maxX: 2000, minZ: -500, maxZ: 500 },
    worldPerPixel: 1.5,
    visible: overrides.visible ?? true,
    paused: overrides.paused ?? false,
  };
}

describe('rail network', () => {
  it('parses a valid network and rejects contract violations', () => {
    const parsed = parseRailNetwork({
      version: 1,
      generatedAt: '2026-11-18T00:00:00Z',
      source: 's',
      licence: 'l',
      note: 'n',
      segments: [{ id: 'a', lengthM: 100, points: [0, 0, 100, 0] }],
    });
    expect(parsed.segments).toHaveLength(1);
    expect(parsed.segments[0].lengthM).toBeCloseTo(100, 4);
    expect(parsed.segments[0].bounds).toEqual([0, 0, 100, 0]);
    expect(() => parseRailNetwork({ version: 2, segments: [] })).toThrow(/version/);
    expect(() => parseRailNetwork({ version: 1 })).toThrow(/segments/);
    expect(() =>
      parseRailNetwork({ version: 1, segments: [{ id: 'a', points: [0, 0] }] }),
    ).toThrow(/points/);
    expect(() =>
      parseRailNetwork({ version: 1, segments: [{ id: 'a', points: [0, 0, 1] }] }),
    ).toThrow(/points/);
    expect(() =>
      parseRailNetwork({ version: 1, segments: [{ id: 'a', points: [0, 0, 0, 0] }] }),
    ).toThrow(/degenerate/);
  });

  it('samples a polyline by arc length and clamps at the ends', () => {
    const points = [0, 0, 100, 0, 100, 100];
    expect(polylineLength(points)).toBeCloseTo(200, 4);
    const mid = sampleRailSegment(points, 50);
    expect(mid.x).toBeCloseTo(50, 4);
    expect(mid.y).toBeCloseTo(0, 4);
    expect(mid.heading).toBeCloseTo(0, 4);
    const turn = sampleRailSegment(points, 150);
    expect(turn.x).toBeCloseTo(100, 4);
    expect(turn.y).toBeCloseTo(50, 4);
    expect(turn.heading).toBeCloseTo(Math.PI / 2, 4);
    expect(sampleRailSegment(points, -10).x).toBeCloseTo(0, 4);
    const end = sampleRailSegment(points, 999);
    expect(end.x).toBeCloseTo(100, 4);
    expect(end.y).toBeCloseTo(100, 4);
  });

  it('builds deterministic commuter/freight consists with plausible lengths', () => {
    const commuter = commuterConsist();
    expect(commuter.map((unit) => unit.model)).toEqual([
      'commuterLead',
      'commuterCar',
      'commuterLead',
    ]);
    expect(commuter[2].facing).toBe(-1);
    const commuterLength = consistLength(commuter);
    expect(commuterLength).toBeGreaterThan(70);
    expect(commuterLength).toBeLessThan(80);
    const freight = freightConsist(6);
    expect(freight).toHaveLength(7);
    expect(consistLength(freight)).toBeGreaterThan(100);
    const segments = [straightSegment('a'), straightSegment('b'), straightSegment('c')];
    const first = buildRailTrains(segments, { maxTrains: 3 });
    const second = buildRailTrains(segments, { maxTrains: 3 });
    expect(first.map((train) => train.kind)).toEqual(['commuter', 'freight', 'commuter']);
    expect(first.map((train) => train.distanceM)).toEqual(second.map((train) => train.distanceM));
    expect(first.map((train) => train.segmentId)).toEqual(['a', 'b', 'c']);
  });

  it('advances the head and wraps without leaving the tail before the start', () => {
    const segment = straightSegment('a', 100);
    const train = buildRailTrains([segment], { maxTrains: 1, minSegmentM: 0 })[0];
    train.distanceM = train.lengthM + 10;
    advanceRailTrain(train, segment, 0.5);
    expect(train.distanceM).toBeCloseTo(train.lengthM + 10 + train.speedMps * 0.5, 4);
    // Large dt is clamped to 0.5 s by contract.
    advanceRailTrain(train, segment, 999);
    expect(train.distanceM).toBeLessThanOrEqual(segment.lengthM + train.lengthM);
    expect(train.distanceM).toBeGreaterThanOrEqual(train.lengthM);
  });

  it('returns null for a unit that has not entered the segment yet', () => {
    const segment = straightSegment('a', 1000);
    const train = buildRailTrains([segment], { maxTrains: 1, minSegmentM: 0 })[0];
    train.distanceM = train.lengthM + 10;
    expect(railUnitPose(train, segment, train.units[0])).not.toBeNull();
    train.distanceM = train.lengthM;
    expect(railUnitPose(train, segment, train.units[0])).not.toBeNull();
  });
});

describe('rail traffic layer', () => {
  it('adopts a network, draws units, honours pause/visibility and disposes', () => {
    const layer = new RailTrafficLayer({ maxTrains: 2, freightWagons: 2 });
    try {
      layer.adoptNetwork(networkOf([straightSegment('a'), straightSegment('b', 800)]));
      expect(layer.state).toBe('ready');
      expect(layer.getTrains()).toHaveLength(2);

      layer.update(0.1, view());
      const stats = layer.getStats();
      expect(stats.trains).toBe(2);
      expect(stats.commuterTrains).toBe(1);
      expect(stats.freightTrains).toBe(1);
      expect(stats.drawnUnits).toBeGreaterThan(0);
      expect(stats.drawCalls).toBeGreaterThan(0);

      const before = layer.getTrains()[0].distanceM;
      layer.update(1, view({ paused: true }));
      expect(layer.getTrains()[0].distanceM).toBe(before);
      layer.update(1, view());
      expect(layer.getTrains()[0].distanceM).not.toBe(before);

      layer.update(0.1, view({ visible: false }));
      expect(layer.getStats().drawnUnits).toBe(0);
      const meshes = layer.root.children.filter(
        (child): child is THREE.InstancedMesh => child instanceof THREE.InstancedMesh,
      );
      expect(meshes.every((mesh) => mesh.count === 0)).toBe(true);
    } finally {
      layer.dispose();
    }
    expect(layer.root.children).toHaveLength(0);
    expect(() => layer.dispose()).not.toThrow();
  });

  it('ignores a network whose data has no long enough segments', () => {
    const layer = new RailTrafficLayer({ maxTrains: 4 });
    try {
      layer.adoptNetwork(networkOf([straightSegment('short', 120)]));
      expect(layer.getTrains()).toHaveLength(0);
      layer.update(0.1, view());
      expect(layer.getStats().drawnUnits).toBe(0);
    } finally {
      layer.dispose();
    }
  });
});
