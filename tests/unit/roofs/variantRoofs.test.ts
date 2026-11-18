/**
 * Unit tests for the distinctive roof envelopes:
 *
 *  - `mansardSurface`: analytic two-slope (steep lower plane + shallow upper
 *    cap) gambrel/mansard profile across the short axis of the footprint.
 *  - `sawtoothSurface`: oriented industrial sawtooth: one sloped roof plane and
 *    one narrow, near-vertical clerestory plane per bay.
 *
 * Both are pure affine height-function envelopes (see
 * `src/city/roofs/envelope.ts`): the mesher clips the footprint triangulation by
 * every facet region, so these tests verify the analytic contract - planar
 * facets, bounded heights, exact eave closure, break lines and coverage of the
 * real outline - rather than emitted triangles.
 */

import { describe, expect, it } from 'vitest';
import {
  mansardEnvelope,
  mansardSurface,
  sawtoothEnvelope,
  sawtoothSurface,
  SAWTOOTH_CLERESTORY_STRIP_M,
  type VariantRoofRequest,
} from '../../../src/city/roofs/variantRoofs';
import {
  clipHalfPlane,
  polygonArea2D,
  type HeightFacet,
  type RoofSurface,
} from '../../../src/city/roofs/envelope';
import { boundaryRings } from '../../../src/city/buildings/walls';
import { pointInPolygon, type Point2 } from '../../../src/city/buildings/polygon2d';
import { FACE_KIND } from '../../../src/shared/geometry';
import { lShapedRing, makeVolume, rectRing } from '../../fixtures/buildings';

/** 24 x 12 m historic footprint (short axis = local y). */
const MANSARD_RING: Point2[] = rectRing(0, 0, 24, 12);
/** 36 x 16 m industrial hall (long axis = local x). */
const SAWTOOTH_RING: Point2[] = rectRing(0, 0, 36, 16);
/** Too short for sawtooth eligibility (long side 12 m < 15 m). */
const SHORT_RING: Point2[] = rectRing(0, 0, 12, 8);

const MANSARD_EAVE = 10;
const MANSARD_RISE = 3;
/** Ridge height = 13. */
const MANSARD_PEAK = MANSARD_EAVE + MANSARD_RISE;
/**
 * Steep plane / shallow cap transition: the steep plane covers relativeRun =
 * 0.6 of the 6 m half-span measured from the eave, so it meets the cap 2.4 m
 * out from the ridge line at y = 6 (i.e. at y = 3.6 and y = 8.4).
 */
const MANSARD_TRANSITION_Y = 6 - (1 - 0.6) * 6;
const MANSARD_STEEP_SLOPE = (0.75 * MANSARD_RISE) / (0.6 * 6);
const MANSARD_CAP_SLOPE = (0.25 * MANSARD_RISE) / (0.4 * 6);

const SAWTOOTH_EAVE = 9;
const SAWTOOTH_RISE = 1.8;
const SAWTOOTH_PEAK = SAWTOOTH_EAVE + SAWTOOTH_RISE;

function requireSurface(surface: RoofSurface | null): RoofSurface {
  if (!surface) throw new Error('expected the roof envelope to be produced');
  return surface;
}

/** The part of `ring` covered by one convex facet region. */
function facetPolygon(ring: readonly Point2[], facet: HeightFacet): Point2[] {
  let polygon: Point2[] = ring.map(([x, y]) => [x, y] as Point2);
  for (const plane of facet.planes) {
    polygon = clipHalfPlane(polygon, plane);
    if (polygon.length < 3) return [];
  }
  return polygon;
}

/** Point-in-ring that also accepts points exactly on an edge. */
function insideOrOnRing(ring: readonly Point2[], point: Point2, eps = 1e-6): boolean {
  if (pointInPolygon([ring], point[0], point[1])) return true;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const lengthSquared = dx * dx + dy * dy;
    const t =
      lengthSquared > 1e-12
        ? Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / lengthSquared))
        : 0;
    const cx = a[0] + dx * t;
    const cy = a[1] + dy * t;
    if (Math.hypot(point[0] - cx, point[1] - cy) <= eps) return true;
  }
  return false;
}

