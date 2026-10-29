/**
 * Unit tests for the parking surface layer + stall markings.
 *
 * The committed pilot tiles do not carry `parking` surface polygons yet (the
 * data pipeline is being regenerated in parallel), so everything here is built
 * from synthetic `SurfacePolygon` fixtures: rectangles, L-shapes and malformed
 * records.
 */

import { describe, expect, it } from 'vitest';
import type { Ring, SurfacePolygon } from '../../../src/shared/types';
import {
  ENV_LAYER_Y,
  layerY,
  maxLayerY,
  surfaceTier,
} from '../../../src/city/environment/envLayers';
import { GeometrySink } from '../../../src/city/environment/meshBuilder';
import {
  MAX_PARKING_STALL_TRIANGLES_PER_POLYGON,
  MAX_PARKING_STALL_TRIANGLES_PER_TILE,
  STALL_DEPTH_M,
  STALL_SPACING_M,
  STALL_TICK_WIDTH_M,
  emitParkingStalls,
} from '../../../src/city/environment/parkingMesh';
import { createSurfaceStats, emitSurfacePolygons } from '../../../src/city/environment/surfaceMeshes';
import { prepareFlatPolygon, type PreparedPolygon } from '../../../src/city/environment/triangulate';
import { ENV_PALETTE, ROAD_PALETTE, surfaceColor } from '../../../src/engine/materials/palette';

const BOUNDS: [number, number, number, number] = [0, 0, 512, 512];

function rect(minX: number, minY: number, maxX: number, maxY: number): Ring {
  return [
    [minX, minY],
    [maxX, minY],
    [maxX, maxY],
    [minX, maxY],
  ];
}

function prepare(...rings: Ring[]): PreparedPolygon {
  const prepared = prepareFlatPolygon(rings, { minArea: 0.5 });
  expect(prepared, 'fixture must be a valid polygon').not.toBeNull();
  return prepared!;
}

function parkingSurface(...rings: Ring[]): SurfacePolygon {
  return { kind: 'parking', polygon: rings };
}

interface ReadTriangle {
  /** Local-metre x of the three vertices. */
  xs: [number, number, number];
  /** Local-metre y of the three vertices (world z is -local y). */
  ys: [number, number, number];
  /** World-space triangle height. */
  height: number;
  normalY: number;
}

/** Read a built sink geometry back as local-metre triangles. */
function readTriangles(sink: GeometrySink): ReadTriangle[] {
  const geometry = sink.build();
  const position = geometry.getAttribute('position').array as Float32Array;
  const normal = geometry.getAttribute('normal').array as Float32Array;
  const indices = geometry.getIndex()!.array as Uint32Array;
  const triangles: ReadTriangle[] = [];
  for (let i = 0; i < indices.length; i += 3) {
    const i0 = indices[i];
    const i1 = indices[i + 1];
    const i2 = indices[i + 2];
    triangles.push({
      xs: [position[i0 * 3], position[i1 * 3], position[i2 * 3]],
      // world z = -local y (see shared/types.ts).
      ys: [-position[i0 * 3 + 2], -position[i1 * 3 + 2], -position[i2 * 3 + 2]],
      height: position[i0 * 3 + 1],
      normalY: normal[i0 * 3 + 1],
    });
  }
  return triangles;
}

function extent(values: number[]): number {
  return Math.max(...values) - Math.min(...values);
}

function round(value: number, digits = 6): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

