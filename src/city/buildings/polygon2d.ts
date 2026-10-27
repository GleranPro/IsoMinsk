/**
 * 2D polygon helpers for the building generator.
 *
 * All coordinates are LOCAL metres (x east, y north) as stored in the tile
 * data. Nothing in this module knows about Three.js or world coordinates.
 */

import type { Ring } from '../../shared/types';

export type Point2 = [number, number];

/** Tolerance used for deduplicating ring vertices (metres). */
const WELD_EPS = 1e-9;

/**
 * Remove non-finite points, consecutive duplicates and a duplicated closing
 * vertex. Returns a new array; the input is not mutated.
 */
export function cleanRing(ring: Ring | undefined): Point2[] {
  const out: Point2[] = [];
  if (!ring) return out;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    if (!p) continue;
    const x = p[0];
    const y = p[1];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const last = out.length ? out[out.length - 1] : null;
    if (last && Math.abs(last[0] - x) < WELD_EPS && Math.abs(last[1] - y) < WELD_EPS) continue;
    out.push([x, y]);
  }
  while (out.length > 1) {
    const first = out[0];
    const last = out[out.length - 1];
    if (Math.abs(first[0] - last[0]) < WELD_EPS && Math.abs(first[1] - last[1]) < WELD_EPS) {
      out.pop();
    } else {
      break;
    }
  }
  return out;
}

/**
 * Signed area of a ring in local metres (positive = CCW, standard shoelace).
 *
 * NB: this deliberately uses the standard mathematical convention rather than
 * `tileMath.ringArea` (which returns the negated value for the same formula);
 * the pipeline normalises exterior rings to CCW, so positive == CCW here.
 */
export function signedArea(ring: readonly Point2[]): number {
  const n = ring.length;
  if (n < 3) return 0;
  let area = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area += ring[i][0] * ring[j][1] - ring[j][0] * ring[i][1];
  }
  return area / 2;
}

/** Absolute area of one ring. */
export function ringAreaAbs(ring: readonly Point2[]): number {
  return Math.abs(signedArea(ring));
}

/** Area-weighted centroid of a single ring, or null when degenerate. */
export function ringCentroid(ring: readonly Point2[]): Point2 | null {
  const n = ring.length;
  if (n < 3) return null;
  const area = signedArea(ring);
  if (Math.abs(area) < 1e-9) return null;
  let cx = 0;
  let cy = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const x0 = ring[j][0];
    const y0 = ring[j][1];
    const x1 = ring[i][0];
    const y1 = ring[i][1];
    // Standard shoelace centroid accumulation in ring order (previous -> current).
    const cross = x0 * y1 - x1 * y0;
    cx += (x0 + x1) * cross;
    cy += (y0 + y1) * cross;
  }
  const scale = 1 / (6 * area);
  return [cx * scale, cy * scale];
}

/**
 * Area weighted centroid of a polygon with holes. Falls back to the average of
 * the exterior ring when the polygon is degenerate.
 */
export function polygonCentroid(rings: readonly (readonly Point2[])[]): Point2 {
  if (!rings.length) return [0, 0];
  const exterior = rings[0];
  const exteriorArea = signedArea(exterior);
  let total = Math.abs(exteriorArea);
  let cx = 0;
  let cy = 0;
  if (total > 1e-9) {
    const c = ringCentroid(exterior);
    if (c) {
      cx += c[0] * total;
      cy += c[1] * total;
    }
  }
  for (let i = 1; i < rings.length; i++) {
    const area = Math.abs(signedArea(rings[i]));
    if (area < 1e-9) continue;
    const c = ringCentroid(rings[i]);
    if (!c) continue;
    cx -= c[0] * area;
    cy -= c[1] * area;
    total -= area;
  }
  if (total > 1e-9) return [cx / total, cy / total];
  // Degenerate: simple average of exterior points.
  let sx = 0;
  let sy = 0;
  for (const p of exterior) {
    sx += p[0];
    sy += p[1];
  }
  const n = Math.max(exterior.length, 1);
  return [sx / n, sy / n];
}

/** Perimeter length in metres. */
export function ringPerimeter(ring: readonly Point2[]): number {
  let length = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    length += Math.hypot(ring[i][0] - ring[j][0], ring[i][1] - ring[j][1]);
  }
  return length;
}

