import { describe, expect, it } from 'vitest';
import {
  DASH_LENGTH_M,
  DASH_MAX_PER_ROAD,
  DASH_WIDTH_M,
  convexHull,
  crossSectionAt,
  dashSpacingForClass,
  minAreaRoadAxis,
  offsetRingOutward,
  pointInPreparedPolygon,
  pointInRing,
  railLineLayout,
  roadDashes,
  simplifyRing,
} from '../../../src/city/roads/roadAnalysis';
import { prepareFlatPolygon } from '../../../src/city/environment/triangulate';
import { ringArea } from '../../../src/shared/tileMath';
import type { Polygon, Ring } from '../../../src/shared/types';

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

describe('convexHull / minAreaRoadAxis', () => {
  it('finds the four corners of a square and ignores interior points', () => {
    const hull = convexHull([
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
      [5, 5],
      [2, 3],
    ]);
    expect(hull).toHaveLength(4);
    expect(Math.abs(ringArea(hull))).toBeCloseTo(100, 6);
  });

  it('derives the long axis of a wide avenue polygon', () => {
    const axis = minAreaRoadAxis(rect(0, -9, 120, 9));
    expect(axis).not.toBeNull();
    expect(axis!.length).toBeCloseTo(120, 4);
    expect(axis!.width).toBeCloseTo(18, 4);
    expect(Math.hypot(axis!.ux, axis!.uy)).toBeCloseTo(1, 9);
    expect(axis!.cx).toBeCloseTo(60, 4);
    expect(axis!.cy).toBeCloseTo(0, 4);
    // Long axis is east/west for this rectangle.
    expect(Math.abs(axis!.ux)).toBeCloseTo(1, 6);
    expect(Math.abs(axis!.uy)).toBeCloseTo(0, 6);
  });

  it('is deterministic', () => {
    const ring = rect(0, -9, 120, 9);
    expect(minAreaRoadAxis(ring)).toEqual(minAreaRoadAxis(ring));
  });

  it('returns null for degenerate rings', () => {
    expect(minAreaRoadAxis([])).toBeNull();
    expect(minAreaRoadAxis([[0, 0], [1, 1]])).toBeNull();
  });
});

describe('crossSectionAt', () => {
  it('returns the polygon centre and half width along the road', () => {
    const ring = rect(0, -9, 120, 9);
    const axis = minAreaRoadAxis(ring)!;
    const middle = crossSectionAt(ring, axis, 0)!;
    expect(middle.x).toBeCloseTo(60, 4);
    expect(middle.y).toBeCloseTo(0, 4);
    expect(middle.halfWidth).toBeCloseTo(9, 4);

    const east = crossSectionAt(ring, axis, 30)!;
    expect(east.x).toBeCloseTo(90, 4);
    expect(east.halfWidth).toBeCloseTo(9, 4);
  });

  it('returns null outside the polygon', () => {
    const ring = rect(0, -9, 120, 9);
    const axis = minAreaRoadAxis(ring)!;
    expect(crossSectionAt(ring, axis, 80)).toBeNull();
  });
});

describe('point tests', () => {
  it('detects points inside / outside a ring', () => {
    const ring = rect(0, 0, 10, 10);
    expect(pointInRing(ring, 5, 5)).toBe(true);
    expect(pointInRing(ring, -1, 5)).toBe(false);
    expect(pointInRing(ring, 11, 5)).toBe(false);
  });

  it('respects holes', () => {
    const polygon = prepared([rect(0, 0, 20, 20), rect(5, 5, 15, 15)]);
    expect(pointInPreparedPolygon(polygon, 2, 2)).toBe(true);
    expect(pointInPreparedPolygon(polygon, 10, 10)).toBe(false);
  });
});

