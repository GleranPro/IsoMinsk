import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { Ring, SurfacePolygon, TileData, TreeInstance } from '../../../src/shared/types';
import { buildEnvironmentMeshes } from '../../../src/city/environment/environmentMeshes';
import {
  BRIDGE_RAISE_M,
  ENV_LAYER_ORDER,
  ENV_LAYER_Y,
  maxLayerY,
} from '../../../src/city/environment/envLayers';
import { TREE_TRIANGLES_FULL } from '../../../src/city/environment/treeMeshes';

type Vec3 = [number, number, number];

const BOUNDS: [number, number, number, number] = [1024, -512, 1536, 0];

function rect(minX: number, minY: number, maxX: number, maxY: number): Ring {
  return [
    [minX, minY],
    [maxX, minY],
    [maxX, maxY],
    [minX, maxY],
  ];
}

function surface(kind: SurfacePolygon['kind'], ...rings: Ring[]): SurfacePolygon {
  return { kind, polygon: rings };
}

function makeTile(overrides: Partial<TileData> = {}): TileData {
  return {
    tileX: 2,
    tileY: -1,
    bounds: BOUNDS,
    buildings: [],
    surfaces: [],
    roads: [],
    trees: [],
    ...overrides,
  };
}

function makeTree(x: number, y: number, overrides: Partial<TreeInstance> = {}): TreeInstance {
  return { x, y, height: 8, radius: 3, variation: 0.5, mapped: true, ...overrides };
}

interface ReadTriangle {
  a: Vec3;
  b: Vec3;
  c: Vec3;
  normal: Vec3;
}

