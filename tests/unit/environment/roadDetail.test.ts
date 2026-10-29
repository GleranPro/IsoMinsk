import { describe, expect, it } from 'vitest';
import { GeometrySink } from '../../../src/city/environment/meshBuilder';
import { prepareFlatPolygon } from '../../../src/city/environment/triangulate';
import { ringBounds } from '../../../src/shared/tileMath';
import type {
  CrossingFeature,
  Polygon,
  RoadPolygon,
  Ring,
} from '../../../src/shared/types';
import {
  centerlinePoints,
  offsetAlong,
  pathLength,
  samplePath,
  stationAt,
} from '../../../src/city/roads/roadPath';
import { barTriangles, effectiveLanes, laneMarkings } from '../../../src/city/roads/markingLayout';
import {
  addBar,
  CROSSING_PAINT_Y,
  createCrossingStats,
  crossingLayout,
  emitCrossings,
  type RoadSurfaceRef,
} from '../../../src/city/roads/crossings';
import { createMedianStats, emitMedian, medianEligible } from '../../../src/city/roads/medianMesh';
import { createBridgeStats, emitBridgeDetails } from '../../../src/city/roads/bridgeMesh';
import { createRoadStats, emitRoadPolygons } from '../../../src/city/roads/roadMeshes';

function rect(minX: number, minY: number, maxX: number, maxY: number): Ring {
  return [
    [minX, minY],
    [maxX, minY],
    [maxX, maxY],
    [minX, maxY],
  ];
}

function prepared(polygon: Polygon) {
  const result = prepareFlatPolygon(polygon);
  if (!result) throw new Error('fixture polygon must be valid');
  return result;
}

function road(overrides: Partial<RoadPolygon> = {}): RoadPolygon {
  return {
    kind: 'road',
    class: 'primary',
    polygon: [rect(0, -9, 120, 9)],
    width: 18,
    centerline: [0, 0, 120, 0],
    centerlineOffset: 0,
    lanes: 4,
    ...overrides,
  };
}

function surfaceRef(r: RoadPolygon): RoadSurfaceRef {
  const prep = prepared(r.polygon);
  const [minX, minY, maxX, maxY] = ringBounds(prep.exterior);
  return {
    road: r,
    prepared: prep,
    width: Number.isFinite(r.width) ? r.width : 6,
    bbox: [minX, minY, maxX, maxY],
  };
}

describe('roadPath — centreline resampling', () => {
  it('validates the flat centreline array', () => {
    expect(centerlinePoints(undefined)).toEqual([]);
    expect(centerlinePoints([0, 0, 10])).toEqual([]);
    expect(centerlinePoints([0, 0, 10, 0])).toEqual([
      [0, 0],
      [10, 0],
    ]);
    // Non-finite values reject the whole path.
    expect(centerlinePoints([0, 0, Number.NaN, 5])).toEqual([]);
  });

  it('resamples a straight path with arc-length stations and unit tangents', () => {
    const points = centerlinePoints([0, 0, 100, 0]);
    expect(pathLength(points)).toBeCloseTo(100, 6);
    const stations = samplePath(points, 2);
    expect(stations.length).toBeGreaterThan(10);
    for (let i = 1; i < stations.length; i++) {
      expect(stations[i].s).toBeGreaterThan(stations[i - 1].s);
      expect(Math.hypot(stations[i].ux, stations[i].uy)).toBeCloseTo(1, 6);
    }
    // A path along +X has tangent (1, 0) and the left normal points north (+Y).
    expect(stations[0].ux).toBeCloseTo(1, 6);
    expect(offsetAlong(stations[0], 3)[1]).toBeCloseTo(3, 6);
  });

  it('stationAt clamps to the path and interpolates a curve', () => {
    const points = centerlinePoints([0, 0, 10, 0, 10, 10]);
    expect(stationAt(points, 5)!.x).toBeCloseTo(5, 6);
    expect(stationAt(points, 15)!.y).toBeCloseTo(5, 6);
    expect(stationAt(points, -5)!.x).toBeCloseTo(0, 6);
  });
});

