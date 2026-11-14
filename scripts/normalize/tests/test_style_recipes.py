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


# ---------------------------------------------------------------------------
# Task 2: deterministic, source-local style selection
# ---------------------------------------------------------------------------

from shapely.geometry import Polygon  # noqa: E402

from style_recipes import (  # noqa: E402
    BASE_RECIPE_ID,
    STYLE_SCHEMA_VERSION,
    StyleInput,
    StyleSelection,
    base_recipe_id,
    eligible_recipes,
    select_style,
    stable_unit,
)

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

# A broad coverage matrix: tiny, normal, elongated and very tall footprints for
# every generic archetype. The weight contract must hold for all of them.
BROAD_FOOTPRINTS = (
    (8.0, 5.0, 3.6, 1),
    (10.0, 10.0, 6.0, 2),
    (18.0, 8.0, 9.0, 3),
    (30.0, 12.0, 18.0, 5),
    (60.0, 16.0, 30.0, 9),
    (40.0, 40.0, 45.0, 14),
)


def rect(x0: float, y0: float, x1: float, y1: float) -> Polygon:
    """Axis-aligned rectangle polygon used by every selector fixture."""
    return Polygon([(x0, y0), (x1, y0), (x1, y1), (x0, y1)])


def courtyard_rect(width: float, depth: float, inset: float = 0.35) -> Polygon:
    """Rectangle with a real courtyard hole (exterior ring + interior ring)."""
    outer = [(0.0, 0.0), (width, 0.0), (width, depth), (0.0, depth)]
    hx, hy = width * inset, depth * inset
    inner = [(hx, hy), (width - hx, hy), (width - hx, depth - hy), (hx, depth - hy)]
    return Polygon(outer, [inner])


def historic_fixture(
    feature_id: str = "w2005",
    *,
    width: float = 18.0,
    depth: float = 8.0,
    height: float = 9.0,
    levels: int | None = 3,
    tags: dict[str, str] | None = None,
    has_parts: bool = False,
    courtyard: bool = False,
) -> StyleInput:
    """A real local StyleInput for the common historic rectangle fixture."""
    polygon = courtyard_rect(width, depth) if courtyard else rect(0.0, 0.0, width, depth)
    return StyleInput(
        id=feature_id,
        archetype="historic",
        tags=tags or {},
        polygon=polygon,
        height=height,
        levels=levels,
        has_parts=has_parts,
    )


class StableHashTest(unittest.TestCase):
    def test_hash_formula_is_the_documented_salted_blake2b(self):
        import hashlib

        feature_id = "w2005"
        digest = hashlib.blake2b(
            f"{feature_id}|style-schema-1".encode("utf-8"), digest_size=8
        ).digest()
        expected = int.from_bytes(digest, "big") / float(2 ** 64 - 1)
        self.assertEqual(stable_unit(feature_id), expected)
        self.assertGreaterEqual(stable_unit(feature_id), 0.0)
        self.assertLessEqual(stable_unit(feature_id), 1.0)
        self.assertEqual(STYLE_SCHEMA_VERSION, 1)

    def test_unit_is_stable_and_source_local(self):
        ids = [f"w{index}" for index in range(1000)]
        first = [stable_unit(feature_id) for feature_id in ids]
        second = [stable_unit(feature_id) for feature_id in ids]
        self.assertEqual(first, second)
        # A hash, not a counter: distinct ids spread over the 0..1 range.
        self.assertGreater(len(set(first)), 990)
        self.assertEqual(stable_unit("w42"), stable_unit("w42"))


