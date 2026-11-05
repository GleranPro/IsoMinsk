/**
 * Raster ground compositor (payload 0.4.0).
 *
 * Paints the whole flat ground of one tile — base, landcover, water, sidewalks,
 * paths, kerbs, carriageways and rails — into one RGBA texture with the
 * cartographic painter's algorithm (the technique used by the Isometric Warsaw
 * reference):
 *
 *   base → landcover (landuse → grass → feature → water)
 *        → synthetic sidewalks (stroke w + 2·(kerb + sidewalk))
 *        → paths (track → path → steps → pedestrian → cycle)
 *        → tram track beds, tram reservations between carriageways, platforms
 *        → kerb casings of ALL roads (stroke w + 2·kerb)
 *        → asphalt fills of ALL roads, lowest rank first (stroke w)
 *        → asphalt fills of dual-carriageway gaps (payload 0.4.1)
 *        → rails / tram rails
 *        → (outside the data extent `ground.clip`: base again)
 *
 * Every road is a round-joined stroke of its centreline. Because every casing
 * is drawn before every fill, and painting a colour over the same colour is
 * idempotent, overlapping ways, multi-way junctions and twin carriageways merge
 * into one clean surface: a kerb survives only on the outer contour of the
 * union, a junction needs no polygon at all, and a data inaccuracy degrades into
 * a slightly irregular edge instead of a hole, sliver or stacked layer.
 *
 * Bridge strokes (`b: 1`) are not painted: raised decks stay geometry.
 *
 * The texel grid is anchored to world coordinates (`bounds[0] / res` is an
 * integer for every tile), so neighbouring tiles paint identical texels along
 * their shared border.
 */

import {
  ENV_PALETTE,
  KERB_COLOR,
  MARKING_COLOR,
  PAVING_COLOR,
  ROAD_PALETTE,
  SURFACE_COLORS,
  shadeHex,
  surfaceColor,
} from '../../engine/materials/palette';
import type { GroundFill, GroundStroke, Polygon, RoadClass, SurfacePolygon, TileData } from '../../shared/types';
import { surfaceTier, type Bounds4 } from '../environment/envLayers';
import { offsetPolyline } from './polyline';
import {
  bresenhamPolyline,
  hardenPaint,
  PAINT_SOLID,
  paintMarkings,
  type PaintContext2D,
  type PaintGrid,
} from './groundMarkings';

/** Kerb casing width on each side of a kerbed carriageway, metres. */
export const KERB_WIDTH_M = 0.6;

/** Colours of the stroke families (sRGB hex). */
export const GROUND_COLORS = {
  footway: ROAD_PALETTE.footway,
  pedestrian: ROAD_PALETTE.pedestrian,
  steps: shadeHex(ROAD_PALETTE.steps, -0.06),
  cycle: '#a86a5c',
  track: SURFACE_COLORS.unpaved,
  sidewalk: PAVING_COLOR,
  kerb: KERB_COLOR,
  /** Embedded/segregated tram rails: light steel, reads on asphalt and on the bed. */
  tramRail: '#b9b6ad',
  /** Tram track bed (segregated reservation, payload 0.4.1). */
  tramBed: '#7d786e',
  /** Tram stop platform and its edge (payload 0.4.1). */
  platform: shadeHex(PAVING_COLOR, 0.08),
  platformEdge: '#d9d3c3',
  railBallast: ENV_PALETTE.railBallast,
  railHead: shadeHex('#7b7367', 0.45),
  railTie: shadeHex('#7b7367', -0.3),
} as const;

/**
 * Canvas colour for a palette hex.
 *
 * The vector environment path stores vertex colours as
 * `new THREE.Color(hex).convertSRGBToLinear()` — `THREE.Color(hex)` already
 * converts sRGB → linear under colour management, so the palette is
 * effectively linearised twice, and the art direction is tuned to that look.
 * The ground texture is uploaded as sRGB (one decode on the GPU), so the canvas
 * paints the once-linearised value to land on exactly the same shading input.
 */
const canvasColorCache = new Map<string, string>();
export function canvasRgb(hex: string): [number, number, number] {
  const value = hex.replace('#', '');
  const channel = (offset: number) => {
    const c = parseInt(value.slice(offset, offset + 2), 16) / 255;
    const linear = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    return Math.max(0, Math.min(255, Math.round(linear * 255)));
  };
  return [channel(0), channel(2), channel(4)];
}

