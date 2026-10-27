/**
 * Geometry analysis for buffered road / rail polygons.
 *
 * The data pipeline only gives us the buffered outline of a road centreline
 * (no centreline itself). To draw lane markings and tram rails we need an
 * approximation of the road's long axis and of its cross-section:
 *
 *  1. compute the minimum-area bounding rectangle of the polygon (rotating
 *     calipers over the convex hull) — its long axis is the road direction;
 *  2. sample cross-sections perpendicular to that axis; each cross-section
 *     returns the centre of the polygon and its half width at that station.
 *
 * This is deterministic and cheap, and follows gentle curves much better than
 * just using the rectangle centre line (dashes/rails stay inside the polygon).
 */

import type { Ring, RoadClass } from '../../shared/types';

export type Point2 = [number, number];

/** A road's minimum-area bounding rectangle expressed as a local frame. */
export interface RoadAxis {
  /** Rectangle centre, local metres. */
  cx: number;
  cy: number;
  /** Unit vector of the long axis (east, north). */
  ux: number;
  uy: number;
  /** Extent along the long axis, metres. */
  length: number;
  /** Extent along the short axis, metres. */
  width: number;
}

/** One derived cross-section of the road polygon. */
export interface CrossSection {
  /** Polygon centre at this station, local metres. */
  x: number;
  y: number;
  /** Signed distance of the centre from the axis line along the short axis. */
  mid: number;
  /** Half of the polygon width at this station, metres. */
  halfWidth: number;
}

export interface Dash {
  /** Centre of the dash, local metres. */
  cx: number;
  cy: number;
  /** Unit direction of the dash (road long axis). */
  ux: number;
  uy: number;
  /** Dash length along the road, metres. */
  length: number;
  /** Dash width across the road, metres. */
  width: number;
}

export interface RailSegment {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Rail head width, metres. */
  width: number;
}

export interface RailLayout {
  segments: RailSegment[];
  /** Width of one rail line, metres. */
  railWidth: number;
  /** Half distance between the two rails, metres (0 when omitted). */
  halfGauge: number;
}

/** Dashed centre lines: spacing by road class, metres (all within 6–9 m). */
const DASH_SPACING: Partial<Record<RoadClass, number>> = {
  motorway: 9,
  trunk: 9,
  primary: 8,
  secondary: 7,
};

export const DASH_LENGTH_M = 3;
export const DASH_WIDTH_M = 0.5;
export const DASH_MIN_ROAD_WIDTH_M = 7;
export const DASH_MIN_ROAD_LENGTH_M = 18;
export const DASH_MAX_PER_ROAD = 24;

export const RAIL_LINE_WIDTH_M = 0.34;
export const RAIL_SAMPLE_STEP_M = 8;
const RAIL_MAX_SAMPLES_PER_SIDE = 72;
const RAIL_MIN_POLYGON_WIDTH_M = 2.4;

const EPS = 1e-9;

function orient(a: Point2, b: Point2, c: Point2): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

/** Andrew's monotone-chain convex hull. Returns CCW hull points. */
export function convexHull(points: readonly Point2[]): Point2[] {
  if (!Array.isArray(points) || points.length < 3) return [];
  const sorted = points
    .filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]))
    .slice()
    .sort((a, b) => (a[0] === b[0] ? a[1] - b[1] : a[0] - b[0]));
  const unique: Point2[] = [];
  for (const point of sorted) {
    const last = unique.length > 0 ? unique[unique.length - 1] : null;
    if (!last || Math.abs(last[0] - point[0]) > EPS || Math.abs(last[1] - point[1]) > EPS) {
      unique.push([point[0], point[1]]);
    }
  }
  if (unique.length < 3) return unique;

  const lower: Point2[] = [];
  for (const point of unique) {
    while (lower.length >= 2 && orient(lower[lower.length - 2], lower[lower.length - 1], point) <= EPS) {
      lower.pop();
    }
    lower.push(point);
  }
  const upper: Point2[] = [];
  for (let i = unique.length - 1; i >= 0; i--) {
    const point = unique[i];
    while (upper.length >= 2 && orient(upper[upper.length - 2], upper[upper.length - 1], point) <= EPS) {
      upper.pop();
    }
    upper.push(point);
  }
  lower.pop();
  upper.pop();
  const hull = lower.concat(upper);
  return hull.length >= 3 ? hull : unique;
}

