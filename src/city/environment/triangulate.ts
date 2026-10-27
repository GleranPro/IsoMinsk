/**
 * Robust flat-polygon triangulation for the environment layers.
 *
 * Uses `THREE.ShapeUtils.triangulateShape` (earcut) so concave outlines and
 * holes are handled correctly — never fan triangulation. All helpers are pure
 * and defensive: invalid, degenerate, self-intersecting or non-finite input
 * yields `null` / an empty triangle list instead of throwing.
 *
 * Triangles are returned in local metres (x east, y north) and are always wound
 * counter-clockwise, which means they face +Y once converted to renderer world
 * space (`world = [x, h, -y]`).
 */

import * as THREE from 'three';
import type { Polygon, Ring } from '../../shared/types';

export type Point2 = [number, number];
export type Triangle2 = [Point2, Point2, Point2];

/** Minimum polygon area rendered, m². Keeps slivers and numeric noise out. */
export const MIN_POLYGON_AREA_M2 = 0.1;
/** Minimum hole area considered, m². */
export const MIN_HOLE_AREA_M2 = 0.02;
/** Minimum triangle area, m². */
export const MIN_TRIANGLE_AREA_M2 = 1e-4;
/** Points closer than this are welded together, metres. */
const WELD_EPS_M = 1e-4;
/** Rings with more vertices than this skip the O(n²) simplicity check. */
const SIMPLE_CHECK_MAX_VERTS = 96;

export interface PreparedPolygon {
  /** Exterior ring, sanitised, no closing duplicate, counter-clockwise. */
  exterior: Ring;
  /** Holes, sanitised. Winding does not matter for earcut. */
  holes: Ring[];
  /** Exterior area minus hole areas, m² (never rendered when <= 0). */
  area: number;
}

export interface PrepareOptions {
  /** Polygons with a smaller |area| are treated as degenerate. */
  minArea?: number;
  /** Keep the O(n²) self-intersection check (default true). */
  checkSimple?: boolean;
}

/**
 * Signed area of a ring (positive = counter-clockwise), m².
 *
 * NOTE: `shared/tileMath.ringArea` uses the opposite sign convention, so this
 * module keeps its own standard shoelace implementation to avoid confusing the
 * winding normalisation (which drives kerb/bridge orientation).
 */
export function signedRingArea(ring: Ring): number {
  let area = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    area += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
  }
  return area / 2;
}

/**
 * Sanitise a ring: reject non-finite coordinates, weld consecutive duplicates,
 * drop the closing vertex, check point count and area. Returns null when the
 * ring cannot be rendered.
 */
export function sanitizeRing(
  ring: Ring | null | undefined,
  minArea: number = MIN_POLYGON_AREA_M2,
): Ring | null {
  if (!Array.isArray(ring) || ring.length < 3) return null;
  const cleaned: Ring = [];
  for (let i = 0; i < ring.length; i++) {
    const point = ring[i];
    if (!point || point.length < 2) return null;
    const x = point[0];
    const y = point[1];
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    const last = cleaned.length > 0 ? cleaned[cleaned.length - 1] : null;
    if (last && Math.abs(last[0] - x) <= WELD_EPS_M && Math.abs(last[1] - y) <= WELD_EPS_M) {
      continue;
    }
    cleaned.push([x, y]);
  }
  // Drop a duplicated closing vertex (the data contract says there is none, but
  // defensive handling costs nothing and keeps earcut's mutation assumptions safe).
  while (cleaned.length > 1) {
    const first = cleaned[0];
    const last = cleaned[cleaned.length - 1];
    if (
      Math.abs(first[0] - last[0]) <= WELD_EPS_M &&
      Math.abs(first[1] - last[1]) <= WELD_EPS_M
    ) {
      cleaned.pop();
    } else {
      break;
    }
  }
  if (cleaned.length < 3) return null;
  // Out-of-range coordinates (NaN already rejected; guard against absurd values).
  for (const [x, y] of cleaned) {
    if (Math.abs(x) > 1e7 || Math.abs(y) > 1e7) return null;
  }
  const area = Math.abs(signedRingArea(cleaned));
  if (!Number.isFinite(area) || area < minArea) return null;
  return cleaned;
}

