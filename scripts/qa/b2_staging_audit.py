"""B-2 staging audit: verify the complete-city candidate before it can replace the map.

Checks (fail-closed, exit code 1 on any failure):

* the tile set is exactly the address book derived from the reviewed raw-input
  bounds in ``scripts/geo_config.py`` (currently 437 addresses, 1024 m tiles)
  and matches the frozen ``docs/B2/area.json`` address list;
* every tile file exists, parses, matches the manifest size/bounds and its
  building count;
* manifest counts equal the payload counts (buildings, trees, attractions,
  crossings, junctions, surfaces), building ids are unique, and
  `crossingBuildingIds` point at real buildings;
* the staging coverage report matches the target area, has
  `treesBudgetScale == 1` and reports the tree duties honestly;
* the staging run did not touch the accepted complete-city dataset or the
  protected derived files recorded in ``docs/building-quality/BASELINE.json``
  (the pre-B2 ``docs/B2/BASELINE.json`` hashes are used as a fallback and are
  reported as historical);
* the tiles directory is not the working dataset directory.

Writes `docs/B2/STAGING_AUDIT.json` with every check, the address
reconciliation record and its details.

Run (after the staging normalisation):

    .venv\\Scripts\\python.exe scripts/qa/b2_staging_audit.py \
        --tiles-dir public/data/city-tiles-b2 \
        --coverage data/processed/coverage_city_b2.json
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
AREA_SCHEMA = ROOT / "docs" / "B2" / "area.json"
BASELINE = ROOT / "docs" / "B2" / "BASELINE.json"
ACCEPTED_BASELINE = ROOT / "docs" / "building-quality" / "BASELINE.json"
OUT = ROOT / "docs" / "B2" / "STAGING_AUDIT.json"
WORKING_TILES = ROOT / "public" / "data" / "city-tiles"

sys.path.insert(0, str(ROOT / "scripts"))
import geo_config  # noqa: E402 - repository-local contract module


def derived_address_book(bounds: tuple[float, float, float, float], tile_size: float) -> set[str]:
    """Inclusive tile address book derived from the reviewed area bounds."""
    min_x, min_y, max_x, max_y = geo_config.tile_range(bounds, tile_size)
    return {f"{x}_{y}" for x in range(min_x, max_x + 1) for y in range(min_y, max_y + 1)}



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


class Audit:
    def __init__(self) -> None:
        self.checks: list[dict] = []

    def check(self, name: str, ok: bool, detail: str = "") -> bool:
        self.checks.append({"name": name, "ok": bool(ok), "detail": detail})
        if not ok:
            print(f"FAIL  {name}: {detail}", file=sys.stderr)
        return ok

    @property
    def failed(self) -> int:
        return sum(1 for check in self.checks if not check["ok"])


def main() -> int:
    parser = argparse.ArgumentParser(description="Audit a B-2 staging tile set")
    parser.add_argument("--tiles-dir", required=True)
    parser.add_argument("--coverage", required=True)
    parser.add_argument("--area-schema", default=str(AREA_SCHEMA))
    parser.add_argument("--baseline", default=str(BASELINE),
                        help="historical pre-B-2 baseline (fallback only)")
    parser.add_argument("--accepted-baseline", default=str(ACCEPTED_BASELINE),
                        help="accepted complete-city baseline frozen for the current work")
    parser.add_argument("--out", default=str(OUT))
    parser.add_argument("--trees-per-tile-cap", type=int, default=16000,
                        help="per-tile tree cap mirrored from treeMeshes.ts")
    parser.add_argument("--skip-address-book", action="store_true",
                        help="skip the area.json address comparison (self-test only)")
    args = parser.parse_args()

    tiles_dir = Path(args.tiles_dir)
    audit = Audit()

    # --- safety: never audit the live dataset as if it were staging ---------
    if tiles_dir.resolve() == WORKING_TILES.resolve():
        audit.check("staging dir is not the working dataset", False,
                    "the audit is meant for an isolated staging directory")
        # Continue: the other checks are still informative.

    area = json.loads(Path(args.area_schema).read_text(encoding="utf-8"))
    expected_bounds = [round(value, 6) for value in area["area"]["boundsLocalM"]]
    expected_tile = area["tileSizeM"]
    expected_addresses = set(area["area"]["addresses"])
    expected_range = area["area"]["tileRange"]

    # --- area contract: derive everything from the reviewed raw-input bounds ---
    reviewed_bounds = tuple(geo_config.area_bounds_m("city"))
    audit.check(
        "area bounds come from reviewed geo_config",
        [round(value, 6) for value in reviewed_bounds] == expected_bounds,
        f"geo_config {list(reviewed_bounds)} vs area.json {expected_bounds}",
    )
    audit.check(
        "area tile size matches geo_config",
        float(geo_config.CITY_TILE_SIZE_M) == float(expected_tile),
        f"geo_config {geo_config.CITY_TILE_SIZE_M} vs area.json {expected_tile}",
    )
    reviewed_range = geo_config.tile_range(reviewed_bounds, float(expected_tile))
    audit.check(
        "area tile range derives from reviewed bounds",
        {
            "minX": reviewed_range[0],
            "minY": reviewed_range[1],
            "maxX": reviewed_range[2],
            "maxY": reviewed_range[3],
        }
        == expected_range,
        f"derived {reviewed_range} vs area.json {expected_range}",
    )
    derived_addresses = derived_address_book(reviewed_bounds, float(expected_tile))
    audit.check(
        "area address book derives from reviewed bounds",
        derived_addresses == expected_addresses,
        f"derived {len(derived_addresses)} addresses vs frozen {len(expected_addresses)}; "
        f"missing={sorted(expected_addresses - derived_addresses)[:5]} "
        f"extra={sorted(derived_addresses - expected_addresses)[:5]}",
    )
    address_reconciliation = {
        "frozenAreaAddresses": len(expected_addresses),
        "derivedAreaAddresses": len(derived_addresses),
        "tileRange": expected_range,
        "note": (
            "Older B-2 reports (399/400 addresses) predate the reviewed rectangle in "
            "scripts/geo_config.py; the 437-address book is derived from those bounds and "
            "the inclusive manifest range, not copied from a historical report."
        ),
    }

    manifest_path = tiles_dir / "manifest.json"
    if not audit.check("manifest present", manifest_path.exists(), str(manifest_path)):
        _write(args, audit)
        return 1
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    tiles = manifest.get("tiles", [])

    bounds = [round(value, 6) for value in manifest.get("bounds", [])]
    audit.check("tile size", float(manifest.get("tileSize", -1)) == float(expected_tile),
                f"manifest {manifest.get('tileSize')} vs expected {expected_tile}")
    audit.check("area bounds", bounds == expected_bounds,
                f"manifest {bounds} vs expected {expected_bounds}")
    audit.check("tile range", manifest.get("tileRange") == expected_range,
                f"manifest {manifest.get('tileRange')} vs expected {expected_range}")
    actual_addresses = {f"{entry['x']}_{entry['y']}" for entry in tiles}
    if not args.skip_address_book:
        audit.check("address book", actual_addresses == expected_addresses,
                    f"{len(actual_addresses)} addresses, expected {len(expected_addresses)}; "
                    f"missing={sorted(expected_addresses - actual_addresses)[:5]} "
                    f"extra={sorted(actual_addresses - expected_addresses)[:5]}")
        audit.check("address book derives from reviewed bounds",
                    actual_addresses == derived_addresses,
                    f"{len(actual_addresses)} manifest addresses vs {len(derived_addresses)} derived")
        address_reconciliation.update({
            "manifestAddresses": len(actual_addresses),
            "missing": sorted(expected_addresses - actual_addresses)[:10],
            "extra": sorted(actual_addresses - expected_addresses)[:10],
        })
    audit.check("tile count", len(tiles) == area["area"]["tileCount"],
                f"{len(tiles)} tiles vs expected {area['area']['tileCount']}")

    # --- per-tile payload checks -------------------------------------------
    building_ids: set[str] = set()
    duplicate_ids: list[str] = []
    crossing_refs: set[str] = set()
    sums = {"buildings": 0, "trees": 0, "attractions": 0, "crossings": 0,
            "junctions": 0, "surfaces": 0}
    missing_files: list[str] = []
    bad_tiles: list[str] = []
    total_bytes = 0
    for entry in tiles:
        file_name = Path(entry["file"]).name
        path = tiles_dir / file_name
        if not path.exists():
            missing_files.append(file_name)
            continue
        size = path.stat().st_size
        total_bytes += size
        if size != entry.get("bytes"):
            bad_tiles.append(f"{file_name}: size {size} != manifest {entry.get('bytes')}")
        try:
            tile = json.loads(path.read_text(encoding="utf-8"))
        except Exception as error:  # noqa: BLE001 - audit must report, not crash
            bad_tiles.append(f"{file_name}: {error}")
            continue
        if tile.get("tileX") != entry["x"] or tile.get("tileY") != entry["y"]:
            bad_tiles.append(f"{file_name}: tileX/Y mismatch")
        expected_tile_bounds = [
            entry["x"] * expected_tile, entry["y"] * expected_tile,
            (entry["x"] + 1) * expected_tile, (entry["y"] + 1) * expected_tile,
        ]
        if [round(value, 6) for value in tile.get("bounds", [])] != [
            round(value, 6) for value in expected_tile_bounds
        ]:
            bad_tiles.append(f"{file_name}: bounds mismatch")
        buildings = tile.get("buildings", [])
        if len(buildings) != entry.get("buildings"):
            bad_tiles.append(
                f"{file_name}: {len(buildings)} buildings vs manifest {entry.get('buildings')}"
            )
        for building in buildings:
            building_id = building.get("id")
            if building_id in building_ids:
                duplicate_ids.append(building_id)
            building_ids.add(building_id)
        crossing_refs.update(tile.get("crossingBuildingIds", []))
        sums["buildings"] += len(buildings)
        sums["trees"] += len(tile.get("trees", []))
        sums["attractions"] += len(tile.get("attractions", []))
        sums["crossings"] += len(tile.get("crossings", []))
        sums["junctions"] += len(tile.get("junctions", []))
        sums["surfaces"] += len(tile.get("surfaces", []))

    audit.check("all tile files present", not missing_files,
                f"{len(missing_files)} missing: {missing_files[:5]}")
    audit.check("tile payloads consistent", not bad_tiles,
                f"{len(bad_tiles)} problems: {bad_tiles[:5]}")
    audit.check("building ids unique", not duplicate_ids,
                f"{len(duplicate_ids)} duplicates: {duplicate_ids[:5]}")
    unknown_refs = sorted(crossing_refs - building_ids)
    audit.check("crossingBuildingIds resolve", not unknown_refs,
                f"{len(unknown_refs)} unknown ids: {unknown_refs[:5]}")

    counts = manifest.get("counts", {})
    for key, value in sums.items():
        audit.check(f"manifest count: {key}", int(counts.get(key, -1)) == value,
                    f"manifest {counts.get(key)} vs payload {value}")

    # --- coverage report ----------------------------------------------------
    coverage_path = Path(args.coverage)
    coverage_ok = audit.check("coverage report present", coverage_path.exists(), str(coverage_path))
    budget_scale = None
    if coverage_ok:
        coverage = json.loads(coverage_path.read_text(encoding="utf-8"))
        coverage_bounds = [
            round(value, 6) for value in coverage.get("area", {}).get("boundsLocal", [])
        ]
        audit.check("coverage area bounds", coverage_bounds == expected_bounds,
                    f"{coverage_bounds} vs {expected_bounds}")
        environment = coverage.get("environment", {})
        budget_scale = environment.get("treesBudgetScale")
        audit.check("trees budget scale is 1", budget_scale == 1,
                    f"treesBudgetScale={budget_scale} (global thinning is not accepted)")
        max_per_tile = environment.get("treesMaxPerTile")
        audit.check(
            "per-tile tree cap respected",
            isinstance(max_per_tile, (int, float)) and max_per_tile <= args.trees_per_tile_cap,
            f"max {max_per_tile} vs cap {args.trees_per_tile_cap}",
        )
        tree_sums = {
            "mapped points": environment.get("treesMappedPoints"),
            "mapped rows": environment.get("treesMappedRows"),
            "heuristic": environment.get("treesHeuristic"),
        }
        if sums["trees"] and all(isinstance(value, int) for value in tree_sums.values()):
            audit.check(
                "tree component counts add up",
                sum(tree_sums.values()) == sums["trees"],
                f"parts {tree_sums} vs payload {sums['trees']}",
            )

    # --- working data untouched --------------------------------------------
    # Prefer the accepted complete-city baseline frozen for the building-quality
    # work (post-B-2 promotion); fall back to the pre-B-2 baseline and say so.
    accepted_path = Path(args.accepted_baseline)
    legacy_path = Path(args.baseline)
    working_manifest = WORKING_TILES / "manifest.json"
    protected_baseline = None
    protected_inputs: dict = {}
    expected_working_hash = None
    if accepted_path.exists():
        accepted = json.loads(accepted_path.read_text(encoding="utf-8"))
        protected_baseline = str(accepted_path)
        expected_working_hash = (accepted.get("dataset") or {}).get("manifestSha256")
        protected_inputs = accepted.get("protectedInputs") or {}
        audit.check("accepted baseline present", True, str(accepted_path))
    elif legacy_path.exists():
        legacy = json.loads(legacy_path.read_text(encoding="utf-8"))
        protected_baseline = str(legacy_path)
        expected_working_hash = ((legacy.get("datasets") or {}).get("city") or {}).get("manifestSha256")
        protected_inputs = {
            relative: recorded
            for relative, recorded in (legacy.get("derived") or {}).items()
            if "city" in relative.lower()
        }
        audit.check(
            "accepted baseline present",
            False,
            f"{accepted_path} missing; using historical pre-B-2 hashes from {legacy_path}",
        )
    else:
        audit.check("accepted baseline present", False, "no baseline file found")

    if working_manifest.exists() and expected_working_hash:
        current = json.loads(working_manifest.read_text(encoding="utf-8"))
        audit.check(
            "working dataset unchanged",
            stable_manifest_hash(current) == expected_working_hash,
            f"public/data/city-tiles manifest differs from {protected_baseline}",
        )
    for relative, recorded in protected_inputs.items():
        if recorded.get("missing"):
            continue
        path = ROOT / relative
        audit.check(
            f"protected input untouched: {relative}",
            path.exists() and sha256_file(path) == recorded["sha256"],
            f"{relative} changed during staging",
        )

    _write(args, audit, address_reconciliation, protected_baseline)
    print(
        f"Audit: {len(audit.checks)} checks, {audit.failed} failed; "
        f"{len(tiles)} tiles, {total_bytes / 1e6:.2f} MB, "
        f"buildings {sums['buildings']:,}, trees {sums['trees']:,}"
    )
    return 0 if audit.failed == 0 else 1


def _write(
    args,
    audit: Audit,
    address_reconciliation: dict | None = None,
    protected_baseline: str | None = None,
) -> None:
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(
        json.dumps(
            {
                "schema": 2,
                "tilesDir": args.tiles_dir,
                "coverage": args.coverage,
                "protectedBaseline": protected_baseline,
                "addressReconciliation": address_reconciliation,
                "checks": audit.checks,
                "failed": audit.failed,
            },
            ensure_ascii=False,
            indent=1,
        ),
        encoding="utf-8",
    )
    print(f"Wrote {out}")


if __name__ == "__main__":
    raise SystemExit(main())
