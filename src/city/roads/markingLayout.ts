/**
 * Lane-marking layout derived from a road centreline.
 *
 * The offline pipeline stores `RoadPolygon.centerline` (plus `lanes`,
 * `oneway`, `surface`), so markings can follow the real axis of the street
 * instead of the polygon's minimum-area rectangle. This module is pure: it
 * returns rectangular bars in local metres and lets `roadMeshes.ts` emit them.
 *
 * Rules (kept deliberately simple and legible at pixel-art scale):
 *  - dashed centre line: avenues / main streets, phase-continuous across tiles
 *    via `centerlineOffset`;
 *  - double solid centre: motorway/trunk/primary with >= 4 lanes;
 *  - dashed lane dividers between the marked lanes (when `lanes` is tagged);
 *  - solid edge lines for the bigger street classes;
 *  - a red painted lane along the right edge when `cycleway=lane`.
 *
 * Every bar is clipped to the road polygon: a bar is only emitted when its
 * centre and both ends are inside the carriageway.
 */

import type { Polygon, RoadPolygon } from '../../shared/types';
import { pointInPreparedPolygon } from './roadAnalysis';
import { offsetAlong, type PathStation } from './roadPath';

/** Semantics of a painted bar; the renderer maps it to a colour. */
export type MarkingTone = 'white' | 'bike';

export interface MarkingBar {
  /** Bar centre, local metres. */
  cx: number;
  cy: number;
  /** Long axis of the bar (unit vector). */
  ux: number;
  uy: number;
  /** Extent along `u`, metres. */
  length: number;
  /** Extent across `u`, metres. */
  width: number;
  tone: MarkingTone;
}

type PreparedLike = { exterior: [number, number][]; holes: [number, number][][] };

/** Minimum carriageway width for a centre line, metres. */
const CENTER_MIN_WIDTH_M = 6.5;
/** Classes that are wide enough to carry a painted centre line. */
const CENTER_CLASSES: ReadonlySet<RoadPolygon['class']> = new Set([
  'motorway',
  'trunk',
  'primary',
  'secondary',
  'tertiary',
]);
/** Classes that get solid outer edge lines. */
const EDGE_CLASSES: ReadonlySet<RoadPolygon['class']> = new Set([
  'motorway',
  'trunk',
  'primary',
  'secondary',
  'tertiary',
]);
/** Classes whose wide >= 4-lane version gets the double solid centre. */
const DOUBLE_CENTER_CLASSES: ReadonlySet<RoadPolygon['class']> = new Set([
  'motorway',
  'trunk',
  'primary',
]);

const CENTER_DASH_M = 3;
const CENTER_GAP_M = 5;
const LANE_DASH_M = 3;
const LANE_GAP_M = 6;
const EDGE_WIDTH_M = 0.14;
const LANE_LINE_WIDTH_M = 0.12;
const CENTER_WIDTH_M = 0.15;
const DOUBLE_OFFSET_M = 0.17;
const DOUBLE_WIDTH_M = 0.12;
const BIKE_LANE_WIDTH_M = 1.5;
/** Bars per road piece; the tile-wide cap lives in roadMeshes.ts. */
export const MAX_BARS_PER_ROAD = 420;

/**
 * Lane count used for layout decisions: the tagged value when valid, otherwise
 * an estimate from the carriageway width.
 */
export function effectiveLanes(road: Pick<RoadPolygon, 'lanes' | 'width'>): number {
  const tagged = road.lanes;
  if (typeof tagged === 'number' && Number.isFinite(tagged) && tagged >= 1 && tagged <= 8) {
    return Math.round(tagged);
  }
  const width = Number.isFinite(road.width) ? road.width : 6;
  return Math.min(6, Math.max(1, Math.round(width / 3.2)));
}

function inside(polygon: PreparedLike, x: number, y: number): boolean {
  return pointInPreparedPolygon(polygon, x, y);
}

function pushBar(
  bars: MarkingBar[],
  ax: number,
  ay: number,
  bx: number,
  by: number,
  width: number,
  tone: MarkingTone,
  limit: number,
): boolean {
  if (bars.length >= limit) return false;
  const dx = bx - ax;
  const dy = by - ay;
  const length = Math.hypot(dx, dy);
  if (!(length > 0.15) || !Number.isFinite(length)) return false;
  bars.push({
    cx: (ax + bx) / 2,
    cy: (ay + by) / 2,
    ux: dx / length,
    uy: dy / length,
    length: length + 0.06,
    width,
    tone,
  });
  return true;
}

/**
 * Append bars following the path at a lateral `offset`. `dash` = 0 means a
 * continuous (solid) line; otherwise the line is dashed with the given pattern.
 * `phase` shifts the dash pattern along the way (metres) for tile continuity.
 */
