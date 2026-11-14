"""Cross-language contract tests for the style recipe registry.

The TypeScript catalog (``src/shared/building-style-recipes.json``) and the
Python mirror (``scripts/normalize/style_recipes.py``) must agree row by row:
same ids, names, archetypes, profiles, motifs, roofs, details and palettes. The
legacy preset copies must also agree with the TypeScript copies, because
protected palace/stadium routes depend on those exact facade parameters.
"""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

# `style_recipes` lives in scripts/normalize; make the module importable both
# under `unittest discover -s scripts/normalize/tests` and when the file is run
# directly.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from style_recipes import (
    ARCHETYPE_BY_ID,
    FACADE_PRESET_COUNT,
    FAMILY_RECIPES,
    FAMILY_RECIPE_COUNT,
    LEGACY_PRESETS,
    LEGACY_RECIPE_OFFSET,
    get_style_recipe,
    legacy_archetype_for_recipe_id,
    legacy_recipe_for,
    legacy_style_id,
    pack_style_bits,
    unpack_style_bits,
)

ROOT = Path(__file__).resolve().parents[3]
CATALOG = ROOT / "src" / "shared" / "building-style-recipes.json"
SCHEMA = ROOT / "src" / "shared" / "building-style-recipes.schema.json"
GEOMETRY_TS = ROOT / "src" / "shared" / "geometry.ts"
PRESETS_TS = ROOT / "src" / "city" / "facades" / "presets.ts"
STYLES_TS = ROOT / "src" / "shared" / "buildingStyles.ts"


class RegistryParityTest(unittest.TestCase):
    def test_typescript_json_registry_agrees(self):
        document = json.loads(CATALOG.read_text(encoding="utf-8"))
        self.assertEqual(len(document), FAMILY_RECIPE_COUNT)
        for entry in document:
            recipe = get_style_recipe(entry["id"])
            self.assertEqual(recipe.id, entry["id"])
            self.assertEqual(recipe.name, entry["name"])
            self.assertEqual(recipe.archetype, entry["archetype"])
            self.assertEqual(recipe.profile, entry["profile"])
            self.assertEqual(recipe.facade, entry["facade"])
            self.assertEqual(recipe.roof, entry["roof"])
            self.assertEqual(list(recipe.details), entry["details"])
            self.assertEqual(list(recipe.palette), entry["palette"])

    def test_ids_are_stable_and_ordered(self):
        self.assertEqual([recipe.id for recipe in FAMILY_RECIPES], list(range(FAMILY_RECIPE_COUNT)))
        self.assertEqual(FAMILY_RECIPES[26].name, "assembly_hall")

    def test_schema_file_documents_the_same_contract(self):
        schema = json.loads(SCHEMA.read_text(encoding="utf-8"))
        required = schema["items"]["required"]
        self.assertEqual(
            required,
            ["id", "name", "archetype", "profile", "facade", "roof", "details", "palette"],
        )
        self.assertEqual(schema["items"]["additionalProperties"], False)
        self.assertEqual(schema["minItems"], FAMILY_RECIPE_COUNT)
        self.assertEqual(schema["maxItems"], FAMILY_RECIPE_COUNT)