describe('markingLayout — lane markings from the centreline', () => {
  it('estimates lanes from the carriageway when untagged', () => {
    expect(effectiveLanes({ width: 3.2 })).toBe(1);
    expect(effectiveLanes({ width: 13 })).toBe(4);
    expect(effectiveLanes({ width: 30 })).toBe(6);
    expect(effectiveLanes({ width: 18, lanes: 3 })).toBe(3);
  });

  it('paints a double solid centre plus edge lines on a wide primary avenue', () => {
    const r = road({ lanes: 6 });
    const polygon = prepared(r.polygon);
    const stations = samplePath(centerlinePoints(r.centerline), 1.6);
    const bars = laneMarkings(r, polygon, stations);
    expect(bars.length).toBeGreaterThan(10);
    // Double centre: two thin solid lines at +-0.17 m around the axis.
    const centre = bars.filter((bar) => Math.abs(bar.cy) < 0.5 && bar.width < 0.2);
    expect(centre.length).toBeGreaterThan(0);
    expect(Math.max(...centre.map((bar) => Math.abs(bar.cy)))).toBeCloseTo(0.17, 1);
    // Edge lines sit near the kerb, about half a metre inside the polygon edge.
    const edge = bars.filter((bar) => Math.abs(bar.cy) > 8 && bar.width < 0.2);
    expect(edge.length).toBeGreaterThan(0);
    // Everything is inside the carriageway.
    for (const bar of bars) {
      expect(Math.abs(bar.cy) + bar.width / 2).toBeLessThanOrEqual(9.01);
    }
    expect(barTriangles(bars)).toBe(bars.length * 2);
  });

  it('uses a dashed centre line on a secondary road and lane dividers when tagged', () => {
    const r = road({ class: 'secondary', lanes: 3, width: 15 });
    const polygon = prepared(r.polygon);
    const stations = samplePath(centerlinePoints(r.centerline), 1.6);
    const bars = laneMarkings(r, polygon, stations);
    const centreDashes = bars.filter((bar) => Math.abs(bar.cy) < 0.2 && Math.abs(bar.cx - 60) < 60);
    expect(centreDashes.length).toBeGreaterThan(0);
    // Dashed: consecutive centre dashes are separated by gaps.
    if (centreDashes.length > 1) {
      const spacing = Math.abs(centreDashes[1].cx - centreDashes[0].cx);
      expect(spacing).toBeGreaterThan(1.5);
    }
    // Lane dividers at +-3 m for width 15 / 3 lanes.
    const dividers = bars.filter((bar) => Math.abs(Math.abs(bar.cy) - 3) < 0.6);
    expect(dividers.length).toBeGreaterThan(0);
  });

  it('paints a red cycle lane tone when cycleway=lane', () => {
    const r = road({ class: 'residential', width: 9, lanes: 2, cycleway: 'lane' });
    const polygon = prepared(r.polygon);
    const stations = samplePath(centerlinePoints(r.centerline), 1.6);
    const bars = laneMarkings(r, polygon, stations);
    expect(bars.some((bar) => bar.tone === 'bike')).toBe(true);
  });

  it('emits nothing for a service alley and skips the centre line when one-way', () => {
    const alley = road({ class: 'service', width: 5.5, lanes: 1 });
    expect(laneMarkings(alley, prepared(alley.polygon), samplePath(centerlinePoints(alley.centerline), 1.6))).toEqual([]);
    const oneway = road({ oneway: true, lanes: 4 });
    const bars = laneMarkings(oneway, prepared(oneway.polygon), samplePath(centerlinePoints(oneway.centerline), 1.6));
    // No centre paint between directions, but lane dividers inside the one-way
    // carriageway still exist.
    expect(bars.some((bar) => Math.abs(bar.cy) < 0.3)).toBe(false);
    expect(bars.some((bar) => Math.abs(bar.cy) > 1)).toBe(true);
  });

  it('drops bars that fall outside the carriageway polygon', () => {
    // Short diagonal polygon with a centreline running out of it.
    const r = road({ polygon: [rect(0, -9, 40, 9)], centerline: [0, 0, 120, 0], width: 18, lanes: 2 });
    const bars = laneMarkings(r, prepared(r.polygon), samplePath(centerlinePoints(r.centerline), 1.6));
    expect(bars.length).toBeGreaterThan(0);
    for (const bar of bars) {
      expect(bar.cx).toBeLessThanOrEqual(40.1);
    }
  });
});

