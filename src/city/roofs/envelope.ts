/**
 * Roof height-function envelopes.
 *
 * Roofs are described as a set of convex *facets*; a facet is
 *   - a convex region of the footprint plane, given as a list of half-planes
 *     (inside: a*x + b*y + c >= 0), and
 *   - an affine height function h(x, y) = hx*x + hy*y + hc over that region.
 *
 * Because the height function is affine on every facet, clipping the footprint
 * triangulation by the facet regions gives planar roof faces for arbitrary
 * (concave, holed) footprints — this is the "affine height-function envelope"
 * method. The union of all facet regions must cover the whole footprint; the
 * height functions are continuous across facet borders (so the roof is
 * watertight).
 *
 * The eave (wall top) is always `eave`; a `RoofSurface` also exposes
 * `heightAt(x, y)` and the kink lines of the height function, which the mesher
 * uses to split the vertical eave-to-roof gap along the footprint boundary
 * (gable end walls / shed end walls).
 */

import { FACE_KIND } from '../../shared/geometry';
import {
  convexHull,
  minAreaRect,
  pointInPolygon,
  polygonCentroid,
  type Point2,
} from '../buildings/polygon2d';

/** A half-plane; the inside of the facet is where a*x + b*y + c >= 0. */
export interface HalfPlane {
  a: number;
  b: number;
  c: number;
}

/** Planar roof facet: convex region + affine height. */
export interface HeightFacet {
  planes: HalfPlane[];
  /** h(x, y) = hx*x + hy*y + hc */
  hx: number;
  hy: number;
  hc: number;
  /** FACE_KIND.roof or FACE_KIND.roofRidge. */
  kind: number;
}

export interface RoofSurface {
  facets: HeightFacet[];
  /** Roof height at a local (x, y) point, including the eave value. */
  heightAt(x: number, y: number): number;
  /** Lines (zero sets a*x+b*y+c = 0) where the height function has a kink. */
  breakLines: HalfPlane[];
  /** Nominal rise above the eave, metres. */
  rise: number;
}

interface Affine {
  a: number;
  b: number;
  c: number;
}

const EPS = 1e-12;

/** Signed value of a half-plane at a point (>= 0 means inside). */
export function planeValue(plane: HalfPlane, x: number, y: number): number {
  return plane.a * x + plane.b * y + plane.c;
}

/**
 * Clip a convex polygon against a half-plane (Sutherland–Hodgman).
 * Returns a new array; the input polygon is not mutated.
 */
export function clipHalfPlane(polygon: readonly Point2[], plane: HalfPlane): Point2[] {
  const out: Point2[] = [];
  const n = polygon.length;
  if (n === 0) return out;
  for (let i = 0; i < n; i++) {
    const p = polygon[i];
    const q = polygon[(i + 1) % n];
    const dp = planeValue(plane, p[0], p[1]);
    const dq = planeValue(plane, q[0], q[1]);
    if (dp >= -EPS) out.push(p);
    if ((dp > EPS && dq < -EPS) || (dp < -EPS && dq > EPS)) {
      const t = dp / (dp - dq);
      out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
    }
  }
  return out;
}

/** Absolute area of a (convex) polygon. */
export function polygonArea2D(polygon: readonly Point2[]): number {
  const n = polygon.length;
  if (n < 3) return 0;
  let area = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    area += (polygon[j][0] + polygon[i][0]) * (polygon[j][1] - polygon[i][1]);
  }
  return Math.abs(area) / 2;
}

/** Affine distance-to-edge helper for a convex polygon with CCW winding. */
function edgeDistances(hull: readonly Point2[]): Affine[] {
  const n = hull.length;
  const out: Affine[] = [];
  for (let i = 0; i < n; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % n];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) continue;
    // Outward normal of a CCW convex polygon is (dy, -dx) / len.
    const ox = dy / len;
    const oy = -dx / len;
    // Inside distance: -(p - a)·outward.
    out.push({ a: -ox, b: -oy, c: ox * a[0] + oy * a[1] });
  }
  return out;
}

