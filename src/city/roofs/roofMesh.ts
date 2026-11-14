/**
 * Roof meshing.
 *
 * Strategy (see src/city/roofs/envelope.ts): triangulate the footprint ONCE and
 * clip each triangle into convex facet polygons, one per roof facet, then set
 * the vertex heights from that facet's affine height function. This guarantees
 * planar facets for arbitrary footprints and keeps the triangle count low.
 *
 * The vertical gap between the eave line (wall top) and the roof surface along
 * the footprint boundary is closed by quads whose top edge follows the height
 * function (gable end walls / shed end walls / dormer-ish facades over
 * courtyards). Flat roofs get a small FACE_KIND.trim parapet band for the
 * close-zoom pixel-art look.
 *
 * Attribute conventions:
 *  - roof faces: aUV = (local x, local y) in metres, aFace.w = ROOF_SHAPE_ID;
 *  - eave-closing walls: FACE_KIND.wall with the wall UV convention;
 *  - parapets: FACE_KIND.trim with the wall UV convention.
 */

import { FACE_KIND, ROOF_SHAPE_ID } from '../../shared/geometry';
import type { BuildingVolume, Ring, RoofShape } from '../../shared/types';
import type { MeshSink, SurfaceStyle } from '../buildings/meshSink';
import {
  boundaryNormalLocal,
  MIN_EDGE_LEN,
  type RingInfo,
} from '../buildings/walls';
import {
  minAreaRect,
  signedArea,
  triangleSignedArea,
  type Point2,
} from '../buildings/polygon2d';
import { makeSurface, roofColorFor, type BuildingStyle } from '../buildings/style';
import { triangulatePolygon, type Triangle2 } from '../buildings/triangulate';
import {
  clipHalfPlane,
  domeBasePolygon,
  gableSurface,
  hipSurface,
  polygonArea2D,
  pyramidSurface,
  skillionSurface,
  steppedDomeSurface,
  type HeightFacet,
  type RoofSurface,
} from './envelope';

/** Below this rise a sloped roof is meshed as a flat roof instead. */
const MIN_SLOPED_RISE = 0.05;
/** Minimum vertical rise worth an eave-closing quad (metres). */
const MIN_EAVE_CLOSING = 0.02;
/** Minimum plan area of an eave closing piece (m²); avoids sliver quads. */
const MIN_CLOSING_AREA = 1e-3;
/** Roof facets smaller than this are discarded (numerical noise). */
const MIN_FACET_AREA = 1e-6;
/** Upper bound on break parameters per boundary edge for eave closings. */
const MAX_EDGE_BREAKS = 40;
const EDGE_BREAK_FALLBACK_SEGMENTS = 32;

export type WarningSink = (message: string) => void;

function allPointsOf(rings: readonly RingInfo[]): Point2[] {
  const points: Point2[] = [];
  for (const ring of rings) for (const p of ring.points) points.push(p);
  return points;
}

function ringPointArea(ring: RingInfo): number {
  return Math.abs(signedArea(ring.points));
}

/** Fallback rise for sloped roofs whose roofHeight was not surveyed. */
function derivedRise(rings: readonly RingInfo[]): number {
  const rect = minAreaRect(rings[0] ? rings[0].points : []);
  const shortSide = rect ? rect.halfWidth * 2 : 6;
  const rise = 0.28 * shortSide;
  return Math.min(7, Math.max(1.5, rise));
}

/** Uniform ground colour / kind payload for roof triangles. */
function roofSurface(style: BuildingStyle, kind: number, shapeId: number, color: SurfaceStyle['color']): SurfaceStyle {
  return makeSurface(style, kind, color, shapeId);
}

/** Analytic unit normal of an affine height facet, facing up. */
function facetNormal(facet: HeightFacet): [number, number, number] {
  const nx = -facet.hx;
  const ny = 1;
  const nz = facet.hy;
  const length = Math.hypot(nx, ny, nz) || 1;
  return [nx / length, ny / length, nz / length];
}

/** Minimum area of an emitted roof triangle (m²); drops clipping slivers. */
const MIN_TRIANGLE_AREA = 1e-4;
/**
 * Vertices closer than this are welded before fan triangulation (metres).
 * Half-plane clipping can leave sub-millimetre duplicate points whose
 * geometric normal is numerically noisy; at city scale 1 mm is invisible.
 */
const POLYGON_WELD = 1e-3;

