/**
 * Centreline path helpers for road detail geometry.
 *
 * The offline pipeline stores a road's centreline as a flat
 * `[x0, y0, x1, y1, …]` array in local metres (see `RoadPolygon.centerline`).
 * Markings, medians, bridge parapets and crossings are all laid out along this
 * path, so this module turns the raw array into arc-length stations with
 * tangents. Everything is pure and defensive: malformed input yields `[]`.
 *
 * Stations are sampled at a fixed step and carry the direction of the path at
 * that point. Offsetting along the normal is how lane markings are placed.
 */

import type { Point2 } from './roadAnalysis';

/** One sampled point on a road centreline. */
export interface PathStation {
  x: number;
  y: number;
  /** Unit tangent direction of the path (east, north). */
  ux: number;
  uy: number;
  /** Arc length from the first point of this centreline piece, metres. */
  s: number;
}

/** Minimum distance between consecutive centreline points, metres. */
const WELD_EPS_M = 1e-4;
/** Safety cap so a pathological centreline cannot explode the station count. */
export const MAX_STATIONS_PER_PATH = 900;

/**
 * Validate and flatten a `RoadPolygon.centerline` value into points.
 * Returns an empty array for missing, odd-length or non-finite input.
 */
export function centerlinePoints(flat: number[] | null | undefined): Point2[] {
  if (!Array.isArray(flat) || flat.length < 4 || flat.length % 2 !== 0) return [];
  const points: Point2[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const x = flat[i];
    const y = flat[i + 1];
    if (!Number.isFinite(x) || !Number.isFinite(y)) return [];
    const last = points.length > 0 ? points[points.length - 1] : null;
    if (last && Math.hypot(last[0] - x, last[1] - y) <= WELD_EPS_M) continue;
    points.push([x, y]);
  }
  return points.length >= 2 ? points : [];
}

/** Total length of a polyline, metres. */
export function pathLength(points: readonly Point2[]): number {
  let length = 0;
  for (let i = 1; i < points.length; i++) {
    length += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  }
  return length;
}

/**
 * Interpolate the point at arc length `s` (clamped to the path) plus its local
 * tangent. Used to derive smoothed tangents and for crossing/median placement.
 */
export function stationAt(points: readonly Point2[], s: number): PathStation | null {
  if (!Array.isArray(points) || points.length < 2) return null;
  const target = Number.isFinite(s) ? Math.max(0, s) : 0;
  let before = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const segment = Math.hypot(dx, dy);
    if (!(segment > 1e-9)) continue;
    if (target <= before + segment) {
      const t = (target - before) / segment;
      return {
        x: a[0] + dx * t,
        y: a[1] + dy * t,
        ux: dx / segment,
        uy: dy / segment,
        s: target,
      };
    }
    before += segment;
  }
  const last = points[points.length - 1];
  const previous = points[points.length - 2];
  let ux = last[0] - previous[0];
  let uy = last[1] - previous[1];
  const length = Math.hypot(ux, uy);
  if (length > 1e-9) {
    ux /= length;
    uy /= length;
  } else {
    ux = 1;
    uy = 0;
  }
  return { x: last[0], y: last[1], ux, uy, s: before };
}

/**
 * Resample a polyline into stations every `step` metres. Tangents are smoothed
 * over a ±`smooth` window so marking quads follow curves without flipping on
 * sharp vertices. The final point of the path is always included.
 */
export function samplePath(
  points: readonly Point2[],
  step: number,
  smooth = 0.9,
): PathStation[] {
  if (!Array.isArray(points) || points.length < 2) return [];
  const total = pathLength(points);
  if (!(total > 0.5)) return [];
  const safeStep = Number.isFinite(step) && step >= 0.4 ? step : 1.6;
  const count = Math.min(MAX_STATIONS_PER_PATH, Math.max(2, Math.round(total / safeStep) + 1));
  const spacing = total / (count - 1);
  const stations: PathStation[] = [];
  for (let i = 0; i < count; i++) {
    const s = i * spacing;
    const point = stationAt(points, s);
    if (!point) return [];
    const before = stationAt(points, Math.max(0, s - smooth));
    const after = stationAt(points, Math.min(total, s + smooth));
    let ux = point.ux;
    let uy = point.uy;
    if (before && after) {
      const dx = after.x - before.x;
      const dy = after.y - before.y;
      const length = Math.hypot(dx, dy);
      if (length > 1e-6) {
        ux = dx / length;
        uy = dy / length;
      }
    }
    stations.push({ x: point.x, y: point.y, ux, uy, s });
  }
  return stations;
}

/** Offset a station sideways: positive = left of the travel direction. */
export function offsetAlong(station: PathStation, offset: number): Point2 {
  // Normal is the tangent rotated +90°: n = (-uy, ux).
  return [station.x - station.uy * offset, station.y + station.ux * offset];
}

/** Unit normal of a station (left of the tangent). */
export function normalOf(station: PathStation): Point2 {
  return [-station.uy, station.ux];
}

/** True when both flat arrays describe the same open polyline (tests/debug). */
export function samePoints(a: readonly Point2[], b: readonly Point2[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i][0] - b[i][0]) > 1e-6) return false;
    if (Math.abs(a[i][1] - b[i][1]) > 1e-6) return false;
  }
  return true;
}