describe('crossings — zebra, stop lines and signal heads', () => {
  const crossing: CrossingFeature = {
    x: 60,
    y: 0,
    angle: Math.PI / 2,
    width: 18,
    kind: 'zebra',
    roadClass: 'primary',
  };

  it('lays zebra bars across the road parallel to its axis', () => {
    const layout = crossingLayout(crossing, surfaceRef(road()));
    expect(layout.zebra.length).toBeGreaterThan(10);
    expect(layout.stopLines).toEqual([]);
    expect(layout.signal).toBeNull();
    for (const bar of layout.zebra) {
      // Bars are long along the road (u = +Y here) and thin across it.
      expect(bar.ux).toBeCloseTo(0, 6);
      expect(bar.uy).toBeCloseTo(1, 6);
      expect(bar.length).toBeCloseTo(4, 6);
      expect(bar.width).toBeCloseTo(0.5, 6);
      expect(Math.abs(bar.cx - 60)).toBeLessThanOrEqual(9.1);
    }
  });

  it('adds stop lines and one signal head for a signalised crossing', () => {
    const layout = crossingLayout({ ...crossing, kind: 'signals' }, surfaceRef(road()));
    expect(layout.zebra.length).toBeGreaterThan(10);
    expect(layout.stopLines).toHaveLength(2);
    for (const line of layout.stopLines) {
      expect(line.length).toBeGreaterThan(3);
      expect(line.width).toBeCloseTo(0.45, 6);
    }
    expect(layout.signal).not.toBeNull();
  });

  it('paints nothing for an unmarked crossing on a motorway', () => {
    expect(crossingLayout({ ...crossing, kind: 'unmarked' }, surfaceRef(road())).zebra).toEqual([]);
    expect(crossingLayout({ ...crossing, roadClass: 'motorway' }, surfaceRef(road())).zebra).toEqual([]);
  });

  it('emits bars, stop lines and a signal into the sink with matching stats', () => {
    const sink = new GeometrySink();
    const stats = createCrossingStats();
    const ref = surfaceRef(road());
    emitCrossings(sink, [{ ...crossing, kind: 'signals' }], [ref], stats, 100000);
    expect(stats.matched).toBe(1);
    expect(stats.skipped).toBe(0);
    expect(stats.zebraBars).toBeGreaterThan(10);
    expect(stats.stopLines).toBe(2);
    expect(stats.signalPoles).toBe(1);
    expect(sink.triangleCount).toBe(stats.triangles);
    expect(stats.triangles).toBeGreaterThan(stats.zebraBars * 2);
  });

  it('skips crossings whose point is not on a carriageway of the tile', () => {
    const sink = new GeometrySink();
    const stats = createCrossingStats();
    emitCrossings(sink, [{ ...crossing, x: 500, y: 500 }], [surfaceRef(road())], stats, 100000);
    expect(stats.matched).toBe(0);
    expect(stats.skipped).toBe(1);
    expect(sink.triangleCount).toBe(0);
  });

  it('addBar places a flat quad at the requested height', () => {
    const sink = new GeometrySink();
    const added = addBar(
      sink,
      { cx: 0, cy: 0, ux: 1, uy: 0, length: 4, width: 0.5, tone: 'white' },
      CROSSING_PAINT_Y,
      '#ffffff',
    );
    expect(added).toBe(true);
    expect(sink.triangleCount).toBe(2);
  });
});

describe('medians — derived raised strips', () => {
  it('rejects narrow, one-way, bridge and non-avenue roads', () => {
    expect(medianEligible(road({ width: 20, lanes: 6 }))).toBe(true);
    expect(medianEligible(road({ width: 12, lanes: 4 }))).toBe(false);
    expect(medianEligible(road({ width: 20, lanes: 2, oneway: true }))).toBe(false);
    expect(medianEligible(road({ width: 20, lanes: 6, bridge: true }))).toBe(false);
    expect(medianEligible(road({ class: 'residential', width: 20, lanes: 6 }))).toBe(false);
  });

  it('emits a raised strip and breaks it at a zebra crossing', () => {
    const r = road({ width: 20, lanes: 6 });
    const prep = prepared(r.polygon);
    const stations = samplePath(centerlinePoints(r.centerline), 1.6);
    const stats = createMedianStats();
    const sink = new GeometrySink();
    emitMedian(sink, r, prep, stations, [], [], 0.07, stats, 100000);
    expect(stats.medians).toBe(1);
    expect(stats.medianTriangles).toBeGreaterThan(20);
    expect(sink.triangleCount).toBe(stats.medianTriangles);

    const splitStats = createMedianStats();
    const splitSink = new GeometrySink();
    const crossing: CrossingFeature = {
      x: 60,
      y: 0,
      angle: 0,
      width: 20,
      kind: 'zebra',
      roadClass: 'primary',
      span: 4,
    };
    emitMedian(splitSink, r, prep, stations, [], [crossing], 0.07, splitStats, 100000);
    expect(splitStats.medians).toBe(2);
  });
});

