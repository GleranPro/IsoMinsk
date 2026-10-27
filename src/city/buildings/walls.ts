/**
 * Wall generation for one building volume.
 *
 * A volume is an extruded footprint (exterior ring + optional courtyard holes)
 * between `minHeight` and `height`. Walls are emitted as one quad per footprint
 * edge and vertical band, so no gaps can appear at corners. Hole rings get
 * inward-facing normals (towards the courtyard), exterior rings outward ones.
 *
 * aUV: u = accumulated distance along the ring in metres (continuous around
 * the ring, so window bays stay aligned across corners); v = height above the
 * volume's `minHeight` in metres.
 */

import { FACE_KIND, STYLE_FLAG } from '../../shared/geometry';
import type { BuildingVolume } from '../../shared/types';
import type { MeshSink, SurfaceStyle } from './meshSink';
import { cleanRing, signedArea, type Point2 } from './polygon2d';
import { makeSurface, type BuildingStyle } from './style';

/** Volumes whose bottom is at (or near) street level get a ground-floor band. */
export const STREET_LEVEL_EPS = 0.5;
export const MIN_EDGE_LEN = 1e-4;

export interface RingInfo {
  /** Cleaned ring points (no duplicate closing point). */
  points: Point2[];
  /** True for courtyard / atrium holes (every ring after the first). */
  isHole: boolean;
  /** Signed area in local metres (positive = CCW). */
  area: number;
  /** True when the stored winding is counter-clockwise in local metres. */
  ccw: boolean;
}

/**
 * Clean and classify footprint rings. Returns [] when the polygon is unusable
 * (missing/violent exterior ring).
 */
export function boundaryRings(volume: BuildingVolume): RingInfo[] {
  const footprint = volume.footprint;
  const rings: RingInfo[] = [];
  if (!footprint || !footprint.length) return rings;
  for (let i = 0; i < footprint.length; i++) {
    const points = cleanRing(footprint[i]);
    if (points.length < 3) continue;
    const area = signedArea(points);
    if (Math.abs(area) < 1e-4) continue;
    rings.push({ points, isHole: i > 0, area, ccw: area > 0 });
  }
  if (!rings.length || rings[0].isHole) return [];
  return rings;
}

/**
 * Unit normal in local metres pointing away from the building solid for edge
 * `edge` of `ring` (outwards for exterior rings, into the courtyard for holes).
 *
 * The ring winding is the authoritative orientation (the pipeline writes
 * exterior rings CCW); flipping it for CW input keeps us robust to malformed
 * data. Volume-centre verification happens in tests via point-in-polygon.
 */
export function boundaryNormalLocal(ring: RingInfo, edge: number): [number, number] {
  const points = ring.points;
  const n = points.length;
  const p0 = points[edge];
  const p1 = points[(edge + 1) % n];
  const dx = p1[0] - p0[0];
  const dy = p1[1] - p0[1];
  const len = Math.hypot(dx, dy) || 1;
  // Right-hand normal of the walking direction: for a CCW exterior ring this
  // points out of the polygon. Hole rings reverse it (they face the courtyard).
  const rx = dy / len;
  const ry = -dx / len;
  const sign = (ring.isHole ? -1 : 1) * (ring.ccw ? 1 : -1);
  return [sign * rx, sign * ry];
}

interface WallBand {
  h0: number;
  h1: number;
  surface: SurfaceStyle;
}

/** Vertical band split of one volume (ground floor / upper walls). */
function wallBands(volume: BuildingVolume, style: BuildingStyle): WallBand[] {
  const base = volume.minHeight;
  const eave = volume.height;
  const wallSurface = (): SurfaceStyle =>
    makeSurface(style, FACE_KIND.wall, style.baseColor, style.detailScale);

  const atStreetLevel = base <= STREET_LEVEL_EPS;
  if (!style.detail || !atStreetLevel) {
    return [{ h0: base, h1: eave, surface: wallSurface() }];
  }

  const groundKind = style.flags & STYLE_FLAG.shopfront ? FACE_KIND.glass : FACE_KIND.ground;
  const groundSurface = (): SurfaceStyle =>
    makeSurface(style, groundKind, style.baseColor, style.detailScale);

  const height = eave - base;
  const groundFloor = style.groundFloorHeight;
  if (height <= groundFloor + 0.5) {
    // Single-storey (or shorter than one ground floor): the whole wall is the
    // plinth / shopfront band.
    return [{ h0: base, h1: eave, surface: groundSurface() }];
  }
  const split = base + groundFloor;
  if (split < eave - 0.35) {
    return [
      { h0: base, h1: split, surface: groundSurface() },
      { h0: split, h1: eave, surface: wallSurface() },
    ];
  }
  return [{ h0: base, h1: eave, surface: wallSurface() }];
}

/**
 * Append all walls of one volume. Returns the updated UV cursor (u metres
 * accumulated along the footprint boundary, continuous across volumes when the
 * caller keeps passing the returned value).
 */
export function addVolumeWalls(
  sink: MeshSink,
  volume: BuildingVolume,
  rings: readonly RingInfo[],
  style: BuildingStyle,
  uStart: number,
): number {
  const base = volume.minHeight;
  const eave = volume.height;
  if (!(eave - base > 0) || !rings.length) return uStart;

  const bands = wallBands(volume, style);
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
      // Local (x, y) horizontal normal -> world (x, up, -y).
      const nx = nlx;
      const nz = -nly;
      const ax = p0[0];
      const az = -p0[1];
      const bx = p1[0];
      const bz = -p1[1];

      for (const band of bands) {
        sink.addQuad(
          ax,
          band.h0,
          az,
          bx,
          band.h0,
          bz,
          bx,
          band.h1,
          bz,
          ax,
          band.h1,
          az,
          u0,
          band.h0 - base,
          u1,
          band.h0 - base,
          u1,
          band.h1 - base,
          u0,
          band.h1 - base,
          nx,
          0,
          nz,
          band.surface,
        );
      }
    }
  }
  return uCursor;
}