export function canvasColor(hex: string): string {
  let color = canvasColorCache.get(hex);
  if (color) return color;
  const [r, g, b] = canvasRgb(hex);
  color = `rgb(${r}, ${g}, ${b})`;
  canvasColorCache.set(hex, color);
  return color;
}

/** Markings/rail heads are only painted at or below this texel size. */
export const MARKINGS_MAX_RES_M = 1.0;

/** Minimal 2D context surface used by the compositor (testable with a mock). */
export interface GroundContext2D {
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  lineCap: CanvasLineCap;
  lineJoin: CanvasLineJoin;
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  setLineDash(segments: number[]): void;
  lineDashOffset: number;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  closePath(): void;
  fill(rule?: CanvasFillRule): void;
  stroke(): void;
  fillRect(x: number, y: number, w: number, h: number): void;
}

export interface GroundRaster {
  width: number;
  height: number;
  /** Metres per texel. */
  res: number;
  bounds: Bounds4;
  /** RGBA8, row 0 = north edge (max y). */
  data: Uint8ClampedArray;
}

export interface GroundPaintStats {
  surfaces: number;
  strokes: number;
  sidewalks: number;
  kerbs: number;
  fills: number;
  rails: number;
  medians: number;
  platforms: number;
  bridgeSkipped: number;
}

/** True when this runtime can rasterise (worker or main thread with OffscreenCanvas). */
export function groundRasterAvailable(): boolean {
  return typeof OffscreenCanvas !== 'undefined';
}

/** True when the tile carries the payload 0.4.0 ground layer. */
export function hasGroundLayer(tile: TileData | null | undefined): boolean {
  return Boolean(tile?.ground && Array.isArray(tile.ground.strokes));
}

/**
 * Rasterise the ground of one tile. Returns null when OffscreenCanvas is not
 * available (e.g. unit tests in Node) — callers then keep the vector ground.
 */
export function rasterizeGround(
  tile: TileData,
  bounds: Bounds4,
  res: number,
  options: { markings?: boolean } = {},
): GroundRaster | null {
  if (!groundRasterAvailable()) return null;
  const width = Math.max(1, Math.round((bounds[2] - bounds[0]) / res));
  const height = Math.max(1, Math.round((bounds[3] - bounds[1]) / res));
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  const crisp = res <= MARKINGS_MAX_RES_M && options.markings !== false;
  paintGround(ctx as unknown as GroundContext2D, tile, bounds, res, width, height, {
    crispRails: crisp,
  });
  if (crisp) paintCrispOverlays(ctx, tile, bounds, res, width, height);
  paintDeckShadows(ctx as unknown as GroundContext2D, tile, bounds, res);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const image = ctx.getImageData(0, 0, width, height);
  return { width, height, res, bounds, data: image.data };
}

/** Under-deck shade: bridges are geometry, the ground below them darkens. */
export const DECK_SHADOW_RGBA = 'rgba(10, 12, 18, 0.34)';

function paintDeckShadows(ctx: GroundContext2D, tile: TileData, bounds: Bounds4, res: number): void {
  const shadows = tile.ground?.shadows;
  if (!Array.isArray(shadows) || shadows.length === 0) return;
  ctx.setTransform(1 / res, 0, 0, -1 / res, -bounds[0] / res, bounds[3] / res);
  ctx.fillStyle = DECK_SHADOW_RGBA;
  for (const shadow of shadows) {
    if (!shadow || !Array.isArray(shadow.p) || shadow.p.length < 6) continue;
    traceFill(ctx, { m: 'asphalt', p: shadow.p, h: shadow.h });
    ctx.fill('evenodd');
  }
  maskOutsideClip(ctx, tile, bounds);
}

/**
 * Hard-edged overlays at marking resolution: lane paint, parking bays,
 * dividers, zebras and stop lines, then rail heads. Shared by the ground
 * texture and the bridge deck textures.
 */
