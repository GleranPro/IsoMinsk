"""Extract the Isometric Minsk pilot area from an OSM PBF extract.

Works with either the BBBike Minsk city extract (~35 MB, default) or the
Geofabrik Belarus country extract (~350 MB, fallback). Both are OSM data under
ODbL 1.0 (see docs/DATA_SOURCES.md).

pyosmium's C++ node-location index is used so that only ways/relations are handed
to Python. Three cheap passes over the file:

  A. relations (no geometry needed): keep multipolygon/building relations and
     remember the way ids that form their rings.
  B. ways (with node locations): buildings, roads, rails, waterways, land
     surfaces, plus the ring geometries of the relations collected in pass A.
  C. tag-filtered pass: individually mapped trees (natural=tree).

Output (data/interim/minsk_raw.geojson) is a GeoJSON-ish document where each
feature carries its OSM id/type and the original tags. Projection, validation,
height inference and tile splitting happen in the next stage.

Usage:
    python scripts/ingest/extract.py [--pbf data/raw/Minsk.osm.pbf]
                                     [--out data/interim/minsk_raw.geojson]
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import osmium  # noqa: E402

from geo_config import (  # noqa: E402
    EPSG_UTM35N,
    EPSG_WGS84,
    PILOT_CENTER_LAT,
    PILOT_CENTER_LON,
    area_bbox,
    ingest_bbox,
)

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


def configure_window(area: str) -> None:
    """Set the extraction window for 'pilot' (default) or 'city'."""
    global _BBOX, MIN_LAT, MIN_LON, MAX_LAT, MAX_LON
    _BBOX = area_bbox(area)
    MIN_LAT = _BBOX[0] - PAD_LAT
    MIN_LON = _BBOX[1] - PAD_LON
    MAX_LAT = _BBOX[2] + PAD_LAT
    MAX_LON = _BBOX[3] + PAD_LON


def inside_window(lat: float, lon: float) -> bool:
    return MIN_LAT <= lat <= MAX_LAT and MIN_LON <= lon <= MAX_LON


# Extra margin used for the cheap first-node early-out on ways (a road segment
# crossing the window may have its first vertex a little outside it).
EARLY_OUT_PAD_LAT = 0.02
EARLY_OUT_PAD_LON = 0.03


# --- tag filters ------------------------------------------------------------

def is_building(tags: dict[str, str]) -> bool:
    return bool(tags.get("building")) or tags.get("building:part") == "yes"


SURFACE_VALUES = {
    "grass", "park", "forest", "wood", "scrub", "water", "riverbank", "reservoir",
    "sand", "beach", "pitch", "cemetery", "railway", "plaza", "square",
    "residential", "industrial", "commercial", "construction", "orchard",
    "meadow", "village_green", "recreation_ground", "school", "university",
    "hospital", "theatre", "museum", "fountain", "garden", "fitness_station",
}

HIGHWAY_VALUES = {
    "motorway", "motorway_link", "trunk", "trunk_link", "primary", "primary_link",
    "secondary", "secondary_link", "tertiary", "tertiary_link", "residential",
    "unclassified", "service", "living_street", "pedestrian", "footway",
    "cycleway", "path", "steps", "track", "construction", "road",
}

RAILWAY_VALUES = {"rail", "tram", "light_rail", "subway", "narrow_gauge", "monorail"}
WATERWAY_VALUES = {"river", "stream", "canal", "drain", "ditch"}

KEEP_TAG_PREFIXES = ("building", "roof", "addr", "height", "min_height", "levels")
KEEP_TAGS = {
    "name", "name:ru", "name:be", "name:en", "amenity", "tourism", "landuse",
    "leisure", "natural", "waterway", "highway", "railway", "shop", "office",
    "historic", "religion", "denomination", "man_made", "public_transport",
    "width", "lanes", "surface", "bridge", "tunnel", "layer", "oneway",
    "place", "admin_level", "building:levels", "building:min_level",
    "roof:levels", "start_date", "ele",
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
        # cheap early-out: a feature that matters for the pilot window has at
        # least one vertex near it; testing the first node avoids building
        # coordinate lists for the rest of the city extract.
        first = None
        for n in way.nodes:
            if n.location.valid():
                first = n.location
                break
        if first is None:
            return
        if not (
            MIN_LAT - EARLY_OUT_PAD_LAT <= first.lat <= MAX_LAT + EARLY_OUT_PAD_LAT
            and MIN_LON - EARLY_OUT_PAD_LON <= first.lon <= MAX_LON + EARLY_OUT_PAD_LON
        ):
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


# --- pass C: trees ----------------------------------------------------------

class TreeCollector:
    def __init__(self) -> None:
        self.trees: list[dict] = []

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
        pass

    def relation(self, rel) -> None:
        pass


# --- helpers ----------------------------------------------------------------

def feature_in_window(feature: dict) -> bool:
    """Keep features that have at least one vertex inside the padded window."""
    geom = feature["geometry"]
    if geom["type"] == "Polygon":
        for ring in geom["coordinates"]:
            for lon, lat in ring:
                if inside_window(lat, lon):
                    return True
        return False
    for lon, lat in geom["coordinates"]:
        if inside_window(lat, lon):
            return True
    return False


def assemble_relation_features(relations: list[dict], way_coords: dict[int, list[list[float]]]) -> list[dict]:
    """Turn collected relations + resolved way geometries into polygon features."""
    features: list[dict] = []
    for relation in relations:
        rings: list[list[list[float]]] = []
        for _role, way_id in relation["members"]:
            coords = way_coords.get(way_id)
            if not coords or len(coords) < 3:
                continue
            ring = coords[:]
            if ring[0] != ring[-1]:
                ring.append(ring[0])
            rings.append(ring)
        if not rings:
            continue
        features.append({
            "kind": relation["kind"],
            "osm_type": "relation",
            "osm_id": relation["osm_id"],
            "tags": relation["tags"],
            "geometry": {"type": "Polygon", "coordinates": rings},
        })
    return features


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

    print(f"PBF: {pbf} ({pbf.stat().st_size / 1e6:.1f} MB)")
    print(f"Area: {args.area}")
    print(f"Window (lat_min, lon_min, lat_max, lon_max): "
          f"{MIN_LAT:.6f}, {MIN_LON:.6f}, {MAX_LAT:.6f}, {MAX_LON:.6f}")

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
    relation_features = assemble_relation_features(rc.relations, wc.way_coords)
    print(f"[pass B] ways: {len(wc.features):,} features, "
          f"{len(wc.way_coords):,} relation rings resolved, "
          f"{len(relation_features):,} relation polygons "
          f"(missing node locations: {wc.missing_locations:,}) in {time.time() - t1:.1f}s")

    # pass C вЂ” trees
    t2 = time.time()
    tc = TreeCollector()
    fp = osmium.FileProcessor(str(pbf)).with_filter(
        osmium.filter.TagFilter(("natural", "tree"))
    )
    for obj in fp:
        if isinstance(obj, osmium.osm.Node):
            tc.node(obj)
    print(f"[pass C] {len(tc.trees):,} mapped trees in {time.time() - t2:.1f}s")

    all_features = wc.features + relation_features
    kept = [f for f in all_features if feature_in_window(f)]
    print(f"[filter] kept {len(kept):,} / {len(all_features):,} features")

    counts = {
        "buildings": sum(1 for f in kept if f["kind"] == "building"),
        "highways": sum(1 for f in kept if f["kind"] == "highway"),
        "railways": sum(1 for f in kept if f["kind"] == "railway"),
        "waterways": sum(1 for f in kept if f["kind"] == "waterway"),
        "surfaces": sum(1 for f in kept if f["kind"] == "surface"),
        "trees": len(tc.trees),
    }

    doc = {
        "meta": {
            "source": "OpenStreetMap",
            "source_url": str(pbf.name),
            "pbf": pbf.name,
            "pbf_size": pbf.stat().st_size,
            "extracted_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "bbox": list(_BBOX),
            "area": args.area,
            "window": [MIN_LAT, MIN_LON, MAX_LAT, MAX_LON],
            "center": [PILOT_CENTER_LAT, PILOT_CENTER_LON],
            "epsg": EPSG_UTM35N,
            "source_srs": EPSG_WGS84,
            "attribution": "(c) OpenStreetMap contributors, ODbL 1.0",
            "counts": counts,
        },
        "features": kept,
    }
    with out.open("w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=False, separators=(",", ":"))
    with trees_out.open("w", encoding="utf-8") as fh:
        json.dump({"trees": tc.trees}, fh, ensure_ascii=False, separators=(",", ":"))
    print(f"Wrote {out.name} ({out.stat().st_size / 1e6:.2f} MB) and {trees_out.name}")
    print(f"Counts: {counts}")
    print(f"Total time: {time.time() - t0:.1f}s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
