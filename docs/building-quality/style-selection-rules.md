# Procedural style selection rules (payload schema 1)

Offline selector: `scripts/normalize/style_recipes.py` (`StyleInput`, `eligible_recipes`,
`select_style`, `stable_unit`). Integration: `scripts/normalize/normalize.py`
(`protected_route`, `selection`, `feature["styleVariant"]`, manifest style block).
Contract tests: `scripts/normalize/tests/test_style_recipes.py`.

This document records every rule the selector applies. It is **not** a claim of
surveyed construction era or material: a recipe is a visual family, and every
choice is either `osm_hint` (a mapped tag actually constrained the family) or
`heuristic`.

---

## 1. Contract

### Input (`StyleInput`)

| field | meaning |
| --- | --- |
| `id` | stable feature id (`w<osm id>` / `r<osm id>`) |
| `archetype` | the 11 broad archetypes from `ARCHETYPE_BY_ID` |
| `tags` | filtered/normalised OSM tags (`amenity`, `building`, `building:material`, `building:levels`, `start_date`, `roof:*`, `shop`, `man_made`, …) |
| `polygon` | source footprint (Shapely `Polygon`, holes = courtyards) |
| `height` | source total height in metres (never mutated) |
| `levels` | `building:levels` when tagged, else `None` |
| `has_parts` | `True` when explicit `building:part` volumes exist |

Validation is fail-closed: an unknown archetype, empty id, empty/degenerate
footprint, non-finite or non-positive height, or invalid levels raises
`ValueError` instead of selecting a guess. The selector:

* never mutates `tags`, `height`, `levels`, the polygon or any source field;
* reads no rendered colour, no other building, no tile order, no process state,
  no clock and no random seed;
* never returns a recipe whose archetype differs from the source archetype (the
  runtime `getStyleRecipe(id, archetype)` would reject it);
* never returns a roof envelope that contradicts a declared `roof:shape`.

### Output (`StyleSelection`)

| field | meaning |
| --- | --- |
| `recipe_id` | family id `0..26`; legacy ids `27..37` only for protected routes |
| `source` | `"osm_hint"` or `"heuristic"` |
| `eligibility` | audit-only reason tokens (see §9) |

Emitted payload (per building):

```json
"styleVariant": {
  "schema": 1,
  "recipeId": 16,
  "source": "osm_hint",
  "eligibility": ["archetype:historic", "recipe:16:brick_gabled_house", "explicit_roof:gabled", "single_candidate", "roof_embellishment"]
}
```

`eligibility` strings are informational; they must never be interpreted as
measured construction facts.

---

## 2. Stable hash

```
stable_unit(featureId) = blake2b("<featureId>|style-schema-1", digest_size=8) / (2**64 - 1)
```

* Salt: exactly `|style-schema-1` (`HASH_SCHEMA_TAG`). Changing the rules requires
  a reviewed migration and a new salt.
* Domain: `0.0 .. 1.0` inclusive, computed with big-endian unsigned 64-bit.
* This is a **different hash** from the normalizer's height seed
  (`normalize.stable_unit`, salted per feature, used only by
  `heuristic_height_variation`). Existing heights are unchanged.
* The same feature id always yields the same unit no matter which tile, order or
  run processes it.

### Weighted selection

`eligible_recipes()` returns candidates sorted by recipe id and normalised so
that the weights sum to `1.0` (within `1e-12`, floating-point). Selection walks
the cumulative distribution:

```python
cumulative = 0.0
unit = stable_unit(source.id)
for recipe, weight in candidates:      # ascending recipe id
    cumulative += weight
    if unit < cumulative:
        return recipe
return candidates[-1][0]               # only covers float rounding at 1.0
```

Consequences: a candidate set of one always selects it; adding/removing an
unrelated building can never change the result.

---

## 3. Candidate weights

Weights below are integer units. The exposed probability of a candidate is
`weight / sum(candidates)`; only eligible candidates contribute. Each archetype
has a **broad base recipe** that is always included for broad (untagged) evidence.
`P` is the probability.

### stalin