export function paintCrispOverlays(
  ctx: OffscreenCanvasRenderingContext2D,
  tile: TileData,
  bounds: Bounds4,
  res: number,
  width: number,
  height: number,
): void {
  {
    const strokes = (tile.ground?.strokes ?? []).filter((s) => isValidStroke(s) && s.b !== 1);
    const grid: PaintGrid = { width, height, x0: bounds[0], y1: bounds[3], res };
    const solid = canvasRgb(MARKING_COLOR);
    const asphalt = canvasRgb(SURFACE_COLORS.asphalt);
    // Dashed paint is a 60 % mix towards the asphalt: reads as worn paint and
    // keeps multi-lane avenues from turning into a carpet of dashes.
    const dim = solid.map((c, i) => Math.round(asphalt[i] + (c - asphalt[i]) * 0.6)) as [
      number,
      number,
      number,
    ];
    // Lane paint / zebras / stop lines: hard-edged layer in the marking colour.
    overlayHardLayer(
      ctx,
      width,
      height,
      bounds,
      res,
      solid,
      (paint) => {
        paintMarkings(paint, grid, strokes, tile.junctions, tile.ground?.crossings ?? tile.crossings, {
          dividers: tile.ground?.dividers,
        });
      },
      dim,
    );
    // Rail heads above the paint: 1-texel Bresenham lines.
    overlayHardLayer(ctx, width, height, bounds, res, canvasRgb(GROUND_COLORS.tramRail), (paint) => {
      paint.setTransform(1, 0, 0, 1, 0, 0);
      const image = paint.getImageData(0, 0, width, height);
      for (const stroke of strokes) {
        if (stroke.k !== 'tram' && stroke.k !== 'rail') continue;
        for (const side of [-0.72, 0.72]) {
          bresenhamPolyline(image.data, grid, offsetPolyline(stroke.p, side), PAINT_SOLID, null, 0);
        }
      }
      paint.putImageData(image, 0, 0);
    });
    ctx.setTransform(1 / res, 0, 0, -1 / res, -bounds[0] / res, bounds[3] / res);
    maskOutsideClip(ctx as unknown as GroundContext2D, tile, bounds);
  }
}

/** Paint into a scratch layer, threshold it to a hard mask, composite on top. */
function overlayHardLayer(
  ctx: OffscreenCanvasRenderingContext2D,
  width: number,
  height: number,
  bounds: Bounds4,
  res: number,
  rgb: [number, number, number],
  draw: (paint: PaintContext2D) => void,
  dimRgb: [number, number, number] = rgb,
): void {
  const layer = new OffscreenCanvas(width, height);
  const paint = layer.getContext('2d', { willReadFrequently: true });
  if (!paint) return;
  paint.setTransform(1 / res, 0, 0, -1 / res, -bounds[0] / res, bounds[3] / res);
  draw(paint as unknown as PaintContext2D);
  paint.setTransform(1, 0, 0, 1, 0, 0);
  const image = paint.getImageData(0, 0, width, height);
  if (hardenPaint(image.data, rgb, dimRgb) === 0) return;
  paint.putImageData(image, 0, 0);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.drawImage(layer, 0, 0);
}

