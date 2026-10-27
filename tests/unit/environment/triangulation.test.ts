import { describe, expect, it } from 'vitest';
import {
  clipRingToYBand,
  isRingSimple,
  prepareFlatPolygon,
  sanitizeRing,
  signedRingArea,
  trianglesArea,
  triangulateFlatPolygon,
} from '../../../src/city/environment/triangulate';
import { ringArea } from '../../../src/shared/tileMath';
import type { Polygon, Ring } from '../../../src/shared/types';

function triangleSignedArea(a: [number, number], b: [number, number], c: [number, number]): number {
  return ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;
}

function rect(minX: number, minY: number, maxX: number, maxY: number): Ring {
  return [
    [minX, minY],
    [maxX, minY],
    [maxX, maxY],
    [minX, maxY],
  ];
}

describe('triangulateFlatPolygon', () => {
  it('covers a concave polygon with the exact ring area', () => {
    // L-shape: the classic fan-triangulation failure case.
    const concave: Polygon = [
      [
        [0, 0],
        [30, 0],
        [30, 10],
        [10, 10],
        [10, 30],
        [0, 30],
      ],
    ];
    const expected = Math.abs(ringArea(concave[0])); // 500 m²
    expect(expected).toBeCloseTo(500, 6);

    const triangles = triangulateFlatPolygon(concave);
    expect(triangles.length).toBeGreaterThanOrEqual(4);
    expect(trianglesArea(triangles)).toBeCloseTo(expected, 6);
    // Concavity must be respected: no triangle may cover the notch.
    for (const [a, b, c] of triangles) {
      const cx = (a[0] + b[0] + c[0]) / 3;
      const cy = (a[1] + b[1] + c[1]) / 3;
      const inNotch = cx > 10 + 1e-6 && cy > 10 + 1e-6;
      expect(inNotch).toBe(false);
    }
  });

  it('winds every triangle counter-clockwise (faces +Y in world space)', () => {
    const polygon: Polygon = [
      [
        [0, 0],
        [40, 0],
        [40, 15],
        [15, 15],
        [15, 40],
        [0, 40],
      ],
    ];
    const triangles = triangulateFlatPolygon(polygon);
    expect(triangles.length).toBeGreaterThan(0);
    for (const triangle of triangles) {
      expect(triangleSignedArea(triangle[0], triangle[1], triangle[2])).toBeGreaterThan(0);
    }
  });

  it('respects holes: area = exterior - holes', () => {
    const exterior: Ring = rect(0, 0, 40, 40); // 1600 m²
    const hole: Ring = rect(10, 10, 30, 30); // 400 m², same winding on purpose
    const triangles = triangulateFlatPolygon([exterior, hole]);
    expect(trianglesArea(triangles)).toBeCloseTo(1600 - 400, 6);
    // No triangle centroid may fall strictly inside the hole.
    for (const [a, b, c] of triangles) {
      const cx = (a[0] + b[0] + c[0]) / 3;
      const cy = (a[1] + b[1] + c[1]) / 3;
      const insideHole = cx > 10.1 && cx < 29.9 && cy > 10.1 && cy < 29.9;
      expect(insideHole).toBe(false);
    }
  });

  it('handles multiple holes and a concave exterior', () => {
    const polygon: Polygon = [
      [
        [0, 0],
        [40, 0],
        [40, 40],
        [20, 40],
        [20, 25],
        [10, 25],
        [10, 40],
        [0, 40],
      ],
      rect(2, 2, 6, 6),
      rect(30, 30, 36, 36),
    ];
    const expected =
      Math.abs(ringArea(polygon[0])) - Math.abs(ringArea(polygon[1])) - Math.abs(ringArea(polygon[2]));
    const triangles = triangulateFlatPolygon(polygon);
    expect(trianglesArea(triangles)).toBeCloseTo(expected, 6);
  });

  it('drops the duplicated closing vertex instead of doubling geometry', () => {
    const closed: Polygon = [
      [
        [0, 0],
        [20, 0],
        [20, 20],
        [0, 20],
        [0, 0],
      ],
    ];
    const triangles = triangulateFlatPolygon(closed);
    expect(trianglesArea(triangles)).toBeCloseTo(400, 6);
  });

  it('welds duplicate consecutive points', () => {
    const dirty: Polygon = [
      [
        [0, 0],
        [0, 0],
        [20, 0],
        [20, 0],
        [20, 20],
        [0, 20],
      ],
    ];
    const triangles = triangulateFlatPolygon(dirty);
    expect(trianglesArea(triangles)).toBeCloseTo(400, 6);
  });
});

