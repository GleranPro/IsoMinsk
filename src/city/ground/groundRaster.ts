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
import type {
  GroundFill,
  GroundStroke,
  Polygon,
  RoadClass,
  SurfaceKind,
  SurfacePolygon,
  TileData,
} from '../../shared/types';
import { surfaceTier, type Bounds4 } from '../environment/envLayers';
import { offsetPolyline } from './polyline';
import {
  hardenPaint,
  isPaintedRoad,
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

/** Road markings are only painted at or below this texel size. */
export const MARKINGS_MAX_RES_M = 1.0;
/** World-space width at EVERY ground LOD; subtexel heads retain area coverage. */
export const RAIL_HEAD_WIDTH_M = 0.15;
export const RAIL_HALF_GAUGE_M = 0.72;

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
    railHeads: false,
  });
  if (crisp) paintCrispOverlays(ctx, tile, bounds, res, width, height);
  paintRailHeads(ctx, tile, bounds, res);
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
 * dividers, zebras and stop lines. Shared by the ground
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
    /** Defer heads until after road paint in the raster/bridge compositors. */
    railHeads?: boolean;
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

  // 4c. Aerodrome surfaces (B-2): apron/helipad fills and runway/taxiway
  // strokes from `aeroway=*`; concrete is the default, tag surface can override.
  for (const fill of fills) {
    if (fill.m !== 'concrete') continue;
    fillRing(ctx, fill.p, SURFACE_COLORS.concrete);
    stats.medians++;
  }
  for (const stroke of strokes) {
    if (stroke.k !== 'aeroway') continue;
    const color = stroke.mat ? SURFACE_COLORS[stroke.mat] : SURFACE_COLORS.concrete;
    strokeLine(ctx, stroke.p, Math.max(minLine, stroke.w), color);
    stats.fills++;
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
      stats.rails++;
    } else if (stroke.k === 'tram') {
      stats.rails++;
    }
  }
  if (options.railHeads !== false) paintRailHeads(ctx, tile, bounds, res);
  else maskOutsideClip(ctx, tile, bounds);
  return stats;
}

/**
 * One palette and physical width across ground and bridge LODs. Do not harden
 * this layer or widen it to one texel: at 4 m/texel that turns two 15 cm heads
 * into a bright 5.4 m band. Canvas antialiasing preserves subtexel coverage,
 * allowing distant heads to blend into the ballast instead of changing it.
 * Heavy rail and tram retain their own palette entries at every resolution.
 */