| id | name | weight | condition | P |
| --- | --- | --- | --- | --- |
| 0 | `ensemble_symmetric` | 50 | always (base) | 50/S |
| 1 | `end_pavilion` | 25 | linear profile supported (§4) | 25/S |
| 2 | `restrained_monument` | 25 | always | 25/S |

### khrushchev

| id | name | weight | condition |
| --- | --- | --- | --- |
| 4 | `balcony_slab` | 45 | always (base) |
| 3 | `brick_punched` | 30 | always (without material tag) |
| 3 | `brick_punched` | **sole** | `building:material` contains `brick` → narrowed to `{3}`, `osm_hint` |
| 5 | `pitched_low_block` | 25 | low attic supported (§4) |

### panel

| id | name | weight | condition |
| --- | --- | --- | --- |
| 6 | `recessed_loggia` | 50 | always (base) |
| 7 | `endwall_tower` | 25 | `has_parts` **or** elongation ≥ 2.2 |
| 8 | `staircore_spine` | 25 | height ≥ 18 m |

### modern

| id | name | weight | condition |
| --- | --- | --- | --- |
| 11 | `framed_residential` | 55 | always (base) |
| 9 | `podium_tower` | 35 | `has_parts` **and** height ≥ 12 m — a tower is never invented |
| 10 | `stepped_residential` | 25 | stepped profile supported (§4) |

### office

| id | name | weight | condition |
| --- | --- | --- | --- |
| 12 | `curtain_ribbon` | 50 | always (base) |
| 13 | `framed_stone_grid` | 25 | height ≥ 12 m **and** area ≥ 300 m² |
| 14 | `commercial_podium` | 25 | area ≥ 200 m² **and** (commercial tag evidence or height ≥ 15 m) |

### historic

| id | name | weight | condition |
| --- | --- | --- | --- |
| 15 | `plaster_street_house` | 45 | always (base) |
| 16 | `brick_gabled_house` | 30 / 35 | declared `roof:shape` = gabled **or** masonry material (35) **or** small historic house (§4) |
| 17 | `mansard_attic` | 25 | mansard supported (§4) |

### industrial

| id | name | weight | condition |
| --- | --- | --- | --- |
| 19 | `broad_clerestory_hall` | 40 | always (base) |
| 18 | `sawtooth_factory` | 35 | sawtooth supported (§4) |
| 20 | `service_workshop` | 25 | area ≤ 500 m² **or** service/utility tag evidence |

### small

Three mutually exclusive categories, evaluated in this order:

1. **detached house** (strong `building` = one of `house`, `villa`, `detached`,
   `bungalow`, `cabin`, `cottage`, `farm`; or weak `building` absent/`yes` with
   declared `roof:shape=hipped`/`pyramidal` or area ≤ 200 m²). A tagged detached
   home is **never** converted to a garage.

   | declared roof | candidates |
   | --- | --- |
   | `gabled` | `{23 gabled_workshop}` |
   | `hipped` / `pyramidal` | `{21 hipped_house}` |
   | `flat` / `skillion` / `mansard` / `dome` / `complex` | `{22 flat_service_annex}` (roof stays source) |
   | none | `{21: 60, 23: 40}` |

2. **service / garage / utility** (`building` = one of `garage`, `garages`,
   `carport`, `shed`, `hut`, `kiosk`, `service`, `utility`, `warehouse`,
   `storage`, `workshop`, `transformer_tower`; or `amenity` = `parking`, `fuel`,
   `car_wash`, `charging_station`, `bicycle_parking`; or `man_made` =
   `storage_tank`, `silo`, `water_tower`, `chimney`). **Never** `21`, only:

   | declared roof | candidates |
   | --- | --- |
   | `flat` | `{22: 75, 23: 25}` |
   | `gabled` | `{23: 75, 22: 25}` |
   | other / none | `{22: 50, 23: 50}` |

3. **default small building**: `{21: 45, 22: 30, 23: 25}`.

### civic

| id | name | weight | condition |
| --- | --- | --- | --- |
| 24 | `school_hospital_wings` | 45 | always (base) |
| 25 | `public_colonnade` | 30 | colonnade supported (§4) |
| 26 | `assembly_hall` | 25 | assembly hall supported (§4) |

### Protected archetypes