function readTriangles(geometry: THREE.BufferGeometry): ReadTriangle[] {
  const position = geometry.getAttribute('position');
  const normal = geometry.getAttribute('normal');
  const index = geometry.getIndex();
  expect(position).toBeTruthy();
  expect(normal).toBeTruthy();
  expect(index).not.toBeNull();
  const positions = position.array as Float32Array;
  const normals = normal.array as Float32Array;
  const indices = index!.array as Uint32Array;
  const triangles: ReadTriangle[] = [];
  for (let i = 0; i < indices.length; i += 3) {
    const i0 = indices[i] * 3;
    const i1 = indices[i + 1] * 3;
    const i2 = indices[i + 2] * 3;
    triangles.push({
      a: [positions[i0], positions[i0 + 1], positions[i0 + 2]],
      b: [positions[i1], positions[i1 + 1], positions[i1 + 2]],
      c: [positions[i2], positions[i2 + 1], positions[i2 + 2]],
      normal: [normals[i0], normals[i0 + 1], normals[i0 + 2]],
    });
  }
  return triangles;
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function triangleArea(triangle: ReadTriangle): number {
  return Math.hypot(...cross(sub(triangle.b, triangle.a), sub(triangle.c, triangle.a))) / 2;
}

function assertValidGeometry(geometry: THREE.BufferGeometry, label: string): void {
  const position = geometry.getAttribute('position');
  const normal = geometry.getAttribute('normal');
  const color = geometry.getAttribute('color');
  const index = geometry.getIndex();
  expect(position, `${label} position`).toBeTruthy();
  expect(normal, `${label} normal`).toBeTruthy();
  expect(color, `${label} color`).toBeTruthy();
  // Option A colour contract: exactly one standard linear-RGB vertex colour
  // attribute, so the environment material multiplies it exactly once.
  expect(geometry.getAttribute('aColor'), `${label} has no duplicate aColor`).toBeUndefined();
  expect(index, `${label} index`).not.toBeNull();

  const positions = position.array as Float32Array;
  const normals = normal.array as Float32Array;
  const colors = color.array as Float32Array;
  const indices = index!.array as Uint32Array;
  let allFinite = true;
  for (let i = 0; i < positions.length; i++) if (!Number.isFinite(positions[i])) allFinite = false;
  for (let i = 0; i < normals.length; i++) if (!Number.isFinite(normals[i])) allFinite = false;
  for (let i = 0; i < colors.length; i++) if (!Number.isFinite(colors[i])) allFinite = false;
  expect(allFinite, `${label} all attributes finite`).toBe(true);

  let indicesValid = true;
  for (let i = 0; i < indices.length; i++) {
    const vertex = indices[i];
    if (!Number.isInteger(vertex) || vertex < 0 || vertex >= position.count) indicesValid = false;
  }
  expect(indicesValid, `${label} indices in range`).toBe(true);
  expect(indices.length % 3, `${label} index count divisible by 3`).toBe(0);

  for (const triangle of readTriangles(geometry)) {
    expect(triangleArea(triangle), `${label} non-degenerate triangle`).toBeGreaterThan(1e-9);
    const normalLength = Math.hypot(...triangle.normal);
    expect(normalLength, `${label} unit normal`).toBeCloseTo(1, 4);
    // Winding must agree with the supplied normal.
    const faceNormal = cross(sub(triangle.b, triangle.a), sub(triangle.c, triangle.a));
    const dot =
      faceNormal[0] * triangle.normal[0] +
      faceNormal[1] * triangle.normal[1] +
      faceNormal[2] * triangle.normal[2];
    expect(dot, `${label} winding matches normal`).toBeGreaterThan(0);
  }
}

function flatTriangles(geometry: THREE.BufferGeometry): ReadTriangle[] {
  return readTriangles(geometry).filter((triangle) => triangle.normal[1] > 0.9);
}

function flatHeights(geometry: THREE.BufferGeometry): number[] {
  return flatTriangles(geometry).map((triangle) => triangle.a[1]);
}

function hasFlatHeightInBand(geometry: THREE.BufferGeometry, base: number, max: number): boolean {
  // Positions are Float32, so allow ~1e-8 of storage rounding on band edges.
  const tolerance = 1e-6;
  return flatHeights(geometry).some((y) => y >= base - tolerance && y <= max + tolerance);
}

function richTile(): TileData {
  return makeTile({
    surfaces: [
      surface('grass', rect(1050, -480, 1150, -400)),
      surface('park', rect(1200, -400, 1400, -200), rect(1250, -350, 1350, -250)),
      surface('river', rect(1450, -500, 1510, -100)),
      surface('plaza', rect(1100, -500, 1180, -450)),
      surface('residential', rect(1250, -480, 1400, -420)),
      surface('forest', rect(1300, -120, 1400, -40)),
    ],
    roads: [
      // Wide avenue: surface + kerb + dashed centre line.
      { kind: 'road', class: 'primary', polygon: [rect(1000, -260, 1120, -242)], width: 18 },
      // Second avenue, north/south.
      { kind: 'road', class: 'secondary', polygon: [rect(1160, -450, 1178, -300)], width: 18 },
      // Pavement, drawn at the sidewalk layer.
      { kind: 'footway', class: 'footway', polygon: [rect(1040, -300, 1044, -240)], width: 4 },
      // Tram / rail: ballast + two rail lines.
      { kind: 'rail', class: 'unknown', polygon: [rect(1200, -500, 1203.5, -460)], width: 3.5 },
      // Bridge across the river: raised deck + skirt.
      { kind: 'road', class: 'secondary', polygon: [rect(1430, -320, 1500, -300)], width: 20, bridge: true },
      // Tunnel: must not be rendered at all.
      { kind: 'road', class: 'secondary', polygon: [rect(1300, -350, 1360, -330)], width: 20, tunnel: true },
    ],
    trees: [
      makeTree(1060, -460, { height: 9, radius: 3.2 }),
      makeTree(1200, -380, { height: 7, radius: 2.4, variation: 0.2 }),
      makeTree(1100, -480, { height: 11, radius: 4, variation: 0.8 }),
      makeTree(1480, -460, { height: 6, radius: 2, variation: 0.4 }),
    ],
  });
}

describe('buildEnvironmentMeshes — empty / minimal tiles', () => {
  it('always emits the base ground quad covering the tile', () => {
    const result = buildEnvironmentMeshes(makeTile(), { tileBounds: BOUNDS, trees: true, treeStyle: 'legacy' });
    expect(result.trees).toBeNull();
    expect(result.triangleCount).toBe(2);
    expect(result.counts!.groundTriangles).toBe(2);
    expect(result.counts!.roadTriangles).toBe(0);

    const triangles = readTriangles(result.ground);
    expect(triangles).toHaveLength(2);
    const xs: number[] = [];
    const zs: number[] = [];
    for (const triangle of triangles) {
      for (const vertex of [triangle.a, triangle.b, triangle.c]) {
        expect(vertex[1]).toBe(ENV_LAYER_Y.base);
        xs.push(vertex[0]);
        zs.push(vertex[2]);
      }
    }
    expect(Math.min(...xs)).toBe(BOUNDS[0]);
    expect(Math.max(...xs)).toBe(BOUNDS[2]);
    // world z = -local y, so the tile spans [-maxY, -minY].
    expect(Math.min(...zs)).toBe(-BOUNDS[3]);
    expect(Math.max(...zs)).toBe(-BOUNDS[1]);
    assertValidGeometry(result.ground, 'ground');
    assertValidGeometry(result.roads, 'roads');
  });

  it('falls back to tile bounds when options bounds are invalid', () => {
    const result = buildEnvironmentMeshes(makeTile(), {
      tileBounds: [NaN, 0, 0, 0],
      trees: false,
    });
    expect(result.counts!.groundTriangles).toBe(2);
    const xs = flatTriangles(result.ground).flatMap((triangle) => [triangle.a[0], triangle.b[0], triangle.c[0]]);
    expect(Math.min(...xs)).toBe(BOUNDS[0]);
    expect(Math.max(...xs)).toBe(BOUNDS[2]);
  });

  it('does not emit tree geometry when trees are disabled', () => {
    const result = buildEnvironmentMeshes(richTile(), { tileBounds: BOUNDS, trees: false });
    expect(result.trees).toBeNull();
    expect(result.counts!.treeTriangles).toBe(0);
  });
});

describe('buildEnvironmentMeshes — full environment', () => {
  it('emits every category in its band and keeps the geometry valid', () => {
    const result = buildEnvironmentMeshes(richTile(), { tileBounds: BOUNDS, trees: true, treeStyle: 'legacy' });
    assertValidGeometry(result.ground, 'ground');
    assertValidGeometry(result.roads, 'roads');
    expect(result.trees).not.toBeNull();
    assertValidGeometry(result.trees!, 'trees');

    expect(result.counts!.groundTriangles).toBeGreaterThan(2);
    expect(result.counts!.roadTriangles).toBeGreaterThan(0);
    expect(result.counts!.treeTriangles).toBe(4 * TREE_TRIANGLES_FULL);
    expect(result.counts!.treeTier).toBe('full');

    // Every flat ground/road height below bridge level belongs to exactly one
    // layer band — no ambiguous coplanar categories.
    const heights = [...flatHeights(result.ground), ...flatHeights(result.roads)].filter((y) => y < 1);
    expect(heights.length).toBeGreaterThan(10);
    for (const y of heights) {
      // Float32 positions lose ~1e-8; allow a small tolerance on band edges.
      const matchingBands = ENV_LAYER_ORDER.filter(
        (key) => y >= ENV_LAYER_Y[key] - 1e-6 && y <= maxLayerY(key) + 1e-6,
      );
      expect(matchingBands, `height ${y} must match exactly one layer band`).toHaveLength(1);
    }

    // Each semantic layer is actually represented.
    expect(hasFlatHeightInBand(result.ground, ENV_LAYER_Y.landuse, maxLayerY('landuse'))).toBe(true);
    expect(hasFlatHeightInBand(result.ground, ENV_LAYER_Y.grass, maxLayerY('grass'))).toBe(true);
    // Plaza in the fixture sits above the park/grass layer and below water.
    expect(hasFlatHeightInBand(result.ground, ENV_LAYER_Y.feature, maxLayerY('feature'))).toBe(true);
    expect(hasFlatHeightInBand(result.ground, ENV_LAYER_Y.water, maxLayerY('water'))).toBe(true);
    expect(hasFlatHeightInBand(result.roads, ENV_LAYER_Y.sidewalk, maxLayerY('sidewalk'))).toBe(true);
    expect(hasFlatHeightInBand(result.roads, ENV_LAYER_Y.railBallast, maxLayerY('railBallast'))).toBe(true);
    expect(hasFlatHeightInBand(result.roads, ENV_LAYER_Y.road, maxLayerY('road'))).toBe(true);
    expect(hasFlatHeightInBand(result.roads, ENV_LAYER_Y.markings, maxLayerY('markings'))).toBe(true);
    expect(hasFlatHeightInBand(result.roads, ENV_LAYER_Y.railTrack, maxLayerY('railTrack'))).toBe(true);
    // Kerb has no jitter, so it is exactly at its layer height.
    expect(flatHeights(result.roads).some((y) => Math.abs(y - ENV_LAYER_Y.kerb) < 1e-6)).toBe(true);

    const roadStats = result.counts!.roads;
    expect(roadStats.dashes).toBeGreaterThan(0);
    expect(roadStats.markingTriangles).toBeGreaterThan(0);
    expect(roadStats.kerbTriangles).toBeGreaterThan(0);
    expect(roadStats.railSegments).toBeGreaterThan(0);
    expect(roadStats.railPolygons).toBe(1);
    expect(roadStats.tunnelsSkipped).toBe(1);
    expect(roadStats.bridges).toBe(1);
    expect(result.counts!.surfaces.waterBands).toBeGreaterThan(0);

    // triangleCount is the sum of the three merges.
    expect(result.triangleCount).toBe(
      result.counts!.groundTriangles + result.counts!.roadTriangles + result.counts!.treeTriangles,
    );
    expect(result.triangleCount).toBe(
      result.ground.getIndex()!.count / 3 +
        result.roads.getIndex()!.count / 3 +
        result.trees!.getIndex()!.count / 3,
    );
  });

  it('raises bridge decks and gives them a skirt down to the ground', () => {
    const result = buildEnvironmentMeshes(richTile(), { tileBounds: BOUNDS, trees: false });
    const triangles = readTriangles(result.roads);
    const deckTriangles = triangles.filter(
      (triangle) => triangle.normal[1] > 0.9 && triangle.a[1] > 1,
    );
    expect(deckTriangles.length).toBeGreaterThan(0);
    const expectedDeckY = ENV_LAYER_Y.road + BRIDGE_RAISE_M;
    for (const triangle of deckTriangles) {
      expect(triangle.a[1]).toBeGreaterThan(expectedDeckY - 0.05);
      expect(triangle.a[1]).toBeLessThan(expectedDeckY + 0.05);
    }
    // Vertical skirt triangles connect the deck to the base layer.
    const skirt = triangles.filter((triangle) => Math.abs(triangle.normal[1]) < 1e-6);
    expect(skirt.length).toBeGreaterThan(0);
    const skirtMinY = Math.min(...skirt.flatMap((t) => [t.a[1], t.b[1], t.c[1]]));
    const skirtMaxY = Math.max(...skirt.flatMap((t) => [t.a[1], t.b[1], t.c[1]]));
    expect(skirtMinY).toBeCloseTo(0, 6);
    // Deck height = road layer + BRIDGE_RAISE_M (+ deterministic jitter).
    const maxDeckY = maxLayerY('road') + BRIDGE_RAISE_M;
    expect(skirtMaxY).toBeGreaterThanOrEqual(expectedDeckY - 0.001);
    expect(skirtMaxY).toBeLessThanOrEqual(maxDeckY + 0.001);
  });

  it('renders nothing for tunnel polygons', () => {
    const tile = makeTile({
      roads: [
        { kind: 'road', class: 'primary', polygon: [rect(1050, -260, 1170, -242)], width: 18, tunnel: true },
      ],
    });
    const result = buildEnvironmentMeshes(tile, { tileBounds: BOUNDS, trees: false });
    expect(result.roads.getIndex()!.count).toBe(0);
    expect(result.counts!.roadTriangles).toBe(0);
    expect(result.counts!.roads.tunnelsSkipped).toBe(1);
  });

  it('keeps ground/roads flat geometry at or below the top ground layer unless it is a bridge', () => {
    const result = buildEnvironmentMeshes(richTile(), { tileBounds: BOUNDS, trees: false });
    for (const geometry of [result.ground, result.roads]) {
      for (const triangle of flatTriangles(geometry)) {
        const y = triangle.a[1];
        if (y > 1) {
          // Only raised bridge decks may be above ground level.
          expect(y).toBeGreaterThan(ENV_LAYER_Y.road + BRIDGE_RAISE_M - 0.06);
        } else {
          expect(y).toBeLessThanOrEqual(maxLayerY('railTrack') + 1e-6);
        }
      }
    }
  });

  it('is deterministic across builds', () => {
    const first = buildEnvironmentMeshes(richTile(), { tileBounds: BOUNDS, trees: true, treeStyle: 'legacy' });
    const second = buildEnvironmentMeshes(richTile(), { tileBounds: BOUNDS, trees: true, treeStyle: 'legacy' });
    expect(second.triangleCount).toBe(first.triangleCount);
    expect(second.counts).toEqual(first.counts);
    const positions = (geometry: THREE.BufferGeometry): number[] =>
      Array.from(geometry.getAttribute('position').array as Float32Array);
    expect(positions(second.ground)).toEqual(positions(first.ground));
    expect(positions(second.roads)).toEqual(positions(first.roads));
    expect(positions(second.trees!)).toEqual(positions(first.trees!));
  });
});

describe('buildEnvironmentMeshes — robustness', () => {
  it('never throws on malformed tile data and still renders valid geometry', () => {
    const malformed = makeTile({
      surfaces: [
        null as unknown as SurfacePolygon,
        { kind: 'grass', polygon: undefined } as unknown as SurfacePolygon,
        { kind: 'water', polygon: [] },
        { kind: 'grass', polygon: [[[NaN, 0], [10, 0], [10, 10]]] },
        surface('grass', rect(1050, -400, 1100, -350)),
      ],
      roads: [
        null as never,
        { kind: 'road', class: 'primary', polygon: undefined } as unknown as never,
        { kind: 'road', class: 'primary', polygon: [], width: 18 },
        { kind: 'road', class: 'primary', polygon: [[[NaN, 0], [10, 0], [10, 10]]], width: 18 },
        { kind: 'rail', class: 'unknown', polygon: [rect(1200, -500, 1203.5, -460)], width: -4 },
        { kind: 'road', class: 'primary', polygon: [rect(1050, -260, 1170, -242)], width: NaN },
        { kind: 'road', class: 'unknown', polygon: [[[0, 0], [10, 0]]], width: 5 },
      ],
      trees: [
        null as unknown as TreeInstance,
        makeTree(NaN, 0),
        makeTree(0, Infinity),
        makeTree(1100, -450),
      ],
    });
    expect(() => buildEnvironmentMeshes(malformed, { tileBounds: BOUNDS, trees: true, treeStyle: 'legacy' })).not.toThrow();
    const result = buildEnvironmentMeshes(malformed, { tileBounds: BOUNDS, trees: true, treeStyle: 'legacy' });
    assertValidGeometry(result.ground, 'ground');
    assertValidGeometry(result.roads, 'roads');
    assertValidGeometry(result.trees!, 'trees');
    expect(result.counts!.trees).toBe(1);
    expect(result.triangleCount).toBeGreaterThan(2);
  });

  it('produces no triangles for a degenerate polygon but does not throw', () => {
    const tile = makeTile({
      surfaces: [surface('grass', [[0, 0], [1, 1]])],
      roads: [{ kind: 'road', class: 'primary', polygon: [[[0, 0], [10, 0], [20, 0]]], width: 18 }],
    });
    const result = buildEnvironmentMeshes(tile, { tileBounds: BOUNDS, trees: true, treeStyle: 'legacy' });
    expect(result.counts!.groundTriangles).toBe(2); // base quad only
    expect(result.counts!.roadTriangles).toBe(0);
    expect(result.triangleCount).toBe(2);
    assertValidGeometry(result.ground, 'ground');
  });

  it('survives tile-like garbage (missing arrays) without throwing', () => {
    const garbage = { tileX: 2, tileY: -1 } as unknown as TileData;
    expect(() => buildEnvironmentMeshes(garbage, { tileBounds: BOUNDS, trees: true, treeStyle: 'legacy' })).not.toThrow();
    const result = buildEnvironmentMeshes(garbage, { tileBounds: BOUNDS, trees: true, treeStyle: 'legacy' });
    expect(result.triangleCount).toBe(2);
  });
});

describe('buildEnvironmentMeshes — performance budget', () => {
  it('stays under 3000 ground+roads triangles on a dense synthetic tile', () => {
    const surfaces: SurfacePolygon[] = [];
    for (let i = 0; i < 12; i++) {
      surfaces.push(surface('grass', rect(1030 + i * 20, -500 + i * 10, 1045 + i * 20, -480 + i * 10)));
    }
    for (let i = 0; i < 8; i++) {
      surfaces.push(surface('residential', rect(1040 + i * 30, -200, 1060 + i * 30, -160)));
    }
    surfaces.push(surface('river', rect(1400, -480, 1460, -120)));

    const roads: TileData['roads'] = [];
    for (let i = 0; i < 8; i++) {
      roads.push({
        kind: 'road',
        class: 'primary',
        polygon: [rect(1020, -460 + i * 40, 1120, -442 + i * 40)],
        width: 18,
      });
    }
    for (let i = 0; i < 10; i++) {
      roads.push({
        kind: 'road',
        class: 'residential',
        polygon: [rect(1140 + i * 15, -480, 1152 + i * 15, -380)],
        width: 9,
      });
    }
    for (let i = 0; i < 4; i++) {
      roads.push({
        kind: 'rail',
        class: 'unknown',
        polygon: [rect(1300 + i * 20, -500, 1303.5 + i * 20, -440)],
        width: 3.5,
      });
    }
    roads.push({
      kind: 'footway',
      class: 'footway',
      polygon: [rect(1390, -480, 1393, -300)],
      width: 3,
    });

    const trees: TreeInstance[] = [];
    for (let i = 0; i < 300; i++) {
      trees.push(makeTree(1030 + (i % 20) * 24, -500 + Math.floor(i / 20) * 22, { variation: (i % 10) / 10 }));
    }

    const result = buildEnvironmentMeshes(makeTile({ surfaces, roads, trees }), {
      tileBounds: BOUNDS,
      trees: true,
      treeStyle: 'legacy',
    });
    expect(result.counts!.groundTriangles + result.counts!.roadTriangles).toBeLessThan(3000);
    expect(result.triangleCount).toBeLessThan(12000);
  });
});
