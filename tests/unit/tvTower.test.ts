/**
 * Unit tests for the Minsk TV/radio lattice mast curated landmark.
 *
 * The landmark is rebuilt from `building.outline` + the measured 176 m profile;
 * generic OSM `volumes` must be ignored by the curated-landmark route.
 */

import { describe, expect, it } from 'vitest';
import { buildBuildingsMesh } from '../../src/city/buildings/buildingsMesh';
import { minAreaRect } from '../../src/city/buildings/polygon2d';
import {
  isTvTowerBuilding,
  TV_TOWER_COLOURS,
  TV_TOWER_TOTAL_HEIGHT,
} from '../../src/city/buildings/tvTower';
import type { BuildingFeature, BuildingVolume, Polygon, Ring } from '../../src/shared/types';
import { decodeMesh } from '../fixtures/buildings';

/** Square of `side` metres rotated by `angle`, centred at (cx, cy). */
function rotatedSquareRing(cx: number, cy: number, side: number, angle: number): Ring {
  const h = side / 2;
  const corners: [number, number][] = [
    [-h, -h],
    [h, -h],
    [h, h],
    [-h, h],
  ];
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return corners.map(([x, y]) => [cx + x * cos - y * sin, cy + x * sin + y * cos]);
}

const OUTLINE: Polygon = [rotatedSquareRing(710, 826, 21.2, Math.PI / 4)];

function dummyVolumes(): BuildingVolume[] {
  // The pipeline still ships bogus volumes for this feature; they must be ignored.
  return [
    {
      footprint: [
        [
          [700, 816],
          [720, 816],
          [720, 836],
          [700, 836],
        ],
      ],
      minHeight: 0,
      height: 168,
      roofShape: 'flat',
      roofHeight: 0,
      heightSource: 'osm_height',
      isPart: true,
    },
    {
      footprint: [
        [
          [704, 820],
          [716, 820],
          [716, 832],
          [704, 832],
        ],
      ],
      minHeight: 168,
      height: 176,
      roofShape: 'pyramidal',
      roofHeight: 8,
      heightSource: 'heuristic',
      isPart: true,
    },
  ];
}

function makeTower(overrides: Partial<BuildingFeature> = {}): BuildingFeature {
  return {
    id: 'w1158101395',
    osmType: 'way',
    osmId: 1158101395,
    name: 'Мінская тэлебашня',
    archetype: 'industrial',
    height: 176,
    roofShape: 'flat',
    volumes: dummyVolumes(),
    tags: { 'man_made': 'tower' },
    outline: OUTLINE,
    landmark: 'tv-tower',
    ...overrides,
  };
}

interface Built {
  triangles: ReturnType<typeof decodeMesh>;
  triangleCount: number;
  positions: Float32Array;
  warnings: string[];
}

function build(building: BuildingFeature, facadeDetail = true): Built {
  const result = buildBuildingsMesh([building], { facadeDetail });
  return {
    triangles: decodeMesh(result),
    triangleCount: result.triangleCount,
    positions: result.geometry.getAttribute('position').array as Float32Array,
    warnings: result.warnings ?? [],
  };
}

function maxY(triangles: Built['triangles']): number {
  let max = -Infinity;
  for (const triangle of triangles) {
    for (const vertex of triangle.vertices) max = Math.max(max, vertex.position[1]);
  }
  return max;
}

function colourPresent(triangles: Built['triangles'], colour: readonly number[], tolerance = 2e-3): boolean {
  return triangles.some((triangle) =>
    triangle.vertices.every(
      (vertex) =>
        Math.abs(vertex.color[0] - colour[0]) < tolerance &&
        Math.abs(vertex.color[1] - colour[1]) < tolerance &&
        Math.abs(vertex.color[2] - colour[2]) < tolerance,
    ),
  );
}

describe('tv tower landmark detection', () => {
  it('matches only the tv-tower landmark id', () => {
    expect(isTvTowerBuilding(makeTower())).toBe(true);
    const other = makeTower();
    delete other.landmark;
    expect(isTvTowerBuilding(other)).toBe(false);
  });
});