/** Paint all ground layers into `ctx` (world → texel transform applied here). */
export function paintGround(
  ctx: GroundContext2D,
  tile: TileData,
  bounds: Bounds4,
  res: number,
  width: number,
  height: number,
  options: {
    crispRails?: boolean;
    /** Base colour; null leaves the canvas transparent (bridge deck textures). */
    base?: string | null;
    /** Rings filled (and dilated by a texel) in `underlayColor` before the strokes. */
    underlay?: number[][];
    underlayColor?: string;
  } = {},
): GroundPaintStats {
  const stats: GroundPaintStats = {
    surfaces: 0,
    strokes: 0,
    sidewalks: 0,
    kerbs: 0,
    fills: 0,
    rails: 0,
    medians: 0,
    platforms: 0,
    bridgeSkipped: 0,
  };
  const [x0, , , y1] = bounds;

  // Pixel space: base fill.
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const base = options.base === undefined ? ENV_PALETTE.ground : options.base;
  if (base !== null) {
    ctx.fillStyle = canvasColor(base);
    ctx.fillRect(0, 0, width, height);
  }

  // World space from here on: x east, y north → texel column/row.
  ctx.setTransform(1 / res, 0, 0, -1 / res, -x0 / res, y1 / res);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.setLineDash([]);

  if (options.underlay && options.underlay.length > 0) {
    const color = canvasColor(options.underlayColor ?? GROUND_COLORS.sidewalk);
    for (const ring of options.underlay) {
      if (!Array.isArray(ring) || ring.length < 6) continue;
      ctx.beginPath();
      ctx.moveTo(ring[0], ring[1]);
      for (let i = 2; i + 1 < ring.length; i += 2) ctx.lineTo(ring[i], ring[i + 1]);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill('nonzero');
      // Dilate: mesh edges sample the outermost texels, never transparent ones.
      ctx.lineWidth = 3 * res;
      ctx.strokeStyle = color;
      ctx.stroke();
    }
  }

  paintSurfaces(ctx, tile.surfaces, stats);

  const strokes = (tile.ground?.strokes ?? []).filter((stroke) => {
    if (!isValidStroke(stroke)) return false;
    if (stroke.b === 1) {
      stats.bridgeSkipped++;
      return false;
    }
    return true;
  });
  stats.strokes = strokes.length;
  const roads = strokes.filter((stroke) => stroke.k === 'road');
  roads.sort((a, b) => a.r - b.r || a.w - b.w);
  const minLine = res;

  // 1. Synthetic sidewalks (under paths, kerbs and asphalt).
  for (const road of roads) {
    const sw = road.sw;
    if (!sw || (sw[0] <= 0 && sw[1] <= 0)) continue;
    const kerb = road.kb === 1 ? KERB_WIDTH_M : 0;
    const [left, right] = sw;
    const band = kerbBand(road);
    if (Math.abs(left - right) < 0.05) {
      strokeLine(ctx, band.p, band.w + 2 * (kerb + left), GROUND_COLORS.sidewalk);
    } else {
      // One-sided (or asymmetric) pavement: an offset stroke spanning from the
      // far carriageway edge to the outer pavement edge of each side.
      for (const [side, value] of [
        [1, left],
        [-1, right],
      ] as const) {
        if (value <= 0) continue;
        const offset = side * ((kerb + value) / 2);
        strokeLine(
          ctx,
          offsetPolyline(band.p, offset),
          band.w + kerb + value,
          GROUND_COLORS.sidewalk,
        );
      }
    }
    stats.sidewalks++;
  }

  // 2. Paths, ordered so the more specific family wins where they overlap.
  const pathOrder: GroundStroke['k'][] = ['track', 'path', 'steps', 'ped', 'cycle'];
  for (const kind of pathOrder) {
    for (const stroke of strokes) {
      if (stroke.k !== kind) continue;
      strokeLine(ctx, stroke.p, Math.max(minLine, stroke.w), pathColor(stroke));
    }
  }

  // 2b. Tram track beds, tram reservations and stop platforms. Under the kerbs
  // and carriageways: a tram embedded in the road disappears under the asphalt
  // (only its rails are drawn later), a segregated one keeps its bed and the
  // carriageway kerb separates the two.
  const fills = (tile.ground?.fills ?? []).filter(isValidFill);
  for (const stroke of strokes) {
    if (stroke.k !== 'tram') continue;
    strokeLine(ctx, stroke.p, stroke.w + TRAM_BED_EXTRA_M, GROUND_COLORS.tramBed);
  }
  for (const fill of fills) {
    if (fill.m !== 'tram') continue;
    fillRing(ctx, fill.p, GROUND_COLORS.tramBed);
    stats.medians++;
  }
  for (const fill of fills) {
    if (fill.m !== 'platform') continue;
    fillRing(ctx, fill.p, GROUND_COLORS.platform);
    ctx.lineJoin = 'miter';
    ctx.lineWidth = 0.5;
    ctx.strokeStyle = canvasColor(GROUND_COLORS.platformEdge);
    ctx.stroke();
    ctx.lineJoin = 'round';
    stats.platforms++;
  }

  // 3. Kerb casings of every kerbed road (and of the closing fills: their
  // outline survives only where the added asphalt meets ground), then 4. every
  // carriageway fill.
  for (const road of roads) {
    if (road.kb !== 1) continue;
    const band = kerbBand(road);
    strokeLine(ctx, band.p, band.w + 2 * KERB_WIDTH_M, GROUND_COLORS.kerb);
    stats.kerbs++;
  }
  for (const fill of fills) {
    if (fill.m !== 'asphalt' || fill.kb !== 1) continue;
    traceFill(ctx, fill);
    ctx.lineWidth = 2 * KERB_WIDTH_M;
    ctx.strokeStyle = canvasColor(GROUND_COLORS.kerb);
    ctx.stroke();
  }
  for (const road of roads) {
    const band = kerbBand(road);
    strokeLine(ctx, band.p, Math.max(minLine, band.w), roadColor(road));
    stats.fills++;
  }
  // 4b. Asphalt between the ribbons: dual-carriageway gaps, gores, junction
  // islands (pipeline carriageway closing).
  for (const fill of fills) {
    if (fill.m !== 'asphalt') continue;
    traceFill(ctx, fill);
    ctx.fillStyle = canvasColor(roadColor({ c: fill.c ?? 'primary' }));
    ctx.fill('evenodd');
    stats.medians++;
  }

  // 5. Rails: tram rails embedded in the asphalt, heavy rail on ballast.
  for (const stroke of strokes) {
    if (stroke.k === 'rail') {
      strokeLine(ctx, stroke.p, stroke.w, GROUND_COLORS.railBallast);
      ctx.lineCap = 'butt';
      ctx.setLineDash([0.6, 0.9]);
      // Tie phase anchored to the way's arc length: tile-clipped pieces of one
      // track must put their sleepers on the same texels at a tile border.
      ctx.lineDashOffset = Number.isFinite(stroke.s0) ? stroke.s0 : 0;
      strokeLine(ctx, stroke.p, Math.min(2.6, stroke.w * 0.8), GROUND_COLORS.railTie);
      ctx.setLineDash([]);
      ctx.lineDashOffset = 0;
      ctx.lineCap = 'round';
      if (!options.crispRails) {
        for (const side of [-0.72, 0.72]) {
          strokeLine(ctx, offsetPolyline(stroke.p, side), Math.max(minLine, 0.15), GROUND_COLORS.railHead);
        }
      }
      stats.rails++;
    } else if (stroke.k === 'tram') {
      if (!options.crispRails) {
        for (const side of [-0.72, 0.72]) {
          strokeLine(ctx, offsetPolyline(stroke.p, side), Math.max(minLine, 0.15), GROUND_COLORS.tramRail);
        }
      }
      stats.rails++;
    }
  }
  maskOutsideClip(ctx, tile, bounds);
  return stats;
}

