/**
 * Crossings: zebra bars, stop lines and signal heads.
 *
 * The pipeline projects every OSM pedestrian crossing / signal node onto the
 * crossed carriageway and stores `TileData.crossings` (point on the road,
 * road direction, carriageway width, kind). This module lays the paint out
 * across that carriageway, clipped to the actual road polygon found at the
 * point, so crossings follow the real street instead of a guessed rectangle.
 *
 * The zebra bars run parallel to the road axis (the pedestrian walks across
 * them), are 0.5 m thick with 0.5 m gaps and ~4 m long along the road.
 * Signalised crossings additionally get stop lines and one signal head per
 * crossing (a stylised pole + head, ~18 triangles).
 */

import type { CrossingFeature, RoadPolygon } from '../../shared/types';
import { ROAD_WIDTH_M } from '../../engine/materials/palette';
import { ENV_LAYER_Y } from '../environment/envLayers';
import type { GeometrySink, Vec3 } from '../environment/meshBuilder';
import type { PreparedPolygon } from '../environment/triangulate';
import { pointInPreparedPolygon } from './roadAnalysis';
import type { MarkingBar } from './markingLayout';
import { MARKING_BAR_COLOR, MARKING_BAR_DIM_COLOR } from './roadColors';

/** A road polygon prepared once per tile and reused by markings/crossings. */
export interface RoadSurfaceRef {
  road: RoadPolygon;
  prepared: PreparedPolygon;
  /** Effective carriageway width, metres. */
  width: number;
  /** Local-metre bounds of the carriageway polygon. */
  bbox: [number, number, number, number];
}

export interface CrossingStats {
  /** Crossings that found their road polygon. */
  matched: number;
  /** Crossings without a usable road polygon (footway nodes, cut by tiles). */
  skipped: number;
  zebraBars: number;
  stopLines: number;
  signalPoles: number;
  triangles: number;
}

export function createCrossingStats(): CrossingStats {
  return { matched: 0, skipped: 0, zebraBars: 0, stopLines: 0, signalPoles: 0, triangles: 0 };
}

/** Zebra geometry for one crossing, already clipped to the road polygon. */
export interface CrossingLayout {
  zebra: MarkingBar[];
  stopLines: MarkingBar[];
  /** Signal pole position (local metres) and the direction it faces. */
  signal: { x: number; y: number; facingX: number; facingY: number } | null;
}

const ZEBRA_BAR_WIDTH_M = 0.5;
const ZEBRA_STEP_M = 1.0;
const ZEBRA_DEFAULT_SPAN_M = 4;
const STOP_LINE_WIDTH_M = 0.45;
const STOP_LINE_GAP_M = 1.5;
/** Crossings are not painted on motorways (no at-grade crossings there). */
const NO_CROSSING_CLASSES: ReadonlySet<RoadPolygon['class']> = new Set(['motorway']);

function clamp(value: number, lo: number, hi: number): number {
  return value < lo ? lo : value > hi ? hi : value;
}

function inside(polygon: PreparedPolygon, x: number, y: number): boolean {
  return pointInPreparedPolygon(polygon, x, y);
}

/**
 * Lay out the paint for one crossing. Bars whose centre or ends fall outside
 * the carriageway polygon are dropped (this also handles tile-cut roads).
 */