/**
 * Remove near-duplicate consecutive points left behind by half-plane clipping.
 * Without this, clipping can leave 0.1 mm slivers whose geometric normal is
 * numerically noisy.
 */
function weldPolygon(polygon: readonly Point2[]): Point2[] {
  const out: Point2[] = [];
  for (const point of polygon) {
    const last = out.length ? out[out.length - 1] : null;
    if (last && Math.abs(last[0] - point[0]) < POLYGON_WELD && Math.abs(last[1] - point[1]) < POLYGON_WELD) {
      continue;
    }
    out.push(point);
  }
  while (out.length > 2) {
    const first = out[0];
    const last = out[out.length - 1];
    if (Math.abs(first[0] - last[0]) < POLYGON_WELD && Math.abs(first[1] - last[1]) < POLYGON_WELD) {
      out.pop();
    } else {
      break;
    }
  }
  return out;
}

/** Emit one convex polygon belonging to one planar facet. */
function emitFacetPolygon(
  sink: MeshSink,
  polygon: readonly Point2[],
  facet: HeightFacet,
  normal: readonly [number, number, number],
  surface: SurfaceStyle,
): void {
  const welded = weldPolygon(polygon);
  if (welded.length < 3) return;
  const [nx, ny, nz] = normal;
  const a = welded[0];
  for (let i = 1; i + 1 < welded.length; i++) {
    const b = welded[i];
    const c = welded[i + 1];
    const signed = triangleSignedArea(a, b, c);
    if (Math.abs(signed) < MIN_TRIANGLE_AREA) continue;
    const ha = facet.hx * a[0] + facet.hy * a[1] + facet.hc;
    const hb = facet.hx * b[0] + facet.hy * b[1] + facet.hc;
    const hc = facet.hx * c[0] + facet.hy * c[1] + facet.hc;
    const ax = a[0];
    const ay = ha;
    const az = -a[1];
    const bx = b[0];
    const by = hb;
    const bz = -b[1];
    const cx = c[0];
    const cy = hc;
    const cz = -c[1];
    // A CCW triangle in local x/y maps to a triangle whose world normal has
    // +Y, so keep local CCW winding for upward faces.
    if (signed > 0) {
      sink.addTriangle(ax, ay, az, bx, by, bz, cx, cy, cz, nx, ny, nz, a[0], a[1], b[0], b[1], c[0], c[1], surface);
    } else {
      sink.addTriangle(ax, ay, az, cx, cy, cz, bx, by, bz, nx, ny, nz, a[0], a[1], c[0], c[1], b[0], b[1], surface);
    }
  }
}

/** Clip every footprint triangle by every facet region and emit the pieces. */
function emitFacetRoof(
  sink: MeshSink,
  triangles: readonly Triangle2[],
  surface: RoofSurface,
  style: BuildingStyle,
  roofColor: SurfaceStyle['color'],
  shapeId: number,
): void {
  const ridgeSurface = roofSurface(style, FACE_KIND.roofRidge, shapeId, roofColor);
  const flatSurface = roofSurface(style, FACE_KIND.roof, shapeId, roofColor);
  for (const triangle of triangles) {
    for (const facet of surface.facets) {
      let polygon: Point2[] = [triangle.a, triangle.b, triangle.c];
      for (const plane of facet.planes) {
        polygon = clipHalfPlane(polygon, plane);
        if (polygon.length < 3) break;
      }
      if (polygon.length < 3) continue;
      if (polygonArea2D(polygon) < MIN_FACET_AREA) continue;
      const surf = facet.kind === FACE_KIND.roofRidge ? ridgeSurface : flatSurface;
      emitFacetPolygon(sink, polygon, facet, facetNormal(facet), surf);
    }
  }
}

/** Flat cap at eave height (holes preserved by the triangulator). */
function emitFlatCap(
  sink: MeshSink,
  triangles: readonly Triangle2[],
  eave: number,
  style: BuildingStyle,
  roofColor: SurfaceStyle['color'],
  shapeId: number,
): void {
  const facet: HeightFacet = {
    planes: [],
    hx: 0,
    hy: 0,
    hc: eave,
    kind: FACE_KIND.roof,
  };
  const surface = roofSurface(style, FACE_KIND.roof, shapeId, roofColor);
  const normal: [number, number, number] = [0, 1, 0];
  for (const triangle of triangles) {
    emitFacetPolygon(sink, [triangle.a, triangle.b, triangle.c], facet, normal, surface);
  }
}