class SelectionBoundaryTest(unittest.TestCase):
    def test_explicit_gable_is_not_changed(self):
        source = StyleInput(
            id="w2005",
            archetype="historic",
            tags={"roof:shape": "gabled"},
            polygon=Polygon([(0, 0), (18, 0), (18, 8), (0, 8)]),
            height=9.0,
            levels=3,
            has_parts=False,
        )
        selection = select_style(source)
        self.assertEqual(selection.recipe_id, 16)
        self.assertEqual(selection.source, "osm_hint")
        self.assertIn("explicit_roof:gabled", selection.eligibility)
        # Only the gable-compatible family is a candidate.
        self.assertEqual([recipe.id for recipe, _ in eligible_recipes(source)], [16])

    def test_all_selection_is_source_local_and_stable(self):
        for name in ("w2005", "w3002", "w3001"):
            source = historic_fixture(feature_id=name)
            first = select_style(source)
            second = select_style(source)
            self.assertEqual(first, second)
            self.assertIsInstance(first, StyleSelection)

    def test_feature_id_order_among_10000_buildings_does_not_matter(self):
        target = historic_fixture(feature_id="w3002")
        expected = select_style(target)
        for index in range(10000):
            # Simulate a changing tile/processing order: every iteration sees a
            # different predecessor, the target itself must never change.
            other = StyleInput(
                id=f"w{200000 + index}",
                archetype="office",
                tags={},
                polygon=rect(0.0, 0.0, 24.0, 14.0),
                height=20.0,
                levels=5,
                has_parts=False,
            )
            select_style(other)
            if index % 1000 == 0:
                self.assertEqual(select_style(target), expected)
        self.assertEqual(select_style(target), expected)

    def test_small_outbuilding_never_gets_apartment_glass(self):
        source = StyleInput(
            id="w42",
            archetype="small",
            tags={"building": "garage"},
            polygon=Polygon([(0, 0), (6, 0), (6, 3), (0, 3)]),
            height=3.2,
            levels=1,
            has_parts=False,
        )
        self.assertIn(select_style(source).recipe_id, {22, 23})
        for index in range(50):
            variant = StyleInput(
                id=f"w{5000 + index}",
                archetype="small",
                tags={"building": "garage"},
                polygon=rect(0.0, 0.0, 6.0, 3.0),
                height=3.2,
                levels=1,
                has_parts=False,
            )
            self.assertIn(select_style(variant).recipe_id, {22, 23})
            self.assertTrue({recipe.id for recipe, _ in eligible_recipes(variant)} <= {22, 23})

    def test_material_tag_selects_brick_punched_as_osm_hint(self):
        source = StyleInput(
            id="w77",
            archetype="khrushchev",
            tags={"building:material": "brick"},
            polygon=rect(0.0, 0.0, 40.0, 12.0),
            height=14.5,
            levels=5,
            has_parts=False,
        )
        selection = select_style(source)
        self.assertEqual(selection.recipe_id, 3)
        self.assertEqual(selection.source, "osm_hint")
        # Without the material tag the brick family stays a weighted heuristic.
        plain = StyleInput(
            id="w77",
            archetype="khrushchev",
            tags={},
            polygon=rect(0.0, 0.0, 40.0, 12.0),
            height=14.5,
            levels=5,
            has_parts=False,
        )
        self.assertIn(select_style(plain).recipe_id, {3, 4, 5})

    def test_explicit_multi_part_tower_is_eligible_for_modern(self):
        ids = [f"w{9000 + index}" for index in range(200)]
        with_parts = {
            select_style(
                StyleInput(
                    id=feature_id,
                    archetype="modern",
                    tags={},
                    polygon=rect(0.0, 0.0, 30.0, 20.0),
                    height=45.0,
                    levels=15,
                    has_parts=True,
                )
            ).recipe_id
            for feature_id in ids
        }
        # 9 is a real weighted candidate and the hash walk reaches it.
        self.assertIn(9, with_parts)
        self.assertTrue(with_parts <= {9, 11})
        # Never invent a tower on a single-volume modern building.
        without_parts = {
            select_style(
                StyleInput(
                    id=feature_id,
                    archetype="modern",
                    tags={},
                    polygon=rect(0.0, 0.0, 30.0, 20.0),
                    height=45.0,
                    levels=15,
                    has_parts=False,
                )
            ).recipe_id
            for feature_id in ids
        }
        self.assertNotIn(9, without_parts)
        self.assertTrue(without_parts <= {10, 11})

    def test_detached_house_gets_hipped_house_not_a_service_annex(self):
        for tags in (
            {"building": "house"},
            {"building": "villa"},
            {"building": "detached"},
            {"roof:shape": "hipped"},
        ):
            source = StyleInput(
                id="w300",
                archetype="small",
                tags=tags,
                polygon=rect(0.0, 0.0, 12.0, 9.0),
                height=8.0,
                levels=2,
                has_parts=False,
            )
            self.assertIn(21, {recipe.id for recipe, _ in eligible_recipes(source)})
            for index in range(40):
                variant = StyleInput(
                    id=f"w{3000 + index}",
                    archetype="small",
                    tags=tags,
                    polygon=rect(0.0, 0.0, 12.0, 9.0),
                    height=8.0,
                    levels=2,
                    has_parts=False,
                )
                selected = select_style(variant).recipe_id
                self.assertNotEqual(selected, 22)
                self.assertIn(selected, {21, 23})

    def test_courtyard_and_oversized_historic_never_get_a_mansard(self):
        courtyard = historic_fixture(feature_id="w400", courtyard=True)
        self.assertNotIn(17, {recipe.id for recipe, _ in eligible_recipes(courtyard)})
        oversized_area = historic_fixture(feature_id="w401", width=40.0, depth=30.0, height=12.0)
        self.assertNotIn(17, {recipe.id for recipe, _ in eligible_recipes(oversized_area)})
        too_tall = historic_fixture(feature_id="w402", width=20.0, depth=10.0, height=15.0)
        self.assertNotIn(17, {recipe.id for recipe, _ in eligible_recipes(too_tall)})
        narrow = historic_fixture(feature_id="w403", width=20.0, depth=4.0, height=9.0)
        self.assertNotIn(17, {recipe.id for recipe, _ in eligible_recipes(narrow)})
        narrowed = historic_fixture(feature_id="w404", width=20.0, depth=10.0, height=9.0)
        self.assertIn(17, {recipe.id for recipe, _ in eligible_recipes(narrowed)})
        for fixture in (courtyard, oversized_area, too_tall, narrow):
            for index in range(25):
                variant = StyleInput(
                    id=f"w{6000 + index}",
                    archetype=fixture.archetype,
                    tags=dict(fixture.tags),
                    polygon=fixture.polygon,
                    height=fixture.height,
                    levels=fixture.levels,
                    has_parts=fixture.has_parts,
                )
                self.assertNotEqual(select_style(variant).recipe_id, 17)

    def test_short_industrial_hall_never_gets_a_sawtooth(self):
        short = StyleInput(
            id="w700",
            archetype="industrial",
            tags={},
            polygon=rect(0.0, 0.0, 10.0, 8.0),
            height=8.0,
            levels=None,
            has_parts=False,
        )
        self.assertNotIn(18, {recipe.id for recipe, _ in eligible_recipes(short)})
        for index in range(25):
            variant = StyleInput(
                id=f"w{7000 + index}",
                archetype="industrial",
                tags={},
                polygon=rect(0.0, 0.0, 14.9, 9.0),
                height=8.0,
                levels=None,
                has_parts=False,
            )
            self.assertNotEqual(select_style(variant).recipe_id, 18)
        # An eligible long, tall hall does offer the sawtooth family.
        long_hall = StyleInput(
            id="w701",
            archetype="industrial",
            tags={},
            polygon=rect(0.0, 0.0, 36.0, 16.0),
            height=9.0,
            levels=None,
            has_parts=False,
        )
        self.assertIn(18, {recipe.id for recipe, _ in eligible_recipes(long_hall)})

    def test_declared_roof_shapes_stay_authoritative(self):
        hipped_house = StyleInput(
            id="w800",
            archetype="small",
            tags={"roof:shape": "hipped"},
            polygon=rect(0.0, 0.0, 12.0, 9.0),
            height=7.0,
            levels=2,
            has_parts=False,
        )
        self.assertEqual(select_style(hipped_house).recipe_id, 21)
        flat_garage = StyleInput(
            id="w801",
            archetype="small",
            tags={"building": "garage", "roof:shape": "flat"},
            polygon=rect(0.0, 0.0, 6.0, 4.0),
            height=3.0,
            levels=1,
            has_parts=False,
        )
        self.assertEqual(select_style(flat_garage).recipe_id, 22)
        gabled_garage = StyleInput(
            id="w802",
            archetype="small",
            tags={"building": "garage", "roof:shape": "gabled"},
            polygon=rect(0.0, 0.0, 6.0, 4.0),
            height=3.5,
            levels=1,
            has_parts=False,
        )
        self.assertEqual(select_style(gabled_garage).recipe_id, 23)
        # A flat-roofed historic house must not gain a mansard.
        flat_historic = historic_fixture(feature_id="w803", tags={"roof:shape": "flat"})
        self.assertNotIn(17, {recipe.id for recipe, _ in eligible_recipes(flat_historic)})
        self.assertEqual(select_style(flat_historic).recipe_id, 15)

    def test_source_roof_direction_and_tags_are_never_mutated(self):
        tags = {
            "roof:shape": "gabled",
            "roof:direction": "N",
            "roof:angle": "38",
            "building:material": "brick",
            "height": "9",
            "building:levels": "3",
        }
        snapshot = dict(tags)
        source = historic_fixture(feature_id="w900", tags=tags)
        selection = select_style(source)
        self.assertEqual(tags, snapshot)
        self.assertEqual(source.tags, snapshot)
        self.assertEqual(source.height, 9.0)
        self.assertEqual(
            {field for field in selection.__dataclass_fields__},
            {"recipe_id", "source", "eligibility"},
        )
        # Nothing in the selection can rewrite a roof.
        self.assertFalse(hasattr(selection, "roof_shape"))
        self.assertNotIn("roof", " ".join(str(value).lower() for value in (selection.recipe_id, selection.source)))

    def test_protected_archetypes_never_get_family_recipes(self):
        for archetype in ("palace", "stadium"):
            source = StyleInput(
                id="w1000",
                archetype=archetype,
                tags={},
                polygon=rect(0.0, 0.0, 20.0, 10.0),
                height=20.0,
                levels=5,
                has_parts=False,
            )
            self.assertEqual(eligible_recipes(source), [])
            selection = select_style(source)
            self.assertEqual(selection.recipe_id, legacy_style_id(archetype))
            self.assertIn("protected_archetype", selection.eligibility)

    def test_invalid_sources_are_rejected(self):
        with self.assertRaises(ValueError):
            select_style(
                StyleInput("w1", "spaceship", {}, rect(0.0, 0.0, 10.0, 5.0), 5.0, 1, False)
            )
        with self.assertRaises(ValueError):
            select_style(StyleInput("", "historic", {}, rect(0.0, 0.0, 10.0, 5.0), 5.0, 1, False))
        with self.assertRaises(ValueError):
            select_style(StyleInput("w1", "historic", {}, Polygon(), 5.0, 1, False))
        with self.assertRaises(ValueError):
            select_style(
                StyleInput("w1", "historic", {}, rect(0.0, 0.0, 10.0, 5.0), float("nan"), 1, False)
            )
        with self.assertRaises(ValueError):
            select_style(
                StyleInput("w1", "historic", {}, rect(0.0, 0.0, 10.0, 5.0), -2.0, 1, False)
            )

    def test_legacy_fallback_mapping_matches_the_registry(self):
        self.assertEqual(set(BASE_RECIPE_ID), set(GENERIC_ARCHETYPES))
        for archetype in GENERIC_ARCHETYPES:
            recipe_id = base_recipe_id(archetype)
            self.assertIn(recipe_id, BASE_RECIPE_ID.values())
            self.assertEqual(get_style_recipe(recipe_id, archetype).id, recipe_id)