export function crossingLayout(crossing: CrossingFeature, surface: RoadSurfaceRef): CrossingLayout {
  const empty: CrossingLayout = { zebra: [], stopLines: [], signal: null };
  if (!crossing || !Number.isFinite(crossing.x) || !Number.isFinite(crossing.y)) return empty;
  if (!Number.isFinite(crossing.angle)) return empty;
  if (NO_CROSSING_CLASSES.has(crossing.roadClass)) return empty;
  const width = Number.isFinite(surface.width) && surface.width > 0.5
    ? surface.width
    : (ROAD_WIDTH_M[surface.road.class] ?? 6);
  if (width < 5) return empty;

  const half = width / 2;
  const ux = Math.cos(crossing.angle);
  const uy = Math.sin(crossing.angle);
  const nx = -uy;
  const ny = ux;
  const span = clamp(
    Number.isFinite(crossing.span) && (crossing.span as number) > 0
      ? (crossing.span as number)
      : ZEBRA_DEFAULT_SPAN_M,
    2.4,
    7,
  );
  const halfLength = span / 2;

  const at = (lateral: number, along: number): [number, number] => [
    crossing.x + nx * lateral + ux * along,
    crossing.y + ny * lateral + uy * along,
  ];
  const barFits = (lateral: number): boolean => {
    const a = at(lateral, -halfLength);
    const b = at(lateral, halfLength);
    const c = at(lateral, 0);
    return inside(surface.prepared, a[0], a[1])
      && inside(surface.prepared, b[0], b[1])
      && inside(surface.prepared, c[0], c[1]);
  };

  const layout: CrossingLayout = { zebra: [], stopLines: [], signal: null };
  // A zebra is painted for marked and signalised crossings; `unmarked` stays bare.
  if (crossing.kind === 'zebra' || crossing.kind === 'signals') {
    const usableHalf = half - 0.55;
    if (usableHalf >= 2) {
      const count = Math.floor((usableHalf * 2 - ZEBRA_BAR_WIDTH_M) / ZEBRA_STEP_M) + 1;
      const first = -((count - 1) * ZEBRA_STEP_M) / 2;
      for (let i = 0; i < count; i++) {
        const lateral = first + i * ZEBRA_STEP_M;
        if (!barFits(lateral)) continue;
        const [cx, cy] = at(lateral, 0);
        layout.zebra.push({
          cx,
          cy,
          ux,
          uy,
          length: span,
          width: ZEBRA_BAR_WIDTH_M,
          tone: 'white',
        });
      }
    }
  }

  if (crossing.kind === 'signals') {
    // Stop lines: right-hand traffic. The normal n is the LEFT-hand side of the
    // travel direction, so the approaching half of each direction is -dir*n.
    const stopLength = clamp(half - 0.6, 1.2, 8);
    const stopOffset = halfLength + STOP_LINE_GAP_M;
    for (const direction of [1, -1] as const) {
      // direction = +1 travels along +u: its stop line sits before the crossing
      // and spans the right half of the carriageway (-n side).
      const along = -direction * stopOffset;
      const lateral = -direction * (stopLength / 2 + 0.3);
      const cx = crossing.x + nx * lateral + ux * along;
      const cy = crossing.y + ny * lateral + uy * along;
      const end0x = cx - nx * (stopLength / 2);
      const end0y = cy - ny * (stopLength / 2);
      const end1x = cx + nx * (stopLength / 2);
      const end1y = cy + ny * (stopLength / 2);
      if (
        inside(surface.prepared, end0x, end0y) &&
        inside(surface.prepared, end1x, end1y) &&
        inside(surface.prepared, cx, cy)
      ) {
        layout.stopLines.push({
          cx,
          cy,
          ux: nx,
          uy: ny,
          length: stopLength,
          width: STOP_LINE_WIDTH_M,
          tone: 'white',
        });
      }
    }
    // One signal head on the right-hand kerb of the +u approach.
    const poleX = crossing.x - ux * (halfLength + 2.1) - nx * (half + 0.85);
    const poleY = crossing.y - uy * (halfLength + 2.1) - ny * (half + 0.85);
    layout.signal = { x: poleX, y: poleY, facingX: -ux, facingY: -uy };
  }

  return layout;
}

/** Where the paint sits: above the lane markings layer, below rail track. */
export const CROSSING_PAINT_Y = ENV_LAYER_Y.markings + 0.006;

/**
 * Emit every crossing of the tile into the shared roads sink. Crossings whose
 * point does not land inside a road polygon of this tile are skipped (the
 * pedestrian node may sit on a footway or the road piece may be in a
 * neighbouring tile at the border).
 */
