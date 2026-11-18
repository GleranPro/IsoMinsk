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

import math

# --- Areas -----------------------------------------------------------------
# Pilot area: October Square / Independence Avenue, central Minsk.
# The exact centre is snapped to a real OSM landmark during ingestion; these are
# only the nominal values used before the first run (see docs/DATA_SOURCES.md).
#
# Pilot working extent (metres around the centre). Milestone-1 render area is
# PILOT_SIZE_M x PILOT_SIZE_M; the ingest bbox is padded so that buildings that
# straddle the edge are still complete.
PILOT_CENTER_LAT = 53.9022
PILOT_CENTER_LON = 27.5610
PILOT_SIZE_M = 1600.0
INGEST_MARGIN_M = 320.0

# Tile grid
TILE_SIZE_M = 512.0

# City-scale dataset (browser: `?dataset=city`). B-2 replaces the old square
# `CITY_SIZE_M` with an explicit rectangle in local metres, aligned to the tile
# grid. It covers the first MKAD ring (measured 19.03 x 15.40 km, 238.2 km2),
# the whole Northern Cemetery (relation 1692227) and the Lipki airfield complex
# east of the ring (runway east edge x = 9919 m), with context around each.
# 23 x 19 = 437 tiles of 1024 m. The target bounds are the map contract;
# extraction adds CITY_HALO_M of geometry context on top so border features
# stay complete. Keeps the existing origin.
CITY_TILE_SIZE_M = 1024.0
CITY_BOUNDS_M = (-11264.0, -9216.0, 12288.0, 10240.0)  # minx, miny, maxx, maxy
CITY_HALO_M = 1000.0

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


def area_bounds_m(area: str) -> tuple[float, float, float, float]:
    """Target map extent in local metres: (minx, miny, maxx, maxy).

    `pilot` is the square around PILOT_CENTER; `city` is the explicit B-2
    rectangle. This is the contract used by extraction, normalisation, the tree
    placement and the tile grid — no component should rebuild it from a side
    length.
    """
    if area == "city":
        return CITY_BOUNDS_M
    half = PILOT_SIZE_M / 2.0
    return (-half, -half, half, half)


def tile_range(
    bounds: tuple[float, float, float, float], tile_size: float
) -> tuple[int, int, int, int]:
    """Inclusive tile index range (min_x, min_y, max_x, max_y) covering bounds.

    For a rectangle that is an exact multiple of `tile_size` the outer tiles
    contain the whole bounds (no empty strip); for other sizes the grid is
    rounded outwards, matching the historical pilot behaviour.
    """
    minx, miny, maxx, maxy = bounds
    return (
        math.floor(minx / tile_size),
        math.floor(miny / tile_size),
        math.ceil(maxx / tile_size) - 1,
        math.ceil(maxy / tile_size) - 1,
    )


def tile_index_for_point(
    x: float,
    y: float,
    bounds: tuple[float, float, float, float],
    tile_size: float,
) -> tuple[int, int]:
    """Tile that owns a point, including points exactly on the far edge.

    `floor(x / tile_size)` maps the upper/right boundary of the area (x == maxx,
    y == maxy) to a tile that does not exist, so a tree or attraction there
    would be silently dropped. Points on that boundary belong to the last tile:
    the area rectangle is half-open in tile ownership, closed for "inside the
    area" checks.
    """
    minx, miny, maxx, maxy = bounds
    max_tx = math.ceil(maxx / tile_size) - 1
    max_ty = math.ceil(maxy / tile_size) - 1
    tx = math.floor(x / tile_size)
    ty = math.floor(y / tile_size)
    if maxx - 1e-9 <= x <= maxx + 1e-9:
        tx = max_tx
    if maxy - 1e-9 <= y <= maxy + 1e-9:
        ty = max_ty
    return tx, ty


def area_bbox(area: str) -> tuple[float, float, float, float]:
    """Approximate WGS84 ingestion window for 'pilot' (default) or 'city'.

    The city rectangle is converted with the spherical metres-per-degree
    approximation here; `scripts/ingest/extract.py` derives the exact window
    from `area_bounds_m` with the UTM transform and adds CITY_HALO_M.
    """
    if area == "city":
        minx, miny, maxx, maxy = CITY_BOUNDS_M
        return (
            PILOT_CENTER_LAT + miny / _M_PER_DEG_LAT,
            PILOT_CENTER_LON + minx / _M_PER_DEG_LON,
            PILOT_CENTER_LAT + maxy / _M_PER_DEG_LAT,
            PILOT_CENTER_LON + maxx / _M_PER_DEG_LON,
        )
    return ingest_bbox()


def city_bbox() -> tuple[float, float, float, float]:
    """Backwards-compatible alias for the city ingestion window."""
    return area_bbox("city")



# --- Rendering / quality defaults ------------------------------------------
DEFAULT_FLOOR_HEIGHT_M = 3.0
MIN_BUILDING_HEIGHT_M = 2.5
MAX_BUILDING_HEIGHT_M = 400.0
