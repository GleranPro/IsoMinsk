import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { Ring, RoadPolygon, RoadSurfacePiece, TileData } from '../../../src/shared/types';
import { buildEnvironmentMeshes } from '../../../src/city/environment/environmentMeshes';
import { BRIDGE_RAISE_M, ENV_LAYER_Y } from '../../../src/city/environment/envLayers';
import {
  KERB_COLOR,
  MEDIAN_COLOR,
  PAVING_COLOR,
  SURFACE_COLORS,
  shadeHex,
} from '../../../src/engine/materials/palette';

type Vec3 = [number, number, number];
type Bounds = [number, number, number, number];

const BOUNDS: Bounds = [0, 0, 100, 100];

function rect(minX: number, minY: number, maxX: number, maxY: number): Ring {
  return [
    [minX, minY],
    [maxX, minY],
    [maxX, maxY],
    [minX, maxY],
  ];
}

function makeTile(overrides: Partial<TileData> = {}): TileData {
  return {
    tileX: 0,
    tileY: 0,
    bounds: BOUNDS,
    buildings: [],
    surfaces: [],
    roads: [],
    roadSurfaces: [],
    roadNetwork: [],
    junctions: [],
    crossings: [],
    trees: [],
    ...overrides,
  };
}

interface ReadTriangle {
  a: Vec3;
  b: Vec3;
  c: Vec3;
  normal: Vec3;
  color: Vec3;
}

function readTriangles(geometry: THREE.BufferGeometry): ReadTriangle[] {
  const position = geometry.getAttribute('position');
  const normal = geometry.getAttribute('normal');
  const color = geometry.getAttribute('color');
  const index = geometry.getIndex();
  expect(position, 'position attribute').toBeTruthy();
  expect(normal, 'normal attribute').toBeTruthy();
  expect(color, 'color attribute').toBeTruthy();
  expect(index, 'index').not.toBeNull();
  const positions = position.array as Float32Array;
  const normals = normal.array as Float32Array;
  const colors = color.array as Float32Array;
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
      color: [colors[i0], colors[i0 + 1], colors[i0 + 2]],
    });
  }
  return triangles;
}

function linearColor(hex: string): Vec3 {
  const color = new THREE.Color(hex).convertSRGBToLinear();
  return [color.r, color.g, color.b];
}

function expectColor(actual: Vec3, hex: string, label: string): void {
  const expected = linearColor(hex);
  for (let channel = 0; channel < 3; channel++) {
    expect(actual[channel], `${label} colour channel ${channel}`).toBeCloseTo(expected[channel], 5);
  }
}

function trianglesWithColor(triangles: ReadTriangle[], hex: string): ReadTriangle[] {
  const expected = linearColor(hex);
  return triangles.filter((triangle) =>
    expected.every((value, channel) => Math.abs(triangle.color[channel] - value) < 1e-5),
  );
}

function makePiece(
  kind: RoadSurfacePiece['kind'],
  ring: Ring,
  overrides: Partial<RoadSurfacePiece> = {},
): RoadSurfacePiece {
  return { kind, polygon: [ring], ...overrides };
}

