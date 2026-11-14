/**
 * Distinctive eligible roof envelopes: analytic mansard (gambrel) and oriented
 * industrial sawtooth.
 *
 * Both envelopes follow the affine height-function contract of
 * `./envelope.ts`: a roof is a set of convex facet regions in the plan plus one
 * affine height function per facet. The footprint triangulation is clipped by
 * every facet region in `roofMesh.emitFacetRoof`, so nothing this module
 * returns is ever meshed outside the real OSM exterior ring; the length of a
 * returned surface's `facets`/`breakLines` is therefore a *plan* property, not a
 * triangle count.
 *
 * ## Mansard (`mansardSurface`)
 *
 * A symmetric two-slope profile across the short axis of the footprint:
 *
 *  - the steep lower plane starts at the eave and covers `MANSARD_STEEP_RUN`
 *    (0.6) of the short-axis half-span, carrying `MANSARD_STEEP_RISE` (0.75) of
 *    the total rise,
 *  - the shallow upper cap carries the remaining quarter of the rise over the
 *    last 0.4 of the half-span and meets the ridge at `eave + rise`.
 *
 * The ridge line runs along `direction` (default: the minimum-area rectangle's
 * long axis) through the middle of the projected span, so the height at both
 * eave lines is exactly `eave` and the peak is exactly `eave + rise`. The
 * profile only varies across the ridge direction, which makes the two short
 * ends proper gable closures (the existing `addEaveClosings` pass splits them
 * at the `ridge`/`transition` break lines). On an irregular plan that is
 * narrower than the full short-axis span at some point, the profile simply
 * returns above `eave` there; the same closing pass caps it with a planar
 * vertical wall, exactly as it does for a gable end.
 *
 * ## Sawtooth (`sawtoothSurface`)
 *
 * `n` repeating bays along the long side of the minimum-area rectangle. In a
 * bay the sloped roof plane rises from `eave` at the bay start to
 * `eave + rise`, then a narrow clerestory plane drops back to `eave` over
 * `SAWTOOTH_CLERESTORY_STRIP_M` (0.3 m) so the fall is bounded but effectively
 * vertical. That gives `2n` facet planes per hall.
 *
 * `breakLines` carries the `n + 1` primary bay boundaries (`eave` height on both
 * sides); the clerestory strip's own lower edge is a secondary kink inside the
 * bay and deliberately not listed, because it is sub-metre and the caller
 * samples it from `heightAt` when closing the eave.
 *
 * The local ridge coordinate is
 *
 * ```text
 * u = (x - cx) * cos(direction) + (y - cy) * sin(direction)
 * ```
 *
 * with `(cx, cy)` the minimum-area rectangle centre. Bays are `longSide / n`
 * wide, centred on the rectangle; because the projected span along an
 * arbitrary source direction can exceed `longSide`, the bay size is widened to
 * cover the whole projected span (the regular case is unchanged).
 *
 * ## Eligibility
 *
 * Every entry point is total: ineligible input returns `null` (never throws)
 * and the caller keeps the original source roof. A complex/courtyard/elevated
 * volume is never silently retagged as a mansard, gable, hip or sawtooth.
 */

import { FACE_KIND } from '../../shared/geometry';
import {
  minAreaRect,
  signedArea,
  type Point2,
} from '../buildings/polygon2d';
import type { HalfPlane, HeightFacet, RoofSurface } from './envelope';

/** Plan coordinate tolerance for cleaning / degeneracy checks (metres). */
const GEOMETRY_EPS = 1e-9;

// --- Mansard profile --------------------------------------------------------

/** Fraction of the short-axis half-span covered by the steep lower plane. */
const MANSARD_STEEP_RUN = 0.6;
/** Fraction of the total rise carried by the steep lower plane. */
const MANSARD_STEEP_RISE = 0.75;
/** Smallest usable half-span of the short axis (metres). */
const MANSARD_MIN_HALF_SPAN = 0.5;

