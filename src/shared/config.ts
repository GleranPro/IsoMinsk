/**
 * Isometric Minsk — shared configuration.
 *
 * Mirrors scripts/geo_config.py. `tests/unit/config_sync.test.ts` guards that
 * the two files agree on the pilot area, tile size and projection.
 */

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

/** Data endpoints (served from public/). */
export const DATA_BASE_URL = '/data';
export const TILE_MANIFEST_URL = `${DATA_BASE_URL}/tiles/manifest.json`;

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
