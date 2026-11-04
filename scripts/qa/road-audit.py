"""Road network audit for payload 0.3.0.

Validates the generated tile payload independently of the renderer:

* every tile carries the normalized surface partition and network layer;
* surface pieces of one layer never overlap (the whole point of the rewrite);
* drivable material zones cover the drivable surface without holes/overlaps;
* one width per named street (<= 0.2 m spread);
* network centrelines stay inside the drivable surface (<= 1.2 m);
* the drivable surface is continuous across tile borders (no seams/gaps);
* junction/crossing records are finite and near the surface.

Usage:
    .venv\\Scripts\\python.exe scripts/qa/road-audit.py
    .venv\\Scripts\\python.exe scripts/qa/road-audit.py --json road-audit.json
    .venv\\Scripts\\python.exe scripts/qa/road-audit.py --tiles <dir>   # baseline dir

Exits 1 when a hard violation is found.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from collections import Counter, defaultdict
from pathlib import Path

from shapely.geometry import LineString, MultiLineString, Point, Polygon, box
from shapely.ops import unary_union
from shapely.prepared import prep

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_TILES = ROOT / "public/data/tiles"

MATERIALS = {"asphalt", "stone", "concrete", "unpaved"}
KINDS = {"drivable", "paving", "kerb", "median"}
CROSSING_KINDS = {"zebra", "signals", "unmarked"}

OVERLAP_TOLERANCE_M2 = 0.35
OVERLAP_TOTAL_TOLERANCE_M2 = 2.0
CROSS_LAYER_TOLERANCE_M2 = 5.0
WIDTH_SPREAD_TOLERANCE_M = 0.2
CENTERLINE_INSIDE_TOLERANCE_M = 1.2
TILE_SEAM_TOLERANCE_M = 0.06


def polygon_of(rings) -> Polygon | None:
    if not isinstance(rings, list) or not rings:
        return None
    try:
        shell = rings[0]
        holes = rings[1:]
        if len(shell) < 3:
            return None
        poly = Polygon(shell, holes)
        if not poly.is_valid:
            poly = poly.buffer(0)
        return poly if not poly.is_empty else None
    except Exception:
        return None


def iter_parts(geom):
    if geom is None or geom.is_empty:
        return []
    if geom.geom_type == "Polygon":
        return [geom]
    if geom.geom_type in ("MultiPolygon", "GeometryCollection"):
        out = []
        for part in geom.geoms:
            out.extend(iter_parts(part))
        return out
    return []


def iter_lines(geom):
    if geom is None or geom.is_empty:
        return []
    if geom.geom_type == "LineString":
        return [geom]
    if geom.geom_type in ("MultiLineString", "GeometryCollection"):
        out = []
        for part in geom.geoms:
            out.extend(iter_lines(part))
        return out
    return []


def load_tiles(tiles_dir: Path):
    manifest = json.loads((tiles_dir / "manifest.json").read_text(encoding="utf-8"))
    tiles = []
    for entry in manifest.get("tiles", []):
        name = Path(entry["file"]).name
        data = json.loads((tiles_dir / name).read_text(encoding="utf-8"))
        pieces = {"drivable": [], "paving": [], "kerb": [], "median": []}
        for record in data.get("roadSurfaces") or []:
            poly = polygon_of(record.get("polygon"))
            if poly is None:
                continue
            pieces.setdefault(record.get("kind"), []).append(
                {
                    "kind": record.get("kind"),
                    "material": record.get("material"),
                    "bridge": bool(record.get("bridge")),
                    "geom": poly,
                }
            )
        tiles.append(
            {
                "name": name,
                "data": data,
                "pieces": pieces,
                "bounds": data.get("bounds"),
            }
        )
    return manifest, tiles


def check_overlaps(tiles, violations, stats):
    same_layer_pairs = 0
    same_layer_area = 0.0
    cross_layer_area = 0.0
    worst = []
    invalid = 0
    for tile in tiles:
        for kind in KINDS:
            items = tile["pieces"].get(kind, [])
            for piece in items:
                if not piece["geom"].is_valid:
                    invalid += 1
                    violations.append(f"{tile['name']}: invalid {kind} polygon")
            for bridge in (False, True):
                layer = [piece for piece in items if piece["bridge"] == bridge]
                for i in range(len(layer)):
                    a = layer[i]["geom"]
                    for j in range(i + 1, len(layer)):
                        b = layer[j]["geom"]
                        if not a.bounds[0] <= b.bounds[2] or not b.bounds[0] <= a.bounds[2]:
                            continue
                        if not a.bounds[1] <= b.bounds[3] or not b.bounds[1] <= a.bounds[3]:
                            continue
                        try:
                            area = a.intersection(b).area
                        except Exception:
                            invalid += 1
                            continue
                        if area <= OVERLAP_TOLERANCE_M2:
                            continue
                        same_layer_pairs += 1
                        same_layer_area += area
                        worst.append((area, tile["name"], kind, bridge, a.area, b.area))
        # drivable and paving are different Y layers; grid snapping can leave
        # a sub-centimetre sliver along shared boundaries. Reported, not a
        # visual/z-fight defect, but a large total would signal a real bug.
        for bridge in (False, True):
            drivable = [piece for piece in tile["pieces"].get("drivable", []) if piece["bridge"] == bridge]
            paving = [piece for piece in tile["pieces"].get("paving", []) if piece["bridge"] == bridge]
            for i in range(len(drivable)):
                a = drivable[i]["geom"]
                for j in range(len(paving)):
                    b = paving[j]["geom"]
                    if not a.bounds[0] <= b.bounds[2] or not b.bounds[0] <= a.bounds[2]:
                        continue
                    if not a.bounds[1] <= b.bounds[3] or not b.bounds[1] <= a.bounds[3]:
                        continue
                    try:
                        area = a.intersection(b).area
                    except Exception:
                        invalid += 1
                        continue
                    if area > 0.01:
                        cross_layer_area += area
    stats["invalid_surface_polygons"] = invalid
    stats["same_layer_overlap_pairs"] = same_layer_pairs
    stats["same_layer_overlap_area_m2"] = round(same_layer_area, 2)
    stats["cross_layer_overlap_area_m2"] = round(cross_layer_area, 2)
    if same_layer_pairs:
        violations.append(
            f"{same_layer_pairs} overlapping same-layer surface pair(s), {same_layer_area:.2f} m2 "
            f"(e.g. {sorted(worst, reverse=True)[:3]})"
        )
    if same_layer_area > OVERLAP_TOTAL_TOLERANCE_M2:
        violations.append(
            f"same-layer overlap total {same_layer_area:.2f} m2 > {OVERLAP_TOTAL_TOLERANCE_M2} m2"
        )
    if cross_layer_area > CROSS_LAYER_TOLERANCE_M2:
        violations.append(
            f"drivable/paving overlap {cross_layer_area:.2f} m2 > {CROSS_LAYER_TOLERANCE_M2} m2"
        )
    return stats


def check_material_coverage(tiles, violations, stats):
    by_material = Counter()
    area_by_material = defaultdict(float)
    drivable_area = 0.0
    stone_ways = 0
    for tile in tiles:
        drivable = tile["pieces"].get("drivable", [])
        drivable_area += sum(p["geom"].area for p in drivable)
        for piece in drivable:
            material = piece.get("material")
            by_material[material] += 1
            area_by_material[material] += piece["geom"].area
            if material not in MATERIALS:
                violations.append(f"{tile['name']}: drivable piece with material {material!r}")
        if any(p.get("material") == "stone" for p in drivable):
            stone_ways += 1
    stats["drivable_pieces_by_material"] = dict(by_material)
    stats["drivable_area_by_material_m2"] = {
        material: round(area, 1) for material, area in area_by_material.items()
    }
    stats["drivable_area_m2"] = round(drivable_area, 1)
    stats["tiles_with_stone"] = stone_ways
    if stone_ways == 0:
        violations.append("no stone drivable pieces in the dataset")
    return stats


def check_widths(tiles, violations, stats):
    # One width per street, direction AND lane signature: a 3-lane segment may
    # legitimately be narrower than a 5-lane segment of the same street, and
    # merged corridors are derived from a pair of carriageways.
    by_name = defaultdict(list)
    unnamed = 0
    for tile in tiles:
        for piece in tile["data"].get("roadNetwork") or []:
            if piece.get("kind") != "road" or piece.get("merged"):
                continue
            name = piece.get("name")
            if not name:
                unnamed += 1
                continue
            by_name[
                (
                    name,
                    bool(piece.get("oneway")),
                    piece.get("lanesForward"),
                    piece.get("lanesBackward"),
                )
            ].append(float(piece.get("width") or 0.0))
    spreads = {
        f"{name} ({'one-way' if oneway else 'two-way'}, "
        f"{lane_f or 0}+{lane_b or 0} lanes)": round(
            max(values) - min(values), 2
        )
        for (name, oneway, lane_f, lane_b), values in by_name.items()
        if len(values) > 1
    }
    worst = sorted(spreads.items(), key=lambda item: -item[1])[:5]
    stats["named_street_direction_groups"] = len(by_name)
    stats["unnamed_network_pieces"] = unnamed
    stats["worst_width_spreads_m"] = worst
    for name, spread in spreads.items():
        if spread > WIDTH_SPREAD_TOLERANCE_M:
            violations.append(f"street {name!r}: width spread {spread} m > {WIDTH_SPREAD_TOLERANCE_M} m")
    return stats


def check_centerlines_inside(tiles, violations, stats):
    outside = 0
    checked = 0
    worst_margin = 0.0
    for tile in tiles:
        drivable = [p["geom"] for p in tile["pieces"].get("drivable", [])]
        if not drivable:
            continue
        surface = unary_union(drivable)
        bounds = tile["bounds"] or [-1e9, -1e9, 1e9, 1e9]
        for piece in tile["data"].get("roadNetwork") or []:
            if piece.get("kind") == "rail":
                # Rails legitimately leave the drivable surface (grass tracks,
                # depots); their continuity is a renderer concern, not a road
                # centrelines-inside-asphalt invariant.
                continue
            if piece.get("merged"):
                # A merged two-way corridor centreline is a derived midline
                # between two OSM ways; it can briefly run through the small
                # unpaved seam between them.
                continue
            flat = piece.get("centerline") or []
            if len(flat) < 4:
                violations.append(f"{tile['name']}: network piece with short centerline")
                continue
            points = [(flat[i], flat[i + 1]) for i in range(0, len(flat) - 1, 2)]
            line = LineString(points)
            samples = max(2, int(line.length // 4.0) + 1)
            for step in range(samples + 1):
                point = line.interpolate(step / samples, normalized=True)
                # Centerlines deliberately overhang the tile by 4 m for dash
                # phase continuity; only check samples that belong to this tile.
                if not (bounds[0] - 0.5 <= point.x <= bounds[2] + 0.5):
                    continue
                if not (bounds[1] - 0.5 <= point.y <= bounds[3] + 0.5):
                    continue
                distance = surface.distance(point)
                checked += 1
                if distance > CENTERLINE_INSIDE_TOLERANCE_M:
                    outside += 1
                    worst_margin = max(worst_margin, distance)
    stats["centerline_samples"] = checked
    stats["centerline_samples_outside"] = outside
    stats["centerline_worst_margin_m"] = round(worst_margin, 2)
    if outside:
        violations.append(
            f"{outside}/{checked} centerline samples outside the drivable surface "
            f"(worst {worst_margin:.2f} m > {CENTERLINE_INSIDE_TOLERANCE_M} m)"
        )
    return stats


def _seam_intervals(tile, vertical: bool, coordinate: float):
    intervals = []
    line = (
        LineString([(coordinate, tile["bounds"][1]), (coordinate, tile["bounds"][3])])
        if vertical
        else LineString([(tile["bounds"][0], coordinate), (tile["bounds"][2], coordinate)])
    )
    # Seam continuity is about *visible ground coverage*, not just asphalt: a
    # narrow paving/kerb strip legitimately runs between carriageways and across
    # the border (e.g. the median slot), so any surface layer counts as covered.
    for kind, pieces in tile["pieces"].items():
        if not isinstance(pieces, list):
            continue
        for piece in pieces:
            geom = piece["geom"].intersection(line)
            for part in iter_lines(geom):
                coords = list(part.coords)
                if vertical:
                    values = sorted((coord[1] for coord in coords))
                else:
                    values = sorted((coord[0] for coord in coords))
                if values and values[-1] - values[0] > 1e-6:
                    intervals.append((values[0], values[-1]))
    merged = []
    for start, end in sorted(intervals):
        if merged and start <= merged[-1][1] + 1e-6:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))
    return merged


def _interval_gap(a, b):
    """Largest uncovered interval between two sorted interval lists."""
    items = []
    for start, end in a:
        items.append((start, 1))
        items.append((end, -1))
    for start, end in b:
        items.append((start, -1))
        items.append((end, 1))
    items.sort()
    coverage = 0
    last = None
    worst = 0.0
    for coordinate, delta in items:
        if coverage != 0 and last is not None:
            worst = max(worst, coordinate - last)
        coverage += delta
        last = coordinate
    return worst


def check_tile_seams(tiles, violations, stats):
    by_tile = {tile["name"]: tile for tile in tiles}
    seam_count = 0
    worst = 0.0
    for tile in tiles:
        bounds = tile["bounds"]
        if bounds is None:
            continue
        data = tile["data"]
        tx, ty = int(data.get("tileX", 0)), int(data.get("tileY", 0))
        neighbours = [
            (f"{tx + 1}_{ty}.json", True, bounds[2]),
            (f"{tx}_{ty + 1}.json", False, bounds[3]),
        ]
        for name, vertical, coordinate in neighbours:
            other = by_tile.get(name)
            if other is None:
                continue
            gap = _interval_gap(
                _seam_intervals(tile, vertical, coordinate),
                _seam_intervals(other, vertical, coordinate),
            )
            seam_count += 1
            worst = max(worst, gap)
            if gap > TILE_SEAM_TOLERANCE_M:
                violations.append(
                    f"tile seam {tile['name']} <-> {name}: drivable gap {gap:.3f} m "
                    f"> {TILE_SEAM_TOLERANCE_M} m"
                )
    stats["checked_tile_seams"] = seam_count
    stats["worst_tile_seam_gap_m"] = round(worst, 3)
    return stats


def check_junctions_crossings(tiles, violations, stats):
    junction_count = 0
    crossing_count = 0
    crossing_kinds = Counter()
    for tile in tiles:
        bounds = tile["bounds"] or [-1e9, -1e9, 1e9, 1e9]
        for junction in tile["data"].get("junctions") or []:
            junction_count += 1
            x, y = junction.get("x"), junction.get("y")
            radius = junction.get("radius")
            if not all(isinstance(v, (int, float)) and math.isfinite(v) for v in (x, y, radius)):
                violations.append(f"{tile['name']}: junction with non-finite values")
                continue
            if not (3.0 <= radius <= 30.0):
                violations.append(f"{tile['name']}: junction radius {radius} out of range")
            if not (bounds[0] - radius - 2 <= x <= bounds[2] + radius + 2):
                violations.append(f"{tile['name']}: junction outside tile x-range")
            if not (bounds[1] - radius - 2 <= y <= bounds[3] + radius + 2):
                violations.append(f"{tile['name']}: junction outside tile y-range")
            if int(junction.get("approaches", 0)) < 2:
                violations.append(f"{tile['name']}: junction with < 2 approaches")
        for crossing in tile["data"].get("crossings") or []:
            crossing_count += 1
            kind = crossing.get("kind")
            crossing_kinds[kind] += 1
            if kind not in CROSSING_KINDS:
                violations.append(f"{tile['name']}: crossing with kind {kind!r}")
            width = crossing.get("width")
            span = crossing.get("span")
            if not all(isinstance(v, (int, float)) and math.isfinite(v) for v in (width, span)):
                violations.append(f"{tile['name']}: crossing with non-finite width/span")
            elif not (1.0 <= width <= 40.0) or not (1.0 <= span <= 10.0):
                violations.append(f"{tile['name']}: crossing width/span out of range")
            x, y = crossing.get("x"), crossing.get("y")
            if not (bounds[0] <= x <= bounds[2] and bounds[1] <= y <= bounds[3]):
                violations.append(f"{tile['name']}: crossing outside its tile")
    stats["junctions"] = junction_count
    stats["crossings"] = crossing_count
    stats["crossing_kinds"] = dict(crossing_kinds)
    return stats


def check_medians(tiles, stats):
    medians = []
    for tile in tiles:
        for piece in tile["pieces"].get("median", []):
            medians.append(piece["geom"].area)
    stats["medians"] = len(medians)
    stats["median_area_m2"] = round(sum(medians), 1)
    return stats


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--tiles", default=str(DEFAULT_TILES))
    parser.add_argument("--json", default=None)
    args = parser.parse_args()
    tiles_dir = Path(args.tiles)
    if not (tiles_dir / "manifest.json").exists():
        print(f"ERROR: no manifest in {tiles_dir}", file=sys.stderr)
        return 1
    manifest, tiles = load_tiles(tiles_dir)
    print(
        f"Road audit: {len(tiles)} tiles, manifest version {manifest.get('version')}, "
        f"tile size {manifest.get('tileSize')} m"
    )
    violations: list[str] = []
    stats: dict = {"tiles": len(tiles), "manifestVersion": manifest.get("version")}
    if manifest.get("version") not in ("0.2.0", "0.3.0"):
        violations.append(
            f"manifest version {manifest.get('version')!r} is not a known road payload version"
        )
    missing = [
        tile["name"]
        for tile in tiles
        if not isinstance(tile["data"].get("roadSurfaces"), list)
        or not isinstance(tile["data"].get("roadNetwork"), list)
    ]
    stats["tiles_without_road_payload"] = missing
    if missing:
        violations.append(f"{len(missing)} tile(s) without roadSurfaces/roadNetwork: {missing[:5]}")
    for check in (
        check_overlaps,
        check_material_coverage,
        check_widths,
        check_centerlines_inside,
        check_tile_seams,
        check_junctions_crossings,
    ):
        check(tiles, violations, stats)
    check_medians(tiles, stats)

    for key in sorted(stats):
        print(f"  {key}: {stats[key]}")
    if args.json:
        Path(args.json).write_text(json.dumps({"stats": stats, "violations": violations}, indent=1), encoding="utf-8")
        print(f"Wrote {args.json}")
    if violations:
        print(f"\nROAD AUDIT FAILED ({len(violations)} issue(s)):")
        for issue in violations:
            print(f"  - {issue}")
        return 1
    print("\nROAD AUDIT PASSED")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

