/**
 * Unit tests for the Minsk Gate landmark superstructure (Ворота Минска).
 *
 * The gate ensemble is ONE BuildingFeature (OSM relation 9383682) with four
 * building:part volumes: two low base blocks and two tall tower tiers. The
 * crown generator must add clock/emblem/spire/finial geometry on top of both
 * tiers while leaving regular buildings untouched.
 *
 * These tests are self-contained (fixtures live here) so they exercise only the
 * landmark contract without depending on regenerated city data.
 */

import { describe, expect, it } from 'vitest';
import { buildBuildingsMesh } from '../../src/city/buildings/buildingsMesh';
import { isCityGateBuilding, selectGateTiers } from '../../src/city/buildings/cityGate';
import { srgbFromHex } from '../../src/city/buildings/style';
import { FACE_KIND, ROOF_SHAPE_ID, STYLE_FLAG } from '../../src/shared/geometry';
import type { BuildingFeature, BuildingVolume, Ring } from '../../src/shared/types';
import { decodeMesh, type DecodedTriangle } from '../fixtures/buildings';

const GOLD = srgbFromHex('#C9A227');

type Decoded = ReturnType<typeof decodeMesh>;

function rotatedRectRing(cx: number, cy: number, width: number, depth: number, angle: number): Ring {
  const hw = width / 2;
  const hd = depth / 2;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const corners: [number, number][] = [
    [-hw, -hd],
    [hw, -hd],
    [hw, hd],
    [-hw, hd],
  ];
  return corners.map(([x, y]) => [cx + x * cos - y * sin, cy + x * sin + y * cos]);
}

function makeTierVolume(cx: number, cy: number, height = 38.5): BuildingVolume {
  return {
    footprint: [rotatedRectRing(cx, cy, 33, 24, 0.28)],
    minHeight: 0,
    height,
    roofShape: 'flat',
    roofHeight: 0,
    heightSource: 'osm_height',
    isPart: true,
  };
}

function makeBaseVolume(cx: number, cy: number, width: number, depth: number): BuildingVolume {
  return {
    footprint: [rotatedRectRing(cx, cy, width, depth, 0.28)],
    minHeight: 0,
    height: 24.5,
    roofShape: 'flat',
    roofHeight: 0,
    heightSource: 'osm_height',
    isPart: true,
  };
}

interface GateFixtureOptions {
  /** 'two' full tiers, 'one' clock-only tier, 'invalid' first tier too small. */
  tiers?: 'two' | 'one' | 'invalid' | 'none';
  archetype?: BuildingFeature['archetype'];
  volumeHeight?: number;
}

function makeGateBuilding(options: GateFixtureOptions = {}): BuildingFeature {
  const mode = options.tiers ?? 'two';
  const volumes: BuildingVolume[] = [
    makeBaseVolume(-10.5, 1, 42, 30),
    makeBaseVolume(10.5, -1, 40, 29),
  ];
  if (mode === 'two') {
    volumes.push(makeTierVolume(-10.5, 1), makeTierVolume(10.5, -1));
  } else if (mode === 'one') {
    volumes.push(makeTierVolume(-10.5, 1));
  } else if (mode === 'invalid') {
    // First tower's tier footprint is too small for the crown (~8x8 m); the
    // second tower must still receive the emblem treatment.
    const tiny: BuildingVolume = {
      ...makeTierVolume(-10.5, 1),
      footprint: [rotatedRectRing(-10.5, 1, 8, 8, 0.28)],
    };
    volumes.push(tiny, makeTierVolume(10.5, -1));
  } else {
    // Degenerate data variant: a single short volume, no qualifying tier.
    const short: BuildingVolume = {
      ...makeTierVolume(-10.5, 1, 16.5),
      footprint: [rotatedRectRing(-10.5, 1, 24, 18, 0.28)],
    };
    volumes.length = 0;
    volumes.push(short);
  }
  const height = options.volumeHeight ?? Math.max(...volumes.map((volume) => volume.height));
  return {
    id: 'r9383682',
    osmType: 'relation',
    osmId: 9383682,
    name: 'Ворота Мінска',
    archetype: options.archetype ?? 'civic',
    height,
    roofShape: 'flat',
    volumes,
    tags: { building: 'yes' },
    landmark: 'minsk-gate',
  };
}

function buildOne(building: BuildingFeature, facadeDetail = false): {
  triangles: Decoded;
  triangleCount: number;
  vertexCount: number;
  positions: Float32Array;
  warnings: string[];
} {
  const result = buildBuildingsMesh([building], { facadeDetail });
  return {
    triangles: decodeMesh(result),
    triangleCount: result.triangleCount,
    vertexCount: result.geometry.getAttribute('position').count,
    positions: result.geometry.getAttribute('position').array as Float32Array,
    warnings: result.warnings ?? [],
  };
}

function maxY(triangles: Decoded): number {
  let max = -Infinity;
  for (const triangle of triangles) {
    for (const vertex of triangle.vertices) max = Math.max(max, vertex.position[1]);
  }
  return max;
}