class LegacyPresetParityTest(unittest.TestCase):
    def test_archetype_order_matches_geometry_ts(self):
        """`legacy_style_id` must use the same 11-entry order as ARCHETYPE_BY_ID."""
        source = GEOMETRY_TS.read_text(encoding="utf-8")
        block = source.split("export const ARCHETYPE_BY_ID: Archetype[] = [", 1)[1]
        block = block.split("];", 1)[0]
        names = [line.strip().strip("',").strip("'") for line in block.splitlines() if line.strip()]
        self.assertEqual(tuple(names), ARCHETYPE_BY_ID)

    def test_legacy_ids_reserve_27_to_37(self):
        self.assertEqual(LEGACY_RECIPE_OFFSET, 27)
        self.assertEqual(FACADE_PRESET_COUNT, 38)
        for index, archetype in enumerate(ARCHETYPE_BY_ID):
            self.assertEqual(legacy_style_id(archetype), 27 + index)
            self.assertEqual(legacy_archetype_for_recipe_id(27 + index), archetype)
            self.assertEqual(legacy_recipe_for(archetype).name, f"legacy_default_{archetype}")
        self.assertEqual(legacy_style_id("palace"), 36)
        self.assertEqual(legacy_style_id("stadium"), 37)

    def test_presets_ts_values_match_the_frozen_python_copy(self):
        """Parse the TypeScript preset table and compare every numeric value."""
        source = PRESETS_TS.read_text(encoding="utf-8")
        table = source.split("export const FACADE_PRESETS: Record<Archetype, FacadePreset> = {", 1)[1]
        table = table.split("\n};", 1)[0]
        entries: dict[str, dict[str, object]] = {}
        current: str | None = None
        for raw_line in table.splitlines():
            line = raw_line.strip()
            if line.endswith(": {") and not line.startswith("//"):
                current = line[: -len(": {")].strip()
                entries[current] = {}
                continue
            if current is None:
                continue
            if line.startswith("}"):
                current = None
                continue
            if ":" not in line:
                continue
            key, _, value = line.partition(":")
            key = key.strip()
            value = value.strip().rstrip(",")
            if key in {
                "floorHeight",
                "groundFloorHeight",
                "bayWidth",
                "windowWidthRatio",
                "windowHeightRatio",
                "sillRatio",
                "corniceHeight",
                "balconyRatio",
            }:
                entries[current][key] = float(value)
        self.assertEqual(set(entries), set(ARCHETYPE_BY_ID))
        for archetype, preset in LEGACY_PRESETS.items():
            parsed = entries[archetype]
            self.assertEqual(float(preset.floor_height), parsed["floorHeight"], archetype)
            self.assertEqual(float(preset.ground_floor_height), parsed["groundFloorHeight"], archetype)
            self.assertEqual(float(preset.bay_width), parsed["bayWidth"], archetype)
            self.assertEqual(float(preset.window_width_ratio), parsed["windowWidthRatio"], archetype)
            self.assertEqual(float(preset.window_height_ratio), parsed["windowHeightRatio"], archetype)
            self.assertEqual(float(preset.sill_ratio), parsed["sillRatio"], archetype)
            self.assertEqual(float(preset.cornice_height), parsed["corniceHeight"], archetype)
            self.assertEqual(float(preset.balcony_ratio), parsed["balconyRatio"], archetype)

    def test_style_bit_packing_is_float32_exact(self):
        for recipe_id in (0, 1, 17, 26, 37, 255):
            packed = pack_style_bits(0xFF, recipe_id)
            self.assertLess(packed, 2 ** 24)
            self.assertEqual(unpack_style_bits(packed), (0xFF, recipe_id))
        with self.assertRaises(ValueError):
            pack_style_bits(0, -1)
        with self.assertRaises(ValueError):
            pack_style_bits(0, 256)


class FallbackTest(unittest.TestCase):
    def test_unknown_ids_fall_back_to_the_source_archetype(self):
        self.assertEqual(get_style_recipe(999).name, "legacy_default_panel")
        self.assertEqual(get_style_recipe(-1, "stalin").name, "legacy_default_stalin")
        self.assertEqual(get_style_recipe(6, "khrushchev").name, "legacy_default_khrushchev")
        self.assertEqual(get_style_recipe(6, "panel").name, "recessed_loggia")
        self.assertEqual(get_style_recipe(27).name, "legacy_default_stalin")
        self.assertEqual(get_style_recipe(37).name, "legacy_default_stadium")

    def test_typescript_module_exposes_the_same_public_names(self):
        source = STYLES_TS.read_text(encoding="utf-8")
        for symbol in (
            "export function getStyleRecipe",
            "export function packStyleBits",
            "export function unpackStyleBits",
            "export const LEGACY_RECIPE_OFFSET = 27",
            "export function legacyRecipeFor",
        ):
            self.assertIn(symbol, source)


if __name__ == "__main__":
    unittest.main()