/**
 * Close the vertical gap between the eave line and the roof surface along the
 * footprint boundary (holes included). The boundary edge is split at the kink
 * lines of the height function so every closing quad is planar.
 */
function addEaveClosings(
  sink: MeshSink,
  rings: readonly RingInfo[],
  eave: number,
  base: number,
  surface: RoofSurface,
  style: BuildingStyle,
  uStart: number,
): void {
  const wallSurface = makeSurface(style, FACE_KIND.wall, style.baseColor, style.detailScale);
  const breakLines = surface.breakLines;
  let uCursor = uStart;

  for (const ring of rings) {
    const points = ring.points;
    const n = points.length;
    for (let i = 0; i < n; i++) {
      const p0 = points[i];
      const p1 = points[(i + 1) % n];
      const dx = p1[0] - p0[0];
      const dy = p1[1] - p0[1];
      const len = Math.hypot(dx, dy);
      const u0 = uCursor;
      const u1 = uCursor + len;
      uCursor = u1;
      if (len < MIN_EDGE_LEN) continue;

      const params: number[] = [0];
      for (const line of breakLines) {
        const f0 = line.a * p0[0] + line.b * p0[1] + line.c;
        const f1 = line.a * p1[0] + line.b * p1[1] + line.c;
        if ((f0 > 1e-9 && f1 < -1e-9) || (f0 < -1e-9 && f1 > 1e-9)) {
          const t = f0 / (f0 - f1);
          if (t > 1e-4 && t < 1 - 1e-4) params.push(t);
        }
      }
      params.sort((a, b) => a - b);
      const breaks: number[] = [0];
      let previous = 0;
      for (const t of params) {
        if (t > previous + 1e-4 && t < 1 - 1e-4) {
          breaks.push(t);
          previous = t;
        }
      }
      breaks.push(1);
      if (breaks.length > MAX_EDGE_BREAKS) {
        breaks.length = 0;
        for (let k = 0; k <= EDGE_BREAK_FALLBACK_SEGMENTS; k++) {
          breaks.push(k / EDGE_BREAK_FALLBACK_SEGMENTS);
        }
      }

      const [nlx, nly] = boundaryNormalLocal(ring, i);
      const nx = nlx;
      const nz = -nly;

      for (let k = 0; k + 1 < breaks.length; k++) {
        const tA = breaks[k];
        const tB = breaks[k + 1];
        const ax = p0[0] + dx * tA;
        const ay = p0[1] + dy * tA;
        const bx = p0[0] + dx * tB;
        const by = p0[1] + dy * tB;
        const rawA = surface.heightAt(ax, ay);
        const rawB = surface.heightAt(bx, by);
        // Snap heights within a millimetre of the eave: this turns the "half
        // quad" at a gable/shed end into an exact triangle and avoids emitting
        // zero-area slivers after float32 quantisation.
        const hA = rawA - eave < 1e-3 ? eave : rawA;
        const hB = rawB - eave < 1e-3 ? eave : rawB;
        const rise = Math.max(hA, hB) - eave;
        if (rise < MIN_EAVE_CLOSING) continue;
        // Skip tiny closing slivers (sub-cm²) on very detailed footprints: they
        // are visually irrelevant and quantise badly in float32.
        if (len * rise < 2 * MIN_CLOSING_AREA) continue;
        const vA = eave - base;
        const vB = hA - base;
        const vC = hB - base;
        sink.addQuad(
          ax,
          eave,
          -ay,
          bx,
          eave,
          -by,
          bx,
          hB,
          -by,
          ax,
          hA,
          -ay,
          u0 + len * tA,
          vA,
          u0 + len * tB,
          vA,
          u0 + len * tB,
          vC,
          u0 + len * tA,
          vB,
          nx,
          0,
          nz,
          wallSurface,
        );
      }
    }
  }
}

/**
 * Small parapet band around a flat roof (FACE_KIND.trim).
 *
 * parapetTop lets the caller keep the declared total height: the wall eave is
 * lowered by the parapet height and the trim band occupies that last slice of
 * the source envelope instead of adding mass above the mapped maximum.
 */
