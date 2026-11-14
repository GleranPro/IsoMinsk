"""Offline procedural building style registry (mirror of the TypeScript catalog).

The canonical catalog is ``src/shared/building-style-recipes.json`` (schema 1).
This module imports no TypeScript: it loads the same JSON document and exposes
the same ids, names, archetypes and eligibility vocabulary, so the Python
selector and the browser renderer can never drift apart silently.

Family recipe ids are ``0..26``. Runtime ids ``27..37`` are reserved for the
eleven legacy archetype presets (``27 + ARCHETYPE_BY_ID index``); protected
routes (curated landmarks, palace, stadium) use those so their previous facade
parameters are reproduced exactly.

Task 2 adds the deterministic selector (``select_style``) on top of this
registry; the registry itself only owns lookup and the frozen preset copies.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CATALOG_PATH = ROOT / "src" / "shared" / "building-style-recipes.json"

FAMILY_RECIPE_COUNT = 27
LEGACY_RECIPE_OFFSET = 27

# Order is the shared contract: `ARCHETYPE_ID` in src/shared/geometry.ts writes
# these indices into aStyle.x and `legacy_style_id` mirrors them.
ARCHETYPE_BY_ID: tuple[str, ...] = (
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
)
ARCHETYPE_ID = {name: index for index, name in enumerate(ARCHETYPE_BY_ID)}
LEGACY_RECIPE_COUNT = len(ARCHETYPE_BY_ID)
FACADE_PRESET_COUNT = FAMILY_RECIPE_COUNT + LEGACY_RECIPE_COUNT

STYLE_PROFILES = ("base", "frame", "end_pavilion", "stepped")
FACADE_MOTIFS = (
    "monument",
    "historic",
    "grid",
    "loggia",
    "balcony_stack",
    "staircore",
    "ribbon",
    "clerestory",
    "blank_service",
    "assembly_hall",
)
RECIPE_ROOFS = ("source", "hip", "mansard", "sawtooth", "clerestory")
DETAIL_KINDS = (
    "entrance",
    "pilasters",
    "cornice",
    "parapet",
    "balconies",
    "loggia",
    "rail",
    "pavilion",
    "stepped",
    "canopy",
    "roof_service",
    "industrial_roof",
    "clerestory",
    "gable",
    "endwall_blank",
    "staircore",
)

# STYLE_FLAG bits (src/shared/geometry.ts).
FLAG_MONUMENT = 1 << 0
FLAG_BALCONIES = 1 << 1
FLAG_SHOPFRONT = 1 << 2
FLAG_CORNICE = 1 << 3
FLAG_PILASTERS = 1 << 4
FLAG_RIBBON = 1 << 5
FLAG_BLANK = 1 << 6
FLAG_ATTIC = 1 << 7


@dataclass(frozen=True)
class StyleRecipe:
    """One catalog row (family or legacy preset)."""

    id: int
    name: str
    archetype: str
    profile: str
    facade: str
    roof: str
    details: tuple[str, ...]
    palette: tuple[str, ...]


@dataclass(frozen=True)
class FacadePreset:
    """Frozen numeric facade preset values of the legacy archetype rows."""

    floor_height: float
    ground_floor_height: float
    bay_width: float
    window_width_ratio: float
    window_height_ratio: float
    sill_ratio: float
    flags: int
    balcony_ratio: float
    cornice_height: float
    colors: tuple[str, ...]


# Complete copy of the eleven presets as they were before the recipe registry
# (src/city/facades/presets.ts at the baseline commit). Frozen on purpose: the
# unit test asserts parity with the TypeScript copies so a preset edit fails
# loudly instead of silently changing old buildings.
LEGACY_PRESETS: dict[str, FacadePreset] = {
    "stalin": FacadePreset(
        3.7, 4.8, 3.7, 0.46, 0.64, 0.16,
        FLAG_MONUMENT | FLAG_PILASTERS | FLAG_CORNICE | FLAG_SHOPFRONT, 0.0, 1.15,
        ("#c39a63", "#cba66f", "#b98f58", "#d0b078", "#c7a166", "#bd955f"),
    ),
    "khrushchev": FacadePreset(
        2.8, 2.9, 3.2, 0.44, 0.52, 0.22,
        FLAG_BALCONIES | FLAG_CORNICE, 0.55, 0.35,
        ("#b7bda4", "#c1c7af", "#adb39a", "#a86a52", "#b07a5e", "#b4b9a0"),
    ),
    "panel": FacadePreset(
        2.8, 3.0, 3.4, 0.58, 0.50, 0.24,
        FLAG_BALCONIES | FLAG_CORNICE, 0.8, 0.30,
        ("#b2bcbf", "#a6b1b5", "#bfc5c5", "#aab5b9", "#9fabb0", "#b8c0c1"),
    ),
    "modern": FacadePreset(
        3.2, 4.4, 4.0, 0.70, 0.62, 0.14,
        FLAG_RIBBON | FLAG_SHOPFRONT | FLAG_CORNICE, 0.15, 0.25,
        ("#a7c3c5", "#93b6ba", "#b7cfcd", "#8fb0b3", "#9dbdc0"),
    ),
    "office": FacadePreset(
        3.6, 4.6, 4.2, 0.72, 0.52, 0.20,
        FLAG_RIBBON | FLAG_SHOPFRONT | FLAG_CORNICE, 0.0, 0.30,
        ("#a9b1b3", "#9ba5a9", "#b7bdbb", "#909ba0", "#b3b8b4"),
    ),
    "historic": FacadePreset(
        3.4, 3.5, 3.0, 0.38, 0.56, 0.24,
        FLAG_CORNICE | FLAG_ATTIC, 0.10, 0.60,
        ("#b98a63", "#c49a76", "#b07a62", "#c9a181", "#b98b76", "#a97a58"),
    ),
    "industrial": FacadePreset(
        6.0, 6.0, 7.5, 0.62, 0.32, 0.52,
        FLAG_RIBBON, 0.0, 0.0,
        ("#9a9b8e", "#8f9186", "#a4a496", "#95968a"),
    ),
    "small": FacadePreset(
        2.8, 2.8, 3.2, 0.32, 0.46, 0.28,
        0, 0.0, 0.18,
        ("#b0a694", "#a89d8a", "#b8ae9c", "#a1968a"),
    ),
    "civic": FacadePreset(
        4.4, 5.2, 3.6, 0.40, 0.68, 0.15,
        FLAG_MONUMENT | FLAG_PILASTERS | FLAG_CORNICE, 0.0, 1.0,
        ("#cbc2ad", "#d2ccbb", "#bdb7a6", "#c6beac"),
    ),
    "palace": FacadePreset(
        5.0, 7.0, 7.0, 0.55, 0.66, 0.22,
        FLAG_MONUMENT | FLAG_PILASTERS | FLAG_CORNICE | FLAG_SHOPFRONT | FLAG_ATTIC, 0.0, 1.4,
        ("#c9b490", "#d2c09e", "#c0aa86", "#ccb996", "#c6b18d", "#c3ae8a"),
    ),
    "stadium": FacadePreset(
        6.0, 6.0, 8.0, 0.90, 0.20, 0.60,
        FLAG_BLANK | FLAG_RIBBON, 0.0, 0.60,
        ("#9a9e9e", "#8f9393", "#a4a7a6", "#969a99"),
    ),
}


def load_catalog(path: Path | None = None) -> tuple[StyleRecipe, ...]:
    """Load and validate the canonical family catalog."""
    document = json.loads((path or CATALOG_PATH).read_text(encoding="utf-8"))
    if not isinstance(document, list) or len(document) != FAMILY_RECIPE_COUNT:
        raise ValueError(f"catalog must contain {FAMILY_RECIPE_COUNT} recipes")
    recipes: list[StyleRecipe] = []
    for row in document:
        recipes.append(
            StyleRecipe(
                id=int(row["id"]),
                name=str(row["name"]),
                archetype=str(row["archetype"]),
                profile=str(row["profile"]),
                facade=str(row["facade"]),
                roof=str(row["roof"]),
                details=tuple(row["details"]),
                palette=tuple(row["palette"]),
            )
        )
    validate_catalog(recipes)
    return tuple(recipes)


def validate_catalog(recipes: tuple[StyleRecipe, ...]) -> None:
    """Fail closed on a structurally broken catalog (mirrors the TS validator)."""
    errors: list[str] = []
    ids = [recipe.id for recipe in recipes]
    if ids != list(range(FAMILY_RECIPE_COUNT)):
        errors.append(f"ids must be 0..{FAMILY_RECIPE_COUNT - 1} in order, found {ids}")
    names = [recipe.name for recipe in recipes]
    if len(set(names)) != len(names):
        errors.append("recipe names must be unique")
    for recipe in recipes:
        label = f"recipe {recipe.id} ({recipe.name})"
        if not recipe.name or not recipe.name.replace("_", "").isalnum():
            errors.append(f"{label}: invalid name")
        if recipe.archetype not in ARCHETYPE_BY_ID:
            errors.append(f"{label}: unsupported archetype {recipe.archetype!r}")
        if recipe.profile not in STYLE_PROFILES:
            errors.append(f"{label}: unsupported profile {recipe.profile!r}")
        if recipe.facade not in FACADE_MOTIFS:
            errors.append(f"{label}: unsupported facade {recipe.facade!r}")
        if recipe.roof not in RECIPE_ROOFS:
            errors.append(f"{label}: unsupported roof {recipe.roof!r}")
        if not recipe.details:
            errors.append(f"{label}: details must not be empty")
        for detail in recipe.details:
            if detail not in DETAIL_KINDS:
                errors.append(f"{label}: unsupported detail {detail!r}")
        if len(recipe.palette) != 3:
            errors.append(f"{label}: palette must contain exactly 3 colours")
        for colour in recipe.palette:
            if len(colour) != 7 or not colour.startswith("#"):
                errors.append(f"{label}: palette colour {colour!r} is not six-digit sRGB")
            else:
                try:
                    int(colour[1:], 16)
                except ValueError:
                    errors.append(f"{label}: palette colour {colour!r} is not hexadecimal")
    if errors:
        raise ValueError("invalid style recipe catalog:\n" + "\n".join(errors))


FAMILY_RECIPES: tuple[StyleRecipe, ...] = load_catalog()
FAMILY_BY_ID: dict[int, StyleRecipe] = {recipe.id: recipe for recipe in FAMILY_RECIPES}


def legacy_style_id(archetype: str) -> int:
    """Runtime recipe id of the legacy preset for an archetype (27..37)."""
    index = ARCHETYPE_ID.get(archetype)
    if index is None:
        index = ARCHETYPE_ID["small"]
    return LEGACY_RECIPE_OFFSET + index


def legacy_recipe_for(archetype: str) -> StyleRecipe:
    """Legacy preset recipe row for an archetype."""
    safe = archetype if archetype in ARCHETYPE_ID else "small"
    preset = LEGACY_PRESETS[safe]
    return StyleRecipe(
        id=legacy_style_id(safe),
        name=f"legacy_default_{safe}",
        archetype=safe,
        profile="base",
        facade="legacy",
        roof="source",
        details=(),
        palette=preset.colors,
    )


def legacy_archetype_for_recipe_id(recipe_id: int) -> str | None:
    """Resolve a legacy recipe id (27..37) back to its archetype."""
    index = recipe_id - LEGACY_RECIPE_OFFSET
    if 0 <= index < len(ARCHETYPE_BY_ID):
        return ARCHETYPE_BY_ID[index]
    return None


def family_recipe_by_id(recipe_id: int | None) -> StyleRecipe | None:
    """Family recipe for an exact id, or None outside 0..26."""
    if recipe_id is None:
        return None
    return FAMILY_BY_ID.get(int(recipe_id))


def get_style_recipe(recipe_id: int | None, archetype: str | None = None) -> StyleRecipe:
    """Strict runtime-safe lookup mirroring `getStyleRecipe` in TypeScript.

    Unknown, negative or out-of-range ids fall back to the legacy preset for the
    source archetype. When ``archetype`` is given (the renderer always passes the
    source feature's archetype) a family whose broad archetype disagrees also
    falls back, so protected routes and mismatches never borrow a family;
    omitting it is a pure registry lookup used for cross-language parity.
    """
    fallback = legacy_recipe_for(archetype or "panel")
    if recipe_id is None:
        return fallback
    try:
        value = int(recipe_id)
    except (TypeError, ValueError):
        return fallback
    if value < 0 or value >= FACADE_PRESET_COUNT:
        return fallback
    if value >= LEGACY_RECIPE_OFFSET:
        legacy_archetype = legacy_archetype_for_recipe_id(value)
        return legacy_recipe_for(legacy_archetype) if legacy_archetype else fallback
    recipe = FAMILY_BY_ID.get(value)
    if recipe is None:
        return fallback
    if archetype is not None and recipe.archetype != archetype:
        return fallback
    return recipe


def pack_style_bits(flags: int, recipe_id: int) -> int:
    """Pack style flags and a recipe id into the float32-exact `aFace.y` integer."""
    if not 0 <= int(recipe_id) <= 255:
        raise ValueError("recipeId must be an integer 0..255")
    return ((int(recipe_id) << 8) | (int(flags) & 0xFF)) & 0xFFFFFFFF


def unpack_style_bits(value: int) -> tuple[int, int]:
    """Unpack `aFace.y` into (flags, recipeId)."""
    packed = int(value) & 0xFFFFFFFF
    return packed & 0xFF, (packed >> 8) & 0xFF


__all__ = [
    "ARCHETYPE_BY_ID",
    "ARCHETYPE_ID",
    "CATALOG_PATH",
    "DETAIL_KINDS",
    "FACADE_MOTIFS",
    "FACADE_PRESET_COUNT",
    "FAMILY_RECIPES",
    "FAMILY_RECIPE_COUNT",
    "FacadePreset",
    "LEGACY_PRESETS",
    "LEGACY_RECIPE_COUNT",
    "LEGACY_RECIPE_OFFSET",
    "RECIPE_ROOFS",
    "STYLE_PROFILES",
    "StyleRecipe",
    "family_recipe_by_id",
    "get_style_recipe",
    "legacy_archetype_for_recipe_id",
    "legacy_recipe_for",
    "legacy_style_id",
    "load_catalog",
    "pack_style_bits",
    "unpack_style_bits",
    "validate_catalog",
]