describe('normalized road surfaces — payload 0.2.0', () => {
  it('draws each kind at its exact semantic layer with the palette colour', () => {
    const tile = makeTile({
      roadSurfaces: [
        // Two asphalt pieces of a partition: same layer, no per-piece jitter.
        makePiece('drivable', rect(2, 2, 30, 30), { material: 'asphalt' }),
        makePiece('drivable', rect(2, 35, 30, 60), { material: 'asphalt' }),
        makePiece('drivable', rect(35, 2, 60, 30), { material: 'stone' }),
        makePiece('drivable', rect(35, 35, 60, 60), { material: 'concrete' }),
        makePiece('drivable', rect(62, 2, 90, 30), { material: 'unpaved' }),
        makePiece('paving', rect(2, 65, 90, 70)),
        makePiece('kerb', rect(2, 72, 90, 73)),
        makePiece('median', rect(2, 75, 90, 77)),
      ],
    });
    const result = buildEnvironmentMeshes(tile, { tileBounds: BOUNDS, trees: false });
    const flat = readTriangles(result.roads).filter((triangle) => triangle.normal[1] > 0.9);
    expect(flat.length).toBeGreaterThan(10);

    const surfaces = result.counts!.roads.surfaces;
    expect(surfaces.pieces).toBe(8);
    expect(surfaces.drivablePieces).toBe(5);
    expect(surfaces.pavingPieces).toBe(1);
    expect(surfaces.kerbPieces).toBe(1);
    expect(surfaces.medianPieces).toBe(1);
    expect(surfaces.materials).toEqual({ asphalt: 2, stone: 1, concrete: 1, unpaved: 1 });
    expect(surfaces.triangles).toBeGreaterThan(0);
    expect(surfaces.culledPieces).toBe(0);
    expect(surfaces.skippedPieces).toBe(0);
    expect(surfaces.degeneratePieces).toBe(0);

    // Two asphalt pieces: all at exactly the road layer (no jitter band).
    const asphalt = trianglesWithColor(flat, SURFACE_COLORS.asphalt);
    expect(asphalt).toHaveLength(4);
    const asphaltHeights = new Set(asphalt.map((triangle) => triangle.a[1]));
    expect(asphaltHeights.size).toBe(1);
    for (const triangle of asphalt) {
      expect(triangle.a[1]).toBeCloseTo(ENV_LAYER_Y.road, 6);
    }

    const perMaterial: Array<[RoadSurfacePiece['material'], number]> = [
      ['stone', 2],
      ['concrete', 2],
      ['unpaved', 2],
    ];
    for (const [material, expectedTriangles] of perMaterial) {
      const triangles = trianglesWithColor(flat, SURFACE_COLORS[material!]);
      expect(triangles, `${material} triangles`).toHaveLength(expectedTriangles);
      for (const triangle of triangles) {
        expectColor(triangle.color, SURFACE_COLORS[material!], material!);
        expect(triangle.a[1]).toBeCloseTo(ENV_LAYER_Y.road, 6);
      }
    }

    const paving = trianglesWithColor(flat, PAVING_COLOR);
    expect(paving).toHaveLength(2);
    for (const triangle of paving) expect(triangle.a[1]).toBeCloseTo(ENV_LAYER_Y.sidewalk, 6);

    const kerb = trianglesWithColor(flat, KERB_COLOR);
    expect(kerb).toHaveLength(2);
    for (const triangle of kerb) expect(triangle.a[1]).toBeCloseTo(ENV_LAYER_Y.kerb, 6);

    const median = trianglesWithColor(flat, MEDIAN_COLOR);
    expect(median).toHaveLength(2);
    for (const triangle of median) expect(triangle.a[1]).toBeCloseTo(ENV_LAYER_Y.median, 6);

    // One merged roads geometry: counts and geometry agree exactly.
    expect(result.counts!.roadTriangles).toBe(result.roads.getIndex()!.count / 3);
    expect(result.counts!.roadTriangles).toBe(surfaces.triangles);
  });

  it('raises bridge pieces by BRIDGE_RAISE_M and gives them vertical skirts', () => {
    const tile = makeTile({
      roadSurfaces: [
        makePiece('drivable', rect(10, 10, 40, 40), { material: 'asphalt', bridge: true }),
      ],
    });
    const result = buildEnvironmentMeshes(tile, { tileBounds: BOUNDS, trees: false });
    const triangles = readTriangles(result.roads);
    const deckY = ENV_LAYER_Y.road + BRIDGE_RAISE_M;

    const deck = triangles.filter((triangle) => triangle.normal[1] > 0.9);
    expect(deck).toHaveLength(2);
    for (const triangle of deck) {
      expect(triangle.a[1]).toBeCloseTo(deckY, 5);
      expectColor(triangle.color, SURFACE_COLORS.asphalt, 'bridge deck');
    }

    // Skirt walls: a rectangle has 4 edges => 8 vertical triangles, ground to deck.
    const skirt = triangles.filter((triangle) => Math.abs(triangle.normal[1]) < 1e-6);
    expect(skirt).toHaveLength(8);
    const skirtMinY = Math.min(...skirt.flatMap((triangle) => [triangle.a[1], triangle.b[1], triangle.c[1]]));
    const skirtMaxY = Math.max(...skirt.flatMap((triangle) => [triangle.a[1], triangle.b[1], triangle.c[1]]));
    expect(skirtMinY).toBeCloseTo(0, 5);
    expect(skirtMaxY).toBeCloseTo(deckY, 5);
    for (const triangle of skirt) {
      expectColor(triangle.color, shadeHex(SURFACE_COLORS.asphalt, -0.28), 'bridge skirt');
    }

    const surfaces = result.counts!.roads.surfaces;
    expect(surfaces.bridgePieces).toBe(1);
    expect(surfaces.bridgeTriangles).toBe(10);
    expect(surfaces.triangles).toBe(10);
    // Isolated deck (no adjacent ground carriageway): every edge keeps a skirt.
    expect(surfaces.bridgeEdgesSkipped).toBe(0);
  });

  it('skips the deck-end skirt where a bridge meets the ground carriageway', () => {
    const tile = makeTile({
      roadSurfaces: [
        // Raised deck whose east end runs into the ground-level stone road.
        makePiece('drivable', rect(20, 10, 80, 40), { material: 'asphalt', bridge: true }),
        makePiece('drivable', rect(80, 10, 100, 40), { material: 'stone' }),
      ],
    });
    const result = buildEnvironmentMeshes(tile, { tileBounds: BOUNDS, trees: false });
    const triangles = readTriangles(result.roads);
    const deckY = ENV_LAYER_Y.road + BRIDGE_RAISE_M;

    const deck = triangles.filter((triangle) => triangle.normal[1] > 0.9 && triangle.a[1] > 1);
    expect(deck).toHaveLength(2);
    for (const triangle of deck) expect(triangle.a[1]).toBeCloseTo(deckY, 5);

    // 4 rectangle edges - 1 deck end meeting the ground road = 3 skirted
    // edges => 6 vertical triangles. No full-width wall across the avenue end.
    const skirt = triangles.filter((triangle) => Math.abs(triangle.normal[1]) < 1e-6);
    expect(skirt).toHaveLength(6);
    const eastWall = skirt.filter((triangle) =>
      [triangle.a, triangle.b, triangle.c].every((vertex) => Math.abs(vertex[0] - 80) < 1e-3),
    );
    expect(eastWall).toHaveLength(0);
    // Skirts are kept on the other three edges (over water/land/paving).
    const westWall = skirt.filter((triangle) =>
      [triangle.a, triangle.b, triangle.c].every((vertex) => Math.abs(vertex[0] - 20) < 1e-3),
    );
    expect(westWall.length).toBeGreaterThan(0);

    const surfaces = result.counts!.roads.surfaces;
    expect(surfaces.bridgePieces).toBe(1);
    expect(surfaces.bridgeEdgesSkipped).toBe(1);
    expect(surfaces.bridgeTriangles).toBe(8); // 2 deck + 6 skirt

    // The ground carriageway still renders flat at the road layer.
    const ground = triangles.filter(
      (triangle) => triangle.normal[1] > 0.9 && triangle.a[1] < 1,
    );
    const groundStone = trianglesWithColor(ground, SURFACE_COLORS.stone);
    expect(groundStone).toHaveLength(2);
    for (const triangle of groundStone) {
      expect(triangle.a[1]).toBeCloseTo(ENV_LAYER_Y.road, 6);
    }
  });

  it('keeps bridge sidewalks flat (no second skirt wall along the deck edge)', () => {
    const tile = makeTile({
      roadSurfaces: [
        makePiece('drivable', rect(10, 10, 60, 40), { material: 'asphalt', bridge: true }),
        makePiece('paving', rect(10, 2, 60, 10), { bridge: true }),
      ],
    });
    const result = buildEnvironmentMeshes(tile, { tileBounds: BOUNDS, trees: false });
    const triangles = readTriangles(result.roads);
    const deckY = ENV_LAYER_Y.road + BRIDGE_RAISE_M;
    const pavingY = ENV_LAYER_Y.sidewalk + BRIDGE_RAISE_M;

    const pavingTop = trianglesWithColor(
      triangles.filter((triangle) => triangle.normal[1] > 0.9),
      PAVING_COLOR,
    );
    expect(pavingTop).toHaveLength(2);
    for (const triangle of pavingTop) expect(triangle.a[1]).toBeCloseTo(pavingY, 5);

    // The bridge sidewalk is a thin slab on the deck: it must not emit its own
    // dark skirt (that was the visible face across the footway at deck ends).
    expect(trianglesWithColor(triangles, shadeHex(PAVING_COLOR, -0.28))).toHaveLength(0);

    const surfaces = result.counts!.roads.surfaces;
    expect(surfaces.bridgePieces).toBe(2);
    expect(surfaces.bridgeTriangles).toBe(12); // 2 asphalt deck + 8 skirt + 2 flat paving
    for (const triangle of triangles.filter((trim) => Math.abs(trim.normal[1]) < 1e-6)) {
      // Every vertical face belongs to the drivable deck.
      expectColor(triangle.color, shadeHex(SURFACE_COLORS.asphalt, -0.28), 'deck skirt');
    }
    void deckY;
  });

  it('skips malformed, degenerate and off-tile pieces without throwing', () => {
    const tile = makeTile({
      roadSurfaces: [
        null as unknown as RoadSurfacePiece,
        { kind: 'drivable', material: 'asphalt' } as unknown as RoadSurfacePiece,
        { kind: 'bogus', polygon: [rect(2, 2, 10, 10)] } as unknown as RoadSurfacePiece,
        // Collinear ring: zero area, rejected as degenerate.
        makePiece('drivable', [
          [0, 0],
          [10, 0],
          [20, 0],
        ], { material: 'asphalt' }),
        // two-point "ring": still degenerate.
        { kind: 'drivable', material: 'asphalt', polygon: [[[0, 0], [10, 0]]] } as unknown as RoadSurfacePiece,
        // Valid polygon that belongs to another tile.
        makePiece('drivable', rect(-90, -90, -20, -20), { material: 'asphalt' }),
        // The only renderable piece.
        makePiece('drivable', rect(5, 5, 25, 25), { material: 'concrete' }),
      ],
    });
    expect(() => buildEnvironmentMeshes(tile, { tileBounds: BOUNDS, trees: false })).not.toThrow();
    const result = buildEnvironmentMeshes(tile, { tileBounds: BOUNDS, trees: false });
    const surfaces = result.counts!.roads.surfaces;
    expect(surfaces.pieces).toBe(1);
    expect(surfaces.drivablePieces).toBe(1);
    expect(surfaces.materials.concrete).toBe(1);
    expect(surfaces.skippedPieces).toBe(3);
    expect(surfaces.degeneratePieces).toBe(2);
    expect(surfaces.culledPieces).toBe(1);

    const triangles = readTriangles(result.roads);
    expect(triangles).toHaveLength(2);
    expectColor(triangles[0].color, SURFACE_COLORS.concrete, 'valid piece');
  });

  it('renders legacy rails on a new-path tile and legacy roads on an old tile', () => {
    const rail: RoadPolygon = {
      kind: 'rail',
      class: 'unknown',
      polygon: [rect(50, 5, 53.5, 80)],
      width: 3.5,
    };
    const newTile = makeTile({
      roadSurfaces: [makePiece('paving', rect(2, 2, 45, 90))],
      roads: [rail],
    });
    const newResult = buildEnvironmentMeshes(newTile, { tileBounds: BOUNDS, trees: false });
    expect(newResult.counts!.roads.surfaces.pieces).toBe(1);
    expect(newResult.counts!.roads.railPolygons).toBe(1);
    expect(newResult.counts!.roads.railTriangles).toBeGreaterThan(0);
    expect(newResult.counts!.roads.network.pieces).toBe(0);
    expect(newResult.counts!.roadTriangles).toBe(newResult.roads.getIndex()!.count / 3);

    // Old payload (no roadSurfaces): buffered polygons still render.
    const legacyTile = makeTile({
      roadSurfaces: undefined,
      roads: [
        {
          kind: 'road',
          class: 'primary',
          polygon: [rect(5, 5, 60, 23)],
          width: 18,
        },
      ],
    });
    const legacyResult = buildEnvironmentMeshes(legacyTile, { tileBounds: BOUNDS, trees: false });
    const legacyStats = legacyResult.counts!.roads;
    expect(legacyStats.roadPolygons).toBe(1);
    expect(legacyStats.roadTriangles).toBeGreaterThan(0);
    expect(legacyStats.dashes).toBeGreaterThan(0);
    expect(legacyStats.markingTriangles).toBeGreaterThan(0);
    // New-path counters stay empty on the fallback.
    expect(legacyStats.surfaces.pieces).toBe(0);
    expect(legacyStats.network.dashes).toBe(0);
    expect(legacyStats.network.pieces).toBe(0);
  });
});