class WeightContractTest(unittest.TestCase):
    def test_every_broad_candidate_set_is_a_complete_distribution(self):
        for archetype in GENERIC_ARCHETYPES:
            for width, depth, height, levels in BROAD_FOOTPRINTS:
                source = StyleInput(
                    id=f"w-{archetype}-{width:g}-{depth:g}",
                    archetype=archetype,
                    tags={},
                    polygon=rect(0.0, 0.0, width, depth),
                    height=height,
                    levels=levels,
                    has_parts=False,
                )
                candidates = eligible_recipes(source)
                label = f"{archetype} {width:g}x{depth:g}x{height:g}"
                self.assertTrue(candidates, label)
                total = sum(weight for _, weight in candidates)
                self.assertAlmostEqual(total, 1.0, delta=1e-12, msg=label)
                ids = [recipe.id for recipe, _ in candidates]
                self.assertEqual(len(ids), len(set(ids)), label)
                self.assertIn(base_recipe_id(archetype), ids, label)
                for recipe, weight in candidates:
                    self.assertEqual(recipe.archetype, archetype, label)
                    self.assertGreater(weight, 0.0, label)
                    self.assertLessEqual(weight, 1.0, label)
                self.assertIn(select_style(source).recipe_id, ids, label)

    def test_weight_contract_holds_with_typical_tags(self):
        tag_cases = (
            {"building": "house"},
            {"building": "apartments"},
            {"building:material": "brick"},
            {"building:material": "panel"},
            {"roof:shape": "hipped"},
            {"roof:shape": "gabled"},
            {"roof:shape": "flat"},
            {"amenity": "school"},
            {"building": "warehouse"},
            {"shop": "supermarket"},
        )
        for archetype in GENERIC_ARCHETYPES:
            for tags in tag_cases:
                source = StyleInput(
                    id=f"w-{archetype}-{'-'.join(sorted(tags))}",
                    archetype=archetype,
                    tags=tags,
                    polygon=rect(0.0, 0.0, 24.0, 12.0),
                    height=15.0,
                    levels=5,
                    has_parts=False,
                )
                candidates = eligible_recipes(source)
                label = f"{archetype} {tags}"
                self.assertTrue(candidates, label)
                self.assertAlmostEqual(
                    sum(weight for _, weight in candidates), 1.0, delta=1e-12, msg=label
                )
                for recipe, _ in candidates:
                    self.assertEqual(recipe.archetype, archetype, label)

    def test_protected_and_courtyard_shapes_keep_a_non_empty_fallback(self):
        # Industrial halls with a declared gable have no roof-forcing family
        # left; the safe source-roof fallback must still produce one candidate.
        source = StyleInput(
            id="w1100",
            archetype="industrial",
            tags={"roof:shape": "gabled"},
            polygon=rect(0.0, 0.0, 30.0, 20.0),
            height=10.0,
            levels=None,
            has_parts=False,
        )
        candidates = eligible_recipes(source)
        self.assertTrue(candidates)
        self.assertAlmostEqual(sum(weight for _, weight in candidates), 1.0, delta=1e-12)
        self.assertEqual({recipe.id for recipe, _ in candidates}, {20})


