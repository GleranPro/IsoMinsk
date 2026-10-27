"""Isometric Minsk — shared geographic configuration.

Single source of truth for the pilot area, coordinate systems and tile grid.
Both the Python pipeline and the TypeScript app derive their constants from
this file's values (the TS mirror lives in src/shared/config.ts — keep in sync,
`tests/unit/config_sync.test.ts` guards the invariant).

Coordinate conventions
----------------------
* Source datasets are WGS84 (EPSG:4326) lon/lat degrees.
* Projection for all metric work: EPSG:32635 (WGS 84 / UTM zone 35N).
* Local renderer coordinates are metres in UTM 35N, translated so that
  ``ORIGIN`` (lon/lat of the pilot centre) maps to (0, 0).
* Mapping from UTM to local:  x_local = x_utm - origin_x, y_local = y_utm - origin_y
* Mapping to renderer world (right-handed, Y up):
      world_x =  x_local
      world_y =  height above ground (metres)
      world_z = -y_local          (north is -Z, i.e. "up" on the screen at azimuth 0)
"""

from __future__ import annotations

# --- Pilot area -------------------------------------------------------------
# October Square / Independence Avenue, central Minsk.
# The exact centre is snapped to a real OSM landmark during ingestion; these are
# only the nominal values used before the first run (see docs/DATA_SOURCES.md).
PILOT_CENTER_LAT = 53.9022
PILOT_CENTER_LON = 27.5610

# Pilot working extent (metres around the centre). Milestone-1 render area is
# PILOT_SIZE_M x PILOT_SIZE_M; the ingest bbox is padded so that buildings that
# straddle the edge are still complete.
PILOT_SIZE_M = 1600.0
INGEST_MARGIN_M = 320.0

# Tile grid
TILE_SIZE_M = 512.0

# --- Coordinate systems -----------------------------------------------------
EPSG_WGS84 = 4326
EPSG_UTM35N = 32635

# Metres per degree at the pilot latitude (spherical, only used for bbox maths)
_M_PER_DEG_LAT = 111_320.0
_M_PER_DEG_LON = 111_320.0 * 0.5937  # cos(53.9 deg)

def ingest_bbox() -> tuple[float, float, float, float]:
    """Return (min_lat, min_lon, max_lat, max_lon) of the ingestion window."""
    half = (PILOT_SIZE_M / 2.0) + INGEST_MARGIN_M
    dlat = half / _M_PER_DEG_LAT
    dlon = half / _M_PER_DEG_LON
    return (
        PILOT_CENTER_LAT - dlat,
        PILOT_CENTER_LON - dlon,
        PILOT_CENTER_LAT + dlat,
        PILOT_CENTER_LON + dlon,
    )


# --- Rendering / quality defaults ------------------------------------------
DEFAULT_FLOOR_HEIGHT_M = 3.0
MIN_BUILDING_HEIGHT_M = 2.5
MAX_BUILDING_HEIGHT_M = 400.0
