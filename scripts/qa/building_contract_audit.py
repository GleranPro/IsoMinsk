"""Fail-closed source/geometry audit for a styled complete-city candidate.

Compares an accepted *before* tile directory with a styled *after* directory and
checks, for every tile and every building:

* the same tile address book and the same source feature ids;
* unchanged archetype, roof shape, levels, height (within 0.05 m), curated
  landmark id and payload tags (explicit `roof:shape` and `building:material`
  stay authoritative);
* every source volume is preserved: when the candidate records `sourceVolumes`
  those must equal the before volumes, otherwise `volumes` itself must match
  (plan bounds within 0.005 m, top bound within 0.05 m);
* the style record is schema 1, references a registered recipe, matches the
  broad archetype and records valid provenance; the unknown-fallback count must
  be zero for an accepted dataset;
* style coverage: at least 24 recipe ids used, and at least 3 distinct recipes
  for every broad generic archetype with at least 6 eligible source buildings.

Writes a compact JSON report; exits 1 on any failure.

Run:

    .venv\\Scripts\\python.exe scripts/qa/building_contract_audit.py \
        --before-dir public/data/city-tiles \
        --after-dir data/staging/city-buildings \
        --out docs/building-quality/style-audit.json
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts" / "normalize"))

import style_recipes  # noqa: E402 - repository-local registry mirror

GENERIC_ARCHETYPES = (
    "stalin",
    "khrushchev",
    "panel",
    "modern",
    "office",
    "historic",
    "industrial",
    "small",
    "civic",
)
REQUIRED_RECIPE_IDS = 24
REQUIRED_PER_ARCHETYPE = 3
ARCHETYPE_MIN_BUILDINGS = 6
TOP_TOLERANCE_M = 0.05
PLAN_TOLERANCE_M = 0.005
PROJECTION_ALLOWANCE_M = 0.45


def stable_manifest_hash(manifest: dict) -> str:
    stable = {key: value for key, value in manifest.items() if key != "generatedAt"}
    payload = json.dumps(stable, sort_keys=True, ensure_ascii=False).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def load_tiles(directory: Path) -> tuple[dict, dict[str, dict]]:
    manifest = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
    tiles: dict[str, dict] = {}
    for entry in manifest.get("tiles", []):
        key = f"{entry['x']}_{entry['y']}"
        path = directory / Path(entry["file"]).name
        tiles[key] = json.loads(path.read_text(encoding="utf-8"))
    return manifest, tiles


def ring_bounds(polygon: list[list[list[float]]]) -> tuple[float, float, float, float] | None:
    xs: list[float] = []
    ys: list[float] = []
    for ring in polygon or []:
        for point in ring:
            if len(point) < 2:
                continue
            xs.append(float(point[0]))
            ys.append(float(point[1]))
    if not xs:
        return None
    return min(xs), min(ys), max(xs), max(ys)


def bounds_close(
    a: tuple[float, float, float, float] | None,
    b: tuple[float, float, float, float] | None,
    tolerance: float,
) -> bool:
    if a is None or b is None:
        return a is b
    return all(abs(a[index] - b[index]) <= tolerance for index in range(4))


def volume_signature(volume: dict) -> dict:
    polygon = volume.get("footprint") or []
    return {
        "minHeight": float(volume.get("minHeight", 0.0)),
        "height": float(volume.get("height", 0.0)),
        "roofShape": volume.get("roofShape"),
        "roofHeight": float(volume.get("roofHeight", 0.0)),
        "bounds": ring_bounds(polygon),
        "ringCount": len(polygon),
        "isPart": bool(volume.get("isPart")),
    }


class Audit:
    def __init__(self) -> None:
        self.failures: list[dict] = []
        self.checks: list[dict] = []

    def check(self, name: str, ok: bool, detail: str = "") -> bool:
        self.checks.append({"name": name, "ok": bool(ok), "detail": detail})
        if not ok:
            print(f"FAIL  {name}: {detail}", file=sys.stderr)
        return ok

    def fail(self, tile: str, building_id: str, reason: str, detail: str = "") -> None:
        if len(self.failures) < 200:
            self.failures.append(
                {"tile": tile, "buildingId": building_id, "reason": reason, "detail": detail}
            )


def main() -> int:
    parser = argparse.ArgumentParser(description="Audit a styled complete-city candidate")
    parser.add_argument("--before-dir", required=True)
    parser.add_argument("--after-dir", required=True)
    parser.add_argument("--out", default="docs/building-quality/style-audit.json")
    parser.add_argument("--gallery-results", default="docs/building-quality/gallery-results.json")
    args = parser.parse_args()

    before_dir = Path(args.before_dir)
    after_dir = Path(args.after_dir)
    audit = Audit()

    before_manifest, before_tiles = load_tiles(before_dir)
    after_manifest, after_tiles = load_tiles(after_dir)

    before_addresses = set(before_tiles)
    after_addresses = set(after_tiles)
    audit.check(
        "tile address book unchanged",
        before_addresses == after_addresses,
        f"before {len(before_addresses)} vs after {len(after_addresses)}; "
        f"missing={sorted(before_addresses - after_addresses)[:5]} extra={sorted(after_addresses - before_addresses)[:5]}",
    )
    audit.check(
        "tile count matches",
        len(after_manifest.get("tiles", [])) == len(before_manifest.get("tiles", [])),
        f"{len(after_manifest.get('tiles', []))} vs {len(before_manifest.get('tiles', []))}",
    )

    recipe_counts: Counter = Counter()
    archetype_counts: Counter = Counter()
    archetype_recipes: dict[str, set[int]] = defaultdict(set)
    palette_by_recipe: dict[int, set[tuple[str, ...]]] = defaultdict(set)
    missing_style = 0
    invalid_style = 0
    mismatched_style = 0
    profiled = 0
    compared_buildings = 0
    compared_volumes = 0

    for key in sorted(before_addresses & after_addresses):
        before_tile = before_tiles[key]
        after_tile = after_tiles[key]
        before_buildings = {building["id"]: building for building in before_tile.get("buildings", [])}
        after_buildings = {building["id"]: building for building in after_tile.get("buildings", [])}
        audit.check(
            f"tile {key}: building ids unchanged",
            set(before_buildings) == set(after_buildings),
            f"before {len(before_buildings)} vs after {len(after_buildings)}; "
            f"missing={sorted(set(before_buildings) - set(after_buildings))[:3]} "
            f"extra={sorted(set(after_buildings) - set(before_buildings))[:3]}",
        ) if set(before_buildings) != set(after_buildings) else None

        for building_id in sorted(set(before_buildings) & set(after_buildings)):
            compared_buildings += 1
            before = before_buildings[building_id]
            after = after_buildings[building_id]
            if after.get("archetype") != before.get("archetype"):
                audit.fail(key, building_id, "archetype_changed")
            if abs(float(after.get("height", 0)) - float(before.get("height", 0))) > TOP_TOLERANCE_M:
                audit.fail(key, building_id, "height_changed", f"{before.get('height')} -> {after.get('height')}")
            if after.get("roofShape") != before.get("roofShape"):
                audit.fail(key, building_id, "roof_shape_changed")
            if after.get("levels") != before.get("levels"):
                audit.fail(key, building_id, "levels_changed")
            if after.get("landmark") != before.get("landmark"):
                audit.fail(key, building_id, "landmark_changed")
            before_tags = before.get("tags") or {}
            after_tags = after.get("tags") or {}
            for tag in ("roof:shape", "building:material", "building:levels", "start_date"):
                if before_tags.get(tag) != after_tags.get(tag):
                    audit.fail(key, building_id, "tag_changed", tag)
            if bool(before.get("roofShapeExplicit")) != bool(after.get("roofShapeExplicit")):
                audit.fail(key, building_id, "explicit_roof_flag_changed")

            # --- volumes: source preservation ---------------------------------
            before_volumes = before.get("volumes") or []
            source_volumes = after.get("sourceVolumes")
            compared = source_volumes if source_volumes is not None else after.get("volumes") or []
            if source_volumes is not None:
                profiled += 1
            if len(compared) != len(before_volumes):
                audit.fail(
                    key,
                    building_id,
                    "volume_count_changed",
                    f"{len(before_volumes)} -> {len(compared)}",
                )
            else:
                for index, (before_volume, after_volume) in enumerate(zip(before_volumes, compared)):
                    compared_volumes += 1
                    a = volume_signature(before_volume)
                    b = volume_signature(after_volume)
                    if abs(a["height"] - b["height"]) > TOP_TOLERANCE_M:
                        audit.fail(key, building_id, "volume_top_changed", f"volume {index}")
                    if abs(a["minHeight"] - b["minHeight"]) > PLAN_TOLERANCE_M:
                        audit.fail(key, building_id, "volume_base_changed", f"volume {index}")
                    if not bounds_close(a["bounds"], b["bounds"], PLAN_TOLERANCE_M):
                        audit.fail(key, building_id, "volume_plan_changed", f"volume {index}")
                    if a["roofShape"] != b["roofShape"]:
                        audit.fail(key, building_id, "volume_roof_changed", f"volume {index}")
                    if abs(a["roofHeight"] - b["roofHeight"]) > TOP_TOLERANCE_M:
                        audit.fail(key, building_id, "volume_roof_height_changed", f"volume {index}")

            # --- style record --------------------------------------------------
            variant = after.get("styleVariant")
            if not isinstance(variant, dict):
                missing_style += 1
                audit.fail(key, building_id, "missing_style_variant")
                continue
            recipe_id = variant.get("recipeId")
            source = variant.get("source")
            if (
                variant.get("schema") != 1
                or not isinstance(recipe_id, int)
                or not 0 <= recipe_id < style_recipes.FACADE_PRESET_COUNT
                or source not in {"osm_hint", "heuristic", "legacy_default"}
                or not isinstance(variant.get("eligibility"), list)
            ):
                invalid_style += 1
                audit.fail(key, building_id, "invalid_style_variant", json.dumps(variant)[:120])
                continue
            archetype = after.get("archetype")
            recipe = style_recipes.get_style_recipe(recipe_id, archetype)
            if recipe.id != recipe_id:
                mismatched_style += 1
                audit.fail(
                    key,
                    building_id,
                    "style_recipe_archetype_mismatch",
                    f"recipe {recipe_id} ({recipe.name}) for {archetype}",
                )
            recipe_counts[recipe_id] += 1
            archetype_counts[archetype] += 1
            archetype_recipes[archetype].add(recipe_id)
            palette_by_recipe[recipe_id].add(tuple(recipe.palette))

    audit.check("buildings compared", compared_buildings > 0, f"{compared_buildings} buildings")
    audit.check("no missing style records", missing_style == 0, f"{missing_style} buildings without styleVariant")
    audit.check("no invalid style records", invalid_style == 0, f"{invalid_style} invalid styleVariant records")
    audit.check(
        "no unknown/archetype-mismatched recipe fallback",
        mismatched_style == 0,
        f"{mismatched_style} mismatched records (an accepted dataset must not fall back)",
    )

    # --- style coverage ------------------------------------------------------
    family_ids = sorted(recipe_id for recipe_id in recipe_counts if recipe_id < style_recipes.FAMILY_RECIPE_COUNT)
    legacy_ids = sorted(recipe_id for recipe_id in recipe_counts if recipe_id >= style_recipes.LEGACY_RECIPE_OFFSET)
    audit.check(
        "at least 24 eligible recipe ids used",
        len(family_ids) >= REQUIRED_RECIPE_IDS,
        f"{len(family_ids)} family recipes used: {family_ids}",
    )
    per_archetype = {}
    for archetype in GENERIC_ARCHETYPES:
        buildings = archetype_counts.get(archetype, 0)
        recipes = sorted(archetype_recipes.get(archetype, set()))
        per_archetype[archetype] = {
            "buildings": buildings,
            "recipes": recipes,
            "distinctRecipes": len(recipes),
            "eligible": buildings >= ARCHETYPE_MIN_BUILDINGS,
        }
        if buildings >= ARCHETYPE_MIN_BUILDINGS:
            audit.check(
                f"archetype {archetype}: >= 3 meaningful recipes",
                len(recipes) >= REQUIRED_PER_ARCHETYPE,
                f"{buildings} buildings, recipes {recipes}",
            )

    gallery_available = False
    gallery_ids: list[int] = []
    gallery_path = Path(args.gallery_results)
    if gallery_path.exists():
        gallery = json.loads(gallery_path.read_text(encoding="utf-8"))
        gallery_ids = [panel["recipeId"] for panel in gallery.get("panels", [])]
        gallery_available = len(set(gallery_ids)) >= style_recipes.FAMILY_RECIPE_COUNT

    report = {
        "schema": 1,
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "before": {
            "directory": str(before_dir),
            "manifestSha256": stable_manifest_hash(before_manifest),
            "tiles": len(before_tiles),
            "buildings": before_manifest.get("counts", {}).get("buildings"),
            "version": before_manifest.get("version"),
        },
        "after": {
            "directory": str(after_dir),
            "manifestSha256": stable_manifest_hash(after_manifest),
            "tiles": len(after_tiles),
            "buildings": after_manifest.get("counts", {}).get("buildings"),
            "version": after_manifest.get("version"),
            "styleSchema": after_manifest.get("styleSchema"),
            "styleRunId": after_manifest.get("styleRunId"),
            "sourceDatasetId": after_manifest.get("sourceDatasetId"),
            "sourceInputSha256": after_manifest.get("sourceInputSha256"),
        },
        "compared": {
            "buildings": compared_buildings,
            "volumes": compared_volumes,
            "profiledBuildings": profiled,
        },
        "tolerances": {
            "topM": TOP_TOLERANCE_M,
            "planM": PLAN_TOLERANCE_M,
            "projectionAllowanceM": PROJECTION_ALLOWANCE_M,
        },
        "style": {
            "familyRecipeIdsUsed": family_ids,
            "legacyRecipeIdsUsed": legacy_ids,
            "recipeCounts": {str(key): value for key, value in sorted(recipe_counts.items())},
            "paletteFamilies": {str(key): len(value) for key, value in sorted(palette_by_recipe.items())},
            "perArchetype": per_archetype,
            "galleryAvailable": gallery_available,
            "galleryRecipeIds": sorted(set(gallery_ids)),
        },
        "failures": audit.failures,
        "checks": audit.checks,
        "failed": sum(1 for check in audit.checks if not check["ok"]) + len(audit.failures),
    }

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    print(
        f"Wrote {out}: {len(audit.checks)} checks, {len(audit.failures)} building failures; "
        f"{compared_buildings} buildings, {len(family_ids)} family recipes, "
        f"{sum(1 for item in per_archetype.values() if item['eligible'])} eligible archetypes"
    )
    return 0 if report["failed"] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