// --- Sawtooth profile -------------------------------------------------------

/**
 * Width of the near-vertical clerestory plane at the rear of each sawtooth bay
 * (metres). Narrow enough to read as a vertical clerestory window, wide enough
 * that the analytic plane stays finite and bounded: with a 1.8 m rise the drop
 * is a ~6.0 gradient, versus ~0.21 for the adjoining roof plane.
 */
export const SAWTOOTH_CLERESTORY_STRIP_M = 0.3;

/** A sawtooth hall must be at least this long along its long side (metres). */
const SAWTOOTH_MIN_LONG_SIDE = 15;
/** Below this rise a sawtooth profile is not worth an industrial roof. */
const SAWTOOTH_MIN_RISE = 1;
const SAWTOOTH_MIN_BAYS = 3;
const SAWTOOTH_MAX_BAYS = 6;
/** Bay count used when the caller does not supply one. */
const SAWTOOTH_DEFAULT_BAYS = 4;
/** The clerestory strip never takes more than this share of a bay. */
const SAWTOOTH_MAX_STRIP_SHARE = 0.2;

/**
 * Distinct roof envelope request. `rings` is the volume footprint: exactly one
 * exterior ring is eligible, so a courtyard hole, an elevated part or an
 * overlapping multi-ring volume is rejected by returning `null`.
 */
export interface VariantRoofRequest {
  rings: readonly (readonly Point2[])[];
  eave: number;
  rise: number;
  direction?: number;
  bayCount?: number;
}

/** Copy a ring, dropping non-finite points and duplicate/seam vertices. */
function sanitizeRing(ring: readonly Point2[] | undefined): Point2[] {
  const out: Point2[] = [];
  if (!ring) return out;
  for (const point of ring) {
    const x = point[0];
    const y = point[1];
    // A non-finite vertex makes the whole request ineligible; callers must not
    // receive a silently truncated footprint.
    if (!Number.isFinite(x) || !Number.isFinite(y)) return [];
    const last = out.length ? out[out.length - 1] : null;
    if (last && Math.abs(last[0] - x) <= GEOMETRY_EPS && Math.abs(last[1] - y) <= GEOMETRY_EPS) {
      continue;
    }
    out.push([x, y]);
  }
  while (out.length > 1) {
    const first = out[0];
    const last = out[out.length - 1];
    if (
      Math.abs(first[0] - last[0]) <= GEOMETRY_EPS &&
      Math.abs(first[1] - last[1]) <= GEOMETRY_EPS
    ) {
      out.pop();
    } else {
      break;
    }
  }
  return out;
}

/** Ridge axis for a surface: explicit source direction or the rectangle long axis. */
function ridgeAxes(
  direction: number | undefined,
  rectUx: number,
  rectUy: number,
): [number, number] | null {
  let dirX = direction !== undefined ? Math.cos(direction) : rectUx;
  let dirY = direction !== undefined ? Math.sin(direction) : rectUy;
  const length = Math.hypot(dirX, dirY);
  if (!(length > GEOMETRY_EPS) || !Number.isFinite(length)) return null;
  dirX /= length;
  dirY /= length;
  return [dirX, dirY];
}

/**
 * Analytic mansard/gambrel envelope over a single footprint ring.
 *
 * The ridge runs along `direction` (default: the minimum-area rectangle long
 * axis). The short-axis span is measured from the extremes of `allPoints`, so
 * every footprint point is inside the profile domain and the height never
 * leaves `[eave, eave + rise]`. Returns `null` for unusable or ineligible
 * input instead of throwing.
 */
