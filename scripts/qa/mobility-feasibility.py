"""Read-only inventory for the public transport / street life feasibility study.

Run from the repository root with .venv/Scripts/python.exe.
Writes only the requested JSON report; never regenerates application datasets.
Counts are inventories, not claims of routability or up-to-date transit service.
"""
from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path

import osmium
from pyproj import Transformer
from shapely.geometry import LineString, box

ROOT = Path(__file__).resolve().parents[2]


def read(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def sha256(path: Path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def tile_inventory(name):
    base = ROOT / "public/data" / name
    manifest = read(base / "manifest.json")
    counts = Counter()
    stroke_kinds = Counter()
    source_ids = set()
    for item in manifest["tiles"]:
        path = base / item["file"]
        if not path.exists():
            path = base / Path(item["file"]).name
        tile = read(path)
        for key in ("buildings", "roadNetwork", "junctions", "crossings", "trees"):
            counts[key + "_tile_records"] += len(tile.get(key, []))
        ground = tile.get("ground", {})
        for stroke in ground.get("strokes", []):
            stroke_kinds[stroke["k"]] += 1
            if stroke.get("id") is not None:
                source_ids.add(stroke["id"])
            for key in ("sw", "pk", "ow", "ln"):
                if stroke.get(key):
                    counts["strokes_with_" + key] += 1
        counts["deck_tile_records"] += len(ground.get("decks", []))
        counts["platform_fill_tile_records"] += sum(
            fill.get("m") == "platform" for fill in ground.get("fills", [])
        )
    return {
        "generatedAt": manifest["generatedAt"], "bounds": manifest["bounds"],
        "tileSize": manifest["tileSize"], "tiles": len(manifest["tiles"]),
        "manifestSha256": sha256(base / "manifest.json"),
        "counts": dict(counts), "strokeTileRecordsByKind": dict(stroke_kinds),
        "uniqueStrokeSourceWayIds": len(source_ids),
        "note": "Tile records include border duplicates. Rail strokes may have no source id.",
    }


def raw_inventory(path, manifest):
    raw = read(path)
    transform = Transformer.from_crs(4326, manifest["epsg"], always_xy=True)
    ox, oy = manifest["originUtm"]
    bounds = manifest.get("areaBounds", manifest.get("pilotBounds", manifest["bounds"]))
    region = box(*bounds)
    ids = set()
    counts = Counter()
    highway_classes = Counter()
    railway_classes = Counter()
    for feature in raw["features"]:
        if feature["kind"] not in ("highway", "railway"):
            continue
        geom = feature["geometry"]
        if geom["type"] != "LineString":
            continue
        coords = [(x - ox, y - oy) for x, y in (
            transform.transform(lon, lat) for lon, lat in geom["coordinates"]
        )]
        if len(coords) < 2 or not LineString(coords).intersects(region):
            continue
        ids.add(feature["osm_id"])
        tags = feature["tags"]
        counts[feature["kind"]] += 1
        if feature["kind"] == "highway":
            highway_classes[tags.get("highway", "unknown")] += 1
            for key in ("sidewalk", "footway", "oneway", "bridge", "tunnel", "layer"):
                if key in tags:
                    counts["highways_tagged_" + key] += 1
        else:
            railway_classes[tags.get("railway", "unknown")] += 1
    return {
        "path": str(path.relative_to(ROOT)), "meta": raw["meta"],
        "targetBounds": bounds, "counts": dict(counts),
        "highwayClasses": dict(highway_classes), "railwayClasses": dict(railway_classes),
    }, ids, transform, (ox, oy), region


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default="docs/MOBILITY_DATA_AUDIT_2026-11-16.json")
    args = parser.parse_args()
    scopes = {}
    for name, dataset, raw_path in (
        ("central", "tiles", "data/interim/minsk_raw.geojson"),
        ("city", "city-tiles", "data/interim/city_raw_b2.geojson"),
    ):
        manifest = read(ROOT / "public/data" / dataset / "manifest.json")
        inventory, ids, transform, origin, region = raw_inventory(ROOT / raw_path, manifest)
        scopes[name] = dict(inventory=inventory, ids=ids, transform=transform,
                            origin=origin, region=region, routes=[], stops=Counter(),
                            restrictions=0)
    pbf = ROOT / "data/raw/Minsk.osm.pbf"
    for obj in osmium.FileProcessor(pbf, entities=osmium.osm.RELATION):
        tags = dict(obj.tags)
        kind = tags.get("type")
        if kind not in ("route", "route_master", "restriction"):
            continue
        way_ids = {m.ref for m in obj.members if m.type == "w"}
        for scope in scopes.values():
            if not (way_ids & scope["ids"]):
                continue
            if kind == "restriction":
                scope["restrictions"] += 1
            elif kind == "route":
                scope["routes"].append({
                    "id": obj.id, "mode": tags.get("route"), "ref": tags.get("ref"),
                    "name": tags.get("name"), "wayMembers": len(way_ids),
                    "wayMembersTouchingTarget": len(way_ids & scope["ids"]),
                    "stopOrPlatformMembers": sum(
                        m.role.startswith(("stop", "platform")) for m in obj.members
                    ),
                })
    nodes = osmium.FileProcessor(pbf, entities=osmium.osm.NODE).with_filter(
        osmium.filter.KeyFilter("highway", "railway", "public_transport")
    )
    for node in nodes:
        tags = dict(node.tags)
        categories = []
        if tags.get("highway") == "bus_stop":
            categories.append("highway_bus_stop")
        if tags.get("railway") == "tram_stop":
            categories.append("railway_tram_stop")
        if tags.get("public_transport") in ("platform", "stop_position"):
            categories.append("public_transport_" + tags["public_transport"])
        if not categories or not node.location.valid():
            continue
        for scope in scopes.values():
            x, y = scope["transform"].transform(node.location.lon, node.location.lat)
            ox, oy = scope["origin"]
            minx, miny, maxx, maxy = scope["region"].bounds
            if minx <= x - ox <= maxx and miny <= y - oy <= maxy:
                scope["stops"].update(categories)
    source_hash = sha256(pbf)
    report = {
        "studyDate": "2026-11-16", "pbf": str(pbf.relative_to(ROOT)),
        "pbfBytes": pbf.stat().st_size, "pbfSha256": source_hash,
        "method": [
            "Raw ways are selected by projected LineString intersection with target bounds.",
            "Route/restriction relations touch at least one selected raw way; they may extend outside target.",
            "Relations count variants/directions, not unique passenger-facing route numbers.",
            "Stop node categories can overlap; polygon platforms are not counted here.",
            "No routing, relation geometry continuity, live feed or performance test was performed.",
        ],
        "datasets": {name: tile_inventory(name) for name in (
            "tiles", "city-tiles", "city-tiles-b2", "city-tiles-current"
        )},
        "scopes": {},
    }
    for name, scope in scopes.items():
        routes = scope["routes"]
        pinned = scope["inventory"]["meta"].get("pbf_sha256")
        report["scopes"][name] = {
            **scope["inventory"], "pbfHashMatchesRawMetadata": source_hash == pinned if pinned else None,
            "routeRelationsByMode": dict(Counter(r["mode"] for r in routes)),
            "distinctRouteRefsByMode": {
                mode: len({r["ref"] for r in routes if r["mode"] == mode and r["ref"]})
                for mode in sorted({r["mode"] for r in routes if r["mode"]})
            },
            "restrictionRelationsTouchingTarget": scope["restrictions"],
            "stopNodeCategories": dict(scope["stops"]), "routeRelations": routes,
        }
    destination = ROOT / args.out
    destination.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(str(destination))
    for name, scope in report["scopes"].items():
        print(name, json.dumps({k: scope[k] for k in (
            "counts", "routeRelationsByMode", "distinctRouteRefsByMode",
            "restrictionRelationsTouchingTarget", "stopNodeCategories"
        )}, ensure_ascii=True))


if __name__ == "__main__":
    main()
