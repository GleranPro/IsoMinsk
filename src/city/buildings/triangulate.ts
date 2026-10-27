/**
 * Robust polygon triangulation with holes.
 *
 * Primary path: three.js `ShapeUtils.triangulateShape` (earcut based).
 * Fallback path: a simple fan over the exterior ring, used only for degenerate
 * inputs or when earcut produces a result that does not cover the polygon.
 *
 * This module never throws and never returns non-finite points.
 */

import { ShapeUtils, Vector2 } from 'three';
import type { Ring } from '../../shared/types';
import { cleanRing, signedArea, type Point2 } from './polygon2d';

export interface Triangle2 {
  a: Point2;
  b: Point2;
  c: Point2;
}

export interface Triangulation {
  triangles: Triangle2[];
  /** Total (unsigned) area of the produced triangles, m². */
  area: number;
  /** True when the fan fallback was used. */
  usedFallback: boolean;
}

const MIN_AREA = 1e-7;

/** Fan triangulation of a ring (works for convex / star shaped rings). */
function fanTriangulate(ring: readonly Point2[]): Triangle2[] {
  const out: Triangle2[] = [];
  if (ring.length < 3) return out;
  for (let i = 1; i < ring.length - 1; i++) {
    const a = ring[0];
    const b = ring[i];
    const c = ring[i + 1];
    const area = Math.abs(
      ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2,
    );
    if (area < MIN_AREA) continue;
    out.push({ a, b, c });
  }
  return out;
}

function triangleArea(triangle: Triangle2): number {
  const { a, b, c } = triangle;
  return Math.abs(((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2);
}

function sumArea(triangles: readonly Triangle2[]): number {
  let area = 0;
  for (const triangle of triangles) area += triangleArea(triangle);
  return area;
}

/**
 * Triangulate a polygon (exterior ring first, then holes) in local metres.
 */
export function triangulatePolygon(polygon: readonly Ring[]): Triangulation {
  const rings: Point2[][] = [];
  for (const ring of polygon) {
    const cleaned = cleanRing(ring);
    if (cleaned.length >= 3) rings.push(cleaned);
  }
  if (!rings.length) return { triangles: [], area: 0, usedFallback: false };

  const exterior = rings[0];
  let expected = Math.abs(signedArea(exterior));
  const holes: Point2[][] = [];
  for (let i = 1; i < rings.length; i++) {
    expected -= Math.abs(signedArea(rings[i]));
    holes.push(rings[i]);
  }
  if (!Number.isFinite(expected) || expected < MIN_AREA) {
    return { triangles: [], area: 0, usedFallback: false };
  }

  let triangles: Triangle2[] = [];
  let usedFallback = false;

  if (holes.length === 0) {
    // Fast path: a convex footprint can be triangulated by a fan, but earcut is
    // cheap too and handles concave rings correctly. Try earcut first.
    triangles = earcutTriangulate(exterior, []);
  } else {
    triangles = earcutTriangulate(exterior, holes);
  }

  if (!triangles.length) {
    usedFallback = true;
    triangles = fanTriangulate(exterior);
  } else {
    // Verify that the triangulation actually covers the polygon. Earcut is very
    // reliable, but a silent failure would produce visible holes in the city,
    // so a cheap area check is worth it.
    const got = sumArea(triangles);
    const tolerance = Math.max(1e-3, expected * 0.02);
    if (Math.abs(got - expected) > tolerance) {
      usedFallback = true;
      triangles = fanTriangulate(exterior);
    }
  }

  // Final finite filter, defensive.
  triangles = triangles.filter(
    (t) =>
      Number.isFinite(t.a[0]) &&
      Number.isFinite(t.a[1]) &&
      Number.isFinite(t.b[0]) &&
      Number.isFinite(t.b[1]) &&
      Number.isFinite(t.c[0]) &&
      Number.isFinite(t.c[1]),
  );

  return { triangles, area: sumArea(triangles), usedFallback };
}

function earcutTriangulate(contour: Point2[], holes: Point2[][]): Triangle2[] {
  try {
    // ShapeUtils mutates its input arrays (it drops duplicated end points via
    // Vector2.equals), so pass fresh THREE.Vector2 instances.
    const contourLike = contour.map((p) => new Vector2(p[0], p[1]));
    const holeLikes = holes.map((hole) => hole.map((p) => new Vector2(p[0], p[1])));
    const faces = ShapeUtils.triangulateShape(contourLike, holeLikes);
    if (!faces.length) return [];
    const pool: Point2[] = contour.slice();
    for (const hole of holes) for (const p of hole) pool.push(p);
    const out: Triangle2[] = [];
    for (const face of faces) {
      if (face.length < 3) continue;
      const a = pool[face[0]];
      const b = pool[face[1]];
      const c = pool[face[2]];
      if (!a || !b || !c) continue;
      const triangle: Triangle2 = { a, b, c };
      if (triangleArea(triangle) < MIN_AREA) continue;
      out.push(triangle);
    }
    return out;
  } catch {
    return [];
  }
}
