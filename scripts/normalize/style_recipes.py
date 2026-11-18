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
The selector is source-local and hash-based: one building can never influence
another building's recipe, and the same feature id always resolves to the same
family wherever it is processed (see ``docs/building-quality/style-selection-rules.md``).
"""

from __future__ import annotations

import hashlib
import json
import math
from dataclasses import dataclass
from functools import cached_property
from pathlib import Path
from typing import TYPE_CHECKING, Literal, Mapping

if TYPE_CHECKING:  # pragma: no cover - typing only, shapely is a caller concern
    from shapely.geometry import Polygon

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


# ---------------------------------------------------------------------------
# Task 2: deterministic, source-local style selection
# ---------------------------------------------------------------------------
#
# The selector is deliberately evidence-first: it reads only mapped tags, the
# source footprint, the source height/levels and the existence of explicit
# building:part volumes. It never mutates the input, never reads other
# buildings, and never uses process state or random seeds.

STYLE_SCHEMA_VERSION = 1
HASH_SCHEMA_TAG = "style-schema-1"

PROTECTED_ARCHETYPES: tuple[str, ...] = ("palace", "stadium")
GENERIC_ARCHETYPES: tuple[str, ...] = tuple(
    name for name in ARCHETYPE_BY_ID if name not in PROTECTED_ARCHETYPES
)

# Broad base family per archetype. Every broad candidate set contains it, so a
# building never falls through unstyled; the only exceptions are explicit tag
# declarations that authoritatively constrain the family (documented below).
BASE_RECIPE_ID: dict[str, int] = {
    "stalin": 0,
    "khrushchev": 4,
    "panel": 6,
    "modern": 11,
    "office": 12,
    "historic": 15,
    "industrial": 19,
    "small": 21,
    "civic": 24,
}

# Guaranteed roof-safe family used when tag/roof filtering leaves no candidate.
# It always has ``roof == 'source'`` so a declared source roof can never be
# rewritten by a style-only fallback.
SAFE_FALLBACK_RECIPE_ID: dict[str, int] = {
    "stalin": 0,
    "khrushchev": 4,
    "panel": 6,
    "modern": 11,
    "office": 12,
    "historic": 15,
    "industrial": 20,
    "small": 22,
    "civic": 24,
}

# Declared ``roof:shape`` alias table of the selector. It is intentionally
# narrower than the renderer's ROOF_SHAPE_MAP: selection cares about the roof
# family a recipe would *force*, so a gambrel reads as mansard here.
_ROOF_SHAPE_ALIASES: dict[str, str] = {
    "flat": "flat",
    "gabled": "gabled",
    "gable": "gabled",
    "saltbox": "gabled",
    "hipped": "hipped",
    "half-hipped": "hipped",
    "half_hipped": "hipped",
    "mansard": "mansard",
    "gambrel": "mansard",
    "pyramidal": "pyramidal",
    "pyramid": "pyramidal",
    "cone": "pyramidal",
    "skillion": "skillion",
    "shed": "skillion",
    "lean_to": "skillion",
    "dome": "dome",
    "onion": "dome",
    "round": "dome",
    "complex": "complex",
}

_DETACHED_BUILDING_TOKENS = frozenset(
    {"house", "villa", "detached", "bungalow", "cabin", "cottage", "farm"}
)
_SERVICE_BUILDING_TOKENS = frozenset(
    {
        "garage",
        "garages",
        "carport",
        "shed",
        "hut",
        "kiosk",
        "service",
        "utility",
        "warehouse",
        "storage",
        "workshop",
        "transformer_tower",
    }
)
_SERVICE_AMENITY_TOKENS = frozenset(
    {"parking", "fuel", "car_wash", "charging_station", "bicycle_parking"}
)
_SERVICE_MANMADE_TOKENS = frozenset({"storage_tank", "silo", "water_tower", "chimney"})
_COMMERCIAL_AMENITY_TOKENS = frozenset(
    {
        "restaurant",
        "bank",
        "cafe",
        "fast_food",
        "bar",
        "pub",
        "marketplace",
        "pharmacy",
        "cinema",
    }
)
_CIVIC_BUILDING_TOKENS = frozenset(
    {
        "public",
        "civic",
        "government",
        "hospital",
        "school",
        "university",
        "college",
        "museum",
        "theatre",
        "train_station",
    }
)
_CIVIC_AMENITY_TOKENS = frozenset(
    {
        "school",
        "hospital",
        "university",
        "college",
        "townhall",
        "courthouse",
        "library",
        "museum",
        "theatre",
        "arts_centre",
        "community_centre",
        "kindergarten",
        "clinic",
        "place_of_worship",
    }
)

# A weak ``building=yes`` footprint counts as a detached house only when it is
# genuinely domestic-sized or already declares a hip roof.
_WEAK_DETACHED_AREA_M2 = 200.0

# An explicit declaration narrows the family to the only catalog row that
# expresses it. The fallback is used when that row is structurally ineligible
# (for example an oversized historic footprint cannot carry a mansard); it must
# itself have ``roof == 'source'``.
_DECLARED_SHAPE_PREFERENCE: dict[tuple[str, str | None], int] = {
    ("historic", "gabled"): 16,
    ("historic", "mansard"): 17,
    ("historic", "hipped"): 15,
    ("historic", "pyramidal"): 15,
    ("historic", "skillion"): 15,
    ("historic", "flat"): 15,
    ("historic", "dome"): 15,
    ("historic", "complex"): 15,
    ("small", "gabled"): 23,
    ("small", "hipped"): 21,
    ("small", "pyramidal"): 21,
    ("small", "flat"): 22,
    ("small", "mansard"): 22,
    ("small", "skillion"): 22,
    ("small", "dome"): 22,
    ("small", "complex"): 22,
    ("khrushchev", "hipped"): 5,
    ("khrushchev", "pyramidal"): 5,
}
_DECLARED_SHAPE_FALLBACK: dict[tuple[str, str | None], int] = {
    ("historic", "mansard"): 15,
}

# Recipes whose catalog roof is an envelope the geometry stage constructs. They
# may only be selected when the source footprint does not declare another roof.
_ROOF_FORCING_RECIPES = frozenset({5, 17, 18, 19, 21})


def stable_unit(feature_id: str) -> float:
    """Deterministic 0..1 hash of a feature id for style selection.

    Formula (design §7): ``blake2b("<featureId>|style-schema-1", digest_size=8)``
    divided by ``2**64 - 1``. It is intentionally a different salt from the
    normalizer's height seed, so existing heights never change.
    """
    digest = hashlib.blake2b(
        f"{feature_id}|{HASH_SCHEMA_TAG}".encode("utf-8"), digest_size=8
    ).digest()
    return int.from_bytes(digest, "big") / float(2**64 - 1)


@dataclass(frozen=True)
class StyleInput:
    """Everything the offline selector is allowed to know about one building."""

    id: str
    archetype: str
    tags: Mapping[str, str]
    polygon: "Polygon"
    height: float
    levels: int | None
    has_parts: bool


@dataclass(frozen=True)
class StyleSelection:
    """A stable family choice plus its audit provenance."""

    recipe_id: int
    source: Literal["osm_hint", "heuristic"]
    eligibility: tuple[str, ...]


def base_recipe_id(archetype: str) -> int:
    """Broad base family of an archetype (always present in broad candidates)."""
    try:
        return BASE_RECIPE_ID[archetype]
    except KeyError as error:
        raise ValueError(f"no base style recipe for archetype {archetype!r}") from error


def _split_tokens(value: str | None) -> frozenset[str]:
    if not value:
        return frozenset()
    return frozenset(
        part.strip().lower() for part in value.replace(",", ";").split(";") if part.strip()
    )


def _footprint_metrics(polygon: "Polygon") -> tuple[float, float, float]:
    """(long side, short side, area) of the minimum rotated rectangle."""
    try:
        rect = polygon.minimum_rotated_rectangle
    except Exception:
        rect = None
    if rect is not None and not getattr(rect, "is_empty", True):
        try:
            coords = list(rect.exterior.coords)
            if len(coords) >= 5 and coords[0] == coords[-1]:
                coords = coords[:-1]
            if len(coords) == 4:
                sides = [
                    math.dist(coords[index], coords[(index + 1) % 4]) for index in range(4)
                ]
                return (max(sides), min(sides), float(rect.area))
        except Exception:
            pass
    minx, miny, maxx, maxy = polygon.bounds
    long_side = float(max(maxx - minx, maxy - miny))
    short_side = float(min(maxx - minx, maxy - miny))
    return (long_side, short_side, long_side * short_side)


class _Evidence:
    """Validated, lazily measured facts about one ``StyleInput``."""

    def __init__(self, source: StyleInput) -> None:
        if not isinstance(source, StyleInput):
            raise ValueError("select_style expects a StyleInput instance")
        archetype = str(getattr(source, "archetype", "") or "")
        if archetype not in ARCHETYPE_ID:
            raise ValueError(f"unsupported building archetype {archetype!r}")
        feature_id = getattr(source, "id", "")
        if not isinstance(feature_id, str) or not feature_id.strip():
            raise ValueError("StyleInput.id must be a non-empty string")
        polygon = getattr(source, "polygon", None)
        if polygon is None or bool(getattr(polygon, "is_empty", True)):
            raise ValueError(f"StyleInput {feature_id!r} has an empty footprint")
        try:
            area = float(polygon.area)
        except (TypeError, ValueError) as error:
            raise ValueError(f"StyleInput {feature_id!r} has an invalid footprint") from error
        if not math.isfinite(area) or area <= 0.0:
            raise ValueError(f"StyleInput {feature_id!r} has a degenerate footprint")
        try:
            height = float(source.height)
        except (TypeError, ValueError) as error:
            raise ValueError(f"StyleInput {feature_id!r} has an invalid height") from error
        if not math.isfinite(height) or height <= 0.0:
            raise ValueError(f"StyleInput {feature_id!r} has an invalid height")
        levels = source.levels
        if levels is not None and (not isinstance(levels, int) or levels < 1):
            raise ValueError(f"StyleInput {feature_id!r} has invalid levels")

        self.source = source
        self.feature_id = feature_id
        self.archetype = archetype
        self.polygon = polygon
        self.height = height
        self.levels = levels
        # A private copy: selection must never mutate the caller's tags.
        self.tags: dict[str, str] = {
            str(key).strip().lower(): str(value)
            for key, value in dict(source.tags or {}).items()
        }
        self.has_parts = bool(source.has_parts)

    # -- tag helpers -------------------------------------------------------
    def tokens(self, key: str) -> frozenset[str]:
        return _split_tokens(self.tags.get(key))

    @cached_property
    def material_tokens(self) -> frozenset[str]:
        return self.tokens("building:material")

    @cached_property
    def roof_shape(self) -> str | None:
        """Declared roof family; an unknown declaration is treated as complex."""
        raw = self.tags.get("roof:shape")
        if not raw:
            return None
        return _ROOF_SHAPE_ALIASES.get(raw.strip().lower().replace(" ", "_"), "complex")

    @cached_property
    def service_evidence(self) -> bool:
        return bool(
            self.tokens("building") & _SERVICE_BUILDING_TOKENS
            or self.tokens("amenity") & _SERVICE_AMENITY_TOKENS
            or self.tokens("man_made") & _SERVICE_MANMADE_TOKENS
        )

    @cached_property
    def detached_evidence(self) -> bool:
        building = self.tokens("building")
        if building & _DETACHED_BUILDING_TOKENS:
            return True
        if building and "yes" not in building:
            return False
        return self.roof_shape in {"hipped", "pyramidal"} or self.area <= _WEAK_DETACHED_AREA_M2

    @cached_property
    def commercial_evidence(self) -> bool:
        return bool(
            self.tokens("shop")
            or self.tokens("amenity") & _COMMERCIAL_AMENITY_TOKENS
            or "commercial" in self.tokens("building")
        )

    @cached_property
    def civic_evidence(self) -> bool:
        return bool(
            self.tokens("building") & _CIVIC_BUILDING_TOKENS
            or self.tokens("amenity") & _CIVIC_AMENITY_TOKENS
        )

    # -- geometry facts ----------------------------------------------------
    @cached_property
    def area(self) -> float:
        return float(self.polygon.area)

    @cached_property
    def footprint(self) -> tuple[float, float, float]:
        return _footprint_metrics(self.polygon)

    @cached_property
    def long_side(self) -> float:
        return self.footprint[0]

    @cached_property
    def short_side(self) -> float:
        return self.footprint[1]

    @cached_property
    def rect_fill(self) -> float:
        rect_area = self.footprint[2]
        return self.area / rect_area if rect_area > 0.0 else 0.0

    @cached_property
    def elongation(self) -> float:
        return self.long_side / self.short_side if self.short_side > 0.0 else 0.0

    @cached_property
    def hole_count(self) -> int:
        interiors = getattr(self.polygon, "interiors", None)
        if interiors is not None:
            return len(interiors)
        count = 0
        for geom in getattr(self.polygon, "geoms", ()):
            count += len(getattr(geom, "interiors", ()))
        return count

    @cached_property
    def has_courtyard(self) -> bool:
        return self.hole_count > 0


# -- structural eligibility (design §5) -------------------------------------


def sawtooth_bay_count(long_side: float) -> int:
    """3..6 sawtooth roof bays, derived from the oriented long side."""
    return max(3, min(6, int(round(long_side / 7.0))))


def _linear_profile_supported(evidence: _Evidence) -> bool:
    """Simple elongated massing that the end-pavilion profile can split."""
    return (
        not evidence.has_parts
        and not evidence.has_courtyard
        and evidence.rect_fill >= 0.8
        and evidence.long_side >= 20.0
        and evidence.elongation >= 1.5
    )


def _stepped_profile_supported(evidence: _Evidence) -> bool:
    """Single-volume long block tall enough for a bounded stepped crown."""
    return (
        not evidence.has_parts
        and not evidence.has_courtyard
        and evidence.rect_fill >= 0.7
        and evidence.long_side >= 24.0
        and evidence.height >= 18.0
    )


def _podium_tower_supported(evidence: _Evidence) -> bool:
    """Never invent a tower: explicit multi-volume evidence is required."""
    return evidence.has_parts and evidence.height >= 12.0


def _low_attic_supported(evidence: _Evidence) -> bool:
    return (
        not evidence.has_parts
        and not evidence.has_courtyard
        and evidence.area <= 1200.0
        and evidence.height <= 16.0
        and evidence.short_side >= 6.0
    )


def _mansard_supported(evidence: _Evidence) -> bool:
    if evidence.has_parts or evidence.has_courtyard:
        return False
    if evidence.height > 14.0 or evidence.area > 900.0 or evidence.short_side < 5.0:
        return False
    return evidence.roof_shape in (None, "mansard")


def _sawtooth_supported(evidence: _Evidence) -> bool:
    return (
        not evidence.has_parts
        and not evidence.has_courtyard
        and evidence.height >= 6.0
        and evidence.long_side >= 15.0
        and evidence.short_side >= 6.0
        and evidence.rect_fill >= 0.6
    )


def _colonnade_supported(evidence: _Evidence) -> bool:
    return (
        not evidence.has_courtyard
        and evidence.rect_fill >= 0.7
        and evidence.area >= 600.0
        and evidence.long_side >= 20.0
        and evidence.height >= 10.0
    )


def _assembly_hall_supported(evidence: _Evidence) -> bool:
    return (
        evidence.area >= 800.0
        and evidence.long_side >= 25.0
        and evidence.short_side >= 12.0
        and evidence.height >= 10.0
    )


# -- candidate tables -------------------------------------------------------
#
# Weights are integers in arbitrary units; the exposed probabilities are
# ``weight / sum(weights)``, so every returned candidate set adds up to 1.0.

def _candidates_stalin(evidence: _Evidence) -> list[tuple[int, int]]:
    items = [(0, 50)]
    if _linear_profile_supported(evidence):
        items.append((1, 25))
    items.append((2, 25))
    return items


def _candidates_khrushchev(evidence: _Evidence) -> list[tuple[int, int]]:
    if "brick" in evidence.material_tokens:
        # An explicit masonry material decides the family (osm_hint).
        return [(3, 1)]
    items = [(4, 45), (3, 30)]
    if _low_attic_supported(evidence):
        items.append((5, 25))
    return items


def _candidates_panel(evidence: _Evidence) -> list[tuple[int, int]]:
    items = [(6, 50)]
    if evidence.has_parts or evidence.elongation >= 2.2:
        items.append((7, 25))
    if evidence.height >= 18.0:
        items.append((8, 25))
    return items


def _candidates_modern(evidence: _Evidence) -> list[tuple[int, int]]:
    items = [(11, 55)]
    if _podium_tower_supported(evidence):
        items.append((9, 35))
    if _stepped_profile_supported(evidence):
        items.append((10, 25))
    return items


def _candidates_office(evidence: _Evidence) -> list[tuple[int, int]]:
    items = [(12, 50)]
    if evidence.height >= 12.0 and evidence.area >= 300.0:
        items.append((13, 25))
    if evidence.area >= 200.0 and (evidence.commercial_evidence or evidence.height >= 15.0):
        items.append((14, 25))
    return items


def _candidates_historic(evidence: _Evidence) -> list[tuple[int, int]]:
    items = [(15, 45)]
    masonry = evidence.material_tokens & {"brick", "stone"}
    if evidence.roof_shape == "gabled" or masonry or _small_historic_house(evidence):
        items.append((16, 35 if masonry else 30))
    if _mansard_supported(evidence):
        items.append((17, 25))
    return items


def _small_historic_house(evidence: _Evidence) -> bool:
    return (
        not evidence.has_parts
        and evidence.area <= 600.0
        and evidence.height <= 12.0
        and evidence.short_side >= 4.0
    )


def _candidates_industrial(evidence: _Evidence) -> list[tuple[int, int]]:
    items = [(19, 40)]
    if _sawtooth_supported(evidence):
        items.append((18, 35))
    if evidence.area <= 500.0 or evidence.service_evidence:
        items.append((20, 25))
    return items


def _candidates_small(evidence: _Evidence) -> list[tuple[int, int]]:
    declared = evidence.roof_shape
    if evidence.detached_evidence:
        # A tagged detached home must never become a garage/service annex.
        if declared == "gabled":
            return [(23, 1)]
        if declared in {"hipped", "pyramidal"}:
            return [(21, 1)]
        if declared in {"flat", "skillion", "complex", "dome", "mansard"}:
            return [(22, 1)]
        return [(21, 60), (23, 40)]
    if evidence.service_evidence:
        # Garages/utility buildings are 22 or 23 only, never a domestic house.
        if declared == "flat":
            return [(22, 75), (23, 25)]
        if declared == "gabled":
            return [(23, 75), (22, 25)]
        return [(22, 50), (23, 50)]
    return [(21, 45), (22, 30), (23, 25)]


def _candidates_civic(evidence: _Evidence) -> list[tuple[int, int]]:
    items = [(24, 45)]
    if _colonnade_supported(evidence):
        items.append((25, 30))
    if _assembly_hall_supported(evidence):
        items.append((26, 25))
    return items


_CANDIDATE_BUILDERS = {
    "stalin": _candidates_stalin,
    "khrushchev": _candidates_khrushchev,
    "panel": _candidates_panel,
    "modern": _candidates_modern,
    "office": _candidates_office,
    "historic": _candidates_historic,
    "industrial": _candidates_industrial,
    "small": _candidates_small,
    "civic": _candidates_civic,
}


# -- roof and declaration rules ---------------------------------------------


def _roof_compatible(recipe_roof: str, declared: str | None) -> bool:
    """True when a recipe never rewrites a declared source roof."""
    if declared is None or recipe_roof == "source":
        return True
    if recipe_roof == "hip":
        return declared in {"hipped", "pyramidal"}
    if recipe_roof == "mansard":
        return declared == "mansard"
    if recipe_roof in {"sawtooth", "clerestory"}:
        return declared == "flat"
    return True


def _apply_declared_shape_preference(
    evidence: _Evidence, candidates: list[tuple[int, int]]
) -> list[tuple[int, int]]:
    key = (evidence.archetype, evidence.roof_shape)
    preferred = _DECLARED_SHAPE_PREFERENCE.get(key)
    if preferred is not None and any(recipe_id == preferred for recipe_id, _ in candidates):
        return [(preferred, 1)]
    fallback = _DECLARED_SHAPE_FALLBACK.get(key)
    if fallback is not None and any(recipe_id == fallback for recipe_id, _ in candidates):
        return [(fallback, 1)]
    return candidates


def _eligible(evidence: _Evidence) -> list[tuple[StyleRecipe, float]]:
    if evidence.archetype in PROTECTED_ARCHETYPES:
        return []
    builder = _CANDIDATE_BUILDERS[evidence.archetype]
    declared = evidence.roof_shape
    filtered = [
        (recipe_id, weight)
        for recipe_id, weight in builder(evidence)
        if _roof_compatible(FAMILY_BY_ID[recipe_id].roof, declared)
    ]
    filtered = _apply_declared_shape_preference(evidence, filtered)
    if not filtered:
        filtered = [(SAFE_FALLBACK_RECIPE_ID[evidence.archetype], 1)]
    total = float(sum(weight for _, weight in filtered))
    if total <= 0.0:  # pragma: no cover - builders always emit positive weights
        filtered = [(SAFE_FALLBACK_RECIPE_ID[evidence.archetype], 1)]
        total = 1.0
    ordered = sorted(filtered, key=lambda item: item[0])
    return [(FAMILY_BY_ID[recipe_id], weight / total) for recipe_id, weight in ordered]


def _provenance(evidence: _Evidence, selected: StyleRecipe) -> Literal["osm_hint", "heuristic"]:
    """``osm_hint`` when a mapped tag actually constrained the chosen family."""
    if selected.id == 3 and "brick" in evidence.material_tokens:
        return "osm_hint"
    if selected.id == 16 and (
        evidence.roof_shape == "gabled" or evidence.material_tokens & {"brick", "stone"}
    ):
        return "osm_hint"
    if selected.id == 17 and evidence.roof_shape == "mansard":
        return "osm_hint"
    if selected.id == 21 and evidence.roof_shape in {"hipped", "pyramidal"}:
        return "osm_hint"
    if selected.id in {22, 23} and evidence.service_evidence:
        return "osm_hint"
    if selected.id == 23 and evidence.roof_shape == "gabled":
        return "osm_hint"
    return "heuristic"


def _reasons(
    evidence: _Evidence, selected: StyleRecipe, candidate_count: int
) -> tuple[str, ...]:
    reasons = [
        f"archetype:{evidence.archetype}",
        f"recipe:{selected.id}:{selected.name}",
        f"explicit_roof:{evidence.roof_shape or 'none'}",
    ]
    if evidence.has_parts:
        reasons.append("explicit_parts")
    if evidence.has_courtyard:
        reasons.append("courtyard")
    if evidence.material_tokens:
        reasons.append("material:" + "+".join(sorted(evidence.material_tokens)))
    if evidence.service_evidence:
        reasons.append("service_tags")
    if evidence.detached_evidence:
        reasons.append("detached_house_tags")
    if evidence.civic_evidence:
        reasons.append("civic_tags")
    if selected.id == 18:
        reasons.append(f"sawtooth_bays:{sawtooth_bay_count(evidence.long_side)}")
    reasons.append("single_candidate" if candidate_count == 1 else "weighted_hash")
    if selected.id in _ROOF_FORCING_RECIPES:
        reasons.append("roof_embellishment")
    return tuple(reasons)


def eligible_recipes(source: StyleInput) -> list[tuple[StyleRecipe, float]]:
    """Weighted, roof-safe candidate families for one building.

    The returned list is ordered by recipe id, is never empty for a generic
    archetype, contains the archetype base family for broad evidence, and its
    weights are normalised so the cumulative walk covers exactly ``0..1``.
    Palace and stadium are protected routes and return no family at all.
    """
    return _eligible(_Evidence(source))


def selection_provenance(
    source: StyleInput, selected: StyleRecipe
) -> Literal["osm_hint", "heuristic"]:
    """Audit provenance of an already selected family for ``source``."""
    return _provenance(_Evidence(source), selected)


def selection_reasons(source: StyleInput, selected: StyleRecipe) -> tuple[str, ...]:
    """Stable human-readable eligibility reasons for QA reports."""
    evidence = _Evidence(source)
    return _reasons(evidence, selected, len(_eligible(evidence)))


def select_style(source: StyleInput) -> StyleSelection:
    """Deterministic weighted-hash style selection for one building.

    The same feature id with the same evidence always yields the same
    ``StyleSelection``; other buildings and processing order cannot affect it.
    Protected palace/stadium routes resolve to their legacy preset id and are
    then overridden by the caller with ``legacy_default`` provenance.
    """
    evidence = _Evidence(source)
    if evidence.archetype in PROTECTED_ARCHETYPES:
        return StyleSelection(
            legacy_style_id(evidence.archetype),
            "heuristic",
            ("protected_archetype",),
        )
    candidates = _eligible(evidence)
    assert candidates, f"no eligible style recipe for {evidence.feature_id}"
    assert abs(sum(weight for _, weight in candidates) - 1.0) < 1e-12
    selected = candidates[-1][0]  # Only covers floating-point cumulative rounding.
    cumulative = 0.0
    unit = stable_unit(evidence.feature_id)
    for recipe, weight in candidates:
        cumulative += weight
        if unit < cumulative:
            selected = recipe
            break
    return StyleSelection(
        selected.id,
        _provenance(evidence, selected),
        _reasons(evidence, selected, len(candidates)),
    )


__all__ = [
    "ARCHETYPE_BY_ID",
    "ARCHETYPE_ID",
    "BASE_RECIPE_ID",
    "CATALOG_PATH",
    "DETAIL_KINDS",
    "FACADE_MOTIFS",
    "FACADE_PRESET_COUNT",
    "FAMILY_RECIPES",
    "FAMILY_RECIPE_COUNT",
    "FacadePreset",
    "GENERIC_ARCHETYPES",
    "HASH_SCHEMA_TAG",
    "LEGACY_PRESETS",
    "LEGACY_RECIPE_COUNT",
    "LEGACY_RECIPE_OFFSET",
    "PROTECTED_ARCHETYPES",
    "RECIPE_ROOFS",
    "SAFE_FALLBACK_RECIPE_ID",
    "STYLE_PROFILES",
    "STYLE_SCHEMA_VERSION",
    "StyleInput",
    "StyleRecipe",
    "StyleSelection",
    "base_recipe_id",
    "eligible_recipes",
    "family_recipe_by_id",
    "get_style_recipe",
    "legacy_archetype_for_recipe_id",
    "legacy_recipe_for",
    "legacy_style_id",
    "load_catalog",
    "pack_style_bits",
    "sawtooth_bay_count",
    "select_style",
    "selection_provenance",
    "selection_reasons",
    "stable_unit",
    "unpack_style_bits",
    "validate_catalog",
]
