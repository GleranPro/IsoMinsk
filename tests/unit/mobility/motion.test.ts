/**
 * Тесты профиля движения и геометрии пути варианта: разгон/торможение,
 * безопасная скорость до границы, темп по расписанию, точный путь из полос
 * рёбер и явный fallback по остановкам без геометрии.
 */

import { describe, expect, it } from 'vitest';
import { stoppingDistanceM } from '../../../src/mobility/signals';
import {
  DEFAULT_MOTION_PROFILES,
  advanceMotion,
  buildRoutePath,
  maxSpeedForStoppingDistance,
  motionProfileForMode,
  sampleRoutePath,
  schedulePaceSpeed,
} from '../../../src/mobility/vehicleMotion';
import type {
  MobilityEdge,
  MobilityRouteVariant,
  MobilityStopCall,
} from '../../../src/shared/mobility';

function stopCall(seq: number, edgeId: string, s: number, x: number, laneIndex = 0): MobilityStopCall {
  return {
    seq,
    stopId: `s:${seq}`,
    edgeId,
    laneIndex,
    s,
    heading: 0,
    x,
    y: 0,
    h: 0,
    dwellS: 20,
    timed: true,
    binding: 'source-id',
  };
}

function edge(id: string, fromX: number, toX: number, offsetY = 0): MobilityEdge {
  return {
    id,
    wayId: 1,
    from: `n:${id}:a`,
    to: `n:${id}:b`,
    modes: ['bus', 'tram'],
    oneway: true,
    layer: 0,
    widthM: 6,
    centerline: { p: [fromX, offsetY, 0, toX, offsetY, 0], s: [0, toX - fromX] },
    lanes: [{ index: 0, offset: 0, widthM: 3, centerline: { p: [], s: [] } }],
  };
}

function variant(overrides: Partial<MobilityRouteVariant> = {}): MobilityRouteVariant {
  const edges = ['e0', 'e1', 'e2', 'e3'];
  return {
    id: 'r:test:0:1',
    mode: 'bus',
    ref: '1',
    headSign: 'Тест',
    direction: 0,
    edges,
    stops: [
      stopCall(0, 'e0', 0, 0),
      stopCall(1, 'e1', 0, 400),
      stopCall(2, 'e2', 0, 800),
      stopCall(3, 'e3', 0, 1200),
    ],
    lengthM: 1200,
    sourceRelationId: 1,
    verified: true,
    bounds: [0, 0, 1200, 0],
    ...overrides,
  };
}

function edgeIndex(list: MobilityEdge[]): (edgeId: string) => MobilityEdge | null {
  const map = new Map(list.map((item) => [item.id, item]));
  return (edgeId: string) => map.get(edgeId) ?? null;
}

const EDGES = [edge('e0', 0, 400), edge('e1', 400, 800), edge('e2', 800, 1200), edge('e3', 1200, 1600)];

