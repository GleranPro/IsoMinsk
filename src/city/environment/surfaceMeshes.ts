/**
 * Ground base + landcover surfaces (parks, grass, forest, water, plaza,
 * residential/industrial landuse, …).
 *
 * Every polygon is triangulated with holes respected (see triangulate.ts) and
 * emitted at its semantic layer height from envLayers.ts. Water additionally
 * gets a cheap two-tone banding pattern (axis-aligned bands clipped to the
 * polygon) so the Svislach and the ponds read as water at pixel-art scale.
 */

import type { Polygon, Ring, SurfaceKind, SurfacePolygon } from '../../shared/types';
import { ringBounds } from '../../shared/tileMath';
import { ENV_PALETTE, mixHex, surfaceColor } from '../../engine/materials/palette';
import type { GeometrySink } from './meshBuilder';
import {
  ENV_LAYER_Y,
  layerY,
  ringTouchesBounds,
  surfaceTier,
  type Bounds4,
} from './envLayers';
import {
  clipRingToYBand,
  prepareFlatPolygon,
  simplifyPreparedPolygon,
  triangulateFlatPolygon,
  triangulatePrepared,
  type PreparedPolygon,
  type Triangle2,
} from './triangulate';

/** Minimum rendered surface area, m². */
const MIN_SURFACE_AREA_M2 = 0.5;
/** Detail simplification applied to landcover outlines before triangulation. */
const SURFACE_SIMPLIFY_TOLERANCE_M = 0.4;

/** Banding is only applied to water polygons at least this large / tall. */
const WATER_BAND_MIN_AREA_M2 = 140;
const WATER_BAND_MIN_EXTENT_M = 14;
const WATER_BAND_HEIGHT_M = 9;
/** Safety valve: fall back to a flat tint for very complex water shapes. */
const WATER_BAND_MAX_RING_VERTS = 220;
const WATER_BAND_MAX_TRIANGLES = 1400;

export interface SurfaceBuildStats {
  surfacePolygons: number;
  surfaceTriangles: number;
  waterPolygons: number;
  waterTriangles: number;
  waterBands: number;
  skippedPolygons: number;
  degeneratePolygons: number;
}

export function createSurfaceStats(): SurfaceBuildStats {
  return {
    surfacePolygons: 0,
    surfaceTriangles: 0,
    waterPolygons: 0,
    waterTriangles: 0,
    waterBands: 0,
    skippedPolygons: 0,
    degeneratePolygons: 0,
  };
}

/**
 * Flat base quad covering the whole tile at the base layer, so there are never
 * holes where the pipeline emitted no landcover polygon.
 */
export function emitBaseGround(sink: GeometrySink, bounds: Bounds4): boolean {
  const [minX, minY, maxX, maxY] = bounds;
  return sink.addFlatQuad(
    [minX, minY],
    [maxX, minY],
    [maxX, maxY],
    [minX, maxY],
    ENV_LAYER_Y.base,
    ENV_PALETTE.ground,
  );
}

/** Emit all landcover polygons; never throws on malformed entries. */
export function emitSurfacePolygons(
  sink: GeometrySink,
  surfaces: SurfacePolygon[] | null | undefined,
  bounds: Bounds4,
  stats: SurfaceBuildStats,
): void {
  if (!Array.isArray(surfaces) || surfaces.length === 0) return;
  for (let index = 0; index < surfaces.length; index++) {
    const surface = surfaces[index];
    if (!surface || !Array.isArray(surface.polygon)) {
      stats.skippedPolygons++;
      continue;
    }
    try {
      emitSurface(sink, surface, index, bounds, stats);
    } catch {
      // Defensive: odd data must never break a whole tile.
      stats.skippedPolygons++;
    }
  }
}