function barsAlongOffset(
  bars: MarkingBar[],
  polygon: PreparedLike,
  stations: readonly PathStation[],
  offset: number,
  options: {
    dash: number;
    gap: number;
    width: number;
    tone: MarkingTone;
    phase: number;
    limit: number;
  },
): void {
  if (stations.length < 2) return;
  const period = options.dash + options.gap;
  for (let i = 1; i < stations.length; i++) {
    if (bars.length >= options.limit) return;
    const previous = stations[i - 1];
    const current = stations[i];
    if (options.dash > 0) {
      const phase = ((current.s + options.phase) % period + period) % period;
      if (phase > options.dash) continue;
    }
    const a = offsetAlong(previous, offset);
    const b = offsetAlong(current, offset);
    const mx = (a[0] + b[0]) / 2;
    const my = (a[1] + b[1]) / 2;
    if (!inside(polygon, a[0], a[1])) continue;
    if (!inside(polygon, b[0], b[1])) continue;
    if (!inside(polygon, mx, my)) continue;
    if (!pushBar(bars, a[0], a[1], b[0], b[1], options.width, options.tone, options.limit)) {
      return;
    }
  }
}

/**
 * Build all lane-marking bars for one road piece.
 *
 * @param road      road payload record (needs `centerline`/`lanes`/`oneway`)
 * @param polygon   prepared carriageway polygon used for clipping
 * @param stations  resampled centreline (`samplePath`)
 */
export function laneMarkings(
  road: RoadPolygon,
  polygon: PreparedLike,
  stations: readonly PathStation[],
  limit: number = MAX_BARS_PER_ROAD,
): MarkingBar[] {
  const bars: MarkingBar[] = [];
  if (stations.length < 2) return bars;
  const width = Number.isFinite(road.width) && road.width > 0 ? road.width : 6;
  const halfWidth = width / 2;
  const phase = typeof road.centerlineOffset === 'number' && Number.isFinite(road.centerlineOffset)
    ? road.centerlineOffset
    : 0;
  const lanes = effectiveLanes(road);
  const taggedLanes = typeof road.lanes === 'number' && road.lanes >= 1;
  const oneway = Boolean(road.oneway);

  // 1. Painted cycle lane along the right-hand edge (Belarus drives on the
  //    right, so "right" is the negative offset side of the travel normal).
  if (road.cycleway === 'lane' && width >= 6) {
    barsAlongOffset(bars, polygon, stations, -(halfWidth - BIKE_LANE_WIDTH_M / 2 - 0.15), {
      dash: 0,
      gap: 0,
      width: BIKE_LANE_WIDTH_M,
      tone: 'bike',
      phase: 0,
      limit,
    });
  }

  // 2. Centre line.
  const centerClass =
    CENTER_CLASSES.has(road.class) || (road.class === 'residential' && width >= 9);
  if (!oneway && centerClass && width >= CENTER_MIN_WIDTH_M) {
    const doubleSolid = DOUBLE_CENTER_CLASSES.has(road.class) && lanes >= 4 && width >= 14;
    if (doubleSolid) {
      for (const side of [-1, 1]) {
        barsAlongOffset(bars, polygon, stations, side * DOUBLE_OFFSET_M, {
          dash: 0,
          gap: 0,
          width: DOUBLE_WIDTH_M,
          tone: 'white',
          phase: 0,
          limit,
        });
      }
    } else {
      barsAlongOffset(bars, polygon, stations, 0, {
        dash: CENTER_DASH_M,
        gap: CENTER_GAP_M,
        width: CENTER_WIDTH_M,
        tone: 'white',
        phase,
        limit,
      });
    }
  }

  // 3. Lane dividers (only when the lane count is actually tagged/derived).
  if (taggedLanes && lanes >= 3 && width / lanes >= 2.2 && width >= 7) {
    const laneWidth = width / lanes;
    for (let k = 1; k < lanes; k++) {
      const offset = -halfWidth + k * laneWidth;
      if (Math.abs(offset) < 0.3) continue; // centre line is handled above
      if (Math.abs(offset) > halfWidth - 0.6) continue;
      barsAlongOffset(bars, polygon, stations, offset, {
        dash: LANE_DASH_M,
        gap: LANE_GAP_M,
        width: LANE_LINE_WIDTH_M,
        tone: 'white',
        phase,
        limit,
      });
    }
  }

  // 4. Edge lines.
  if (!oneway && EDGE_CLASSES.has(road.class) && width >= 8) {
    for (const side of [-1, 1]) {
      const offset = side * (halfWidth - 0.4);
      if (Math.abs(offset) < 1.2) continue;
      barsAlongOffset(bars, polygon, stations, offset, {
        dash: 0,
        gap: 0,
        width: EDGE_WIDTH_M,
        tone: 'white',
        phase: 0,
        limit,
      });
    }
  }
  return bars;
}

/** Number of triangles a bar list will add (each bar = one flat quad). */
export function barTriangles(bars: readonly MarkingBar[]): number {
  return bars.length * 2;
}

/** Re-export for callers that only need the polygon type. */
export type MarkingPolygon = Polygon;