function addParapet(
  sink: MeshSink,
  rings: readonly RingInfo[],
  eave: number,
  base: number,
  style: BuildingStyle,
  uStart: number,
  parapetTop?: number,
): void {
  const surface = makeSurface(style, FACE_KIND.trim, style.trimColor, style.detailScale);
  const requested = Number.isFinite(parapetTop) ? Math.min(parapetTop as number, eave + style.parapetHeight) : eave + style.parapetHeight;
  const top = Math.max(eave + 0.05, requested);
  if (top - eave < 0.02) return;
  let uCursor = uStart;
  for (const ring of rings) {
    const points = ring.points;
    const n = points.length;
    for (let i = 0; i < n; i++) {
      const p0 = points[i];
      const p1 = points[(i + 1) % n];
      const dx = p1[0] - p0[0];
      const dy = p1[1] - p0[1];
      const len = Math.hypot(dx, dy);
      const u0 = uCursor;
      const u1 = uCursor + len;
      uCursor = u1;
      if (len < MIN_EDGE_LEN) continue;
      const [nlx, nly] = boundaryNormalLocal(ring, i);
      sink.addQuad(
        p0[0],
        eave,
        -p0[1],
        p1[0],
        eave,
        -p1[1],
        p1[0],
        top,
        -p1[1],
        p0[0],
        top,
        -p0[1],
        u0,
        eave - base,
        u1,
        eave - base,
        u1,
        top - base,
        u0,
        top - base,
        nlx,
        0,
        -nly,
        surface,
      );
    }
  }
}

/** Flat roof + parapet; also the fallback for complex/unsupported shapes. */
function addFlatRoof(
  sink: MeshSink,
  rings: readonly RingInfo[],
  eave: number,
  base: number,
  style: BuildingStyle,
  uStart: number,
  warn: WarningSink,
  parapetTop?: number,
): void {
  const polygon = rings.map((ring) => ring.points);
  const triangulation = triangulatePolygon(polygon);
  if (triangulation.usedFallback) warn('triangulation fallback used for flat roof cap (holes may be filled)');
  if (!triangulation.triangles.length) {
    warn('flat roof cap triangulation produced no triangles');
    return;
  }
  const color = roofColorFor('flat', style.seed);
  emitFlatCap(sink, triangulation.triangles, eave, style, color, ROOF_SHAPE_ID.flat);
  if (style.detail) addParapet(sink, rings, eave, base, style, uStart, parapetTop);
}

/**
 * Skirted dome: a stepped dome over a convex base (octagon or decimated hull)
 * that fits strictly inside the footprint, with a flat skirt cap covering the
 * rest of the footprint at eave height. Returns false when no suitable base
 * exists (caller then uses a hull envelope dome with eave closings).
 */
function addSkirtedDome(
  sink: MeshSink,
  rings: readonly RingInfo[],
  eave: number,
  style: BuildingStyle,
  rise: number,
): boolean {
  const polygon: Point2[][] = rings.map((ring) => ring.points);
  const domeBase = domeBasePolygon(polygon);
  if (!domeBase) return false;

  const ringHoleAreas = rings.slice(1).reduce((sum, ring) => sum + ringPointArea(ring), 0);
  const exteriorArea = ringPointArea(rings[0]);
  const baseArea = Math.abs(signedArea(domeBase));
  const expectedSkirt = exteriorArea - ringHoleAreas - baseArea;
  if (!(baseArea > 1) || !(expectedSkirt > 0.5)) return false;

  const skirt: Ring[] = polygon.slice();
  skirt.push(domeBase);
  const skirtTriangles = triangulatePolygon(skirt);
  if (
    skirtTriangles.usedFallback ||
    !skirtTriangles.triangles.length ||
    Math.abs(skirtTriangles.area - expectedSkirt) > Math.max(1e-3, expectedSkirt * 0.02)
  ) {
    return false;
  }

  const domeTriangles = triangulatePolygon([domeBase]);
  const surface = steppedDomeSurface(domeBase, eave, rise);
  if (!surface || !domeTriangles.triangles.length) return false;

  // Everything validated: emit the flat skirt (flat roof family) and the dome.
  emitFlatCap(
    sink,
    skirtTriangles.triangles,
    eave,
    style,
    roofColorFor('flat', style.seed),
    ROOF_SHAPE_ID.flat,
  );
  emitFacetRoof(
    sink,
    domeTriangles.triangles,
    surface,
    style,
    roofColorFor('dome', style.seed),
    ROOF_SHAPE_ID.dome,
  );
  return true;
}

/**
 * Add the roof of one volume. Never throws for sane input; unsupported shapes
 * degrade to a flat roof and record a warning.
 */
