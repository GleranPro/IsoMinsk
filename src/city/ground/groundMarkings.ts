/**
 * Lane paint, zebras and stop lines for the raster ground compositor.
 *
 * Paint goes into its own transparent layer which is thresholded to a hard
 * mask (no anti-aliased half-texels) and composited over the asphalt in one go:
 *
 *   lane lines: 1-texel Bresenham lines written straight into the layer pixels
 *     (solid = full paint, dashed = dimmer paint), trimmed at junctions by the
 *     `nj` arc-length intervals — the same technique as the reference renderer
 *   → erase junction faces (tile.junctions polygons): a second, independent
 *     guard, so paint can never enter a junction even if a trim is short
 *   → per crossing: erase the crossing box, paint zebra bars and stop lines
 *
 * A wrong trim or face only shortens or lengthens a line; it can never punch a
 * hole into the surface, which `groundRaster.ts` paints underneath.
 */

import type { CrossingFeature, GroundStroke, JunctionFeature, Polygon } from '../../shared/types';
import { laneMarkingLayout } from '../roads/networkMeshes';
import { offsetPolyline, polylineLength } from './polyline';

/** Only asphalt carries road paint. */
const PAINTED_MATERIALS = new Set([undefined, 'asphalt']);
/** Zebra geometry (metres): bars run along the road, stepped across it. */
const ZEBRA_BAR_M = 0.6;
const ZEBRA_STEP_M = 1.2;
const ZEBRA_EDGE_INSET_M = 0.5;
const STOP_LINE_WIDTH_M = 0.5;
const STOP_LINE_GAP_M = 1.0;
const STOP_LINE_EDGE_INSET_M = 0.4;

/** Paint values written into the red channel: solid vs dimmer dashed paint. */
export const PAINT_SOLID = 255;
export const PAINT_DASH = 128;

/** Context surface needed for the paint layer (subset of the 2D canvas API). */
export interface PaintContext2D {
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  lineCap: CanvasLineCap;
  lineJoin: CanvasLineJoin;
  globalCompositeOperation: GlobalCompositeOperation;
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  closePath(): void;
  fill(rule?: CanvasFillRule): void;
  stroke(): void;
  getImageData(x: number, y: number, w: number, h: number): ImageData;
  putImageData(image: ImageData, x: number, y: number): void;
}

/** World → texel mapping of a paint layer. */
export interface PaintGrid {
  width: number;
  height: number;
  x0: number;
  y1: number;
  res: number;
}

export interface MarkingStats {
  lines: number;
  trimmedRanges: number;
  zebras: number;
  stopLines: number;
  junctionMasks: number;
}

/** Arc-length ranges of a stroke that may carry paint (relative to p[0]). */
export function paintableRanges(
  stroke: Pick<GroundStroke, 'p' | 's0' | 'nj'>,
): Array<[number, number]> {
  const length = polylineLength(stroke.p);
  if (!(length > 0)) return [];
  const cuts: Array<[number, number]> = [];
  const nj = stroke.nj ?? [];
  const s0 = Number.isFinite(stroke.s0) ? stroke.s0 : 0;
  for (let i = 0; i + 1 < nj.length; i += 2) {
    const a = nj[i] - s0;
    const b = nj[i + 1] - s0;
    if (b <= 0 || a >= length) continue;
    cuts.push([Math.max(0, a), Math.min(length, b)]);
  }
  cuts.sort((x, y) => x[0] - y[0]);
  const ranges: Array<[number, number]> = [];
  let cursor = 0;
  for (const [a, b] of cuts) {
    if (a > cursor) ranges.push([cursor, a]);
    cursor = Math.max(cursor, b);
  }
  if (cursor < length) ranges.push([cursor, length]);
  return ranges.filter(([a, b]) => b - a > 0.5);
}

/** Sub-polyline of `flat` between arc lengths a..b. */
/** Bay pitch along the kerb: diagonal ≈ 2.5 m / sin 60°, perpendicular 2.5 m. */
export const PARKING_DIAGONAL_PITCH_M = 2.9;
export const PARKING_PERPENDICULAR_PITCH_M = 2.5;