describe('VehicleMotion — профиль скорости', () => {
  it('обратная функция к тормозному пути согласована с signals.ts', () => {
    for (const speed of [1, 3, 5, 8, 14]) {
      const distance = stoppingDistanceM(speed, 3, 0.5);
      const recovered = maxSpeedForStoppingDistance(distance, 3, 0.5);
      expect(recovered).toBeGreaterThan(speed - 1e-6);
      expect(recovered).toBeLessThan(speed + 1e-6);
    }
    expect(maxSpeedForStoppingDistance(0)).toBe(0);
    expect(maxSpeedForStoppingDistance(-5)).toBe(0);
    expect(maxSpeedForStoppingDistance(Number.NaN)).toBe(Number.POSITIVE_INFINITY);
    expect(maxSpeedForStoppingDistance(10, 0)).toBe(Number.POSITIVE_INFINITY);
    expect(maxSpeedForStoppingDistance(20, 3, 0.5)).toBeGreaterThan(9);
    expect(stoppingDistanceM(maxSpeedForStoppingDistance(20, 3, 0.5), 3, 0.5)).toBeCloseTo(20, 6);
  });

  it('целевая скорость учитывает время, лимит и минимальный темп', () => {
    expect(schedulePaceSpeed(400, 80, 14, 4)).toBeCloseTo(5, 9);
    expect(schedulePaceSpeed(400, 10, 14, 4)).toBe(14); // опаздываем — не больше лимита
    expect(schedulePaceSpeed(400, 0, 14, 4)).toBe(14);
    expect(schedulePaceSpeed(400, -10, 14, 4)).toBe(14);
    expect(schedulePaceSpeed(400, 4000, 14, 4)).toBe(4); // слишком много времени — комфортный темп
    expect(schedulePaceSpeed(0, 100, 14, 4)).toBe(0);
    expect(schedulePaceSpeed(10, 1, 14, 0)).toBe(10);
  });

  it('разгон и торможение ограничены, скорость не выше лимита', () => {
    const profile = motionProfileForMode('bus');
    let state = { distanceM: 0, speedMps: 0 };
    // Длинный перегон без границы: выходим на лимит, но не выше.
    for (let step = 0; step < 400; step += 1) {
      const result = advanceMotion(state, 0.1, profile, { targetSpeedMps: profile.maxSpeedMps });
      const acceleration = (result.speedMps - state.speedMps) / 0.1;
      expect(acceleration).toBeLessThanOrEqual(profile.accelMps2 + 1e-9);
      expect(result.speedMps).toBeLessThanOrEqual(profile.maxSpeedMps + 1e-9);
      state = { distanceM: result.distanceM, speedMps: result.speedMps };
    }
    expect(state.speedMps).toBeCloseTo(profile.maxSpeedMps, 6);

    // Торможение до нуля: замедление не резче лимита.
    let previous = state.speedMps;
    for (let step = 0; step < 300 && previous > 0; step += 1) {
      const result = advanceMotion(
        { distanceM: state.distanceM, speedMps: previous },
        0.1,
        profile,
        { targetSpeedMps: 0 },
      );
      const deceleration = (previous - result.speedMps) / 0.1;
      expect(deceleration).toBeLessThanOrEqual(profile.brakingMps2 + 1e-9);
      expect(result.speedMps).toBeGreaterThanOrEqual(0);
      previous = result.speedMps;
    }
    expect(previous).toBe(0);
  });

  it('не пересекает границу и останавливается ровно перед ней', () => {
    const profile = motionProfileForMode('bus');
    let state = { distanceM: 0, speedMps: 12 };
    const boundary = 60;
    let stopped = false;
    let travelled = 0;
    for (let step = 0; step < 200; step += 1) {
      const result = advanceMotion(state, 0.1, profile, {
        targetSpeedMps: profile.maxSpeedMps,
        stopDistanceM: Math.max(0, boundary - state.distanceM),
      });
      expect(result.distanceM).toBeLessThanOrEqual(boundary + 1e-6);
      travelled = result.distanceM;
      if (result.atBoundary) {
        stopped = true;
        expect(result.speedMps).toBe(0);
        break;
      }
      state = { distanceM: result.distanceM, speedMps: result.speedMps };
    }
    expect(stopped).toBe(true);
    expect(travelled).toBeCloseTo(boundary, 9);
  });

  it('не двигается за границей с нулевой дистанцией', () => {
    const profile = motionProfileForMode('bus');
    const result = advanceMotion(
      { distanceM: 100, speedMps: 5 },
      0.1,
      profile,
      { targetSpeedMps: 14, stopDistanceM: 0 },
    );
    expect(result.atBoundary).toBe(true);
    expect(result.distanceM).toBe(100);
    expect(result.speedMps).toBe(0);
  });

  it('некорректный шаг — ошибка, а не «тихое» движение', () => {
    const profile = motionProfileForMode('bus');
    expect(() => advanceMotion({ distanceM: 0, speedMps: 0 }, Number.NaN, profile, { targetSpeedMps: 1 })).toThrow(
      RangeError,
    );
    expect(() => advanceMotion({ distanceM: 0, speedMps: 0 }, -0.1, profile, { targetSpeedMps: 1 })).toThrow(
      RangeError,
    );
    expect(() => motionProfileForMode('bus', { maxSpeedMps: 0 })).toThrow(RangeError);
    expect(() => motionProfileForMode('bus', { minCruiseMps: 99 })).toThrow(RangeError);
  });

  it('модельные профили видов транспорта заданы и валидны', () => {
    for (const mode of ['bus', 'trolleybus', 'tram'] as const) {
      const profile = motionProfileForMode(mode);
      expect(profile).toEqual(DEFAULT_MOTION_PROFILES[mode]);
      expect(profile.maxSpeedMps).toBeGreaterThan(profile.minCruiseMps);
      expect(profile.bodyLengthM).toBeGreaterThan(0);
    }
  });
});