export interface RoofOptions {
  /**
   * Absolute top of a flat-roof parapet. When provided, the parapet band is
   * emitted between the (already lowered) eave and this top, so decorative
   * trim never exceeds the declared source height.
   */
  readonly parapetTop?: number;
}

export function addRoof(
  sink: MeshSink,
  volume: BuildingVolume,
  rings: readonly RingInfo[],
  style: BuildingStyle,
  uStart: number,
  warn: WarningSink,
  options: RoofOptions = {},
): void {
  if (!rings.length) return;
  const eave = volume.height;
  const base = volume.minHeight;
  const declaredShape: RoofShape = volume.roofShape;
  let shape: RoofShape = declaredShape;

  if (declaredShape === 'complex') {
    warn('roof shape "complex" is not meshed: rendered as a flat roof');
    shape = 'flat';
  } else if (!(declaredShape in ROOF_SHAPE_ID)) {
    warn(`unsupported roof shape "${String(declaredShape)}": rendered as a flat roof`);
    shape = 'flat';
  }

  const polygon: Point2[][] = rings.map((ring) => ring.points);
  const exterior = polygon[0];
  const allPoints = allPointsOf(rings);

  if (shape === 'flat') {
    addFlatRoof(sink, rings, eave, base, style, uStart, warn, options.parapetTop);
    return;
  }

  let rise = volume.roofHeight;
  if (!Number.isFinite(rise) || rise <= 0.02) {
    rise = derivedRise(rings);
    warn(
      `sloped ${shape} roof without a usable roofHeight: derived fallback rise ${rise.toFixed(
        2,
      )} m (not surveyed data)`,
    );
  } else {
    rise = Math.min(40, Math.max(0.05, rise));
  }

  if (shape === 'dome') {
    if (addSkirtedDome(sink, rings, eave, style, rise)) return;
    const hullSurface = steppedDomeSurface(allPoints, eave, rise);
    if (!hullSurface) {
      warn('dome roof could not be built: rendered as a flat roof');
      addFlatRoof(sink, rings, eave, base, style, uStart, warn, options.parapetTop);
      return;
    }
    const hullTriangles = triangulatePolygon(polygon);
    if (!hullTriangles.triangles.length) {
      warn('dome roof footprint triangulation failed: rendered as a flat roof');
      addFlatRoof(sink, rings, eave, base, style, uStart, warn, options.parapetTop);
      return;
    }
    emitFacetRoof(
      sink,
      hullTriangles.triangles,
      hullSurface,
      style,
      roofColorFor('dome', style.seed),
      ROOF_SHAPE_ID.dome,
    );
    addEaveClosings(sink, rings, eave, base, hullSurface, style, uStart);
    return;
  }

  if (rise < MIN_SLOPED_RISE) {
    warn(`sloped ${shape} roof rise below ${MIN_SLOPED_RISE} m: rendered as a flat roof`);
    addFlatRoof(sink, rings, eave, base, style, uStart, warn, options.parapetTop);
    return;
  }

  const direction =
    volume.roofDirection !== undefined && Number.isFinite(volume.roofDirection)
      ? volume.roofDirection
      : undefined;

  let surface: RoofSurface | null = null;
  switch (shape) {
    case 'gabled':
      surface = gableSurface(exterior, allPoints, eave, rise, direction);
      break;
    case 'hipped':
      surface = hipSurface(exterior, allPoints, eave, rise);
      break;
    case 'pyramidal':
      surface = pyramidSurface(exterior, allPoints, eave, rise);
      break;
    case 'skillion':
      surface = skillionSurface(exterior, allPoints, eave, rise, direction);
      break;
    default:
      surface = null;
      break;
  }

  if (!surface) {
    warn(`could not build a ${shape} roof envelope: rendered as a flat roof`);
    addFlatRoof(sink, rings, eave, base, style, uStart, warn, options.parapetTop);
    return;
  }

  const triangulation = triangulatePolygon(polygon);
  if (triangulation.usedFallback) {
    warn(`triangulation fallback used for ${shape} roof (courtyard holes may be filled)`);
  }
  if (!triangulation.triangles.length) {
    warn(`footprint triangulation failed for ${shape} roof: rendered as a flat roof`);
    addFlatRoof(sink, rings, eave, base, style, uStart, warn, options.parapetTop);
    return;
  }

  emitFacetRoof(sink, triangulation.triangles, surface, style, roofColorFor(shape, style.seed), ROOF_SHAPE_ID[shape]);
  addEaveClosings(sink, rings, eave, base, surface, style, uStart);
}