/** Point and unit tangent at arc length `s` along a flat polyline. */
export function pointAlong(
  flat: readonly number[],
  s: number,
): { x: number; y: number; tx: number; ty: number } | null {
  let walked = 0;
  for (let i = 0; i + 3 < flat.length; i += 2) {
    const dx = flat[i + 2] - flat[i];
    const dy = flat[i + 3] - flat[i + 1];
    const length = Math.hypot(dx, dy);
    if (length < 1e-9) continue;
    if (walked + length >= s) {
      const t = Math.max(0, (s - walked) / length);
      return { x: flat[i] + dx * t, y: flat[i + 1] + dy * t, tx: dx / length, ty: dy / length };
    }
    walked += length;
  }
  return null;
}

export function slicePolyline(flat: readonly number[], a: number, b: number): number[] {
  const out: number[] = [];
  let travelled = 0;
  for (let i = 2; i + 1 < flat.length; i += 2) {
    const x0 = flat[i - 2];
    const y0 = flat[i - 1];
    const x1 = flat[i];
    const y1 = flat[i + 1];
    const seg = Math.hypot(x1 - x0, y1 - y0);
    if (seg <= 0) continue;
    const start = travelled;
    const end = travelled + seg;
    travelled = end;
    if (end < a) continue;
    if (start > b) break;
    const t0 = Math.max(0, (a - start) / seg);
    const t1 = Math.min(1, (b - start) / seg);
    if (out.length === 0) out.push(x0 + (x1 - x0) * t0, y0 + (y1 - y0) * t0);
    out.push(x0 + (x1 - x0) * t1, y0 + (y1 - y0) * t1);
  }
  return out;
}

/** True when a road stroke carries lane paint at all. */
export function isPaintedRoad(stroke: GroundStroke): boolean {
  return (
    stroke.k === 'road' &&
    stroke.b !== 1 &&
    (stroke.ln !== 1 || stroke.pl === 1) &&
    stroke.c !== 'service' &&
    stroke.c !== 'unknown' &&
    PAINTED_MATERIALS.has(stroke.mat as string | undefined)
  );
}

/**
 * Rasterise a polyline 1 texel wide (Bresenham, no anti-aliasing) into an RGBA
 * buffer. Dashes follow the arc length from `phase` with `[on, off]` metres, so
 * the dash pattern is anchored to the source way and continuous across tiles.
 */
export function bresenhamPolyline(
  data: Uint8ClampedArray,
  grid: PaintGrid,
  flat: readonly number[],
  value: number,
  dash: [number, number] | null,
  phase: number,
): number {
  let written = 0;
  const period = dash ? dash[0] + dash[1] : 0;
  let travelled = phase;
  const put = (px: number, py: number) => {
    if (px < 0 || py < 0 || px >= grid.width || py >= grid.height) return;
    if (dash && ((travelled % period) + period) % period >= dash[0]) return;
    const i = (py * grid.width + px) * 4;
    if (data[i + 3] === 255 && data[i] >= value) return;
    data[i] = value;
    data[i + 1] = value;
    data[i + 2] = value;
    data[i + 3] = 255;
    written++;
  };
  for (let k = 2; k + 1 < flat.length; k += 2) {
    let x = Math.floor((flat[k - 2] - grid.x0) / grid.res);
    let y = Math.floor((grid.y1 - flat[k - 1]) / grid.res);
    const xe = Math.floor((flat[k] - grid.x0) / grid.res);
    const ye = Math.floor((grid.y1 - flat[k + 1]) / grid.res);
    const dx = Math.abs(xe - x);
    const dy = -Math.abs(ye - y);
    const sx = x < xe ? 1 : -1;
    const sy = y < ye ? 1 : -1;
    let err = dx + dy;
    for (let guard = 0; guard < 200000; guard++) {
      put(x, y);
      if (x === xe && y === ye) break;
      const e2 = 2 * err;
      let steps = 0;
      if (e2 >= dy) {
        err += dy;
        x += sx;
        steps++;
      }
      if (e2 <= dx) {
        err += dx;
        y += sy;
        steps++;
      }
      travelled += (steps === 2 ? Math.SQRT2 : 1) * grid.res;
    }
  }
  return written;
}