export function mansardSurface(
  exterior: readonly Point2[],
  allPoints: readonly Point2[],
  eave: number,
  rise: number,
  direction?: number,
): RoofSurface | null {
  if (!Number.isFinite(eave) || !Number.isFinite(rise) || !(rise > 0)) return null;
  if (direction !== undefined && !Number.isFinite(direction)) return null;

  const exteriorRing = sanitizeRing(exterior);
  if (exteriorRing.length < 3) return null;
  const points = sanitizeRing(allPoints.length >= 3 ? allPoints : exterior);
  if (points.length < 3) return null;

  const rect = minAreaRect(points);
  if (!rect) return null;
  if (!(rect.halfLength > 0.1) || !(rect.halfWidth > 0.1)) return null;

  const axes = ridgeAxes(direction, rect.ux, rect.uy);
  if (!axes) return null;
  const [dirX, dirY] = axes;
  // The two-slope profile runs across the ridge, i.e. along the perpendicular.
  const acrossX = -dirY;
  const acrossY = dirX;

  let dMin = Infinity;
  let dMax = -Infinity;
  for (const point of points) {
    const d = point[0] * acrossX + point[1] * acrossY;
    if (d < dMin) dMin = d;
    if (d > dMax) dMax = d;
  }
  const halfSpan = (dMax - dMin) / 2;
  if (!(halfSpan > MANSARD_MIN_HALF_SPAN) || !Number.isFinite(halfSpan)) return null;
  const dMid = (dMin + dMax) / 2;

  // Profile: slope (height per metre of distance from the ridge line). The
  // steep plane carries 3/4 of the rise over 0.6 of the half-span, the cap 1/4
  // over the last 0.4 -> the lower plane is exactly twice as steep.
  const steepSlope = (MANSARD_STEEP_RISE * rise) / (MANSARD_STEEP_RUN * halfSpan);
  const capSlope = ((1 - MANSARD_STEEP_RISE) * rise) / ((1 - MANSARD_STEEP_RUN) * halfSpan);
  const capBand = (1 - MANSARD_STEEP_RUN) * halfSpan;

  const facets: HeightFacet[] = [];
  // One cap and one steep facet per side of the ridge line (q >= 0 along +).
  for (const sign of [1, -1]) {
    const alongX = sign * acrossX;
    const alongY = sign * acrossY;
    const offset = sign * dMid; // q(x, y) = alongX*x + alongY*y - offset
    facets.push({
      // 0 <= q <= capBand: shallow cap, from the ridge down to the transition.
      planes: [
        { a: alongX, b: alongY, c: -offset },
        { a: -alongX, b: -alongY, c: offset + capBand },
      ],
      hx: -capSlope * alongX,
      hy: -capSlope * alongY,
      hc: eave + rise + capSlope * offset,
      kind: FACE_KIND.roofRidge,
    });
    facets.push({
      // capBand <= q <= halfSpan: steep lower plane, down to the eave.
      planes: [
        { a: alongX, b: alongY, c: -(offset + capBand) },
        { a: -alongX, b: -alongY, c: offset + halfSpan },
      ],
      hx: -steepSlope * alongX,
      hy: -steepSlope * alongY,
      hc: eave + steepSlope * (halfSpan + offset),
      kind: FACE_KIND.roofRidge,
    });
  }

  const profileHeight = (distanceFromRidge: number): number => {
    const q = distanceFromRidge < 0 ? 0 : distanceFromRidge > halfSpan ? halfSpan : distanceFromRidge;
    const h =
      q <= capBand
        ? eave + rise - capSlope * q
        : eave + steepSlope * (halfSpan - q);
    if (h < eave) return eave;
    if (h > eave + rise) return eave + rise;
    return h;
  };

  return {
    facets,
    heightAt(x: number, y: number): number {
      const d = x * acrossX + y * acrossY;
      return profileHeight(Math.abs(d - dMid));
    },
    breakLines: [
      // The ridge line...
      { a: acrossX, b: acrossY, c: -dMid },
      // ...and the steep/cap transitions on both sides.
      { a: acrossX, b: acrossY, c: -(dMid + capBand) },
      { a: acrossX, b: acrossY, c: -(dMid - capBand) },
    ],
    rise,
  };
}

