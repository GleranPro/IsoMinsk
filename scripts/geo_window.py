"""Exact WGS84 windows derived from the metric area contract.

`geo_config` owns the metric rectangle (local metres, EPSG:32635 relative to the
pilot origin). Both the extractor and the normaliser need the corresponding
WGS84 window, so the UTM transforms live here instead of being re-derived with
the approximate "metres per degree" constants.
"""

from __future__ import annotations

from pyproj import Transformer

from geo_config import (
    CITY_HALO_M,
    EPSG_UTM35N,
    EPSG_WGS84,
    PILOT_CENTER_LAT,
    PILOT_CENTER_LON,
    area_bounds_m,
)

WGS84 = EPSG_WGS84

_TO_UTM = Transformer.from_crs(EPSG_WGS84, EPSG_UTM35N, always_xy=True)
_TO_WGS = Transformer.from_crs(EPSG_UTM35N, EPSG_WGS84, always_xy=True)
ORIGIN_X, ORIGIN_Y = _TO_UTM.transform(PILOT_CENTER_LON, PILOT_CENTER_LAT)


def local_to_wgs84(x: float, y: float) -> tuple[float, float]:
    """Local metres -> (lon, lat) in EPSG:4326."""
    return _TO_WGS.transform(ORIGIN_X + x, ORIGIN_Y + y)


def wgs84_to_local(lon: float, lat: float) -> tuple[float, float]:
    """(lon, lat) -> local metres."""
    x, y = _TO_UTM.transform(lon, lat)
    return x - ORIGIN_X, y - ORIGIN_Y


def area_window_wgs84(area: str, halo_m: float | None = None) -> tuple[float, float, float, float]:
    """(min_lat, min_lon, max_lat, max_lon) covering the area bounds + halo.

    The halo is the geometry context the extractor keeps around the target
    rectangle (CITY_HALO_M for the city area by default); the pilot area has no
    halo because its ingest window already carries INGEST_MARGIN_M.
    """
    minx, miny, maxx, maxy = area_bounds_m(area)
    if area == "city":
        pad = CITY_HALO_M if halo_m is None else halo_m
    else:
        pad = 0.0 if halo_m is None else halo_m
    lons: list[float] = []
    lats: list[float] = []
    for x, y in (
        (minx - pad, miny - pad),
        (maxx + pad, miny - pad),
        (minx - pad, maxy + pad),
        (maxx + pad, maxy + pad),
    ):
        lon, lat = local_to_wgs84(x, y)
        lons.append(lon)
        lats.append(lat)
    return (min(lats), min(lons), max(lats), max(lons))


def window_covers(
    window: tuple[float, float, float, float],
    required: tuple[float, float, float, float],
    tolerance: float = 1e-6,
) -> bool:
    """True when `window` (lat/lon bbox) fully covers `required`."""
    return (
        window[0] <= required[0] + tolerance
        and window[1] <= required[1] + tolerance
        and window[2] >= required[2] - tolerance
        and window[3] >= required[3] - tolerance
    )