`palace` (legacy id 36) and `stadium` (legacy id 37) return **no family
candidates** (`eligible_recipes() == []`) and `select_style()` returns their
legacy preset id with `eligibility == ("protected_archetype",)`. The normalizer
then overrides the payload to `source: "legacy_default"` (see §8).

---

## 4. Structural thresholds

All footprints use `polygon.minimum_rotated_rectangle`; `long_side`/`short_side`
are its longest/shortest edge and `rect_fill = footprint_area / rectangle_area`.
A courtyard/hole excludes the profile and roof envelopes that cannot represent
it. Heights are source total heights.

| predicate | exact rule |
| --- | --- |
| **linear profile** (`end_pavilion`) | no `has_parts`, no courtyard, `rect_fill ≥ 0.80`, `long_side ≥ 20 m`, `elongation ≥ 1.5` |
| **stepped profile** (`stepped_residential`) | no `has_parts`, no courtyard, `rect_fill ≥ 0.70`, `long_side ≥ 24 m`, `height ≥ 18 m` |
| **podium tower** | `has_parts` **and** `height ≥ 12 m` |
| **low attic** (`pitched_low_block`) | no `has_parts`, no courtyard, `area ≤ 1200 m²`, `height ≤ 16 m`, `short_side ≥ 6 m` |
| **mansard** (`mansard_attic`) | no `has_parts` (no elevated part evidence accepted), no courtyard, `height ≤ 14 m`, `area ≤ 900 m²`, `short_side ≥ 5 m`, declared roof absent or `mansard` |
| **sawtooth** (`sawtooth_factory`) | no `has_parts`, no courtyard, `height ≥ 6 m`, `long_side ≥ 15 m`, `short_side ≥ 6 m`, `rect_fill ≥ 0.60`; roof bays = `clamp(round(long_side / 7), 3, 6)` |
| **colonnade** | no courtyard, `rect_fill ≥ 0.70`, `area ≥ 600 m²`, `long_side ≥ 20 m`, `height ≥ 10 m` |
| **assembly hall** | `area ≥ 800 m²`, `long_side ≥ 25 m`, `short_side ≥ 12 m`, `height ≥ 10 m` |
| **small historic house** | no `has_parts`, `area ≤ 600 m²`, `height ≤ 12 m`, `short_side ≥ 4 m` |

`has_parts` means explicit `building:part` volumes exist. Explicit part topology
always dominates: profiles are never invented over an explicit multi-volume
massing, and the mansard/stepped/linear families are not offered for it.

### Minimum-area-rectangle details

* The long side is the orientation reference for `sawtooth_factory`; bay count is
  derived from it (Task 5 clamps to `3..6` again when building the roof).
* A footprint that does not fill its minimum rectangle (`rect_fill` below the
  per-family threshold) is not treated as a clean hall/block and loses the
  profile/roof family, keeping the facade-only base.

---

## 5. Declared `roof:shape` is authoritative

The selector normalises the tag through its own alias table:

| tag value(s) | family |
| --- | --- |
| `flat` | flat |
| `gabled`, `gable`, `saltbox` | gabled |
| `hipped`, `half-hipped`, `half_hipped` | hipped |
| `mansard`, `gambrel` | mansard (gambrel is a mansard-style envelope) |
| `pyramidal`, `pyramid`, `cone` | pyramidal |
| `skillion`, `shed`, `lean_to` | skillion |
| `dome`, `onion`, `round` | dome |
| `complex` | complex |
| any other non-empty value | **complex** (fail-conservative) |

### Roof compatibility

A recipe may not force a roof family that contradicts the declaration:

| recipe `roof` | compatible when |
| --- | --- |
| `source` | always (the source declaration is retained) |
| `hip` (5, 21) | declared `hipped`/`pyramidal`, or no declaration |
| `mansard` (17) | declared `mansard`, or no declaration |
| `sawtooth` (18), `clerestory` (19) | declared `flat`, or no declaration |
| anything else | — |

Therefore a declared `gabled` never selects 5/17/18/19/21, and a declared
`flat` never selects 5/17/21.

### Declared-shape narrowing

When a declaration is present, the only catalog row that expresses it is
selected outright (weight 1.0) if it is structurally eligible:

