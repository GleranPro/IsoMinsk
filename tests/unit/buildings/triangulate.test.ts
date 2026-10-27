/**
 * Unit tests for the polygon triangulation + 2D polygon helpers.
 */

import { describe, expect, it } from 'vitest';
import { triangulatePolygon } from '../../../src/city/buildings/triangulate';
import {
  convexHull,
  minAreaRect,
  pointInPolygon,
  ringCentroid,
  signedArea,
  type Point2,
} from '../../../src/city/buildings/polygon2d';
import { courtyardPolygon, lShapedRing, rectRing } from '../../fixtures/buildings';

function asRings(polygon: [number, number][][]): Point2[][] {
  return polygon.map((ring) => ring.map(([x, y]) => [x, y] as Point2));
}

function cross(a: Point2, b: Point2, c: Point2): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

/** Proper segment intersection (shared endpoints are allowed). */
function segmentsCross(a: Point2, b: Point2, c: Point2, d: Point2): boolean {
  const same = (p: Point2, q: Point2): boolean => p[0] === q[0] && p[1] === q[1];
  if (same(a, c) || same(a, d) || same(b, c) || same(b, d)) return false;
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  return d1 * d2 < -1e-12 && d3 * d4 < -1e-12;
}

describe('triangulatePolygon', () => {
  it('triangulates a square into 2 triangles without fallback', () => {
    const result = triangulatePolygon([rectRing(0, 0, 10, 10)]);
    expect(result.usedFallback).toBe(false);
    expect(result.triangles).toHaveLength(2);
    expect(result.area).toBeCloseTo(100, 6);
  });

  it('triangulates an L-shaped (concave) footprint without overlap', () => {
    const ring = lShapedRing();
    const polygon: [number, number][][] = [ring];
    const result = triangulatePolygon(polygon);
    expect(result.usedFallback).toBe(false);
    expect(result.area).toBeCloseTo(208, 6); // 20*14 - 8*9
    const rings = asRings(polygon);
    for (const triangle of result.triangles) {
      const cx = (triangle.a[0] + triangle.b[0] + triangle.c[0]) / 3;
      const cy = (triangle.a[1] + triangle.b[1] + triangle.c[1]) / 3;
      expect(pointInPolygon(rings, cx, cy)).toBe(true);
      expect(Number.isFinite(triangle.a[0])).toBe(true);
    }
    // No two triangles may overlap: check all edge pairs for proper crossings.
    for (let i = 0; i < result.triangles.length; i++) {
      const tri = result.triangles[i];
      const edges: [Point2, Point2][] = [
        [tri.a, tri.b],
        [tri.b, tri.c],
        [tri.c, tri.a],
      ];
      for (let j = i + 1; j < result.triangles.length; j++) {
        const other = result.triangles[j];
        const otherEdges: [Point2, Point2][] = [
          [other.a, other.b],
          [other.b, other.c],
          [other.c, other.a],
        ];
        for (const [a, b] of edges) {
          for (const [c, d] of otherEdges) {
            expect(segmentsCross(a, b, c, d)).toBe(false);
          }
        }
      }
    }
  });

  it('preserves courtyard holes', () => {
    const result = triangulatePolygon(courtyardPolygon());
    expect(result.usedFallback).toBe(false);
    expect(result.area).toBeCloseTo(336, 6); // 400 - 64
    const hole: Point2[] = [
      [6, 6],
      [14, 6],
      [14, 14],
      [6, 14],
    ];
    for (const triangle of result.triangles) {
      const cx = (triangle.a[0] + triangle.b[0] + triangle.c[0]) / 3;
      const cy = (triangle.a[1] + triangle.b[1] + triangle.c[1]) / 3;
      expect(pointInPolygon([hole], cx, cy)).toBe(false);
    }
    // A vertex of the hole ring must be present in the triangulation boundary.
    const holeVertices = new Set(['6,6', '14,6', '14,14', '6,14']);
    let found = 0;
    for (const triangle of result.triangles) {
      for (const point of [triangle.a, triangle.b, triangle.c]) {
        if (holeVertices.has(`${point[0]},${point[1]}`)) found++;
      }
    }
    expect(found).toBeGreaterThan(0);
  });

  it('handles clockwise exterior rings too', () => {
    const cwRing: [number, number][] = [
      [0, 0],
      [0, 10],
      [10, 10],
      [10, 0],
    ];
    const result = triangulatePolygon([cwRing]);
    expect(result.usedFallback).toBe(false);
    expect(result.triangles).toHaveLength(2);
    expect(result.area).toBeCloseTo(100, 6);
  });

  it('returns empty output for degenerate input without throwing', () => {
    expect(triangulatePolygon([]).triangles).toHaveLength(0);
    expect(triangulatePolygon([[[0, 0]], [[1, 1], [2, 2]]]).triangles).toHaveLength(0);
    expect(
      triangulatePolygon([
        [
          [0, 0],
          [1, 0],
        ],
      ]).triangles,
    ).toHaveLength(0);
    // Collinear ring -> zero area -> no usable triangles.
    const collinear = triangulatePolygon([
      [
        [0, 0],
        [1, 0],
        [2, 0],
      ],
    ]);
    expect(collinear.triangles).toHaveLength(0);
  });

  it('filters non-finite points', () => {
    const ring = rectRing(0, 0, 10, 10);
    ring.splice(1, 0, [Number.NaN, 5]);
    const result = triangulatePolygon([ring]);
    expect(result.triangles).toHaveLength(2);
    expect(result.area).toBeCloseTo(100, 6);
  });
});

describe('polygon2d helpers', () => {
  it('computes signed area with the CCW convention', () => {
    expect(signedArea(rectRing(0, 0, 10, 10))).toBeCloseTo(100, 9);
    expect(signedArea(rectRing(0, 0, 10, 10).reverse() as [number, number][])).toBeCloseTo(-100, 9);
  });

  it('computes ring centroids', () => {
    expect(ringCentroid(rectRing(0, 0, 10, 10))).toEqual([5, 5]);
    expect(ringCentroid(rectRing(-4, 2, 8, 6))).toEqual([2, 4]);
  });

  it('convex hull contains the input points', () => {
    const hull = convexHull(lShapedRing().map(([x, y]) => [x, y] as Point2));
    expect(hull.length).toBe(5); // (12,5) is inside the hull
    expect(signedArea(hull)).toBeGreaterThan(0);
  });

  it('minimum-area rectangle of a rotated rectangle recovers its dimensions', () => {
    const angle = Math.PI / 6;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const points: Point2[] = (
      [
        [-10, -4],
        [10, -4],
        [10, 4],
        [-10, 4],
      ] as [number, number][]
    ).map(([u, v]) => [u * cos - v * sin, u * sin + v * cos] as Point2);
    const rect = minAreaRect(points);
    expect(rect).not.toBeNull();
    expect(rect!.halfLength).toBeCloseTo(10, 3);
    expect(rect!.halfWidth).toBeCloseTo(4, 3);
    expect(rect!.halfLength * rect!.halfWidth * 4).toBeCloseTo(160, 1);
    expect(Math.hypot(rect!.ux, rect!.uy)).toBeCloseTo(1, 9);
  });
});
