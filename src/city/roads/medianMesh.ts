/**
 * Raised medians for wide two-way avenues.
 *
 * Minsk's main avenues carry a physical strip between the directions (lawn or
 * stone with a kerb). OSM does not map that strip as a polygon, but for wide
 * two-way carriageways it is derivable: a raised strip of 1.4–3 m along the
 * centreline. The strip is broken where a painted crossing crosses the road and
 * wherever another carriageway polygon overlaps the centreline (junctions), so
 * the zebra bars and crossing streets stay unobstructed.
 *
 * Geometry: a top quad with two vertical side faces and end caps, 14 cm high,
 * emitted into the shared roads sink (no extra draw calls).
 */

import type { CrossingFeature, RoadPolygon } from '../../shared/types';
import type { GeometrySink } from '../environment/meshBuilder';
import type { PreparedPolygon } from '../environment/triangulate';
import { pointInPreparedPolygon } from './roadAnalysis';
import { offsetAlong, type PathStation } from './roadPath';
import type { RoadSurfaceRef } from './crossings';
import { medianColor, roadSeed } from './roadColors';
import { shadeHex } from '../../engine/materials/palette';

export interface MedianStats {
  /** Number of emitted median runs. */
  medians: number;
  medianTriangles: number;
}

export function createMedianStats(): MedianStats {
  return { medians: 0, medianTriangles: 0 };
}

/** Median top height above the road layer, metres. */
const MEDIAN_RAISE_M = 0.14;
/** Classes that get a median when wide enough. */
const MEDIAN_CLASSES: ReadonlySet<RoadPolygon['class']> = new Set([
  'motorway',
  'trunk',
  'primary',
  'secondary',
]);
const MEDIAN_MIN_WIDTH_M = 14;
const MEDIAN_MIN_LANES = 4;
const MEDIAN_MIN_LENGTH_M = 45;
/** Gap kept around crossings and at junction/road overlaps, metres. */
const MEDIAN_CROSSING_GAP_M = 6;
/** A median breaks when another street's centreline comes this close, metres. */
const MEDIAN_JUNCTION_DIST_M = 5;
/** Minimum length of a median run that is worth drawing. */
const MEDIAN_MIN_RUN_M = 5;

function clamp(value: number, lo: number, hi: number): number {
  return value < lo ? lo : value > hi ? hi : value;
}

/** Squared distance from a point to a segment (2D), metres². */
function pointSegmentDistanceSq(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  if (!(lengthSq > 1e-9)) {
    const ex = px - ax;
    const ey = py - ay;
    return ex * ex + ey * ey;
  }
  let t = ((px - ax) * dx + (py - ay) * dy) / lengthSq;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = ax + dx * t;
  const qy = ay + dy * t;
  const ex = px - qx;
  const ey = py - qy;
  return ex * ex + ey * ey;
}

/** True when the road is eligible for a derived median at all. */
export function medianEligible(road: RoadPolygon): boolean {
  if (road.kind !== 'road' || road.oneway || road.bridge || road.tunnel) return false;
  if (!MEDIAN_CLASSES.has(road.class)) return false;
  const width = Number.isFinite(road.width) ? road.width : 0;
  const lanes = typeof road.lanes === 'number' ? road.lanes : 0;
  return width >= MEDIAN_MIN_WIDTH_M && (lanes >= MEDIAN_MIN_LANES || width >= 17);
}

/**
 * Emit the median strip for one road piece (if eligible). `others` are the
 * prepared carriageway polygons of the same tile, used to punch junction gaps.
 */