/** y value where a break line crosses the vertical section x = 12. */
function breakLineAtX(line: { a: number; b: number; c: number }, x: number): number {
  return Math.abs(line.b) > 1e-9 ? -(line.a * x + line.c) / line.b : Number.NaN;
}

describe('variant roofs — mansard', () => {
  it('keeps the height envelope and closes the original eave', () => {
    const rings = boundaryRings(makeVolume([rectRing(0, 0, 24, 12)], 0, 10, 'hipped', 3));
    expect(rings).toHaveLength(1);
    const exterior = rings[0].points;
    const roof = requireSurface(mansardSurface(exterior, exterior, MANSARD_EAVE, MANSARD_RISE, 0));

    // The ridge is exactly one rise above the eave and never above it.
    expect(roof.heightAt(12, 6)).toBeLessThanOrEqual(MANSARD_PEAK + 1e-6);
    expect(roof.heightAt(12, 6)).toBeCloseTo(MANSARD_PEAK, 6);
    // Eave corners and both eave-side edges sit exactly on the eave.
    expect(roof.heightAt(0, 0)).toBeCloseTo(MANSARD_EAVE, 5);
    expect(roof.heightAt(24, 12)).toBeCloseTo(MANSARD_EAVE, 5);
    for (let x = 0; x <= 24; x += 0.5) {
      expect(roof.heightAt(x, 0)).toBeCloseTo(MANSARD_EAVE, 6);
      expect(roof.heightAt(x, 12)).toBeCloseTo(MANSARD_EAVE, 6);
    }
    // The ridge runs along the long axis through the centre line.
    expect(roof.heightAt(0, 6)).toBeCloseTo(MANSARD_PEAK, 6);
    expect(roof.heightAt(24, 6)).toBeCloseTo(MANSARD_PEAK, 6);
    expect(roof.rise).toBe(MANSARD_RISE);
  });

  it('has a steep lower plane, a shallow upper cap and the ridge as break lines', () => {
    const roof = requireSurface(mansardSurface(MANSARD_RING, MANSARD_RING, MANSARD_EAVE, MANSARD_RISE, 0));

    const steepSlope = (roof.heightAt(12, MANSARD_TRANSITION_Y) - roof.heightAt(12, 0)) / MANSARD_TRANSITION_Y;
    const capSlope = (roof.heightAt(12, 6) - roof.heightAt(12, MANSARD_TRANSITION_Y)) / (6 - MANSARD_TRANSITION_Y);
    expect(steepSlope).toBeCloseTo(MANSARD_STEEP_SLOPE, 6);
    expect(capSlope).toBeCloseTo(MANSARD_CAP_SLOPE, 6);
    // The steep lower plane really is the steeper of the two.
    expect(steepSlope).toBeGreaterThan(capSlope * 1.9);

    // breakLines: the ridge plus both steep/cap transitions.
    expect(roof.breakLines).toHaveLength(3);
    const crossings = roof.breakLines.map((line) => breakLineAtX(line, 12)).sort((a, b) => a - b);
    expect(crossings[0]).toBeCloseTo(MANSARD_TRANSITION_Y, 6);
    expect(crossings[1]).toBeCloseTo(6, 6);
    expect(crossings[2]).toBeCloseTo(12 - MANSARD_TRANSITION_Y, 6);
  });

  it('emits planar roofRidge facets that tile the 24 x 12 footprint exactly', () => {
    const roof = requireSurface(mansardSurface(MANSARD_RING, MANSARD_RING, MANSARD_EAVE, MANSARD_RISE, 0));
    expect(roof.facets).toHaveLength(4);
    let covered = 0;
    for (const facet of roof.facets) {
      expect(facet.kind).toBe(FACE_KIND.roofRidge);
      for (const value of [facet.hx, facet.hy, facet.hc]) expect(Number.isFinite(value)).toBe(true);
      const polygon = facetPolygon(MANSARD_RING, facet);
      expect(polygon.length).toBeGreaterThanOrEqual(3);
      covered += polygonArea2D(polygon);
      for (const [x, y] of polygon) {
        const facetHeight = facet.hx * x + facet.hy * y + facet.hc;
        expect(Number.isFinite(facetHeight)).toBe(true);
        expect(facetHeight).toBeGreaterThanOrEqual(MANSARD_EAVE - 1e-9);
        expect(facetHeight).toBeLessThanOrEqual(MANSARD_PEAK + 1e-9);
        // Facet height and global height function agree (continuous envelope).
        expect(roof.heightAt(x, y)).toBeCloseTo(facetHeight, 6);
      }
    }
    // No facet area is emitted outside the outline and nothing is missing.
    expect(covered).toBeCloseTo(24 * 12, 6);
  });

  it('defaults the ridge direction to the minimum-area rectangle long axis', () => {
    const explicit = requireSurface(mansardSurface(MANSARD_RING, MANSARD_RING, MANSARD_EAVE, MANSARD_RISE, 0));
    const implicit = requireSurface(mansardSurface(MANSARD_RING, MANSARD_RING, MANSARD_EAVE, MANSARD_RISE));
    for (const [x, y] of [
      [0, 0],
      [6, 3],
      [12, 6],
      [20, 10],
    ] as Point2[]) {
      expect(implicit.heightAt(x, y)).toBeCloseTo(explicit.heightAt(x, y), 9);
    }
    // The request wrapper accepts a single ring and produces the same envelope.
    const request: VariantRoofRequest = { rings: [MANSARD_RING], eave: MANSARD_EAVE, rise: MANSARD_RISE };
    const envelope = requireSurface(mansardEnvelope(request));
    expect(envelope.heightAt(12, 6)).toBeCloseTo(MANSARD_PEAK, 9);
    expect(envelope.heightAt(0, 0)).toBeCloseTo(MANSARD_EAVE, 9);
  });
});