describe('roadDashes', () => {
  it('produces deterministic dashes spaced 6–9 m apart', () => {
    const polygon = prepared([rect(0, -9, 120, 9)]);
    const first = roadDashes(polygon, 'primary', 18);
    const second = roadDashes(polygon, 'primary', 18);
    expect(first).toEqual(second);
    expect(first.length).toBeGreaterThan(5);
    expect(first.length).toBeLessThanOrEqual(DASH_MAX_PER_ROAD);
    const spacing = dashSpacingForClass('primary');
    expect(spacing).toBeGreaterThanOrEqual(6);
    expect(spacing).toBeLessThanOrEqual(9);
    for (let i = 0; i < first.length; i++) {
      const dash = first[i];
      expect(dash.length).toBeCloseTo(DASH_LENGTH_M, 9);
      expect(dash.width).toBeCloseTo(DASH_WIDTH_M, 9);
      expect(Math.hypot(dash.ux, dash.uy)).toBeCloseTo(1, 9);
      expect(dash.cx).toBeGreaterThanOrEqual(0);
      expect(dash.cx).toBeLessThanOrEqual(120);
      if (i > 0) {
        const previous = first[i - 1];
        const distance = Math.hypot(dash.cx - previous.cx, dash.cy - previous.cy);
        expect(distance).toBeCloseTo(spacing, 4);
      }
    }
  });

  it('places every dash fully inside the road polygon', () => {
    const polygon = prepared([rect(0, -9, 120, 9)]);
    for (const dash of roadDashes(polygon, 'secondary', 18)) {
      const half = dash.length / 2;
      expect(pointInPreparedPolygon(polygon, dash.cx - dash.ux * half, dash.cy - dash.uy * half)).toBe(
        true,
      );
      expect(pointInPreparedPolygon(polygon, dash.cx + dash.ux * half, dash.cy + dash.uy * half)).toBe(
        true,
      );
    }
  });

  it('skips narrow, short and non-avenue roads', () => {
    expect(roadDashes(prepared([rect(0, -3, 120, 3)]), 'primary', 6)).toEqual([]);
    expect(roadDashes(prepared([rect(0, -4, 10, 4)]), 'primary', 8)).toEqual([]);
    expect(roadDashes(prepared([rect(0, -9, 120, 9)]), 'residential', 18)).toEqual([]);
    expect(roadDashes(prepared([rect(0, -9, 120, 9)]), 'footway', 18)).toEqual([]);
  });

  it('handles a polygon with a hole without crashing', () => {
    const polygon = prepared([rect(0, -9, 120, 9), rect(40, -3, 60, 3)]);
    const dashes = roadDashes(polygon, 'primary', 18);
    // Dashes crossing the hole are dropped, the rest remain.
    expect(dashes.length).toBeGreaterThan(0);
    for (const dash of dashes) {
      expect(pointInPreparedPolygon(polygon, dash.cx, dash.cy)).toBe(true);
    }
  });
});

describe('railLineLayout', () => {
  it('emits two inset rail lines following the track', () => {
    const polygon = prepared([rect(0, -1.75, 120, 1.75)]);
    const layout = railLineLayout(polygon, 3.5);
    expect(layout.halfGauge).toBeGreaterThan(0.4);
    expect(layout.railWidth).toBeGreaterThan(0.2);
    expect(layout.segments.length).toBeGreaterThan(10);
    for (const segment of layout.segments) {
      expect(Number.isFinite(segment.x0)).toBe(true);
      expect(pointInPreparedPolygon(polygon, segment.x0, segment.y0)).toBe(true);
      expect(pointInPreparedPolygon(polygon, segment.x1, segment.y1)).toBe(true);
      expect(segment.width).toBeCloseTo(layout.railWidth, 9);
    }
    // Two parallel lines: segments exist above and below the centre line.
    expect(layout.segments.some((s) => s.y0 > 0.1)).toBe(true);
    expect(layout.segments.some((s) => s.y0 < -0.1)).toBe(true);
  });

  it('returns no rail lines for very narrow polygons', () => {
    const layout = railLineLayout(prepared([rect(0, -0.8, 120, 0.8)]), 1.6);
    expect(layout.segments).toEqual([]);
  });
});

describe('kerb helpers', () => {
  it('simplifies a collinear-heavy ring', () => {
    const ring: Ring = [
      [0, 0],
      [5, 0],
      [10, 0],
      [10, 5],
      [10, 10],
      [5, 10],
      [0, 10],
      [0, 5],
    ];
    const simplified = simplifyRing(ring, 0.15);
    expect(simplified.length).toBeGreaterThanOrEqual(4);
    expect(simplified.length).toBeLessThan(ring.length);
    expect(Math.abs(ringArea(simplified))).toBeCloseTo(100, 6);
  });

  it('offsets a CCW square outward', () => {
    const square = rect(0, 0, 10, 10);
    const offset = offsetRingOutward(square, 1)!;
    expect(offset).not.toBeNull();
    const area = Math.abs(ringArea(offset));
    expect(area).toBeGreaterThan(100);
    expect(area).toBeCloseTo(144, 4);
    expect(Math.min(...offset.map((p) => p[0]))).toBeCloseTo(-1, 6);
    expect(Math.max(...offset.map((p) => p[0]))).toBeCloseTo(11, 6);
  });

  it('returns null for degenerate rings', () => {
    expect(offsetRingOutward([[0, 0]], 0.5)).toBeNull();
    expect(offsetRingOutward(rect(0, 0, 10, 10), 0)).toBeNull();
  });
});