/** Minimum-area bounding rectangle of a ring, with the long axis first. */
export function minAreaRoadAxis(ring: Ring): RoadAxis | null {
  if (!Array.isArray(ring) || ring.length < 3) return null;
  const hull = convexHull(ring);
  if (hull.length < 3) return null;

  let best: {
    area: number;
    ex: number;
    ey: number;
    px: number;
    py: number;
    minU: number;
    maxU: number;
    minV: number;
    maxV: number;
  } | null = null;

  for (let i = 0; i < hull.length; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    let ex = b[0] - a[0];
    let ey = b[1] - a[1];
    const edgeLength = Math.hypot(ex, ey);
    if (!Number.isFinite(edgeLength) || edgeLength < 1e-6) continue;
    ex /= edgeLength;
    ey /= edgeLength;
    const px = -ey;
    const py = ex;
    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    for (const point of hull) {
      const u = point[0] * ex + point[1] * ey;
      const v = point[0] * px + point[1] * py;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    const lengthU = maxU - minU;
    const lengthV = maxV - minV;
    const area = lengthU * lengthV;
    if (!Number.isFinite(area)) continue;
    if (!best || area < best.area) {
      best = { area, ex, ey, px, py, minU, maxU, minV, maxV };
    }
  }
  if (!best) return null;

  const midU = (best.minU + best.maxU) / 2;
  const midV = (best.minV + best.maxV) / 2;
  const cx = best.ex * midU + best.px * midV;
  const cy = best.ey * midU + best.py * midV;

  let ux = best.ex;
  let uy = best.ey;
  let length = best.maxU - best.minU;
  let width = best.maxV - best.minV;
  if (width > length) {
    ux = best.px;
    uy = best.py;
    length = best.maxV - best.minV;
    width = best.maxU - best.minU;
  }
  if (!Number.isFinite(cx) || !Number.isFinite(cy) || !(length > 0) || !(width > 0)) return null;
  return { cx, cy, ux, uy, length, width };
}

/**
 * Intersect the polygon with the line through `axis.cx/cx + u*t` perpendicular
 * to the long axis, and return the centre of the polygon at that station.
 */
export function crossSectionAt(ring: Ring, axis: RoadAxis, t: number): CrossSection | null {
  if (!Array.isArray(ring) || ring.length < 3 || !Number.isFinite(t)) return null;
  const px = axis.cx + axis.ux * t;
  const py = axis.cy + axis.uy * t;
  const vx = -axis.uy;
  const vy = axis.ux;

  const stations: number[] = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const denominator = vx * dy - vy * dx;
    if (!Number.isFinite(denominator) || Math.abs(denominator) < EPS) continue;
    const rx = a[0] - px;
    const ry = a[1] - py;
    const k = (rx * vy - ry * vx) / denominator;
    if (k < -1e-6 || k > 1 + 1e-6) continue;
    const s = (rx * dy - ry * dx) / denominator;
    if (!Number.isFinite(s)) continue;
    stations.push(s);
  }
  if (stations.length < 2) return null;
  stations.sort((a, b) => a - b);
  const unique: number[] = [];
  for (const s of stations) {
    if (unique.length === 0 || Math.abs(s - unique[unique.length - 1]) > 1e-4) unique.push(s);
  }
  if (unique.length < 2) return null;
  if (unique.length % 2 === 1) unique.pop();

  let bestMid: number | null = null;
  let bestHalf = 0;
  let bestDistance = Infinity;
  for (let i = 0; i + 1 < unique.length; i += 2) {
    const s0 = unique[i];
    const s1 = unique[i + 1];
    const half = (s1 - s0) / 2;
    if (!(half > 0.05)) continue;
    const mid = (s0 + s1) / 2;
    const containsZero = s0 <= 1e-6 && s1 >= -1e-6;
    const distance = containsZero ? -1 : Math.abs(mid);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestMid = mid;
      bestHalf = half;
    }
  }
  if (bestMid === null) return null;
  return {
    x: px + vx * bestMid,
    y: py + vy * bestMid,
    mid: bestMid,
    halfWidth: bestHalf,
  };
}