describe('VehicleMotion — путь варианта', () => {
  it('собирает точный путь из полос рёбер и привязывает остановки по s', () => {
    const build = buildRoutePath(variant(), edgeIndex(EDGES));
    expect(build).not.toBeNull();
    expect(build?.exact).toBe(true);
    expect(build?.missingEdgeIds).toEqual([]);
    const path = build!.path;
    expect(path.lengthM).toBeCloseTo(1600, 6);
    expect(path.stopDistancesM).toEqual([0, 400, 800, 1200]);
    expect(path.exact).toBe(true);
    // Стыковые вершины соседних рёбер не дублируются: e0(0..400)+e1(400..800)+…
    expect(path.points.length / 3).toBe(5);
    const at500 = sampleRoutePath(path, 500);
    expect(at500.x).toBeCloseTo(500, 6);
    expect(at500.heading).toBeCloseTo(0, 6);
    const atStop = sampleRoutePath(path, path.stopDistancesM[2] ?? 0);
    expect(atStop.x).toBeCloseTo(800, 6);
  });

  it('берёт крайнюю правую полосу и сдвигает её внутрь от кромки', () => {
    const edges = EDGES.map((item) => ({ ...item }));
    const withLane = edges[1];
    if (withLane) {
      withLane.lanes = [
        { index: 0, offset: 2, widthM: 3, centerline: { p: [400, 2, 0, 800, 2, 0], s: [0, 400] } },
        {
          index: 1,
          offset: -2,
          widthM: 3,
          centerline: {
            p: [400, -2, 0, 600, -2, 0, 800, -2, 0],
            s: [0, 200, 400],
          },
        },
      ];
    }
    const route = variant({
      stops: [
        stopCall(0, 'e0', 0, 0),
        stopCall(1, 'e1', 0, 400, 0),
        stopCall(2, 'e2', 0, 800),
        stopCall(3, 'e3', 0, 1200),
      ],
    });
    const build = buildRoutePath(route, edgeIndex(edges));
    expect(build?.exact).toBe(true);
    const path = build!.path;
    const sample = sampleRoutePath(path, 600);
    // Правая полоса (offset −2 в +X направлении) подтянута к осевой на 0,6 м,
    // чтобы кузов не свисал с нарисованной кромки.
    expect(sample.y).toBeCloseTo(-1.4, 2);
  });

  it('без геометрии рёбер даёт явный fallback по остановкам и список рёбер', () => {
    const build = buildRoutePath(variant(), () => null);
    expect(build).not.toBeNull();
    expect(build?.exact).toBe(false);
    expect(build?.missingEdgeIds).toEqual(['e0', 'e1', 'e2', 'e3']);
    expect(build?.reason).toContain('геометрия');
    const path = build!.path;
    // Хорды масштабированы к variant.lengthM и не выдаются за точный путь.
    expect(path.exact).toBe(false);
    expect(path.lengthM).toBeCloseTo(1200, 6);
    expect(path.stopDistancesM).toEqual([0, 400, 800, 1200]);
  });

  it('не строит путь без остановок или с нечисловыми координатами', () => {
    expect(buildRoutePath(variant({ stops: [] }), edgeIndex(EDGES))).toBeNull();
    const broken = variant({
      stops: [{ ...stopCall(0, 'e0', 0, 0), x: Number.NaN }],
    });
    expect(buildRoutePath(broken, edgeIndex(EDGES))).toBeNull();
  });

  it('явно отвергает s остановки за пределами полосы', () => {
    const route = variant({
      stops: [
        stopCall(0, 'e0', 0, 0),
        stopCall(1, 'e1', 4000, 4000),
        stopCall(2, 'e2', 0, 800),
        stopCall(3, 'e3', 0, 1200),
      ],
    });
    const build = buildRoutePath(route, edgeIndex(EDGES));
    expect(build?.exact).toBe(false);
    expect(build?.reason).toContain('вне полосы');
  });
});
