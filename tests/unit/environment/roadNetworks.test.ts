import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type {
  CrossingFeature,
  Ring,
  RoadNetworkPiece,
  RoadSurfacePiece,
  TileData,
} from '../../../src/shared/types';
import { GeometrySink } from '../../../src/city/environment/meshBuilder';
import { BRIDGE_RAISE_M, ENV_LAYER_Y } from '../../../src/city/environment/envLayers';
import { buildEnvironmentMeshes } from '../../../src/city/environment/environmentMeshes';
import { MARKING_COLOR, MARKING_COLOR_DIM } from '../../../src/engine/materials/palette';
import { RAIL_BALLAST_COLOR, RAIL_HEAD_COLOR } from '../../../src/city/roads/roadColors';
import {
  CROSSING_PAINT_Y,
  CROSSING_STOP_LINE_Y,
  createRoadNetworkStats,
  emitRoadNetwork,
  laneMarkingLayout,
  type PaintLine,
  type RoadNetworkStats,
} from '../../../src/city/roads/networkMeshes';
import {
  centerlinePoints,
  offsetAlong,
  pathLength,
  samplePath,
  stationAt,
} from '../../../src/city/roads/roadPath';

type Bounds = [number, number, number, number];
type Vec3 = [number, number, number];

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

function drivable(
  ring: Ring,
  material: RoadSurfacePiece['material'] = 'asphalt',
  bridge = false,
): RoadSurfacePiece {
  return { kind: 'drivable', material, polygon: [ring], ...(bridge ? { bridge: true } : {}) };
}

function networkPiece(overrides: Partial<RoadNetworkPiece> = {}): RoadNetworkPiece {
  return {
    kind: 'road',
    class: 'primary',
    width: 12,
    material: 'asphalt',
    centerline: [-4, 50, 104, 50],
    centerlineOffset: 0,
    ...overrides,
  };
}

function railPiece(overrides: Partial<RoadNetworkPiece> = {}): RoadNetworkPiece {
  return {
    kind: 'rail',
    class: 'unknown',
    width: 2.2,
    centerline: [-4, 50, 104, 50],
    centerlineOffset: 0,
    ...overrides,
  };
}

function crossing(
  kind: CrossingFeature['kind'],
  overrides: Partial<CrossingFeature> = {},
): CrossingFeature {
  return {
    x: 50,
    y: 50,
    angle: 0,
    width: 10,
    span: 4,
    kind,
    roadClass: 'primary',
    material: 'asphalt',
    ...overrides,
  };
}

function linearColor(hex: string): [number, number, number] {
  const color = new THREE.Color(hex).convertSRGBToLinear();
  return [color.r, color.g, color.b];
}

function colorMatches(color: readonly number[], hex: string): boolean {
  const expected = linearColor(hex);
  return expected.every((value, channel) => Math.abs(color[channel] - value) < 1e-5);
}

interface Quad {
  corners: Array<[number, number]>;
  centerX: number;
  centerY: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  height: number;
  color: [number, number, number];
}

/** Read flat paint quads (4 vertices each; the network pass has no other quads). */
function readQuads(geometry: THREE.BufferGeometry): Quad[] {
  const position = geometry.getAttribute('position');
  const color = geometry.getAttribute('color');
  expect(position, 'position attribute').toBeTruthy();
  expect(color, 'color attribute').toBeTruthy();
  const positions = position.array as Float32Array;
  const colors = color.array as Float32Array;
  expect(positions.length % 12, 'whole quads').toBe(0);
  const quads: Quad[] = [];
  for (let v = 0; v < positions.length / 3; v += 4) {
    const corners: Array<[number, number]> = [];
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let height = 0;
    for (let i = 0; i < 4; i++) {
      const base = (v + i) * 3;
      const x = positions[base];
      const y = -positions[base + 2]; // world z = -local y
      height = positions[base + 1];
      corners.push([x, y]);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const colorBase = v * 3;
    quads.push({
      corners,
      centerX: (minX + maxX) / 2,
      centerY: (minY + maxY) / 2,
      minX,
      maxX,
      minY,
      maxY,
      height,
      color: [colors[colorBase], colors[colorBase + 1], colors[colorBase + 2]],
    });
  }
  return quads;
}

interface ReadTriangle {
  a: Vec3;
  b: Vec3;
  c: Vec3;
  color: [number, number, number];
}

function readTriangles(geometry: THREE.BufferGeometry): ReadTriangle[] {
  const position = geometry.getAttribute('position');
  const color = geometry.getAttribute('color');
  const index = geometry.getIndex();
  expect(position).toBeTruthy();
  expect(color).toBeTruthy();
  expect(index).not.toBeNull();
  const positions = position.array as Float32Array;
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
      color: [colors[i0], colors[i0 + 1], colors[i0 + 2]],
    });
  }
  return triangles;
}