describe('variant roofs — sawtooth', () => {
  it('emits 2n facet planes and n+1 primary bay boundaries', () => {
    const roof = requireSurface(sawtoothSurface(SAWTOOTH_RING, SAWTOOTH_RING, SAWTOOTH_EAVE, SAWTOOTH_RISE, 4, 0));
    expect(roof.facets).toHaveLength(8);
    expect(roof.breakLines).toHaveLength(5);

    // 4 bays over the 36 m long side -> 9 m bays starting at x = 0, 9, 18, 27.
    for (const x of [0, 9, 18, 27, 36]) {
      expect(roof.heightAt(x, 8)).toBeCloseTo(SAWTOOTH_EAVE, 5);
    }
    // The n + 1 break lines are exactly the bay boundaries at x = 0..36.
    const boundaryX = roof.breakLines
      .map((line) => (Math.abs(line.a) > 1e-9 ? -(line.b * 8 + line.c) / line.a : Number.NaN))
      .sort((a, b) => a - b);
    for (let i = 0; i <= 4; i++) expect(boundaryX[i]).toBeCloseTo(i * 9, 5);
    // Half way up the first sloped plane (bay 0 spans x 0..8.7 before the strip).
    expect(roof.heightAt(4.35, 8)).toBeCloseTo(SAWTOOTH_EAVE + SAWTOOTH_RISE / 2, 5);
    // Rear of the bay (base of the clerestory strip) is exactly eave + rise.
    expect(roof.heightAt(8.7, 8)).toBeCloseTo(SAWTOOTH_PEAK, 5);
    // The profile is constant across the bay direction (local y here).
    for (const y of [0, 4, 8, 12, 16]) {
      expect(roof.heightAt(4.35, y)).toBeCloseTo(SAWTOOTH_EAVE + SAWTOOTH_RISE / 2, 5);
    }
    expect(roof.rise).toBe(SAWTOOTH_RISE);
  });

  it('keeps n sloped planes and n narrow, near-vertical clerestory planes', () => {
    const roof = requireSurface(sawtoothSurface(SAWTOOTH_RING, SAWTOOTH_RING, SAWTOOTH_EAVE, SAWTOOTH_RISE, 4, 0));
    const gradients = roof.facets
      .map((facet) => Math.hypot(facet.hx, facet.hy))
      .sort((a, b) => a - b);
    expect(gradients).toHaveLength(8);
    const slopeGradient = SAWTOOTH_RISE / (9 - SAWTOOTH_CLERESTORY_STRIP_M);
    const clerestoryGradient = SAWTOOTH_RISE / SAWTOOTH_CLERESTORY_STRIP_M;
    for (const gradient of gradients.slice(0, 4)) expect(gradient).toBeCloseTo(slopeGradient, 5);
    for (const gradient of gradients.slice(4)) expect(gradient).toBeCloseTo(clerestoryGradient, 5);
    // The clerestory drop is bounded but effectively vertical.
    expect(gradients[4]).toBeGreaterThan(gradients[3] * 10);
    expect(SAWTOOTH_CLERESTORY_STRIP_M).toBeGreaterThanOrEqual(0.2);
    expect(SAWTOOTH_CLERESTORY_STRIP_M).toBeLessThanOrEqual(0.4);
  });

  const ORIENTED_CASES: { direction: number; ridge: Point2 }[] = [
    // u = x - 18 for direction 0: the bay peels 0.3 m before the boundary at x = 18.
    { direction: 0, ridge: [17.7, 8] },
    // u = y - 8 for direction PI/2.
    { direction: Math.PI / 2, ridge: [18, 7.7] },
  ];

  it.each(ORIENTED_CASES)('stays inside [eave, eave + rise] for direction $direction', ({ direction, ridge }) => {
    const roof = requireSurface(
      sawtoothSurface(SAWTOOTH_RING, SAWTOOTH_RING, SAWTOOTH_EAVE, SAWTOOTH_RISE, 4, direction),
    );
    expect(roof.facets).toHaveLength(8);
    expect(roof.breakLines).toHaveLength(5);
    for (let x = 0.4; x < 36; x += 1.3) {
      for (let y = 0.4; y < 16; y += 0.9) {
        const h = roof.heightAt(x, y);
        expect(Number.isFinite(h)).toBe(true);
        expect(h).toBeGreaterThanOrEqual(SAWTOOTH_EAVE - 1e-9);
        expect(h).toBeLessThanOrEqual(SAWTOOTH_PEAK + 1e-9);
      }
    }
    // Both orientations attain the ridge height inside the outline.
    expect(roof.heightAt(ridge[0], ridge[1])).toBeCloseTo(SAWTOOTH_PEAK, 5);
  });

  it('clips every facet to the exterior outline and covers it exactly', () => {
    const roof = requireSurface(sawtoothSurface(SAWTOOTH_RING, SAWTOOTH_RING, SAWTOOTH_EAVE, SAWTOOTH_RISE, 4, 0));
    let covered = 0;
    for (const facet of roof.facets) {
      const polygon = facetPolygon(SAWTOOTH_RING, facet);
      expect(polygon.length).toBeGreaterThanOrEqual(3);
      covered += polygonArea2D(polygon);
      for (const point of polygon) expect(insideOrOnRing(SAWTOOTH_RING, point)).toBe(true);
    }
    expect(covered).toBeCloseTo(36 * 16, 6);

    // A concave L-shaped hall (20 x 14, notch removed) stays inside its real
    // outline too; clipped facet areas still partition the footprint (208 m²).
    const concave: Point2[] = lShapedRing() as Point2[];
    const concaveRoof = requireSurface(sawtoothSurface(concave, concave, SAWTOOTH_EAVE, SAWTOOTH_RISE, 4, 0));
    let concaveCovered = 0;
    for (const facet of concaveRoof.facets) {
      const polygon = facetPolygon(concave, facet);
      concaveCovered += polygonArea2D(polygon);
      for (const point of polygon) expect(insideOrOnRing(concave, point)).toBe(true);
    }
    expect(concaveCovered).toBeCloseTo(208, 6);
  });
});