| archetype | declaration | family |
| --- | --- | --- |
| historic | `gabled` | 16 `brick_gabled_house` |
| historic | `mansard` | 17 `mansard_attic` (fallback 15 when structurally ineligible) |
| historic | `hipped`, `pyramidal`, `skillion`, `flat`, `dome`, `complex` | 15 `plaster_street_house` (roof `source`) |
| small | `gabled` | 23 `gabled_workshop` |
| small | `hipped`, `pyramidal` | 21 `hipped_house` |
| small | `flat` | 22 `flat_service_annex` |
| small | `mansard`, `skillion`, `dome`, `complex` | 22 `flat_service_annex` (roof `source`) |
| khrushchev | `hipped`, `pyramidal` | 5 `pitched_low_block` |

Example: `historic` + `roof:shape=gabled` always selects recipe **16**
(`brick_gabled_house`) with `source = "osm_hint"`. An oversized historic
footprint (> 900 m² / > 14 m) with an explicit `mansard` cannot carry 17 and
falls back to 15.

---

## 6. Safe fallback

After roof filtering, if no candidate survives (for example an industrial hall
that declares `roof:shape=gabled`, which excludes sawtooth 18 and clerestory 19),
the selector uses the archetype's roof-safe fallback — a family whose catalog
roof is `source`, so a declaration is never rewritten:

| archetype | broad base recipe | safe fallback |
| --- | --- | --- |
| stalin | 0 `ensemble_symmetric` | 0 |
| khrushchev | 4 `balcony_slab` | 4 |
| panel | 6 `recessed_loggia` | 6 |
| modern | 11 `framed_residential` | 11 |
| office | 12 `curtain_ribbon` | 12 |
| historic | 15 `plaster_street_house` | 15 |
| industrial | 19 `broad_clerestory_hall` | 20 `service_workshop` |
| small | 21 `hipped_house` | 22 `flat_service_annex` |
| civic | 24 `school_hospital_wings` | 24 |

Every non-protected building therefore always receives a family; no building
falls through unstyled and no building is dropped to satisfy the selector.

---

## 7. Tags that influence eligibility

Only these mapped tags are inspected (design §5 information budget):

| tag | used for |
| --- | --- |
| `building` | detached-house, service/garage, commercial and civic evidence |
| `building:material` | `brick` → khrushchev 3 (`osm_hint`), historic 16 (`osm_hint`, weight 35) |
| `building:levels`, `height`, `min_height` | `height` (already derived from `height` / `building:levels` by the normalizer) drives the structural thresholds; `levels` is validated and passed but no family is chosen from floor count alone; `min_height` never enters the selector |
| `roof:shape` | authoritative roof family (§5) |
| `roof:direction`, `roof:angle`, `roof:height` | never read by the selector; preserved in the payload |
| `amenity` | commercial service tokens, civic evidence |
| `shop` | commercial evidence for office `commercial_podium` |
| `man_made` | service/utility evidence |
| `building:part` topology | `has_parts` (explicit volumes) |

Not used: rendered colour, unrelated building ids, tile/process order, random
seeds, wall-clock time.

---

## 8. Emission in the normalizer

`scripts/normalize/normalize.py` selects **after** `landmark_override` is known
and **before** the `volumes`/profile assembly, so no rendered geometry can
influence the choice:

```python
protected_route = bool(landmark_override) or archetype in {'palace', 'stadium'}
selection = select_style(
    StyleInput(building_id, archetype, tags, polygon, height, levels,
               bool(part_groups.get(index)))
)
style_payload = {
    'schema': 1,
    'recipeId': legacy_style_id(archetype) if protected_route else selection.recipe_id,
    'source': 'legacy_default' if protected_route else selection.source,
    'eligibility': ['protected_geometry_route'] if protected_route else list(selection.eligibility),
}
```

The payload is attached as `feature["styleVariant"]` right after the complete
`BuildingFeature` dictionary; no existing field is shortened, `archetype` is not
replaced, and `tags` still contains `building:material` (the payload tag filter
keeps every `building:*` key).

### Protected routes

* `landmark_override` (curated Minsk Gate, National Library, Victory obelisk,
  Red Church, TV tower) and archetypes `palace` / `stadium` are protected.