function colourMatches(triangle: DecodedTriangle, expected: readonly number[], tolerance = 2e-3): boolean {
  return triangle.vertices.every(
    (vertex) =>
      Math.abs(vertex.color[0] - expected[0]) < tolerance &&
      Math.abs(vertex.color[1] - expected[1]) < tolerance &&
      Math.abs(vertex.color[2] - expected[2]) < tolerance,
  );
}

describe('city gate landmark detection', () => {
  it('isCityGateBuilding only matches the ensemble landmark id', () => {
    expect(isCityGateBuilding(makeGateBuilding())).toBe(true);
    const other = makeGateBuilding();
    delete other.landmark;
    expect(isCityGateBuilding(other)).toBe(false);
    const unrelated = { ...makeGateBuilding(), landmark: 'some-other-landmark' as never };
    expect(isCityGateBuilding(unrelated)).toBe(false);
  });

  it('selects the tall building:part tiers deterministically (by centroid x)', () => {
    const tiers = selectGateTiers(makeGateBuilding());
    expect(tiers).toHaveLength(2);
    expect(tiers[0].centroid[0]).toBeLessThan(tiers[1].centroid[0]);
    expect(tiers[0].volume.height).toBeCloseTo(38.5, 3);
    // Base blocks (24.5 m, isPart) are not tiers.
    const short = selectGateTiers(makeGateBuilding({ tiers: 'none' }));
    expect(short).toHaveLength(0);
  });
});

describe('city gate clock tower (two crowns)', () => {
  const building = makeGateBuilding();
  const built = buildOne(building);

  it('builds both towers without warnings', () => {
    expect(built.warnings).toEqual([]);
    expect(built.triangleCount).toBeGreaterThan(100);
  });

  it('adds a flat parapet crown with corner turret stars above 43 m', () => {
    // The real ensemble has flat-topped pylon towers: no spire, but four
    // ornamental turrets with small gold star finials per tower.
    const starTop = maxY(built.triangles);
    expect(starTop).toBeGreaterThanOrEqual(43.5);
    expect(starTop).toBeLessThan(45);
    // Two distinct towers were crowned (turrets sit at x ~ -10.5 and +10.5).
    const gold = built.triangles.filter((triangle) => colourMatches(triangle, GOLD));
    const goldXs = gold.flatMap((triangle) => triangle.vertices.map((v) => v.position[0]));
    expect(Math.min(...goldXs)).toBeLessThan(-5);
    expect(Math.max(...goldXs)).toBeGreaterThan(5);
  });

  it('adds four clock medallions to the clock tower (glass faces)', () => {
    const glass = built.triangles.filter((triangle) => triangle.faceKind === FACE_KIND.glass);
    // 4 dials on the clock tower * (12-gon fan = 10 triangles). The emblem
    // tower carries a gold medallion instead (see the emblem test below).
    expect(glass).toHaveLength(40);
    // The dial sits high on the tower wall, just below the eave (38.5 m).
    const dialHeights = glass.flatMap((triangle) => triangle.vertices.map((v) => v.position[1]));
    expect(Math.min(...dialHeights)).toBeGreaterThan(34);
    expect(Math.max(...dialHeights)).toBeLessThan(38.5);
  });

  it('adds gold clock hands, emblem medallions and turret stars', () => {
    const gold = built.triangles.filter((triangle) => colourMatches(triangle, GOLD));
    // clock hands 16 + emblem medallion faces 40 + 8 turret stars * 8 = 64.
    expect(gold).toHaveLength(120);
    const goldMaxY = Math.max(...gold.flatMap((triangle) => triangle.vertices.map((v) => v.position[1])));
    expect(goldMaxY).toBeGreaterThan(43);
    const trim = built.triangles.filter((triangle) => triangle.faceKind === FACE_KIND.trim);
    expect(trim.length).toBeGreaterThan(100);
    const roofRidge = built.triangles.filter((triangle) => triangle.faceKind === FACE_KIND.roofRidge);
    expect(roofRidge).toHaveLength(0); // no shingle treatment on the crown
    // No spire: the crown is a flat parapet block, not a pointed roof.
    const pyramidal = built.triangles.filter(
      (triangle) =>
        triangle.faceKind === FACE_KIND.roof && triangle.roofShapeId === ROOF_SHAPE_ID.pyramidal,
    );
    expect(pyramidal).toHaveLength(0);
  });

  it('writes finite, complete vertex attributes for the crown', () => {
    const result = buildBuildingsMesh([building], { facadeDetail: false });
    for (const name of ['position', 'normal', 'aUV', 'aColor', 'aStyle', 'aFace']) {
      const array = result.geometry.getAttribute(name).array as Float32Array;
      let bad = 0;
      for (let i = 0; i < array.length; i++) if (!Number.isFinite(array[i])) bad++;
      expect(bad, name).toBe(0);
    }
    expect(result.triangleOwner.length).toBe(result.triangleCount);
    expect(new Set(Array.from(result.triangleOwner))).toEqual(new Set([0]));
  });

  it('detects clock and emblem treatment via blank attic walls', () => {
    // Attic/parapet walls are blank painted trim (no window rhythm).
    const blankWalls = built.triangles.filter(
      (triangle) =>
        triangle.faceKind === FACE_KIND.trim && (triangle.vertices[0].face[1] & STYLE_FLAG.blank) !== 0,
    );
    expect(blankWalls.length).toBeGreaterThan(0);
    const heights = blankWalls.flatMap((triangle) => triangle.vertices.map((v) => v.position[1]));
    expect(Math.min(...heights)).toBeGreaterThanOrEqual(39.2);
    expect(Math.max(...heights)).toBeLessThanOrEqual(41.9);
  });

  it('is deterministic (same input twice -> identical mesh)', () => {
    const second = buildOne(makeGateBuilding());
    expect(second.triangleCount).toBe(built.triangleCount);
    expect(second.vertexCount).toBe(built.vertexCount);
    expect(Array.from(second.positions)).toEqual(Array.from(built.positions));
  });

  it('reports stable triangle counts per data variant', () => {
    // Regular volumes (2 bases + 2 tiers * 10 tris) + clock crown (266)
    // + emblem crown (250).
    expect(buildOne(makeGateBuilding()).triangleCount).toBe(556);
    // Two bases + one tier (30 regular) + clock crown (266).
    expect(buildOne(makeGateBuilding({ tiers: 'one' })).triangleCount).toBe(296);
    // 4 regular volumes (40), first tower crown skipped, emblem crown (250).
    expect(buildOne(makeGateBuilding({ tiers: 'invalid' })).triangleCount).toBe(290);
  });
});