/** Convex hull of a point cloud, counter-clockwise, no duplicate closing point. */
export function convexHull(points: readonly Point2[]): Point2[] {
  if (points.length < 3) return points.slice();
  const sorted = points
    .filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]))
    .slice()
    .sort((a, b) => (a[0] === b[0] ? a[1] - b[1] : a[0] - b[0]));
  if (sorted.length < 3) return sorted;
  const unique: Point2[] = [];
  for (const p of sorted) {
    const last = unique.length ? unique[unique.length - 1] : null;
    if (last && Math.abs(last[0] - p[0]) < WELD_EPS && Math.abs(last[1] - p[1]) < WELD_EPS) {
      continue;
    }
    unique.push([p[0], p[1]]);
  }
  if (unique.length < 3) return unique;
  const cross = (o: Point2, a: Point2, b: Point2): number =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Point2[] = [];
  for (const p of unique) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper: Point2[] = [];
  for (let i = unique.length - 1; i >= 0; i--) {
    const p = unique[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  const hull = lower.concat(upper);
  return hull.length >= 3 ? hull : unique;
}

/** Oriented minimum-area bounding rectangle of a point cloud. */
export interface OrientedRect {
  cx: number;
  cy: number;
  /** Unit vector along the LONG axis of the rectangle. */
  ux: number;
  uy: number;
  /** Half extent along the long axis (`ux, uy`). */
  halfLength: number;
  /** Half extent along the short axis. */
  halfWidth: number;
}

/**
 * Minimum-area bounding rectangle (rotating calipers over the convex hull).
 * One rectangle side is always collinear with a hull edge.
 */
export function minAreaRect(points: readonly Point2[]): OrientedRect | null {
  const hull = convexHull(points);
  const n = hull.length;
  if (n < 3) return null;
  let bestArea = Infinity;
  let best: OrientedRect | null = null;
  for (let i = 0; i < n; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % n];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) continue;
    const ux = dx / len;
    const uy = dy / len;
    const vx = -uy;
    const vy = ux;
    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    for (const p of hull) {
      const pu = p[0] * ux + p[1] * uy;
      const pv = p[0] * vx + p[1] * vy;
      if (pu < minU) minU = pu;
      if (pu > maxU) maxU = pu;
      if (pv < minV) minV = pv;
      if (pv > maxV) maxV = pv;
    }
    const width = maxU - minU;
    const depth = maxV - minV;
    const area = width * depth;
    if (area < bestArea) {
      bestArea = area;
      const midU = (minU + maxU) / 2;
      const midV = (minV + maxV) / 2;
      best = {
        cx: ux * midU + vx * midV,
        cy: uy * midU + vy * midV,
        ux,
        uy,
        halfLength: width / 2,
        halfWidth: depth / 2,
      };
    }
  }
  if (!best) return null;
  // Guarantee that the long axis is stored in ux/uy.
  if (best.halfWidth > best.halfLength) {
    const ux = -best.uy;
    const uy = best.ux;
    const half = best.halfLength;
    best.halfLength = best.halfWidth;
    best.halfWidth = half;
    best.ux = ux;
    best.uy = uy;
  }
  return best;
}

/** Point in ring test (ray casting; boundary behaviour is unspecified). */
export function pointInRing(ring: readonly Point2[], x: number, y: number): boolean {
  let inside = false;
  const n = ring.length;
  if (n < 3) return false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    const intersects = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

/** Point in polygon with holes test. */
export function pointInPolygon(
  rings: readonly (readonly Point2[])[],
  x: number,
  y: number,
): boolean {
  if (!rings.length) return false;
  if (!pointInRing(rings[0], x, y)) return false;
  for (let i = 1; i < rings.length; i++) {
    if (pointInRing(rings[i], x, y)) return false;
  }
  return true;
}

/** All boundary edges of a polygon as [start, end] pairs (holes included). */
export function polygonEdges(rings: readonly (readonly Point2[])[]): [Point2, Point2][] {
  const edges: [Point2, Point2][] = [];
  for (const ring of rings) {
    const n = ring.length;
    for (let i = 0; i < n; i++) {
      edges.push([ring[i], ring[(i + 1) % n]]);
    }
  }
  return edges;
}

/** Local signed area of a triangle (positive = CCW in local x/y). */
export function triangleSignedArea(a: Point2, b: Point2, c: Point2): number {
  return ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;
}
