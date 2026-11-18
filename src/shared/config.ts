/**
 * Isometric Minsk — shared configuration.
 *
 * Mirrors scripts/geo_config.py. `tests/unit/config_sync.test.ts` guards that
 * the two files agree on the pilot area, tile size and projection.
 */

import { publicAssetUrl } from './assets';

/**
 * Pilot area: October Square / Independence Avenue, central Minsk.
 * Selected as the nominal centre; the actual data bbox is a square of
 * PILOT_SIZE_M around it projected in UTM 35N.
 */
export const PILOT_CENTER = {
  lat: 53.9022,
  lon: 27.561,
} as const;

/** Rendered pilot area (metres). Ingestion is padded by INGEST_MARGIN_M. */
export const PILOT_SIZE_M = 1600;
export const INGEST_MARGIN_M = 320;

/** Geographic tile grid cell size (metres). */
export const TILE_SIZE_M = 512;

/** Renderer world units = metres. */
export const METERS_PER_UNIT = 1;

export const EPSG_WGS84 = 4326;
export const EPSG_UTM35N = 32635;

/**
 * Data endpoints (served from public/).
 *
 * The public application serves exactly one payload: the complete city of
 * Minsk (`public/data/city-tiles`). There is no pilot/central dataset, no
 * staging dataset and no runtime selector that could fall back to one — the
 * artifact published to GitHub Pages contains only `data/city-tiles` and
 * `data/museum`.
 *
 * URLs are resolved through `publicAssetUrl`, i.e. relative to the Vite
 * deployment base, so they work below `/VoxelMinsk/` as well as at the root.
 */
export const DATA_BASE_URL = publicAssetUrl('data/city-tiles');
export const TILE_MANIFEST_URL = `${DATA_BASE_URL}/manifest.json`;

/** The only dataset the public application exposes. */
export type DatasetName = 'city';

/**
 * Resolve the dataset to load.
 *
 * Always `city`. Legacy bookmarks such as `?dataset=central`,
 * `?dataset=city` or an unknown `?dataset=potato` keep working: they must not
 * select a reduced payload or a local pilot fallback, they just show the
 * complete city. `search` is accepted (and ignored) only so callers and tests
 * can pass a URL search string explicitly.
 */
export function resolveDatasetName(_search?: string): DatasetName {
  return 'city';
}

/** Base URL of the complete-city tile payloads. */
export function resolveDataBaseUrl(_search?: string): string {
  return publicAssetUrl('data/city-tiles');
}

/** Manifest URL of the complete-city dataset. */
export function resolveManifestUrl(search?: string): string {
  return `${resolveDataBaseUrl(search)}/manifest.json`;
}

/**
 * Full URL of a tile file (`file` is a manifest entry such as
 * `tiles/-11_-9.json`; tiles live directly under the data base).
 */
export function resolveTileUrl(file: string, search?: string): string {
  return `${resolveDataBaseUrl(search)}/${file.replace(/^tiles\//, '')}`;
}

/** Rendering defaults. */
export const DEFAULT_FLOOR_HEIGHT_M = 3.0;
export const MIN_BUILDING_HEIGHT_M = 2.5;
export const MAX_BUILDING_HEIGHT_M = 400;

/** Anti-z-fighting layer heights for flat ground surfaces (metres). */
export const GROUND_LAYER_Y = {
  base: 0.0,
  landuse: 0.02,
  grass: 0.03,
  sidewalk: 0.05,
  road: 0.07,
  markings: 0.09,
  water: 0.04,
} as const;

/** Isometric defaults. */
export const ISO_CAMERA = {
  /** Screen azimuth in radians: how much the world is rotated about Y. */
  azimuth: Math.PI / 4,
  /** Elevation of the classic isometric view: atan(1 / sqrt(2)) ≈ 35.264°. */
  elevation: Math.atan(1 / Math.SQRT2),
  /** Vertical half-extent of the orthographic frustum in metres. */
  orthoHeight: 420,
  minOrthoHeight: 40,
  maxOrthoHeight: 2600,
  /** Camera distance from the target (only matters for depth precision). */
  distance: 3000,
  near: 1,
  far: 12000,
} as const;