* Their `styleVariant` uses `legacy_style_id(archetype) = 27 + ARCHETYPE_BY_ID
  index`, `source = "legacy_default"` and
  `eligibility = ["protected_geometry_route"]`, so the previous facade
  parameters are reproduced exactly and a family preset can never be inherited.

Legacy runtime ids (reserved, never family recipes):

| archetype | legacy id | recipe name |
| --- | --- | --- |
| stalin | 27 | `legacy_default_stalin` |
| khrushchev | 28 | `legacy_default_khrushchev` |
| panel | 29 | `legacy_default_panel` |
| modern | 30 | `legacy_default_modern` |
| office | 31 | `legacy_default_office` |
| historic | 32 | `legacy_default_historic` |
| industrial | 33 | `legacy_default_industrial` |
| small | 34 | `legacy_default_small` |
| civic | 35 | `legacy_default_civic` |
| palace | 36 | `legacy_default_palace` |
| stadium | 37 | `legacy_default_stadium` |

### Manifest and payload version

The tile payload minor version is raised from `0.4.3` to **`0.5.0`**
(`PAYLOAD_VERSION`). The manifest records:

| key | value |
| --- | --- |
| `styleSchema` | `1` |
| `sourceDatasetId` | `"<area>-<first 16 hex of the input PBF sha256>"`; with the reviewed B-2 extraction (`pbf_sha256 = da3ccdb434f90d6a…`) the city id is `city-da3ccdb434f90d6a` |
| `sourceInputSha256` | SHA-256 of the canonical JSON of `{area, epsg, center, window, pbf, pbfSize, pbfSha256, tileSize, bounds}` |
| `styleRunId` | the same deterministic input hash, recorded as the identity of one styled run (no wall clock) |
| `styleRecipeCounts` | object with **all 38 runtime ids** (`0..26` families, `27..37` legacy) → building count, zeros included |

The source-input hash deliberately excludes `generatedAt` so the same reviewed
inputs always produce the same fingerprint.

---

## 9. Provenance (`source`)

`osm_hint` when the chosen family was actually constrained by a tag:

| selected family | tag |
| --- | --- |
| 3 `brick_punched` | `building:material` contains `brick` |
| 16 `brick_gabled_house` | `roof:shape=gabled` or masonry material (`brick`/`stone`) |
| 17 `mansard_attic` | `roof:shape=mansard` |
| 21 `hipped_house` | `roof:shape=hipped`/`pyramidal` |
| 22 / 23 | service/garage/utility tags |
| 23 `gabled_workshop` | `roof:shape=gabled` |

Everything else is `heuristic`, including the weighted hash walk over a broad
candidate set: a weight boost from weak context (e.g. height) is not a tag
constraint.

### Eligibility reason tokens

`archetype:<name>`, `recipe:<id>:<name>`, `explicit_roof:<family|none>`,
`explicit_parts`, `courtyard`, `material:<tokens>` (sorted, `+` joined),
`service_tags`, `detached_house_tags`, `civic_tags`,
`sawtooth_bays:<3..6>`, `single_candidate` / `weighted_hash`,
`roof_embellishment` (for recipes 5/17/18/19/21). Protected routes carry
`protected_archetype` (selector) or `protected_geometry_route` (payload).

---

## 10. Verification

```powershell
.venv\Scripts\python.exe -m unittest discover -s scripts/normalize/tests -p "test_*.py" -v
pnpm run typecheck
pnpm exec vitest run tests/unit/buildings/buildingStyles.test.ts
```

Selector contract tests cover: explicit gable stays 16; identical repeated
selection; the same id among 10,000 reordered features is unchanged; garages are
22/23 only; brick material is 3 with `osm_hint`; modern `has_parts` can select 9
but never invents one; detached houses never select 22; courtyard/oversized
historic never 17; short industrial halls never 18; declared roofs stay
authoritative; input tags/height are never mutated; every broad candidate set is
non-empty, sums to `1.0` within `1e-12` and contains the archetype base recipe.

No city dataset is regenerated by this step; that is a separate reviewed
Task 6 run (`scripts/normalize/normalize.py --area city --tiles-dir <staging>`).