describe('bridges — parapets, posts and piers', () => {
  it('adds rail posts, rails and piers to a bridge deck', () => {
    const r = road({ class: 'secondary', width: 12, bridge: true, lanes: 2 });
    const prep = prepared(r.polygon);
    const stations = samplePath(centerlinePoints(r.centerline), 1.6);
    const stats = createBridgeStats();
    const sink = new GeometrySink();
    emitBridgeDetails(sink, r, prep, stations, 2.57, stats, 100000);
    expect(stats.railPosts).toBeGreaterThan(5);
    expect(stats.piers).toBeGreaterThan(0);
    expect(stats.triangles).toBeGreaterThan(100);
    expect(sink.triangleCount).toBe(stats.triangles);
  });

  it('does nothing for a non-bridge road', () => {
    const stats = createBridgeStats();
    const sink = new GeometrySink();
    const r = road();
    emitBridgeDetails(sink, r, prepared(r.polygon), samplePath(centerlinePoints(r.centerline), 1.6), 2.57, stats, 100000);
    expect(stats.triangles).toBe(0);
    expect(sink.triangleCount).toBe(0);
  });
});

describe('roadMeshes — integration of the new detail', () => {
  const bounds: [number, number, number, number] = [-512, -512, 512, 512];

  it('emits centreline markings, crossings and surface tint from one tile', () => {
    const sink = new GeometrySink();
    const stats = createRoadStats();
    const roads: RoadPolygon[] = [
      road({ surface: 'paving_stones', lanes: 4 }),
      road({ class: 'secondary', width: 15, lanes: 3, polygon: [rect(0, 30, 120, 45)], centerline: [0, 37.5, 120, 37.5] }),
    ];
    const crossings: CrossingFeature[] = [
      { x: 60, y: 0, angle: 0, width: 18, kind: 'zebra', roadClass: 'primary' },
      { x: 60, y: 37.5, angle: 0, width: 15, kind: 'signals', roadClass: 'secondary' },
    ];
    emitRoadPolygons(sink, roads, crossings, bounds, stats);
    expect(stats.centerlineRoads).toBe(2);
    expect(stats.markingBars).toBeGreaterThan(0);
    expect(stats.markingTriangles).toBeGreaterThan(0);
    expect(stats.crossings.matched).toBe(2);
    expect(stats.crossings.signalPoles).toBe(1);
    expect(stats.roadTriangles).toBeGreaterThan(0);
    expect(sink.triangleCount).toBeGreaterThan(0);
  });

  it('stops lane markings inside junction boxes (no paint through a cross street)', () => {
    const sink = new GeometrySink();
    const stats = createRoadStats();
    const roads: RoadPolygon[] = [
      road({ polygon: [rect(0, -9, 120, 9)], centerline: [0, 0, 120, 0], width: 18, lanes: 4 }),
      road({
        class: 'secondary',
        width: 15,
        lanes: 2,
        polygon: [rect(52, -60, 67, 60)],
        centerline: [59.5, -60, 59.5, 60],
      }),
    ];
    emitRoadPolygons(sink, roads, [], bounds, stats);
    expect(stats.markingBarsSkippedJunction).toBeGreaterThan(0);
    expect(stats.markingBars).toBeGreaterThan(0);
  });

  it('falls back to rectangle-axis dashes for legacy tiles without a centreline', () => {
    const sink = new GeometrySink();
    const stats = createRoadStats();
    const legacy = road({ centerline: undefined, lanes: undefined });
    emitRoadPolygons(sink, [legacy], [], bounds, stats);
    expect(stats.centerlineRoads).toBe(0);
    expect(stats.dashes).toBeGreaterThan(0);
    expect(stats.markingTriangles).toBeGreaterThan(0);
  });

  it('skips tunnels entirely', () => {
    const sink = new GeometrySink();
    const stats = createRoadStats();
    emitRoadPolygons(sink, [road({ tunnel: true })], [], bounds, stats);
    expect(stats.tunnelsSkipped).toBe(1);
    expect(sink.triangleCount).toBe(0);
  });
});