/** Round and clamp a requested sawtooth bay count into 3..6. */
function clampBayCount(bayCount: number): number {
  const rounded = Math.round(bayCount);
  if (!Number.isFinite(rounded)) return SAWTOOTH_DEFAULT_BAYS;
  return Math.min(SAWTOOTH_MAX_BAYS, Math.max(SAWTOOTH_MIN_BAYS, rounded));
}

/**
 * Oriented industrial sawtooth envelope over a single footprint ring.
 *
 * `bayCount` sawteeth -> `2 * bayCount` facet planes and `bayCount + 1` primary
 * bay boundaries in `breakLines`. Returns `null` when the hall is too short
 * (< 15 m long side), the rise is not above 1 m, or any input is non-finite.
 */
export function sawtoothSurface(
  exterior: readonly Point2[],
  allPoints: readonly Point2[],
  eave: number,
  rise: number,
  bayCount: number,
  direction?: number,
): RoofSurface | null {
  if (!Number.isFinite(eave) || !Number.isFinite(rise) || !(rise > SAWTOOTH_MIN_RISE)) return null;
  if (!Number.isFinite(bayCount)) return null;
  if (direction !== undefined && !Number.isFinite(direction)) return null;

  const exteriorRing = sanitizeRing(exterior);
  if (exteriorRing.length < 3) return null;
  const points = sanitizeRing(allPoints.length >= 3 ? allPoints : exterior);
  if (points.length < 3) return null;

  const rect = minAreaRect(points);
  if (!rect) return null;
  const longSide = rect.halfLength * 2;
  if (!(longSide >= SAWTOOTH_MIN_LONG_SIDE)) return null;
  if (!(rect.halfWidth > 0.1)) return null;

  const axes = ridgeAxes(direction, rect.ux, rect.uy);
  if (!axes) return null;
  const [dirX, dirY] = axes;

  // u = (x - cx) * cos(direction) + (y - cy) * sin(direction), measured from
  // the minimum-area rectangle centre.
  let uMin = Infinity;
  let uMax = -Infinity;
  for (const point of points) {
    const u = (point[0] - rect.cx) * dirX + (point[1] - rect.cy) * dirY;
    if (u < uMin) uMin = u;
    if (u > uMax) uMax = u;
  }
  const uExtent = uMax - uMin;
  if (!(uExtent > 1) || !Number.isFinite(uExtent)) return null;

  const bays = clampBayCount(bayCount);
  // A source `direction` oblique to the long axis projects a span wider than
  // the long side; widen the bays so the pattern still covers the whole
  // footprint. For the regular (long-axis) case this is exactly
  // `longSide / bayCount`.
  const span = Math.max(longSide, uExtent);
  const bay = span / bays;
  const strip = Math.min(SAWTOOTH_CLERESTORY_STRIP_M, bay * SAWTOOTH_MAX_STRIP_SHARE);
  const slopeWidth = bay - strip;
  if (!(slopeWidth > 0.1) || !Number.isFinite(slopeWidth)) return null;

  // Bay boundaries: the projected span is centred on the rectangle centre.
  const uBase = (uMin + uMax) / 2 - span / 2;
  const uOrigin = rect.cx * dirX + rect.cy * dirY;
  const uOf = (x: number, y: number): number => x * dirX + y * dirY - uOrigin;

  const riseSlope = rise / slopeWidth;
  const stripSlope = rise / strip;
  const facets: HeightFacet[] = [];
  const breakLines: HalfPlane[] = [];
  for (let i = 0; i < bays; i++) {
    const start = uBase + i * bay;
    const shoulder = start + slopeWidth;
    const end = start + bay;
    // Sloped roof plane: eave at the bay start, eave + rise at the shoulder.
    facets.push({
      planes: [
        { a: dirX, b: dirY, c: -(uOrigin + start) },
        { a: -dirX, b: -dirY, c: uOrigin + shoulder },
      ],
      hx: riseSlope * dirX,
      hy: riseSlope * dirY,
      hc: eave - riseSlope * (uOrigin + start),
      kind: FACE_KIND.roofRidge,
    });
    // Near-vertical clerestory plane at the rear of the bay.
    facets.push({
      planes: [
        { a: dirX, b: dirY, c: -(uOrigin + shoulder) },
        { a: -dirX, b: -dirY, c: uOrigin + end },
      ],
      hx: -stripSlope * dirX,
      hy: -stripSlope * dirY,
      hc: eave + rise + stripSlope * (uOrigin + shoulder),
      kind: FACE_KIND.roofRidge,
    });
    // Primary bay boundaries (n + 1 in total): where the roof is at `eave`.
    breakLines.push({ a: dirX, b: dirY, c: -(uOrigin + start) });
  }
  breakLines.push({ a: dirX, b: dirY, c: -(uOrigin + uBase + bays * bay) });

  return {
    facets,
    heightAt(x: number, y: number): number {
      const relative = (uOf(x, y) - uBase) / bay;
      if (!(relative > 0) || !(relative < bays)) return eave;
      const index = Math.floor(relative);
      const local = uOf(x, y) - (uBase + index * bay);
      let h: number;
      if (local <= slopeWidth) {
        h = eave + rise * Math.min(1, local / slopeWidth);
      } else {
        h = eave + rise * Math.max(0, 1 - (local - slopeWidth) / strip);
      }
      if (h < eave) return eave;
      if (h > eave + rise) return eave + rise;
      return h;
    },
    breakLines,
    rise,
  };
}