function emit(
  tile: TileData,
  bounds: Bounds = BOUNDS,
): { geometry: THREE.BufferGeometry; stats: RoadNetworkStats; quads: Quad[] } {
  const sink = new GeometrySink();
  const stats = createRoadNetworkStats();
  emitRoadNetwork(sink, tile, bounds, stats);
  const geometry = sink.build();
  return { geometry, stats, quads: readQuads(geometry) };
}

/** Paint quads grouped by lateral offset from the centreline (centre y = 50). */
function quadsByLateral(quads: Quad[], hex: string, centreY = 50): Map<string, Quad[]> {
  const out = new Map<string, Quad[]>();
  for (const quad of quads) {
    if (!colorMatches(quad.color, hex)) continue;
    const key = (quad.centerY - centreY).toFixed(2);
    const list = out.get(key) ?? [];
    list.push(quad);
    out.set(key, list);
  }
  return out;
}

/** Group keys sorted numerically (lateral offsets, not lexicographic). */
function lateralKeys(groups: Map<string, Quad[]>): string[] {
  return [...groups.keys()].sort((first, second) => Number(first) - Number(second));
}

// ---------------------------------------------------------------------------
// Lane-marking layout (pure)
// ---------------------------------------------------------------------------

describe('lane-marking layout', () => {
  it('derives a dashed centre line for a two-lane two-way street', () => {
    const lines = laneMarkingLayout({ width: 9, class: 'residential' });
    const centre = lines.filter((line) => line.kind === 'centre');
    expect(centre).toHaveLength(1);
    expect(centre[0]).toMatchObject({
      offset: 0,
      dashed: true,
      length: 3,
      spacing: 7,
      width: 0.5,
    });
    expect(lines.filter((line) => line.kind === 'divider')).toHaveLength(0);
    expect(lines.filter((line) => line.kind === 'edge')).toHaveLength(0);
  });

  it('keeps a narrow two-way street unpainted below 5.5 m', () => {
    expect(laneMarkingLayout({ width: 5.4, class: 'service' })).toHaveLength(0);
    const lines = laneMarkingLayout({ width: 5.5, class: 'service' });
    expect(lines.filter((line) => line.kind === 'centre')).toHaveLength(1);
  });

  it('derives double solid centre, dividers and edge lines on a wide avenue', () => {
    const lines = laneMarkingLayout({ width: 15, class: 'primary' });
    const centre = lines.filter((line) => line.kind === 'centre');
    expect(centre).toHaveLength(2);
    expect(centre.map((line) => line.offset).sort((a, b) => a - b)).toEqual([-0.25, 0.25]);
    for (const line of centre) {
      expect(line.dashed).toBe(false);
      expect(line.width).toBeCloseTo(0.15, 9);
      expect(line.length).toBe(2);
    }
    const dividers = lines.filter((line) => line.kind === 'divider');
    // lanesTotal = round(15/3) = 5 -> 2 lanes per direction.
    expect(dividers).toHaveLength(2);
    expect(dividers.map((line) => line.offset).sort((a, b) => a - b)).toEqual([-3.35, 3.35]);
    for (const line of dividers) {
      expect(line.dashed).toBe(true);
      expect(line).toMatchObject({ length: 2, spacing: 6, width: 0.15 });
    }
    const edges = lines.filter((line) => line.kind === 'edge');
    expect(edges.map((line) => line.offset).sort((a, b) => a - b)).toEqual([-7.1, 7.1]);
  });

  it('derives one-way lane dividers only, with no centre line', () => {
    const lines = laneMarkingLayout({ width: 10.7, class: 'residential', oneway: true });
    expect(lines.filter((line) => line.kind === 'centre')).toHaveLength(0);
    expect(lines.filter((line) => line.kind === 'edge')).toHaveLength(0);
    const dividers = lines.filter((line) => line.kind === 'divider');
    expect(dividers).toHaveLength(2);
    const offsets = dividers.map((line) => line.offset).sort((a, b) => a - b);
    expect(offsets[0]).toBeCloseTo(-1.7833, 3);
    expect(offsets[1]).toBeCloseTo(1.7833, 3);
  });

  it('uses the tagged lane count (Pobediteley, Bogdanovicha, merged Independence)', () => {
    // 6.6 m / lanes=2 one-way: one divider (Pobediteley).
    const pobediteley = laneMarkingLayout({
      width: 6.6,
      class: 'primary',
      oneway: true,
      lanes: 2,
    }).filter((line) => line.kind === 'divider');
    expect(pobediteley).toHaveLength(1);
    expect(pobediteley[0].offset).toBeCloseTo(0, 9);

    // 9.6 m / lanes=3 one-way: two dividers (Bogdanovicha).
    const bogdanovicha = laneMarkingLayout({
      width: 9.6,
      class: 'primary',
      oneway: true,
      lanes: 3,
    })
      .filter((line) => line.kind === 'divider')
      .map((line) => line.offset)
      .sort((a, b) => a - b);
    expect(bogdanovicha[0]).toBeCloseTo(-1.6, 9);
    expect(bogdanovicha[1]).toBeCloseTo(1.6, 9);

    // 24 m merged corridor / lanes=8: double solid + 3 divider rows per side.
    const independence = laneMarkingLayout({
      width: 24,
      class: 'primary',
      lanes: 8,
      merged: true,
    });
    expect(independence.filter((line) => line.kind === 'centre')).toHaveLength(2);
    const mergedDividers = independence
      .filter((line) => line.kind === 'divider')
      .map((line) => line.offset)
      .sort((a, b) => a - b);
    expect(mergedDividers).toHaveLength(6);
    [-8.4, -5.6, -2.8, 2.8, 5.6, 8.4].forEach((expected, index) => {
      expect(mergedDividers[index]).toBeCloseTo(expected, 9);
    });

    // Merged pieces are forced to the two-way layout.
    const forced = laneMarkingLayout({
      width: 9,
      class: 'residential',
      oneway: true,
      merged: true,
    });
    expect(forced.filter((line) => line.kind === 'centre')).toHaveLength(1);
    expect(forced.filter((line) => line.kind === 'divider')).toHaveLength(0);

    // Absurd lane tags are capped by the minimum lane pitch.
    expect(
      laneMarkingLayout({ width: 6.6, class: 'primary', oneway: true, lanes: 8 }).filter(
        (line) => line.kind === 'divider',
      ),
    ).toHaveLength(1);
  });

  it('adds edge lines only for the major classes at 7 m width or more', () => {
    expect(
      laneMarkingLayout({ width: 9, class: 'residential' }).filter((line) => line.kind === 'edge'),
    ).toHaveLength(0);
    expect(
      laneMarkingLayout({ width: 6.9, class: 'primary' }).filter((line) => line.kind === 'edge'),
    ).toHaveLength(0);
    expect(
      laneMarkingLayout({ width: 7, class: 'primary' }).filter((line) => line.kind === 'edge'),
    ).toHaveLength(2);
    expect(
      laneMarkingLayout({ width: 7, class: 'secondary' }).filter((line) => line.kind === 'edge'),
    ).toHaveLength(2);
    expect(
      laneMarkingLayout({ width: 7, class: 'tertiary' }).filter((line) => line.kind === 'edge'),
    ).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Lane paint geometry
// ---------------------------------------------------------------------------

describe('lane paint geometry', () => {
  it('paints a dashed centre line on a two-lane two-way street', () => {
    const result = emit(
      makeTile({
        roadSurfaces: [drivable(rect(-10, 44, 110, 56))],
        roadNetwork: [networkPiece({ width: 9, class: 'residential' })],
      }),
    );
    expect(result.stats.dashes).toBe(14);
    expect(result.stats.solidChunks).toBe(0);
    expect(result.stats.paintedPieces).toBe(1);
    expect(result.stats.boundsSkipped).toBe(2);
    expect(result.quads).toHaveLength(14);
    for (const quad of result.quads) {
      expect(quad.height).toBeCloseTo(ENV_LAYER_Y.markings, 6);
      expect(quad.centerY).toBeCloseTo(50, 6);
      expect(quad.maxX - quad.minX).toBeCloseTo(3, 4);
      expect(quad.maxY - quad.minY).toBeCloseTo(0.5, 4);
      expect(colorMatches(quad.color, MARKING_COLOR)).toBe(true);
    }
    const centers = result.quads.map((quad) => quad.centerX).sort((a, b) => a - b);
    expect(centers[0]).toBeCloseTo(4.5, 4);
    expect(centers[centers.length - 1]).toBeCloseTo(95.5, 4);
    for (let i = 1; i < centers.length; i++) {
      expect(centers[i] - centers[i - 1]).toBeCloseTo(7, 4);
    }
  });

  it('paints double solid centre, per-direction dividers and edge lines on an avenue', () => {
    const result = emit(
      makeTile({
        roadSurfaces: [drivable(rect(-10, 35, 110, 65))],
        roadNetwork: [networkPiece({ width: 15, class: 'primary' })],
      }),
    );
    const groups = quadsByLateral(result.quads, MARKING_COLOR);
    expect(lateralKeys(groups)).toEqual(['-7.10', '-3.35', '-0.25', '0.25', '3.35', '7.10']);
    for (const quads of groups.values()) {
      for (const quad of quads) {
        expect(quad.height).toBeCloseTo(ENV_LAYER_Y.markings, 6);
        expect(quad.maxX - quad.minX).toBeCloseTo(2, 4);
      }
    }
    // Solid centre lines + both edge lines: 50 chunks each; dividers: 17 dashes.
    expect(groups.get('0.25')).toHaveLength(50);
    expect(groups.get('-0.25')).toHaveLength(50);
    expect(groups.get('7.10')).toHaveLength(50);
    expect(groups.get('-7.10')).toHaveLength(50);
    expect(groups.get('3.35')).toHaveLength(17);
    expect(groups.get('-3.35')).toHaveLength(17);
    for (const lateral of ['3.35', '-3.35']) {
      for (const quad of groups.get(lateral)!) {
        expect(quad.maxY - quad.minY).toBeCloseTo(0.15, 4);
      }
    }
    expect(result.stats.solidChunks).toBe(200);
    expect(result.stats.dashes).toBe(34);
    expect(result.stats.markingTriangles).toBe(2 * (200 + 34));
  });

  it('paints merged two-way corridor lanes from the tagged lane count', () => {
    const result = emit(
      makeTile({
        roadSurfaces: [drivable(rect(-30, 20, 130, 80))],
        roadNetwork: [
          networkPiece({ width: 24, class: 'primary', lanes: 8, merged: true }),
        ],
      }),
    );
    const groups = quadsByLateral(result.quads, MARKING_COLOR);
    expect(lateralKeys(groups)).toEqual([
      '-11.60',
      '-8.40',
      '-5.60',
      '-2.80',
      '-0.25',
      '0.25',
      '2.80',
      '5.60',
      '8.40',
      '11.60',
    ]);
    expect(result.stats.paintedPieces).toBe(1);
    expect(result.stats.dashes).toBe(6 * 17);
    expect(result.stats.solidChunks).toBe(4 * 50);
  });

  it('paints one-way lane dividers across the carriageway', () => {
    const result = emit(
      makeTile({
        roadSurfaces: [drivable(rect(-10, 30, 110, 70))],
        roadNetwork: [networkPiece({ width: 10.7, class: 'residential', oneway: true })],
      }),
    );
    expect(result.stats.solidChunks).toBe(0);
    expect(result.stats.dashes).toBe(34);
    const groups = quadsByLateral(result.quads, MARKING_COLOR);
    expect(lateralKeys(groups)).toEqual(['-1.78', '1.78']);
    for (const quads of groups.values()) {
      for (const quad of quads) {
        expect(quad.maxX - quad.minX).toBeCloseTo(2, 4);
        expect(quad.maxY - quad.minY).toBeCloseTo(0.15, 4);
      }
    }
  });

  it('paints residential, tertiary and service streets too', () => {
    const cases: Array<[RoadNetworkPiece['class'], number, number]> = [
      ['residential', 9, 14],
      ['tertiary', 13, 34],
      ['service', 5.5, 14],
    ];
    for (const [roadClass, width, expectedDashes] of cases) {
      const result = emit(
        makeTile({
          roadSurfaces: [drivable(rect(-10, 35, 110, 65))],
          roadNetwork: [networkPiece({ width, class: roadClass })],
        }),
      );
      expect(result.stats.paintedPieces, roadClass).toBe(1);
      expect(result.stats.dashes, roadClass).toBe(expectedDashes);
      expect(result.stats.markingTriangles, roadClass).toBeGreaterThan(0);
    }
  });

  it('raises bridge-deck paint by BRIDGE_RAISE_M and uses bridge asphalt pieces', () => {
    const result = emit(
      makeTile({
        roadSurfaces: [drivable(rect(-10, 44, 110, 56), 'asphalt', true)],
        roadNetwork: [networkPiece({ width: 9, class: 'residential', bridge: true })],
      }),
    );
    expect(result.stats.paintedPieces).toBe(1);
    expect(result.stats.dashes).toBe(14);
    for (const quad of result.quads) {
      expect(quad.height).toBeCloseTo(ENV_LAYER_Y.markings + BRIDGE_RAISE_M, 5);
    }
  });

  it('suppresses every paint type inside junction boxes', () => {
    const dashed = emit(
      makeTile({
        roadSurfaces: [drivable(rect(-10, 44, 110, 56))],
        roadNetwork: [networkPiece({ width: 9, class: 'residential' })],
        junctions: [{ x: 51.5, y: 50, radius: 5, approaches: 4 }],
      }),
    );
    expect(dashed.stats.dashes).toBe(12);
    expect(dashed.stats.junctionSkipped).toBe(2);

    const solid = emit(
      makeTile({
        roadSurfaces: [drivable(rect(-10, 40, 110, 60))],
        roadNetwork: [networkPiece({ width: 9, class: 'primary' })],
        junctions: [{ x: 51.5, y: 50, radius: 5, approaches: 4 }],
      }),
    );
    // 2 edge lines x 50 chunks; 4 chunks each fall in the 5.5 m clearance
    // circle because the edge line is already 4.1 m to the side of the centre.
    expect(solid.stats.solidChunks).toBe(92);
    expect(solid.stats.dashes).toBe(12);
    expect(solid.stats.junctionSkipped).toBe(8 + 2);
  });

  it('skips paint for non-asphalt, non-road and too-narrow pieces', () => {
    const noPaint = (piece: RoadNetworkPiece, material: RoadSurfacePiece['material'] = 'asphalt') =>
      emit(
        makeTile({
          roadSurfaces: [drivable(rect(-10, 35, 110, 65), material)],
          roadNetwork: [piece],
        }),
      ).stats;
    expect(noPaint(networkPiece({ material: 'stone' })).paintedPieces).toBe(0);
    expect(noPaint(networkPiece({ material: undefined })).paintedPieces).toBe(0);
    expect(noPaint(networkPiece({ kind: 'footway', width: 12 })).paintedPieces).toBe(0);
    expect(noPaint(networkPiece({ width: 4, class: 'residential' })).paintedPieces).toBe(0);
    // A bridge piece without bridge asphalt has no containment and stays bare.
    expect(
      emit(
        makeTile({
          roadSurfaces: [drivable(rect(-10, 44, 110, 56))],
          roadNetwork: [networkPiece({ width: 9, class: 'residential', bridge: true })],
        }),
      ).stats.paintedPieces,
    ).toBe(0);
  });

  it('caps lane paint at 8192 triangles per tile deterministically', () => {
    const result = emit(
      makeTile({
        roadSurfaces: [drivable(rect(-10, 0, 20010, 100))],
        roadNetwork: [
          networkPiece({
            width: 10.7,
            class: 'residential',
            oneway: true,
            centerline: [-4, 50, 20004, 50],
          }),
        ],
      }),
      [0, 0, 20000, 20000],
    );
    expect(result.stats.dashes).toBe(4096);
    expect(result.stats.markingTriangles).toBe(8192);
    expect(result.stats.capped).toBe(true);
    expect(result.quads).toHaveLength(4096);
  });

  it('emits each dash exactly once across a tile border and keeps the phase', () => {
    // Same way clipped per tile: global station of world x is x + 7 in both
    // tiles (centerlineOffset 3 for A, 103 for B).
    const tileA = makeTile({
      bounds: [0, 0, 100, 100],
      roadSurfaces: [drivable(rect(-10, 44, 100, 56))],
      roadNetwork: [
        networkPiece({
          width: 9,
          class: 'residential',
          centerline: [-4, 50, 104, 50],
          centerlineOffset: 3,
        }),
      ],
    });
    const tileB = makeTile({
      tileX: 1,
      bounds: [100, 0, 200, 100],
      roadSurfaces: [drivable(rect(100, 44, 210, 56))],
      roadNetwork: [
        networkPiece({
          width: 9,
          class: 'residential',
          centerline: [96, 50, 204, 50],
          centerlineOffset: 103,
        }),
      ],
    });
    const a = emit(tileA, [0, 0, 100, 100]);
    const b = emit(tileB, [100, 0, 200, 100]);
    expect(a.stats.dashes).toBe(15);
    expect(b.stats.dashes).toBe(14);
    expect(a.stats.containmentSkipped).toBe(0);
    expect(b.stats.containmentSkipped).toBe(0);
    expect(b.stats.boundsSkipped).toBe(1);

    const straddling = [...a.quads, ...b.quads].filter(
      (quad) => quad.minX < 100 && quad.maxX > 100,
    );
    expect(straddling).toHaveLength(1);
    expect(straddling[0].centerX).toBeCloseTo(99.5, 4);
    expect(a.quads.some((quad) => Math.abs(quad.centerX - 99.5) < 1e-3)).toBe(true);
    expect(b.quads.some((quad) => Math.abs(quad.centerX - 99.5) < 1e-3)).toBe(false);

    const centers = [...a.quads, ...b.quads].map((quad) => quad.centerX).sort((x, y) => x - y);
    expect(centers).toHaveLength(29);
    for (let i = 1; i < centers.length; i++) {
      expect(centers[i] - centers[i - 1], `phase gap at ${i}`).toBeCloseTo(7, 4);
    }
    expect(centers[centers.length - 1]).toBeCloseTo(197.5, 4);
  });
});

// ---------------------------------------------------------------------------
// Crossing paint
// ---------------------------------------------------------------------------

describe('crossing paint', () => {
  it('keeps the paint heights ordered: dashes < zebra < stop lines < rails', () => {
    expect(CROSSING_PAINT_Y).toBeGreaterThan(ENV_LAYER_Y.markings + 0.001);
    expect(CROSSING_STOP_LINE_Y).toBeGreaterThan(CROSSING_PAINT_Y + 0.0007);
    expect(CROSSING_STOP_LINE_Y).toBeLessThan(ENV_LAYER_Y.railTrack - 0.002);
  });

  it('paints zebra bars along the road plus stop lines on both approaches', () => {
    const result = emit(
      makeTile({
        roadSurfaces: [drivable(rect(20, 20, 80, 80))],
        crossings: [crossing('zebra')],
      }),
    );
    expect(result.stats.crossings).toBe(1);
    expect(result.stats.zebraBars).toBe(9);
    expect(result.stats.zebraTriangles).toBe(18);
    expect(result.stats.stopLines).toBe(2);
    expect(result.stats.markingTriangles).toBe(4);
    expect(result.quads).toHaveLength(11);

    const bars = result.quads.filter((quad) => colorMatches(quad.color, MARKING_COLOR));
    expect(bars).toHaveLength(9);
    for (const bar of bars) {
      // Bars run ALONG the road: span along x, 0.5 m thick across.
      expect(bar.maxX - bar.minX).toBeCloseTo(4, 4);
      expect(bar.maxY - bar.minY).toBeCloseTo(0.5, 4);
      expect(bar.centerX).toBeCloseTo(50, 4);
      expect(bar.height).toBeCloseTo(CROSSING_PAINT_Y, 6);
    }
    const barCentres = bars.map((bar) => bar.centerY).sort((x, y) => x - y);
    expect(barCentres[0]).toBeCloseTo(46, 4);
    expect(barCentres[barCentres.length - 1]).toBeCloseTo(54, 4);

    const stops = result.quads.filter((quad) => colorMatches(quad.color, MARKING_COLOR_DIM));
    expect(stops).toHaveLength(2);
    for (const stop of stops) {
      // Across the carriageway minus the 0.4 m kerb inset, 0.5 m thick.
      expect(stop.maxY - stop.minY).toBeCloseTo(9.2, 4);
      expect(stop.maxX - stop.minX).toBeCloseTo(0.5, 4);
      expect(stop.centerY).toBeCloseTo(50, 4);
      // Stop lines sit above the zebra bars to avoid cross-type z-fighting.
      expect(stop.height).toBeCloseTo(CROSSING_STOP_LINE_Y, 6);
    }
    const stopCentres = stops.map((stop) => stop.centerX).sort((x, y) => x - y);
    expect(stopCentres[0]).toBeCloseTo(47.3, 4);
    expect(stopCentres[1]).toBeCloseTo(52.7, 4);
  });

  it('paints stop lines only for signalised crossings; one line on a one-way', () => {
    const signals = emit(
      makeTile({
        roadSurfaces: [drivable(rect(20, 20, 80, 80))],
        crossings: [crossing('signals')],
      }),
    );
    expect(signals.stats.zebraBars).toBe(0);
    expect(signals.stats.stopLines).toBe(2);

    const oneway = emit(
      makeTile({
        roadSurfaces: [drivable(rect(20, 20, 80, 80))],
        crossings: [crossing('signals', { oneway: true })],
      }),
    );
    expect(oneway.stats.stopLines).toBe(1);
    expect(oneway.quads[0].centerX).toBeCloseTo(47.3, 4);

    const unmarked = emit(
      makeTile({
        roadSurfaces: [drivable(rect(20, 20, 80, 80))],
        crossings: [crossing('unmarked')],
      }),
    );
    expect(unmarked.quads).toHaveLength(0);
    for (const material of ['concrete', 'unpaved', undefined] as const) {
      const skipped = emit(
        makeTile({
          roadSurfaces: [drivable(rect(20, 20, 80, 80))],
          crossings: [crossing('zebra', { material })],
        }),
      );
      expect(skipped.quads, `material ${material}`).toHaveLength(0);
      expect(skipped.stats.crossingsSkipped).toBe(1);
    }
  });

  it('drops zebra bars and stop lines whose corners leave the paved surface', () => {
    const result = emit(
      makeTile({
        // Narrow strip: only the middle 7 zebra bars fit across the carriageway.
        roadSurfaces: [drivable(rect(40, 46, 60, 54))],
        crossings: [crossing('zebra')],
      }),
    );
    expect(result.stats.crossingContainmentSkipped).toBe(4);
    expect(result.stats.zebraBars).toBe(7);
    expect(result.stats.stopLines).toBe(0);
    expect(result.stats.markingTriangles).toBe(0);

    const full = emit(
      makeTile({
        roadSurfaces: [drivable(rect(20, 20, 80, 80))],
        crossings: [crossing('zebra')],
      }),
    );
    expect(full.stats.crossingContainmentSkipped).toBe(0);
    expect(full.stats.zebraBars).toBe(9);
    expect(full.stats.stopLines).toBe(2);
  });

  it('keeps stop lines contained when they span exactly the carriageway width', () => {
    // Asphalt piece exactly as wide as the 10 m crossing: without the kerb
    // inset the stop line corners would sit on the boundary and be dropped.
    const result = emit(
      makeTile({
        roadSurfaces: [drivable(rect(40, 45, 60, 55))],
        crossings: [crossing('zebra')],
      }),
    );
    expect(result.stats.crossingContainmentSkipped).toBe(0);
    expect(result.stats.zebraBars).toBe(9);
    expect(result.stats.stopLines).toBe(2);
    const stops = result.quads.filter((quad) => colorMatches(quad.color, MARKING_COLOR_DIM));
    for (const stop of stops) {
      expect(stop.maxY - stop.minY).toBeCloseTo(9.2, 4);
    }
  });

  it('accepts crossing paint over asphalt and stone carriageway pieces', () => {
    const result = emit(
      makeTile({
        roadSurfaces: [drivable(rect(20, 20, 80, 80), 'stone')],
        crossings: [crossing('zebra', { material: 'stone' })],
      }),
    );
    expect(result.stats.zebraBars).toBe(9);
    expect(result.stats.stopLines).toBe(2);
  });

  it('drops a stop line whose centre falls inside a junction box', () => {
    const result = emit(
      makeTile({
        roadSurfaces: [drivable(rect(30, 40, 70, 60))],
        crossings: [crossing('signals')],
        junctions: [{ x: 47.3, y: 50, radius: 2, approaches: 3 }],
      }),
    );
    expect(result.stats.stopLines).toBe(1);
    expect(result.stats.stopLineJunctionSkipped).toBe(1);
    expect(result.stats.zebraBars).toBe(0);
    expect(result.quads[0].centerX).toBeCloseTo(52.7, 4);
  });

  it('caps zebra bars at 600 triangles per tile', () => {
    const crossings: CrossingFeature[] = [];
    for (let i = 0; i < 20; i++) {
      crossings.push(crossing('zebra', { width: 26, y: 10 + i }));
    }
    const result = emit(
      makeTile({
        roadSurfaces: [drivable(rect(-50, -50, 150, 150))],
        crossings,
      }),
    );
    // 25 bars per crossing: 12 crossings fill the 300-bar (600-tri) budget.
    expect(result.stats.zebraBars).toBe(300);
    expect(result.stats.zebraTriangles).toBe(600);
    expect(result.stats.capped).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tram rails
// ---------------------------------------------------------------------------

describe('tram rails from the network', () => {
  it('emits a ballast strip and two rail heads, with no lane paint', () => {
    const result = emit(makeTile({ roadNetwork: [railPiece()] }));
    expect(result.stats.railPieces).toBe(1);
    expect(result.stats.railSegments).toBe(34);
    expect(result.stats.dashes).toBe(0);
    expect(result.stats.solidChunks).toBe(0);
    expect(result.stats.paintedPieces).toBe(0);

    const triangles = readTriangles(result.geometry);
    expect(result.stats.railTriangles).toBe(triangles.length);
    const ballast = triangles.filter((triangle) => colorMatches(triangle.color, RAIL_BALLAST_COLOR));
    const heads = triangles.filter((triangle) => colorMatches(triangle.color, RAIL_HEAD_COLOR));
    expect(ballast.length).toBeGreaterThan(0);
    expect(heads.length).toBeGreaterThan(0);

    const ballastY = ballast.flatMap((triangle) => [triangle.a[1], triangle.b[1], triangle.c[1]]);
    for (const height of ballastY) expect(height).toBeCloseTo(ENV_LAYER_Y.railBallast, 5);
    const ballastLateral = ballast.flatMap((triangle) => [
      -triangle.a[2],
      -triangle.b[2],
      -triangle.c[2],
    ]);
    expect(Math.min(...ballastLateral)).toBeCloseTo(48.9, 4);
    expect(Math.max(...ballastLateral)).toBeCloseTo(51.1, 4);

    const headHeights = heads.map((triangle) => triangle.a[1]);
    for (const height of headHeights) expect(height).toBeCloseTo(ENV_LAYER_Y.railTrack, 5);
    const headLateral = heads.flatMap((triangle) => [
      -triangle.a[2],
      -triangle.b[2],
      -triangle.c[2],
    ]);
    expect(Math.min(...headLateral)).toBeCloseTo(49.08, 4);
    expect(Math.max(...headLateral)).toBeCloseTo(50.92, 4);
    // Two separate heads: nothing in the middle between them.
    for (const value of headLateral) {
      expect(value <= 49.43 || value >= 50.57, `rail head lateral ${value}`).toBe(true);
    }
  });

  it('clips the strip to the tile, so two adjacent tiles render it exactly once', () => {
    const tileA = makeTile({
      bounds: [0, 0, 100, 100],
      roadNetwork: [railPiece({ centerline: [-4, 50, 104, 50], centerlineOffset: 0 })],
    });
    const tileB = makeTile({
      tileX: 1,
      bounds: [100, 0, 200, 100],
      roadNetwork: [railPiece({ centerline: [96, 50, 204, 50], centerlineOffset: 100 })],
    });
    const a = emit(tileA, [0, 0, 100, 100]);
    const b = emit(tileB, [100, 0, 200, 100]);
    expect(a.stats.railPieces).toBe(1);
    expect(b.stats.railPieces).toBe(1);

    const ballastOf = (geometry: THREE.BufferGeometry): ReadTriangle[] =>
      readTriangles(geometry).filter((triangle) => colorMatches(triangle.color, RAIL_BALLAST_COLOR));
    const ballastA = ballastOf(a.geometry);
    const ballastB = ballastOf(b.geometry);
    expect(ballastA.length).toBeGreaterThan(0);
    expect(ballastB.length).toBeGreaterThan(0);

    const xsA = ballastA.flatMap((triangle) => [triangle.a[0], triangle.b[0], triangle.c[0]]);
    const xsB = ballastB.flatMap((triangle) => [triangle.a[0], triangle.b[0], triangle.c[0]]);
    expect(Math.min(...xsA)).toBeCloseTo(0, 3);
    expect(Math.max(...xsA)).toBeCloseTo(100, 3);
    expect(Math.min(...xsB)).toBeCloseTo(100, 3);
    expect(Math.max(...xsB)).toBeCloseTo(200, 3);
    for (const triangle of ballastA) {
      for (const x of [triangle.a[0], triangle.b[0], triangle.c[0]]) {
        expect(x).toBeLessThanOrEqual(100 + 1e-3);
      }
    }
    for (const triangle of ballastB) {
      for (const x of [triangle.a[0], triangle.b[0], triangle.c[0]]) {
        expect(x).toBeGreaterThanOrEqual(100 - 1e-3);
      }
    }

    // The union covers [0, 200] without a gap (x intervals of the strip).
    const intervals = [...ballastA, ...ballastB]
      .map((triangle) => {
        const xs = [triangle.a[0], triangle.b[0], triangle.c[0]];
        return [Math.min(...xs), Math.max(...xs)] as [number, number];
      })
      .sort((first, second) => first[0] - second[0]);
    let covered = 0;
    let cursor = intervals[0][0];
    for (const [min, max] of intervals) {
      if (max <= cursor) continue;
      covered += Math.max(0, max - Math.max(min, cursor));
      cursor = Math.max(cursor, max);
    }
    expect(covered).toBeCloseTo(200, 1);
  });

  it('does not render legacy tile.roads rails when the network carries rails', () => {
    const result = buildEnvironmentMeshes(
      makeTile({
        roadSurfaces: [drivable(rect(10, 10, 90, 90))],
        roadNetwork: [railPiece()],
        roads: [
          { kind: 'rail', class: 'unknown', polygon: [rect(50, 0, 53.5, 100)], width: 3.5 },
        ],
      }),
      { tileBounds: BOUNDS, trees: false },
    );
    expect(result.counts!.roads.network.railPieces).toBe(1);
    expect(result.counts!.roads.railPolygons).toBe(0);
    expect(result.counts!.roadTriangles).toBe(result.roads.getIndex()!.count / 3);
  });

  it('keeps the legacy rail fallback for old tiles (no roadSurfaces)', () => {
    const result = buildEnvironmentMeshes(
      makeTile({
        roadSurfaces: undefined,
        roads: [
          { kind: 'rail', class: 'unknown', polygon: [rect(50, 5, 53.5, 90)], width: 3.5 },
        ],
      }),
      { tileBounds: BOUNDS, trees: false },
    );
    expect(result.counts!.roads.railPolygons).toBe(1);
    expect(result.counts!.roads.railTriangles).toBeGreaterThan(0);
    expect(result.counts!.roads.network.railPieces).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Road path helpers
// ---------------------------------------------------------------------------

describe('road path helpers', () => {
  it('flattens, welds and rejects malformed centrelines', () => {
    expect(centerlinePoints([0, 0, 10, 0])).toEqual([
      [0, 0],
      [10, 0],
    ]);
    expect(centerlinePoints([0, 0, 0, 0, 10, 0])).toEqual([
      [0, 0],
      [10, 0],
    ]);
    expect(centerlinePoints([0, 0, 10])).toEqual([]);
    expect(centerlinePoints([0, 0, NaN, 2])).toEqual([]);
    expect(centerlinePoints(undefined)).toEqual([]);
    expect(centerlinePoints([1, 1])).toEqual([]);
  });

  it('derives arc-length stations with tangents', () => {
    const points = centerlinePoints([0, 0, 10, 0, 10, 10]);
    expect(pathLength(points)).toBeCloseTo(20, 9);
    const middle = stationAt(points, 15);
    expect(middle).not.toBeNull();
    expect(middle!.x).toBeCloseTo(10, 9);
    expect(middle!.y).toBeCloseTo(5, 9);
    expect(middle!.ux).toBeCloseTo(0, 9);
    expect(middle!.uy).toBeCloseTo(1, 9);
    const offset = offsetAlong(middle!, 2);
    expect(offset[0]).toBeCloseTo(8, 9);
    expect(offset[1]).toBeCloseTo(5, 9);
    const stations = samplePath(points, 2);
    expect(stations.length).toBeGreaterThan(5);
    expect(stations[stations.length - 1].s).toBeCloseTo(20, 6);
    for (const station of stations) {
      expect(Math.hypot(station.ux, station.uy)).toBeCloseTo(1, 6);
    }
  });
});
