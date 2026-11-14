"""Normalise the raw OSM extract into renderer-ready city data.

Pipeline
--------
raw GeoJSON (WGS84, lon/lat)
  -> project to EPSG:32635 and translate to a local metric origin
  -> repair / validate geometries with shapely, drop slivers
  -> infer building heights, roof shapes and architectural archetypes
    (with explicit provenance for every inferred value)
  -> resolve OSM building:part volumes into non-overlapping volumes
  -> normalize the road network: one width/material per street, a non-overlapping
     surface partition (drivable material zones / paving / kerbs / medians) and a
     semantic centreline network with junction boxes and pedestrian crossings
     (see scripts/normalize/road_network.py and docs/ROAD_NETWORK.md)
  -> deterministic tree placement
  -> clip everything into the 512 m tile grid
  -> data/processed/city_normalized.json + public/data/tiles/*.json + manifest

Coordinate convention (see src/shared/config.ts and scripts/geo_config.py):
    local_x = utm_x - origin_x
    local_y = utm_y - origin_y
    renderer world = (local_x, height, -local_y)

Outputs
-------
data/processed/city_normalized.json   full normalised city (debug / validation)
data/processed/coverage.json          data coverage statistics
public/data/tiles/manifest.json       tile index + attribution
public/data/tiles/<x>_<y>.json        per-tile render payload

Usage:
    python scripts/normalize/normalize.py
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from pyproj import Transformer  # noqa: E402
from shapely import STRtree, make_valid, set_precision  # noqa: E402
from shapely.geometry import (  # noqa: E402
    GeometryCollection,
    LineString,
    MultiLineString,
    MultiPolygon,
    Point,
    Polygon,
    box,
)
from shapely.ops import linemerge, polygonize, unary_union  # noqa: E402

from geo_config import (  # noqa: E402
    CITY_TILE_SIZE_M,
    DEFAULT_FLOOR_HEIGHT_M,
    EPSG_UTM35N,
    EPSG_WGS84,
    MAX_BUILDING_HEIGHT_M,
    MIN_BUILDING_HEIGHT_M,
    PILOT_CENTER_LAT,
    PILOT_CENTER_LON,
    PILOT_SIZE_M,
    TILE_SIZE_M,
    area_bounds_m,
    tile_index_for_point,
    tile_range,
)
from geo_window import area_window_wgs84, window_covers  # noqa: E402
from road_network import build_road_network  # noqa: E402
from bridge_decks import bridge_decks, stroke_footprint  # noqa: E402
from trees import build_trees  # noqa: E402
from ground_strokes import (  # noqa: E402
    assign_fills_to_tiles,
    carriageway_closing,
    assign_strokes_to_tiles,
    median_fills,
    rail_strokes,
    tram_platforms,
)
from aeroway import build_aeroway  # noqa: E402

GROUND_STROKE_MARGIN_M = 64.0

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "data/interim/minsk_raw.geojson"
TREES_RAW = ROOT / "data/interim/minsk_trees.json"
OUT_DIR = ROOT / "data/processed"
TILES_DIR = ROOT / "public/data/tiles"

# --- projection -------------------------------------------------------------
_transformer = Transformer.from_crs(EPSG_WGS84, EPSG_UTM35N, always_xy=True)
ORIGIN_X, ORIGIN_Y = _transformer.transform(PILOT_CENTER_LON, PILOT_CENTER_LAT)

HALF = PILOT_SIZE_M / 2.0
PILOT_RECT = box(-HALF, -HALF, HALF, HALF)


def to_local(lon: float, lat: float) -> tuple[float, float]:
    x, y = _transformer.transform(lon, lat)
    return x - ORIGIN_X, y - ORIGIN_Y


def ring_to_local(coords: list[list[float]]) -> list[tuple[float, float]]:
    """GeoJSON ring (closed) -> local metric ring (unclosed, CCW)."""
    pts = [to_local(c[0], c[1]) for c in coords]
    if len(pts) > 1 and pts[0] == pts[-1]:
        pts.pop()
    if len(pts) >= 3:
        # normalise winding: exterior CCW in local metres
        area = sum(
            (pts[i - 1][0] * pts[i][1] - pts[i][0] * pts[i - 1][1])
            for i in range(len(pts))
        )
        if area < 0:
            pts.reverse()
    return pts


def round_ring(ring: list[tuple[float, float]], ndigits: int = 2) -> list[list[float]]:
    return [[round(x, ndigits), round(y, ndigits)] for x, y in ring]


def poly_to_rings(poly: Polygon, ndigits: int = 2) -> list[list[list[float]]]:
    """Shapely Polygon -> [[exterior], [hole], ...] with CCW exterior."""
    rings = [round_ring(list(poly.exterior.coords)[:-1], ndigits)]
    for interior in poly.interiors:
        hole = list(interior.coords)[:-1]
        # holes are clockwise in GeoJSON convention; normalising is optional for rendering
        rings.append(round_ring(hole, ndigits))
    return rings


def iter_polygons(geom) -> list[Polygon]:
    if geom is None or geom.is_empty:
        return []
    if isinstance(geom, Polygon):
        return [geom]
    if isinstance(geom, MultiPolygon):
        return list(geom.geoms)
    if isinstance(geom, GeometryCollection):
        out: list[Polygon] = []
        for part in geom.geoms:
            out.extend(iter_polygons(part))
        return out
    return []


def repair(geom):
    if geom is None or geom.is_empty:
        return None
    if not geom.is_valid:
        geom = make_valid(geom)
    polys = iter_polygons(geom)
    if not polys:
        return None
    if len(polys) == 1:
        return polys[0]
    return MultiPolygon(polys)


def buffer_line(line: LineString, width: float, clip=None) -> list[Polygon]:
    """Buffer a centreline, optionally clipping it to the pilot rectangle."""
    try:
        buffered = line.buffer(width / 2.0, cap_style=2, join_style=2)
    except Exception:
        return []
    if clip is not None:
        buffered = buffered.intersection(clip)
    return iter_polygons(repair(buffered))


def ring_area_abs(ring: list[list[float]]) -> float:
    """Absolute shoelace area of a payload ring (after rounding)."""
    area = 0.0
    for index in range(len(ring)):
        x1, y1 = ring[index]
        x2, y2 = ring[(index + 1) % len(ring)]
        area += x1 * y2 - x2 * y1
    return abs(area) / 2.0


def payload_rings(polygon: Polygon, min_hole_area: float = 0.1) -> list[list[list[float]]]:
    """Serialise a polygon, dropping holes that collapsed on the 1 cm grid."""
    rings = poly_to_rings(polygon)
    if len(rings) > 1:
        rings = [rings[0]] + [hole for hole in rings[1:] if ring_area_abs(hole) >= min_hole_area]
    return rings


def iter_lines(geom) -> list[LineString]:
    if geom is None or geom.is_empty:
        return []
    if isinstance(geom, LineString):
        return [geom]
    if isinstance(geom, MultiLineString):
        return list(geom.geoms)
    if isinstance(geom, GeometryCollection):
        out: list[LineString] = []
        for part in geom.geoms:
            out.extend(iter_lines(part))
        return out
    return []


# --- tag parsing ------------------------------------------------------------

def parse_number(value: str | None, default: float | None = None) -> float | None:
    if value is None:
        return default
    text = str(value).strip().replace(",", ".")
    # take the leading number, ignore units like "m" / "meters"
    num = ""
    for char in text:
        if char.isdigit() or char in ".-+":
            num += char
        elif num:
            break
    try:
        return float(num)
    except ValueError:
        return default


# OSM occasionally carries obvious height typos (e.g. height=0.01 on a
# five-storey block). Treat anything below a door height as missing data
# instead of rendering a 1 cm building.
MIN_PLAUSIBLE_HEIGHT_M = 2.5


def parse_height(tags: dict[str, str]) -> float | None:
    for key in ("height", "building:height", "est_height"):
        value = parse_number(tags.get(key))
        if value is not None and MIN_PLAUSIBLE_HEIGHT_M <= value <= MAX_BUILDING_HEIGHT_M:
            return value
    return None


def parse_levels(tags: dict[str, str]) -> int | None:
    for key in ("building:levels", "levels"):
        value = parse_number(tags.get(key))
        if value is not None and 0 < value <= 120:
            return max(1, int(round(value)))
    return None


def parse_min_height(tags: dict[str, str]) -> float:
    value = parse_number(tags.get("min_height"))
    if value is not None:
        return max(0.0, value)
    value = parse_number(tags.get("building:min_level"))
    if value is not None:
        return max(0.0, value * DEFAULT_FLOOR_HEIGHT_M)
    return 0.0


ROOF_SHAPE_MAP = {
    "flat": "flat",
    "gabled": "gabled",
    "gable": "gabled",
    "hipped": "hipped",
    "half-hipped": "hipped",
    "pyramidal": "pyramidal",
    "pyramid": "pyramidal",
    "skillion": "skillion",
    "shed": "skillion",
    "lean_to": "skillion",
    "dome": "dome",
    "onion": "dome",
    "round": "dome",
    "cone": "pyramidal",
    "complex": "complex",
    "saltbox": "gabled",
    "gambrel": "gabled",
    "mansard": "hipped",
}

COMPASS = {
    "N": 90.0, "NNE": 67.5, "NE": 45.0, "ENE": 22.5,
    "E": 0.0, "ESE": -22.5, "SE": -45.0, "SSE": -67.5,
    "S": -90.0, "SSW": -112.5, "SW": -135.0, "WSW": -157.5,
    "W": 180.0, "WNW": 157.5, "NW": 135.0, "NNW": 112.5,
}


def parse_roof_direction(tags: dict[str, str]) -> float | None:
    raw = tags.get("roof:direction")
    if not raw:
        return None
    text = raw.strip().upper()
    if text in COMPASS:
        # ridge runs perpendicular to the slope direction
        return math.radians(COMPASS[text] + 90.0)
    value = parse_number(text)
    if value is not None:
        return math.radians(value + 90.0)
    return None


# --- archetype classification ----------------------------------------------

CIVIC_BUILDINGS = {
    "church", "cathedral", "chapel", "monastery", "temple", "mosque", "synagogue",
    "school", "university", "college", "hospital", "theatre", "museum",
    "civic", "public", "government", "library", "train_station", "stadium",
}
SMALL_BUILDINGS = {
    "garage", "garages", "shed", "hut", "kiosk", "carport", "toilets",
    "transformer_tower", "service", "roof",
}
INDUSTRIAL_BUILDINGS = {
    "industrial", "factory", "warehouse", "hangar", "manufacture",
    "storage_tank", "barn", "depot", "works",
}
OFFICE_BUILDINGS = {"office", "commercial", "retail", "supermarket", "mall", "hotel"}


class ArchetypeClassifier:
    """Heuristic archetype classification.

    Explicit OSM tags are preferred. Where the tagging is silent, neighbourhood
    heuristics are applied (distance to the Independence Avenue ensemble, expected
    Soviet-era stock, building size). These are ESTIMATES, never surveyed facts.
    """

    def __init__(self, avenue_distance):
        self.avenue_distance = avenue_distance  # callable (x, y) -> metres

    def classify(self, tags: dict[str, str], polygon: Polygon, height: float, levels: int | None,
                 centroid: tuple[float, float]) -> str:
        building = tags.get("building", "")
        if building == "building:part":
            building = tags.get("building:part", "")
        # floors may come from building:levels or be derived from an explicit
        # height tag; `known_floors is None` means we have no height signal.
        known_floors = levels
        if known_floors is None and height > 0:
            known_floors = max(1, round(height / DEFAULT_FLOOR_HEIGHT_M))
        floors = known_floors or 1

        if building in {"stadium", "grandstand", "sports_hall"} or tags.get("leisure") == "stadium":
            return "stadium"
        if building in CIVIC_BUILDINGS or tags.get("amenity") in CIVIC_BUILDINGS:
            # Monumental civic ensembles (Palace of the Republic, Bolshoi,
            # concert halls) get a dedicated colonnade-based facade preset
            # instead of the generic civic window grid.
            name = (tags.get("name") or "").lower()
            monumental_names = ("РґРІРѕСЂРµС†", "РїР°Р»Р°С†", "palace", "С‚РµР°С‚СЂ", "С‚СЌР°С‚СЂ", "theatre", "С„РёР»Р°СЂРјРѕРЅРё")
            monumental_use = tags.get("amenity") in {"arts_centre", "theatre", "concert_hall", "townhall", "parliament"}
            if polygon.area >= 6000 and (monumental_use or any(part in name for part in monumental_names)):
                return "palace"
            return "civic"
        if building in SMALL_BUILDINGS or tags.get("building") in {"garages"}:
            return "small"
        if building in INDUSTRIAL_BUILDINGS or tags.get("man_made") in {"silo", "storage_tank"}:
            return "industrial"
        if building in OFFICE_BUILDINGS or tags.get("office") or tags.get("shop") in {"mall", "department_store"}:
            return "office"

        area = polygon.area
        dist_avenue = self.avenue_distance(*centroid)
        start_date = parse_number(tags.get("start_date"))

        if building in {"house", "detached", "villa", "cabin"}:
            return "historic" if dist_avenue < 700 else "small"
        if building == "apartments" or building == "residential":
            if start_date is not None and start_date >= 2000:
                return "modern"
            if floors >= 12:
                return "panel" if (start_date is None or start_date < 2000) else "modern"
            if floors >= 8:
                return "panel"
            if floors == 5:
                return "khrushchev"
            if 6 <= floors <= 7:
                return "panel" if dist_avenue > 350 else "stalin"
            if 3 <= floors <= 4:
                return "stalin" if dist_avenue < 500 else "historic"
            return "historic"
        if building in {"terrace", "dormitory", "hotel"}:
            return "stalin" if dist_avenue < 400 else "panel"

        # untagged / generic building: footprint size and position are the only
        # signals available, so use them explicitly (documented heuristic).
        area = polygon.area
        if floors >= 9:
            return "panel"
        if floors == 5:
            return "khrushchev"
        if floors >= 3:
            return "stalin" if dist_avenue < 450 else "historic"
        if known_floors is None:
            # no height information at all: large footprints in the avenue
            # ensemble are Soviet institutional blocks (flat roofs, 4-6 storeys),
            # small footprints are pre-war low-rise.
            if area > 1600:
                return "stalin" if dist_avenue < 500 else "office"
            if area > 500:
                return "stalin" if dist_avenue < 450 else "historic"
            if area < 120:
                return "small"
            return "historic" if dist_avenue < 700 else "small"
        return "historic" if dist_avenue < 600 else "small"


def default_height_for(archetype: str, area: float) -> float:
    """Heuristic height used only when neither height nor levels are tagged."""
    base = {
        "stalin": 22.0,
        "khrushchev": 14.5,
        "panel": 28.0,
        "modern": 42.0,
        "office": 20.0,
        "historic": 11.0,
        "industrial": 8.0,
        "small": 4.0,
        "civic": 18.0,
    }.get(archetype, 12.0)
    # very large footprints are usually low-rise halls / complexes
    if area > 4000:
        base = min(base, 16.0)
    return base


def stable_unit(value: str) -> float:
    """Deterministic 0..1 hash of a feature id (stable across pipeline runs)."""
    digest = hashlib.blake2b(value.encode("utf-8"), digest_size=8).digest()
    return int.from_bytes(digest, "big") / float(2 ** 64 - 1)


def heuristic_height_variation(archetype: str, building_id: str, base: float) -> float:
    """Break the uniformity of fully inferred heights.

    Untagged buildings would otherwise all share one height per archetype, which
    reads as an artificial skyline. The variation is deterministic (В±18 %) and
    is still an INFERENCE вЂ” provenance remains `heuristic` in the payload.
    """
    unit = stable_unit(building_id + "|height")
    factor = 0.82 + 0.36 * unit
    if archetype in {"stalin", "civic"}:
        # monumental buildings were built to a handful of storey counts
        factor = 0.9 + 0.2 * round(unit * 4) / 4
    return base * factor


def floor_height_for(archetype: str) -> float:
    return {
        "stalin": 3.6,
        "khrushchev": 2.8,
        "panel": 2.8,
        "modern": 3.1,
        "office": 3.5,
        "historic": 3.3,
        "industrial": 6.0,
        "small": 2.7,
        "civic": 4.2,
    }.get(archetype, DEFAULT_FLOOR_HEIGHT_M)


def roof_height_for(tags: dict[str, str], shape: str, polygon: Polygon, height: float) -> float:
    explicit = parse_number(tags.get("roof:height"))
    if explicit is not None and 0 < explicit < 30:
        return explicit
    if shape == "flat" or shape == "complex":
        return 0.0
    short = min(polygon.bounds[2] - polygon.bounds[0], polygon.bounds[3] - polygon.bounds[1])
    angle = parse_number(tags.get("roof:angle"))
    if angle is not None and 5 <= angle <= 80:
        rise = math.tan(math.radians(angle)) * (short / 2.0)
    else:
        rise = max(1.2, min(short * 0.3, 8.0))
    # never let the roof swallow the whole building
    return max(0.0, min(rise, max(1.0, height * 0.45)))


def inferred_roof_shape(tags: dict[str, str], archetype: str, polygon: Polygon, height: float) -> tuple[str, bool]:
    explicit = tags.get("roof:shape")
    if explicit:
        mapped = ROOF_SHAPE_MAP.get(explicit.strip().lower())
        if mapped:
            return mapped, True
    # Heuristic defaults: pitched roofs only for genuinely small pre-war
    # low-rise buildings. Large central-Minsk volumes are Soviet ensembles with
    # flat roofs; giving them a pitched roof would be an obviously wrong guess.
    area = polygon.area
    if archetype in {"historic", "small"} and height <= 14.0 and area <= 900.0:
        return ("gabled", False)
    if archetype == "civic" and area <= 500.0 and height <= 12.0:
        return ("gabled", False)
    if archetype == "industrial" and area <= 2500.0:
        return ("skillion", False)
    return ("flat", False)


# --- building assembly ------------------------------------------------------

def rings_to_polygons(rings: list[list[tuple[float, float]]]) -> list[Polygon]:
    """Assemble multipolygon rings (no role info) into polygons with holes.

    Strategy: polygonize the ring boundaries (noded correctly by shapely for
    normal OSM multipolygons), then use containment depth to decide which rings
    are shells and which are holes. Falls back to plain ring polygons when
    polygonization fails.
    """
    valid_rings = [ring for ring in rings if len(ring) >= 3]
    if not valid_rings:
        return []

    lines: list[LineString] = []
    fallback_polys: list[Polygon] = []
    for ring in valid_rings:
        closed = ring + [ring[0]] if ring[0] != ring[-1] else ring
        lines.append(LineString(closed))
        try:
            poly = Polygon(closed)
        except Exception:
            continue
        if not poly.is_valid:
            poly = make_valid(poly)
        for piece in iter_polygons(poly):
            if piece.area > 0:
                fallback_polys.append(piece)

    assembled: list[Polygon] = []
    try:
        assembled = list(polygonize(lines))
    except Exception:
        assembled = []
    if not assembled:
        assembled = fallback_polys
    if not assembled:
        return []

    # nesting: classify rings by containment depth using their *exterior*
    # boundaries only вЂ” a polygon that already carries holes does not contain
    # its own hole rings, which made the old depth test fail for nested rings.
    outer_polys: list[Polygon] = []
    for poly in assembled:
        try:
            outer_polys.append(Polygon(poly.exterior.coords))
        except Exception:
            outer_polys.append(poly)
    depths: list[int] = []
    for index, poly in enumerate(assembled):
        point = poly.representative_point()
        depth = 0
        for other_index, outer in enumerate(outer_polys):
            if other_index == index:
                continue
            if outer.area > poly.area and outer.contains(point):
                depth += 1
        depths.append(depth)

    result: list[Polygon] = []
    for shell_index, shell in enumerate(assembled):
        if depths[shell_index] % 2 != 0:
            continue
        holes: list[list[tuple[float, float]]] = []
        for other_index, other in enumerate(assembled):
            if other_index == shell_index:
                continue
            if depths[other_index] != depths[shell_index] + 1:
                continue
            if outer_polys[shell_index].contains(outer_polys[other_index].representative_point()):
                holes.append(list(other.exterior.coords)[:-1])
        try:
            poly = Polygon(shell.exterior.coords, holes)
            if not poly.is_valid:
                repaired = repair(poly)
                for piece in iter_polygons(repaired):
                    if piece.area > 0:
                        result.append(piece)
                continue
            if not poly.is_empty:
                result.append(poly)
        except Exception:
            continue
    return result if result else fallback_polys


def _polygons_from_ring_coords(coords) -> list[Polygon]:
    """Build shapely polygons from one GeoJSON polygon's rings.

    GeoJSON guarantees ring order: the first ring is the exterior ring, every
    further ring is a hole. MultiPolygon features are split by the caller, so no
    nesting heuristic is needed here. Earlier versions re-polygonised the rings,
    which silently turned island holes (e.g. Komsomolskoye Lake, the Svislach
    river) into separate water/land polygons вЂ” the islands then disappeared
    under the water surface.
    """
    rings = [ring_to_local(ring) for ring in coords]
    rings = [ring for ring in rings if len(ring) >= 3]
    if not rings:
        return []
    polygon = Polygon(rings[0], rings[1:])
    if polygon.is_valid:
        return [] if polygon.is_empty else [polygon]
    pieces = iter_polygons(repair(polygon))
    if pieces:
        return pieces
    # Last resort for broken ring order: reconstruct shells/holes heuristically.
    return rings_to_polygons(rings)


def feature_polygons(feature: dict) -> list[Polygon]:
    """Polygon geometry of one raw feature.

    Building/surface relations are assembled with their member roles in
    `extract.py`, so a relation feature may arrive as a proper MultiPolygon.
    """
    geom = feature["geometry"]
    geom_type = geom["type"]
    if geom_type == "Polygon":
        return _polygons_from_ring_coords(geom["coordinates"])
    if geom_type == "MultiPolygon":
        polygons: list[Polygon] = []
        for polygon_coords in geom["coordinates"]:
            polygons.extend(_polygons_from_ring_coords(polygon_coords))
        return polygons
    return []


def feature_line(feature: dict) -> LineString | None:
    geom = feature["geometry"]
    if geom["type"] != "LineString":
        return None
    pts = [to_local(c[0], c[1]) for c in geom["coordinates"]]
    if len(pts) < 2:
        return None
    return LineString(pts)


# Raw OSM highway values that produce a road/rail polygon feature. Actual
# width/material normalization lives in scripts/normalize/road_network.py.
ROAD_WIDTH = {
    "motorway": 22.0, "motorway_link": 8.0,
    "trunk": 20.0, "trunk_link": 8.0,
    "primary": 18.0, "primary_link": 7.0,
    "secondary": 15.0, "secondary_link": 6.5,
    "tertiary": 13.0, "tertiary_link": 6.0,
    "residential": 9.0, "unclassified": 8.0,
    "service": 5.5, "living_street": 6.0,
    "pedestrian": 8.0, "footway": 2.5, "cycleway": 2.5,
    "path": 2.0, "steps": 2.5, "track": 3.5, "construction": 6.0, "road": 6.0,
}


def surface_kind_from_tags(tags: dict[str, str]) -> str:
    landuse = tags.get("landuse")
    leisure = tags.get("leisure")
    natural = tags.get("natural")
    amenity = tags.get("amenity")
    if natural in {"water", "bay", "spring"} or landuse == "reservoir" or tags.get("waterway") == "riverbank":
        return "water"
    if natural in {"river", "stream"}:
        return "river"
    if landuse == "forest" or natural == "wood":
        return "forest"
    if landuse in {"grass", "meadow", "orchard", "village_green", "recreation_ground"} or natural == "grassland" or natural == "meadow":
        return "grass"
    if leisure in {"park", "garden", "playground", "fitness_station"}:
        return "park"
    if natural == "scrub":
        return "scrub"
    if natural in {"sand", "beach"}:
        return "sand"
    if leisure == "pitch":
        return "pitch"
    if landuse == "cemetery" or amenity == "grave_yard":
        return "cemetery"
    if landuse == "railway" or tags.get("railway") == "station":
        return "railway"
    if landuse in {"plaza", "square"} or place == "square" or (leisure or "") == "square":
        return "plaza"
    if landuse == "residential":
        return "residential"
    if landuse == "industrial":
        return "industrial"
    if landuse == "commercial":
        return "commercial"
    if landuse in {"construction", "brownfield"}:
        return "construction"
    if amenity in {"school", "university", "hospital"}:
        return "plaza"
    if amenity == "parking" and (tags.get("parking") or "surface") not in {
        "underground", "multi-storey", "rooftop", "garage_boxes", "carports",
    } and tags.get("location") not in {"underground", "roof", "rooftop"}:
        return "parking"
    return "unknown"


def surface_kind_from_tags(tags: dict[str, str]) -> str:  # noqa: F811
    landuse = tags.get("landuse")
    leisure = tags.get("leisure")
    natural = tags.get("natural")
    amenity = tags.get("amenity")
    if natural in {"water", "bay", "spring"} or landuse == "reservoir" or tags.get("waterway") == "riverbank":
        return "water"
    if natural in {"river", "stream"}:
        return "river"
    if landuse == "forest" or natural == "wood":
        return "forest"
    if landuse in {"grass", "meadow", "orchard", "village_green", "recreation_ground"} or natural in {"grassland", "meadow"}:
        return "grass"
    if leisure in {"park", "garden", "playground", "fitness_station"}:
        return "park"
    if natural == "scrub":
        return "scrub"
    if natural in {"sand", "beach"}:
        return "sand"
    if leisure == "pitch":
        return "pitch"
    if landuse == "cemetery" or amenity == "grave_yard":
        return "cemetery"
    if landuse == "railway":
        return "railway"
    if landuse in {"plaza", "square"} or tags.get("place") == "square":
        return "plaza"
    if landuse == "residential":
        return "residential"
    if landuse == "industrial":
        return "industrial"
    if landuse == "commercial":
        return "commercial"
    if landuse in {"construction", "brownfield"}:
        return "construction"
    if amenity in {"school", "university", "hospital"}:
        return "plaza"
    if amenity == "parking" and (tags.get("parking") or "surface") not in {
        "underground", "multi-storey", "rooftop", "garage_boxes", "carports",
    } and tags.get("location") not in {"underground", "roof", "rooftop"}:
        return "parking"
    return "unknown"


# --- curated road tag fixes (payload 0.4.1) ---------------------------------
# Street properties OSM does not carry yet, verified against aerial imagery.
# Merged into the way's tags before the lane/width/parking model runs and listed
# in the coverage report (`curation.roadTagOverrides`); the proper fix is the
# same tags in OSM itself, after which an entry can be dropped.
ROAD_TAG_OVERRIDES: dict[tuple[str, int], dict[str, str]] = {
    # Internatsionalnaya (one-way, lanes=1): angled parking on both kerbs makes
    # the carriageway ~3 lanes wide, but the ways have no parking:* tags.
    **{
        ("way", way_id): {"parking:both": "lane", "parking:both:orientation": "diagonal"}
        for way_id in (38664566, 1426373454, 1426373455, 1426373456, 1426373457, 38664567)
    },
}


# --- curated landmark fixes -------------------------------------------------
# A very small, explicit table of OSM mapping defects that the generic rules
# cannot resolve. Keys are (osm_type, osm_id); every entry is documented here
# and reported in the coverage statistics, so the curation stays auditable.
LANDMARK_OVERRIDES: dict[tuple[str, int], dict] = {
    # "Р’РѕСЂРѕС‚Р° РњРёРЅСЃРєР°" (The Minsk Gate, Privokzalnaya square). The OSM relation
    # aggregates the two 7-storey tower blocks together with their 11-storey
    # building:parts. It carries no height/levels tags and is a malformed
    # multipolygon (two outer rings in one flattened polygon), so without this
    # override it renders as generic blocks. The volumes themselves stay fully
    # data-driven; the renderer adds the clock tier, emblem and spires for
    # `landmark: "minsk-gate"` (see src/city/buildings/cityGate.ts).
    ("relation", 9383682): {
        "landmark": "minsk-gate",
        "archetype": "stalin",
    },
    # РќР°С†РёРѕРЅР°Р»СЊРЅР°СЏ Р±РёР±Р»РёРѕС‚РµРєР° Р‘РµР»Р°СЂСѓСЃС– ("Р°Р»РјР°Р·"). OSM maps the stylobate as one
    # 89-point footprint and the rhombicuboctahedron shell as many
    # building:part polygons (some with heights that make no sense as volumes).
    # The renderer rebuilds the podium + diamond from the curated `outline`
    # (src/city/buildings/nationalLibrary.ts); `height` is the real 71.6 m top.
    ("way", 25319604): {
        "landmark": "national-library",
        "archetype": "civic",
        "height": 71.6,
    },
    # РњРѕРЅСѓРјРµРЅС‚ РџРѕР±РµРґС‹ (Victory Square obelisk): mapped as a 16x16 m "building"
    # with a bogus height=4 plus pedestal/pyramidion parts. The real monument is
    # ~38 m tall including the gold star; the renderer rebuilds it from the
    # footprint (src/city/buildings/victoryObelisk.ts).
    ("way", 346312699): {
        "landmark": "victory-obelisk",
        "archetype": "civic",
        "height": 38.2,
    },
    # РљРѕСЃС‚С‘Р» РЎРІ. РЎС‹РјРѕРЅР° С– РЎРІ. РђР»РµРЅС‹ ("Р§С‹СЂРІРѕРЅС‹ РєР°СЃС†С‘Р»" / Red Church). The church
    # way carries detailed building:parts (nave 25 m gabled, towers to 50 m); the
    # renderer rebuilds the brick neo-gothic massing, twin spires and crosses
    # (src/city/buildings/redChurch.ts).
    ("way", 100418249): {
        "landmark": "red-church",
        "archetype": "civic",
        "height": 50.0,
    },
    # РўСЌР»РµРІРµР¶Р° (Minsk TV / radio tower, vul. KamunistyДЌnaja). OSM maps it as a
    # `building=tower, man_made=tower` with height=176 and a bogus
    # roof:height=170, which made the generic builder extrude a 168 m white prism
    # with an 8 m pyramid cap. The real structure is a free-standing lattice mast;
    # the renderer rebuilds it from the footprint (src/city/buildings/tvTower.ts).
    ("way", 1158101395): {
        "landmark": "tv-tower",
        "archetype": "civic",
        "height": 176.0,
    },
}

# Broken OSM mappings around the Minsk Gate: two `building=residential` ways with
# a bogus `height=0.01` whose single ring traces several unrelated real buildings
# at once. Each lobe duplicates a building that is mapped separately (the gate
# towers and Bobruiskaya 13/15, Leningradskaya 7, Ulyanovskaya 34), so these
# aggregate records are skipped entirely instead of being rendered as 7 m blocks
# or deleting the real ways in the duplicate detector.
CURATED_DUPLICATE_IDS: dict[tuple[str, int], str] = {
    ("way", 602639195): "aggregate of the gate tower + Bobruiskaya 15 + Ulyanovskaya 34",
    ("way", 602639199): "aggregate of the gate tower + Bobruiskaya 13 + Leningradskaya 7",
}

# Curated `building:part` parenting for the Minsk Gate. After relations are
# assembled with their member roles (extract.py), relation 9383682 is a ring
# outline: the four tower parts' centroids fall into its courtyard hole, so the
# generic containment test cannot associate them and the curated crown loses
# its tower tiers. Keys are part way ids, values the parent record key.
CURATED_PART_PARENTS: dict[int, tuple[str, int]] = {
    25434766: ("relation", 9383682),
    35996179: ("relation", 9383682),
    229705382: ("relation", 9383682),
    229705383: ("relation", 9383682),
}

# --- curated park attractions ----------------------------------------------
# Ferris wheels are mapped as `attraction=big_wheel` NODES with only a `height`
# tag; diameter, cabin count and the wheel-plane orientation are not tagged. The
# missing values come from the reference model of the project's X-Plane scenery
# (measured against photos and a 2012 orthophoto, see docs/DATA_SOURCES.md В§7).
ATTRACTION_CURATION: dict[int, dict] = {
    3588199861: {  # РђРіР»СЏРґРЅР°Рµ РєРѕР»Р°, park Horkaha - 54 m tall, Г51 m, 36 cabins
        "radius": 25.0,
        "hubHeight": 28.6,
        "cabins": 36,
        "openCabins": 4,
        "planeBearingDeg": 70.87,
    },
    9841484917: {  # РђРіР»СЏРґРЅР°Рµ РєРѕР»Р°, ДЊaliuЕЎkinca park - 28 m tall
        "radius": 12.8,
        "hubHeight": 14.6,
        "cabins": 18,
        "openCabins": 2,
        "planeBearingDeg": 303.39,
    },
}


# --- main normalisation -----------------------------------------------------

def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _validate_input_meta(
    meta: dict, area: str, *, required: bool, label: str
) -> str | None:
    """Reject inputs extracted for another area / snapshot / origin.

    A stale `city_raw.geojson` from the pre-B-2 12 km extraction would otherwise
    produce 399 formally existing but geographically incomplete tiles. The window
    check uses the same exact UTM conversion as the extractor, not the
    metres-per-degree approximation.

    `required=True` (the city area) additionally demands every field, including
    the PBF SHA-256; the pilot keeps the legacy tolerant mode.
    """
    if not meta:
        return (
            f"{label} has no meta block; re-run scripts/ingest/extract.py"
            if required else None
        )
    required_fields = ("area", "epsg", "center", "window", "pbf", "pbf_size", "pbf_sha256")
    missing = [key for key in required_fields if key not in meta]
    if required and missing:
        return f"{label} meta is missing: {', '.join(missing)}"
    if meta.get("area") != area:
        return f"{label} was extracted for area '{meta.get('area')}', not '{area}'"
    if meta.get("epsg") != EPSG_UTM35N:
        return f"{label} EPSG {meta.get('epsg')} != {EPSG_UTM35N}"
    center = meta.get("center")
    if center is not None:
        if not (
            isinstance(center, (list, tuple))
            and len(center) == 2
            and all(isinstance(value, (int, float)) for value in center)
        ):
            return f"{label} has a malformed extraction center"
        if (
            abs(center[0] - PILOT_CENTER_LAT) > 1e-6
            or abs(center[1] - PILOT_CENTER_LON) > 1e-6
        ):
            return f"{label} was extracted with a different local origin"
    elif required:
        return f"{label} meta has no extraction center"
    window = meta.get("window")
    if not window:
        return f"{label} has no extraction window"
    expected = area_window_wgs84(area)
    if not window_covers(tuple(window), expected):
        return (
            f"{label} extraction window does not cover the required area + halo "
            f"'{area}': window {window} vs needed {expected}"
        )
    size = meta.get("pbf_size")
    if required and not (isinstance(size, int) and size > 0):
        return f"{label} meta has no positive pbf_size"
    recorded_sha = meta.get("pbf_sha256")
    if required and not (
        isinstance(recorded_sha, str)
        and len(recorded_sha) == 64
        and all(ch in "0123456789abcdefABCDEF" for ch in recorded_sha)
    ):
        return f"{label} meta has no valid pbf_sha256"
    pbf = meta.get("pbf")
    pbf_path = ROOT / "data" / "raw" / pbf if pbf else None
    if pbf_path is None:
        if required:
            return f"{label} meta has no pbf name"
        return None
    if not pbf_path.exists():
        if required:
            return f"{label} references a missing PBF: {pbf_path}"
        return None
    if size is not None and pbf_path.stat().st_size != size:
        return (
            f"{label} was extracted from a different PBF ({pbf}: {size} bytes, "
            f"file is {pbf_path.stat().st_size})"
        )
    if recorded_sha:
        actual_sha = _sha256_file(pbf_path)
        if actual_sha != recorded_sha:
            return (
                f"{label} was extracted from a PBF with a different SHA-256: "
                f"meta {recorded_sha[:12]}… vs file {actual_sha[:12]}…"
            )
    elif required:
        return f"{label} meta has no pbf_sha256; re-run extract with the pinned PBF"
    return None


def smallest_containing_building(
    centroid: Point,
    polygons: "list[Polygon]",
    tree: "STRtree | None",
    extra: "list[tuple[int, Polygon]]" = (),
) -> int | None:
    """Index of the smallest building polygon that contains `centroid`.

    `tree` indexes `polygons`; `extra` holds synthetic orphan parents created
    later in the loop (they keep the historical behaviour where an orphan part
    becomes a building and can parent a subsequent part). Kept as a pure helper
    so the association rules stay unit-tested after moving from O(parts x
    buildings) to an STRtree candidate query.
    """
    best_index = None
    best_area = float("inf")
    candidates = tree.query(centroid) if tree is not None else range(len(polygons))
    for raw_index in candidates:
        index = int(raw_index)
        poly = polygons[index]
        if poly.area < best_area and poly.contains(centroid):
            best_area = poly.area
            best_index = index
    for index, poly in extra:
        if poly.area < best_area and poly.contains(centroid):
            best_area = poly.area
            best_index = index
    return best_index


def tree_budget_policy_error(
    scale: float, *, is_city: bool, allow_thinning: bool
) -> str | None:
    """Refuse an implicit global tree thinning for the city dataset.

    `trees_budget_scale < 1` means every vegetation zone was scaled down, i.e.
    the whole city (including the already accepted centre) got sparser. That
    must be an explicit decision (`--allow-tree-thinning`) or a raised
    `--max-trees`, never a silent side effect of growing the area.
    """
    if is_city and not allow_thinning and scale < 0.999:
        return (
            f"global tree budget scale is {scale:.3f} (< 1): the whole city "
            "would be thinned. Raise --max-trees or pass --allow-tree-thinning."
        )
    return None


def _peak_rss_mb() -> float | None:
    """Peak resident set size of this process in MiB (Windows, best effort)."""
    try:
        if os.name == "nt":
            import ctypes
            from ctypes import wintypes

            class _ProcessMemoryCounters(ctypes.Structure):
                _fields_ = [
                    ("cb", wintypes.DWORD),
                    ("PageFaultCount", wintypes.DWORD),
                    ("PeakWorkingSetSize", ctypes.c_size_t),
                    ("WorkingSetSize", ctypes.c_size_t),
                    ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                    ("PagefileUsage", ctypes.c_size_t),
                    ("PeakPagefileUsage", ctypes.c_size_t),
                ]

            counters = _ProcessMemoryCounters()
            counters.cb = ctypes.sizeof(counters)
            kernel32 = ctypes.windll.kernel32
            psapi = ctypes.windll.psapi
            # GetCurrentProcess returns the pseudo-handle -1 as HANDLE; without
            # explicit restype/argtypes ctypes truncates it to 32 bits and
            # GetProcessMemoryInfo fails with ERROR_INVALID_HANDLE (6).
            kernel32.GetCurrentProcess.restype = wintypes.HANDLE
            kernel32.GetCurrentProcess.argtypes = []
            psapi.GetProcessMemoryInfo.argtypes = [
                wintypes.HANDLE,
                ctypes.POINTER(_ProcessMemoryCounters),
                wintypes.DWORD,
            ]
            psapi.GetProcessMemoryInfo.restype = wintypes.BOOL
            handle = kernel32.GetCurrentProcess()
            if not psapi.GetProcessMemoryInfo(
                handle, ctypes.byref(counters), counters.cb
            ):
                return None
            return counters.PeakWorkingSetSize / (1024 * 1024)
        import resource  # type: ignore[import-not-found]

        return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024.0
    except Exception:
        return None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--area", choices=["pilot", "city"], default="pilot",
                        help="pilot (1.6 km central area) or city (12 km belt)")
    parser.add_argument("--raw", default=None)
    parser.add_argument("--trees-raw", default=None)
    parser.add_argument("--max-trees", type=int, default=None,
                        help="city-wide safety cap on trees (default 1200000 city / 90000 pilot)")
    parser.add_argument("--allow-tree-thinning", action="store_true",
                        help="allow trees_budget_scale < 1 (global thinning of every "
                             "vegetation zone); off by default for the city area")
    parser.add_argument("--tree-triangle-budget", type=int, default=None,
                        help="optional tiered tree-triangle budget (default: off; 0.4.2 used 1603664)")
    parser.add_argument("--max-trees-per-tile", type=int, default=None,
                        help="per-tile tree cap (default trees.MAX_TREES_PER_TILE, mirrors treeMeshes.ts)")
    parser.add_argument("--out", default=None)
    parser.add_argument("--tiles-dir", default=None)
    parser.add_argument("--coverage-out", default=None,
                        help="write the coverage report here (default: data/processed/...); "
                             "use for staging runs so the live report is not overwritten")
    parser.add_argument("--profile", action="store_true",
                        help="print stage timings and the peak working set (RSS) "
                             "at key checkpoints (B-2 staging evidence)")
    parser.add_argument("--tile-size", type=float, default=None)
    parser.add_argument("--pilot-size", type=float, default=None)
    parser.add_argument("--legacy-roads", action="store_true",
                        help="also build the 0.3.0 vector road partition (roadSurfaces/roadNetwork, "
                             "for ?ground=vector); ~15 min extra on the city")
    args = parser.parse_args()

    is_city = args.area == "city"
    raw_path = Path(args.raw) if args.raw else ROOT / (
        "data/interim/city_raw.geojson" if is_city else "data/interim/minsk_raw.geojson"
    )
    trees_raw_path = Path(args.trees_raw) if args.trees_raw else ROOT / (
        "data/interim/city_trees.json" if is_city else "data/interim/minsk_trees.json"
    )
    out_path = Path(args.out) if args.out else OUT_DIR / (
        "city_area_normalized.json" if is_city else "city_normalized.json"
    )
    coverage_path = (
        Path(args.coverage_out) if args.coverage_out
        else OUT_DIR / ("coverage_city.json" if is_city else "coverage.json")
    )
    tiles_dir = (
        Path(args.tiles_dir) if args.tiles_dir
        else (TILES_DIR.parent / "city-tiles" if is_city else TILES_DIR)
    )
    tile_size = args.tile_size if args.tile_size else (CITY_TILE_SIZE_M if is_city else TILE_SIZE_M)
    bounds = area_bounds_m(args.area)
    if args.pilot_size:
        half = args.pilot_size / 2.0
        bounds = (-half, -half, half, half)
    minx, miny, maxx, maxy = bounds
    pilot_rect = box(*bounds)

    def inside(x: float, y: float, pad: float = 0.0) -> bool:
        """True when a local-metre point lies in the target area (+pad)."""
        return minx - pad <= x <= maxx + pad and miny - pad <= y <= maxy + pad
    # Full density: the cap is only a safety net. B-2 grows the city to 23 x 19
    # tiles (~3x the old 12 km area), so the default must not trigger the global
    # thinning scale; the policy guard below turns an unexpected overflow into an
    # explicit error instead of a silently sparser map.
    max_total_trees = args.max_trees or (1200000 if is_city else 90000)

    if not raw_path.exists():
        print(f"ERROR: raw data not found: {raw_path}\n"
              f"Run: python scripts/ingest/extract.py --area {args.area}", file=sys.stderr)
        return 1
    t_start = time.time()

    def profile(label: str) -> None:
        """Stage timing + peak RSS checkpoint (B-2 staging evidence)."""
        if not args.profile:
            return
        rss = _peak_rss_mb()
        suffix = f", peak RSS {rss:.0f} MiB" if rss is not None else ""
        print(f"[profile] {label}: {time.time() - t_start:.1f}s{suffix}")
    with raw_path.open(encoding="utf-8") as fh:
        raw = json.load(fh)
    features = raw["features"]
    print(f"Loaded {len(features):,} raw features from {raw_path.name} (area: {args.area})")
    profile("raw load")

    raw_meta = raw.get("meta") or {}
    input_error = _validate_input_meta(
        raw_meta, args.area, required=is_city, label="raw data"
    )
    if input_error:
        print(f"ERROR: {input_error}", file=sys.stderr)
        return 1

    print(f"Area: {(maxx - minx) / 1000:.3f} x {(maxy - miny) / 1000:.3f} km "
          f"({'x'.join(str(round(v)) for v in bounds)} m), "
          f"tile size {tile_size:.0f} m, output {tiles_dir}")

    stats = Counter()
    warnings: list[str] = []

    # --- mapped tree input (loaded and validated before any processing) ----
    # Placement lives in trees.py; here the raw/trees pair is validated so a
    # stale 12 km trees file cannot slip into a 399-tile build.
    tree_doc: dict = {}
    if not trees_raw_path.exists():
        if is_city:
            print(
                f"ERROR: mapped tree input not found: {trees_raw_path}\n"
                f"Run: python scripts/ingest/extract.py --area {args.area}",
                file=sys.stderr,
            )
            return 1
        warnings.append(f"Mapped tree data missing ({trees_raw_path.name}).")
    else:
        with trees_raw_path.open(encoding="utf-8") as fh:
            tree_doc = json.load(fh)
        print(f"Mapped tree input: {len(tree_doc.get('trees', [])):,} points, "
              f"{len(tree_doc.get('rows', [])):,} rows")
        tree_meta = tree_doc.get("meta") or {}
        tree_error = _validate_input_meta(
            tree_meta, args.area, required=is_city, label="mapped tree input"
        )
        if tree_error:
            print(f"ERROR: {tree_error}", file=sys.stderr)
            return 1
        if tree_meta:
            if (
                raw_meta.get("pbf_sha256")
                and tree_meta.get("pbf_sha256")
                and raw_meta["pbf_sha256"] != tree_meta["pbf_sha256"]
            ):
                print(
                    "ERROR: tree input and raw data were extracted from "
                    "different PBF snapshots",
                    file=sys.stderr,
                )
                return 1
            if (
                raw_meta.get("window")
                and tree_meta.get("window")
                and list(tree_meta["window"]) != list(raw_meta["window"])
            ):
                print(
                    "ERROR: tree input and raw data come from different "
                    "extraction windows",
                    file=sys.stderr,
                )
                return 1

    # --- park attractions (ferris wheels) ---------------------------------
    # OSM nodes (`attraction=big_wheel`) with a curated radius / cabin count /
    # wheel-plane orientation; emitted per tile and rendered by the environment
    # builder as merged props (src/city/environment/ferrisWheel.ts).
    attractions: list[dict] = []
    for feature in features:
        if feature["kind"] != "attraction":
            continue
        geometry = feature.get("geometry", {})
        if geometry.get("type") != "Point":
            continue
        coords = geometry.get("coordinates")
        if not isinstance(coords, (list, tuple)) or len(coords) < 2:
            continue
        x, y = to_local(coords[0], coords[1])
        if not inside(x, y):
            continue
        tags = feature.get("tags", {})
        osm_id = int(feature["osm_id"])
        curation = ATTRACTION_CURATION.get(osm_id, {})
        raw_height = parse_number(tags.get("height"))
        height = float(curation.get("height") or raw_height or 24.0)
        hub_height = float(curation.get("hubHeight") or height * 0.53)
        radius = float(curation.get("radius") or max(6.0, height - hub_height - 0.7))
        cabins = int(curation.get("cabins") or (36 if height >= 40 else 18))
        open_cabins = int(curation.get("openCabins") or (4 if cabins >= 30 else 2))
        bearing = float(curation.get("planeBearingDeg") or 0.0)
        attractions.append({
            "id": f"n{osm_id}",
            "type": "ferris-wheel",
            "x": round(x, 2),
            "y": round(y, 2),
            "radius": round(radius, 2),
            "hubHeight": round(hub_height, 2),
            "height": round(max(height, hub_height + radius + 0.5), 2),
            "cabins": cabins,
            "openCabins": min(max(open_cabins, 0), max(cabins - 1, 0)),
            # plane yaw (math CCW from +X/east) from the compass bearing
            "rotation": round(math.radians(90.0 - bearing), 4),
            **({"name": tags["name"]} if tags.get("name") else {}),
        })
    if attractions:
        print(f"Attractions: {len(attractions)} ferris wheel(s) -> " +
              ", ".join(f"{item['id']} at ({item['x']:.0f}, {item['y']:.0f})"
                        for item in attractions))

    # --- pass 1: project / validate all polygons ---------------------------
    buildings_raw: list[dict] = []
    parts_raw: list[dict] = []
    aeroway_raw: list[dict] = []
    surfaces: list[dict] = []
    roads_raw: list[tuple[dict, LineString]] = []
    rails_raw: list[tuple[dict, LineString]] = []
    waterways: list[tuple[dict, LineString]] = []
    crossing_nodes: list[dict] = []

    for feature in features:
        kind = feature["kind"]
        tags = feature.get("tags", {})
        if kind == "building":
            if (feature["osm_type"], int(feature["osm_id"])) in CURATED_DUPLICATE_IDS:
                stats["curated_duplicates_skipped"] += 1
                continue
            polys = feature_polygons(feature)
            if not polys:
                stats["buildings_invalid"] += 1
                continue
            is_part = tags.get("building:part") == "yes" or tags.get("building:part")
            for poly in polys:
                if poly.is_empty:
                    stats["buildings_empty_geom"] += 1
                    continue
                if not poly.intersects(pilot_rect):
                    stats["buildings_outside"] += 1
                    continue
                clipped = poly.intersection(pilot_rect) if not poly.within(pilot_rect) else poly
                for piece in iter_polygons(repair(clipped)):
                    if piece.area < 4.0:
                        stats["buildings_sliver"] += 1
                        continue
                    (parts_raw if is_part else buildings_raw).append({
                        "feature": feature,
                        "polygon": piece,
                    })
        elif kind == "surface":
            polys = feature_polygons(feature)
            for poly in polys:
                clipped = poly.intersection(pilot_rect) if not poly.within(pilot_rect) else poly
                for piece in iter_polygons(repair(clipped)):
                    if piece.area < 8.0:
                        continue
                    surfaces.append({"tags": tags, "polygon": piece, "name": tags.get("name")})
        elif kind == "aeroway":
            aeroway_kind = tags.get("aeroway")
            if aeroway_kind in {"apron", "helipad"}:
                for poly in feature_polygons(feature):
                    clipped = poly.intersection(pilot_rect) if not poly.within(pilot_rect) else poly
                    for piece in iter_polygons(repair(clipped)):
                        if piece.area < 20.0:
                            continue
                        aeroway_raw.append({
                            "tags": tags,
                            "osm_id": feature["osm_id"],
                            "type": "polygon",
                            "polygon": piece,
                        })
            elif aeroway_kind in {"runway", "taxiway"}:
                line = feature_line(feature)
                if line is None or not line.intersects(pilot_rect):
                    continue
                clipped = line.intersection(pilot_rect)
                if clipped.is_empty:
                    continue
                aeroway_raw.append({
                    "tags": tags,
                    "osm_id": feature["osm_id"],
                    "type": "line",
                    "line": clipped,
                })
        elif kind in {"highway", "railway", "waterway"}:
            line = feature_line(feature)
            if line is None:
                continue
            if not line.intersects(pilot_rect):
                continue
            if tags.get("highway", "").startswith("proposed"):
                continue
            if kind == "highway":
                if tags.get("highway") in ROAD_WIDTH:
                    road_override = ROAD_TAG_OVERRIDES.get((feature.get("osm_type", "way"), int(feature["osm_id"])))
                    if road_override:
                        tags = {**tags, **road_override}
                        stats["road_tag_overrides"] += 1
                    roads_raw.append(({"tags": tags, "feature": feature}, line))
            elif kind == "railway":
                if tags.get("railway") in {"rail", "tram", "light_rail", "subway"}:
                    rails_raw.append(({"tags": tags, "feature": feature}, line))
            else:
                waterways.append(({"tags": tags, "feature": feature}, line))
        elif kind == "crossing":
            geometry = feature.get("geometry", {})
            if geometry.get("type") != "Point":
                stats["crossings_invalid"] += 1
                continue
            coords = geometry.get("coordinates")
            if not isinstance(coords, (list, tuple)) or len(coords) < 2:
                stats["crossings_invalid"] += 1
                continue
            x, y = to_local(coords[0], coords[1])
            if not inside(x, y):
                stats["crossings_outside"] += 1
                continue
            crossing_nodes.append({
                "osm_id": int(feature["osm_id"]),
                "tags": tags,
                "x": x,
                "y": y,
            })

    stats["buildings_raw"] = len(buildings_raw)
    stats["building_parts_raw"] = len(parts_raw)
    stats["surfaces_raw"] = len(surfaces)
    stats["roads_raw"] = len(roads_raw)
    stats["rails_raw"] = len(rails_raw)
    stats["waterways_raw"] = len(waterways)
    stats["crossings_raw"] = len(crossing_nodes)
    print(
        f"Projected: buildings={stats['buildings_raw']:,} parts={stats['building_parts_raw']:,} "
        f"surfaces={stats['surfaces_raw']:,} roads={stats['roads_raw']:,} rails={stats['rails_raw']:,} "
        f"crossings={stats['crossings_raw']:,} "
        f"| outside={stats['buildings_outside']:,} slivers={stats['buildings_sliver']:,} "
        f"invalid={stats['buildings_invalid']:,} empty={stats['buildings_empty_geom']:,}"
    )

    # --- Independence Avenue reference (for architectural heuristics) ------
    avenue_lines: list[LineString] = []
    AVE_NAME_PATTERNS = ("РЅРµР·Р°Р»РµР¶РЅР°СЃС†С–", "РЅРµР·Р°РІРёСЃРёРјРѕСЃС‚Рё", "independence")
    for entry, line in roads_raw:
        name = entry["tags"].get("name", "").lower()
        if any(pattern in name for pattern in AVE_NAME_PATTERNS):
            avenue_lines.append(line)
    if avenue_lines:
        avenue_geom = unary_union(avenue_lines)
        avenue_is_real = True
    else:
        # fallback: roughly the real axis of the avenue through the pilot centre
        avenue_geom = LineString([(0, miny - 500.0), (60, maxy + 500.0)])
        avenue_is_real = False
        warnings.append(
            "Independence Avenue geometry not found by name; using a straight fallback axis "
            "for archetype heuristics."
        )
    print(f"Avenue reference: {'OSM way(s)' if avenue_is_real else 'fallback line'} "
          f"({len(avenue_lines)} ways)")

    def avenue_distance(x: float, y: float) -> float:
        return avenue_geom.distance(Point(x, y))

    classifier = ArchetypeClassifier(avenue_distance)

    # --- building parts association ---------------------------------------
    # group parts under the building polygon that contains their centroid;
    # curated landmarks can force a parent when the relation is a ring outline
    # (see CURATED_PART_PARENTS).
    part_groups: dict[int, list[dict]] = defaultdict(list)
    orphan_parts = 0
    curated_parts = 0
    building_index_by_key: dict[tuple[str, int], int] = {}
    for index, building in enumerate(buildings_raw):
        feature = building["feature"]
        building_index_by_key.setdefault(
            (feature["osm_type"], int(feature["osm_id"])), index
        )
    # Candidate query instead of parts x buildings: an STRtree over the building
    # footprints keeps the "smallest containing polygon" rule while the city
    # grows from ~32k to ~95k raw buildings.
    building_polygons = [entry["polygon"] for entry in buildings_raw]
    building_tree = STRtree(building_polygons) if building_polygons else None
    synthetic_parents: list[tuple[int, Polygon]] = []
    for part in parts_raw:
        part_feature = part["feature"]
        forced_parent = (
            CURATED_PART_PARENTS.get(int(part_feature["osm_id"]))
            if part_feature["osm_type"] == "way"
            else None
        )
        forced_index = building_index_by_key.get(forced_parent) if forced_parent else None
        if forced_index is not None:
            part_groups[forced_index].append(part)
            curated_parts += 1
            continue
        centroid = part["polygon"].representative_point()
        best_index = smallest_containing_building(
            centroid, building_polygons, building_tree, synthetic_parents
        )
        if best_index is None:
            orphan_parts += 1
            # orphan parts become their own volumes via a synthetic building
            buildings_raw.append({"feature": part["feature"], "polygon": part["polygon"]})
            synthetic_parents.append((len(buildings_raw) - 1, part["polygon"]))
            part_groups[len(buildings_raw) - 1].append(part)
        else:
            part_groups[best_index].append(part)
    stats["orphan_parts"] = orphan_parts
    stats["curated_parts_parented"] = curated_parts

    # --- build BuildingFeature records ------------------------------------
    buildings: list[dict] = []
    used_ids: set[str] = set()
    roof_shape_counts: Counter = Counter()
    archetype_counts: Counter = Counter()
    height_source_counts: Counter = Counter()

    for index, entry in enumerate(buildings_raw):
        feature = entry["feature"]
        tags = feature.get("tags", {})
        polygon = entry["polygon"]
        if polygon.is_empty or polygon.area < 4.0:
            continue

        osm_type = feature["osm_type"]
        osm_id = int(feature["osm_id"])
        building_id = f"{osm_type[0]}{osm_id}"
        if building_id in used_ids:
            building_id = f"{building_id}_{index}"
        used_ids.add(building_id)

        levels = parse_levels(tags)
        explicit_height = parse_height(tags)
        centroid = (polygon.centroid.x, polygon.centroid.y)

        # archetype first (needed for height inference)
        archetype = classifier.classify(tags, polygon, explicit_height or 0, levels, centroid)

        # curated landmark override (documented OSM mapping defects only)
        landmark_override = LANDMARK_OVERRIDES.get((osm_type, osm_id))
        if landmark_override:
            archetype = landmark_override.get("archetype", archetype)

        if explicit_height is not None:
            height = explicit_height
            height_source = "osm_height"
        elif levels is not None:
            height = levels * floor_height_for(archetype)
            height_source = "osm_levels"
        else:
            height = default_height_for(archetype, polygon.area)
            height = heuristic_height_variation(archetype, building_id, height)
            height_source = "heuristic"
            if archetype in {"historic", "small"}:
                height_source = "heuristic"
        height = max(MIN_BUILDING_HEIGHT_M, min(height, MAX_BUILDING_HEIGHT_M))

        roof_shape, roof_explicit = inferred_roof_shape(tags, archetype, polygon, height)
        roof_height = roof_height_for(tags, roof_shape, polygon, height)
        if roof_height <= 0:
            roof_shape = "flat"
        roof_direction = parse_roof_direction(tags)
        min_height = parse_min_height(tags)
        # The eave must stay above the bottom of the volume; a large inferred
        # roof on a building with min_height would otherwise invert the volume.
        wall_top = max(2.0, height - roof_height, min_height + 0.5)

        volumes: list[dict] = []
        parts = part_groups.get(index, [])
        if parts:
            # resolve overlaps: taller parts win over lower parts, and the base
            # polygon is cut by the union of all parts so nothing is drawn twice
            sorted_parts = sorted(
                parts,
                key=lambda p: (parse_height(p["feature"].get("tags", {})) or
                               (parse_levels(p["feature"].get("tags", {})) or 0) *
                               DEFAULT_FLOOR_HEIGHT_M or 0),
                reverse=True,
            )
            covered: list[Polygon] = []
            part_volumes: list[dict] = []
            for part in sorted_parts:
                ptags = part["feature"].get("tags", {})
                ppoly = part["polygon"]
                if covered:
                    try:
                        remainder = ppoly.difference(unary_union(covered))
                    except Exception:
                        remainder = ppoly
                    pieces = iter_polygons(repair(remainder))
                else:
                    pieces = [ppoly]
                covered.append(ppoly)
                p_levels = parse_levels(ptags)
                p_height_explicit = parse_height(ptags)
                p_height = p_height_explicit
                if p_height is None and p_levels is not None:
                    p_height = p_levels * floor_height_for(archetype)
                if p_height is None:
                    p_height = height
                p_height = max(MIN_BUILDING_HEIGHT_M, min(p_height, MAX_BUILDING_HEIGHT_M))
                p_min = parse_min_height(ptags)
                p_roof_shape, _ = inferred_roof_shape(ptags, archetype, ppoly, p_height)
                p_roof_height = roof_height_for(ptags, p_roof_shape, ppoly, p_height)
                if p_roof_height <= 0:
                    p_roof_shape = "flat"
                p_dir = parse_roof_direction(ptags)
                for piece in pieces:
                    if piece.area < 2.0:
                        continue
                    part_volumes.append({
                        "footprint": poly_to_rings(piece),
                        "minHeight": round(p_min, 2),
                        "height": round(max(p_min + 0.5, p_height - p_roof_height), 2),
                        "roofShape": p_roof_shape,
                        "roofHeight": round(p_roof_height, 2),
                        **({"roofDirection": round(p_dir, 4)} if p_dir is not None else {}),
                        "heightSource": "osm_height" if p_height_explicit else (
                            "osm_levels" if p_levels is not None else height_source
                        ),
                        "isPart": True,
                    })
            # remaining base mass
            try:
                base_remainder = polygon.difference(unary_union(covered))
            except Exception:
                base_remainder = polygon
            base_pieces = iter_polygons(repair(base_remainder))
            min_part_height = min(
                (vol["minHeight"] for vol in part_volumes if vol["minHeight"] > 0), default=0.0
            )
            base_height = max(min_part_height, min(vol["height"] for vol in part_volumes) if part_volumes else wall_top)
            for piece in base_pieces:
                if piece.area < 2.0:
                    continue
                volumes.append({
                    "footprint": poly_to_rings(piece),
                    "minHeight": round(min_height, 2),
                    "height": round(max(min_height + 0.5, base_height), 2),
                    "roofShape": "flat",
                    "roofHeight": 0.0,
                    "heightSource": height_source,
                })
            volumes.extend(part_volumes)
            if not volumes:
                stats["buildings_empty_volumes"] += 1
                continue
            # overall height = top of the tallest volume (+ its roof)
            overall = max((vol["height"] + vol["roofHeight"]) for vol in volumes)
        else:
            volumes.append({
                "footprint": poly_to_rings(polygon),
                "minHeight": round(min_height, 2),
                "height": round(wall_top, 2),
                "roofShape": roof_shape,
                "roofHeight": round(roof_height, 2),
                **({"roofDirection": round(roof_direction, 4)} if roof_direction is not None else {}),
                "heightSource": height_source,
            })
            overall = wall_top + roof_height

        roof_shape_counts[roof_shape] += 1
        archetype_counts[archetype] += 1
        height_source_counts[height_source] += 1

        tags_out = {
            key: value
            for key, value in tags.items()
            if key.startswith(("building", "roof", "addr", "name", "height", "levels", "start_date"))
            or key in {"amenity", "shop", "office", "tourism", "historic", "religion", "man_made"}
        }
        address = ""
        street = tags.get("addr:street")
        house = tags.get("addr:housenumber")
        if street or house:
            address = f"{street or ''} {house or ''}".strip()

        buildings.append({
            "id": building_id,
            "osmType": osm_type,
            "osmId": osm_id,
            "name": tags.get("name") or tags.get("name:ru") or tags.get("name:en") or "",
            "archetype": archetype,
            **({"levels": levels} if levels is not None else {}),
            "height": round(overall, 2),
            "roofShape": roof_shape,
            "volumes": volumes,
            "tags": tags_out,
            "address": address,
            "roofShapeExplicit": roof_explicit,
            **({"landmark": landmark_override["landmark"]} if landmark_override else {}),
            # Curated landmarks keep the untrimmed OSM footprint: the generic
            # de-overlap cuts the base into pieces around building:parts, which
            # landmark geometry cannot use to rebuild the real massing.
            **({"outline": poly_to_rings(polygon)} if landmark_override else {}),
        })

    # --- merge polygons that belong to the same OSM feature -----------------
    # make_valid / multipolygon assembly can split one OSM building into several
    # polygons. They must stay ONE BuildingFeature with multiple volumes so that
    # the id is the stable OSM id (contract: FeatureId = "<w|r><osm id>").
    merged_buildings: list[dict] = []
    merged_index: dict[tuple[str, int], int] = {}
    for candidate in buildings:
        key = (candidate["osmType"], candidate["osmId"])
        existing_index = merged_index.get(key)
        if existing_index is None:
            merged_index[key] = len(merged_buildings)
            merged_buildings.append(candidate)
            continue
        existing = merged_buildings[existing_index]
        existing["volumes"].extend(candidate["volumes"])
        existing["height"] = max(existing["height"], candidate["height"])
        if len(candidate["tags"]) > len(existing["tags"]):
            existing["tags"] = candidate["tags"]
        if len(candidate.get("name") or "") > len(existing.get("name") or ""):
            existing["name"] = candidate["name"]
        if candidate.get("levels") and not existing.get("levels"):
            existing["levels"] = candidate["levels"]
    split_polygons_merged = len(buildings) - len(merged_buildings)
    buildings = merged_buildings
    stats["split_polygons_merged"] = split_polygons_merged

    # --- de-duplicate exact double-mapped buildings ------------------------
    # OSM occasionally contains the same building twice (e.g. a way and a
    # multipolygon relation for one footprint). Rendering both would z-fight.
    # The signature is deliberately coarse (2 m centroid cell, 20 m2 area
    # cell), so every collision is verified against the actual footprint area
    # and centroid: distinct neighbouring buildings must never be merged.
    source_rank = {"osm_height": 4, "osm_levels": 3, "heuristic": 2, "default": 1}

    def footprint_metrics(record: dict) -> tuple[float, float, float]:
        ring = record["volumes"][0]["footprint"][0]
        cx = sum(point[0] for point in ring) / len(ring)
        cy = sum(point[1] for point in ring) / len(ring)
        area = abs(
            sum(
                ring[i - 1][0] * ring[i][1] - ring[i][0] * ring[i - 1][1]
                for i in range(len(ring))
            )
        ) / 2.0
        return cx, cy, area

    def is_landmark(record: dict) -> bool:
        return (record["osmType"], record["osmId"]) in LANDMARK_OVERRIDES

    deduped: list[dict] = []
    signatures: dict[tuple[int, int, int], int] = {}
    signature_metrics: list[tuple[float, float, float]] = []
    duplicates_dropped = 0
    near_misses_kept = 0
    for candidate in buildings:
        cx, cy, area = footprint_metrics(candidate)
        signature = (round(cx / 2.0), round(cy / 2.0), round(area / 20.0))
        existing_index = signatures.get(signature)
        same_footprint = False
        if existing_index is not None:
            ex_cx, ex_cy, ex_area = signature_metrics[existing_index]
            area_ref = max(area, ex_area, 1.0)
            same_footprint = (
                abs(area - ex_area) / area_ref <= 0.15
                and abs(cx - ex_cx) <= 3.0
                and abs(cy - ex_cy) <= 3.0
            )
        if existing_index is None or not same_footprint:
            if existing_index is not None:
                near_misses_kept += 1
            signatures[signature] = len(deduped)
            deduped.append(candidate)
            signature_metrics.append((cx, cy, area))
            continue
        existing = deduped[existing_index]
        if is_landmark(candidate) and not is_landmark(existing):
            deduped[existing_index] = candidate
            signature_metrics[existing_index] = (cx, cy, area)
        elif not is_landmark(candidate) and not is_landmark(existing) and source_rank.get(
            candidate["volumes"][0]["heightSource"], 0
        ) > source_rank.get(existing["volumes"][0]["heightSource"], 0):
            deduped[existing_index] = candidate
            signature_metrics[existing_index] = (cx, cy, area)
        duplicates_dropped += 1
    buildings = deduped
    stats["duplicate_buildings_dropped"] = duplicates_dropped
    stats["dedupe_near_misses_kept"] = near_misses_kept

    # Curated landmark heights override the inferred / OSM-part maximum so the
    # info panel and LOD distances see the real measured top elevation.
    for record in buildings:
        override = LANDMARK_OVERRIDES.get((record["osmType"], record["osmId"]))
        if override and override.get("height") is not None:
            record["height"] = float(override["height"])

    stats["buildings"] = len(buildings)
    print(f"Buildings: {len(buildings):,} (duplicates dropped: {duplicates_dropped}, "
          f"near-miss collisions kept apart: {near_misses_kept}) "
          f"(archetypes: {dict(archetype_counts)})")

    # --- road network normalization (payload 0.2.0) ------------------------
    # One non-overlapping surface partition (drivable material zones / paving /
    # kerbs / medians) plus a semantic network layer (centrelines, width, lanes,
    # direction, material) and junction/crossing records. The old per-way
    # overlapping buffers (and their class-tinted fills) are gone; see
    # scripts/normalize/road_network.py for the width/material model.
    mapped_water_areas = [
        surface["polygon"]
        for surface in surfaces
        if surface_kind_from_tags(surface["tags"]) in {"water", "river"}
    ]
    road_way_entries = [
        {
            "osm_type": entry["feature"]["osm_type"],
            "osm_id": entry["feature"]["osm_id"],
            "tags": entry["tags"],
            "line": line,
        }
        for entry, line in roads_raw
    ]
    road_result = build_road_network(
        road_way_entries, crossing_nodes, pilot_rect, mapped_water_areas,
        legacy_partition=args.legacy_roads,
    )
    road_stats = road_result["stats"]
    road_surfaces = road_result["surfaces"]
    network_pieces = road_result["network"]
    junction_features = road_result["junctions"]
    crossing_features = road_result["crossings"]
    print(
        f"Road network: {road_stats.get('ways', 0):,} ways "
        f"({road_stats.get('named_street_groups', 0)} named streets), "
        f"{road_stats.get('surface_drivable', 0)} drivable zones, "
        f"{road_stats.get('surface_paving', 0)} paving / "
        f"{road_stats.get('surface_kerb', 0)} kerb / "
        f"{road_stats.get('surface_median', 0)} median pieces, "
        f"{road_stats.get('junctions', 0)} junctions, "
        f"{road_stats.get('crossings', 0)} crossings; "
        f"widths normalized={road_stats.get('widths_normalized', 0)}, "
        f"materials={road_stats.get('materials', {})} "
        f"[{road_stats.get('build_seconds', 0)}s]"
    )

    # --- rail network (payload 0.2.0) --------------------------------------
    # Rails are now centrelines in the same `roadNetwork` array as roads: the
    # renderer draws the ballast strip and the two rail heads along them. This
    # keeps tram rails continuous through junctions and across tile borders
    # (the old per-way buffered polygons stopped at OSM way ends, which is what
    # the user reported as "no rails on the crossing").
    rail_groups: dict[tuple[str, float], list[LineString]] = defaultdict(list)
    for entry, line in rails_raw:
        tags = entry["tags"]
        railway = tags.get("railway", "rail")
        # The Minsk metro is mapped as railway=subway UNDER the streets. Drawing
        # it as a surface rail strip paints a black line across Independence
        # Square, so underground rail is never rendered as a ground surface.
        # (Metro geometry stays in the raw extract for future station features.)
        if railway == "subway":
            stats["subway_skipped"] += 1
            continue
        if tags.get("tunnel") in {"yes", "building_passage"}:
            stats["rail_tunnels_skipped"] += 1
            continue
        layer = parse_number(tags.get("layer"))
        if layer is not None and layer < 0:
            stats["rail_tunnels_skipped"] += 1
            continue
        # Tram rails are embedded in the carriageway: thin strip, heavy rail wider.
        width = 2.2 if railway == "tram" else 3.4
        # Bridge rails are merged separately: they become deck strokes (0.4.2).
        on_bridge = tags.get("bridge") not in (None, "", "no")
        rail_groups[(railway, width, on_bridge)].append(line)

    rail_pieces: list[dict] = []
    for (railway, width, on_bridge), lines in sorted(rail_groups.items()):
        # Both directions of one track are frequently mapped as two nearly
        # identical ways; render a single rail pair for them, not four rails.
        representatives: list[LineString] = []
        for candidate in sorted(
            lines, key=lambda item: (-item.length, round(item.centroid.x, 2), round(item.centroid.y, 2))
        ):
            if any(rep.hausdorff_distance(candidate) <= 3.5 for rep in representatives):
                continue
            representatives.append(candidate)
        try:
            merged = linemerge(unary_union(representatives))
        except Exception:
            stats["rail_merge_failed"] += 1
            continue
        for line in iter_lines(merged):
            if line.length < 5.0:
                continue
            clipped = line.intersection(pilot_rect)
            for segment in iter_lines(clipped):
                if segment.length < 5.0:
                    continue
                simplified = segment.simplify(0.5, preserve_topology=False)
                points = list(simplified.coords)
                if len(points) < 2:
                    continue
                flat: list[float] = []
                for x, y in points:
                    flat.extend((round(float(x), 2), round(float(y), 2)))
                rail_pieces.append({
                    "kind": "rail",
                    "class": "unknown",
                    "width": round(width, 2),
                    "centerline": flat,
                    "centerlineOffset": 0.0,
                    **({"bridge": True} if on_bridge else {}),
                })
    if args.legacy_roads:
        network_pieces.extend(rail_pieces)
    stats["rail_pieces"] = len(rail_pieces)

    # --- ground strokes (payload 0.4.0) ------------------------------------
    # Painter's-order centrelines rasterised by the renderer into one ground
    # texture per tile (scripts/normalize/ground_strokes.py).
    ground_strokes = list(road_result.get("ground_strokes") or []) + rail_strokes(rail_pieces)
    stats["ground_strokes"] = len(ground_strokes)
    tram_lines = [
        LineString(list(zip(s["p"][0::2], s["p"][1::2])))
        for s in ground_strokes
        if s.get("k") == "tram" and len(s.get("p") or []) >= 4
    ]
    # Dual-carriageway gaps: asphalt + divider, or tram track bed (0.4.1).
    ground_fills, ground_dividers, median_stats = median_fills(ground_strokes, tram_lines)
    stats.update(median_stats)
    for stroke in ground_strokes:
        stroke.pop("_lk", None)
    # Tram stops → platforms beside the track (0.4.1).
    tram_stop_points: list[tuple[float, float]] = []
    tram_platform_points: list[tuple[float, float]] = []
    for feature in features:
        if feature["kind"] != "transit_stop":
            continue
        coords = feature.get("geometry", {}).get("coordinates")
        if not isinstance(coords, (list, tuple)) or len(coords) < 2:
            continue
        x, y = to_local(coords[0], coords[1])
        if not inside(x, y, GROUND_STROKE_MARGIN_M):
            continue
        tags = feature.get("tags", {})
        if tags.get("railway") == "tram_stop" or tags.get("public_transport") == "stop_position":
            tram_stop_points.append((x, y))
        else:
            tram_platform_points.append((x, y))
    platforms, platform_stats = tram_platforms(tram_stop_points, tram_platform_points, tram_lines)
    stats.update(platform_stats)
    ground_fills.extend(platforms)
    # Aerodrome surfaces (B-2): runways/taxiways as wide concrete strokes,
    # aprons/helipads as concrete fills — same ground raster compositor.
    aeroway_strokes, aeroway_fills, aeroway_stats = build_aeroway(aeroway_raw)
    ground_strokes.extend(aeroway_strokes)
    ground_fills.extend(aeroway_fills)
    stats["aeroway_strokes"] = aeroway_stats.get("strokes", 0)
    stats["aeroway_fills"] = aeroway_stats.get("fills", 0)
    if aeroway_raw:
        print(f"Aeroway: {aeroway_stats.get('stroke_runway', 0)} runway / "
              f"{aeroway_stats.get('stroke_taxiway', 0)} taxiway stroke(s), "
              f"{aeroway_stats.get('fill_apron', 0)} apron / "
              f"{aeroway_stats.get('fill_helipad', 0)} helipad fill(s)")
    print(f"Ground: {median_stats.get('median_asphalt_runs', 0)} asphalt median run(s) "
          f"({median_stats.get('median_asphalt_m', 0)} m), "
          f"{median_stats.get('median_tram_runs', 0)} tram reservation run(s) "
          f"({median_stats.get('median_tram_m', 0)} m), {len(ground_dividers)} divider(s), "
          f"{platform_stats.get('tram_platforms', 0)} tram platform(s) from "
          f"{len(tram_stop_points)} stop node(s)")

    # Payload 0.2.0 keeps no legacy buffered road/rail polygons: the legacy
    # `roads` array is empty for new tiles (older tiles still render via the
    # legacy path).
    road_polys: list[dict] = []
    stats["road_polygons"] = 0
    print(f"Rail network: {len(rail_pieces):,} centreline piece(s) "
          f"(metro skipped: {stats['subway_skipped']}, "
          f"underground rail skipped: {stats['rail_tunnels_skipped']})")

    # --- ground surface list (mapped polygon land cover, incl. water areas) ---
    surface_features: list[dict] = []
    for entry in surfaces:
        kind = surface_kind_from_tags(entry["tags"])
        if kind == "unknown":
            continue
        for ring_set in [poly_to_rings(entry["polygon"])]:
            surface_features.append({
                "kind": kind,
                "polygon": ring_set,
                "name": entry["name"] or "",
            })

    # --- narrow streams from centre lines -----------------------------------
    # Wide water must come from mapped AREAS (natural=water, waterway=riverbank,
    # landuse=reservoir, multipolygons). Buffering a river CENTRE LINE into a
    # 20+ m band synthesises water where OSM only has an axis вЂ” that painted a
    # diagonal "flood" across Yanka Kupala park. Centre lines are used only for
    # genuinely narrow streams, and never where an area already covers them.
    water_polys: list[dict] = []
    existing_water = [
        Polygon(feature["polygon"][0], [Polygon(ring).exterior.coords for ring in feature["polygon"][1:]])
        for feature in surface_features
        if feature["kind"] in {"water", "river"}
    ]
    existing_water = [geom for geom in existing_water if not geom.is_empty]
    water_tree = STRtree(existing_water) if existing_water else None
    for entry, line in waterways:
        tags = entry["tags"]
        kind = tags.get("waterway")
        if kind not in {"stream", "ditch", "drain"}:
            # rivers and canals must be areas; skip their centre lines entirely
            stats["waterway_lines_skipped"] += 1
            continue
        explicit_width = parse_number(tags.get("width"))
        width = min(6.0, explicit_width) if explicit_width else 3.5
        buffered = buffer_line(line, width, pilot_rect)
        for poly in buffered:
            if poly.area < 10:
                continue
            if water_tree is not None and water_tree.query(poly).size > 0:
                if any(geom.intersects(poly) for geom in (existing_water[i] for i in water_tree.query(poly))):
                    # already represented by a mapped water area
                    continue
            water_polys.append({
                "kind": "water",
                "polygon": poly_to_rings(poly),
                **({"name": tags["name"]} if tags.get("name") else {}),
            })
    stats["water_polygons"] = len(water_polys)
    surface_features.extend(water_polys)
    stats["surfaces"] = len(surface_features)
    print(f"Water: {stats['water_polygons']} line-derived stream polygons "
          f"({stats['waterway_lines_skipped']} river/canal lines skipped вЂ” areas only)")
    print(f"Ground surfaces: {len(surface_features):,}")

    # --- trees ------------------------------------------------------------
    # Placement lives in scripts/normalize/trees.py (payload 0.4.3): the pure
    # functions there are unit-tested on synthetic data in
    # scripts/normalize/tests/test_trees.py. This block only loads the input,
    # builds the exclusion geometry and reports statistics. W4-W6 (disjoint
    # vegetation zones, cemetery grid, budget scale and per-tile/triangle caps)
    # all live in the module.
    # `tree_doc` was loaded and validated before the heavy passes (raw/trees
    # pair checks: area, origin, snapshot SHA-256 and extraction window).

    # Exclusion masks. Mapped trees (nodes and tree rows) are authoritative and
    # are dropped only on hard surfaces: buildings, water, rail and the
    # carriageway (W3). Heuristic trees stay clear of every paved / open
    # surface, as before.
    hard_mask_geoms: list[Polygon] = []
    soft_mask_geoms: list[Polygon] = []

    def add_mask_geom(target: list[Polygon], geom) -> None:
        if geom is None or geom.is_empty:
            return
        if not geom.is_valid:
            geom = repair(geom)
        for mask_piece in iter_polygons(geom):
            if not mask_piece.is_empty:
                target.append(mask_piece)

    for building in buildings:
        for volume in building["volumes"]:
            footprint = volume["footprint"]
            try:
                poly = Polygon(footprint[0], [Polygon(ring).exterior.coords for ring in footprint[1:]])
            except Exception:
                continue
            add_mask_geom(hard_mask_geoms, poly)
            add_mask_geom(soft_mask_geoms, poly)

    drivable_geom = road_result["drivable_geom"]
    paving_geom = road_result["paving_geom"]
    add_mask_geom(hard_mask_geoms, drivable_geom)
    add_mask_geom(soft_mask_geoms, drivable_geom)
    add_mask_geom(soft_mask_geoms, paving_geom)
    if drivable_geom is None:
        # No vector partition: derive the carriageway band from the road
        # strokes themselves (sidewalks and pavements are not hard surfaces).
        for stroke in ground_strokes:
            try:
                footprint = stroke_footprint(stroke)
            except Exception:
                continue
            add_mask_geom(soft_mask_geoms, footprint)
            if stroke.get("k") != "road" or len(stroke.get("p") or []) < 4:
                continue
            try:
                line = LineString(list(zip(stroke["p"][0::2], stroke["p"][1::2])))
                carriageway = line.buffer(float(stroke["w"]) / 2.0, cap_style="flat")
            except Exception:
                continue
            add_mask_geom(hard_mask_geoms, carriageway)

    for surface in surface_features:
        kind = surface["kind"]
        if kind not in {"water", "river", "pitch", "plaza", "construction", "railway", "sand"}:
            continue
        try:
            poly = Polygon(surface["polygon"][0], [Polygon(ring).exterior.coords for ring in surface["polygon"][1:]])
        except Exception:
            continue
        add_mask_geom(soft_mask_geoms, poly)
        if kind in {"water", "river", "railway"}:
            add_mask_geom(hard_mask_geoms, poly)

    # Rail centrelines are rails too: mapped trees do not stand on them, and
    # heuristic trees keep the wider margin as before.
    for piece in rail_pieces:
        centerline = piece.get("centerline") or []
        if len(centerline) < 4:
            continue
        try:
            line = LineString(list(zip(centerline[0::2], centerline[1::2])))
            band = line.buffer(float(piece["width"]) / 2.0, cap_style="flat")
        except Exception:
            continue
        add_mask_geom(hard_mask_geoms, band)
        add_mask_geom(soft_mask_geoms, band)

    # Keep the ground under a park attraction clear of heuristic trees: the real
    # ferris wheels stand on an open plaza, and tree canopies would hide them.
    for attraction in attractions:
        try:
            clearing = Point(attraction["x"], attraction["y"]).buffer(
                float(attraction["radius"]) + 10.0, 16
            )
        except Exception:
            continue
        add_mask_geom(soft_mask_geoms, clearing)

    tree_surfaces: list[tuple[str, Polygon]] = []
    for surface in surface_features:
        try:
            poly = Polygon(surface["polygon"][0], [Polygon(ring).exterior.coords for ring in surface["polygon"][1:]])
        except Exception:
            continue
        if not poly.is_empty:
            tree_surfaces.append((surface["kind"], poly))

    trees, tree_stats = build_trees(
        surfaces=tree_surfaces,
        mapped_raw=tree_doc.get("trees", []),
        row_raw=tree_doc.get("rows", []),
        hard_masks=hard_mask_geoms,
        soft_masks=soft_mask_geoms,
        to_local=to_local,
        bounds=bounds,
        max_total_trees=max_total_trees,
        tile_size=tile_size,
        **({"triangle_budget": args.tree_triangle_budget} if args.tree_triangle_budget else {}),
        **({"max_trees_per_tile": args.max_trees_per_tile} if args.max_trees_per_tile else {}),
    )
    # `stats` is a Counter: only numbers merge (the triangle budget is None
    # when it is off).
    stats.update({
        key: value for key, value in tree_stats.items()
        if isinstance(value, (int, float))
    })
    print(f"Mapped trees: {tree_stats['trees_mapped_points']:,} points and "
          f"{tree_stats['trees_mapped_rows']:,} tree-row points kept "
          f"({tree_stats['trees_mapped_points_dropped']:,} points + "
          f"{tree_stats['trees_mapped_rows_dropped_mask']:,} row points on hard surfaces, "
          f"{tree_stats['trees_mapped_rows_dropped_duplicate']:,} row duplicates dropped)")
    print(f"Vegetation: {tree_stats['trees_zones']:,} zone(s), "
          f"{tree_stats['trees_narrow_skipped']:,} narrow / "
          f"{tree_stats['trees_zones_skipped_small']:,} too-small pieces skipped, "
          f"budget scale {tree_stats['trees_budget_scale']:.3f} of "
          f"{tree_stats['trees_budget_target_total']:,} target(s); "
          f"{len(hard_mask_geoms):,} hard / {len(soft_mask_geoms):,} exclusion polygons")
    print(f"Trees: {len(trees):,} ({stats['trees_mapped']:,} mapped, "
          f"{stats['trees_heuristic']:,} heuristic; "
          f"{tree_stats['trees_tile_thinned']:,} thinned by the per-tile cap, "
          f"triangle scale {tree_stats['trees_triangle_scale']:.3f}, "
          f"{tree_stats['trees_triangle_thinned']:,} thinned by the triangle budget)")
    print("Trees per class: " + ", ".join(
        f"{kind} {count:,}" for kind, count in tree_stats["trees_heuristic_by_class"].items()
    ))
    print(f"Trees: max {tree_stats['trees_max_per_tile']:,} per tile, "
          f"{tree_stats['trees_triangles']:,} triangles total, "
          f"max {tree_stats['trees_max_triangles_per_tile']:,} per tile")
    profile("buildings + roads + trees")

    # Fail before writing any tile: an implicit thinning of every vegetation
    # zone is a product decision, not a side effect of a larger area.
    tree_policy_error = tree_budget_policy_error(
        tree_stats["trees_budget_scale"],
        is_city=is_city,
        allow_thinning=args.allow_tree_thinning,
    )
    if tree_policy_error:
        print(f"ERROR: {tree_policy_error}", file=sys.stderr)
        return 1

    # --- tile assignment --------------------------------------------------
    min_tx, min_ty, max_tx, max_ty = tile_range(bounds, tile_size)

    tiles: dict[tuple[int, int], dict] = {}
    for tx in range(min_tx, max_tx + 1):
        for ty in range(min_ty, max_ty + 1):
            tiles[(tx, ty)] = {
                "tileX": tx,
                "tileY": ty,
                "bounds": [tx * tile_size, ty * tile_size, (tx + 1) * tile_size, (ty + 1) * tile_size],
                "buildings": [],
                "surfaces": [],
                "roads": [],
                "roadSurfaces": [],
                "roadNetwork": [],
                "junctions": [],
                "crossings": [],
                "ground": {"version": 2, "strokes": []},
                "trees": [],
                "crossingBuildingIds": [],
            }

    def tile_of_point(x: float, y: float) -> tuple[int, int] | None:
        tx, ty = tile_index_for_point(x, y, bounds, tile_size)
        return (tx, ty) if (tx, ty) in tiles else None

    for building in buildings:
        centroid = Polygon(building["volumes"][0]["footprint"][0]).representative_point()
        owner = tile_of_point(centroid.x, centroid.y)
        if owner is None:
            continue
        tiles[owner]["buildings"].append(building)
        # record crossing tiles for spatial indexing
        bbox = Polygon(building["volumes"][0]["footprint"][0]).bounds
        for tx in range(math.floor(bbox[0] / tile_size), math.floor(bbox[2] / tile_size) + 1):
            for ty in range(math.floor(bbox[1] / tile_size), math.floor(bbox[3] / tile_size) + 1):
                if (tx, ty) in tiles and (tx, ty) != owner:
                    tiles[(tx, ty)]["crossingBuildingIds"].append(building["id"])

    def split_polygon(polygon: Polygon, min_area: float = 1.0) -> list[tuple[tuple[int, int], Polygon]]:
        out: list[tuple[tuple[int, int], Polygon]] = []
        minx, miny, maxx, maxy = polygon.bounds
        for tx in range(math.floor(minx / tile_size), math.floor(maxx / tile_size) + 1):
            for ty in range(math.floor(miny / tile_size), math.floor(maxy / tile_size) + 1):
                if (tx, ty) not in tiles:
                    continue
                tile_rect = box(tx * tile_size, ty * tile_size, (tx + 1) * tile_size, (ty + 1) * tile_size)
                if not polygon.intersects(tile_rect):
                    continue
                piece = polygon.intersection(tile_rect)
                for part in iter_polygons(repair(piece)):
                    if part.area < min_area:
                        continue
                    out.append(((tx, ty), part))
        return out

    for surface in surface_features:
        poly = Polygon(surface["polygon"][0], [Polygon(ring).exterior.coords for ring in surface["polygon"][1:]])
        if not poly.is_valid:
            poly = repair(poly)
        for (tx, ty), piece in split_polygon(poly) if poly is not None else []:
            tiles[(tx, ty)]["surfaces"].append({
                "kind": surface["kind"],
                "polygon": poly_to_rings(piece),
                **({"name": surface["name"]} if surface.get("name") else {}),
            })

    for road in road_polys:
        poly = Polygon(road["polygon"][0], [Polygon(ring).exterior.coords for ring in road["polygon"][1:]])
        if not poly.is_valid:
            poly = repair(poly)
        for (tx, ty), piece in split_polygon(poly) if poly is not None else []:
            tiles[(tx, ty)]["roads"].append({
                "kind": road["kind"],
                "class": road["class"],
                "polygon": poly_to_rings(piece),
                "width": road["width"],
                **({"bridge": True} if road.get("bridge") else {}),
                **({"name": road["name"]} if road.get("name") else {}),
            })

    # --- normalized road surfaces / network / junctions / crossings --------
    for surface in road_surfaces:
        geom = surface.get("geom")
        if geom is None or geom.is_empty:
            continue
        if not geom.is_valid:
            geom = repair(geom)
        if geom is None or geom.is_empty:
            continue
        for (tx, ty), piece in split_polygon(geom, min_area=0.005):
            # Snap to the 1 cm payload grid BEFORE serialising: rounding raw
            # shapely output independently per ring can create self-touching
            # polygons, and invalid pieces broke exact tile-seam matching and
            # the audit's boolean operations.
            try:
                snapped = set_precision(piece, 0.01)
            except Exception:
                snapped = repair(piece)
            if snapped is None or snapped.is_empty:
                snapped = piece
            parts = iter_polygons(snapped)
            if not parts:
                parts = iter_polygons(piece)
            for part in parts:
                if part.area < 0.005:
                    continue
                rings = payload_rings(part)
                if not rings or len(rings[0]) < 3:
                    continue
                if ring_area_abs(rings[0]) < 0.01:
                    continue
                record = {
                    "kind": surface["kind"],
                    "polygon": rings,
                }
                if surface.get("material"):
                    record["material"] = surface["material"]
                if surface.get("bridge"):
                    record["bridge"] = True
                if surface.get("junction"):
                    record["junction"] = True
                tiles[(tx, ty)]["roadSurfaces"].append(record)

    # Network centrelines overhang the tile by 4 m so a dash that straddles a
    # tile border is emitted by exactly one tile (the renderer culls bars whose
    # centre is outside the tile bounds).
    for piece in network_pieces:
        flat = piece.get("centerline") or []
        if len(flat) < 4:
            continue
        points = [(flat[i], flat[i + 1]) for i in range(0, len(flat) - 1, 2)]
        line = LineString(points)
        base = {key: value for key, value in piece.items() if key != "centerline"}
        seg_minx, seg_miny, seg_maxx, seg_maxy = line.bounds
        for tx in range(math.floor((seg_minx - 4.0) / tile_size), math.floor((seg_maxx + 4.0) / tile_size) + 1):
            for ty in range(math.floor((seg_miny - 4.0) / tile_size), math.floor((seg_maxy + 4.0) / tile_size) + 1):
                if (tx, ty) not in tiles:
                    continue
                tile_rect = box(tx * tile_size, ty * tile_size, (tx + 1) * tile_size, (ty + 1) * tile_size)
                try:
                    clipped = line.intersection(tile_rect.buffer(4.0))
                except Exception:
                    continue
                for segment in iter_lines(clipped):
                    coords = list(segment.coords)
                    if len(coords) < 2:
                        continue
                    try:
                        offset = piece["centerlineOffset"] + line.project(Point(coords[0][0], coords[0][1]))
                    except Exception:
                        offset = piece["centerlineOffset"]
                    flat_out: list[float] = []
                    for x, y in coords:
                        flat_out.extend((round(float(x), 2), round(float(y), 2)))
                    record = dict(base)
                    record["centerline"] = flat_out
                    record["centerlineOffset"] = round(float(offset), 2)
                    tiles[(tx, ty)]["roadNetwork"].append(record)

    # Junction faces are clipped per tile (payload 0.3.0). A junction is attached
    # to every tile its face touches, so markings near a tile border still know
    # about a junction centred in the neighbouring tile. Duplicated small
    # records are intentional (same as the legacy clearance circles).
    for junction in junction_features:
        polygon = junction.get("polygon")
        base = {key: value for key, value in junction.items() if key != "polygon"}
        attached = 0
        if polygon is not None and hasattr(polygon, "is_empty") and not polygon.is_empty:
            for (tx, ty), piece in split_polygon(polygon, min_area=1.0):
                if piece.is_empty or piece.area < 1.0:
                    continue
                piece = repair(piece)
                if piece is None or piece.is_empty or piece.area < 1.0:
                    continue
                try:
                    piece = set_precision(piece, 0.01)
                except Exception:
                    piece = repair(piece)
                if piece is None or piece.is_empty or piece.area < 1.0:
                    continue
                for part in iter_polygons(piece):
                    if part.area < 1.0:
                        continue
                    rings = payload_rings(part)
                    if not rings:
                        continue
                    try:
                        check = Polygon(rings[0], rings[1:])
                    except Exception:
                        continue
                    if not check.is_valid or check.area < 1.0:
                        continue
                    record = dict(base)
                    record["polygon"] = rings
                    tiles[(tx, ty)]["junctions"].append(record)
                    attached += 1
        if attached:
            continue
        radius = float(junction["radius"])
        x, y = float(junction["x"]), float(junction["y"])
        for tx in range(math.floor((x - radius - 1.0) / tile_size), math.floor((x + radius + 1.0) / tile_size) + 1):
            for ty in range(math.floor((y - radius - 1.0) / tile_size), math.floor((y + radius + 1.0) / tile_size) + 1):
                if (tx, ty) in tiles:
                    tiles[(tx, ty)]["junctions"].append(base)

    # Bridge decks (0.4.2): b-strokes become raised 3D slabs with their own
    # texture strokes; tiny bridge bits stay on the ground, flattened.
    t_decks = time.time()
    decks_by_tile, deck_shadows, ground_strokes, deck_stats = bridge_decks(
        ground_strokes, tile_size, tiles.keys()
    )
    stats.update(deck_stats)
    for key, decks in decks_by_tile.items():
        if decks:
            tiles[key]["ground"]["decks"] = decks
    for key, shades in assign_fills_to_tiles(deck_shadows, tile_size, tiles.keys(), GROUND_STROKE_MARGIN_M).items():
        if shades:
            tiles[key]["ground"]["shadows"] = shades
    print(f"Bridge decks: {deck_stats.get('decks', 0)} deck(s), {deck_stats.get('deck_chunks', 0)} chunk(s), "
          f"{deck_stats.get('deck_m2', 0)} m2, {deck_stats.get('deck_ends', 0)} end(s), "
          f"{deck_stats.get('deck_no_ends', 0)} without ends, {deck_stats.get('deck_flattened', 0)} flattened, "
          f"{deck_stats.get('deck_too_small', 0)} too small in {time.time() - t_decks:.1f}s")

    # Ground strokes: clipped per tile with a 64 m margin (> any half-width +
    # sidewalk), so stroke caps created by clipping stay outside the tile.
    for key, strokes in assign_strokes_to_tiles(
        ground_strokes, tile_size, tiles.keys(), GROUND_STROKE_MARGIN_M
    ).items():
        tiles[key]["ground"]["strokes"] = strokes
    for key, fills in assign_fills_to_tiles(
        ground_fills, tile_size, tiles.keys(), GROUND_STROKE_MARGIN_M
    ).items():
        if fills:
            tiles[key]["ground"]["fills"] = fills
    # Carriageway closing: gores, junction islands and slivers between ribbons
    # become asphalt (ground_strokes.carriageway_closing).
    protected_geoms: list = []
    for stroke in ground_strokes:
        if stroke.get("k") in ("tram", "rail") and len(stroke.get("p") or []) >= 4:
            protected_geoms.append(
                LineString(list(zip(stroke["p"][0::2], stroke["p"][1::2]))).buffer(
                    (float(stroke["w"]) + 1.2) / 2.0, quad_segs=4
                )
            )
    for fill in ground_fills:
        if fill.get("m") in ("tram", "platform"):
            ring = list(zip(fill["p"][0::2], fill["p"][1::2]))
            if len(ring) >= 3:
                protected_geoms.append(repair(Polygon(ring)))
    protected_kinds = {"grass", "park", "forest", "scrub", "cemetery", "water", "river", "pitch", "plaza", "sand"}
    for surface in surface_features:
        if surface["kind"] not in protected_kinds:
            continue
        rings = surface["polygon"]
        try:
            protected_geoms.append(repair(Polygon(rings[0], [Polygon(r).exterior.coords for r in rings[1:]])))
        except Exception:
            continue
    for building in buildings:
        for volume in building.get("volumes", []):
            footprint = volume.get("footprint") or []
            if footprint and len(footprint[0]) >= 3:
                try:
                    protected_geoms.append(repair(Polygon(footprint[0])))
                except Exception:
                    continue
    t_close = time.time()
    closing_fills, closing_stats = carriageway_closing(
        ground_strokes,
        [fill for fill in ground_fills if fill.get("m") == "asphalt"],
        protected_geoms,
        tile_size,
        tiles.keys(),
        GROUND_STROKE_MARGIN_M,
    )
    stats.update(closing_stats)
    for key, fills in closing_fills.items():
        if fills:
            tiles[key]["ground"].setdefault("fills", []).extend(fills)
    print(f"Carriageway closing: {closing_stats.get('close_fill_parts', 0)} fill part(s), "
          f"{closing_stats.get('close_fill_m2', 0)} m2; holes filled "
          f"{closing_stats.get('close_holes_filled', 0)} ({closing_stats.get('close_holes_filled_m2', 0)} m2), "
          f"protected {closing_stats.get('close_holes_protected', 0)}, "
          f"large {closing_stats.get('close_holes_large', 0)} in {time.time() - t_close:.1f}s")
    for key, dividers in assign_fills_to_tiles(
        ground_dividers, tile_size, tiles.keys(), GROUND_STROKE_MARGIN_M
    ).items():
        if dividers:
            tiles[key]["ground"]["dividers"] = dividers
    # Data extent: the renderer clips the ground to it, so ways cut at the area
    # border end in a straight edge instead of round stroke caps.
    for key in tiles:
        tiles[key]["ground"]["clip"] = list(bounds)

    # Ground compositor crossings: attached to every tile within 12 m so a zebra
    # straddling a tile border is painted identically on both sides.
    for crossing in crossing_features:
        cx, cy = float(crossing["x"]), float(crossing["y"])
        for tx in range(math.floor((cx - 12.0) / tile_size), math.floor((cx + 12.0) / tile_size) + 1):
            for ty in range(math.floor((cy - 12.0) / tile_size), math.floor((cy + 12.0) / tile_size) + 1):
                if (tx, ty) in tiles:
                    tiles[(tx, ty)]["ground"].setdefault("crossings", []).append(crossing)

    for crossing in crossing_features:
        owner = tile_of_point(crossing["x"], crossing["y"])
        if owner is not None:
            tiles[owner]["crossings"].append(crossing)

    assigned_trees = 0
    for tree in trees:
        owner = tile_of_point(tree["x"], tree["y"])
        if owner is None:
            continue
        tiles[owner]["trees"].append(tree)
        assigned_trees += 1
    if assigned_trees != len(trees):
        print(
            f"ERROR: {len(trees) - assigned_trees:,} trees have no owning tile "
            "(boundary ownership bug); refusing to write a partial dataset",
            file=sys.stderr,
        )
        return 1

    for attraction in attractions:
        owner = tile_of_point(attraction["x"], attraction["y"])
        if owner is not None:
            tiles[owner].setdefault("attractions", []).append(attraction)

    # --- write tiles ------------------------------------------------------
    tiles_dir.mkdir(parents=True, exist_ok=True)
    for stale in tiles_dir.glob("*.json"):
        stale.unlink()
    manifest_tiles = []
    total_bytes = 0
    for (tx, ty), tile in sorted(tiles.items()):
        payload = json.dumps(tile, ensure_ascii=False, separators=(",", ":"))
        file_name = f"{tx}_{ty}.json"
        (tiles_dir / file_name).write_text(payload, encoding="utf-8")
        size = len(payload.encode("utf-8"))
        total_bytes += size
        manifest_tiles.append({
            "x": tx,
            "y": ty,
            "file": f"tiles/{file_name}",
            "buildings": len(tile["buildings"]),
            "bytes": size,
        })

    heights_explicit = sum(1 for b in buildings if b["volumes"][0]["heightSource"] == "osm_height")
    heights_levels = sum(1 for b in buildings if b["volumes"][0]["heightSource"] == "osm_levels")
    heights_inferred = sum(1 for b in buildings if b["volumes"][0]["heightSource"] in {"heuristic", "default"})
    roof_explicit_count = sum(1 for b in buildings if b.get("roofShapeExplicit"))
    pitched = sum(1 for b in buildings if b["roofShape"] != "flat")

    manifest = {
        "version": "0.4.3",
        "generatedAt": time.strftime("%Y-%m-%d", time.gmtime()),
        "epsg": EPSG_UTM35N,
        "originUtm": [round(ORIGIN_X, 3), round(ORIGIN_Y, 3)],
        "centerLatLon": [PILOT_CENTER_LAT, PILOT_CENTER_LON],
        "tileSize": tile_size,
        "tileRange": {"minX": min_tx, "minY": min_ty, "maxX": max_tx, "maxY": max_ty},
        # bounds = full extent covered by the tile grid (what the renderer can
        # stream); areaBounds = the requested map area inside it. `pilotBounds`
        # is kept as a deprecated alias of areaBounds for older consumers.
        "bounds": [
            min_tx * tile_size,
            min_ty * tile_size,
            (max_tx + 1) * tile_size,
            (max_ty + 1) * tile_size,
        ],
        "areaBounds": list(bounds),
        "pilotBounds": list(bounds),
        "tiles": manifest_tiles,
        "counts": {
            "buildings": len(buildings),
            "buildingsWithExplicitHeight": heights_explicit,
            "buildingsWithLevels": heights_levels,
            "buildingsWithRoofShape": roof_explicit_count,
            "surfaces": sum(len(t["surfaces"]) for t in tiles.values()),
            "roads": sum(len(t["roads"]) for t in tiles.values()),
            "roadSurfaces": sum(len(t["roadSurfaces"]) for t in tiles.values()),
            "roadNetwork": sum(len(t["roadNetwork"]) for t in tiles.values()),
            "junctions": sum(len(t["junctions"]) for t in tiles.values()),
            "crossings": sum(len(t["crossings"]) for t in tiles.values()),
            "trees": len(trees),
            "attractions": len(attractions),
        },
        "attribution": [
            {
                "name": "OpenStreetMap",
                "url": "https://www.openstreetmap.org/copyright",
                "licence": "ODbL 1.0",
                "note": "Buildings, roads, landuse, trees. В© OpenStreetMap contributors",
            },
            {
                "name": "Geofabrik",
                "url": "https://download.geofabrik.de/europe/belarus.html",
                "licence": "ODbL 1.0",
                "note": f"OSM extract {raw['meta']['pbf']}",
            },
        ],
    }
    (tiles_dir / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8"
    )
    print(f"Wrote {len(manifest_tiles)} tiles, {total_bytes / 1e6:.2f} MB total")

    # --- coverage report --------------------------------------------------
    coverage = {
        "generatedAt": manifest["generatedAt"],
        "source": raw["meta"],
        "area": {
            "tileSizeM": tile_size,
            "boundsLocal": list(bounds),
            "spanM": [maxx - minx, maxy - miny],
            "originUtm": manifest["originUtm"],
        },
        "buildings": {
            "total": len(buildings),
            "withExplicitHeight": heights_explicit,
            "withExplicitHeightPct": round(100 * heights_explicit / max(1, len(buildings)), 1),
            "withLevels": heights_levels,
            "withLevelsPct": round(100 * heights_levels / max(1, len(buildings)), 1),
            "heightInferred": heights_inferred,
            "heightInferredPct": round(100 * heights_inferred / max(1, len(buildings)), 1),
            "withExplicitRoofShape": roof_explicit_count,
            "withExplicitRoofShapePct": round(100 * roof_explicit_count / max(1, len(buildings)), 1),
            "withPitchedRoof": pitched,
            "byArchetype": dict(archetype_counts),
            "byRoofShape": dict(roof_shape_counts),
            "byHeightSource": dict(height_source_counts),
            "withBuildingParts": len(part_groups),
        },
        "geometry": {
            "invalidBuildings": stats.get("buildings_invalid", 0),
            "sliverBuildings": stats.get("buildings_sliver", 0),
            "emptyVolumeBuildings": stats.get("buildings_empty_volumes", 0),
            "orphanParts": stats.get("orphan_parts", 0),
            "tunnelsSkipped": stats.get("tunnels_skipped", 0),
            "duplicatesDropped": duplicates_dropped,
            "nearMissCollisionsKeptApart": near_misses_kept,
        },
        "curation": {
            "roadTagOverrides": [
                {"id": f"{osm_type[0]}{osm_id}", **override}
                for (osm_type, osm_id), override in ROAD_TAG_OVERRIDES.items()
            ],
            "roadTagOverridesApplied": stats.get("road_tag_overrides", 0),
            "landmarkOverrides": [
                {"id": f"{osm_type[0]}{osm_id}", **override}
                for (osm_type, osm_id), override in LANDMARK_OVERRIDES.items()
            ],
            "duplicateAggregatesSkipped": [
                {"id": f"{osm_type[0]}{osm_id}", "reason": reason}
                for (osm_type, osm_id), reason in CURATED_DUPLICATE_IDS.items()
            ],
            "duplicateAggregatesSkippedCount": stats.get("curated_duplicates_skipped", 0),
            "partParents": [
                {"part": f"w{part_id}", "parent": f"{parent_type[0]}{parent_id}"}
                for part_id, (parent_type, parent_id) in CURATED_PART_PARENTS.items()
            ],
            "partParentsForced": stats.get("curated_parts_parented", 0),
            "note": (
                "Hand-reviewed OSM mapping fixes for individual landmarks. Only feature "
                "metadata is overridden; every rendered volume still comes from OSM."
            ),
        },
        "environment": {
            "surfacePolygons": len(surface_features),
            "roadPolygons": len(road_polys),
            "roadSurfaces": len(road_surfaces),
            "roadNetworkPieces": len(network_pieces),
            "junctions": len(junction_features),
            "crossings": len(crossing_features),
            "roadNormalization": road_stats,
            "treesMapped": stats["trees_mapped"],
            "treesMappedPoints": stats["trees_mapped_points"],
            "treesMappedRows": stats["trees_mapped_rows"],
            "treesHeuristic": stats["trees_heuristic"],
            "treesBudgetScale": tree_stats["trees_budget_scale"],
            "treesBudgetTargetTotal": tree_stats["trees_budget_target_total"],
            "treesHeuristicByClass": tree_stats["trees_heuristic_by_class"],
            "treesZones": tree_stats["trees_zones"],
            "treesZonesByClass": tree_stats["trees_zones_by_class"],
            "treesZoneAreaM2ByClass": tree_stats["trees_zone_area_m2_by_class"],
            "treesTileThinned": tree_stats["trees_tile_thinned"],
            "treesTilesWithTrees": tree_stats["trees_tiles_with_trees"],
            "treesMaxPerTile": tree_stats["trees_max_per_tile"],
            "treesTriangles": tree_stats["trees_triangles"],
            "treesMaxTrianglesPerTile": tree_stats["trees_max_triangles_per_tile"],
            "treesTriangleScale": tree_stats["trees_triangle_scale"],
            "treesTriangleThinned": tree_stats["trees_triangle_thinned"],
            "attractions": len(attractions),
        },
        "externalHeightData": {
            "used": False,
            "note": (
                "No external height dataset is used. GlobalBuildingAtlas LoD1/height data is "
                "licensed non-commercially and was not integrated; OSM height/level tags plus "
                "documented architectural heuristics are the only height sources."
            ),
        },
        "warnings": warnings,
    }
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    coverage_path.write_text(json.dumps(coverage, ensure_ascii=False, indent=1), encoding="utf-8")
    # Full normalised city payload (debug/validation; not served to the browser)
    out_path.write_text(
        json.dumps(
            {
                "meta": manifest,
                "buildings": buildings,
                "surfaces": surface_features,
                "roads": road_polys,
                "roadSurfaces": [
                    {
                        "kind": surface["kind"],
                        **({"material": surface["material"]} if surface.get("material") else {}),
                        **({"bridge": True} if surface.get("bridge") else {}),
                        "area": round(float(surface["geom"].area), 1),
                    }
                    for surface in road_surfaces
                ],
                "roadNetwork": network_pieces,
                "junctions": [
                    {
                        **{key: value for key, value in junction.items() if key != "polygon"},
                        **(
                            {"polygon": payload_rings(junction["polygon"])}
                            if junction.get("polygon") is not None
                            else {}
                        ),
                    }
                    for junction in junction_features
                ],
                "crossings": crossing_features,
                "trees": trees,
                "attractions": attractions,
            },
            ensure_ascii=False,
            separators=(",", ":"),
        ),
        encoding="utf-8",
    )
    print(f"Coverage report: {coverage_path}")
    print(json.dumps(coverage["buildings"], ensure_ascii=False)[:400])
    print(f"Done in {time.time() - t_start:.1f}s")
    profile("tiles written + coverage")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