export function paintMarkings(
  ctx: PaintContext2D,
  grid: PaintGrid,
  strokes: readonly GroundStroke[],
  junctions: readonly JunctionFeature[] | null | undefined,
  crossings: readonly CrossingFeature[] | null | undefined,
  extra: { dividers?: readonly number[][] | null } = {},
): MarkingStats {
  const stats: MarkingStats = {
    lines: 0,
    trimmedRanges: 0,
    zebras: 0,
    stopLines: 0,
    junctionMasks: 0,
  };
  const world = () =>
    ctx.setTransform(1 / grid.res, 0, 0, -1 / grid.res, -grid.x0 / grid.res, grid.y1 / grid.res);

  // 1. Lane lines straight into the layer pixels.
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const image = ctx.getImageData(0, 0, grid.width, grid.height);
  for (const stroke of strokes) {
    if (!isPaintedRoad(stroke)) continue;
    const layout = laneMarkingLayout({
      width: stroke.w,
      class: stroke.c,
      oneway: stroke.ow === 1,
      lanes: stroke.ow === 1 ? stroke.lf : (stroke.lf ?? 0) + (stroke.lb ?? 0),
      lanesForward: stroke.lf,
      lanesBackward: stroke.lb,
      link: stroke.ln === 1 && stroke.pl !== 1,
      roundabout: stroke.ra === 1,
      // The kerb already draws the carriageway edge at pixel scale.
    }).filter((line) => line.kind !== 'edge');
    if (layout.length === 0) continue;
    const ranges = paintableRanges(stroke);
    if (stroke.nj && stroke.nj.length) stats.trimmedRanges += ranges.length;
    for (const [a, b] of ranges) {
      const piece = slicePolyline(stroke.p, a, b);
      if (piece.length < 4) continue;
      for (const line of layout) {
        bresenhamPolyline(
          image.data,
          grid,
          offsetPolyline(piece, line.offset),
          line.dashed ? PAINT_DASH : PAINT_SOLID,
          line.dashed ? [line.length, Math.max(0.1, line.spacing - line.length)] : null,
          (stroke.s0 ?? 0) + a,
        );
        stats.lines++;
      }
    }
  }
  // On-street parking bays (payload 0.4.1): a short line across the parking
  // strip every bay, leaning ~60° for diagonal parking; parallel parking is not
  // subdivided (Minsk rarely paints it). Junction trims apply as for lanes.
  for (const stroke of strokes) {
    if (stroke.k !== 'road' || stroke.b === 1 || !stroke.pk || !stroke.po) continue;
    const ranges = paintableRanges(stroke);
    for (const [index, side] of [
      [0, 1],
      [1, -1],
    ] as const) {
      const depth = stroke.pk[index] ?? 0;
      const code = stroke.po[index] ?? 0;
      if (!(depth > 0) || (code !== 2 && code !== 3)) continue;
      const pitch = code === 2 ? PARKING_DIAGONAL_PITCH_M : PARKING_PERPENDICULAR_PITCH_M;
      const lean = code === 2 ? depth * 0.58 : 0;
      for (const [a, b] of ranges) {
        for (let s = a + pitch / 2; s <= b - pitch / 2; s += pitch) {
          const at = pointAlong(stroke.p, s);
          if (!at) continue;
          const nx = -at.ty * side;
          const ny = at.tx * side;
          const inner = stroke.w / 2;
          const outer = inner + depth;
          const line = [
            at.x + nx * inner,
            at.y + ny * inner,
            at.x + nx * outer + at.tx * lean,
            at.y + ny * outer + at.ty * lean,
          ];
          bresenhamPolyline(image.data, grid, line, PAINT_DASH, null, 0);
          stats.lines++;
        }
      }
    }
  }
  // Solid divider between the two halves of a dual carriageway (payload 0.4.1;
  // already cut out of the junction trims by the pipeline).
  for (const divider of extra.dividers ?? []) {
    if (!Array.isArray(divider) || divider.length < 4) continue;
    bresenhamPolyline(image.data, grid, divider, PAINT_SOLID, null, 0);
    stats.lines++;
  }
  ctx.putImageData(image, 0, 0);
  world();
  ctx.fillStyle = '#ffffff';

  // 2. Junction faces: no lane paint inside, whatever the trims said.
  if (Array.isArray(junctions)) {
    ctx.globalCompositeOperation = 'destination-out';
    for (const junction of junctions) {
      if (!junction || !Array.isArray(junction.polygon)) continue;
      if (tracePolygon(ctx, junction.polygon)) {
        ctx.fill('evenodd');
        stats.junctionMasks++;
      }
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  // 3. Crossings: clear, then zebra bars and stop lines.
  if (Array.isArray(crossings)) {
    for (const crossing of crossings) {
      if (!crossing || !Number.isFinite(crossing.x) || !Number.isFinite(crossing.angle)) continue;
      if (crossing.material && crossing.material !== 'asphalt') continue;
      paintCrossing(ctx, crossing, stats);
    }
  }
  ctx.globalCompositeOperation = 'source-over';
  return stats;
}

function paintCrossing(ctx: PaintContext2D, crossing: CrossingFeature, stats: MarkingStats): void {
  const width = Number.isFinite(crossing.width) && crossing.width > 0 ? crossing.width : 7;
  const span = Number.isFinite(crossing.span) && crossing.span > 0 ? crossing.span : 4;
  const ux = Math.cos(crossing.angle);
  const uy = Math.sin(crossing.angle);
  const nx = -uy;
  const ny = ux;
  const half = width / 2;
  const at = (along: number, across: number): [number, number] => [
    crossing.x + ux * along + nx * across,
    crossing.y + uy * along + ny * across,
  ];
  const rect = (a0: number, a1: number, c0: number, c1: number) => {
    const corners = [at(a0, c0), at(a1, c0), at(a1, c1), at(a0, c1)];
    ctx.beginPath();
    ctx.moveTo(corners[0][0], corners[0][1]);
    for (let i = 1; i < 4; i++) ctx.lineTo(corners[i][0], corners[i][1]);
    ctx.closePath();
    ctx.fill();
  };
  // Clear lane paint under the crossing and its stop-line apron.
  ctx.globalCompositeOperation = 'destination-out';
  rect(-span / 2 - STOP_LINE_GAP_M - STOP_LINE_WIDTH_M, span / 2 + STOP_LINE_GAP_M + STOP_LINE_WIDTH_M, -half, half);
  ctx.globalCompositeOperation = 'source-over';
  if (crossing.kind === 'zebra') {
    const usable = width - 2 * ZEBRA_EDGE_INSET_M;
    const count = Math.max(1, Math.floor((usable + (ZEBRA_STEP_M - ZEBRA_BAR_M)) / ZEBRA_STEP_M));
    const start = -((count - 1) * ZEBRA_STEP_M) / 2;
    for (let i = 0; i < count; i++) {
      const c = start + i * ZEBRA_STEP_M;
      rect(-span / 2, span / 2, c - ZEBRA_BAR_M / 2, c + ZEBRA_BAR_M / 2);
    }
    stats.zebras++;
  }
  // Stop lines on two-way carriageways (the approach side is known there).
  if ((crossing.kind === 'zebra' || crossing.kind === 'signals') && crossing.oneway !== true) {
    const d = span / 2 + STOP_LINE_GAP_M;
    // Traffic along +u drives on the -n half and stops before the crossing.
    rect(-d - STOP_LINE_WIDTH_M, -d, -half + STOP_LINE_EDGE_INSET_M, 0);
    rect(d, d + STOP_LINE_WIDTH_M, 0, half - STOP_LINE_EDGE_INSET_M);
    stats.stopLines += 2;
  }
}

function tracePolygon(ctx: PaintContext2D, polygon: Polygon): boolean {
  let traced = false;
  ctx.beginPath();
  for (const ring of polygon) {
    if (!Array.isArray(ring) || ring.length < 3) continue;
    ctx.moveTo(ring[0][0], ring[0][1]);
    for (let i = 1; i < ring.length; i++) ctx.lineTo(ring[i][0], ring[i][1]);
    ctx.closePath();
    traced = true;
  }
  return traced;
}

/**
 * Threshold an RGBA paint layer to a hard mask: texels with alpha ≥ 100 become
 * opaque paint (`rgb` for solid paint, `dimRgb` for dashed paint), the rest
 * transparent. Returns the number of painted texels.
 */
export function hardenPaint(
  data: Uint8ClampedArray,
  rgb: readonly [number, number, number],
  dimRgb: readonly [number, number, number] = rgb,
): number {
  let painted = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 100) {
      data[i + 3] = 0;
      continue;
    }
    const colour = data[i] > 190 ? rgb : dimRgb;
    data[i] = colour[0];
    data[i + 1] = colour[1];
    data[i + 2] = colour[2];
    data[i + 3] = 255;
    painted++;
  }
  return painted;
}
