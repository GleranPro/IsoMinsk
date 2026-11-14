"""Freeze the complete-city building-quality baseline (L0).

Two artefacts are written from the *accepted* tile dataset, without mutating it:

* ``docs/building-quality/BASELINE.json`` — commit, dataset manifest hash, tile
  hashes/bytes, counts, the locked camera/pixel settings and the verbatim
  baseline suite results (typecheck / vitest / python data tests);
* ``docs/building-quality/review-cases.json`` — the deterministic L0 comparison
  case registry (real building ids, tile keys, local coordinates, heights,
  archetypes, tags, input bounds) used by every later L2 capture.

The selection is deterministic and category-driven, never "best-looking":

* one typical real building per broad archetype (median height/area/id order);
* the three densest panel-residential neighbourhoods and the three densest
  pre-war/low-rise neighbourhoods (tile ranked by count, tie-break tile key);
* every curated landmark;
* the tile with the tallest ``modern`` building (modern tower district);
* the tile with the most ``industrial`` buildings;
* the border tile with the most ``small`` buildings (detached/small edge);
* the four corner tiles;
* a river/bridge viewpoint and the Lipki museum viewpoint.

Run:

    .venv\\Scripts\\python.exe scripts/qa/freeze_building_baseline.py \
        --tiles-dir public/data/city-tiles \
        --out docs/building-quality/BASELINE.json \
        --cases docs/building-quality/review-cases.json \
        --typecheck-log .agent-scratch/baseline-typecheck.txt \
        --vitest-log .agent-scratch/baseline-vitest.txt \
        --python-log .agent-scratch/baseline-python.txt
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

# Locked daytime camera settings (design §9/§10, plan Task 5/6).
CAMERA_OVERVIEW = {
    "orthoHeight": 420.0,
    "azimuth": math.pi / 4,
    "elevation": math.atan(1 / math.sqrt(2)),
    "timeHours": 13.0,
}
CAMERA_CLOSE = {
    "orthoHeight": 90.0,
    "azimuth": math.pi / 4,
    "elevation": math.atan(1 / math.sqrt(2)),
    "timeHours": 13.0,
}
# Second opposing azimuth required for profile/roof/corner review (design §10).
CAMERA_CLOSE_OPPOSITE = {
    "orthoHeight": 90.0,
    "azimuth": 5 * math.pi / 4,
    "elevation": math.atan(1 / math.sqrt(2)),
    "timeHours": 13.0,
}
PIXEL_ART = {
    "enabled": True,
    "resolution": 360,
    "outline": 0.55,
    "colorLevels": 20,
    "dither": 0.35,
}
VIEWPORT = {"width": 1600, "height": 900}
TIMES = {"day": 13.0, "warmEvening": 18.5, "night": 22.0}

ARCHETYPES = [
    "stalin",
    "khrushchev",
    "panel",
    "modern",
    "office",
    "historic",
    "industrial",
    "small",
    "civic",
    "palace",
    "stadium",
]

# Derived working files that a staging run must never touch (hashed as
# protected inputs; missing files are recorded as missing, never invented).
PROTECTED_INPUTS = (
    "data/processed/coverage_city_b2.json",
    "data/processed/city_area_b2_normalized.json",
    "data/processed/coverage_city.json",
    "data/processed/city_area_normalized.json",
    "data/processed/city_normalized.json",
    "data/processed/coverage.json",
    "docs/COVERAGE_REPORT_CITY.md",
)

# Tags that actually inform style selection (design §5 "Information budget").
KEPT_TAGS = (
    "building",
    "building:material",
    "building:levels",
    "roof:shape",
    "roof:height",
    "amenity",
    "start_date",
    "addr:street",
    "addr:housenumber",
)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def stable_manifest_hash(manifest: dict) -> str:
    stable = {key: value for key, value in manifest.items() if key != "generatedAt"}
    payload = json.dumps(stable, sort_keys=True, ensure_ascii=False).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def git_sha() -> str:
    try:
        return subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=ROOT, text=True, stderr=subprocess.DEVNULL
        ).strip()
    except Exception:  # noqa: BLE001 - baseline must still be writable outside git
        return "unknown"


def ring_area(ring: list[list[float]]) -> float:
    area = 0.0
    count = len(ring)
    for index in range(count):
        x0, y0 = ring[index]
        x1, y1 = ring[(index + 1) % count]
        area += x0 * y1 - x1 * y0
    return abs(area) / 2


def ring_centroid(ring: list[list[float]]) -> tuple[float, float]:
    area = 0.0
    cx = 0.0
    cy = 0.0
    count = len(ring)
    for index in range(count):
        x0, y0 = ring[index]
        x1, y1 = ring[(index + 1) % count]
        cross = x0 * y1 - x1 * y0
        area += cross
        cx += (x0 + x1) * cross
        cy += (y0 + y1) * cross
    area /= 2
    if abs(area) < 1e-9:
        return float(ring[0][0]), float(ring[0][1])
    return cx / (6 * area), cy / (6 * area)


def polygon_area(polygon: list[list[list[float]]]) -> float:
    if not polygon:
        return 0.0
    area = ring_area(polygon[0])
    for hole in polygon[1:]:
        area -= ring_area(hole)
    return max(0.0, area)


def footprint_bounds(polygon: list[list[list[float]]]) -> list[float]:
    xs: list[float] = []
    ys: list[float] = []
    for ring in polygon:
        for x, y in ring:
            xs.append(x)
            ys.append(y)
    return [min(xs), min(ys), max(xs), max(ys)]


def main_volume(building: dict) -> dict | None:
    volumes = building.get("volumes") or []
    if not volumes:
        return None
    return max(volumes, key=lambda volume: polygon_area(volume.get("footprint") or []))


def describe_building(building: dict, tile_key: str) -> dict | None:
    volume = main_volume(building)
    if volume is None:
        return None
    polygon = volume.get("footprint") or []
    if not polygon or len(polygon[0]) < 3:
        return None
    area = polygon_area(polygon)
    if area <= 0:
        return None
    cx, cy = ring_centroid(polygon[0])
    tags = {
        key: value
        for key, value in (building.get("tags") or {}).items()
        if key in KEPT_TAGS
    }
    return {
        "kind": "building",
        "id": building.get("id"),
        "tileKey": tile_key,
        "localX": round(cx, 3),
        "localY": round(cy, 3),
        "height": building.get("height"),
        "archetype": building.get("archetype"),
        "roofShape": building.get("roofShape"),
        "levels": building.get("levels"),
        "name": building.get("name"),
        "landmark": building.get("landmark"),
        "tags": tags,
        "areaM2": round(area, 2),
        "inputBounds": [round(value, 3) for value in footprint_bounds(polygon)],
        "volumeCount": len(building.get("volumes") or []),
    }


def typical(cases: list[dict]) -> dict | None:
    """Median-height/area member of a category: deterministic and unbiased."""
    if not cases:
        return None
    ordered = sorted(cases, key=lambda case: (case["height"] or 0, case["areaM2"], case["id"]))
    return ordered[len(ordered) // 2]


def select_cases(dataset: dict) -> dict:
    buildings: list[dict] = dataset["buildings"]
    tiles = dataset["tiles_by_key"]
    manifest = dataset["manifest"]
    bounds = manifest["bounds"]
    tile_range = manifest["tileRange"]
    tile_size = manifest["tileSize"]

    cases: list[dict] = []
    used: set[str] = set()

    def add(case: dict | None, category: str, reason: str) -> None:
        if case is None:
            return
        key = f"{category}:{case.get('id') or case.get('tileKey')}"
        if key in used:
            return
        used.add(key)
        cases.append({**case, "category": category, "selectionRule": reason})

    by_archetype: dict[str, list[dict]] = {name: [] for name in ARCHETYPES}
    for building in buildings:
        archetype = building.get("archetype")
        if archetype in by_archetype:
            by_archetype[archetype].append(building)

    # 1. One typical real building per broad archetype.
    for archetype in ARCHETYPES:
        candidates = [case for case in by_archetype[archetype] if case["areaM2"] >= 40]
        add(
            typical(candidates),
            f"archetype_{archetype}",
            "median height/area/id member of the archetype (area >= 40 m2)",
        )

    def densest_tiles(predicate) -> list[str]:
        counts: dict[str, int] = {}
        for building in buildings:
            if predicate(building):
                counts[building["tileKey"]] = counts.get(building["tileKey"], 0) + 1
        return [
            key
            for key, _ in sorted(counts.items(), key=lambda item: (-item[1], item[0]))
        ]

    def typical_in_tile(tile_key: str, predicate) -> dict | None:
        members = [
            building
            for building in buildings
            if building["tileKey"] == tile_key and predicate(building)
        ]
        return typical(members)

    panel_tiles = densest_tiles(lambda b: b.get("archetype") == "panel")
    for index, tile_key in enumerate(panel_tiles[:3], start=1):
        add(
            typical_in_tile(tile_key, lambda b: b.get("archetype") == "panel"),
            f"panel_neighborhood_{index}",
            "densest panel-residential tiles ranked by count then tile key",
        )

    historic_tiles = densest_tiles(lambda b: b.get("archetype") == "historic")
    for index, tile_key in enumerate(historic_tiles[:3], start=1):
        add(
            typical_in_tile(tile_key, lambda b: b.get("archetype") == "historic"),
            f"prewar_lowrise_{index}",
            "densest historic/pre-war tiles ranked by count then tile key",
        )

    # 3. Every curated landmark.
    for building in buildings:
        if building.get("landmark"):
            add(
                building,
                f"landmark_{building['landmark']}",
                "every curated landmark building in the accepted dataset",
            )

    # 4. Modern tower district: the tile with the tallest modern building.
    modern = [b for b in by_archetype["modern"] if b.get("height")]
    if modern:
        tallest = max(modern, key=lambda b: (b["height"], b["id"]))
        add(tallest, "modern_tower_district", "tallest modern building in the accepted dataset")

    # 5. Industrial area: tile with the most industrial buildings.
    industrial_tiles = densest_tiles(lambda b: b.get("archetype") == "industrial")
    if industrial_tiles:
        add(
            typical_in_tile(industrial_tiles[0], lambda b: b.get("archetype") == "industrial"),
            "industrial_area",
            "tile with the most industrial buildings",
        )

    # 6. Detached / small-building edge: border tile with the most `small`.
    min_x, min_y, max_x, max_y = tile_range["minX"], tile_range["minY"], tile_range["maxX"], tile_range["maxY"]

    def is_border(tile_key: str) -> bool:
        x_text, y_text = tile_key.split("_")
        x, y = int(x_text), int(y_text)
        return x in (min_x, max_x) or y in (min_y, max_y)

    small_tiles = [key for key in densest_tiles(lambda b: b.get("archetype") == "small") if is_border(key)]
    if small_tiles:
        add(
            typical_in_tile(small_tiles[0], lambda b: b.get("archetype") == "small"),
            "small_edge",
            "border tile with the most small/outbuilding features",
        )

    # 7. The four corner tiles: tallest building in each.
    corners = {
        "sw": f"{min_x}_{min_y}",
        "se": f"{max_x}_{min_y}",
        "nw": f"{min_x}_{max_y}",
        "ne": f"{max_x}_{max_y}",
    }
    for name, tile_key in corners.items():
        members = [building for building in buildings if building["tileKey"] == tile_key]
        tallest = max(members, key=lambda b: (b.get("height") or 0, b["id"])) if members else None
        if tallest is None:
            # Empty corner tile: record the viewpoint itself, never invent a building.
            cases.append(
                {
                    "kind": "view",
                    "id": None,
                    "tileKey": tile_key,
                    "localX": round((int(tile_key.split("_")[0]) + 0.5) * tile_size, 3),
                    "localY": round((int(tile_key.split("_")[1]) + 0.5) * tile_size, 3),
                    "category": f"corner_{name}",
                    "selectionRule": "area corner tile with no building feature",
                }
            )
        else:
            add(tallest, f"corner_{name}", "tallest building in the area corner tile")

    # 8. River / bridge viewpoint: a tile that carries a bridge deck or a bridge surface.
    bridge_tiles: list[str] = []
    river_tiles: list[str] = []
    for tile_key, tile in tiles.items():
        ground = tile.get("ground") or {}
        decks = ground.get("decks") or []
        surfaces = tile.get("roadSurfaces") or []
        if decks or any(piece.get("bridge") for piece in surfaces):
            bridge_tiles.append(tile_key)
        if any((surface.get("kind") in ("river", "water")) for surface in tile.get("surfaces") or []):
            river_tiles.append(tile_key)
    bridge_tiles.sort()
    river_tiles.sort()
    river_bridge_key = None
    for tile_key in bridge_tiles:
        if tile_key in river_tiles:
            river_bridge_key = tile_key
            break
    if river_bridge_key is None and bridge_tiles:
        river_bridge_key = bridge_tiles[0]
    if river_bridge_key:
        x_text, y_text = river_bridge_key.split("_")
        cases.append(
            {
                "kind": "view",
                "id": None,
                "tileKey": river_bridge_key,
                "localX": round((int(x_text) + 0.5) * tile_size, 3),
                "localY": round((int(y_text) + 0.5) * tile_size, 3),
                "category": "river_bridge",
                "selectionRule": "first tile (by tile key) carrying both a bridge deck and a river surface",
            }
        )

    # 9. Lipki museum viewpoint (the museum focus point, design §10).
    museum_x, museum_y = 9300.0, 655.0
    museum_tile = f"{math.floor(museum_x / tile_size)}_{math.floor(museum_y / tile_size)}"
    cases.append(
        {
            "kind": "view",
            "id": None,
            "tileKey": museum_tile,
            "localX": museum_x,
            "localY": museum_y,
            "category": "lipki_museum",
            "selectionRule": "fixed Lipki museum focus point (src/shared/museum.ts)",
        }
    )

    for case in cases:
        case["sourceManifestSha256"] = dataset["manifestSha256"]

    return {
        "schema": 1,
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "dataset": {
            "directory": dataset["directory"],
            "manifestSha256": dataset["manifestSha256"],
            "tileCount": len(manifest["tiles"]),
            "buildingCount": manifest["counts"]["buildings"],
            "bounds": bounds,
            "tileSize": tile_size,
        },
        "capture": {
            "viewport": VIEWPORT,
            "pixelArt": PIXEL_ART,
            "camera": {
                "overview": CAMERA_OVERVIEW,
                "close": CAMERA_CLOSE,
                "closeOpposite": CAMERA_CLOSE_OPPOSITE,
            },
            "times": TIMES,
            "levels": {
                "overview": 420.0,
                "close": 90.0,
            },
        },
        "cases": cases,
    }


def load_dataset(tiles_dir: Path) -> dict:
    manifest_path = tiles_dir / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    tiles_by_key: dict[str, dict] = {}
    buildings: list[dict] = []
    tile_files: list[dict] = []
    for entry in manifest["tiles"]:
        name = Path(entry["file"]).name
        path = tiles_dir / name
        if not path.exists():
            raise SystemExit(f"missing tile file: {path}")
        tile = json.loads(path.read_text(encoding="utf-8"))
        key = f"{entry['x']}_{entry['y']}"
        tiles_by_key[key] = tile
        for building in tile.get("buildings") or []:
            described = describe_building(building, key)
            if described is not None:
                buildings.append(described)
        tile_files.append(
            {
                "x": entry["x"],
                "y": entry["y"],
                "file": entry["file"],
                "bytes": path.stat().st_size,
                "sha256": sha256_file(path),
            }
        )
    return {
        "directory": str(tiles_dir),
        "manifest": manifest,
        "manifestSha256": stable_manifest_hash(manifest),
        "tiles_by_key": tiles_by_key,
        "buildings": buildings,
        "tile_files": tile_files,
    }


def read_log(path: Path) -> str:
    """Read a captured suite log regardless of the PowerShell redirection encoding."""
    raw = path.read_bytes()
    if raw.startswith(b"\xff\xfe") or raw.startswith(b"\xfe\xff"):
        return raw.decode("utf-16", errors="replace")
    # UTF-16LE without a BOM still has NUL bytes in every odd position.
    if raw[:64].count(b"\x00") > 16:
        return raw.decode("utf-16-le", errors="replace")
    return raw.decode("utf-8-sig", errors="replace")


def suite_summary(log_path: Path | None, kind: str) -> dict:
    if log_path is None or not log_path.exists():
        return {"status": "not-recorded", "verbatimTail": []}
    text = read_log(log_path)
    lines = [line.rstrip() for line in text.splitlines() if line.strip()]
    tail = lines[-40:]
    status = "unknown"
    summary: dict[str, object] = {}
    if kind == "vitest":
        for line in lines:
            stripped = line.strip()
            if stripped.startswith("Test Files"):
                summary["testFiles"] = stripped
            elif stripped.startswith("Tests"):
                summary["tests"] = stripped
            elif stripped.startswith("Duration"):
                summary["duration"] = stripped
        status = "pass" if "failed" not in " ".join(summary.values()) else "fail"
    elif kind == "python":
        for line in lines:
            stripped = line.strip()
            if stripped.startswith("Ran "):
                summary["ran"] = stripped
            elif stripped in ("OK", "FAILED") or stripped.startswith("FAILED"):
                summary["result"] = stripped
        status = "pass" if summary.get("result") == "OK" else "fail"
    elif kind == "typecheck":
        status = "pass" if not any("error TS" in line for line in lines) else "fail"
        summary["result"] = "tsc --noEmit completed" if status == "pass" else "type errors present"
    return {
        "status": status,
        "summary": summary,
        "logFile": str(log_path),
        "verbatimTail": tail,
    }


def protected_inputs() -> dict:
    """Hash the derived working files a staging run must not touch."""
    recorded: dict[str, dict] = {}
    for relative in PROTECTED_INPUTS:
        path = ROOT / relative
        if not path.exists():
            recorded[relative] = {"missing": True}
            continue
        recorded[relative] = {
            "sizeBytes": path.stat().st_size,
            "sha256": sha256_file(path),
        }
    return recorded


def main() -> int:
    parser = argparse.ArgumentParser(description="Freeze the complete-city building-quality baseline")
    parser.add_argument("--tiles-dir", default="public/data/city-tiles")
    parser.add_argument("--out", default="docs/building-quality/BASELINE.json")
    parser.add_argument("--cases", default="docs/building-quality/review-cases.json")
    parser.add_argument("--typecheck-log")
    parser.add_argument("--vitest-log")
    parser.add_argument("--python-log")
    parser.add_argument("--start-commit", default=None)
    parser.add_argument("--skip-cases", action="store_true")
    args = parser.parse_args()

    tiles_dir = Path(args.tiles_dir)
    dataset = load_dataset(tiles_dir)
    manifest = dataset["manifest"]
    tile_files = dataset["tile_files"]
    total_bytes = sum(tile["bytes"] for tile in tile_files)

    baseline = {
        "schema": 1,
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "startCommit": args.start_commit or git_sha(),
        "purpose": (
            "Frozen before-state for the procedural building variety work: exact suite results, "
            "accepted complete-city manifest, per-tile hashes and the locked review camera."
        ),
        "suites": {
            "typecheck": suite_summary(Path(args.typecheck_log) if args.typecheck_log else None, "typecheck"),
            "vitest": suite_summary(Path(args.vitest_log) if args.vitest_log else None, "vitest"),
            "pythonDataTests": suite_summary(Path(args.python_log) if args.python_log else None, "python"),
        },
        "dataset": {
            "directory": str(tiles_dir),
            "payloadVersion": manifest.get("version"),
            "manifestSha256": dataset["manifestSha256"],
            "generatedAt": manifest.get("generatedAt"),
            "epsg": manifest.get("epsg"),
            "originUtm": manifest.get("originUtm"),
            "tileSize": manifest.get("tileSize"),
            "tileRange": manifest.get("tileRange"),
            "bounds": manifest.get("bounds"),
            "areaBounds": manifest.get("areaBounds"),
            "tileCount": len(manifest.get("tiles", [])),
            "totalTileBytes": total_bytes,
            "counts": manifest.get("counts"),
            "tiles": tile_files,
        },
        "review": {
            "viewport": VIEWPORT,
            "pixelArt": PIXEL_ART,
            "camera": {
                "overview": CAMERA_OVERVIEW,
                "close": CAMERA_CLOSE,
                "closeOpposite": CAMERA_CLOSE_OPPOSITE,
            },
            "times": TIMES,
        },
        "protectedInputs": protected_inputs(),
        "notes": [
            "Baseline observed on the B-2 437-address complete-city candidate already promoted to "
            "public/data/city-tiles; recompute before every release instead of treating the numbers "
            "as constants.",
            "The root checkout's uncommitted B-2 data-pipeline state was imported as the prerequisite "
            "commit so this branch can regenerate the same complete city.",
        ],
    }

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(baseline, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"Wrote {out_path}")

    if not args.skip_cases:
        cases = select_cases(dataset)
        cases_path = Path(args.cases)
        cases_path.parent.mkdir(parents=True, exist_ok=True)
        cases_path.write_text(json.dumps(cases, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"Wrote {cases_path} ({len(cases['cases'])} cases)")

    print(
        f"Dataset: {len(manifest.get('tiles', []))} tiles, "
        f"{total_bytes / 1e6:.2f} MB, buildings {manifest['counts']['buildings']:,}, "
        f"manifest sha256 {dataset['manifestSha256']}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
