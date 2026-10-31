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
import { ENV_LAYER_Y, maxLayerY } from '../../../src/city/environment/envLayers';
import { MARKING_COLOR, MARKING_COLOR_DIM } from '../../../src/engine/materials/palette';
import {
  CROSSING_PAINT_Y,
  createRoadNetworkStats,
  emitRoadNetwork,
  type RoadNetworkStats,
} from '../../../src/city/roads/networkMeshes';
import { centerlinePoints, offsetAlong, pathLength, samplePath, stationAt } from '../../../src/city/roads/roadPath';

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

function linearColor(hex: string): [number, number, number] {
  const color = new THREE.Color(hex).convertSRGBToLinear();
  return [color.r, color.g, color.b];
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

/** Read the flat quads emitted by the network pass (4 vertices per quad). */
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

function colorMatches(quad: Quad, hex: string): boolean {
  const expected = linearColor(hex);
  return expected.every((value, channel) => Math.abs(quad.color[channel] - value) < 1e-5);
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

function dashQuads(quads: Quad[]): Quad[] {
  return quads.filter((quad) => colorMatches(quad, MARKING_COLOR));
}

function stopLineQuads(quads: Quad[]): Quad[] {
  return quads.filter((quad) => colorMatches(quad, MARKING_COLOR_DIM));
}

const ASPHALT_PIECE: RoadSurfacePiece = {
  kind: 'drivable',
  material: 'asphalt',
  polygon: [rect(-10, 44, 210, 56)],
};

function makeNetworkPiece(overrides: Partial<RoadNetworkPiece> = {}): RoadNetworkPiece {
  return {
    kind: 'road',
    class: 'primary',
    width: 12,
    material: 'asphalt',
    centerline: [-4, 50, 104, 50],
    centerlineOffset: 2,
    ...overrides,
  };
}

describe('road network — dashed centre lines', () => {
  it('paints each dash in exactly one of two adjacent tiles and keeps the phase', () => {
    // Same OSM way clipped per tile (centreline overhangs the border by 4 m).
    // Global station of local x is x + 6 in both tiles: the phases line up.
    // Each tile's asphalt piece is clipped at its own border, so the dash at
    // 99.5 has two corners overhanging into tile B: those are ignored by the
    // containment test (their asphalt lives in B) and A still paints it.
    const tileA = makeTile({
      tileX: 0,
      bounds: [0, 0, 100, 100],
      roadSurfaces: [
        { kind: 'drivable', material: 'asphalt', polygon: [rect(-10, 44, 100, 56)] },
      ],
      roadNetwork: [makeNetworkPiece({ centerline: [-4, 50, 104, 50], centerlineOffset: 2 })],
    });
    const tileB = makeTile({
      tileX: 1,
      bounds: [100, 0, 200, 100],
      roadSurfaces: [
        { kind: 'drivable', material: 'asphalt', polygon: [rect(100, 44, 210, 56)] },
      ],
      roadNetwork: [makeNetworkPiece({ centerline: [96, 50, 204, 50], centerlineOffset: 102 })],
    });
    const a = emit(tileA, [0, 0, 100, 100]);
    const b = emit(tileB, [100, 0, 200, 100]);

    expect(a.stats.dashes).toBe(13);
    // B paints 107.5 .. 195.5; the 203.5 m dash would belong to the next tile.
    expect(b.stats.dashes).toBe(12);
    expect(a.quads).toHaveLength(13);
    expect(b.quads).toHaveLength(12);
    // No dash is dropped by asphalt containment at the tile border any more.
    expect(a.stats.containmentSkipped).toBe(0);
    expect(b.stats.containmentSkipped).toBe(0);
    for (const quad of a.quads) {
      expect(quad.centerX).toBeGreaterThanOrEqual(0);
      expect(quad.centerX).toBeLessThan(100);
      expect(quad.height).toBeCloseTo(ENV_LAYER_Y.markings, 6);
      // Dash 3.0 m along the road (x) by 0.5 m across.
      expect(quad.maxX - quad.minX).toBeCloseTo(3, 4);
      expect(quad.maxY - quad.minY).toBeCloseTo(0.5, 4);
    }
    for (const quad of b.quads) {
      expect(quad.centerX).toBeGreaterThanOrEqual(100);
      expect(quad.centerX).toBeLessThan(200);
    }
    // B sees (and rejects) the dashes whose centres belong to A and to the
    // next tile: ownership rule keeps each dash in exactly one tile.
    expect(b.stats.boundsSkipped).toBe(2);

    const centers = [...a.quads, ...b.quads].map((quad) => quad.centerX).sort((x, y) => x - y);
    expect(centers).toHaveLength(25);
    for (let i = 1; i < centers.length; i++) {
      expect(centers[i] - centers[i - 1], `phase gap at ${i}`).toBeCloseTo(8, 4);
    }
    expect(centers[0]).toBeCloseTo(3.5, 4);
    expect(centers[centers.length - 1]).toBeCloseTo(195.5, 4);

    // Exactly one dash straddles the shared border x = 100, and A paints it;
    // its far corners lie in B's tile but outside A's clipped asphalt piece.
    const straddling = [...a.quads, ...b.quads].filter(
      (quad) => quad.minX < 100 && quad.maxX > 100,
    );
    expect(straddling).toHaveLength(1);
    expect(straddling[0].centerX).toBeCloseTo(99.5, 4);
    expect(straddling[0].maxX).toBeGreaterThan(100);
    expect(a.quads.some((quad) => Math.abs(quad.centerX - 99.5) < 1e-3)).toBe(true);
    expect(b.quads.some((quad) => Math.abs(quad.centerX - 99.5) < 1e-3)).toBe(false);
  });

  it('suppresses dashes inside junction clearance circles', () => {
    const base = makeTile({
      roadSurfaces: [ASPHALT_PIECE],
      roadNetwork: [makeNetworkPiece()],
    });
    const free = emit(base);
    expect(free.stats.dashes).toBe(13);

    const oneJunction = emit(
      makeTile({
        ...base,
        junctions: [{ x: 51.5, y: 50, radius: 5, approaches: 4 }],
      }),
    );
    // radius 5 + dashLen/2 1.5 + 0.5 = 7 m clearance: only the 51.5 m dash.
    expect(oneJunction.stats.dashes).toBe(12);
    expect(oneJunction.stats.junctionSkipped).toBe(1);

    const bigJunction = emit(
      makeTile({
        ...base,
        junctions: [{ x: 51.5, y: 50, radius: 20, approaches: 4 }],
      }),
    );
    expect(bigJunction.stats.dashes).toBe(8);
    expect(bigJunction.stats.junctionSkipped).toBe(5);
  });

  it('clears lane paint around a crossing of the same road but keeps painting it', () => {
    const crossing: CrossingFeature = {
      x: 51.5,
      y: 50,
      angle: 0,
      width: 10,
      span: 4,
      kind: 'zebra',
      roadClass: 'primary',
      material: 'asphalt',
    };
    const base = {
      roadSurfaces: [ASPHALT_PIECE],
      roadNetwork: [makeNetworkPiece()],
    };
    const painted = emit(makeTile({ ...base, crossings: [crossing] }));
    // max(2.5, span/2 + 1) = 3 m clearance: only the 51.5 m dash is cleared.
    expect(painted.stats.dashes).toBe(12);
    expect(painted.stats.crossingClearanceSkipped).toBe(1);
    // The crossing itself is still painted (zebra + both stop lines).
    expect(painted.stats.zebraBars).toBe(9);
    expect(painted.stats.stopLines).toBe(2);

    // A crossing on a different road (perpendicular) must NOT clear our dashes.
    const perpendicular = emit(
      makeTile({ ...base, crossings: [{ ...crossing, angle: Math.PI / 2 }] }),
    );
    expect(perpendicular.stats.dashes).toBe(13);
    expect(perpendicular.stats.crossingClearanceSkipped).toBe(0);
  });

  it('only paints asphalt avenue-class carriageways at least 7 m wide', () => {
    const cases: Array<[string, Partial<RoadNetworkPiece>, number]> = [
      ['stone surface', { material: 'stone' }, 0],
      ['unknown material', { material: undefined }, 0],
      ['bridge', { bridge: true }, 0],
      ['too narrow', { width: 6.9 }, 0],
      ['residential class', { class: 'residential', width: 12 }, 0],
      ['exactly 7 m wide', { width: 7 }, 13],
    ];
    for (const [label, overrides, expected] of cases) {
      const result = emit(
        makeTile({
          roadSurfaces: [ASPHALT_PIECE],
          roadNetwork: [makeNetworkPiece(overrides)],
        }),
      );
      expect(result.stats.dashes, label).toBe(expected);
    }
  });

  it('uses 9 m spacing for secondary streets and checks asphalt containment', () => {
    const secondary = emit(
      makeTile({
        roadSurfaces: [ASPHALT_PIECE],
        roadNetwork: [makeNetworkPiece({ class: 'secondary' })],
      }),
    );
    const centers = dashQuads(secondary.quads)
      .map((quad) => quad.centerX)
      .sort((x, y) => x - y);
    // 4.5, 13.5, ... 94.5 inside [0, 100); the 103.5 m dash belongs to the neighbour.
    expect(centers).toHaveLength(11);
    for (let i = 1; i < centers.length; i++) {
      expect(centers[i] - centers[i - 1]).toBeCloseTo(9, 4);
    }

    // No drivable asphalt piece => all dashes dropped by containment.
    const noAsphalt = emit(
      makeTile({ roadSurfaces: [], roadNetwork: [makeNetworkPiece()] }),
    );
    expect(noAsphalt.stats.dashes).toBe(0);
    expect(noAsphalt.stats.containmentSkipped).toBe(13);

    // The containment piece must be asphalt drivable: a stone piece cannot host
    // asphalt lane paint.
    const stoneOnly = emit(
      makeTile({
        roadSurfaces: [{ ...ASPHALT_PIECE, material: 'stone' }],
        roadNetwork: [makeNetworkPiece()],
      }),
    );
    expect(stoneOnly.stats.dashes).toBe(0);
    expect(stoneOnly.stats.containmentSkipped).toBe(13);
  });

  it('caps lane paint at 900 triangles per tile deterministically', () => {
    const huge: Bounds = [0, 0, 4000, 4000];
    const result = emit(
      makeTile({
        roadSurfaces: [
          { kind: 'drivable', material: 'asphalt', polygon: [rect(-10, -10, 4010, 4010)] },
        ],
        roadNetwork: [
          makeNetworkPiece({ centerline: [-4, 50, 4004, 50], centerlineOffset: 2 }),
        ],
      }),
      huge,
    );
    expect(result.stats.dashes).toBe(450);
    expect(result.stats.markingTriangles).toBe(900);
    expect(result.stats.capped).toBe(true);
    expect(result.quads).toHaveLength(450);
  });
});

describe('road network — crossings', () => {
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

  it('paints zebra bars along the road plus stop lines on both approaches', () => {
    const result = emit(makeTile({ crossings: [crossing('zebra')] }));
    expect(result.stats.crossings).toBe(1);
    expect(result.stats.zebraBars).toBe(9);
    expect(result.stats.zebraTriangles).toBe(18);
    expect(result.stats.stopLines).toBe(2);
    expect(result.stats.markingTriangles).toBe(4);
    expect(result.quads).toHaveLength(11);

    const bars = dashQuads(result.quads);
    expect(bars).toHaveLength(9);
    for (const bar of bars) {
      // Bars run ALONG the road: length = span along x, 0.5 m thick across.
      expect(bar.maxX - bar.minX).toBeCloseTo(4, 4);
      expect(bar.maxY - bar.minY).toBeCloseTo(0.5, 4);
      expect(bar.centerX).toBeCloseTo(50, 4);
      expect(bar.height).toBeCloseTo(CROSSING_PAINT_Y, 6);
    }
    const barCentres = bars.map((bar) => bar.centerY).sort((a, b) => a - b);
    expect(barCentres[0]).toBeCloseTo(46, 4);
    expect(barCentres[barCentres.length - 1]).toBeCloseTo(54, 4);
    for (let i = 1; i < barCentres.length; i++) {
      expect(barCentres[i] - barCentres[i - 1]).toBeCloseTo(1, 4);
    }

    const stops = stopLineQuads(result.quads);
    expect(stops).toHaveLength(2);
    for (const stop of stops) {
      // Stop line: across the carriageway (width long), 0.5 m thick along road.
      expect(stop.maxY - stop.minY).toBeCloseTo(10, 4);
      expect(stop.maxX - stop.minX).toBeCloseTo(0.5, 4);
      expect(stop.centerY).toBeCloseTo(50, 4);
      expect(stop.height).toBeCloseTo(CROSSING_PAINT_Y, 6);
    }
    const stopCentres = stops.map((stop) => stop.centerX).sort((a, b) => a - b);
    expect(stopCentres[0]).toBeCloseTo(47.3, 4);
    expect(stopCentres[1]).toBeCloseTo(52.7, 4);
  });

  it('keeps crossing paint above the lane dashes but inside the markings band', () => {
    // Overlapping coplanar paint would z-fight: crossings sit one jitter step
    // above the centre-line dashes, still inside the markings layer band.
    expect(CROSSING_PAINT_Y).toBeGreaterThan(ENV_LAYER_Y.markings);
    // Above the depth-buffer resolution of the isometric camera (~0.7 mm).
    expect(CROSSING_PAINT_Y - ENV_LAYER_Y.markings).toBeGreaterThan(0.001);
    expect(CROSSING_PAINT_Y).toBeLessThanOrEqual(maxLayerY('markings') + 1e-9);
    expect(CROSSING_PAINT_Y).toBeLessThan(ENV_LAYER_Y.railTrack - 0.002);
  });

  it('paints stop lines only for signalised crossings', () => {
    const signals = emit(makeTile({ crossings: [crossing('signals')] }));
    expect(signals.stats.zebraBars).toBe(0);
    expect(signals.stats.zebraTriangles).toBe(0);
    expect(signals.stats.stopLines).toBe(2);
    expect(stopLineQuads(signals.quads)).toHaveLength(2);
  });

  it('gives a one-way street a single approach stop line', () => {
    const oneway = emit(makeTile({ crossings: [crossing('signals', { oneway: true })] }));
    expect(oneway.stats.zebraBars).toBe(0);
    expect(oneway.stats.stopLines).toBe(1);
    const stops = stopLineQuads(oneway.quads);
    expect(stops).toHaveLength(1);
    // Approach side is -u (travel direction is +u): 50 - 2.7 = 47.3.
    expect(stops[0].centerX).toBeCloseTo(47.3, 4);
  });

  it('paints nothing for unmarked crossings or non-paved materials', () => {
    const unmarked = emit(makeTile({ crossings: [crossing('unmarked')] }));
    expect(unmarked.stats.zebraBars).toBe(0);
    expect(unmarked.stats.stopLines).toBe(0);
    expect(unmarked.quads).toHaveLength(0);

    for (const material of ['concrete', 'unpaved', undefined] as const) {
      const skipped = emit(makeTile({ crossings: [crossing('zebra', { material })] }));
      expect(skipped.quads, `material ${material}`).toHaveLength(0);
      expect(skipped.stats.crossingsSkipped).toBe(1);
    }
  });

  it('paints stone-street zebras and caps zebra bars at 600 triangles', () => {
    const stone = emit(
      makeTile({ crossings: [crossing('zebra', { material: 'stone' })] }),
    );
    expect(stone.stats.zebraBars).toBe(9);

    const crossings: CrossingFeature[] = [];
    for (let i = 0; i < 20; i++) {
      crossings.push(crossing('zebra', { width: 26, y: 10 + i }));
    }
    const capped = emit(makeTile({ crossings }));
    // 25 bars per crossing: 12 crossings fill the 300-bar (600-tri) budget.
    expect(capped.stats.zebraBars).toBe(300);
    expect(capped.stats.zebraTriangles).toBe(600);
    expect(capped.stats.capped).toBe(true);
  });
});

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
    // Resampling covers the path and keeps the tangent unit length.
    const stations = samplePath(points, 2);
    expect(stations.length).toBeGreaterThan(5);
    expect(stations[stations.length - 1].s).toBeCloseTo(20, 6);
    for (const station of stations) {
      expect(Math.hypot(station.ux, station.uy)).toBeCloseTo(1, 6);
    }
  });
});