/**
 * Structural guards shared by both envelope requests.
 *
 * Returns the cleaned single exterior ring, or `null` when the volume is not a
 * plain single-ring footprint (courtyard hole, elevated/overlapping part,
 * degenerate ring) or when any numeric request field is non-finite.
 */
function singleRingFootprint(request: VariantRoofRequest): Point2[] | null {
  if (!request || !request.rings) return null;
  if (!Number.isFinite(request.eave) || !Number.isFinite(request.rise)) return null;
  if (request.direction !== undefined && !Number.isFinite(request.direction)) return null;
  if (request.bayCount !== undefined && !Number.isFinite(request.bayCount)) return null;
  // Exactly one ring: a courtyard/atrium hole or an elevated/overlapping
  // multi-ring volume keeps its source roof; it is not retagged.
  if (request.rings.length !== 1) return null;
  const ring = sanitizeRing(request.rings[0]);
  if (ring.length < 3) return null;
  // Degeneracy guard only (collinear / zero-area rings); recipe-level
  // eligibility thresholds live in the style selector, not here.
  if (!(Math.abs(signedArea(ring)) > 1e-3)) return null;
  return ring;
}

/**
 * Mansard envelope for a footprint request.
 *
 * Enforces the structural guards (one finite ring, no holes, `rise > 0`) and
 * returns `null` - never throws - when the volume is ineligible.
 */
export function mansardEnvelope(request: VariantRoofRequest): RoofSurface | null {
  const ring = singleRingFootprint(request);
  if (!ring) return null;
  return mansardSurface(ring, ring, request.eave, request.rise, request.direction);
}

/**
 * Sawtooth envelope for a footprint request.
 *
 * Enforces the structural guards (one finite ring, no holes, finite
 * `bayCount` clamped to 3..6, `rise > 1`, long side >= 15 m) and returns
 * `null` - never throws - when the hall is ineligible. `bayCount` defaults to
 * `SAWTOOTH_DEFAULT_BAYS` (4) when omitted.
 */
export function sawtoothEnvelope(request: VariantRoofRequest): RoofSurface | null {
  const ring = singleRingFootprint(request);
  if (!ring) return null;
  const bayCount = request.bayCount === undefined ? SAWTOOTH_DEFAULT_BAYS : request.bayCount;
  return sawtoothSurface(ring, ring, request.eave, request.rise, bayCount, request.direction);
}