export function emitCrossings(
  sink: GeometrySink,
  crossings: CrossingFeature[] | null | undefined,
  surfaces: readonly RoadSurfaceRef[],
  stats: CrossingStats,
  maxTriangles: number,
): void {
  if (!Array.isArray(crossings) || crossings.length === 0) return;
  if (surfaces.length === 0) return;
  for (const crossing of crossings) {
    if (stats.triangles >= maxTriangles) return;
    if (!crossing || !Number.isFinite(crossing.x) || !Number.isFinite(crossing.y)) continue;
    let surface: RoadSurfaceRef | null = null;
    for (const candidate of surfaces) {
      if (candidate.road.tunnel) continue;
      const [minX, minY, maxX, maxY] = candidate.bbox;
      if (crossing.x < minX || crossing.x > maxX || crossing.y < minY || crossing.y > maxY) continue;
      if (inside(candidate.prepared, crossing.x, crossing.y)) {
        surface = candidate;
        break;
      }
    }
    if (!surface) {
      stats.skipped++;
      continue;
    }
    const layout = crossingLayout(crossing, surface);
    if (layout.zebra.length === 0 && layout.stopLines.length === 0 && !layout.signal) {
      stats.skipped++;
      continue;
    }
    stats.matched++;
    for (const bar of layout.zebra) {
      if (stats.triangles >= maxTriangles) break;
      if (addBar(sink, bar, CROSSING_PAINT_Y, MARKING_BAR_COLOR)) {
        stats.zebraBars++;
        stats.triangles += 2;
      }
    }
    for (const bar of layout.stopLines) {
      if (stats.triangles >= maxTriangles) break;
      if (addBar(sink, bar, CROSSING_PAINT_Y + 0.001, MARKING_BAR_DIM_COLOR)) {
        stats.stopLines++;
        stats.triangles += 2;
      }
    }
    if (layout.signal && stats.triangles + 18 <= maxTriangles) {
      const added = emitSignalHead(sink, layout.signal.x, layout.signal.y, layout.signal.facingX, layout.signal.facingY);
      if (added > 0) {
        stats.signalPoles++;
        stats.triangles += added;
      }
    }
  }
}

function ringBoundsOf(prepared: PreparedPolygon): [number, number, number, number] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of prepared.exterior) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}

/** Emit one painted bar as a flat quad at height `y`. */
export function addBar(sink: GeometrySink, bar: MarkingBar, y: number, color: string): boolean {
  const halfLength = bar.length / 2;
  const halfWidth = bar.width / 2;
  const px = -bar.uy;
  const py = bar.ux;
  const ax = bar.cx - bar.ux * halfLength - px * halfWidth;
  const ay = bar.cy - bar.uy * halfLength - py * halfWidth;
  const bx = bar.cx + bar.ux * halfLength - px * halfWidth;
  const by = bar.cy + bar.uy * halfLength - py * halfWidth;
  const cx = bar.cx + bar.ux * halfLength + px * halfWidth;
  const cy = bar.cy + bar.uy * halfLength + py * halfWidth;
  const dx = bar.cx - bar.ux * halfLength + px * halfWidth;
  const dy = bar.cy - bar.uy * halfLength + py * halfWidth;
  return sink.addFlatQuad([ax, ay], [bx, by], [cx, cy], [dx, dy], y, color);
}

const POLE_BASE_Y = ENV_LAYER_Y.sidewalk;
const POLE_HEIGHT_M = 3.2;
const POLE_HALF_M = 0.07;
const HEAD_HALF_ALONG_M = 0.12;
const HEAD_HALF_ACROSS_M = 0.17;
const HEAD_BOTTOM_Y = POLE_BASE_Y + 2.35;
const HEAD_TOP_Y = POLE_BASE_Y + 3.3;
const SIGNAL_POLE_COLOR = '#4a4e52';
const SIGNAL_HEAD_COLOR = '#303438';
const SIGNAL_LENS_COLORS = ['#a83a2e', '#b8873c', '#3f7a4a'] as const;