describe('degenerate geometry is skipped, never thrown', () => {
  it('returns [] for empty / short / zero-area / NaN polygons', () => {
    const cases: unknown[] = [
      [],
      [undefined],
      [[[0, 0]]],
      [
        [
          [0, 0],
          [1, 1],
        ],
      ],
      // Collinear
      [
        [
          [0, 0],
          [10, 0],
          [20, 0],
        ],
      ],
      // NaN coordinate
      [
        [
          [NaN, 0],
          [10, 0],
          [10, 10],
        ],
      ],
      // Infinity coordinate
      [
        [
          [0, 0],
          [Infinity, 0],
          [10, 10],
        ],
      ],
      // Bow-tie with zero net area
      [
        [
          [0, 0],
          [10, 10],
          [10, 0],
          [0, 10],
        ],
      ],
    ];
    for (const polygon of cases) {
      expect(() => triangulateFlatPolygon(polygon as Polygon)).not.toThrow();
      expect(triangulateFlatPolygon(polygon as Polygon)).toEqual([]);
    }
  });

  it('rejects a self-intersecting ring with non-zero signed area', () => {
    const selfIntersecting: Ring = [
      [0, 0],
      [20, 0],
      [20, 20],
      [0, 20],
      [10, -10],
    ];
    expect(isRingSimple(selfIntersecting)).toBe(false);
    expect(prepareFlatPolygon([selfIntersecting])).toBeNull();
    expect(triangulateFlatPolygon([selfIntersecting])).toEqual([]);
  });

  it('does not throw on a malformed holes array', () => {
    const polygon = [rect(0, 0, 10, 10), undefined, [], rect(50, 50, 60, 60)] as unknown as Polygon;
    expect(() => triangulateFlatPolygon(polygon)).not.toThrow();
    expect(trianglesArea(triangulateFlatPolygon(polygon))).toBeCloseTo(100, 6);
  });
});

describe('prepareFlatPolygon / sanitizeRing', () => {
  it('normalises the exterior ring to counter-clockwise', () => {
    const clockwiseExterior: Ring = [
      [0, 0],
      [0, 20],
      [20, 20],
      [20, 0],
    ];
    expect(signedRingArea(clockwiseExterior)).toBeLessThan(0);
    const prepared = prepareFlatPolygon([clockwiseExterior]);
    expect(prepared).not.toBeNull();
    expect(signedRingArea(prepared!.exterior)).toBeGreaterThan(0);
  });

  it('rejects rings below the minimum area', () => {
    expect(sanitizeRing(rect(0, 0, 0.2, 0.2), 1)).toBeNull();
    expect(sanitizeRing(rect(0, 0, 0.2, 0.2), 0.01)).not.toBeNull();
  });
});

describe('clipRingToYBand', () => {
  it('clips a square to a horizontal band with the right area', () => {
    const square = rect(0, 0, 10, 10);
    const clipped = clipRingToYBand(square, 3, 7);
    expect(clipped.length).toBeGreaterThanOrEqual(4);
    expect(Math.abs(ringArea(clipped))).toBeCloseTo(10 * 4, 6);
  });

  it('returns [] when the band misses the ring', () => {
    expect(clipRingToYBand(rect(0, 0, 10, 10), 20, 30)).toEqual([]);
  });

  it('returns [] for reversed/invalid bands', () => {
    expect(clipRingToYBand(rect(0, 0, 10, 10), 7, 3)).toEqual([]);
    expect(clipRingToYBand(rect(0, 0, 10, 10), NaN, 3)).toEqual([]);
  });
});