function emitSurface(
  sink: GeometrySink,
  surface: SurfacePolygon,
  index: number,
  bounds: Bounds4,
  stats: SurfaceBuildStats,
): void {
  const kind: SurfaceKind = surface.kind ?? 'unknown';
  const tier = surfaceTier(kind);
  if (tier === 'water') {
    emitWaterSurface(sink, surface, kind, index, bounds, stats);
    return;
  }
  const prepared = prepareFlatPolygon(surface.polygon as Polygon, {
    minArea: MIN_SURFACE_AREA_M2,
  });
  if (!prepared) {
    stats.degeneratePolygons++;
    return;
  }
  if (!touchesTile(prepared.exterior, bounds)) {
    stats.skippedPolygons++;
    return;
  }
  const triangles = triangulatePrepared(simplifyPreparedPolygon(prepared, SURFACE_SIMPLIFY_TOLERANCE_M));
  if (triangles.length === 0) {
    stats.degeneratePolygons++;
    return;
  }
  const added = sink.addFlatTriangles(triangles, layerY(tier, index), surfaceColor(kind));
  stats.surfacePolygons++;
  stats.surfaceTriangles += added;
}

function emitWaterSurface(
  sink: GeometrySink,
  surface: SurfacePolygon,
  kind: SurfaceKind,
  index: number,
  bounds: Bounds4,
  stats: SurfaceBuildStats,
): void {
  const prepared = prepareFlatPolygon(surface.polygon as Polygon, { minArea: 2 });
  if (!prepared) {
    stats.degeneratePolygons++;
    return;
  }
  if (!touchesTile(prepared.exterior, bounds)) {
    stats.skippedPolygons++;
    return;
  }
  const y = layerY('water', index);
  const baseHex = mixHex(surfaceColor(kind), ENV_PALETTE.waterDeep, 0.16);
  const bandHex = mixHex(surfaceColor(kind), ENV_PALETTE.waterDeep, 0.5);

  const bands = tryEmitWaterBands(sink, prepared, y, baseHex, bandHex, stats);
  if (!bands) {
    const added = sink.addFlatTriangles(triangulatePrepared(prepared), y, baseHex);
    stats.waterPolygons++;
    stats.waterTriangles += added;
  }
}

/**
 * Subtle two-tone banding for water: clip the polygon into horizontal bands
 * anchored to the global metric grid (so neighbouring tiles agree) and
 * alternate the two tints. Returns false when the polygon is too small or
 * complex, in which case a flat tint is used instead.
 */
function tryEmitWaterBands(
  sink: GeometrySink,
  prepared: PreparedPolygon,
  y: number,
  baseHex: string,
  bandHex: string,
  stats: SurfaceBuildStats,
): boolean {
  if (prepared.area < WATER_BAND_MIN_AREA_M2) return false;
  if (prepared.exterior.length > WATER_BAND_MAX_RING_VERTS) return false;
  const [minX, minY, maxX, maxY] = ringBounds(prepared.exterior);
  const extent = maxY - minY;
  if (!Number.isFinite(extent) || extent < WATER_BAND_MIN_EXTENT_M) return false;

  const firstBand = Math.floor(minY / WATER_BAND_HEIGHT_M);
  const lastBand = Math.floor(maxY / WATER_BAND_HEIGHT_M);
  const bandCount = lastBand - firstBand + 1;
  // Rough upper bound on the emitted triangles before doing the clipping work.
  const worstCase = bandCount * (prepared.exterior.length + 8);
  if (worstCase > WATER_BAND_MAX_TRIANGLES) return false;

  let emitted = 0;
  for (let band = firstBand; band <= lastBand; band++) {
    const yMin = band * WATER_BAND_HEIGHT_M;
    const yMax = yMin + WATER_BAND_HEIGHT_M;
    const exterior = clipRingToYBand(prepared.exterior, yMin, yMax);
    if (exterior.length < 3) continue;
    const holes: Ring[] = [];
    for (const hole of prepared.holes) {
      const clipped = clipRingToYBand(hole, yMin, yMax);
      if (clipped.length >= 3) holes.push(clipped);
    }
    const polygon: Polygon = [exterior, ...holes];
    const triangles: Triangle2[] = triangulateFlatPolygon(polygon, { minArea: 0.01 });
    if (triangles.length === 0) continue;
    const hex = (band & 1) === 0 ? baseHex : bandHex;
    emitted += sink.addFlatTriangles(triangles, y, hex);
  }
  if (emitted === 0) return false;
  stats.waterPolygons++;
  stats.waterBands += bandCount;
  stats.waterTriangles += emitted;
  return true;
}

function touchesTile(ring: Ring, bounds: Bounds4): boolean {
  return ringTouchesBounds(ring, bounds);
}
