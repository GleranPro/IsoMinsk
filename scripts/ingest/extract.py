"""Extract the Isometric Minsk pilot area from an OSM PBF extract.

Works with either the BBBike Minsk city extract (~35 MB, default) or the
Geofabrik Belarus country extract (~350 MB, fallback). Both are OSM data under
ODbL 1.0 (see docs/DATA_SOURCES.md).

pyosmium's C++ node-location index is used so that only ways/relations are handed
to Python. Cheap passes over the file:

  A. relations (no geometry needed): keep multipolygon/building relations and
     remember the way ids that form their rings.
  B. ways (with node locations): buildings, roads, rails, waterways, land
     surfaces, plus the ring geometries of the relations collected in pass A.
  C. tag-filtered pass: individually mapped trees (natural=tree) and tree rows
     (natural=tree_row, emitted as lines; payload 0.4.3).
  D. tag-filtered pass: non-building attractions (ferris wheels).
  E. tag-filtered pass: pedestrian crossings and traffic-signal nodes
     (payload 0.2.0 road network; see docs/ROAD_NETWORK.md).

Output (data/interim/minsk_raw.geojson) is a GeoJSON-ish document where each
feature carries its OSM id/type and the original tags. Projection, validation,
height inference and tile splitting happen in the next stage.

Usage:
    python scripts/ingest/extract.py [--pbf data/raw/Minsk.osm.pbf]
                                     [--out data/interim/minsk_raw.geojson]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import osmium  # noqa: E402
from pyproj import Transformer  # noqa: E402
from shapely.geometry import LineString, Polygon, mapping  # noqa: E402
from shapely.ops import polygonize, unary_union  # noqa: E402

from geo_config import (  # noqa: E402
    EPSG_UTM35N,
    EPSG_WGS84,
    PILOT_CENTER_LAT,
    PILOT_CENTER_LON,
    ingest_bbox,
)
from geo_window import area_window_wgs84  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]

# Preferred raw source: the BBBike city extract for Minsk (~35 MB, weekly update).
# Fallback: the Geofabrik country extract for Belarus (~350 MB).
DEFAULT_PBF_CANDIDATES = [
    ROOT / "data/raw/Minsk.osm.pbf",
    ROOT / "data/raw/belarus-latest.osm.pbf",
]

# --- geometry window --------------------------------------------------------
# The extraction window is the requested area padded so that roads and rivers
# crossing the boundary still have complete geometry (clipped during
# normalisation). `configure_window('pilot' | 'city')` sets it before the passes.
PAD_LAT = 0.012
PAD_LON = 0.020

_BBOX = ingest_bbox()
MIN_LAT, MIN_LON, MAX_LAT, MAX_LON = (
    _BBOX[0] - PAD_LAT,
    _BBOX[1] - PAD_LON,
    _BBOX[2] + PAD_LAT,
    _BBOX[3] + PAD_LON,
)


def _city_window() -> tuple[float, float, float, float]:
    """Exact WGS84 window for the city area: target rectangle + CITY_HALO_M."""
    return area_window_wgs84("city")


def configure_window(area: str) -> None:
    """Set the extraction window for 'pilot' (default) or 'city'."""
    global _BBOX, MIN_LAT, MIN_LON, MAX_LAT, MAX_LON
    if area == "city":
        # The halo is already part of the window: no extra PAD for geometry.
        _BBOX = _city_window()
        MIN_LAT, MIN_LON, MAX_LAT, MAX_LON = _BBOX
        return
    _BBOX = ingest_bbox()
    MIN_LAT = _BBOX[0] - PAD_LAT
    MIN_LON = _BBOX[1] - PAD_LON
    MAX_LAT = _BBOX[2] + PAD_LAT
    MAX_LON = _BBOX[3] + PAD_LON


def inside_window(lat: float, lon: float) -> bool:
    return MIN_LAT <= lat <= MAX_LAT and MIN_LON <= lon <= MAX_LON


# A way that crosses the window may have every vertex outside it (a bridge over
# the area, a ring enclosing it): selection is bbox-based, never first-node
# based, so such geometries are kept instead of being silently dropped.
def bbox_intersects_window(
    min_lat: float, min_lon: float, max_lat: float, max_lon: float
) -> bool:
    return not (
        max_lat < MIN_LAT or min_lat > MAX_LAT
        or max_lon < MIN_LON or min_lon > MAX_LON
    )


# --- tag filters ------------------------------------------------------------

def is_building(tags: dict[str, str]) -> bool:
    return bool(tags.get("building")) or tags.get("building:part") == "yes"


SURFACE_VALUES = {
    "grass", "park", "forest", "wood", "scrub", "water", "riverbank", "reservoir",
    "sand", "beach", "pitch", "cemetery", "railway", "plaza", "square",
    "residential", "industrial", "commercial", "construction", "orchard",
    "meadow", "village_green", "recreation_ground", "school", "university",
    "hospital", "theatre", "museum", "fountain", "garden", "fitness_station",
    # amenity=parking areas (payload 0.4.1: painted as asphalt).
    "parking",
}

HIGHWAY_VALUES = {
    "motorway", "motorway_link", "trunk", "trunk_link", "primary", "primary_link",
    "secondary", "secondary_link", "tertiary", "tertiary_link", "residential",
    "unclassified", "service", "living_street", "pedestrian", "footway",
    "cycleway", "path", "steps", "track", "construction", "road",
}

RAILWAY_VALUES = {"rail", "tram", "light_rail", "subway", "narrow_gauge", "monorail"}
WATERWAY_VALUES = {"river", "stream", "canal", "drain", "ditch"}

KEEP_TAG_PREFIXES = ("building", "roof", "addr", "height", "min_height", "levels", "parking:")
KEEP_TAGS = {
    "name", "name:ru", "name:be", "name:en", "amenity", "tourism", "landuse",
    "leisure", "natural", "waterway", "highway", "railway", "shop", "office",
    "historic", "religion", "denomination", "man_made", "public_transport",
    "width", "lanes", "surface", "bridge", "tunnel", "layer", "oneway",
    "place", "admin_level", "building:levels", "building:min_level",
    "roof:levels", "start_date", "ele",
    # Airfield geometry (B-2: Lipki runways/taxiways/aprons/helipads).
    "aeroway",
    # Tags that drive road material, lane markings, pavements, crossings and
    # traffic signals (payload 0.2.0, see scripts/normalize/road_network.py).
    "cycleway", "cycleway:left", "cycleway:right",
    "sidewalk", "footway",
    "crossing", "crossing:ref", "crossing_ref", "crossing:markings",
    "traffic_signals", "parking", "junction",
    "lanes:forward", "lanes:backward",
    "sidewalk:width", "sidewalk:both:width", "sidewalk:left:width",
    "sidewalk:right:width",
    # Tram stop / platform nodes (payload 0.4.1).
    "tram",
    # What a highway=construction way will become (payload 0.4.2).
    "construction",
}
MAX_TAGS = 48


def filter_tags(tags) -> dict[str, str]:
    out: dict[str, str] = {}
    for key, value in tags.items():
        if key in KEEP_TAGS or any(key.startswith(prefix) for prefix in KEEP_TAG_PREFIXES):
            out[key] = value
            if len(out) >= MAX_TAGS:
                break
    return out


def surface_kind(tags: dict[str, str]) -> str | None:
    """Return the surface key that makes this closed way a ground polygon."""
    for key in ("landuse", "leisure", "natural", "amenity", "place", "man_made", "tourism"):
        value = tags.get(key)
        if value and value in SURFACE_VALUES:
            return key
    return None


def round_coords(coords: list[tuple[float, float]]) -> list[list[float]]:
    return [[round(lon, 7), round(lat, 7)] for lon, lat in coords]


def sha256_file(path: Path) -> str:
    """SHA-256 of the pinned source file, recorded in the extraction metadata."""
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


# --- pass A: relations ------------------------------------------------------

class RelationCollector:
    """Collect relevant multipolygon/boundary relations and their member ids."""

    def __init__(self) -> None:
        self.relations: list[dict] = []
        self.needed_ways: set[int] = set()

    def node(self, obj) -> None:
        pass

    def way(self, obj) -> None:
        pass

    def relation(self, rel) -> None:
        tags = {t.k: t.v for t in rel.tags}
        if not tags or tags.get("type") not in {"multipolygon", "boundary"}:
            return
        is_bld = is_building(tags)
        is_water = tags.get("natural") == "water" or tags.get("waterway") == "riverbank"
        is_land = surface_kind(tags) is not None
        if not (is_bld or is_water or is_land):
            return
        members: list[tuple[str, int]] = []
        for member in rel.members:
            if member.type != "w":
                continue
            members.append((member.role or "", member.ref))
            self.needed_ways.add(member.ref)
        if not members:
            return
        self.relations.append({
            "osm_id": rel.id,
            "tags": filter_tags(tags),
            "members": members,
            "kind": "building" if is_bld else "surface",
        })


# --- pass B: ways -----------------------------------------------------------

class WayCollector:
    def __init__(self, needed_ways: set[int]):
        self.needed_ways = needed_ways
        self.way_coords: dict[int, list[list[float]]] = {}
        self.features: list[dict] = []
        self.missing_locations = 0
        self.skipped = 0

    def node(self, obj) -> None:
        pass

    def relation(self, obj) -> None:
        pass

    def _coords(self, way) -> list[list[float]]:
        coords: list[tuple[float, float]] = []
        for n in way.nodes:
            if not n.location.valid():
                self.missing_locations += 1
                continue
            coords.append((n.location.lon, n.location.lat))
        return round_coords(coords)

    def _add(self, osm_id: int, tags: dict[str, str], geometry: dict, kind: str) -> None:
        self.features.append({
            "kind": kind,
            "osm_type": "way",
            "osm_id": osm_id,
            "tags": tags,
            "geometry": geometry,
        })

    def way(self, way) -> None:
        tags = {t.k: t.v for t in way.tags}
        if way.id in self.needed_ways:
            coords = self._coords(way)
            if coords:
                self.way_coords[way.id] = coords
        if not tags:
            return
        # Window selection uses the way's node bbox: a geometry crossing the
        # window may have no vertex inside it (a bridge over the area, a ring
        # enclosing it), so a first-node test would drop valid features.
        min_lat = min_lon = math.inf
        max_lat = max_lon = -math.inf
        for n in way.nodes:
            if not n.location.valid():
                continue
            lat, lon = n.location.lat, n.location.lon
            if lat < min_lat:
                min_lat = lat
            if lat > max_lat:
                max_lat = lat
            if lon < min_lon:
                min_lon = lon
            if lon > max_lon:
                max_lon = lon
        if math.isinf(min_lat):
            return
        if not bbox_intersects_window(min_lat, min_lon, max_lat, max_lon):
            return
        coords = self._coords(way)
        if len(coords) < 2:
            self.skipped += 1
            return
        closed = len(coords) > 3 and coords[0] == coords[-1]
        stags = filter_tags(tags)

        if is_building(tags) and closed:
            self._add(way.id, stags, {"type": "Polygon", "coordinates": [coords]}, "building")
            return
        highway = tags.get("highway")
        if highway in HIGHWAY_VALUES:
            self._add(way.id, stags, {"type": "LineString", "coordinates": coords}, "highway")
            return
        if tags.get("railway") in RAILWAY_VALUES:
            self._add(way.id, stags, {"type": "LineString", "coordinates": coords}, "railway")
            return
        if tags.get("waterway") in WATERWAY_VALUES:
            self._add(way.id, stags, {"type": "LineString", "coordinates": coords}, "waterway")
            return
        if closed and surface_kind(tags):
            self._add(way.id, stags, {"type": "Polygon", "coordinates": [coords]}, "surface")
            return
        aeroway = tags.get("aeroway")
        if aeroway in {"runway", "taxiway", "apron", "helipad"}:
            if closed and aeroway in {"apron", "helipad"}:
                self._add(way.id, stags, {"type": "Polygon", "coordinates": [coords]}, "aeroway")
            elif not closed:
                self._add(way.id, stags, {"type": "LineString", "coordinates": coords}, "aeroway")


# --- pass C: trees ----------------------------------------------------------

_TREE_ROW_TRANSFORMER = Transformer.from_crs(EPSG_WGS84, EPSG_UTM35N, always_xy=True)


def _tree_row_length_m(coords: list[list[float]]) -> float:
    """Metres along a lon/lat polyline (UTM 35N, accurate enough for a log line)."""
    return LineString([_TREE_ROW_TRANSFORMER.transform(c[0], c[1]) for c in coords]).length


class TreeCollector:
    """Collect individually mapped trees (nodes) and tree rows (ways).

    Tree rows are the OSM `natural=tree_row` ways: real avenues and cemetery
    alleys. They are kept as lon/lat lines (`coords`) and turned into points by
    the normaliser (7 m spacing), so the extraction stays cheap and the spacing
    rule lives in one place (`scripts/normalize/trees.py`).
    """

    def __init__(self) -> None:
        self.trees: list[dict] = []
        self.rows: list[dict] = []

    def node(self, node) -> None:
        tags = {t.k: t.v for t in node.tags}
        if tags.get("natural") != "tree":
            return
        if not node.location.valid():
            return
        lat, lon = node.location.lat, node.location.lon
        if not inside_window(lat, lon):
            return
        self.trees.append({
            "osm_id": node.id,
            "lat": round(lat, 7),
            "lon": round(lon, 7),
            "height": tags.get("height"),
            "species": tags.get("species"),
            "crown": tags.get("diameter_crown") or tags.get("crown_diameter"),
        })

    def way(self, way) -> None:
        tags = {t.k: t.v for t in way.tags}
        if tags.get("natural") != "tree_row":
            return
        coords: list[tuple[float, float]] = []
        any_inside = False
        for n in way.nodes:
            if not n.location.valid():
                continue
            lat, lon = n.location.lat, n.location.lon
            coords.append((lon, lat))
            if inside_window(lat, lon):
                any_inside = True
        if len(coords) < 2 or not any_inside:
            return
        # A row that runs out of the window is kept whole: the normaliser clips
        # it to the area when it turns the line into points.
        self.rows.append({
            "osm_id": way.id,
            "coords": round_coords(coords),
            "leaf_type": tags.get("leaf_type"),
            "height": tags.get("height"),
        })

    def relation(self, rel) -> None:
        pass


# --- pass D: non-building attractions (ferris wheels) -----------------------

ATTRACTION_TAGS = (
    ("attraction", "big_wheel"),
    ("attraction", "ferris_wheel"),
    ("man_made", "ferris_wheel"),
)


class AttractionCollector:
    """Collect park attractions mapped as standalone OSM nodes.

    Ferris wheels in Minsk are nodes tagged `attraction=big_wheel` with a
    `height`; the pipeline adds the curated radius/cabins/orientation.
    """

    def __init__(self) -> None:
        self.features: list[dict] = []

    def node(self, node) -> None:
        tags = {t.k: t.v for t in node.tags}
        if not any(tags.get(key) == value for key, value in ATTRACTION_TAGS):
            return
        if not node.location.valid():
            return
        lat, lon = node.location.lat, node.location.lon
        if not inside_window(lat, lon):
            return
        self.features.append({
            "kind": "attraction",
            "osm_type": "node",
            "osm_id": node.id,
            "tags": filter_tags(tags),
            "geometry": {"type": "Point", "coordinates": [round(lon, 7), round(lat, 7)]},
        })

    def way(self, way) -> None:
        pass

    def relation(self, rel) -> None:
        pass


# --- pass E: crossings / traffic signals -----------------------------------

class CrossingCollector:
    """Collect pedestrian crossing and traffic-signal nodes in the window.

    Both `highway=crossing` (marked/unmarked crossing) and
    `highway=traffic_signals` (signal head) nodes are emitted as `crossing`
    point features. The normaliser projects each one onto the nearest drivable
    road centreline and turns it into a `CrossingFeature` (payload 0.2.0) for
    the renderer (zebra bars, stop lines).
    """

    def __init__(self) -> None:
        self.features: list[dict] = []

    def node(self, node) -> None:
        tags = {t.k: t.v for t in node.tags}
        kind = None
        if tags.get("highway") in {"crossing", "traffic_signals"}:
            kind = "crossing"
        elif tags.get("railway") == "tram_stop" or (
            tags.get("tram") == "yes"
            and tags.get("public_transport") in {"stop_position", "platform"}
        ):
            # Tram stops / platform nodes → synthetic platforms (payload 0.4.1).
            kind = "transit_stop"
        if kind is None:
            return
        if not node.location.valid():
            return
        lat, lon = node.location.lat, node.location.lon
        if not inside_window(lat, lon):
            return
        self.features.append({
            "kind": kind,
            "osm_type": "node",
            "osm_id": node.id,
            "tags": filter_tags(tags),
            "geometry": {"type": "Point", "coordinates": [round(lon, 7), round(lat, 7)]},
        })

    def way(self, way) -> None:
        pass

    def relation(self, rel) -> None:
        pass


# --- helpers ----------------------------------------------------------------

def feature_in_window(feature: dict) -> bool:
    """Keep features whose geometry bbox intersects the extraction window.

    A polygon that encloses the window, or a line crossing it with both end
    points outside, has no vertex inside the window; a vertex test would drop
    it. The bbox test is conservative (over-inclusion is clipped later by the
    normaliser).
    """
    coords = feature["geometry"].get("coordinates", [])
    min_lat = min_lon = math.inf
    max_lat = max_lon = -math.inf

    def scan(node) -> None:
        nonlocal min_lat, min_lon, max_lat, max_lon
        if isinstance(node, (list, tuple)):
            if len(node) == 2 and all(isinstance(value, (int, float)) for value in node):
                lon, lat = node
                if lat < min_lat:
                    min_lat = lat
                if lat > max_lat:
                    max_lat = lat
                if lon < min_lon:
                    min_lon = lon
                if lon > max_lon:
                    max_lon = lon
                return
            for child in node:
                scan(child)

    scan(coords)
    if math.isinf(min_lat):
        return False
    return bbox_intersects_window(min_lat, min_lon, max_lat, max_lon)


def assemble_relation_features(
    relations: list[dict], way_coords: dict[int, list[list[float]]]
) -> tuple[list[dict], dict]:
    """Turn collected relations + resolved member ways into polygon features.

    Multipolygon relations MUST be assembled with their member roles: `outer`
    ways form the shells, `inner` ways the holes. The earlier implementation
    concatenated every ring into one ``Polygon`` (first ring = shell, all others
    = holes). For relations with several unrelated outer rings that is invalid
    geometry, and ``make_valid`` in the normaliser repaired it into large spurious
    areas — e.g. the Svislach river relation 14605048 flooded the Yanka Kupala
    park between the circus and the opera with a ~13 hectare "lake".

    Outer ways may also be split into multiple segments, so the linework is
    noded (`unary_union`) and rebuilt with `polygonize` before the inner rings
    are subtracted.
    """
    features: list[dict] = []
    stats = {
        "assembled": 0,
        "multipolygons": 0,
        "fallbacks": 0,
        "missing_outer": 0,
        "empty": 0,
        "emptyRelations": [],
    }

    def note_empty(reason: str) -> None:
        """Record which relations assembled to nothing (review evidence)."""
        if len(stats["emptyRelations"]) < 20:
            stats["emptyRelations"].append({
                "osm_id": relation["osm_id"],
                "name": relation["tags"].get("name"),
                "kind": relation["kind"],
                "reason": reason,
            })
    for relation in relations:
        outer_lines: list[LineString] = []
        inner_rings: list[list[list[float]]] = []
        for role, way_id in relation["members"]:
            coords = way_coords.get(way_id)
            # Member ways are frequently short 2-point segments of a shared
            # boundary (the Svislach river and Yanka Kupala park are both split
            # into such pieces). They must all take part in the polygonize step;
            # dropping anything shorter than 3 points left the ring open and the
            # whole relation was lost.
            if not coords or len(coords) < 2:
                continue
            if role == "inner":
                ring = [list(coord) for coord in coords]
                if ring[0] != ring[-1]:
                    ring.append(ring[0])
                inner_rings.append(ring)
            else:
                outer_lines.append(LineString(coords))
        if not outer_lines:
            stats["missing_outer"] += 1
            continue

        geometry = None
        try:
            shells = list(polygonize(unary_union(outer_lines)))
            if shells:
                geometry = unary_union(shells)
                if inner_rings:
                    holes = [Polygon(ring) for ring in inner_rings if len(ring) >= 4]
                    if holes:
                        hole_union = unary_union(holes)
                        if not hole_union.is_empty:
                            geometry = geometry.difference(hole_union)
            else:
                stats["fallbacks"] += 1
                geometry = unary_union(
                    [Polygon(line.coords) for line in outer_lines if len(line.coords) >= 4]
                )
        except Exception:
            stats["fallbacks"] += 1
            try:
                geometry = unary_union(
                    [Polygon(line.coords) for line in outer_lines if len(line.coords) >= 4]
                )
            except Exception:
                geometry = None
        if geometry is None or geometry.is_empty:
            stats["empty"] += 1
            note_empty("no assembled geometry")
            continue
        if not geometry.is_valid:
            geometry = geometry.buffer(0)
        if geometry.is_empty:
            stats["empty"] += 1
            note_empty("empty after validity repair")
            continue
        mapped = mapping(geometry)
        if mapped["type"] not in {"Polygon", "MultiPolygon"}:
            stats["empty"] += 1
            note_empty("assembled geometry is not a polygon")
            continue
        stats["assembled"] += 1
        if mapped["type"] == "MultiPolygon":
            stats["multipolygons"] += 1
        features.append({
            "kind": relation["kind"],
            "osm_type": "relation",
            "osm_id": relation["osm_id"],
            "tags": relation["tags"],
            "geometry": mapped,
        })
    return features, stats


def main() -> int:
    parser = argparse.ArgumentParser()
    default_pbf = next((p for p in DEFAULT_PBF_CANDIDATES if p.exists()), DEFAULT_PBF_CANDIDATES[0])
    parser.add_argument("--pbf", default=str(default_pbf))
    parser.add_argument("--area", choices=["pilot", "city"], default="pilot",
                        help="pilot (1.6 km central area) or city (12 km belt)")
    parser.add_argument("--out", default=None)
    parser.add_argument("--trees-out", default=None)
    args = parser.parse_args()

    configure_window(args.area)
    out = Path(args.out) if args.out else ROOT / (
        "data/interim/city_raw.geojson" if args.area == "city" else "data/interim/minsk_raw.geojson"
    )
    trees_out = Path(args.trees_out) if args.trees_out else ROOT / (
        "data/interim/city_trees.json" if args.area == "city" else "data/interim/minsk_trees.json"
    )

    pbf = Path(args.pbf)
    if not pbf.exists():
        print(f"ERROR: PBF not found: {pbf}\nRun: npm run data:download", file=sys.stderr)
        return 1
    out.parent.mkdir(parents=True, exist_ok=True)

    pbf_sha256 = sha256_file(pbf)
    print(f"PBF: {pbf} ({pbf.stat().st_size / 1e6:.1f} MB, sha256 {pbf_sha256[:12]}…)")
    print(f"Area: {args.area}")
    print(f"Window (lat_min, lon_min, lat_max, lon_max): "
          f"{MIN_LAT:.6f}, {MIN_LON:.6f}, {MAX_LAT:.6f}, {MAX_LON:.6f}")

    # The header bbox is a cheap sanity check that the pinned extract really
    # covers the requested window; it is not proof of relation completeness.
    header = osmium.io.Reader(str(pbf)).header()
    header_box = header.box()
    if header_box is not None:
        min_lon = header_box.bottom_left.lon
        min_lat = header_box.bottom_left.lat
        max_lon = header_box.top_right.lon
        max_lat = header_box.top_right.lat
        print(f"PBF header bbox: lon {min_lon:.4f}..{max_lon:.4f}, "
              f"lat {min_lat:.4f}..{max_lat:.4f}")
        covered = (
            MIN_LAT >= min_lat - 1e-6 and MAX_LAT <= max_lat + 1e-6
            and MIN_LON >= min_lon - 1e-6 and MAX_LON <= max_lon + 1e-6
        )
        if not covered:
            print(
                "ERROR: PBF header bbox does not cover the extraction window.\n"
                f"  window: lat {MIN_LAT:.6f}..{MAX_LAT:.6f}, "
                f"lon {MIN_LON:.6f}..{MAX_LON:.6f}\n"
                f"  header: lat {min_lat:.6f}..{max_lat:.6f}, "
                f"lon {min_lon:.6f}..{max_lon:.6f}\n"
                "Pass a larger extract with --pbf.",
                file=sys.stderr,
            )
            return 1

    t0 = time.time()

    # pass A вЂ” relations
    rc = RelationCollector()
    fp = osmium.FileProcessor(str(pbf)).with_filter(
        osmium.filter.EntityFilter(osmium.osm.RELATION)
    )
    for obj in fp:
        rc.relation(obj)
    print(f"[pass A] relevant relations: {len(rc.relations):,} "
          f"({len(rc.needed_ways):,} member ways) in {time.time() - t0:.1f}s")

    # pass B вЂ” ways + relation member geometries
    t1 = time.time()
    wc = WayCollector(rc.needed_ways)
    fp = (
        osmium.FileProcessor(str(pbf))
        .with_locations("flex_mem")
        .with_filter(osmium.filter.EntityFilter(osmium.osm.WAY))
    )
    for obj in fp:
        wc.way(obj)
    relation_features, relation_stats = assemble_relation_features(rc.relations, wc.way_coords)
    print(f"[pass B] ways: {len(wc.features):,} features, "
          f"{len(wc.way_coords):,} relation rings resolved, "
          f"{len(relation_features):,} relation polygons "
          f"(assembled {relation_stats['assembled']:,}, multipolygons {relation_stats['multipolygons']:,}, "
          f"fallbacks {relation_stats['fallbacks']:,}, missing outer {relation_stats['missing_outer']:,}, "
          f"empty {relation_stats['empty']:,}; "
          f"missing node locations: {wc.missing_locations:,}) in {time.time() - t1:.1f}s")

    # pass C — trees and tree rows
    t2 = time.time()
    tc = TreeCollector()
    fp = (
        osmium.FileProcessor(str(pbf))
        .with_locations("flex_mem")
        .with_filter(osmium.filter.TagFilter(("natural", "tree"), ("natural", "tree_row")))
    )
    for obj in fp:
        if isinstance(obj, osmium.osm.Node):
            tc.node(obj)
        elif isinstance(obj, osmium.osm.Way):
            tc.way(obj)
    row_km = sum(
        _tree_row_length_m(row["coords"]) for row in tc.rows if len(row["coords"]) >= 2
    ) / 1e3
    print(f"[pass C] {len(tc.trees):,} mapped trees, {len(tc.rows):,} tree rows "
          f"(~{row_km:.1f} km) in {time.time() - t2:.1f}s")

    # pass D вЂ” non-building attractions (ferris wheels)
    t3 = time.time()
    ac = AttractionCollector()
    fp = osmium.FileProcessor(str(pbf)).with_filter(osmium.filter.TagFilter(*ATTRACTION_TAGS))
    for obj in fp:
        if isinstance(obj, osmium.osm.Node):
            ac.node(obj)
    print(f"[pass D] {len(ac.features):,} attraction nodes in {time.time() - t3:.1f}s")

    # pass E - crossings / traffic signals (point features)
    t4 = time.time()
    cc = CrossingCollector()
    fp = osmium.FileProcessor(str(pbf)).with_filter(
        osmium.filter.TagFilter(
            ("highway", "crossing"),
            ("highway", "traffic_signals"),
            ("railway", "tram_stop"),
            ("public_transport", "stop_position"),
            ("public_transport", "platform"),
        )
    )
    for obj in fp:
        if isinstance(obj, osmium.osm.Node):
            cc.node(obj)
    print(f"[pass E] {len(cc.features):,} crossing/signal nodes in {time.time() - t4:.1f}s")

    all_features = wc.features + relation_features + ac.features + cc.features
    kept = [f for f in all_features if feature_in_window(f)]
    print(f"[filter] kept {len(kept):,} / {len(all_features):,} features")

    counts = {
        "buildings": sum(1 for f in kept if f["kind"] == "building"),
        "highways": sum(1 for f in kept if f["kind"] == "highway"),
        "railways": sum(1 for f in kept if f["kind"] == "railway"),
        "waterways": sum(1 for f in kept if f["kind"] == "waterway"),
        "surfaces": sum(1 for f in kept if f["kind"] == "surface"),
        "attractions": sum(1 for f in kept if f["kind"] == "attraction"),
        "crossings": sum(1 for f in kept if f["kind"] == "crossing"),
        "transit_stops": sum(1 for f in kept if f["kind"] == "transit_stop"),
        "trees": len(tc.trees),
        "tree_rows": len(tc.rows),
    }

    doc = {
        "meta": {
            "source": "OpenStreetMap",
            "source_url": str(pbf.name),
            "pbf": pbf.name,
            "pbf_size": pbf.stat().st_size,
            "pbf_sha256": pbf_sha256,
            "extracted_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "bbox": list(_BBOX),
            "area": args.area,
            "window": [MIN_LAT, MIN_LON, MAX_LAT, MAX_LON],
            "center": [PILOT_CENTER_LAT, PILOT_CENTER_LON],
            "epsg": EPSG_UTM35N,
            "source_srs": EPSG_WGS84,
            "attribution": "(c) OpenStreetMap contributors, ODbL 1.0",
            "counts": counts,
            "relationAssembly": relation_stats,
        },
        "features": kept,
    }
    with out.open("w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=False, separators=(",", ":"))
    trees_doc = {
        "meta": {
            "area": args.area,
            "epsg": EPSG_UTM35N,
            "center": [PILOT_CENTER_LAT, PILOT_CENTER_LON],
            "pbf": pbf.name,
            "pbf_size": pbf.stat().st_size,
            "pbf_sha256": pbf_sha256,
            "window": [MIN_LAT, MIN_LON, MAX_LAT, MAX_LON],
            "extracted_at": doc["meta"]["extracted_at"],
        },
        "trees": tc.trees,
        "rows": tc.rows,
    }
    with trees_out.open("w", encoding="utf-8") as fh:
        json.dump(trees_doc, fh, ensure_ascii=False, separators=(",", ":"))
    print(f"Wrote {out.name} ({out.stat().st_size / 1e6:.2f} MB) and {trees_out.name}")
    print(f"Counts: {counts}")
    print(f"Total time: {time.time() - t0:.1f}s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