function orient(a: Point2, b: Point2, c: Point2): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function onSegment(a: Point2, b: Point2, p: Point2): boolean {
  return (
    Math.min(a[0], b[0]) - 1e-9 <= p[0] &&
    p[0] <= Math.max(a[0], b[0]) + 1e-9 &&
    Math.min(a[1], b[1]) - 1e-9 <= p[1] &&
    p[1] <= Math.max(a[1], b[1]) + 1e-9
  );
}

function segmentsIntersect(a: Point2, b: Point2, c: Point2, d: Point2): boolean {
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  if (((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))) {
    return true;
  }
  const eps = 1e-9;
  if (Math.abs(o1) <= eps && onSegment(a, b, c)) return true;
  if (Math.abs(o2) <= eps && onSegment(a, b, d)) return true;
  if (Math.abs(o3) <= eps && onSegment(c, d, a)) return true;
  if (Math.abs(o4) <= eps && onSegment(c, d, b)) return true;
  return false;
}

/**
 * Cheap self-intersection check for small rings. Large rings return true and
 * rely on earcut's tolerance, keeping tile build time bounded.
 */
export function isRingSimple(ring: Ring, maxVertices: number = SIMPLE_CHECK_MAX_VERTS): boolean {
  const n = ring.length;
  if (n < 3) return false;
  if (n > maxVertices) return true;
  for (let i = 0; i < n; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    for (let j = i + 1; j < n; j++) {
      // Skip adjacent edges (they share a vertex by construction).
      if (j === i || j === (i + 1) % n || i === (j + 1) % n) continue;
      const c = ring[j];
      const d = ring[(j + 1) % n];
      if (segmentsIntersect(a, b, c, d)) return false;
    }
  }
  return true;
}

/**
 * Sanitise a polygon (exterior + holes), reject degenerates and normalise the
 * exterior ring to counter-clockwise winding.
 */
export function prepareFlatPolygon(
  polygon: Polygon | null | undefined,
  options: PrepareOptions = {},
): PreparedPolygon | null {
  if (!Array.isArray(polygon) || polygon.length === 0) return null;
  const minArea = options.minArea ?? MIN_POLYGON_AREA_M2;
  const checkSimple = options.checkSimple !== false;

  const exterior = sanitizeRing(polygon[0], minArea);
  if (!exterior) return null;
  if (checkSimple && !isRingSimple(exterior)) return null;
  if (signedRingArea(exterior) < 0) exterior.reverse();

  const exteriorArea = Math.abs(signedRingArea(exterior));
  const holes: Ring[] = [];
  const extMinX = Math.min(...exterior.map((p) => p[0]));
  const extMaxX = Math.max(...exterior.map((p) => p[0]));
  const extMinY = Math.min(...exterior.map((p) => p[1]));
  const extMaxY = Math.max(...exterior.map((p) => p[1]));
  let coveredArea = 0;

  for (let i = 1; i < polygon.length; i++) {
    const hole = sanitizeRing(polygon[i], Math.max(MIN_HOLE_AREA_M2, minArea * 0.01));
    if (!hole) continue;
    if (checkSimple && !isRingSimple(hole)) continue;
    const holeArea = Math.abs(signedRingArea(hole));
    if (holeArea >= exteriorArea * 0.999) continue;
    let insideBounds = true;
    for (const [x, y] of hole) {
      if (x < extMinX - 1e-6 || x > extMaxX + 1e-6 || y < extMinY - 1e-6 || y > extMaxY + 1e-6) {
        insideBounds = false;
        break;
      }
    }
    if (!insideBounds) continue;
    holes.push(hole);
    coveredArea += holeArea;
  }

  return { exterior, holes, area: exteriorArea - coveredArea };
}

/**
 * Triangulate an already prepared polygon. Triangles are CCW in local metres
 * and degenerate/sliver faces are dropped.
 */