describe('parking surface classification', () => {
  it('renders parking at the feature layer, above grass/landuse and below water/road', () => {
    expect(surfaceTier('parking')).toBe('feature');
    expect(ENV_LAYER_Y.feature).toBeGreaterThan(ENV_LAYER_Y.grass);
    expect(ENV_LAYER_Y.feature).toBeGreaterThan(ENV_LAYER_Y.landuse);
    expect(maxLayerY('feature')).toBeLessThan(ENV_LAYER_Y.water);
    expect(maxLayerY('feature')).toBeLessThan(ENV_LAYER_Y.road);

    // Stall marks share the road-marking layer so they stay above the asphalt.
    expect(layerY('markings', 0)).toBeGreaterThanOrEqual(ENV_LAYER_Y.road);
    expect(layerY('markings', 0)).toBeGreaterThan(maxLayerY('feature'));
  });

  it('gives parking its own asphalt tint, slightly lighter than residential road asphalt', () => {
    expect(surfaceColor('parking')).toBe(ENV_PALETTE.parking);
    expect(surfaceColor('parking')).toMatch(/^#[0-9a-f]{6}$/);
    const luminance = (hex: string): number => {
      const h = hex.replace('#', '');
      const r = parseInt(h.slice(0, 2), 16);
      const g = parseInt(h.slice(2, 4), 16);
      const b = parseInt(h.slice(4, 6), 16);
      return r * 0.299 + g * 0.587 + b * 0.114;
    };
    expect(luminance(ENV_PALETTE.parking)).toBeGreaterThan(luminance(ROAD_PALETTE.residential));
    // It must still read as asphalt, not pavement.
    expect(luminance(ENV_PALETTE.parking)).toBeLessThan(luminance('#a9a293'));
  });
});

describe('emitParkingStalls — rectangular lot', () => {
  // 60 m x 20 m lot: long axis along x, two stall rows on the long edges.
  const prepared = prepare(rect(100, 100, 160, 120));

  it('lays out two rows of perpendicular ticks with the documented spacing', () => {
    const sink = new GeometrySink();
    const stats = createSurfaceStats();
    const index = 3;
    const added = emitParkingStalls(sink, prepared, index, stats);

    const usableLength = 60 - 2 * 1; // 1 m end margin on both sides
    const expectedPerRow = Math.floor((usableLength - STALL_TICK_WIDTH_M) / STALL_SPACING_M) + 1;
    expect(added).toBe(expectedPerRow * 2 * 2);
    expect(stats.parkingStalls).toBe(expectedPerRow * 2);
    expect(stats.parkingTriangles).toBe(stats.parkingStalls * 2);
    expect(sink.triangleCount).toBe(stats.parkingTriangles);

    const triangles = readTriangles(sink);
    expect(triangles).toHaveLength(stats.parkingTriangles);
    for (const triangle of triangles) {
      // Flat at the markings layer, facing up.
      expect(triangle.normalY).toBeCloseTo(1, 5);
      expect(triangle.height).toBeCloseTo(layerY('markings', index), 5);
      // Tick: 0.12 m wide along the lot's long axis, 5 m deep across it.
      // (Positions are Float32, so allow 4 decimal digits ≈ 5e-5 m.)
      expect(extent([...triangle.xs])).toBeCloseTo(STALL_TICK_WIDTH_M, 4);
      expect(extent([...triangle.ys])).toBeCloseTo(STALL_DEPTH_M, 4);
      // Every vertex stays strictly inside the asphalt.
      for (const x of triangle.xs) expect(x).toBeGreaterThan(100);
      for (const x of triangle.xs) expect(x).toBeLessThan(160);
      for (const y of triangle.ys) expect(y).toBeGreaterThan(100);
      for (const y of triangle.ys) expect(y).toBeLessThan(120);
    }

    // Exactly two rows, one against each long edge.
    const rowCentres = new Set<string>();
    for (const triangle of triangles) {
      rowCentres.add(round((Math.min(...triangle.ys) + Math.max(...triangle.ys)) / 2, 2).toFixed(2));
    }
    expect(rowCentres.size).toBe(2);
    const rows = [...rowCentres].map(Number).sort((a, b) => a - b);
    expect(rows[0]).toBeCloseTo(100 + 0.12 + STALL_DEPTH_M / 2, 2);
    expect(rows[1]).toBeCloseTo(120 - 0.12 - STALL_DEPTH_M / 2, 2);

    // Ticks are evenly spaced within each row.
    const xCentres = Array.from(
      new Set(triangles.map((triangle) => (Math.min(...triangle.xs) + Math.max(...triangle.xs)) / 2)),
    ).sort((a, b) => a - b);
    expect(xCentres).toHaveLength(expectedPerRow);
    for (let i = 1; i < xCentres.length; i++) {
      expect(xCentres[i] - xCentres[i - 1]).toBeCloseTo(STALL_SPACING_M, 4);
    }
  });

  it('skips stall ticks that would cross a concave/truncated outline', () => {
    // L-shaped lot: a 60 x 20 bounding rectangle with the north-east block cut
    // out, so the row along the top edge can only be painted over the arm.
    const lShape = prepare([
      [0, 0],
      [60, 0],
      [60, 8],
      [8, 8],
      [8, 20],
      [0, 20],
    ]);
    const sink = new GeometrySink();
    const stats = createSurfaceStats();
    emitParkingStalls(sink, lShape, 0, stats);

    // Bottom row is complete, top row is clipped to the 8 m-wide arm.
    expect(stats.parkingStalls).toBeGreaterThan(0);
    expect(stats.parkingStalls).toBeLessThan(46);
    for (const triangle of readTriangles(sink)) {
      for (let i = 0; i < 3; i++) {
        const [x, y] = [triangle.xs[i], triangle.ys[i]];
        const inArmOrBase = y <= 8 || x <= 8;
        expect(inArmOrBase, `tick vertex (${x}, ${y}) must be on the asphalt`).toBe(true);
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(60);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThanOrEqual(20);
      }
    }
  });

  it('is deterministic across builds', () => {
    const firstSink = new GeometrySink();
    const firstStats = createSurfaceStats();
    emitParkingStalls(firstSink, prepared, 2, firstStats);

    const secondSink = new GeometrySink();
    const secondStats = createSurfaceStats();
    emitParkingStalls(secondSink, prepared, 2, secondStats);

    expect(secondStats).toEqual(firstStats);
    const positions = (sink: GeometrySink): number[] =>
      Array.from(sink.build().getAttribute('position').array as Float32Array);
    expect(positions(secondSink)).toEqual(positions(firstSink));
  });
});

describe('emitParkingStalls — skip and cap rules', () => {
  it('does not paint stalls on small, narrow or malformed parking polygons', () => {
    const cases: Array<[string, PreparedPolygon | null]> = [
      ['too small (30 x 5 m)', prepare(rect(0, 0, 30, 5))],
      // 240 m² but only 4 m wide: no room for two 5 m rows.
      ['narrow strip (60 x 4 m)', prepare(rect(0, 0, 60, 4))],
      ['area below threshold (15 x 10 m)', prepare(rect(0, 0, 15, 10))],
      ['null prepared polygon', null],
      ['empty exterior', { exterior: [], holes: [], area: 500 }],
      [
        'non-finite exterior',
        { exterior: [[Number.NaN, 0], [10, 0], [10, 10]], holes: [], area: 500 } as PreparedPolygon,
      ],
    ];
    for (const [label, prepared] of cases) {
      const sink = new GeometrySink();
      const stats = createSurfaceStats();
      expect(() => emitParkingStalls(sink, prepared, 0, stats), label).not.toThrow();
      expect(stats.parkingStalls, label).toBe(0);
      expect(stats.parkingTriangles, label).toBe(0);
      expect(sink.triangleCount, label).toBe(0);
    }
  });

  it('caps stall triangles per polygon and per tile', () => {
    const largeLot = prepare(rect(0, 0, 600, 20));

    // Single polygon: capped at the per-polygon budget, both rows present.
    const sink = new GeometrySink();
    const stats = createSurfaceStats();
    emitParkingStalls(sink, largeLot, 0, stats);
    expect(stats.parkingTriangles).toBe(MAX_PARKING_STALL_TRIANGLES_PER_POLYGON);
    expect(stats.parkingStalls).toBe(MAX_PARKING_STALL_TRIANGLES_PER_POLYGON / 2);
    expect(sink.triangleCount).toBe(MAX_PARKING_STALL_TRIANGLES_PER_POLYGON);

    // Several large lots: the tile budget stops further ticks.
    const tileSink = new GeometrySink();
    const tileStats = createSurfaceStats();
    for (let i = 0; i < 4; i++) {
      emitParkingStalls(tileSink, largeLot, i, tileStats);
    }
    expect(tileStats.parkingTriangles).toBe(MAX_PARKING_STALL_TRIANGLES_PER_TILE);
    expect(tileStats.parkingStalls).toBe(MAX_PARKING_STALL_TRIANGLES_PER_TILE / 2);
    expect(tileSink.triangleCount).toBe(MAX_PARKING_STALL_TRIANGLES_PER_TILE);
  });
});

describe('emitSurfacePolygons — parking integration', () => {
  it('emits the parking surface at the feature layer, then its stall marks', () => {
    const sink = new GeometrySink();
    const stats = createSurfaceStats();
    emitSurfacePolygons(
      sink,
      [parkingSurface(rect(100, 100, 160, 120)), { kind: 'grass', polygon: [rect(300, 300, 340, 340)] }],
      BOUNDS,
      stats,
    );

    expect(stats.skippedPolygons).toBe(0);
    expect(stats.degeneratePolygons).toBe(0);
    expect(stats.surfacePolygons).toBe(2);
    expect(stats.parkingPolygons).toBe(1);
    expect(stats.parkingStalls).toBeGreaterThan(0);
    expect(stats.parkingTriangles).toBe(stats.parkingStalls * 2);

    const triangles = readTriangles(sink);
    // 2 triangles of asphalt + grass fill + one quad per stall tick.
    expect(triangles.length).toBe(2 + 2 + stats.parkingTriangles);
    expect(sink.triangleCount).toBe(stats.surfaceTriangles + stats.parkingTriangles);

    // Parking asphalt height comes from the feature band, stall marks from the
    // markings band.
    const parkingSurfaceTriangles = triangles.filter(
      (triangle) =>
        triangle.height >= ENV_LAYER_Y.feature - 1e-6 && triangle.height < ENV_LAYER_Y.water,
    );
    expect(parkingSurfaceTriangles).toHaveLength(2);
    for (const triangle of parkingSurfaceTriangles) {
      expect(triangle.height).toBeGreaterThanOrEqual(ENV_LAYER_Y.feature - 1e-6);
      expect(triangle.height).toBeLessThanOrEqual(maxLayerY('feature') + 1e-6);
    }
    const markingHeights = triangles
      .filter((triangle) => triangle.height >= ENV_LAYER_Y.markings - 1e-4)
      .map((triangle) => triangle.height);
    expect(markingHeights.length).toBe(stats.parkingTriangles);
    for (const height of markingHeights) expect(height).toBeCloseTo(layerY('markings', 0), 5);

    // Every stall triangle sits inside the parking polygon.
    for (const triangle of triangles.filter((t) => t.height >= ENV_LAYER_Y.markings - 1e-4)) {
      for (let i = 0; i < 3; i++) {
        expect(triangle.xs[i]).toBeGreaterThan(100);
        expect(triangle.xs[i]).toBeLessThan(160);
        expect(triangle.ys[i]).toBeGreaterThan(100);
        expect(triangle.ys[i]).toBeLessThan(120);
      }
    }
  });

  it('leaves the existing surface behaviour unchanged for non-parking kinds', () => {
    const sink = new GeometrySink();
    const stats = createSurfaceStats();
    emitSurfacePolygons(sink, [{ kind: 'grass', polygon: [rect(100, 100, 140, 140)] }], BOUNDS, stats);

    expect(stats.surfacePolygons).toBe(1);
    expect(stats.surfaceTriangles).toBe(sink.triangleCount);
    expect(stats.parkingPolygons).toBe(0);
    expect(stats.parkingStalls).toBe(0);
    expect(stats.parkingTriangles).toBe(0);
    expect(layerY('feature', 0)).toBeCloseTo(ENV_LAYER_Y.feature, 6);
  });

  it('skips a malformed parking surface without throwing or counting it', () => {
    const sink = new GeometrySink();
    const stats = createSurfaceStats();
    const malformed = parkingSurface([
      [Number.NaN, 0],
      [10, 0],
      [10, 10],
    ]);
    expect(() => emitSurfacePolygons(sink, [malformed], BOUNDS, stats)).not.toThrow();
    expect(stats.surfacePolygons).toBe(0);
    expect(stats.parkingPolygons).toBe(0);
    expect(stats.parkingStalls).toBe(0);
    expect(sink.triangleCount).toBe(0);
  });
});