/** Min of a set of affine functions at (x, y). */
function minAffine(affines: readonly Affine[], x: number, y: number): number {
  let value = Infinity;
  for (let i = 0; i < affines.length; i++) {
    const affine = affines[i];
    const v = affine.a * x + affine.b * y + affine.c;
    if (v < value) value = v;
  }
  return value;
}

/**
 * Sample the maximum of min-distance-to-edge over a convex polygon. The true
 * maximum is the inradius; sampling vertices, centroid and points along the
 * centroid-vertex rays gets close enough for roof proportions.
 */
function sampleInnerRadius(hull: readonly Point2[], distances: readonly Affine[]): number {
  if (!hull.length || !distances.length) return 0;
  const centroid = polygonCentroid([hull]);
  let best = 0;
  const sample = (x: number, y: number): void => {
    const d = minAffine(distances, x, y);
    if (d > best) best = d;
  };
  for (const p of hull) {
    sample(p[0], p[1]);
    sample((p[0] + centroid[0]) / 2, (p[1] + centroid[1]) / 2);
    sample(centroid[0] + (p[0] - centroid[0]) * 0.25, centroid[1] + (p[1] - centroid[1]) * 0.25);
    sample(centroid[0] + (p[0] - centroid[0]) * 0.75, centroid[1] + (p[1] - centroid[1]) * 0.75);
  }
  sample(centroid[0], centroid[1]);
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    sample((a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
  }
  return best;
}

/** Canonicalise a line so duplicate planes can be detected cheaply. */
function lineKey(line: HalfPlane): string {
  let a = line.a;
  let b = line.b;
  let c = line.c;
  const len = Math.hypot(a, b);
  if (len < 1e-12) return '';
  a /= len;
  b /= len;
  c /= len;
  if (a < -1e-9 || (Math.abs(a) <= 1e-9 && b < 0)) {
    a = -a;
    b = -b;
    c = -c;
  }
  return `${a.toFixed(6)}|${b.toFixed(6)}|${c.toFixed(5)}`;
}

/** Extract the unique kink lines of a facet list. */
function facetBreakLines(facets: readonly HeightFacet[]): HalfPlane[] {
  const seen = new Set<string>();
  const out: HalfPlane[] = [];
  for (const facet of facets) {
    for (const plane of facet.planes) {
      const key = lineKey(plane);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(plane);
    }
  }
  return out;
}

/** Facet from a set of affine distances: region = where edge k is the minimum. */
function minOfFacets(distances: readonly Affine[], slope: number, eave: number): HeightFacet[] {
  const facets: HeightFacet[] = [];
  for (let k = 0; k < distances.length; k++) {
    const dk = distances[k];
    const planes: HalfPlane[] = [];
    for (let j = 0; j < distances.length; j++) {
      if (j === k) continue;
      const dj = distances[j];
      // d_j - d_k >= 0  (edge k is the closest one).
      planes.push({ a: dj.a - dk.a, b: dj.b - dk.b, c: dj.c - dk.c });
    }
    facets.push({
      planes,
      hx: slope * dk.a,
      hy: slope * dk.b,
      hc: eave + slope * dk.c,
      kind: FACE_KIND.roofRidge,
    });
  }
  return facets;
}

/**
 * Gabled roof: ridge line along `roofDirection` (or the principal axis of the
 * footprint) through the footprint centre; tent profile.
 */
export function gableSurface(
  exterior: readonly Point2[],
  allPoints: readonly Point2[],
  eave: number,
  rise: number,
  roofDirection?: number,
): RoofSurface | null {
  let dirX: number;
  let dirY: number;
  let ridgeX: number;
  let ridgeY: number;
  if (roofDirection !== undefined && Number.isFinite(roofDirection)) {
    dirX = Math.cos(roofDirection);
    dirY = Math.sin(roofDirection);
    const centre = polygonCentroid([exterior]);
    ridgeX = centre[0];
    ridgeY = centre[1];
  } else {
    const rect = minAreaRect(allPoints);
    if (!rect) return null;
    dirX = rect.ux;
    dirY = rect.uy;
    ridgeX = rect.cx;
    ridgeY = rect.cy;
  }
  const axisLength = Math.hypot(dirX, dirY);
  if (axisLength < 1e-9) return null;
  dirX /= axisLength;
  dirY /= axisLength;
  const px = -dirY;
  const py = dirX;
  let halfSpan = 0;
  for (const p of allPoints) {
    const s = Math.abs((p[0] - ridgeX) * px + (p[1] - ridgeY) * py);
    if (s > halfSpan) halfSpan = s;
  }
  if (!(halfSpan > 0.05) || !(rise > 0)) return null;
  const slope = rise / halfSpan;
  const cLine = -(px * ridgeX + py * ridgeY);
  const posPlane: HalfPlane = { a: px, b: py, c: cLine };
  const negPlane: HalfPlane = { a: -px, b: -py, c: -cLine };
  const facets: HeightFacet[] = [
    {
      planes: [posPlane],
      hx: -slope * px,
      hy: -slope * py,
      hc: eave + rise - slope * cLine,
      kind: FACE_KIND.roofRidge,
    },
    {
      planes: [negPlane],
      hx: slope * px,
      hy: slope * py,
      hc: eave + rise + slope * cLine,
      kind: FACE_KIND.roofRidge,
    },
  ];
  return {
    facets,
    heightAt(x: number, y: number): number {
      const distance = Math.abs((x - ridgeX) * px + (y - ridgeY) * py);
      const h = eave + rise - slope * distance;
      return h < eave ? eave : h;
    },
    breakLines: [posPlane],
    rise,
  };
}

/**
 * Hipped roof: h = eave + slope * min(distance to each side of the minimum-area
 * bounding rectangle). Reads as a proper hip roof with a ridge on elongated
 * plans and a point/ridge on compact plans.
 */
export function hipSurface(
  exterior: readonly Point2[],
  allPoints: readonly Point2[],
  eave: number,
  rise: number,
): RoofSurface | null {
  void exterior;
  const rect = minAreaRect(allPoints);
  if (!rect) return null;
  const halfLength = rect.halfLength;
  const halfWidth = rect.halfWidth;
  if (!(halfLength > 0.1) || !(halfWidth > 0.1) || !(rise > 0)) return null;
  const ux = rect.ux;
  const uy = rect.uy;
  const vx = -uy;
  const vy = ux;
  const centreU = rect.cx * ux + rect.cy * uy;
  const centreV = rect.cx * vx + rect.cy * vy;
  // Inside distance to the four rectangle sides.
  const dUplus: Affine = { a: -ux, b: -uy, c: halfLength + centreU };
  const dUminus: Affine = { a: ux, b: uy, c: halfLength - centreU };
  const dVplus: Affine = { a: -vx, b: -vy, c: halfWidth + centreV };
  const dVminus: Affine = { a: vx, b: vy, c: halfWidth - centreV };
  const distances = [dUplus, dUminus, dVplus, dVminus];
  // Short side half-width sets the ridge height (correct hip proportion).
  const slope = rise / halfWidth;
  const facets = minOfFacets(distances, slope, eave);
  const breakLines: HalfPlane[] = [];
  for (let i = 0; i < distances.length; i++) {
    for (let j = i + 1; j < distances.length; j++) {
      const di = distances[i];
      const dj = distances[j];
      breakLines.push({ a: di.a - dj.a, b: di.b - dj.b, c: di.c - dj.c });
    }
  }
  return {
    facets,
    heightAt(x: number, y: number): number {
      const d = minAffine(distances, x, y);
      const h = eave + slope * d;
      return h < eave ? eave : h;
    },
    breakLines: facetBreakLines(facets).concat(breakLines),
    rise,
  };
}

/**
 * Pyramidal roof: h = eave + slope * min distance to the convex hull boundary.
 * Compact footprints get a pyramid apex, elongated ones a short ridge.
 */
export function pyramidSurface(
  exterior: readonly Point2[],
  allPoints: readonly Point2[],
  eave: number,
  rise: number,
): RoofSurface | null {
  void exterior;
  const hull = convexHull(allPoints);
  if (hull.length < 3 || !(rise > 0)) return null;
  const distances = edgeDistances(hull);
  if (distances.length < 3) return null;
  const radius = sampleInnerRadius(hull, distances);
  if (!(radius > 0.05)) return null;
  const slope = rise / radius;
  const facets = minOfFacets(distances, slope, eave);
  return {
    facets,
    heightAt(x: number, y: number): number {
      const d = Math.max(0, minAffine(distances, x, y));
      const h = eave + slope * d;
      return h > eave + rise ? eave + rise : h;
    },
    breakLines: facetBreakLines(facets),
    rise,
  };
}

/** Longest edge direction of a ring, used as the skillion fallback slope axis. */
function longestEdgeDirection(ring: readonly Point2[]): [number, number] | null {
  let best = -1;
  let bestX = 0;
  let bestY = 0;
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    if (len > best) {
      best = len;
      bestX = dx;
      bestY = dy;
    }
  }
  if (best < 1e-6) return null;
  return [bestX / best, bestY / best];
}

