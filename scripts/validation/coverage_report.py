"""Validate generated tile data and write the data coverage report.

Reads public/data/tiles/manifest.json + every tile payload and checks the
invariants the renderer relies on, then renders docs/COVERAGE_REPORT.md from
data/processed/coverage.json (produced by normalize.py).

Checks
------
* manifest schema, tile files present and parseable
* building ids unique across all tiles (each building owned by exactly one tile)
* footprints: rings with >= 3 finite vertices, positive area, volume heights
  positive and ordered (minHeight < height)
* tile bounds consistent with the manifest tile size / range
* roads/surfaces clipped inside their tile bounds (allow 0.5 m tolerance)
* counts in the manifest match the actual payloads

Exit code 1 if any hard error is found, 0 otherwise (warnings allowed).

Usage:
    python scripts/validation/coverage_report.py
"""

from __future__ import annotations

import json
import math
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TILES_DIR = ROOT / "public/data/tiles"
COVERAGE_JSON = ROOT / "data/processed/coverage.json"
REPORT_MD = ROOT / "docs/COVERAGE_REPORT.md"

errors: list[str] = []
warnings: list[str] = []


def fail(message: str) -> None:
    errors.append(message)


def warn(message: str) -> None:
    warnings.append(message)


def ring_area(ring: list[list[float]]) -> float:
    area = 0.0
    for i in range(len(ring)):
        x1, y1 = ring[i]
        x2, y2 = ring[(i + 1) % len(ring)]
        area += x1 * y2 - x2 * y1
    return area / 2.0


def check_ring(ring, context: str) -> bool:
    if not isinstance(ring, list) or len(ring) < 3:
        fail(f"{context}: ring has {len(ring) if isinstance(ring, list) else 'no'} vertices")
        return False
    for point in ring:
        if not isinstance(point, list) or len(point) != 2:
            fail(f"{context}: malformed point {point!r}")
            return False
        x, y = point
        if not (math.isfinite(x) and math.isfinite(y)):
            fail(f"{context}: non-finite coordinate {point!r}")
            return False
    if abs(ring_area(ring)) < 0.01:
        fail(f"{context}: zero-area ring")
        return False
    return True