export function paintRailHeads(ctx: GroundContext2D, tile: TileData, bounds: Bounds4, res: number): void {
  ctx.setTransform(1 / res, 0, 0, -1 / res, -bounds[0] / res, bounds[3] / res);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.setLineDash([]);
  ctx.lineDashOffset = 0;
  for (const stroke of tile.ground?.strokes ?? []) {
    if (!isValidStroke(stroke) || stroke.b === 1 || (stroke.k !== 'rail' && stroke.k !== 'tram')) continue;
    const color = stroke.k === 'rail' ? GROUND_COLORS.railHead : GROUND_COLORS.tramRail;
    for (const side of [-RAIL_HALF_GAUGE_M, RAIL_HALF_GAUGE_M]) {
      strokeLine(ctx, offsetPolyline(stroke.p, side), RAIL_HEAD_WIDTH_M, color);
    }
  }
  maskOutsideClip(ctx, tile, bounds);
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

// ---------------------------------------------------------------------------
// season mask (seasons P0–P2)
// ---------------------------------------------------------------------------

/**
 * Surface class in the blue channel of the season mask.
 *
 * 0 = asphalt/carriageway, 64 = paving (pavement, plaza), 128 = open ground
 * (grass, parks, soil), 192 = water, 255 = other. The ground shader gates
 * snow on this value: class 0 never receives snow, so "the road is cleared"
 * is a data decision, not a shader trick.
 */
export const SEASON_CLASS = {
  asphalt: 0,
  paving: 64,
  grass: 128,
  water: 192,
  other: 255,
} as const;

/** RGBA8 baked season mask of one tile; row 0 is the north edge. */
export interface SeasonMask {
  width: number;
  height: number;
  /** Metres per texel. */
  res: number;
  /** R snow depth 0–255, G leaf litter, B surface class, A wet/dirt. */
  data: Uint8ClampedArray;
}

/**
 * Landcover table: snow depth and class per landcover kind.
 *
 * Roads, pavements, kerbs, crossings and tram tracks are painted separately in
 * `paintSeasonGround` (P1). Anything not covered by a `tile.surfaces` polygon
 * stays class 0 (paved) with zero snow: the mask must never whiten a
 * carriageway or an unknown courtyard just because nobody painted it.
 */
function seasonSurface(
  kind: SurfaceKind | undefined,
): { snow: number; leaf: number; cls: number } {
  switch (kind) {
    case 'grass':
    case 'park':
    case 'forest':
    case 'scrub':
    case 'cemetery':
      // Open lawns stay clean: litter is painted under crowns and along kerbs,
      // a uniform base tint would only dither into a checkerboard.
      return { snow: 235, leaf: 0, cls: SEASON_CLASS.grass };
    case 'pitch':
    case 'sand':
      return { snow: 220, leaf: 0, cls: SEASON_CLASS.grass };
    case 'construction':
      return { snow: 160, leaf: 0, cls: SEASON_CLASS.grass };
    case 'water':
    case 'river':
      // The middle stays dark; `applyIceBanks` adds the pale shoreline ring.
      return { snow: 0, leaf: 0, cls: SEASON_CLASS.water };
    case 'plaza':
      // Plazas are ploughed/cleared; a thin depth here only produced sparse
      // snow dots that slid with the zoom.
      return { snow: 0, leaf: 0, cls: SEASON_CLASS.paving };
    case 'parking':
      return { snow: 140, leaf: 0, cls: SEASON_CLASS.paving };
    case 'residential':
    case 'industrial':
    case 'commercial':
      // Courtyard/landuse ground: a trodden but continuous cover. Depths below
      // ~110 leave bare ground through the 3-step quantiser (the dark green
      // gaps between buildings in winter).
      return { snow: 140, leaf: 0, cls: SEASON_CLASS.paving };
    case 'railway':
      return { snow: 120, leaf: 0, cls: SEASON_CLASS.asphalt };
    default:
      return { snow: 140, leaf: 0, cls: SEASON_CLASS.paving };
  }
}

/**
 * Mask texel size: twice the ground texel (1 m for 512 m tiles, 2 m for
 * 1024 m), capped from below at 0.5 m for the near LOD. 512² RGBA = 1 MB per
 * base tile; only near tiles reach 1024².
 */
export function seasonMaskResolutionFor(groundRes: number): number {
  const res = Number.isFinite(groundRes) && groundRes > 0 ? groundRes : 1;
  return Math.max(0.5, res * 2);
}

interface SeasonChannel {
  canvas: OffscreenCanvas;
  ctx: OffscreenCanvasRenderingContext2D;
}

type SeasonValueKey = 'snow' | 'leaf' | 'cls' | 'wet';

/** Values to write into the mask channels; omitted keys are left untouched. */
interface SeasonValues {
  snow?: number;
  leaf?: number;
  cls?: number;
  wet?: number;
}

const SEASON_VALUE_KEYS: readonly SeasonValueKey[] = ['snow', 'leaf', 'cls', 'wet'];

/** Berm strip outside the kerb (P1), metres. */
const SEASON_BERM_M = 0.9;
/** Gutter strip inside the kerb: a thin snow ridge in winter. */
const SEASON_GUTTER_M = 0.6;
/** Wheel-rut geometry: two lines per lane, ±0.75 m from its centre. */
const SEASON_RUT_OFFSET_M = 0.75;
const SEASON_RUT_WIDTH_M = 0.8;

function seasonChannel(width: number, height: number): SeasonChannel | null {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  return ctx ? { canvas, ctx } : null;
}

function fillSeasonChannel(channel: SeasonChannel, value: number): void {
  channel.ctx.setTransform(1, 0, 0, 1, 0, 0);
  channel.ctx.fillStyle = seasonGray(value);
  channel.ctx.fillRect(0, 0, channel.canvas.width, channel.canvas.height);
}

function seasonGray(value: number): string {
  return `rgb(${value}, ${value}, ${value})`;
}

function paintSeasonPolygon(
  ctx: OffscreenCanvasRenderingContext2D,
  polygon: Polygon,
  value: number,
): void {
  if (!tracePolygon(ctx as unknown as GroundContext2D, polygon)) return;
  ctx.fillStyle = seasonGray(value);
  ctx.fill('evenodd');
}

/** Stroke a flat polyline into every channel named in `values`. */
function seasonStroke(
  channels: SeasonChannel[],
  flat: number[],
  width: number,
  values: SeasonValues,
): void {
  if (flat.length < 4 || !(width > 0)) return;
  for (let i = 0; i < channels.length; i += 1) {
    const value = values[SEASON_VALUE_KEYS[i]];
    if (value === undefined) continue;
    const ctx = channels[i].ctx;
    ctx.beginPath();
    ctx.moveTo(flat[0], flat[1]);
    for (let p = 2; p + 1 < flat.length; p += 2) ctx.lineTo(flat[p], flat[p + 1]);
    ctx.lineWidth = width;
    ctx.strokeStyle = seasonGray(value);
    ctx.stroke();
  }
}

/** Fill a world-space circle with the named channels (tree litter, puddles). */
function seasonFillCircle(
  channels: SeasonChannel[],
  x: number,
  y: number,
  radius: number,
  values: SeasonValues,
): void {
  if (!(radius > 0) || !Number.isFinite(x) || !Number.isFinite(y)) return;
  for (let i = 0; i < channels.length; i += 1) {
    const value = values[SEASON_VALUE_KEYS[i]];
    if (value === undefined) continue;
    const ctx = channels[i].ctx;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fillStyle = seasonGray(value);
    ctx.fill();
  }
}

/** Deterministic 0..1 noise for litter dapple (no Math.random in tiles). */
function seasonTreeHash(x: number, y: number, salt: number): number {
  const n = Math.sin(Math.floor(x * 13.7) * 12.9898 + Math.floor(y * 17.3) * 78.233 + salt) * 43758.5453;
  return n - Math.floor(n);
}

/** Leaf litter under tree crowns; asphalt is excluded by the shader gate. */
function paintSeasonTreeLitter(tile: TileData, channels: SeasonChannel[]): void {
  const trees = tile.trees ?? [];
  if (trees.length === 0) return;
  const stride = Math.max(1, Math.ceil(trees.length / 4000));
  for (let i = 0; i < trees.length; i += stride) {
    const tree = trees[i];
    if (!tree || ![tree.x, tree.y, tree.radius].every(Number.isFinite)) continue;
    const h1 = seasonTreeHash(tree.x, tree.y, 1.7);
    const h2 = seasonTreeHash(tree.x, tree.y, 9.3);
    const h3 = seasonTreeHash(tree.x, tree.y, 21.1);
    const radius = Math.max(1, tree.radius * (0.8 + h1 * 0.35));
    // A ragged outer patch plus a denser core: no perfectly round litter discs.
    seasonFillCircle(
      channels,
      tree.x + (h2 - 0.5) * radius * 0.6,
      tree.y + (h3 - 0.5) * radius * 0.6,
      radius,
      { leaf: 150 + Math.round(h3 * 60) },
    );
    seasonFillCircle(channels, tree.x, tree.y, radius * 0.62, { leaf: 215 });
  }
}

/** Fill flat rings (outer + holes) with evenodd into the named channels. */
function seasonFillFlat(
  channels: SeasonChannel[],
  rings: number[][],
  values: SeasonValues,
): void {
  const valid = rings.filter((ring) => Array.isArray(ring) && ring.length >= 6);
  if (valid.length === 0) return;
  for (let i = 0; i < channels.length; i += 1) {
    const value = values[SEASON_VALUE_KEYS[i]];
    if (value === undefined) continue;
    const ctx = channels[i].ctx;
    ctx.beginPath();
    for (const ring of valid) {
      ctx.moveTo(ring[0], ring[1]);
      for (let p = 2; p + 1 < ring.length; p += 2) ctx.lineTo(ring[p], ring[p + 1]);
      ctx.closePath();
    }
    ctx.fillStyle = seasonGray(value);
    ctx.fill('evenodd');
  }
}

/** Stroke the outline of a `GroundFill` (kerb casings of closing fills). */
function seasonStrokeFill(
  channels: SeasonChannel[],
  fill: GroundFill,
  width: number,
  values: SeasonValues,
): void {
  const rings = [fill.p, ...(fill.h ?? [])].filter(
    (ring) => Array.isArray(ring) && ring.length >= 6,
  );
  if (rings.length === 0) return;
  for (let i = 0; i < channels.length; i += 1) {
    const value = values[SEASON_VALUE_KEYS[i]];
    if (value === undefined) continue;
    const ctx = channels[i].ctx;
    ctx.beginPath();
    for (const ring of rings) {
      ctx.moveTo(ring[0], ring[1]);
      for (let p = 2; p + 1 < ring.length; p += 2) ctx.lineTo(ring[p], ring[p + 1]);
      ctx.closePath();
    }
    ctx.lineWidth = width;
    ctx.strokeStyle = seasonGray(value);
    ctx.stroke();
  }
}

/** Winter snow on a raised sidewalk: cleared centre, drifted wall edge. */
function paintSeasonSidewalk(
  channels: SeasonChannel[],
  band: { p: number[]; w: number },
  kerb: number,
  value: number,
  minLine: number,
  side: -1 | 1,
): void {
  if (!(value > 0)) return;
  const centre = side * (band.w / 2 + kerb + value / 2);
  seasonStroke(channels, offsetPolyline(band.p, centre), Math.max(minLine, value * 0.5), {
    snow: 0,
    leaf: 10,
    cls: SEASON_CLASS.paving,
  });
  const edge = side * (band.w / 2 + kerb + value * 0.85);
  seasonStroke(channels, offsetPolyline(band.p, edge), Math.max(minLine, value * 0.3), {
    snow: 150,
    leaf: 90,
    cls: SEASON_CLASS.paving,
  });
}

/** Zebra / signal crossing: compacted snow, broken berm and autumn puddles. */
function paintSeasonCrossing(
  channels: SeasonChannel[],
  crossing: { x: number; y: number; angle: number; width: number; span: number },
): void {
  const width = Number.isFinite(crossing.width) && crossing.width > 0 ? crossing.width : 7;
  const span = Number.isFinite(crossing.span) && crossing.span > 0 ? crossing.span : 4;
  const ux = Math.cos(crossing.angle);
  const uy = Math.sin(crossing.angle);
  const nx = -uy;
  const ny = ux;
  // Extend across the carriageway past the kerb so the berm is broken at the
  // crossing: people and ploughs cross there, snow does not pile up.
  const half = width / 2 + KERB_WIDTH_M + 0.4;
  const at = (along: number, across: number): [number, number] => [
    crossing.x + ux * along + nx * across,
    crossing.y + uy * along + ny * across,
  ];
  const corners = [at(-span / 2, -half), at(span / 2, -half), at(span / 2, half), at(-span / 2, half)];
  seasonFillFlat(channels, [corners.flat()], {
    snow: 35,
    leaf: 0,
    cls: SEASON_CLASS.paving,
    wet: 80,
  });
  // Autumn puddles on the approach: dark, cold asphalt without reflections.
  for (const side of [-1, 1]) {
    const [px, py] = at(side * (span / 2 + 1.6), side * width * 0.28);
    seasonFillCircle(channels, px, py, 1.4, {
      snow: 0,
      leaf: 0,
      cls: SEASON_CLASS.asphalt,
      wet: 245,
    });
  }
}

/**
 * Paint roads, pavements, kerbs, tram tracks and crossings in the same painter
 * order as `paintGround`: sidewalks → paths → tram beds → kerbs → carriageways
 * → rails → P1 details. Every layer writes snow/class/wet into its channels,
 * so the shader only has to read the baked values.
 */
function paintSeasonGround(tile: TileData, channels: SeasonChannel[], res: number): void {
  const surfaces = tile.surfaces ?? [];
  for (const tier of TIER_ORDER) {
    for (const surface of surfaces) {
      if (!surface || !Array.isArray(surface.polygon)) continue;
      if (surfaceTier(surface.kind) !== tier) continue;
      const values = seasonSurface(surface.kind);
      paintSeasonPolygon(channels[0].ctx, surface.polygon, values.snow);
      paintSeasonPolygon(channels[2].ctx, surface.polygon, values.cls);
      if (values.leaf > 0) {
        paintSeasonPolygon(channels[1].ctx, surface.polygon, values.leaf);
      }
    }
  }

  const minLine = res;
  const strokes = (tile.ground?.strokes ?? []).filter(
    (stroke) => isValidStroke(stroke) && stroke.b !== 1,
  );
  const roads = strokes.filter((stroke) => stroke.k === 'road');
  roads.sort((a, b) => a.r - b.r || a.w - b.w);
  const fills = (tile.ground?.fills ?? []).filter(isValidFill);

  // 1. Sidewalks under everything: a packed base, a cleared centre strip and a
  //    drifted edge near the wall.
  for (const road of roads) {
    const sw = road.sw;
    if (!sw || (sw[0] <= 0 && sw[1] <= 0)) continue;
    const kerb = road.kb === 1 ? KERB_WIDTH_M : 0;
    const [left, right] = sw;
    const band = kerbBand(road);
    if (Math.abs(left - right) < 0.05) {
      seasonStroke(channels, band.p, band.w + 2 * (kerb + left), {
        snow: 75,
        leaf: 20,
        cls: SEASON_CLASS.paving,
      });
      paintSeasonSidewalk(channels, band, kerb, left, minLine, 1);
      paintSeasonSidewalk(channels, band, kerb, left, minLine, -1);
    } else {
      for (const [side, value] of [[1, left], [-1, right]] as const) {
        if (value <= 0) continue;
        seasonStroke(channels, offsetPolyline(band.p, side * ((kerb + value) / 2)),
          band.w + kerb + value, { snow: 75, leaf: 20, cls: SEASON_CLASS.paving });
        paintSeasonSidewalk(channels, band, kerb, value, minLine, side);
      }
    }
  }

  // 2. Paths (same order as the ground compositor).
  const pathOrder: GroundStroke['k'][] = ['track', 'path', 'steps', 'ped', 'cycle'];
  for (const kind of pathOrder) {
    for (const stroke of strokes) {
      if (stroke.k !== kind) continue;
      const values: SeasonValues = kind === 'ped'
        ? { snow: 45, leaf: 10, cls: SEASON_CLASS.paving }
        : kind === 'track'
          ? { snow: 110, leaf: 40, cls: SEASON_CLASS.grass }
          : { snow: 80, leaf: 30, cls: SEASON_CLASS.paving };
      seasonStroke(channels, stroke.p, Math.max(minLine, stroke.w), values);
    }
  }

  // 3. Tram track beds, reservations and stop platforms.
  for (const stroke of strokes) {
    if (stroke.k !== 'tram') continue;
    seasonStroke(channels, stroke.p, stroke.w + TRAM_BED_EXTRA_M, {
      snow: 110,
      leaf: 0,
      cls: SEASON_CLASS.asphalt,
    });
  }
  for (const fill of fills) {
    if (fill.m === 'platform') {
      seasonFillFlat(channels, [fill.p, ...(fill.h ?? [])], {
        snow: 0,
        leaf: 10,
        cls: SEASON_CLASS.paving,
      });
    } else if (fill.m === 'tram') {
      seasonFillFlat(channels, [fill.p, ...(fill.h ?? [])], {
        snow: 110,
        leaf: 0,
        cls: SEASON_CLASS.asphalt,
      });
    }
  }

  // 4. Kerb casings become the ploughed berm: the whole band is snow, then the
  //    carriageway is painted clean on top, leaving a strip outside the kerb.
  for (const road of roads) {
    if (road.kb !== 1) continue;
    const band = kerbBand(road);
    seasonStroke(channels, band.p, band.w + 2 * SEASON_BERM_M, {
      snow: 245,
      leaf: 160,
      cls: SEASON_CLASS.grass,
    });
  }
  for (const fill of fills) {
    if (fill.m !== 'asphalt' || fill.kb !== 1) continue;
    seasonStrokeFill(channels, fill, 2 * SEASON_BERM_M, {
      snow: 245,
      leaf: 160,
      cls: SEASON_CLASS.grass,
    });
  }

  // 5. Carriageways and asphalt gap fills: ploughed to the asphalt.
  for (const road of roads) {
    const band = kerbBand(road);
    seasonStroke(channels, band.p, Math.max(minLine, band.w), {
      snow: 0,
      leaf: 0,
      cls: SEASON_CLASS.asphalt,
      wet: 110,
    });
  }
  for (const fill of fills) {
    if (fill.m === 'asphalt') {
      seasonFillFlat(channels, [fill.p, ...(fill.h ?? [])], {
        snow: 0,
        leaf: 0,
        cls: SEASON_CLASS.asphalt,
        wet: 110,
      });
    } else if (fill.m === 'concrete') {
      seasonFillFlat(channels, [fill.p, ...(fill.h ?? [])], {
        snow: 0,
        leaf: 0,
        cls: SEASON_CLASS.asphalt,
        wet: 100,
      });
    }
  }
  for (const stroke of strokes) {
    if (stroke.k !== 'aeroway') continue;
    seasonStroke(channels, stroke.p, Math.max(minLine, stroke.w), {
      snow: 0,
      leaf: 0,
      cls: SEASON_CLASS.asphalt,
      wet: 100,
    });
  }

  // 6. Rails: ballast holds a thin cover; tram rails stay clean steel.
  for (const stroke of strokes) {
    if (stroke.k === 'rail') {
      seasonStroke(channels, stroke.p, stroke.w, {
        snow: 60,
        cls: SEASON_CLASS.asphalt,
      });
    } else if (stroke.k === 'tram') {
      for (const side of [-RAIL_HALF_GAUGE_M, RAIL_HALF_GAUGE_M]) {
        seasonStroke(channels, offsetPolyline(stroke.p, side), RAIL_HEAD_WIDTH_M, {
          snow: 0,
          wet: 160,
        });
      }
    }
  }

  // 7. On-street parking strips: half-cleared, wet asphalt.
  for (const road of roads) {
    const pk = road.pk;
    if (!pk) continue;
    for (const [side, width] of [[1, pk[0]], [-1, pk[1]]] as const) {
      if (!(width > 0)) continue;
      seasonStroke(channels, offsetPolyline(road.p, side * (road.w / 2 + width / 2)),
        width, { snow: 120, cls: SEASON_CLASS.asphalt, wet: 100 });
    }
  }

  // 8. Gutter and wheel ruts: the dark wet lines that keep winter roads legible.
  for (const road of roads) {
    const band = kerbBand(road);
    if (road.kb === 1 && band.w > 4) {
      for (const side of [-1, 1]) {
        const offset = side * (band.w / 2 - SEASON_GUTTER_M / 2);
        seasonStroke(channels, offsetPolyline(band.p, offset), SEASON_GUTTER_M, {
          snow: 50,
          cls: SEASON_CLASS.asphalt,
          wet: 220,
        });
      }
    }
    if (!isPaintedRoad(road)) continue;
    const lanes = Math.max(1, (road.lf ?? 0) + (road.lb ?? 0));
    const laneWidth = road.w / lanes;
    if (!(laneWidth > 1.5)) continue;
    for (let lane = 0; lane < lanes; lane += 1) {
      const centre = -road.w / 2 + laneWidth * (lane + 0.5);
      for (const side of [-SEASON_RUT_OFFSET_M, SEASON_RUT_OFFSET_M]) {
        const offset = centre + side;
        if (Math.abs(offset) > road.w / 2 - 0.2) continue;
        seasonStroke(channels, offsetPolyline(road.p, offset), SEASON_RUT_WIDTH_M, {
          snow: 0,
          wet: 230,
        });
      }
    }
  }

  // 9. Crossings last: compacted snow breaks the kerb berm.
  const crossings = tile.ground?.crossings ?? tile.crossings ?? [];
  for (const crossing of crossings) {
    if (!crossing || !Number.isFinite(crossing.x) || !Number.isFinite(crossing.angle)) continue;
    if (crossing.material && crossing.material !== 'asphalt') continue;
    paintSeasonCrossing(channels, crossing);
  }

  // 10. Leaf litter after the built layers: under crowns it falls on pavements,
  //     lawns and kerbs; the shader ignores it on asphalt.
  paintSeasonTreeLitter(tile, channels);
}

/** Reset the mask outside the data extent, matching the ground compositor. */
function maskSeasonOutsideClip(
  ctx: OffscreenCanvasRenderingContext2D,
  tile: TileData,
  bounds: Bounds4,
): void {
  const clip = tile.ground?.clip;
  if (!Array.isArray(clip) || clip.length !== 4 || !clip.every(Number.isFinite)) return;
  const [cx0, cy0, cx1, cy1] = clip;
  const [bx0, by0, bx1, by1] = bounds;
  if (cx0 <= bx0 && cy0 <= by0 && cx1 >= bx1 && cy1 >= by1) return;
  ctx.fillStyle = 'rgb(0, 0, 0)';
  const pad = 1;
  if (cx0 > bx0) ctx.fillRect(bx0 - pad, by0 - pad, cx0 - bx0 + pad, by1 - by0 + 2 * pad);
  if (cx1 < bx1) ctx.fillRect(cx1, by0 - pad, bx1 - cx1 + pad, by1 - by0 + 2 * pad);
  if (cy0 > by0) ctx.fillRect(bx0 - pad, by0 - pad, bx1 - bx0 + 2 * pad, cy0 - by0 + pad);
  if (cy1 < by1) ctx.fillRect(bx0 - pad, cy1, bx1 - bx0 + 2 * pad, by1 - cy1 + pad);
}

/** Ice along the actual shoreline; tile borders are treated as open water. */
function applyIceBanks(data: Uint8ClampedArray, width: number, height: number): void {
  const waterMin = Math.round(SEASON_CLASS.water * 0.92);
  const waterMax = Math.round(SEASON_CLASS.water * 1.12);
  const isWater = (index: number): boolean => {
    const value = data[index * 4 + 2];
    return value >= waterMin && value <= waterMax;
  };
  const shore = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (!isWater(index)) continue;
      const touchesLand =
        (x > 0 && !isWater(index - 1))
        || (x + 1 < width && !isWater(index + 1))
        || (y > 0 && !isWater(index - width))
        || (y + 1 < height && !isWater(index + width));
      if (touchesLand) shore[index] = 1;
    }
  }
  // One dilation step into a separate mask: about two mask texels (2–4 m at
  // base LOD) of ice. Writing into the same array while reading neighbours
  // would carry the ice across the whole water body in scan order.
  const ice = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (!isWater(index)) continue;
      if (
        shore[index]
        || (x > 0 && shore[index - 1])
        || (x + 1 < width && shore[index + 1])
        || (y > 0 && shore[index - width])
        || (y + 1 < height && shore[index + width])
      ) {
        ice[index] = 1;
      }
    }
  }
  for (let index = 0; index < ice.length; index += 1) {
    if (!ice[index]) continue;
    data[index * 4] = 255;
    data[index * 4 + 1] = 0;
    data[index * 4 + 2] = SEASON_CLASS.water;
    data[index * 4 + 3] = 0;
  }
}