/** Skillion / shed roof: single slope along `roofDirection`. */
export function skillionSurface(
  exterior: readonly Point2[],
  allPoints: readonly Point2[],
  eave: number,
  rise: number,
  roofDirection?: number,
): RoofSurface | null {
  let dirX: number;
  let dirY: number;
  if (roofDirection !== undefined && Number.isFinite(roofDirection)) {
    dirX = Math.cos(roofDirection);
    dirY = Math.sin(roofDirection);
  } else {
    const fallback = longestEdgeDirection(exterior);
    if (!fallback) return null;
    dirX = fallback[0];
    dirY = fallback[1];
  }
  let sMin = Infinity;
  let sMax = -Infinity;
  for (const p of allPoints) {
    const s = p[0] * dirX + p[1] * dirY;
    if (s < sMin) sMin = s;
    if (s > sMax) sMax = s;
  }
  const span = sMax - sMin;
  if (!(span > 0.2) || !(rise > 0)) return null;
  const slope = rise / span;
  const loPlane: HalfPlane = { a: dirX, b: dirY, c: -sMin };
  const hiPlane: HalfPlane = { a: -dirX, b: -dirY, c: sMax };
  const facets: HeightFacet[] = [
    // Below the low eave: flat strip (normally empty for real footprints).
    { planes: [{ a: -dirX, b: -dirY, c: sMin }], hx: 0, hy: 0, hc: eave, kind: FACE_KIND.roofRidge },
    // The slope itself.
    {
      planes: [loPlane, hiPlane],
      hx: slope * dirX,
      hy: slope * dirY,
      hc: eave - slope * sMin,
      kind: FACE_KIND.roofRidge,
    },
    // Above the high eave: flat top strip.
    { planes: [{ a: dirX, b: dirY, c: -sMax }], hx: 0, hy: 0, hc: eave + rise, kind: FACE_KIND.roofRidge },
  ];
  return {
    facets,
    heightAt(x: number, y: number): number {
      const t = (x * dirX + y * dirY - sMin) / span;
      const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
      return eave + rise * clamped;
    },
    breakLines: [loPlane, hiPlane],
    rise,
  };
}