describe('city gate emblem tower', () => {
  it('builds a gold emblem medallion variant without glass dial faces', () => {
    // First tier footprint is too small, so only the second tower gets a crown;
    // index 1 => emblem treatment.
    const built = buildOne(makeGateBuilding({ tiers: 'invalid' }));
    expect(built.triangleCount).toBeGreaterThan(0);
    expect(built.warnings.length).toBeGreaterThan(0); // skipped first tower
    expect(maxY(built.triangles)).toBeGreaterThanOrEqual(43.5);
    expect(built.triangles.filter((triangle) => triangle.faceKind === FACE_KIND.glass)).toHaveLength(0);
    const goldTrim = built.triangles.filter(
      (triangle) => triangle.faceKind === FACE_KIND.trim && colourMatches(triangle, GOLD),
    );
    // 4 medallion faces (10-triangle fans = 40) + 4 turret stars (8 each = 32).
    expect(goldTrim).toHaveLength(72);
  });
});

describe('city gate variants and robustness', () => {
  it('one-tier variant still gets the clock treatment', () => {
    const built = buildOne(makeGateBuilding({ tiers: 'one' }));
    expect(built.warnings).toEqual([]);
    expect(built.triangles.filter((triangle) => triangle.faceKind === FACE_KIND.glass)).toHaveLength(40);
    expect(maxY(built.triangles)).toBeGreaterThanOrEqual(43.5);
  });

  it('no qualifying tier -> warning, no crown, no throw', () => {
    const built = buildOne(makeGateBuilding({ tiers: 'none' }));
    expect(built.warnings.join(' ')).toMatch(/no usable tier/i);
    expect(maxY(built.triangles)).toBeLessThan(20);
    expect(built.triangles.filter((triangle) => triangle.faceKind === FACE_KIND.glass)).toHaveLength(0);
  });

  it('empty volumes -> warning, no throw', () => {
    const empty = makeGateBuilding();
    empty.volumes = [];
    const result = buildBuildingsMesh([empty], { facadeDetail: false });
    expect(result.triangleCount).toBe(0);
    expect((result.warnings ?? []).join(' ')).toMatch(/no volumes/i);
  });

  it('landmark field on an unrelated archetype only adds the crown', () => {
    const built = buildOne(makeGateBuilding({ archetype: 'panel' }));
    expect(built.warnings).toEqual([]);
    // Regular 4-volume mesh is still there, plus two crowns.
    const baseAndTierWalls = built.triangles.filter((triangle) => triangle.faceKind === FACE_KIND.wall);
    expect(baseAndTierWalls.length).toBeGreaterThan(0);
    expect(maxY(built.triangles)).toBeGreaterThanOrEqual(43.5);
  });

  it('normal building without landmark is unchanged (no spire)', () => {
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
    const built = buildOne(square);
    expect(built.triangleCount).toBe(10); // 8 wall + 2 flat cap
    expect(maxY(built.triangles)).toBeCloseTo(12, 3);
    expect(
      built.triangles.filter(
        (triangle) =>
          triangle.faceKind === FACE_KIND.roof && triangle.roofShapeId === ROOF_SHAPE_ID.pyramidal,
      ),
    ).toHaveLength(0);
  });
});
