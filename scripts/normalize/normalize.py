"""Normalise the raw OSM extract into renderer-ready city data.

Pipeline
--------
raw GeoJSON (WGS84, lon/lat)
  -> project to EPSG:32635 and translate to a local metric origin
  -> repair / validate geometries with shapely, drop slivers
  -> infer building heights, roof shapes and architectural archetypes
    (with explicit provenance for every inferred value)
  -> resolve OSM building:part volumes into non-overlapping volumes
  -> buffer road centre lines into renderable polygons (+ pavements)
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
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from pyproj import Transformer  # noqa: E402
from shapely import make_valid  # noqa: E402
from shapely.geometry import (  # noqa: E402
    GeometryCollection,
    LineString,
    MultiLineString,
    MultiPolygon,
    Point,
    Polygon,
    box,
)
from shapely.ops import polygonize, unary_union  # noqa: E402

from geo_config import (  # noqa: E402
    DEFAULT_FLOOR_HEIGHT_M,
    EPSG_UTM35N,
    EPSG_WGS84,
    MAX_BUILDING_HEIGHT_M,
    MIN_BUILDING_HEIGHT_M,
    PILOT_CENTER_LAT,
    PILOT_CENTER_LON,
    PILOT_SIZE_M,
    TILE_SIZE_M,
)

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


def parse_height(tags: dict[str, str]) -> float | None:
    for key in ("height", "building:height", "est_height"):
        value = parse_number(tags.get(key))
        if value is not None and 0 < value <= MAX_BUILDING_HEIGHT_M:
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

        if building in CIVIC_BUILDINGS or tags.get("amenity") in CIVIC_BUILDINGS:
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
    reads as an artificial skyline. The variation is deterministic (±18 %) and
    is still an INFERENCE — provenance remains `heuristic` in the payload.
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

    # nesting: a polygon is a hole when contained by an odd number of others
    shells: list[Polygon] = []
    for i, poly in enumerate(assembled):
        depth = 0
        representative = poly.representative_point()
        for j, other in enumerate(assembled):
            if i == j:
                continue
            if other.area > poly.area and other.contains(representative):
                depth += 1
        if depth % 2 == 0:
            shells.append(poly)

    result: list[Polygon] = []
    for shell in shells:
        holes: list[list[tuple[float, float]]] = []
        for other in assembled:
            if other is shell or other.area >= shell.area:
                continue
            if shell.contains(other.representative_point()):
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


def feature_polygons(feature: dict) -> list[Polygon]:
    geom = feature["geometry"]
    if geom["type"] != "Polygon":
        return []
    rings = [ring_to_local(ring) for ring in geom["coordinates"]]
    rings = [ring for ring in rings if len(ring) >= 3]
    if not rings:
        return []
    if len(rings) == 1:
        poly = Polygon(rings[0])
        if not poly.is_valid:
            poly = repair(poly) or Polygon()
        return [] if poly.is_empty else [poly]
    return rings_to_polygons(rings)


def feature_line(feature: dict) -> LineString | None:
    geom = feature["geometry"]
    if geom["type"] != "LineString":
        return None
    pts = [to_local(c[0], c[1]) for c in geom["coordinates"]]
    if len(pts) < 2:
        return None
    return LineString(pts)


def parse_width(tags: dict[str, str], default: float) -> float:
    width = parse_number(tags.get("width"))
    if width is not None and 0.5 <= width <= 60:
        return width
    lanes = parse_number(tags.get("lanes"))
    if lanes is not None and 1 <= lanes <= 12:
        return max(default, lanes * 3.1)
    return default


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

ROAD_CLASS_NORMALISE = {
    "motorway_link": "motorway",
    "trunk_link": "trunk",
    "primary_link": "primary",
    "secondary_link": "secondary",
    "tertiary_link": "tertiary",
    "unclassified": "residential",
    "construction": "unknown",
    "road": "unknown",
}


def normalise_road_class(tags: dict[str, str]) -> str:
    raw = tags.get("highway", "unknown")
    return ROAD_CLASS_NORMALISE.get(raw, raw)


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
    return "unknown"


# --- main normalisation -----------------------------------------------------

def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--raw", default=str(RAW))
    parser.add_argument("--trees-raw", default=str(TREES_RAW))
    parser.add_argument("--out", default=str(OUT_DIR / "city_normalized.json"))
    parser.add_argument("--tiles-dir", default=str(TILES_DIR))
    parser.add_argument("--tile-size", type=float, default=TILE_SIZE_M)
    parser.add_argument("--pilot-size", type=float, default=PILOT_SIZE_M)
    args = parser.parse_args()

    raw_path = Path(args.raw)
    if not raw_path.exists():
        print(f"ERROR: raw data not found: {raw_path}\nRun: python scripts/ingest/extract.py", file=sys.stderr)
        return 1
    t_start = time.time()
    with raw_path.open(encoding="utf-8") as fh:
        raw = json.load(fh)
    features = raw["features"]
    print(f"Loaded {len(features):,} raw features from {raw_path.name}")

    tile_size = args.tile_size
    half = args.pilot_size / 2.0
    pilot_rect = box(-half, -half, half, half)

    stats = Counter()
    warnings: list[str] = []

    # --- pass 1: project / validate all polygons ---------------------------
    buildings_raw: list[dict] = []
    parts_raw: list[dict] = []
    surfaces: list[dict] = []
    roads_raw: list[tuple[dict, LineString]] = []
    rails_raw: list[tuple[dict, LineString]] = []
    waterways: list[tuple[dict, LineString]] = []

    for feature in features:
        kind = feature["kind"]
        tags = feature.get("tags", {})
        if kind == "building":
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
                    roads_raw.append(({"tags": tags, "feature": feature}, line))
            elif kind == "railway":
                if tags.get("railway") in {"rail", "tram", "light_rail", "subway"}:
                    rails_raw.append(({"tags": tags, "feature": feature}, line))
            else:
                waterways.append(({"tags": tags, "feature": feature}, line))

    stats["buildings_raw"] = len(buildings_raw)
    stats["building_parts_raw"] = len(parts_raw)
    stats["surfaces_raw"] = len(surfaces)
    stats["roads_raw"] = len(roads_raw)
    stats["rails_raw"] = len(rails_raw)
    stats["waterways_raw"] = len(waterways)
    print(
        f"Projected: buildings={stats['buildings_raw']:,} parts={stats['building_parts_raw']:,} "
        f"surfaces={stats['surfaces_raw']:,} roads={stats['roads_raw']:,} rails={stats['rails_raw']:,} "
        f"| outside={stats['buildings_outside']:,} slivers={stats['buildings_sliver']:,} "
        f"invalid={stats['buildings_invalid']:,} empty={stats['buildings_empty_geom']:,}"
    )

    # --- Independence Avenue reference (for architectural heuristics) ------
    avenue_lines: list[LineString] = []
    AVE_NAME_PATTERNS = ("незалежнасці", "независимости", "independence")
    for entry, line in roads_raw:
        name = entry["tags"].get("name", "").lower()
        if any(pattern in name for pattern in AVE_NAME_PATTERNS):
            avenue_lines.append(line)
    if avenue_lines:
        avenue_geom = unary_union(avenue_lines)
        avenue_is_real = True
    else:
        # fallback: roughly the real axis of the avenue through the pilot centre
        avenue_geom = LineString([(0, -half * 2), (60, half * 2)])
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
    # group parts under the building polygon that contains their centroid
    part_groups: dict[int, list[dict]] = defaultdict(list)
    orphan_parts = 0
    for part in parts_raw:
        centroid = part["polygon"].representative_point()
        best_index = None
        best_area = float("inf")
        for index, building in enumerate(buildings_raw):
            poly = building["polygon"]
            if poly.area < best_area and poly.contains(centroid):
                best_area = poly.area
                best_index = index
        if best_index is None:
            orphan_parts += 1
            # orphan parts become their own volumes via a synthetic building
            buildings_raw.append({"feature": part["feature"], "polygon": part["polygon"]})
            part_groups[len(buildings_raw) - 1].append(part)
        else:
            part_groups[best_index].append(part)
    stats["orphan_parts"] = orphan_parts

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
        wall_top = max(2.0, height - roof_height)

        roof_direction = parse_roof_direction(tags)
        min_height = parse_min_height(tags)

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
            "levels": levels,
            "height": round(overall, 2),
            "roofShape": roof_shape,
            "volumes": volumes,
            "tags": tags_out,
            "address": address,
            "roofShapeExplicit": roof_explicit,
        })

    # --- de-duplicate exact double-mapped buildings ------------------------
    # OSM occasionally contains the same building twice (e.g. a way and a
    # multipolygon relation for one footprint). Rendering both would z-fight.
    source_rank = {"osm_height": 4, "osm_levels": 3, "heuristic": 2, "default": 1}
    deduped: list[dict] = []
    signatures: dict[tuple[int, int, int], int] = {}
    duplicates_dropped = 0
    for candidate in buildings:
        ring = candidate["volumes"][0]["footprint"][0]
        cx = sum(point[0] for point in ring) / len(ring)
        cy = sum(point[1] for point in ring) / len(ring)
        area = abs(
            sum(
                ring[i - 1][0] * ring[i][1] - ring[i][0] * ring[i - 1][1]
                for i in range(len(ring))
            )
        ) / 2.0
        signature = (round(cx / 2.0), round(cy / 2.0), round(area / 20.0))
        existing_index = signatures.get(signature)
        if existing_index is None:
            signatures[signature] = len(deduped)
            deduped.append(candidate)
            continue
        existing = deduped[existing_index]
        if source_rank.get(candidate["volumes"][0]["heightSource"], 0) > source_rank.get(
            existing["volumes"][0]["heightSource"], 0
        ):
            deduped[existing_index] = candidate
        duplicates_dropped += 1
    buildings = deduped
    stats["duplicate_buildings_dropped"] = duplicates_dropped

    stats["buildings"] = len(buildings)
    print(f"Buildings: {len(buildings):,} (duplicates dropped: {duplicates_dropped}) "
          f"(archetypes: {dict(archetype_counts)})")

    # --- road / rail polygons ---------------------------------------------
    def buffer_line(line: LineString, width: float) -> list[Polygon]:
        try:
            buffered = line.buffer(width / 2.0, cap_style=2, join_style=2)
        except Exception:
            return []
        clipped = buffered.intersection(pilot_rect)
        return iter_polygons(repair(clipped))

    road_polys: list[dict] = []
    for entry, line in roads_raw:
        tags = entry["tags"]
        raw_class = tags.get("highway", "unknown")
        road_class = normalise_road_class(tags)
        if road_class not in ROAD_WIDTH and raw_class not in ROAD_WIDTH:
            continue
        base_width = ROAD_WIDTH.get(raw_class, ROAD_WIDTH.get(road_class, 6.0))
        width = parse_width(tags, base_width)
        if tags.get("tunnel") == "yes":
            stats["tunnels_skipped"] += 1
            continue
        is_bridge = tags.get("bridge") == "yes"
        surfaces_list = buffer_line(line, width)
        for poly in surfaces_list:
            if poly.area < 6:
                continue
            road_polys.append({
                "kind": "road" if road_class not in {"footway", "path", "steps", "cycleway", "pedestrian"} else "footway",
                "class": road_class,
                "polygon": poly_to_rings(poly),
                "width": round(width, 2),
                "bridge": is_bridge,
                "name": tags.get("name", ""),
            })
        # pavements for vehicle streets
        if road_class in {"motorway", "trunk", "primary", "secondary", "tertiary", "residential"}:
            pavement_width = 3.0
            try:
                outer = line.buffer(width / 2.0 + pavement_width, cap_style=2, join_style=2)
                inner = line.buffer(width / 2.0, cap_style=2, join_style=2)
                ring = outer.difference(inner).intersection(pilot_rect)
            except Exception:
                continue
            for poly in iter_polygons(repair(ring)):
                if poly.area < 8:
                    continue
                road_polys.append({
                    "kind": "footway",
                    "class": "footway",
                    "polygon": poly_to_rings(poly),
                    "width": round(pavement_width, 2),
                })

    for entry, line in rails_raw:
        tags = entry["tags"]
        railway = tags.get("railway", "rail")
        width = 3.2 if railway == "rail" else 2.8
        for poly in buffer_line(line, width):
            if poly.area < 6:
                continue
            road_polys.append({
                "kind": "rail",
                "class": "unknown",
                "polygon": poly_to_rings(poly),
                "width": width,
                "name": tags.get("name", ""),
            })
    stats["road_polygons"] = len(road_polys)
    print(f"Road/rail polygons: {len(road_polys):,}")

    # --- water from waterways (rivers without polygon areas) --------------
    water_polys: list[dict] = []
    for entry, line in waterways:
        tags = entry["tags"]
        if tags.get("waterway") in {"river", "canal", "stream"}:
            width = parse_number(tags.get("width"))
            if width is None:
                width = 24.0 if tags["waterway"] == "river" else (12.0 if tags["waterway"] == "canal" else 5.0)
            for poly in buffer_line(line, max(4.0, width)):
                water_polys.append({
                    "kind": "river" if tags.get("waterway") == "river" else "water",
                    "polygon": poly_to_rings(poly),
                    "name": tags.get("name", ""),
                })
    stats["water_polygons"] = len(water_polys)

    # --- ground surface list ----------------------------------------------
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
    surface_features.extend(water_polys)
    stats["surfaces"] = len(surface_features)
    print(f"Ground surfaces: {len(surface_features):,}")

    # --- trees ------------------------------------------------------------
    import random

    trees: list[dict] = []
    if Path(args.trees_raw).exists():
        with Path(args.trees_raw).open(encoding="utf-8") as fh:
            tree_doc = json.load(fh)
        for tree in tree_doc.get("trees", []):
            x, y = to_local(tree["lon"], tree["lat"])
            if not (-half <= x <= half and -half <= y <= half):
                continue
            seed = int(tree.get("osm_id", 0)) % 1000 / 1000.0
            height = parse_number(tree.get("height"))
            if height is None or not (2 <= height <= 40):
                height = 7.0 + seed * 8.0
            crown = parse_number(tree.get("crown"))
            radius = crown / 2 if crown and 0.5 <= crown <= 25 else height * 0.32
            trees.append({
                "x": round(x, 2),
                "y": round(y, 2),
                "height": round(height, 2),
                "radius": round(radius, 2),
                "variation": round(seed, 3),
                "mapped": True,
            })
        print(f"Mapped trees: {len(trees):,}")
    else:
        warnings.append("Mapped tree data missing (data/interim/minsk_trees.json).")

    # deterministic vegetation in suitable land-use polygons
    rng = random.Random(20261027)
    placed = 0
    park_polys = [f for f in surface_features if f["kind"] in {"park", "forest", "grass", "scrub"}]
    for surface in park_polys:
        poly = Polygon(surface["polygon"][0], [Polygon(ring).exterior.coords for ring in surface["polygon"][1:]])
        if not poly.is_valid:
            poly = repair(poly)
            if poly is None:
                continue
        polys = iter_polygons(poly)
        for piece in polys:
            minx, miny, maxx, maxy = piece.bounds
            step = 13.0
            if piece.area < 60:
                continue
            x = minx
            while x < maxx:
                y = miny
                while y < maxy:
                    jx = x + rng.uniform(-4.0, 4.0)
                    jy = y + rng.uniform(-4.0, 4.0)
                    if piece.contains(Point(jx, jy)):
                        seed = rng.random()
                        height = 6.5 + seed * 7.5
                        trees.append({
                            "x": round(jx, 2),
                            "y": round(jy, 2),
                            "height": round(height, 2),
                            "radius": round(height * 0.34, 2),
                            "variation": round(seed, 3),
                            "mapped": False,
                        })
                        placed += 1
                    y += step
                x += step
        if placed > 6000:
            break
    stats["trees_mapped"] = sum(1 for tree in trees if tree["mapped"])
    stats["trees_heuristic"] = sum(1 for tree in trees if not tree["mapped"])
    print(f"Trees: {len(trees):,} ({stats['trees_mapped']:,} mapped, {stats['trees_heuristic']:,} heuristic)")

    # --- tile assignment --------------------------------------------------
    min_tx = math.floor(-half / tile_size)
    max_tx = math.floor((half - 1e-6) / tile_size)
    min_ty = math.floor(-half / tile_size)
    max_ty = math.floor((half - 1e-6) / tile_size)

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
                "trees": [],
                "crossingBuildingIds": [],
            }

    def tile_of_point(x: float, y: float) -> tuple[int, int] | None:
        tx = math.floor(x / tile_size)
        ty = math.floor(y / tile_size)
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

    def split_polygon(polygon: Polygon) -> list[tuple[tuple[int, int], Polygon]]:
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
                    if part.area < 1.0:
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

    for tree in trees:
        owner = tile_of_point(tree["x"], tree["y"])
        if owner is not None:
            tiles[owner]["trees"].append(tree)

    # --- write tiles ------------------------------------------------------
    tiles_dir = Path(args.tiles_dir)
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
        "version": "0.1.0",
        "generatedAt": time.strftime("%Y-%m-%d", time.gmtime()),
        "epsg": EPSG_UTM35N,
        "originUtm": [round(ORIGIN_X, 3), round(ORIGIN_Y, 3)],
        "centerLatLon": [PILOT_CENTER_LAT, PILOT_CENTER_LON],
        "tileSize": tile_size,
        "tileRange": {"minX": min_tx, "minY": min_ty, "maxX": max_tx, "maxY": max_ty},
        "bounds": [-half, -half, half, half],
        "tiles": manifest_tiles,
        "counts": {
            "buildings": len(buildings),
            "buildingsWithExplicitHeight": heights_explicit,
            "buildingsWithLevels": heights_levels,
            "buildingsWithRoofShape": roof_explicit_count,
            "surfaces": sum(len(t["surfaces"]) for t in tiles.values()),
            "roads": sum(len(t["roads"]) for t in tiles.values()),
            "trees": len(trees),
        },
        "attribution": [
            {
                "name": "OpenStreetMap",
                "url": "https://www.openstreetmap.org/copyright",
                "licence": "ODbL 1.0",
                "note": "Buildings, roads, landuse, trees. © OpenStreetMap contributors",
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
            "pilotSizeM": args.pilot_size,
            "tileSizeM": tile_size,
            "boundsLocal": [-half, -half, half, half],
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
        },
        "environment": {
            "surfacePolygons": len(surface_features),
            "roadPolygons": len(road_polys),
            "treesMapped": stats["trees_mapped"],
            "treesHeuristic": stats["trees_heuristic"],
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
    coverage_path = OUT_DIR / "coverage.json"
    coverage_path.write_text(json.dumps(coverage, ensure_ascii=False, indent=1), encoding="utf-8")
    # Full normalised city payload (debug/validation; not served to the browser)
    Path(args.out).write_text(
        json.dumps(
            {
                "meta": manifest,
                "buildings": buildings,
                "surfaces": surface_features,
                "roads": road_polys,
                "trees": trees,
            },
            ensure_ascii=False,
            separators=(",", ":"),
        ),
        encoding="utf-8",
    )
    print(f"Coverage report: {coverage_path}")
    print(json.dumps(coverage["buildings"], ensure_ascii=False)[:400])
    print(f"Done in {time.time() - t_start:.1f}s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