const DOME_BAND_T = [0.25, 0.5, 0.75];
const DOME_BAND_F = [0.66, 0.87, 1];

/** Piecewise linear dome profile in [0,1] (quarter-circle silhouette). */
export function domeProfile(t: number): number {
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
  let lo = 0;
  let fLo = 0;
  for (let i = 0; i < DOME_BAND_T.length; i++) {
    const hi = DOME_BAND_T[i];
    const fHi = DOME_BAND_F[i];
    if (clamped <= hi) {
      const k = (clamped - lo) / (hi - lo);
      return fLo + (fHi - fLo) * k;
    }
    lo = hi;
    fLo = fHi;
  }
  return 1;
}

/**
 * Faceted stepped dome over a convex base polygon. Octagonal bases (from
 * `domeBaseOctagon`) give the classic octagonal dome silhouette; a convex hull
 * base is the robust fallback for irregular footprints.
 */
export function steppedDomeSurface(
  base: readonly Point2[],
  eave: number,
  rise: number,
): RoofSurface | null {
  const hull = convexHull(base);
  if (hull.length < 3 || !(rise > 0)) return null;
  const distances = edgeDistances(hull);
  if (distances.length < 3) return null;
  const radius = sampleInnerRadius(hull, distances);
  if (!(radius > 0.05)) return null;

  const bands: { lo: number; hi: number; fLo: number; fHi: number }[] = [];
  let previousT = 0;
  let previousF = 0;
  for (let i = 0; i < DOME_BAND_T.length; i++) {
    const lo = previousT * radius;
    const hi = DOME_BAND_T[i] * radius;
    bands.push({ lo, hi, fLo: previousF, fHi: DOME_BAND_F[i] });
    previousT = DOME_BAND_T[i];
    previousF = DOME_BAND_F[i];
  }
  // Final band: flat top plateau at the full rise (covers d >= 0.75*radius).
  bands.push({ lo: previousT * radius, hi: Infinity, fLo: 1, fHi: 1 });

  const facets: HeightFacet[] = [];
  for (let k = 0; k < distances.length; k++) {
    const dk = distances[k];
    const bisectors: HalfPlane[] = [];
    for (let j = 0; j < distances.length; j++) {
      if (j === k) continue;
      const dj = distances[j];
      bisectors.push({ a: dj.a - dk.a, b: dj.b - dk.b, c: dj.c - dk.c });
    }
    for (const band of bands) {
      const planes = bisectors.slice();
      planes.push({ a: dk.a, b: dk.b, c: dk.c - band.lo });
      if (Number.isFinite(band.hi)) {
        planes.push({ a: -dk.a, b: -dk.b, c: band.hi - dk.c });
      }
      const span = band.hi - band.lo;
      if (!Number.isFinite(span) || span <= 1e-9) {
        facets.push({ planes, hx: 0, hy: 0, hc: eave + rise, kind: FACE_KIND.roofRidge });
        continue;
      }
      const slope = (band.fHi - band.fLo) / span;
      facets.push({
        planes,
        hx: rise * slope * dk.a,
        hy: rise * slope * dk.b,
        hc: eave + rise * band.fLo + rise * slope * (dk.c - band.lo),
        // Dome facets are emitted as roofRidge so the shader can give them the
        // smooth banded treatment keyed off ROOF_SHAPE_ID.dome in aFace.w.
        kind: FACE_KIND.roofRidge,
      });
    }
  }

  const breakLines = facetBreakLines(facets);
  // Band boundaries are kinks of the global height function, not just facet
  // planes, so add them explicitly for the eave-closing splitter.
  for (const distance of distances) {
    for (const t of DOME_BAND_T) {
      breakLines.push({ a: distance.a, b: distance.b, c: distance.c - t * radius });
    }
  }

  return {
    facets,
    heightAt(x: number, y: number): number {
      const d = Math.max(0, minAffine(distances, x, y));
      return eave + rise * domeProfile(d / radius);
    },
    breakLines,
    rise,
  };
}