class NormalizeStyleIntegrationTest(unittest.TestCase):
    """The normalizer must emit exactly the metadata the runtime expects."""

    def test_building_tags_out_keeps_material_and_roof_evidence(self):
        import normalize

        tags = {
            "building": "house",
            "building:material": "brick",
            "building:levels": "3",
            "roof:shape": "gabled",
            "roof:direction": "N",
            "addr:street": "Lenina",
            "name": "Дом",
            "highway": "residential",
            "source": "survey",
            "note": "internal",
        }
        out = normalize.building_tags_out(tags)
        self.assertEqual(out["building:material"], "brick")
        self.assertEqual(out["roof:shape"], "gabled")
        self.assertEqual(out["roof:direction"], "N")
        self.assertEqual(out["addr:street"], "Lenina")
        self.assertEqual(out["name"], "Дом")
        self.assertNotIn("highway", out)
        self.assertNotIn("source", out)
        self.assertNotIn("note", out)
        self.assertIsNot(out, tags)

    def test_style_recipe_counts_cover_every_runtime_id_including_legacy(self):
        import normalize

        buildings = [
            {"styleVariant": {"schema": 1, "recipeId": 3, "source": "osm_hint", "eligibility": []}},
            {"styleVariant": {"schema": 1, "recipeId": 3, "source": "heuristic", "eligibility": []}},
            {"styleVariant": {"schema": 1, "recipeId": 36, "source": "legacy_default", "eligibility": []}},
            {"styleVariant": {"schema": 1, "recipeId": 37, "source": "legacy_default", "eligibility": []}},
            {},
        ]
        counts = normalize.style_recipe_counts(buildings)
        self.assertEqual(set(counts), set(range(FACADE_PRESET_COUNT)))
        self.assertEqual(counts[3], 2)
        self.assertEqual(counts[36], 1)
        self.assertEqual(counts[37], 1)
        self.assertEqual(counts[0], 0)
        self.assertEqual(sum(counts.values()), 4)

    def test_source_identity_is_stable_and_content_derived(self):
        import normalize

        meta = {
            "pbf": "belarus-latest.osm.pbf",
            "pbf_size": 1234,
            "pbf_sha256": "a" * 64,
            "window": [1.0, 2.0, 3.0, 4.0],
            "center": [53.9, 27.56],
        }
        bounds = (-100.0, -100.0, 100.0, 100.0)
        dataset_id = normalize.source_dataset_id("city", meta)
        self.assertEqual(dataset_id, normalize.source_dataset_id("city", dict(meta)))
        self.assertIn("city", dataset_id)
        digest = normalize.source_input_sha256("city", meta, 512.0, bounds)
        self.assertEqual(
            digest, normalize.source_input_sha256("city", dict(meta), 512.0, tuple(bounds))
        )
        self.assertEqual(len(digest), 64)
        changed = dict(meta, pbf_sha256="b" * 64)
        self.assertNotEqual(dataset_id, normalize.source_dataset_id("city", changed))
        self.assertNotEqual(
            digest, normalize.source_input_sha256("city", changed, 512.0, bounds)
        )
        self.assertNotEqual(
            digest, normalize.source_input_sha256("city", meta, 1024.0, bounds)
        )

    def test_selection_is_emitted_after_landmark_override_and_before_volumes(self):
        source = (ROOT / "scripts" / "normalize" / "normalize.py").read_text(encoding="utf-8")
        landmark = source.index("landmark_override = LANDMARK_OVERRIDES.get((osm_type, osm_id))")
        protected = source.index("protected_route = bool(landmark_override)")
        selection = source.index("selection = select_style(")
        volumes = source.index("volumes: list[dict] = []")
        payload = source.index("feature['styleVariant'] = style_payload")
        append = source.index("buildings.append(feature)")
        self.assertLess(landmark, protected)
        self.assertLess(protected, selection)
        self.assertLess(selection, volumes)
        self.assertLess(volumes, payload)
        self.assertLess(payload, append)
        # The documented selector input must stay complete: no dropped field.
        for fragment in (
            "StyleInput(",
            "building_id",
            "archetype",
            "tags",
            "polygon",
            "height",
            "levels",
            "bool(part_groups.get(index))",
        ):
            self.assertIn(fragment, source[selection:volumes])
        self.assertIn("from style_recipes import", source)
        self.assertIn("'protected_geometry_route'", source)
        self.assertIn("legacy_style_id(archetype) if protected_route else selection.recipe_id", source)

    def test_manifest_records_style_schema_and_source_identity(self):
        source = (ROOT / "scripts" / "normalize" / "normalize.py").read_text(encoding="utf-8")
        for key in (
            '"styleSchema"',
            '"sourceDatasetId"',
            '"sourceInputSha256"',
            '"styleRecipeCounts"',
            "PAYLOAD_VERSION",
        ):
            self.assertIn(key, source)
        self.assertNotIn('"version": "0.4.3"', source)
        self.assertIn('PAYLOAD_VERSION = "0.5.0"', source)


if __name__ == "__main__":
    unittest.main()