/**
 * Kerb-to-kerb band of a carriageway: the driving lanes plus on-street parking
 * strips (`pk`, payload 0.4.1). Lane paint stays on the OSM centre line; only
 * the asphalt, kerb and pavement follow the band.
 */
export function kerbBand(road: Pick<GroundStroke, 'p' | 'w' | 'pk'>): { p: number[]; w: number } {
  const left = road.pk?.[0] ?? 0;
  const right = road.pk?.[1] ?? 0;
  if (!(left > 0) && !(right > 0)) return { p: road.p, w: road.w };
  const shift = (left - right) / 2;
  return { p: Math.abs(shift) > 1e-6 ? offsetPolyline(road.p, shift) : road.p, w: road.w + left + right };
}

/** Tram bed width beyond the rail strip (2.2 m strip → 3.4 m bed per track). */
export const TRAM_BED_EXTRA_M = 1.2;

function isValidFill(fill: GroundFill | null | undefined): fill is GroundFill {
  if (!fill || !Array.isArray(fill.p) || fill.p.length < 6) return false;
  for (const value of fill.p) if (!Number.isFinite(value)) return false;
  return true;
}

/** Path of a fill: outer ring plus its holes (`h`), for evenodd fill / stroke. */
function traceFill(ctx: GroundContext2D, fill: GroundFill): void {
  ctx.beginPath();
  for (const ring of [fill.p, ...(fill.h ?? [])]) {
    if (!Array.isArray(ring) || ring.length < 6) continue;
    ctx.moveTo(ring[0], ring[1]);
    for (let i = 2; i + 1 < ring.length; i += 2) ctx.lineTo(ring[i], ring[i + 1]);
    ctx.closePath();
  }
}

function fillRing(ctx: GroundContext2D, flat: number[], color: string): void {
  ctx.beginPath();
  ctx.moveTo(flat[0], flat[1]);
  for (let i = 2; i + 1 < flat.length; i += 2) ctx.lineTo(flat[i], flat[i + 1]);
  ctx.closePath();
  ctx.fillStyle = canvasColor(color);
  ctx.fill('nonzero');
}

/**
 * Repaint the base colour outside the data extent: ways are cut at the area
 * border, and their round caps / sidewalks would otherwise end as "lollipops"
 * (Bogdanovicha × Yanki Kupaly sits 17 m inside the pilot border).
 */
function maskOutsideClip(ctx: GroundContext2D, tile: TileData, bounds: Bounds4): void {
  const clip = tile.ground?.clip;
  if (!Array.isArray(clip) || clip.length !== 4 || !clip.every(Number.isFinite)) return;
  const [cx0, cy0, cx1, cy1] = clip;
  const [bx0, by0, bx1, by1] = bounds;
  if (cx0 <= bx0 && cy0 <= by0 && cx1 >= bx1 && cy1 >= by1) return;
  ctx.fillStyle = canvasColor(ENV_PALETTE.ground);
  const pad = 1;
  if (cx0 > bx0) ctx.fillRect(bx0 - pad, by0 - pad, cx0 - bx0 + pad, by1 - by0 + 2 * pad);
  if (cx1 < bx1) ctx.fillRect(cx1, by0 - pad, bx1 - cx1 + pad, by1 - by0 + 2 * pad);
  if (cy0 > by0) ctx.fillRect(bx0 - pad, by0 - pad, bx1 - bx0 + 2 * pad, cy0 - by0 + pad);
  if (cy1 < by1) ctx.fillRect(bx0 - pad, cy1, bx1 - bx0 + 2 * pad, by1 - cy1 + pad);
}