/** True when every vertex and edge midpoint of `candidate` is inside `rings`. */
function isStrictlyInside(
  rings: readonly (readonly Point2[])[],
  candidate: readonly Point2[],
): boolean {
  for (const point of candidate) {
    if (!Number.isFinite(point[0]) || !Number.isFinite(point[1])) return false;
    if (!pointInPolygon(rings, point[0], point[1])) return false;
  }
  for (let i = 0; i < candidate.length; i++) {
    const a = candidate[i];
    const b = candidate[(i + 1) % candidate.length];
    if (!pointInPolygon(rings, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2)) return false;
  }
  return true;
}

/** Octagonal dome base from the minimum-area rectangle (inset + chamfered). */
function octagonFromRect(rings: readonly (readonly Point2[])[]): Point2[] | null {
  if (!rings.length) return null;
  const rect = minAreaRect(rings[0]);
  if (!rect) return null;
  const shortSide = rect.halfWidth * 2;
  if (!(shortSide > 1)) return null;
  const inset = Math.min(0.4, Math.max(0.12, shortSide * 0.03));
  const halfH = rect.halfLength - inset;
  const halfW = rect.halfWidth - inset;
  if (!(halfH > 0.5) || !(halfW > 0.5)) return null;
  const cut = Math.min(halfH, halfW) * 0.2929;
  const ux = rect.ux;
  const uy = rect.uy;
  const vx = -uy;
  const vy = ux;
  const local: [number, number][] = [
    [halfH, halfW - cut],
    [halfH - cut, halfW],
    [-(halfH - cut), halfW],
    [-halfH, halfW - cut],
    [-halfH, -(halfW - cut)],
    [-(halfH - cut), -halfW],
    [halfH - cut, -halfW],
    [halfH, -(halfW - cut)],
  ];
  const points: Point2[] = local.map(([u, v]) => [
    rect.cx + ux * u + vx * v,
    rect.cy + uy * u + vy * v,
  ]);
  return isStrictlyInside(rings, points) ? points : null;
}