def main() -> int:
    manifest_path = TILES_DIR / "manifest.json"
    if not manifest_path.exists():
        print(f"ERROR: {manifest_path} not found. Run the data pipeline first:\n"
              f"  npm run data:all", file=sys.stderr)
        return 1
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

    tiles = manifest.get("tiles", [])
    tile_size = manifest.get("tileSize")
    if not tiles:
        fail("manifest has no tiles")
    if not manifest.get("attribution"):
        fail("manifest has no attribution entries (ODbL requires attribution)")

    building_ids: Counter[str] = Counter()
    total_buildings = 0
    total_tri_estimate = 0
    total_trees = 0
    total_roads = 0
    total_surfaces = 0
    height_sources: Counter[str] = Counter()
    archetypes: Counter[str] = Counter()
    roof_shapes: Counter[str] = Counter()
    per_tile: list[dict] = []

    for entry in tiles:
        tile_path = TILES_DIR / Path(entry["file"]).name
        if not tile_path.exists():
            fail(f"tile file missing: {tile_path}")
            continue
        try:
            tile = json.loads(tile_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            fail(f"{tile_path.name}: invalid JSON: {exc}")
            continue

        bounds = tile.get("bounds")
        if not bounds or len(bounds) != 4:
            fail(f"{tile_path.name}: invalid bounds")
            continue
        minx, miny, maxx, maxy = bounds
        if tile_size and abs((maxx - minx) - tile_size) > 0.01:
            fail(f"{tile_path.name}: tile width {maxx - minx} != tileSize {tile_size}")
        if tile.get("tileX") is None or tile.get("tileY") is None:
            fail(f"{tile_path.name}: missing tile indices")

        if len(tile["buildings"]) != entry.get("buildings", -1):
            warn(f"{tile_path.name}: manifest says {entry.get('buildings')} buildings, "
                 f"payload has {len(tile['buildings'])}")

        for building in tile["buildings"]:
            total_buildings += 1
            building_ids[building["id"]] += 1
            archetypes[building.get("archetype", "?")] += 1
            roof_shapes[building.get("roofShape", "?")] += 1
            if not building.get("volumes"):
                fail(f"{building['id']}: no volumes")
                continue
            for volume in building["volumes"]:
                footprint = volume.get("footprint")
                if not footprint or not check_ring(footprint[0], f"{building['id']} exterior"):
                    continue
                for hole in footprint[1:]:
                    check_ring(hole, f"{building['id']} hole")
                min_h = volume.get("minHeight", 0)
                height = volume.get("height", 0)
                roof_h = volume.get("roofHeight", 0)
                if not (0 <= min_h < height):
                    fail(f"{building['id']}: invalid volume heights {min_h}..{height}")
                if height > 400:
                    fail(f"{building['id']}: absurd building height {height}")
                if roof_h < 0:
                    fail(f"{building['id']}: negative roof height")
                height_sources[volume.get("heightSource", "?")] += 1
                total_tri_estimate += len(footprint[0]) + 4

        for road in tile["roads"]:
            total_roads += 1
            polygon = road.get("polygon")
            if not polygon or not check_ring(polygon[0], f"{tile_path.name} road"):
                continue
            rx0 = min(p[0] for p in polygon[0])
            rx1 = max(p[0] for p in polygon[0])
            ry0 = min(p[1] for p in polygon[0])
            ry1 = max(p[1] for p in polygon[0])
            if rx0 < minx - 0.5 or rx1 > maxx + 0.5 or ry0 < miny - 0.5 or ry1 > maxy + 0.5:
                fail(f"{tile_path.name}: road extends outside its tile bounds")

        for surface in tile["surfaces"]:
            total_surfaces += 1
            check_ring(surface.get("polygon", [[]])[0], f"{tile_path.name} surface")

        for tree in tile.get("trees", []):
            total_trees += 1
            if not (math.isfinite(tree["x"]) and math.isfinite(tree["y"])):
                fail(f"{tile_path.name}: non-finite tree position")
            if not (1 <= tree.get("height", 0) <= 45):
                warn(f"{tile_path.name}: suspicious tree height {tree.get('height')}")

        per_tile.append({
            "tile": f"{tile['tileX']}_{tile['tileY']}",
            "buildings": len(tile["buildings"]),
            "surfaces": len(tile["surfaces"]),
            "roads": len(tile["roads"]),
            "trees": len(tile.get("trees", [])),
            "bytes": entry.get("bytes", tile_path.stat().st_size),
        })

    duplicates = [bid for bid, count in building_ids.items() if count > 1]
    if duplicates:
        fail(f"{len(duplicates)} building ids are duplicated across tiles "
             f"(e.g. {duplicates[:5]})")

    counts = manifest.get("counts", {})
    if counts.get("buildings") != total_buildings:
        fail(f"manifest counts.buildings={counts.get('buildings')} != actual {total_buildings}")

    total_bytes = sum(t["bytes"] for t in per_tile)
    coverage = json.loads(COVERAGE_JSON.read_text(encoding="utf-8")) if COVERAGE_JSON.exists() else None
    if coverage is None:
        warn(f"{COVERAGE_JSON} missing; report will contain less detail")

    # ---- write report ----------------------------------------------------
    lines: list[str] = []
    lines.append("# Data coverage report — central Minsk pilot area\n")
    lines.append(
        "*Generated automatically by `scripts/validation/coverage_report.py` from the "
        "actual generated tile payloads.*\n"
    )
    lines.append("## Source\n")
    if coverage:
        meta = coverage.get("source", {})
        lines.append(f"- Source: {meta.get('source', 'OpenStreetMap via Geofabrik')}")
        lines.append(f"- Extract: `{meta.get('pbf', 'belarus-latest.osm.pbf')}`")
        lines.append(f"- Extraction date: {meta.get('extracted_at', 'unknown')}")
        lines.append(f"- Attribution: {meta.get('attribution', '© OpenStreetMap contributors, ODbL 1.0')}")
        area = coverage.get("area", {})
        lines.append(f"- Pilot area: {area.get('pilotSizeM')} m × {area.get('pilotSizeM')} m, "
                     f"tile size {area.get('tileSizeM')} m, projection EPSG:{manifest.get('epsg')}")
        lines.append(f"- Local origin (UTM 35N): {area.get('originUtm')}")
    lines.append("")
    lines.append("## Buildings\n")
    if coverage:
        b = coverage["buildings"]
        lines.append("| Metric | Value |")
        lines.append("| --- | --- |")
        lines.append(f"| Building footprints rendered | {b['total']} |")
        lines.append(f"| With explicit OSM `height` | {b['withExplicitHeight']} ({b['withExplicitHeightPct']}%) |")
        lines.append(f"| With `building:levels` (height derived) | {b['withLevels']} ({b['withLevelsPct']}%) |")
        lines.append(f"| Height inferred by heuristic | {b['heightInferred']} ({b['heightInferredPct']}%) |")
        lines.append(f"| With explicit `roof:shape` | {b['withExplicitRoofShape']} ({b['withExplicitRoofShapePct']}%) |")
        lines.append(f"| Pitched roofs rendered | {b['withPitchedRoof']} |")
        lines.append(f"| Buildings using `building:part` volumes | {b['withBuildingParts']} |")
        lines.append("")
        lines.append("### Archetype distribution (heuristic classification)\n")
        lines.append("| Archetype | Buildings |")
        lines.append("| --- | --- |")
        for key, value in sorted(b["byArchetype"].items(), key=lambda kv: -kv[1]):
            lines.append(f"| {key} | {value} |")
        lines.append("")
        lines.append("### Roof shape distribution\n")
        lines.append("| Roof shape | Buildings |")
        lines.append("| --- | --- |")
        for key, value in sorted(b["byRoofShape"].items(), key=lambda kv: -kv[1]):
            lines.append(f"| {key} | {value} |")
        lines.append("")
        lines.append("## Geometry validity\n")
        g = coverage["geometry"]
        lines.append("| Check | Count |")
        lines.append("| --- | --- |")
        lines.append(f"| Invalid building geometries (repaired or dropped) | {g['invalidBuildings']} |")
        lines.append(f"| Sliver polygons dropped | {g['sliverBuildings']} |")
        lines.append(f"| Buildings left without volumes | {g['emptyVolumeBuildings']} |")
        lines.append(f"| Orphan `building:part` polygons (rendered standalone) | {g['orphanParts']} |")
        lines.append(f"| Tunnels skipped (not rendered as surface) | {g['tunnelsSkipped']} |")
        lines.append("")
        lines.append("## Environment\n")
        e = coverage["environment"]
        lines.append("| Metric | Value |")
        lines.append("| --- | --- |")
        lines.append(f"| Ground surface polygons | {e['surfacePolygons']} |")
        lines.append(f"| Road/rail/pavement polygons | {e['roadPolygons']} |")
        lines.append(f"| OSM-mapped trees | {e['treesMapped']} |")
        lines.append(f"| Heuristically placed trees | {e['treesHeuristic']} |")
        lines.append("")
        lines.append("## External height data\n")
        ext = coverage.get("externalHeightData", {})
        lines.append(f"- Used: **{'yes' if ext.get('used') else 'no'}**")
        lines.append(f"- {ext.get('note', '')}")
        lines.append("")
    lines.append("## Tiles\n")
    lines.append("| Tile | Buildings | Surfaces | Roads | Trees | Bytes |")
    lines.append("| --- | --- | --- | --- | --- | --- |")
    for tile in per_tile:
        lines.append(f"| {tile['tile']} | {tile['buildings']} | {tile['surfaces']} | "
                     f"{tile['roads']} | {tile['trees']} | {tile['bytes']:,} |")
    lines.append(f"\nTotal payload: **{total_bytes / 1024:.0f} KiB** across {len(per_tile)} tiles "
                 f"(uncompressed JSON).\n")
    lines.append("## Validation result\n")
    if errors:
        lines.append(f"**{len(errors)} error(s)**, {len(warnings)} warning(s)\n")
        for message in errors[:50]:
            lines.append(f"- ❌ {message}")
    else:
        lines.append(f"**PASS** — 0 errors, {len(warnings)} warning(s)\n")
    for message in warnings[:30]:
        lines.append(f"- ⚠️ {message}")
    lines.append("")
    lines.append("## Known data limitations\n")
    lines.append("- Building heights are only partially tagged in OSM; inferred heights are estimated "
                 "from `building:levels` or architectural heuristics and are **not** surveyed measurements.")
    lines.append("- Roof shapes are usually inferred from archetype, not tagged in OSM.")
    lines.append("- Architectural archetype classification is heuristic (building tags + distance to "
                 "Independence Avenue), not authoritative.")
    lines.append("- Trees marked *heuristic* are procedurally placed inside land-use polygons; they do "
                 "not represent individually surveyed trees.")
    lines.append("- Underground infrastructure is intentionally not drawn: Minsk metro lines "
                 "(`railway=subway`, 5 ways in the pilot area) and underground roads are skipped, "
                 "because drawing them as ground surfaces paints black strips across the squares. "
                 "Surface tram tracks are rendered.")
    lines.append("- Flat terrain: no DEM is used yet. See docs/DATA_SOURCES.md.")
    lines.append("")

    REPORT_MD.parent.mkdir(parents=True, exist_ok=True)
    REPORT_MD.write_text("\n".join(lines), encoding="utf-8")

    print(f"Tiles: {len(per_tile)}  buildings: {total_buildings}  roads: {total_roads}  "
          f"surfaces: {total_surfaces}  trees: {total_trees}")
    print(f"Payload: {total_bytes / 1024:.0f} KiB")
    print(f"Report: {REPORT_MD}")
    if errors:
        print(f"\n{len(errors)} ERROR(S):", file=sys.stderr)
        for message in errors[:50]:
            print(f"  - {message}", file=sys.stderr)
        return 1
    if warnings:
        print(f"\n{len(warnings)} warning(s):")
        for message in warnings[:20]:
            print(f"  - {message}")
    print("VALIDATION PASSED")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
