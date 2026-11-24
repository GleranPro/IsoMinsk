/**
 * Crisp kerb / sidewalk edge overlay for the raster ground.
 *
 * The raster ground texture is 0.5–1 m per texel and the season mask is
 * coarser, so kerb and pavement edges sampled from it read as texel squares
 * and staircases at close zoom (even with the pixel-art post disabled).
 * This module re-emits those edges as thin flat geometry on top of the
 * ground quad: geometry edges stay crisp at every zoom and in both render
 * paths, while the texture keeps the surface colours.
 *
 * The strips are deliberately wider than the physical kerb: the mask is
 * painted at 1–2 m/texel, so the line must cover the whole hard mask edge.
 */

import { GROUND_LAYER_Y } from '../../shared/config';
import type { GroundStroke, TileData } from '../../shared/types';
import { KERB_COLOR, shadeHex } from '../../engine/materials/palette';
import type { Bounds4 } from '../environment/envLayers';
import type { GeometrySink } from '../environment/meshBuilder';
import { KERB_WIDTH_M, kerbBand } from './groundRaster';
import { offsetPolyline } from './polyline';

/** Lift above the raster ground; keeps the line out of depth fighting. */
export const GROUND_EDGE_RAISE_M = 0.02;
/** Wider than the physical kerb: covers one mask texel of hard edge. */
const KERB_EDGE_WIDTH_M = KERB_WIDTH_M + 0.4;
/** Pavement/road boundary where no kerb geometry exists. */
const OUTER_EDGE_WIDTH_M = 0.8;
const OUTER_EDGE_COLOR = shadeHex(KERB_COLOR, -0.1);

export interface GroundEdgeStats {
  kerbs: number;
  sidewalkEdges: number;
  triangles: number;
}

export function createGroundEdgeStats(): GroundEdgeStats {
  return { kerbs: 0, sidewalkEdges: 0, triangles: 0 };
}

function isValidStroke(stroke: GroundStroke | null | undefined): stroke is GroundStroke {
  if (!stroke || !Array.isArray(stroke.p) || stroke.p.length < 4) return false;
  if (!Number.isFinite(stroke.w) || stroke.w <= 0) return false;
  return stroke.p.every(Number.isFinite);
}

/** Sutherland–Hodgman clip of a convex polygon against one tile edge. */
function clipHalfPlane(points: number[], axis: 0 | 1, limit: number, keep: 1 | -1): number[] {
  const out: number[] = [];
  const count = points.length / 2;
  if (count === 0) return out;
  for (let i = 0; i < count; i++) {
    const ax = points[i * 2];
    const ay = points[i * 2 + 1];
    const j = (i + 1) % count;
    const bx = points[j * 2];
    const by = points[j * 2 + 1];
    const da = keep * ((axis === 0 ? ax : ay) - limit);
    const db = keep * ((axis === 0 ? bx : by) - limit);
    if (da >= 0) out.push(ax, ay);
    if ((da >= 0) !== (db >= 0)) {
      const t = da / (da - db);
      out.push(ax + (bx - ax) * t, ay + (by - ay) * t);
    }
  }
  return out;
}

function clipRectangle(points: number[], bounds: Bounds4): number[] {
  let poly = points;
  poly = clipHalfPlane(poly, 0, bounds[0], 1);
  if (poly.length === 0) return poly;
  poly = clipHalfPlane(poly, 0, bounds[2], -1);
  if (poly.length === 0) return poly;
  poly = clipHalfPlane(poly, 1, bounds[1], 1);
  if (poly.length === 0) return poly;
  return clipHalfPlane(poly, 1, bounds[3], -1);
}

/**
 * One continuous strip along a polyline.
 *
 * Both sides are offset polylines sharing the same miter points, so the
 * outer edge is a single smooth curve. Drawing per-segment quads (or adding
 * axis-aligned patches at joints) produced visible squares and staircases on
 * diagonal kerbs — precisely the artefact this module exists to remove.
 */
function addStrip(
  sink: GeometrySink,
  flat: number[],
  offset: number,
  width: number,
  y: number,
  color: string,
  bounds: Bounds4,
  stats: GroundEdgeStats,
): void {
  if (flat.length < 4 || !(width > 0)) return;
  const left = offsetPolyline(flat, offset + width / 2);
  const right = offsetPolyline(flat, offset - width / 2);
  const count = Math.min(left.length, right.length) / 2;
  for (let i = 0; i + 1 < count; i++) {
    const j = i + 1;
    const quad = [
      left[i * 2],
      left[i * 2 + 1],
      left[j * 2],
      left[j * 2 + 1],
      right[j * 2],
      right[j * 2 + 1],
      right[i * 2],
      right[i * 2 + 1],
    ];
    if (!quad.every(Number.isFinite)) continue;
    const clipped = clipRectangle(quad, bounds);
    if (clipped.length < 6) continue;
    for (let k = 1; k + 1 < clipped.length / 2; k++) {
      if (
        sink.addFlatTriangle(
          clipped[0],
          clipped[1],
          clipped[k * 2],
          clipped[k * 2 + 1],
          clipped[(k + 1) * 2],
          clipped[(k + 1) * 2 + 1],
          y,
          color,
        )
      ) {
        stats.triangles++;
      }
    }
  }
}

/**
 * Emit kerb casings and pavement edges for the raster ground of one tile.
 * Safe on old tiles without a ground layer (no strokes, no geometry).
 */
export function emitGroundEdges(
  sink: GeometrySink,
  tile: TileData,
  bounds: Bounds4,
  stats: GroundEdgeStats,
): void {
  const y = GROUND_LAYER_Y.base + GROUND_EDGE_RAISE_M;
  const strokes = (tile.ground?.strokes ?? []).filter(
    (stroke) => isValidStroke(stroke) && stroke.b !== 1,
  );
  for (const stroke of strokes) {
    if (stroke.k !== 'road') continue;
    const band = kerbBand(stroke);
    const kerb = stroke.kb === 1 ? KERB_WIDTH_M : 0;
    if (kerb > 0) {
      for (const side of [-1, 1]) {
        addStrip(
          sink,
          band.p,
          side * (band.w / 2 + KERB_EDGE_WIDTH_M / 2),
          KERB_EDGE_WIDTH_M,
          y,
          KERB_COLOR,
          bounds,
          stats,
        );
        stats.kerbs++;
      }
    }
    const sw = stroke.sw;
    if (!sw) {
      if (kerb === 0) {
        for (const side of [-1, 1]) {
          addStrip(
            sink,
            band.p,
            side * (band.w / 2),
            OUTER_EDGE_WIDTH_M,
            y,
            OUTER_EDGE_COLOR,
            bounds,
            stats,
          );
        }
      }
      continue;
    }
    for (const [side, value] of [[1, sw[0]], [-1, sw[1]]] as const) {
      if (!(value > 0)) continue;
      addStrip(
        sink,
        band.p,
        side * (band.w / 2 + kerb + value),
        OUTER_EDGE_WIDTH_M,
        y,
        OUTER_EDGE_COLOR,
        bounds,
        stats,
      );
      if (kerb === 0) {
        addStrip(
          sink,
          band.p,
          side * (band.w / 2),
          OUTER_EDGE_WIDTH_M,
          y,
          OUTER_EDGE_COLOR,
          bounds,
          stats,
        );
      }
      stats.sidewalkEdges++;
    }
  }
}