/**
 * Build a convex dome base that fits strictly inside the footprint.
 *
 * Preferred: an octagon derived from the minimum-area rectangle (classic
 * octagonal dome look on rectangular footprints). Otherwise: the convex hull
 * decimated to at most 8 edges and shrunk towards its centroid until it fits
 * inside the footprint. Returns null when neither works — the caller then uses
 * a hull based envelope dome with no skirt.
 */
export function domeBasePolygon(rings: readonly (readonly Point2[])[]): Point2[] | null {
  const octagon = octagonFromRect(rings);
  if (octagon) return octagon;
  if (!rings.length) return null;
  const hull = convexHull(rings[0]);
  if (hull.length < 4) return null;
  const maxEdges = 8;
  const step = Math.max(1, Math.ceil(hull.length / maxEdges));
  const picked: Point2[] = [];
  for (let i = 0; i < hull.length; i += step) picked.push(hull[i]);
  if (picked.length < 3) return null;
  const centre = polygonCentroid([picked]);
  for (let attempt = 0; attempt < 6; attempt++) {
    const scale = 0.95 - attempt * 0.08;
    if (!(scale > 0.4)) break;
    const candidate: Point2[] = picked.map((p) => [
      centre[0] + (p[0] - centre[0]) * scale,
      centre[1] + (p[1] - centre[1]) * scale,
    ]);
    if (Math.abs(signedAreaOf(candidate)) < 2) continue;
    if (isStrictlyInside(rings, candidate)) return candidate;
  }
  return null;
}

/** Local signed area helper (kept private to avoid an extra import cycle). */
function signedAreaOf(ring: readonly Point2[]): number {
  let area = 0;
  for (let i = 0; i < ring.length; i++) {
    const j = (i + 1) % ring.length;
    area += ring[i][0] * ring[j][1] - ring[j][0] * ring[i][1];
  }
  return area / 2;
}