describe('tv tower geometry', () => {
  const built = build(makeTower());

  it('builds the landmark without warnings in the triangle budget', () => {
    expect(built.warnings).toEqual([]);
    expect(built.triangleCount).toBeGreaterThan(300);
    expect(built.triangleCount).toBeLessThan(3000);
  });

  it('reaches the measured 176 m tip', () => {
    const top = maxY(built.triangles);
    expect(top).toBeGreaterThanOrEqual(175);
    expect(top).toBeLessThanOrEqual(177);
    expect(top).toBeCloseTo(TV_TOWER_TOTAL_HEIGHT, 1);
  });

  it('keeps the base spread aligned with the outline extent', () => {
    const ring = OUTLINE[0].map(([x, y]) => [x, y] as [number, number]);
    const rect = minAreaRect(ring);
    expect(rect).not.toBeNull();
    const expectedSide = 2 * Math.min(rect!.halfLength, rect!.halfWidth);
    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    for (const triangle of built.triangles) {
      for (const vertex of triangle.vertices) {
        if (vertex.position[1] > 1.5) continue; // footings + lowest leg section
        const lx = vertex.position[0] - 710;
        const ly = -vertex.position[2] - 826;
        const u = lx * rect!.ux + ly * rect!.uy;
        const v = lx * -rect!.uy + ly * rect!.ux;
        minU = Math.min(minU, u);
        maxU = Math.max(maxU, u);
        minV = Math.min(minV, v);
        maxV = Math.max(maxV, v);
      }
    }
    const spreadU = maxU - minU;
    const spreadV = maxV - minV;
    expect(spreadU).toBeGreaterThan(expectedSide * 0.9);
    expect(spreadU).toBeLessThan(expectedSide * 1.3);
    expect(spreadV).toBeGreaterThan(expectedSide * 0.9);
    expect(spreadV).toBeLessThan(expectedSide * 1.3);
    expect(Math.abs(spreadU - spreadV)).toBeLessThan(1.5);
  });

  it('uses the red-brown steel, white member and grey deck palette', () => {
    expect(colourPresent(built.triangles, TV_TOWER_COLOURS.steel)).toBe(true);
    expect(colourPresent(built.triangles, TV_TOWER_COLOURS.white)).toBe(true);
    expect(colourPresent(built.triangles, TV_TOWER_COLOURS.deck)).toBe(true);
    expect(colourPresent(built.triangles, TV_TOWER_COLOURS.beacon)).toBe(true);
  });

  it('writes finite attributes and correct triangle owners', () => {
    const result = buildBuildingsMesh([makeTower()], { facadeDetail: true });
    for (const name of ['position', 'normal', 'aUV', 'aColor', 'aStyle', 'aFace']) {
      const array = result.geometry.getAttribute(name).array as Float32Array;
      let bad = 0;
      for (let i = 0; i < array.length; i++) if (!Number.isFinite(array[i])) bad++;
      expect(bad, name).toBe(0);
    }
    expect(result.triangleOwner.length).toBe(result.triangleCount);
    expect(new Set(Array.from(result.triangleOwner))).toEqual(new Set([0]));
    expect(result.buildingIds).toEqual(['w1158101395']);
  });

  it('ignores the OSM volumes entirely', () => {
    const differentVolumes = makeTower({
      volumes: [
        {
          footprint: [
            [
              [690, 800],
              [730, 800],
              [730, 850],
              [690, 850],
            ],
          ],
          minHeight: 0,
          height: 73,
          roofShape: 'gabled',
          roofHeight: 12,
          heightSource: 'default',
        },
      ],
    });
    const other = build(differentVolumes);
    expect(other.warnings).toEqual([]);
    expect(other.triangleCount).toBe(built.triangleCount);
    expect(Array.from(other.positions)).toEqual(Array.from(built.positions));
  });

  it('is deterministic (same input twice -> identical mesh)', () => {
    const second = build(makeTower());
    expect(second.triangleCount).toBe(built.triangleCount);
    expect(Array.from(second.positions)).toEqual(Array.from(built.positions));
  });
});

describe('tv tower robustness', () => {
  it('missing outline -> warning + simplified mast fallback', () => {
    const building = makeTower();
    delete building.outline;
    const built = build(building);
    expect(built.warnings.join(' ')).toMatch(/outline/i);
    expect(built.triangleCount).toBeGreaterThan(0);
    expect(built.triangleCount).toBeLessThan(3000);
    expect(maxY(built.triangles)).toBeCloseTo(TV_TOWER_TOTAL_HEIGHT, 1);
    const positions = built.positions;
    let bad = 0;
    for (let i = 0; i < positions.length; i++) if (!Number.isFinite(positions[i])) bad++;
    expect(bad).toBe(0);
  });

  it('empty outline -> warning + fallback, no throw', () => {
    const built = build(makeTower({ outline: [] }));
    expect(built.warnings.join(' ')).toMatch(/outline/i);
    expect(built.triangleCount).toBeGreaterThan(0);
    expect(maxY(built.triangles)).toBeLessThanOrEqual(177);
  });

  it('degenerate outline -> warning + fallback, no throw', () => {
    const built = build(
      makeTower({
        outline: [
          [
            [710, 826],
            [711, 826],
            [712, 826],
          ],
        ],
      }),
    );
    expect(built.warnings.join(' ')).toMatch(/outline/i);
    expect(built.triangleCount).toBeGreaterThan(0);
  });

  it('malformed height -> warning, no geometry, no throw', () => {
    const built = build(makeTower({ height: Number.NaN }));
    expect(built.warnings.join(' ')).toMatch(/height/i);
    expect(built.triangleCount).toBe(0);
    const tooShort = build(makeTower({ height: 20 }));
    expect(tooShort.warnings.join(' ')).toMatch(/height/i);
    expect(tooShort.triangleCount).toBe(0);
  });

  it('non-landmark buildings are untouched', () => {
    const square: BuildingFeature = {
      id: 'w2001',
      osmType: 'way',
      osmId: 2001,
      archetype: 'panel',
      height: 12,
      roofShape: 'flat',
      volumes: [
        {
          footprint: [
            [
              [0, 0],
              [10, 0],
              [10, 10],
              [0, 10],
            ],
          ],
          minHeight: 0,
          height: 12,
          roofShape: 'flat',
          roofHeight: 0,
          heightSource: 'osm_height',
        },
      ],
      tags: {},
    };
    expect(isTvTowerBuilding(square)).toBe(false);
    const built = build(square, false);
    expect(built.triangleCount).toBe(10);
    expect(maxY(built.triangles)).toBeCloseTo(12, 3);
  });
});
