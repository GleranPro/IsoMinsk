/**
 * Environment layer heights and surface classification.
 *
 * All flat environment geometry must be drawn at one of the heights below so
 * that categories never z-fight. The base values come from
 * `GROUND_LAYER_Y` in `src/shared/config.ts`; the two extra heights
 * (`railBallast`, `railTrack`) are local offsets because the shared config has
 * no railway layer (it is read-only for this module).
 *
 * Ordering (strictly increasing):
 *   base < landuse < grass < feature < water < sidewalk < railBallast
 *        < kerb < road < markings < railTrack
 *
 * `feature` is a local layer for specific built features (sports pitches,
 * plazas, sand) that frequently sit *inside* a broader park/landuse polygon in
 * OSM, and therefore must draw above it to stay visible.
 *
 * Coplanar *overlapping* polygons in the same category would still shimmer, so
 * every category also gets a small deterministic per-polygon offset ("jitter")
 * picked from a fixed number of sub-levels. The jitter step (1.5 mm) is more
 * than twice the depth-buffer resolution of the isometric camera
 * (≈0.7 mm at the far/near ratio used by the renderer), so two polygons that
 * overlap always resolve to a single stable winner.
 */

import { GROUND_LAYER_Y } from '../../shared/config';
import { boundsIntersect, ringBounds } from '../../shared/tileMath';
import type { Ring, RoadClass, RoadPolygon, SurfaceKind } from '../../shared/types';

/** Local-metre tile bounds: [minX, minY, maxX, maxY]. */
export type Bounds4 = [number, number, number, number];

/** Height of one jitter sub-level, metres. Must be > depth resolution. */
export const LAYER_JITTER_STEP_M = 0.0015;

/**
 * Semantic layer heights used by the environment meshes. `base` values 0..0.09
 * are the shared `GROUND_LAYER_Y` values; the two railway heights are local
 * extensions that sit between/below the shared layers.
 */
export const ENV_LAYER_Y = {
  base: GROUND_LAYER_Y.base,
  landuse: GROUND_LAYER_Y.landuse,
  grass: GROUND_LAYER_Y.grass,
  feature: 0.0365,
  water: GROUND_LAYER_Y.water,
  sidewalk: GROUND_LAYER_Y.sidewalk,
  railBallast: 0.06,
  median: 0.0635,
  kerb: 0.0655,
  road: GROUND_LAYER_Y.road,
  markings: GROUND_LAYER_Y.markings,
  railTrack: 0.099,
} as const;

export type EnvLayerKey = keyof typeof ENV_LAYER_Y;

/** Strictly increasing order of the layers, used by tests and diagnostics. */
export const ENV_LAYER_ORDER: readonly EnvLayerKey[] = [
  'base',
  'landuse',
  'grass',
  'feature',
  'water',
  'sidewalk',
  'railBallast',
  'median',
  'kerb',
  'road',
  'markings',
  'railTrack',
];

/**
 * Number of deterministic jitter sub-levels per category. Chosen so that
 * `ENV_LAYER_Y[key] + (levels - 1) * LAYER_JITTER_STEP_M` stays strictly below
 * the next category's base height.
 */
export const ENV_LAYER_JITTER_LEVELS: Record<EnvLayerKey, number> = {
  base: 1,
  landuse: 5,
  grass: 4,
  feature: 2,
  water: 4,
  sidewalk: 4,
  railBallast: 2,
  median: 1,
  kerb: 1,
  road: 9,
  markings: 2,
  railTrack: 2,
};

/** Height of a layer with a deterministic per-polygon sub-level offset. */
export function layerY(key: EnvLayerKey, index: number): number {
  const levels = ENV_LAYER_JITTER_LEVELS[key];
  if (levels <= 1) return ENV_LAYER_Y[key];
  const slot = ((index % levels) + levels) % levels;
  return ENV_LAYER_Y[key] + slot * LAYER_JITTER_STEP_M;
}

/** Maximum height a layer can take after jitter (kept below the next layer). */
export function maxLayerY(key: EnvLayerKey): number {
  return ENV_LAYER_Y[key] + (ENV_LAYER_JITTER_LEVELS[key] - 1) * LAYER_JITTER_STEP_M;
}

/** How much a bridge deck is raised above the normal road layer, metres. */
export const BRIDGE_RAISE_M = 2.5;

/** Ground category of a landcover polygon. */
export type SurfaceTier = 'landuse' | 'grass' | 'feature' | 'water';

/** Classify a landcover polygon into its rendering tier. */
export function surfaceTier(kind: SurfaceKind | undefined): SurfaceTier {
  switch (kind) {
    case 'water':
    case 'river':
      return 'water';
    case 'grass':
    case 'park':
    case 'forest':
    case 'scrub':
    case 'cemetery':
      return 'grass';
    case 'pitch':
    case 'plaza':
    case 'sand':
      // Specific features often drawn inside a park/landuse polygon in OSM:
      // they need to sit above it to remain visible.
      return 'feature';
    default:
      return 'landuse';
  }
}

/** True for kinds rendered as water. */
export function isWaterKind(kind: SurfaceKind | undefined): boolean {
  return kind === 'water' || kind === 'river';
}

/**
 * How a road record is rendered:
 *  - `rail`     : ballast + two rail lines
 *  - `pavement` : footways / cycleways / paths, drawn at the sidewalk layer
 *  - `road`     : drivable surface at the road layer, with kerb and markings
 */
export type RoadTier = 'rail' | 'pavement' | 'road';

const PAVEMENT_CLASSES: ReadonlySet<RoadClass> = new Set<RoadClass>([
  'footway',
  'cycleway',
  'path',
  'steps',
]);

/** Classify a buffered road polygon into its rendering tier. */
export function roadTier(road: Pick<RoadPolygon, 'kind' | 'class'>): RoadTier {
  if (road.kind === 'rail') return 'rail';
  if (road.kind === 'footway') return 'pavement';
  if (PAVEMENT_CLASSES.has(road.class)) return 'pavement';
  return 'road';
}

/** Classes that receive a dashed centre line (Minsk avenues / main streets). */
export const DASH_MARKING_CLASSES: ReadonlySet<RoadClass> = new Set<RoadClass>([
  'motorway',
  'trunk',
  'primary',
  'secondary',
]);

/**
 * Classes that get a kerb/shoulder strip.
 *
 * Restricted to the street classes where the kerb reads against pavements at
 * pixel scale. Service alleys / tracks / unknown ways skip it to keep dense
 * central tiles inside the triangle budget (real data has ~700 service-alley
 * polygons across the pilot area alone); the road surface itself still renders.
 */
export const KERB_CLASSES: ReadonlySet<RoadClass> = new Set<RoadClass>([
  'motorway',
  'trunk',
  'primary',
  'secondary',
  'tertiary',
  'residential',
  'living_street',
]);

/** True when a ring's axis-aligned bounds overlap the tile bounds. */
export function ringTouchesBounds(ring: Ring, bounds: Bounds4): boolean {
  if (!Array.isArray(ring) || ring.length < 3) return false;
  const [minX, minY, maxX, maxY] = ringBounds(ring);
  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
    return false;
  }
  return boundsIntersect([minX, minY, maxX, maxY], bounds);
}