/** Ray-casting point-in-ring test. */
export function pointInRing(ring: Ring, x: number, y: number): boolean {
  if (!Array.isArray(ring) || ring.length < 3) return false;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    const crosses = yi > y !== yj > y;
    if (crosses && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Point in polygon with holes. */
export function pointInPreparedPolygon(
  polygon: { exterior: Ring; holes: Ring[] },
  x: number,
  y: number,
): boolean {
  if (!pointInRing(polygon.exterior, x, y)) return false;
  for (const hole of polygon.holes) {
    if (pointInRing(hole, x, y)) return false;
  }
  return true;
}

/** Spacing between consecutive dashes for a road class (metres), or 0. */
export function dashSpacingForClass(cls: RoadClass): number {
  return DASH_SPACING[cls] ?? 0;
}

/**
 * Derive deterministic dashed-centre-line quads for a road polygon. Dashes are
 * placed along the minimum-area rectangle long axis, snapped to the polygon
 * cross-section centre, and skipped when any part would fall outside the road.
 */
export function roadDashes(
  polygon: { exterior: Ring; holes: Ring[] },
  cls: RoadClass,
  effectiveWidth: number,
): Dash[] {
  const spacing = dashSpacingForClass(cls);
  if (spacing <= 0) return [];
  const axis = minAreaRoadAxis(polygon.exterior);
  if (!axis) return [];
  const polygonWidth = Math.max(axis.width, Number.isFinite(effectiveWidth) ? effectiveWidth : 0);
  if (polygonWidth < DASH_MIN_ROAD_WIDTH_M || axis.length < DASH_MIN_ROAD_LENGTH_M) return [];

  const halfLength = axis.length / 2;
  const first = -halfLength + DASH_LENGTH_M / 2;
  const last = halfLength - DASH_LENGTH_M / 2;
  if (!(last >= first)) return [];

  const dashes: Dash[] = [];
  for (let t = first; t <= last + 1e-9 && dashes.length < DASH_MAX_PER_ROAD; t += spacing) {
    const section = crossSectionAt(polygon.exterior, axis, t);
    if (!section || section.halfWidth <= 0.2) continue;
    const halfDash = DASH_LENGTH_M / 2;
    const startX = section.x - axis.ux * halfDash;
    const startY = section.y - axis.uy * halfDash;
    const endX = section.x + axis.ux * halfDash;
    const endY = section.y + axis.uy * halfDash;
    if (!pointInPreparedPolygon(polygon, startX, startY)) continue;
    if (!pointInPreparedPolygon(polygon, endX, endY)) continue;
    if (!pointInPreparedPolygon(polygon, section.x, section.y)) continue;
    dashes.push({
      cx: section.x,
      cy: section.y,
      ux: axis.ux,
      uy: axis.uy,
      length: DASH_LENGTH_M,
      width: DASH_WIDTH_M,
    });
  }
  return dashes;
}

/**
 * Derive the two tram/rail lines of a buffered rail polygon. The lines follow
 * the polygon cross-section centre so they stay inset from the polygon edges
 * even when the track curves.
 */
export function railLineLayout(
  polygon: { exterior: Ring; holes: Ring[] },
  effectiveWidth: number,
): RailLayout {
  const axis = minAreaRoadAxis(polygon.exterior);
  const empty: RailLayout = { segments: [], railWidth: RAIL_LINE_WIDTH_M, halfGauge: 0 };
  if (!axis) return empty;
  const polygonWidth = Math.max(axis.width, Number.isFinite(effectiveWidth) ? effectiveWidth : 0);
  if (polygonWidth < RAIL_MIN_POLYGON_WIDTH_M) return empty;

  const maxHalfGauge = axis.width / 2 - RAIL_LINE_WIDTH_M - 0.2;
  if (maxHalfGauge < 0.4) return empty;
  const halfGauge = Math.min(Math.max(axis.width * 0.16, 0.55), maxHalfGauge);
  const vx = -axis.uy;
  const vy = axis.ux;
  const halfLength = axis.length / 2;
  const sampleCount = Math.min(
    RAIL_MAX_SAMPLES_PER_SIDE,
    Math.max(2, Math.ceil(axis.length / RAIL_SAMPLE_STEP_M) + 1),
  );
  const step = axis.length / (sampleCount - 1);

  const segments: RailSegment[] = [];
  // Sample interior stations only: stations exactly on the polygon end caps
  // are numerically ambiguous for point-in-polygon checks.
  const inset = step / 2;
  for (const side of [-1, 1]) {
    let previous: Point2 | null = null;
    for (let i = 0; i < sampleCount - 1; i++) {
      const t = -halfLength + inset + i * step;
      if (t > halfLength - inset + 1e-9) break;
      const section = crossSectionAt(polygon.exterior, axis, t);
      if (!section || section.halfWidth < halfGauge + RAIL_LINE_WIDTH_M * 0.5 + 0.1) {
        previous = null;
        continue;
      }
      const point: Point2 = [
        section.x + vx * side * halfGauge,
        section.y + vy * side * halfGauge,
      ];
      if (previous) {
        const dx = point[0] - previous[0];
        const dy = point[1] - previous[1];
        if (Math.hypot(dx, dy) > 0.05) {
          segments.push({
            x0: previous[0],
            y0: previous[1],
            x1: point[0],
            y1: point[1],
            width: RAIL_LINE_WIDTH_M,
          });
        }
      }
      previous = point;
    }
  }
  return { segments, railWidth: RAIL_LINE_WIDTH_M, halfGauge };
}

/**
 * Ring simplification lives in the shared environment geometry module; it is
 * re-exported here because road-specific helpers use it (and tests import it
 * from this module).
 */
export { simplifyRing } from '../environment/triangulate';

/**
 * Offset a counter-clockwise ring outward by `distance` metres using mitered
 * joins. Acute corners are clamped so the miter cannot spike. Returns null if
 * the ring is degenerate.
 */
export function offsetRingOutward(ring: Ring, distance: number): Ring | null {
  const n = ring.length;
  if (n < 3 || !(distance > 0)) return null;
  const out: Ring = new Array(n);
  for (let i = 0; i < n; i++) {
    const previous = ring[(i + n - 1) % n];
    const current = ring[i];
    const next = ring[(i + 1) % n];
    let d0x = current[0] - previous[0];
    let d0y = current[1] - previous[1];
    let d1x = next[0] - current[0];
    let d1y = next[1] - current[1];
    const l0 = Math.hypot(d0x, d0y);
    const l1 = Math.hypot(d1x, d1y);
    if (!(l0 > 1e-9) || !(l1 > 1e-9)) return null;
    d0x /= l0;
    d0y /= l0;
    d1x /= l1;
    d1y /= l1;
    // Outward normal of a CCW ring is the right-hand side of the edge.
    const n0x = d0y;
    const n0y = -d0x;
    const n1x = d1y;
    const n1y = -d1x;
    let mx = n0x + n1x;
    let my = n0y + n1y;
    const ml = Math.hypot(mx, my);
    if (ml < 1e-6) {
      // 180° reversal: just push straight out along the incoming normal.
      out[i] = [current[0] + n0x * distance, current[1] + n0y * distance];
      continue;
    }
    mx /= ml;
    my /= ml;
    const cosHalf = mx * n0x + my * n0y;
    const miterLength = distance / Math.max(cosHalf, 0.4);
    out[i] = [current[0] + mx * miterLength, current[1] + my * miterLength];
  }
  return out;
}