/**
 * Stylised traffic signal: a slim post plus a head with three dark lenses,
 * facing `facingX/facingY`. ~18 triangles.
 */
export function emitSignalHead(
  sink: GeometrySink,
  x: number,
  y: number,
  facingX: number,
  facingY: number,
): number {
  const before = sink.triangleCount;
  const ux = -facingX;
  const uy = -facingY; // pole-local "along the road" direction
  const nx = -uy;
  const ny = ux;
  const baseY = POLE_BASE_Y;
  const topY = baseY + POLE_HEIGHT_M;

  emitBox(sink, x, y, baseY, topY, POLE_HALF_M, POLE_HALF_M, ux, uy, nx, ny, SIGNAL_POLE_COLOR);
  const headCx = x;
  const headCy = y;
  emitBox(
    sink,
    headCx,
    headCy,
    HEAD_BOTTOM_Y,
    HEAD_TOP_Y,
    HEAD_HALF_ALONG_M,
    HEAD_HALF_ACROSS_M,
    ux,
    uy,
    nx,
    ny,
    SIGNAL_HEAD_COLOR,
  );

  // Lenses on the face that looks at oncoming traffic (facing direction).
  const faceX = facingX;
  const faceY = facingY;
  const lensOffset = HEAD_HALF_ALONG_M + 0.005;
  for (let i = 0; i < 3; i++) {
    const lensY = HEAD_TOP_Y - 0.18 - i * 0.28;
    const cxl = headCx + faceX * lensOffset;
    const cyl = headCy + faceY * lensOffset;
    const half = 0.09;
    const a: Vec3 = [cxl - nx * half, lensY - half, -(cyl - ny * half)];
    const b: Vec3 = [cxl + nx * half, lensY - half, -(cyl + ny * half)];
    const c: Vec3 = [cxl + nx * half, lensY + half, -(cyl + ny * half)];
    const d: Vec3 = [cxl - nx * half, lensY + half, -(cyl - ny * half)];
    sink.addOrientedQuad(a, b, c, d, [faceX, 0, -faceY], SIGNAL_LENS_COLORS[i]);
  }
  return sink.triangleCount - before;
}

/** Four vertical faces of an axis-aligned (in u/n) box between two heights. */
function emitBox(
  sink: GeometrySink,
  cx: number,
  cy: number,
  bottomY: number,
  topY: number,
  halfU: number,
  halfN: number,
  ux: number,
  uy: number,
  nx: number,
  ny: number,
  color: string,
): void {
  const faces: Array<{ ox: number; oy: number; wx: number; wy: number; hw: number; hh: number }> = [
    // +u face
    { ox: cx + ux * halfU, oy: cy + uy * halfU, wx: ux, wy: uy, hw: halfU, hh: halfN },
    // -u face
    { ox: cx - ux * halfU, oy: cy - uy * halfU, wx: -ux, wy: -uy, hw: halfU, hh: halfN },
    // +n face
    { ox: cx + nx * halfN, oy: cy + ny * halfN, wx: nx, wy: ny, hw: halfN, hh: halfU },
    // -n face
    { ox: cx - nx * halfN, oy: cy - ny * halfN, wx: -nx, wy: -ny, hw: halfN, hh: halfU },
  ];
  for (const face of faces) {
    // Corners along the face plane: tangent = normal rotated 90°.
    const tx = -face.wy;
    const ty = face.wx;
    const a: Vec3 = [face.ox - tx * face.hh, bottomY, -(face.oy - ty * face.hh)];
    const b: Vec3 = [face.ox + tx * face.hh, bottomY, -(face.oy + ty * face.hh)];
    const c: Vec3 = [face.ox + tx * face.hh, topY, -(face.oy + ty * face.hh)];
    const d: Vec3 = [face.ox - tx * face.hh, topY, -(face.oy - ty * face.hh)];
    sink.addOrientedQuad(a, b, c, d, [face.wx, 0, -face.wy], color);
  }
}
