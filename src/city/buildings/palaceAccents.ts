/**
 * Palace massing accents (Milestone B follow-up).
 *
 * Monumental civic ensembles (Palace of the Republic & friends) need their
 * massing read from silhouette alone: a plinth at the base, then two stacked
 * projecting trim bands at the top (cornice + attic). These are pure geometry
 * accents — the facade shader still paints the colonnade/windows.
 *
 * Bands overhang the wall (mitered outward offset) so they read at pixel scale:
 *   plinth  : base .. base+1.2 m, FACE_KIND.ground, overhang 0.12 m
 *   cornice : eave-0.9 .. eave,   FACE_KIND.trim,   overhang 0.35 m
 *   attic   : eave .. eave+0.4,   FACE_KIND.trim,   overhang 0.35 m
 * Each band emits an outer vertical face plus a top annulus face (watertight
 * ledge, no coplanar overlap with the wall).
 */

import { FACE_KIND } from '../../shared/geometry';
import type { BuildingVolume } from '../../shared/types';
import { MeshSink, type SurfaceStyle } from './meshSink';
import { boundaryNormalLocal, MIN_EDGE_LEN, type RingInfo } from './walls';
import { makeSurface, type BuildingStyle } from './style';
import type { Point2 } from './polygon2d';

export const PALACE_PLINTH_HEIGHT = 1.2;
export const PALACE_PLINTH_OVERHANG = 0.12;
export const PALACE_CORNICE_HEIGHT = 0.9;
export const PALACE_ATTIC_HEIGHT = 0.4;
export const PALACE_BAND_OVERHANG = 0.35;

interface AccentBand {
  h0: number;
  h1: number;
  overhang: number;
  surface: SurfaceStyle;
}

/**
 * Mitered outward offset of a boundary ring: every vertex moves along the
 * bisector of its two edge normals so adjacent band faces meet without gaps.
 */
export function offsetRing(ring: RingInfo, offset: number): Point2[] {
  const points = ring.points;
  const n = points.length;
  const normals: Point2[] = [];
  for (let i = 0; i < n; i++) normals.push(boundaryNormalLocal(ring, i));
  const out: Point2[] = [];
  for (let i = 0; i < n; i++) {
    const prev = normals[(i - 1 + n) % n];
    const next = normals[i];
    const sumX = prev[0] + next[0];
    const sumY = prev[1] + next[1];
    const length = Math.hypot(sumX, sumY);
    if (length > 0.2) {
      // miter direction = average normal; miter length = offset / cos(theta/2)
      const scale = (2 * offset) / (length * length);
      out.push([points[i][0] + sumX * scale, points[i][1] + sumY * scale]);
    } else {
      out.push([points[i][0] + next[0] * offset, points[i][1] + next[1] * offset]);
    }
  }
  return out;
}

/** Add plinth + cornice + attic bands to one palace volume. */
export function addPalaceAccents(
  sink: MeshSink,
  volume: BuildingVolume,
  rings: readonly RingInfo[],
  style: BuildingStyle,
): void {
  const base = volume.minHeight;
  const eave = volume.height;
  const height = eave - base;
  if (!(height >= 2.4) || !rings.length) return;

  const bands: AccentBand[] = [];
  // Plinth (ground kind -> plinth treatment in the facade shader). Elevated
  // building:part volumes get no plinth: their "base" is a rooftop, not a plinth.
  if (volume.minHeight <= 2) {
    bands.push({
      h0: base,
      h1: base + PALACE_PLINTH_HEIGHT,
      overhang: PALACE_PLINTH_OVERHANG,
      surface: makeSurface(style, FACE_KIND.ground, style.trimColor, style.detailScale),
    });
  }
  if (height >= 3.2) {
    bands.push({
      h0: eave - PALACE_CORNICE_HEIGHT,
      h1: eave,
      overhang: PALACE_BAND_OVERHANG,
      surface: makeSurface(style, FACE_KIND.trim, style.trimColor, style.detailScale),
    });
    bands.push({
      h0: eave,
      h1: eave + PALACE_ATTIC_HEIGHT,
      overhang: PALACE_BAND_OVERHANG,
      surface: makeSurface(style, FACE_KIND.trim, style.trimColor, style.detailScale),
    });
  }

  const upNormal: [number, number, number] = [0, 1, 0];
  for (const ring of rings) {
    const points = ring.points;
    const n = points.length;
    const offsetPoints = offsetRing(ring, PALACE_BAND_OVERHANG);
    const plinthPoints = offsetRing(ring, PALACE_PLINTH_OVERHANG);
    let uCursor = 0;
    for (let i = 0; i < n; i++) {
      const p0 = points[i];
      const p1 = points[(i + 1) % n];
      const len = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
      const u0 = uCursor;
      const u1 = uCursor + len;
      uCursor = u1;
      if (len < MIN_EDGE_LEN) continue;
      const [nlx, nly] = boundaryNormalLocal(ring, i);
      const nx = nlx;
      const nz = -nly;
      for (const band of bands) {
        const outer = band.overhang === PALACE_BAND_OVERHANG ? offsetPoints : plinthPoints;
        const o0 = outer[i];
        const o1 = outer[(i + 1) % n];
        const v0 = band.h0 - base;
        const v1 = band.h1 - base;
        // Outer vertical face (projecting beyond the wall).
        sink.addQuad(
          o0[0], band.h0, -o0[1],
          o1[0], band.h0, -o1[1],
          o1[0], band.h1, -o1[1],
          o0[0], band.h1, -o0[1],
          u0, v0, u1, v0, u1, v1, u0, v1,
          nx, 0, nz, band.surface,
        );
        // Top annulus (ledge) connecting the projecting face back to the wall.
        sink.addQuad(
          p0[0], band.h1, -p0[1],
          p1[0], band.h1, -p1[1],
          o1[0], band.h1, -o1[1],
          o0[0], band.h1, -o0[1],
          u0, v1, u1, v1, u1, v1, u0, v1,
          upNormal[0], upNormal[1], upNormal[2], band.surface,
        );
      }
    }
  }
}