describe('variant roofs — structural guards', () => {
  it('returns null for courtyard / multi-ring requests', () => {
    // A volume with a courtyard hole must keep its source roof, not be silently
    // retagged as a gambrel or sawtooth.
    const mansardRequest: VariantRoofRequest = {
      rings: [rectRing(0, 0, 24, 12), rectRing(6, 3, 12, 9)],
      eave: MANSARD_EAVE,
      rise: MANSARD_RISE,
    };
    expect(mansardEnvelope(mansardRequest)).toBeNull();
    const sawtoothRequest: VariantRoofRequest = {
      rings: [rectRing(0, 0, 36, 16), rectRing(6, 3, 12, 9)],
      eave: SAWTOOTH_EAVE,
      rise: SAWTOOTH_RISE,
      bayCount: 4,
    };
    expect(sawtoothEnvelope(sawtoothRequest)).toBeNull();
  });

  it('returns null for a hall shorter than 15 m and for invalid bay counts', () => {
    expect(sawtoothSurface(SHORT_RING, SHORT_RING, SAWTOOTH_EAVE, SAWTOOTH_RISE, 4, 0)).toBeNull();
    expect(
      sawtoothEnvelope({ rings: [SHORT_RING], eave: SAWTOOTH_EAVE, rise: SAWTOOTH_RISE, bayCount: 4 }),
    ).toBeNull();
    expect(
      sawtoothEnvelope({ rings: [SAWTOOTH_RING], eave: SAWTOOTH_EAVE, rise: SAWTOOTH_RISE, bayCount: Number.NaN }),
    ).toBeNull();
    expect(
      sawtoothSurface(SAWTOOTH_RING, SAWTOOTH_RING, SAWTOOTH_EAVE, SAWTOOTH_RISE, Number.NaN, 0),
    ).toBeNull();
    expect(
      sawtoothSurface(SAWTOOTH_RING, SAWTOOTH_RING, SAWTOOTH_EAVE, SAWTOOTH_RISE, Number.POSITIVE_INFINITY, 0),
    ).toBeNull();
  });

  it('clamps bayCount into 3..6', () => {
    const three = requireSurface(
      sawtoothEnvelope({ rings: [SAWTOOTH_RING], eave: SAWTOOTH_EAVE, rise: SAWTOOTH_RISE, bayCount: 2 }),
    );
    expect(three.facets).toHaveLength(6);
    expect(three.breakLines).toHaveLength(4);

    const six = requireSurface(
      sawtoothEnvelope({ rings: [SAWTOOTH_RING], eave: SAWTOOTH_EAVE, rise: SAWTOOTH_RISE, bayCount: 9 }),
    );
    expect(six.facets).toHaveLength(12);
    expect(six.breakLines).toHaveLength(7);

    // Non-integer counts round to the nearest whole bay before clamping.
    const five = requireSurface(
      sawtoothEnvelope({ rings: [SAWTOOTH_RING], eave: SAWTOOTH_EAVE, rise: SAWTOOTH_RISE, bayCount: 4.6 }),
    );
    expect(five.facets).toHaveLength(10);
  });

  it('rejects a sawtooth rise that is not above 1 m', () => {
    expect(sawtoothSurface(SAWTOOTH_RING, SAWTOOTH_RING, SAWTOOTH_EAVE, 1, 4, 0)).toBeNull();
    expect(sawtoothSurface(SAWTOOTH_RING, SAWTOOTH_RING, SAWTOOTH_EAVE, 0.4, 4, 0)).toBeNull();
    expect(
      sawtoothEnvelope({ rings: [SAWTOOTH_RING], eave: SAWTOOTH_EAVE, rise: 1, bayCount: 4 }),
    ).toBeNull();
    expect(
      sawtoothEnvelope({ rings: [SAWTOOTH_RING], eave: SAWTOOTH_EAVE, rise: Number.NaN, bayCount: 4 }),
    ).toBeNull();
    // The mansard keeps a plain rise > 0 rule.
    expect(mansardSurface(MANSARD_RING, MANSARD_RING, MANSARD_EAVE, 0, 0)).toBeNull();
    expect(mansardSurface(MANSARD_RING, MANSARD_RING, MANSARD_EAVE, Number.NaN, 0)).toBeNull();
  });

  it('rejects non-finite eave/rise/direction/bayCount', () => {
    expect(mansardSurface(MANSARD_RING, MANSARD_RING, Number.NaN, MANSARD_RISE, 0)).toBeNull();
    expect(mansardSurface(MANSARD_RING, MANSARD_RING, MANSARD_EAVE, MANSARD_RISE, Number.NaN)).toBeNull();
    expect(
      mansardEnvelope({ rings: [MANSARD_RING], eave: MANSARD_EAVE, rise: MANSARD_RISE, direction: Number.NaN }),
    ).toBeNull();
    expect(mansardEnvelope({ rings: [MANSARD_RING], eave: MANSARD_EAVE, rise: 0 })).toBeNull();
    // bayCount is unused for a mansard, but a non-finite value is still rejected.
    expect(
      mansardEnvelope({ rings: [MANSARD_RING], eave: MANSARD_EAVE, rise: MANSARD_RISE, bayCount: Number.NaN }),
    ).toBeNull();
    expect(
      sawtoothSurface(SAWTOOTH_RING, SAWTOOTH_RING, SAWTOOTH_EAVE, SAWTOOTH_RISE, 4, Number.NaN),
    ).toBeNull();
    expect(
      sawtoothEnvelope({
        rings: [SAWTOOTH_RING],
        eave: SAWTOOTH_EAVE,
        rise: SAWTOOTH_RISE,
        bayCount: 4,
        direction: Number.NaN,
      }),
    ).toBeNull();
    expect(sawtoothSurface(SAWTOOTH_RING, SAWTOOTH_RING, Number.NaN, SAWTOOTH_RISE, 4, 0)).toBeNull();
  });

  it('rejects degenerate ring lists instead of throwing', () => {
    expect(() => mansardEnvelope({ rings: [], eave: MANSARD_EAVE, rise: MANSARD_RISE })).not.toThrow();
    expect(mansardEnvelope({ rings: [], eave: MANSARD_EAVE, rise: MANSARD_RISE })).toBeNull();
    expect(
      mansardEnvelope({ rings: [[[0, 0], [24, 0]]], eave: MANSARD_EAVE, rise: MANSARD_RISE }),
    ).toBeNull();
    expect(
      sawtoothEnvelope({ rings: [[[0, 0], [36, 0]]], eave: SAWTOOTH_EAVE, rise: SAWTOOTH_RISE, bayCount: 4 }),
    ).toBeNull();
    expect(mansardSurface([], [], MANSARD_EAVE, MANSARD_RISE, 0)).toBeNull();
    expect(sawtoothSurface([], [], SAWTOOTH_EAVE, SAWTOOTH_RISE, 4, 0)).toBeNull();
  });

  it('accepts a single valid ring through the request wrappers', () => {
    const mansard = requireSurface(
      mansardEnvelope({ rings: [MANSARD_RING], eave: MANSARD_EAVE, rise: MANSARD_RISE, direction: 0 }),
    );
    expect(mansard.heightAt(12, 6)).toBeCloseTo(MANSARD_PEAK, 5);
    expect(mansard.heightAt(0, 0)).toBeCloseTo(MANSARD_EAVE, 5);

    const sawtooth = requireSurface(
      sawtoothEnvelope({
        rings: [SAWTOOTH_RING],
        eave: SAWTOOTH_EAVE,
        rise: SAWTOOTH_RISE,
        bayCount: 4,
        direction: 0,
      }),
    );
    expect(sawtooth.facets).toHaveLength(8);
    expect(sawtooth.breakLines).toHaveLength(5);
    expect(sawtooth.heightAt(36, 8)).toBeCloseTo(SAWTOOTH_EAVE, 5);
    // The default bay count is deterministic when the caller omits it.
    const defaulted = requireSurface(
      sawtoothEnvelope({ rings: [SAWTOOTH_RING], eave: SAWTOOTH_EAVE, rise: SAWTOOTH_RISE, direction: 0 }),
    );
    expect(defaulted.facets.length / 2).toBeGreaterThanOrEqual(3);
    expect(defaulted.facets.length / 2).toBeLessThanOrEqual(6);
    expect(defaulted.breakLines).toHaveLength(defaulted.facets.length / 2 + 1);
  });
});