export function triangulatePrepared(polygon: PreparedPolygon): Triangle2[] {
  if (polygon.holes.length === 0 && polygon.area <= 0) return [];
  // Vector2 instances are required: ShapeUtils calls `.equals()` on the input.
  const contour = polygon.exterior.map(([x, y]) => new THREE.Vector2(x, y));
  const holeContours = polygon.holes.map((ring) => ring.map(([x, y]) => new THREE.Vector2(x, y)));

  let faces: number[][];
  try {
    faces = THREE.ShapeUtils.triangulateShape(contour, holeContours);
  } catch {
    return [];
  }
  if (!Array.isArray(faces)) return [];

  const points: Point2[] = [];
  for (const [x, y] of polygon.exterior) points.push([x, y]);
  for (const hole of polygon.holes) for (const [x, y] of hole) points.push([x, y]);

  const triangles: Triangle2[] = [];
  for (const face of faces) {
    if (!Array.isArray(face) || face.length < 3) continue;
    const i0 = face[0];
    const i1 = face[1];
    const i2 = face[2];
    if (
      !Number.isInteger(i0) ||
      !Number.isInteger(i1) ||
      !Number.isInteger(i2) ||
      i0 < 0 ||
      i1 < 0 ||
      i2 < 0 ||
      i0 >= points.length ||
      i1 >= points.length ||
      i2 >= points.length
    ) {
      continue;
    }
    const a = points[i0];
    const b = points[i1];
    const c = points[i2];
    const cross = orient(a, b, c);
    if (!Number.isFinite(cross) || Math.abs(cross) < 2 * MIN_TRIANGLE_AREA_M2) continue;
    triangles.push(cross > 0 ? [a, b, c] : [a, c, b]);
  }
  return triangles;
}

/** Prepare + triangulate in one call. Returns [] for invalid geometry. */
export function triangulateFlatPolygon(
  polygon: Polygon | null | undefined,
  options: PrepareOptions = {},
): Triangle2[] {
  const prepared = prepareFlatPolygon(polygon, options);
  if (!prepared) return [];
  return triangulatePrepared(prepared);
}

/** Unsigned area of one local triangle, m². */
export function triangleArea(triangle: Triangle2): number {
  return Math.abs(orient(triangle[0], triangle[1], triangle[2])) / 2;
}

/** Sum of triangle areas, m² (used by tests and diagnostics). */
export function trianglesArea(triangles: readonly Triangle2[]): number {
  let sum = 0;
  for (const triangle of triangles) sum += triangleArea(triangle);
  return sum;
}

function dedupeRing(ring: Ring): Ring {
  const out: Ring = [];
  for (const point of ring) {
    const last = out.length > 0 ? out[out.length - 1] : null;
    if (last && Math.abs(last[0] - point[0]) <= 1e-9 && Math.abs(last[1] - point[1]) <= 1e-9) {
      continue;
    }
    out.push([point[0], point[1]]);
  }
  while (out.length > 1) {
    const first = out[0];
    const last = out[out.length - 1];
    if (Math.abs(first[0] - last[0]) <= 1e-9 && Math.abs(first[1] - last[1]) <= 1e-9) {
      out.pop();
    } else {
      break;
    }
  }
  return out;
}

function intersectHorizontal(a: Point2, b: Point2, y: number): Point2 {
  const dy = b[1] - a[1];
  if (!Number.isFinite(dy) || Math.abs(dy) < 1e-12) return [a[0], y];
  const t = (y - a[1]) / dy;
  return [a[0] + (b[0] - a[0]) * t, y];
}

function clipHalfPlane(ring: Ring, boundary: number, keepAbove: boolean): Ring {
  if (ring.length === 0) return [];
  const out: Ring = [];
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const current = ring[i];
    const previous = ring[(i + n - 1) % n];
    const currentInside = keepAbove ? current[1] >= boundary : current[1] <= boundary;
    const previousInside = keepAbove ? previous[1] >= boundary : previous[1] <= boundary;
    if (currentInside) {
      if (!previousInside) out.push(intersectHorizontal(previous, current, boundary));
      out.push([current[0], current[1]]);
    } else if (previousInside) {
      out.push(intersectHorizontal(previous, current, boundary));
    }
  }
  return dedupeRing(out);
}