function isValidStroke(stroke: GroundStroke | null | undefined): stroke is GroundStroke {
  if (!stroke || !Array.isArray(stroke.p) || stroke.p.length < 4) return false;
  if (!Number.isFinite(stroke.w) || stroke.w <= 0) return false;
  for (const value of stroke.p) if (!Number.isFinite(value)) return false;
  return true;
}

/**
 * Every carriageway class shares one asphalt tone: a junction is one surface in
 * reality, and per-class shades turned dense multi-way junctions (Bogdanovicha
 * × Yanki Kupaly: 20 short primary/secondary/link ways) into a patchwork of
 * 1–3-level steps. Only service aisles and living streets stay lighter.
 */
const LIGHT_ROAD_CLASSES: ReadonlySet<RoadClass> = new Set<RoadClass>(['service', 'living_street']);
export function roadColor(stroke: Pick<GroundStroke, 'c' | 'mat'>): string {
  if (stroke.mat && stroke.mat !== 'asphalt') return SURFACE_COLORS[stroke.mat];
  if (LIGHT_ROAD_CLASSES.has(stroke.c)) return ROAD_PALETTE[stroke.c];
  return ROAD_PALETTE.primary;
}

export function pathColor(stroke: Pick<GroundStroke, 'k' | 'mat'>): string {
  switch (stroke.k) {
    case 'cycle':
      return GROUND_COLORS.cycle;
    case 'ped':
      return GROUND_COLORS.pedestrian;
    case 'steps':
      return GROUND_COLORS.steps;
    case 'track':
      return GROUND_COLORS.track;
    default:
      return stroke.mat === 'unpaved' ? GROUND_COLORS.track : GROUND_COLORS.footway;
  }
}

function strokeLine(ctx: GroundContext2D, flat: number[], width: number, color: string): void {
  if (flat.length < 4 || !(width > 0)) return;
  ctx.beginPath();
  ctx.moveTo(flat[0], flat[1]);
  for (let i = 2; i + 1 < flat.length; i += 2) ctx.lineTo(flat[i], flat[i + 1]);
  ctx.lineWidth = width;
  ctx.strokeStyle = canvasColor(color);
  ctx.stroke();
}

const TIER_ORDER = ['landuse', 'grass', 'feature', 'water'] as const;

function paintSurfaces(
  ctx: GroundContext2D,
  surfaces: SurfacePolygon[] | null | undefined,
  stats: GroundPaintStats,
): void {
  if (!Array.isArray(surfaces)) return;
  for (const tier of TIER_ORDER) {
    for (const surface of surfaces) {
      if (!surface || !Array.isArray(surface.polygon)) continue;
      if (surfaceTier(surface.kind) !== tier) continue;
      if (!tracePolygon(ctx, surface.polygon)) continue;
      ctx.fillStyle = canvasColor(surfaceColor(surface.kind));
      ctx.fill('evenodd');
      stats.surfaces++;
    }
  }
}

function tracePolygon(ctx: GroundContext2D, polygon: Polygon): boolean {
  let traced = false;
  ctx.beginPath();
  for (const ring of polygon) {
    if (!Array.isArray(ring) || ring.length < 3) continue;
    let started = false;
    for (const point of ring) {
      if (!Array.isArray(point) || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) continue;
      if (!started) {
        ctx.moveTo(point[0], point[1]);
        started = true;
      } else {
        ctx.lineTo(point[0], point[1]);
      }
    }
    if (started) {
      ctx.closePath();
      traced = true;
    }
  }
  return traced;
}

/**
 * Ground texel size for a tile. Payload tiles are 512 m (pilot) or 1024 m
 * (city); textures are capped at 1024² texels until the LOD tiers land.
 */
export function groundResolutionFor(tileSize: number, override?: number | null): number {
  if (override && Number.isFinite(override) && override > 0) return override;
  return Math.max(0.5, tileSize / 1024);
}