/**
 * Bake the per-tile season mask (seasons P0).
 *
 * Four single-channel canvases are painted independently and merged into RGBA
 * at the end: R snow depth, G leaf litter, B surface class, A wet/dirt. The
 * mask describes the *potential* of a surface (how much snow can lie there),
 * never the current date — `uWinter` decides how much of it is visible, so a
 * season change never rebuilds a tile.
 *
 * P1 paints landcover plus roads, pavements, kerbs/berms, crossings, tram
 * tracks and shoreline ice; P2 fills the G channel with leaf litter under
 * crowns, along kerbs and on lawns.
 */
export function paintSeasonMask(
  tile: TileData,
  bounds: Bounds4,
  res: number,
): SeasonMask | null {
  if (!groundRasterAvailable()) return null;
  const width = Math.max(1, Math.round((bounds[2] - bounds[0]) / res));
  const height = Math.max(1, Math.round((bounds[3] - bounds[1]) / res));
  const snow = seasonChannel(width, height);
  const leaf = seasonChannel(width, height);
  const cls = seasonChannel(width, height);
  const wet = seasonChannel(width, height);
  if (!snow || !leaf || !cls || !wet) return null;

  // Base: unknown ground is open/courtyard in the city, so it holds snow in
  // winter. Roads, pavements, plazas and water are painted over below with
  // their explicit (often cleared) classes; this fill is what removes the
  // dark green gaps between buildings.
  fillSeasonChannel(snow, 200);
  fillSeasonChannel(leaf, 0);
  fillSeasonChannel(cls, SEASON_CLASS.other);
  fillSeasonChannel(wet, 0);

  const channels = [snow, leaf, cls, wet];
  for (const channel of channels) {
    channel.ctx.setTransform(1 / res, 0, 0, -1 / res, -bounds[0] / res, bounds[3] / res);
    channel.ctx.lineCap = 'round';
    channel.ctx.lineJoin = 'round';
    channel.ctx.setLineDash([]);
  }

  paintSeasonGround(tile, channels, res);
  for (const channel of channels) maskSeasonOutsideClip(channel.ctx, tile, bounds);

  const buffers = channels.map(
    (channel) => channel.ctx.getImageData(0, 0, width, height).data,
  );
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const base = i * 4;
    data[base] = buffers[0][base]; // R = snow depth
    data[base + 1] = buffers[1][base]; // G = leaf litter
    data[base + 2] = buffers[2][base]; // B = surface class
    data[base + 3] = buffers[3][base]; // A = wet / dirt
  }
  applyIceBanks(data, width, height);
  return { width, height, res, data };
}