export function emitMedian(
  sink: GeometrySink,
  road: RoadPolygon,
  prepared: PreparedPolygon,
  stations: readonly PathStation[],
  others: readonly RoadSurfaceRef[],
  crossings: readonly CrossingFeature[],
  y: number,
  stats: MedianStats,
  maxTriangles: number,
): void {
  if (!medianEligible(road)) return;
  if (stats.medianTriangles >= maxTriangles) return;
  if (stations.length < 4) return;
  const total = stations[stations.length - 1].s;
  if (total < MEDIAN_MIN_LENGTH_M) return;

  const width = Number.isFinite(road.width) ? road.width : MEDIAN_MIN_WIDTH_M;
  const half = clamp(width * 0.11, 1.4, 3.0) / 2;
  const color = medianColor(roadSeed(road));
  const sideColor = shadeHex(color, -0.24);
  const topY = y + MEDIAN_RAISE_M;

  // Junction detection: another street's CENTRELINE crossing our path. Plain
  // polygon overlap is not enough — a parallel carriageway or a service aisle
  // can overlap our asphalt for the whole street without being a junction.
  interface OtherSegment {
    ax: number;
    ay: number;
    bx: number;
    by: number;
  }
  const otherSegments: OtherSegment[] = [];
  const otherPolygons: RoadSurfaceRef[] = [];
  for (const other of others) {
    if (other.prepared === prepared) continue;
    const flat = other.road.centerline;
    if (Array.isArray(flat) && flat.length >= 4 && flat.length % 2 === 0) {
      for (let i = 0; i + 3 < flat.length; i += 2) {
        const ax = flat[i];
        const ay = flat[i + 1];
        const bx = flat[i + 2];
        const by = flat[i + 3];
        if (
          Number.isFinite(ax) &&
          Number.isFinite(ay) &&
          Number.isFinite(bx) &&
          Number.isFinite(by)
        ) {
          otherSegments.push({ ax, ay, bx, by });
        }
      }
    } else {
      otherPolygons.push(other);
    }
  }
  const junctionDistSq = MEDIAN_JUNCTION_DIST_M * MEDIAN_JUNCTION_DIST_M;

  // Decide per-station whether the median may exist there.
  const allowed: boolean[] = stations.map((station) => {
    if (station.s < 8 || station.s > total - 8) return false;
    for (const crossing of crossings) {
      if (!Number.isFinite(crossing.x) || !Number.isFinite(crossing.y)) continue;
      const span = Number.isFinite(crossing.span) && (crossing.span as number) > 0
        ? (crossing.span as number)
        : 4;
      const distance = Math.hypot(station.x - crossing.x, station.y - crossing.y);
      if (distance < MEDIAN_CROSSING_GAP_M + span / 2) return false;
    }
    const px = station.x;
    const py = station.y;
    for (const segment of otherSegments) {
      if (pointSegmentDistanceSq(px, py, segment.ax, segment.ay, segment.bx, segment.by) <= junctionDistSq) {
        return false;
      }
    }
    for (const other of otherPolygons) {
      const [minX, minY, maxX, maxY] = other.bbox;
      if (px < minX || px > maxX || py < minY || py > maxY) continue;
      if (pointInPreparedPolygon(other.prepared, px, py)) return false;
    }
    return true;
  });

  // Walk the allowed stations into runs and emit each run.
  let run: PathStation[] = [];
  const flush = (): void => {
    if (run.length >= 2) {
      const runLength = run[run.length - 1].s - run[0].s;
      if (runLength >= MEDIAN_MIN_RUN_M) {
        emitMedianRun(sink, run, half, y, topY, color, sideColor, stats, maxTriangles);
      }
    }
    run = [];
  };
  for (let i = 0; i < stations.length; i++) {
    if (allowed[i]) {
      run.push(stations[i]);
    } else {
      flush();
    }
  }
  flush();
}

function emitMedianRun(
  sink: GeometrySink,
  run: readonly PathStation[],
  half: number,
  y: number,
  topY: number,
  color: string,
  sideColor: string,
  stats: MedianStats,
  maxTriangles: number,
): void {
  if (run.length < 2) return;
  const before = sink.triangleCount;
  const leftPoints = run.map((station) => offsetAlong(station, half));
  const rightPoints = run.map((station) => offsetAlong(station, -half));

  for (let i = 1; i < run.length; i++) {
    if (stats.medianTriangles + (sink.triangleCount - before) >= maxTriangles) break;
    const l0 = leftPoints[i - 1];
    const l1 = leftPoints[i];
    const r0 = rightPoints[i - 1];
    const r1 = rightPoints[i];
    // Top face.
    sink.addFlatQuad(l0, l1, r1, r0, topY, color);
    // Two side faces.
    const n0 = normalAt(run[i - 1], 1);
    sink.addOrientedQuad(
      [l0[0], topY, -l0[1]],
      [l1[0], topY, -l1[1]],
      [l1[0], y, -l1[1]],
      [l0[0], y, -l0[1]],
      [n0[0], 0, -n0[1]],
      sideColor,
    );
    sink.addOrientedQuad(
      [r0[0], topY, -r0[1]],
      [r1[0], topY, -r1[1]],
      [r1[0], y, -r1[1]],
      [r0[0], y, -r0[1]],
      [-n0[0], 0, n0[1]],
      sideColor,
    );
    // End caps on the first and last segment.
    if (i === 1) {
      sink.addOrientedQuad(
        [l0[0], topY, -l0[1]],
        [r0[0], topY, -r0[1]],
        [r0[0], y, -r0[1]],
        [l0[0], y, -l0[1]],
        [-run[0].ux, 0, run[0].uy],
        sideColor,
      );
    }
    if (i === run.length - 1) {
      sink.addOrientedQuad(
        [r1[0], topY, -r1[1]],
        [l1[0], topY, -l1[1]],
        [l1[0], y, -l1[1]],
        [r1[0], y, -r1[1]],
        [run[i].ux, 0, -run[i].uy],
        sideColor,
      );
    }
  }
  const added = sink.triangleCount - before;
  if (added > 0) {
    stats.medians++;
    stats.medianTriangles += added;
  }
}

function normalAt(station: PathStation, side: number): [number, number] {
  return [-station.uy * side, station.ux * side];
}