/**
 * Clip a ring to a horizontal band `yMin <= y <= yMax` (Sutherland–Hodgman).
 * Used for subtle two-tone water banding; returns [] when fully outside.
 */
export function clipRingToYBand(ring: Ring, yMin: number, yMax: number): Ring {
  if (!Array.isArray(ring) || ring.length < 3) return [];
  if (!Number.isFinite(yMin) || !Number.isFinite(yMax) || yMax <= yMin) return [];
  let out = clipHalfPlane(ring, yMin, true);
  if (out.length < 3) return [];
  out = clipHalfPlane(out, yMax, false);
  return out.length >= 3 ? out : [];
}

/**
 * Douglas–Peucker simplification of a closed ring. Used to keep thin strips
 * (pavements, kerbs, landcover edges) cheap: buffered OSM outlines often carry
 * far more nearly-collinear vertices than pixel-art scale can resolve.
 */
export function simplifyRing(ring: Ring, tolerance: number): Ring {
  if (!Array.isArray(ring) || ring.length < 4 || !(tolerance > 0)) {
    return Array.isArray(ring) ? ring.map((p) => [p[0], p[1]] as Point2) : [];
  }
  const closed: Point2[] = ring.map((p) => [p[0], p[1]] as Point2);
  closed.push([ring[0][0], ring[0][1]]);
  const simplified = douglasPeucker(closed, tolerance, 0, closed.length - 1);
  if (simplified.length > 1) simplified.pop(); // drop closing duplicate
  return simplified.length >= 3 ? simplified : ring.map((p) => [p[0], p[1]] as Point2);
}

function douglasPeucker(points: Point2[], tolerance: number, first: number, last: number): Point2[] {
  if (last <= first) return [points[first]];
  const ax = points[first][0];
  const ay = points[first][1];
  const bx = points[last][0];
  const by = points[last][1];
  const dx = bx - ax;
  const dy = by - ay;
  const length = Math.hypot(dx, dy);
  let maxDistance = -1;
  let maxIndex = -1;
  for (let i = first + 1; i < last; i++) {
    const px = points[i][0] - ax;
    const py = points[i][1] - ay;
    const distance = length < 1e-12 ? Math.hypot(px, py) : Math.abs(px * dy - py * dx) / length;
    if (distance > maxDistance) {
      maxDistance = distance;
      maxIndex = i;
    }
  }
  if (maxDistance <= tolerance || maxIndex < 0) return [points[first], points[last]];
  const left = douglasPeucker(points, tolerance, first, maxIndex);
  const right = douglasPeucker(points, tolerance, maxIndex, last);
  return left.slice(0, -1).concat(right);
}

/**
 * Simplify a prepared polygon's exterior ring for rendering. Falls back to the
 * original when the ring has holes, is already simple, or the simplification
 * would change the area too much (thin strips are sensitive to that).
 */
export function simplifyPreparedPolygon(polygon: PreparedPolygon, tolerance: number): PreparedPolygon {
  if (!(tolerance > 0) || polygon.holes.length > 0 || polygon.exterior.length <= 4) return polygon;
  const simplified = simplifyRing(polygon.exterior, tolerance);
  if (simplified.length < 3 || simplified.length >= polygon.exterior.length) return polygon;
  const originalArea = Math.abs(signedRingArea(polygon.exterior));
  const simplifiedArea = Math.abs(signedRingArea(simplified));
  if (
    !Number.isFinite(simplifiedArea) ||
    simplifiedArea < originalArea * 0.7 ||
    simplifiedArea > originalArea * 1.3
  ) {
    return polygon;
  }
  return { exterior: simplified, holes: polygon.holes, area: polygon.area };
}
