# Complete-city procedural architecture and GitHub Pages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add 27 coherent procedural building families, retain the entire expanded city without building or geographic cuts, verify five visual levels, and deploy that complete city as the only public map on GitHub Pages.

**Architecture:** Offline normalization assigns a stable, versioned recipe ID while preserving source volume metadata. TypeScript adapters resolve those recipes into shared massing, projection, roof and facade modules inside the existing merged tile mesh. Independent full/far representations cover the same building IDs, and a whitelist-built static artifact is published only after data, visual, runtime, licensing and nested-path checks pass.

**Tech Stack:** Python 3.11/Shapely for data staging and audits; TypeScript, Three.js and GLSL for geometry/materials; Vite/React for the static app; Vitest/unittest/Playwright for tests and evidence; pnpm 10/Node 24; GitHub Actions and GitHub Pages.

**Design:** [`2026-11-14-procedural-building-variety-design.md`](../specs/2026-11-14-procedural-building-variety-design.md)

---

## Handoff invariants

1. The observed baseline is the 437-address B2 candidate: 76,004 source buildings, 1,910,624 trees, 295,295,334 tile bytes. Recompute from the actual accepted manifest before every release; these numbers are not a perpetual magic constant.
2. The public application resolves **only `city`**. A pilot dataset, `city-tiles-current`, a staging city, or an older 400-tile resident collection is not a valid release substitute.
3. Preserve all real footprints, building IDs, heights/parts, explicit roof tags and curated routes. Optional profile recipes must remain in source envelopes and record any profiled `sourceVolumes`.
4. 27 recipes have IDs `0..26`; recipes alone—not color permutations or whole-city random height jitter—are counted as architectural variety.
5. No per-window/per-building draw calls. No per-frame allocations of decorative geometry. Merge output per tile through `MeshSink` and transfer `triangleOwner` unchanged.
6. Never claim visual or FPS success from unit tests, SwiftShader FPS or file counts. Capture visual L0–L4 evidence and record hardware-GPU p95/resource measurements.
7. Work in an isolated worktree. The root checkout is already on `feat/road-normalization` and contains unrelated changes in `scripts/geo_config.py`, `scripts/ingest/extract.py`, normalization and validation modules. Do not reset, overwrite, stage or lose them.
8. Treat the B2 full/far implementation currently under development as an integration prerequisite. Do not rebuild ground raster/tree LOD or replace it with a placeholder ground plate.
9. Artifacts from captures go to ignored `screenshots/building-quality/<revision>/`; only compact manifests, measurements, provenance and human approval records go into `docs/building-quality/`.
10. The owner must select the source-code license before an open-source claim, choose the public repository owner/name, and supply/resolution-check third-party model redistribution permission. Do not invent these identities, permissions or data licenses.

## Planned file ownership

| File | Responsibility |
| --- | --- |
| `src/shared/buildingStyles.ts` | Recipe metadata and strict runtime-safe lookup |
| `scripts/normalize/style_recipes.py` | Offline recipe/ID mirror and selection API |
| `src/shared/building-style-recipes.json` | Canonical recipe IDs, names, archetypes, eligibility tags |
| `src/shared/geometry.ts` | Float32-safe bit packing helpers and vertex contract documentation |
| `src/shared/types.ts` | Style metadata, source volumes, far payload and version fields |
| `src/city/buildings/style.ts` | Per-building resolution, palette and resolved module parameters |
| `src/city/buildings/buildingProfiles.ts` | Bounded source-preserving massing profiles |
| `src/city/buildings/facadeDetails.ts` | Projection, balcony and entrance primitives |
| `src/city/roofs/variantRoofs.ts` | Mansard and oriented industrial roof surfaces |
| `src/city/buildings/buildingsMesh.ts` | Legacy/curated routing and detail dispatch |
| `src/city/facades/presets.ts` | Recipe-driven facade/lod parameters |
| `src/engine/materials/facadeMaterial.ts` | Preset uniform arrays keyed by recipe |
| `src/engine/shaders/facadeShader.ts` | Masked flags, recipe-indexed presets and compatible motif branches |
| `src/engine/tiles/tileBuild.ts` | Build level, per-layer byte geometry instrumentation |
| `src/engine/tiles/serialization.ts` | Full/far representation labels transmitted to the main thread |
| `src/engine/tiles/cityLodStreamer.ts` | Full/far coverage and atomic replacement policy |
| `src/engine/tiles/tileStreamer.ts` | Existing ground/tree/detail stream integration, no placeholder tiles |
| `src/shared/config.ts`, `src/shared/assets.ts` | Single-city endpoints below the deployment base |
| `scripts/normalize/normalize.py` | Calling style selection and emitting style manifest metadata |
| `scripts/normalize/export_far.py` | Derive complete far geometry from accepted source/profile metadata |
| `scripts/qa/freeze_building_baseline.py` | Freeze source hashes and real-city comparison cases |
| `scripts/qa/building_contract_audit.py` | Validate source identity, geometry envelopes and recipe usage |
| `scripts/qa/building-gallery-capture.mjs` | L1 gallery snapshots and assertions |
| `scripts/qa/building-review-capture.mjs` | Locked camera city before/after pairs and route captures |
| `scripts/qa/building-runtime-audit.mjs` | GPU-tagged performance and journey evidence |
| `scripts/qa/build-pages.mjs`, `scripts/qa/publication-audit.mjs` | Whitelist site assembly and fail-closed publication checks |
| `qa/building-gallery.html`, `src/qa/buildingGallery.ts` | Isolated geometry/material gallery using production builders/materials |
| `tests/unit/buildings/buildingStyles.test.ts` | Recipe parity, bit packing and deterministic legacy fallback |
| `tests/unit/buildings/facadeDetails.test.ts` | Projection normality, caps, placement and owner tracking |
| `tests/unit/buildings/buildingProfiles.test.ts` | Bounded profile topology and source-volume preservation |
| `tests/unit/roofs/variantRoofs.test.ts` | Roof eligibility, normals, orientation and height bounds |
| `tests/unit/facades/facadeMaterial.test.ts` | Runtime shader source/uniform contract |
| `tests/unit/config_sync.test.ts` | Full-city-only resolver and endpoint path behavior |
| `tests/e2e/buildingGallery.spec.ts`, `tests/e2e/publication.spec.ts` | Browser rendering and nested-path release checks |
| `.github/workflows/pages.yml` | Deterministically build/validate/deploy reviewable release |

`docs/building-quality/review-cases.json` provides the shared machine-readable case registry. `REVIEW.md` contains L0–L4 reviewer findings and cannot pass with blank/unreviewed rows. `screenshots/` remains excluded from git and any Pages artifact.

---

### Task 0: Isolate the feature and freeze an honest baseline

**Files:**
- Create: `docs/building-quality/BASELINE.json`, `REVIEW.md`
- Modify: `scripts/qa/b2_staging_audit.py`, `scripts/normalize/tests/test_pipeline_guards.py`
- Read before edits: `scripts/geo_config.py`, `scripts/ingest/extract.py`, `scripts/normalize/normalize.py`, `scripts/normalize/trees.py`, `scripts/validation/coverage_report.py`

- [ ] **Step 1: Create isolated work using the worktree workflow**

Load `using-git-worktrees`. Record the current branch/diff before choosing the new worktree's starting commit. Do not stash or accidentally include the existing B2 edits in an unrelated baseline claim. If the building feature depends on those edits, explicitly base it on their reviewed commit rather than silently assuming they are in `HEAD`.

- [ ] **Step 2: Run the baseline suites and record failures before changing anything**

```powershell
pnpm run typecheck
pnpm test
pnpm run test:data
git status --short
```

Expected: baseline output is captured verbatim in `docs/building-quality/BASELINE.json` with exact suite results. A pre-existing failure remains a documented failure; do not mark it newly introduced by buildings.

- [ ] **Step 3: Reconcile the expected address book**

The currently observed 437-tile manifest must be checked against the latest `docs/B2/area.json` and `docs/B2/STAGING_AUDIT.json`, whose older reports may name 399/400 addresses. Update the expected area contract only from the reviewed raw-input bounds (`scripts/geo_config.py`), derive tile addresses from the manifest's inclusive min/max/range, and record the reasons for any differences. Keep exact existing-road/source fixes in their original commits.

- [ ] **Step 4: Run independent staging validation**

```powershell
.venv\Scripts\python.exe scripts/qa/b2_staging_audit.py --tiles-dir public/data/city-tiles-b2 --coverage data/processed/coverage_city_b2.json
```

Expected: zero failed checks, no missing address, no trees/global thinning mismatch, and no changed protected baseline inputs. If the B2 stream is not integrated, record that as a blocker; do not fake L0 by hiding the outer 37 tiles.

- [ ] **Step 5: Freeze the complete-city L0 samples**

Add deterministic selection by input category (not by best-looking outcomes): at least one real case per 11 broad archetypes, 3 panel-residential neighborhoods, 3 pre-war/low-rise areas, all curated landmarks, a modern tower district, industrial area, detached/small-building edge, four corners, river/bridge and Lipki. Preserve `id`, `tileKey`, `localX`, `localY`, `height`, `archetype`, `tags`, `inputBounds`, and source manifest hash. Do not invent OSM IDs.

- [ ] **Step 6: Commit the baseline only**

```powershell
git add docs/building-quality scripts/qa/b2_staging_audit.py scripts/normalize/tests/test_pipeline_guards.py
git commit -m "test: freeze complete-city building quality baseline"
```

**Review gate:** confirm full-city coverage and initial data acceptance before writing style code. `L0` is recorded as either `pass` or `fail with named blocker` in `docs/building-quality/REVIEW.md`; never use ambiguous success wording.

---

### Task 1: Introduce the versioned recipe/schema contract

**Files:**
- Create: `src/shared/building-style-recipes.json`, `src/shared/buildingStyles.ts`, `scripts/normalize/style_recipes.py`, `src/shared/building-style-recipes.schema.json`
- Create: `tests/unit/buildings/buildingStyles.test.ts`, `scripts/normalize/tests/test_style_recipes.py`
- Modify: `src/shared/types.ts`, `src/shared/geometry.ts`

- [ ] **Step 1: Write failing cross-language tests for IDs and type-safe fallback**

```ts
// tests/unit/buildings/buildingStyles.test.ts
import recipes from '../../shared/building-style-recipes.json';
import { getStyleRecipe, packStyleBits, unpackStyleBits } from '../../shared/buildingStyles';

it('exposes the complete stable catalog', () => {
  expect(recipes).toHaveLength(27);
  expect(recipes.map((recipe) => recipe.id)).toEqual(Array.from({ length: 27 }, (_, id) => id));
  expect(getStyleRecipe(999).name).toBe('legacy_default_panel');
});

it('keeps flags and recipe ids exact in float32', () => {
  for (const id of [0, 1, 17, 26, 255]) {
    const packed = packStyleBits(0xff, id);
    expect(Math.fround(packed)).toBe(packed);
    expect(unpackStyleBits(packed)).toEqual({ flags: 0xff, recipeId: id });
  }
});
```

```python
# scripts/normalize/tests/test_style_recipes.py
import json
import unittest
from pathlib import Path
from style_recipes import get_style_recipe

class RegistryTest(unittest.TestCase):
    def test_typescript_json_registry_agrees(self):
        document = json.loads((Path(__file__).parents[3] / 'src/shared/building-style-recipes.json').read_text())
        for entry in document:
            self.assertEqual(get_style_recipe(entry['id']).name, entry['name'])
            self.assertEqual(get_style_recipe(entry['id']).archetype, entry['archetype'])
```

Run `pnpm exec vitest run tests/unit/buildings/buildingStyles.test.ts` and the new Python test. Expected: `module not found` / absent JSON is the intentional test failure, not a global import error.

- [ ] **Step 2: Add the actual canonical catalog**

Use all 27 rows and eligibility rules in the approved design §5 exactly. Example JSON entries:

```json
[
  {"id": 0, "name": "ensemble_symmetric", "archetype": "stalin", "profile": "frame", "facade": "monument", "roof": "source", "details": ["entrance", "pilasters", "cornice"], "palette": ["#c39a63", "#cba66f", "#d0b078"]},
  {"id": 17, "name": "mansard_attic", "archetype": "historic", "profile": "base", "facade": "historic", "roof": "mansard", "details": ["cornice"], "palette": ["#b98a63", "#c49a76", "#b07a62"]},
  {"id": 18, "name": "sawtooth_factory", "archetype": "industrial", "profile": "base", "facade": "clerestory", "roof": "sawtooth", "details": ["industrial_roof"], "palette": ["#9a9b8e", "#8f9186", "#a4a496"]}
]
```

The file must contain the other 24 complete—not abbreviated—entries with structurally meaningful detail fields and no invented geometry placeholders. ID 26 is `assembly_hall`. Validate the JSON with `building-style-recipes.schema.json`: family IDs `0..26`, required `id/name/archetype/profile/facade/roof/details/palette` fields, no blank names, palette entries as six-digit sRGB, and no unsupported profile/roof names. Test schema rejection of a partial recipe entry so one empty table row cannot silently select a legacy generic.

- [ ] **Step 3: Implement strict lookup and bit packing**

```ts
// src/shared/buildingStyles.ts
export interface StyleRecipe {
  readonly id: number; readonly name: string; readonly archetype: Archetype;
  readonly profile: 'base' | 'frame' | 'end_pavilion' | 'stepped';
  readonly facade: string; readonly roof: 'source' | 'hip' | 'mansard' | 'sawtooth' | 'clerestory';
  readonly details: readonly DetailKind[]; readonly palette: readonly string[];
}
export const LEGACY_RECIPE_OFFSET = 27;
export function legacyRecipeFor(archetype: Archetype): StyleRecipe {
  return { ...legacyPresets[archetype], id: LEGACY_RECIPE_OFFSET + ARCHETYPE_ID[archetype] };
}
// `legacyPresets` contains complete copies of all 11 prior preset values from
// src/city/facades/presets.ts, not aliases into the 27-family preset values.
// The 27-family table is imported verbatim from building-style-recipes.json.
export function packStyleBits(flags: number, recipeId: number): number {
  if (!Number.isInteger(recipeId) || recipeId < 0 || recipeId > 255) throw new RangeError('recipeId must be 0..255');
  return ((recipeId << 8) | (flags & 0xff)) >>> 0;
}
export function unpackStyleBits(value: number): { flags: number; recipeId: number } {
  const packed = (value | 0) >>> 0;
  return { flags: packed & 0xff, recipeId: (packed >>> 8) & 0xff };
}
```

`getStyleRecipe(id: number | undefined, archetype: Archetype = 'panel'): StyleRecipe` resolves ID `0..26` from the family catalog and ID `27..37` from the original preset copy. Missing/unknown IDs use `legacyRecipeFor(archetype)`. It rejects a recipe whose broad archetype disagrees with the source feature, logs once per unknown key, and returns that same prior preset. Add `BuildingStyleVariant { schema: 1; recipeId: number; source: 'osm_hint' | 'heuristic' | 'legacy_default'; eligibility: string[] }`, optional on `BuildingFeature`, and optional `sourceVolumes` as in the design. Shader indices allow `0..37` (38 presets), not only the 27 families; legacy `palace` and `stadium` therefore never reuse a modern-family preset.

- [ ] **Step 4: Verify contracts and commit**

Run the two tests plus `pnpm run typecheck`, compare all 27 IDs/names/palettes across Python and TypeScript, then commit only schema/registry/tests:

```powershell
git add src/shared/building-style-recipes* src/shared/buildingStyles.ts src/shared/types.ts src/shared/geometry.ts scripts/normalize/style_recipes.py scripts/normalize/tests/test_style_recipes.py tests/unit/buildings/buildingStyles.test.ts
git commit -m "feat: add procedural building recipe registry"
```

---

### Task 2: Assign recipes offline deterministically and safely

**Files:**
- Modify: `scripts/normalize/style_recipes.py`, `normalize.py`, `scripts/normalize/tests/test_style_recipes.py`
- Create: `docs/building-quality/style-selection-rules.md`

- [ ] **Step 1: Write failing selector boundary tests**

```python
from shapely.geometry import Polygon
from style_recipes import StyleInput, select_style

class SelectionTest(unittest.TestCase):
    def test_explicit_gable_is_not_changed(self):
        source = StyleInput(id='w2005', archetype='historic', tags={'roof:shape': 'gabled'}, polygon=Polygon([(0,0),(18,0),(18,8),(0,8)]), height=9.0, levels=3, has_parts=False)
        self.assertEqual(select_style(source).recipe_id, 16)

    def test_all_selection_is_source_local_and_stable(self):
        for name in ('w2005', 'w3002', 'w3001'):
            source = historic_fixture(feature_id=name)
            first = select_style(source)
            second = select_style(source)
            self.assertEqual(first, second)

    def test_small_outbuilding_never_gets_apartment_glass(self):
        result = select_style(StyleInput(id='w42', archetype='small', tags={'building': 'garage'}, polygon=Polygon([(0,0),(6,0),(6,3),(0,3)]), height=3.2, levels=1, has_parts=False))
        self.assertIn(result.recipe_id, {22, 23})
```

Add a case for `w42` reordered among 10,000 other IDs and assert unchanged output; material-tag cases; explicit multi-part tower case; detached-house case; courtyard/mansard ineligibility case; oversized industrial case; source roof-direction preservation case. `historic_fixture()` must be a real local helper built from a Shapely rectangle, not a forbidden undefined function.

- [ ] **Step 2: Implement input, eligibility and weighted hash selection**

```python
@dataclass(frozen=True)
class StyleInput:
    id: str
    archetype: str
    tags: Mapping[str, str]
    polygon: Polygon
    height: float
    levels: int | None
    has_parts: bool

@dataclass(frozen=True)
class StyleSelection:
    recipe_id: int
    source: Literal['osm_hint', 'heuristic']
    eligibility: tuple[str, ...]

def stable_unit(feature_id: str) -> float:
    digest = hashlib.blake2b(f'{feature_id}|style-schema-1'.encode('utf-8'), digest_size=8).digest()
    return int.from_bytes(digest, 'big') / float(2 ** 64 - 1)

def select_style(source: StyleInput) -> StyleSelection:
    candidates = eligible_recipes(source)
    assert candidates and abs(sum(weight for _, weight in candidates) - 1.0) < 1e-12
    selected = candidates[-1][0]  # Only covers floating-point cumulative rounding.
    cumulative = 0.0
    unit = stable_unit(source.id)
    for recipe, weight in candidates:
        cumulative += weight
        if unit < cumulative:
            selected = recipe
            break
    return StyleSelection(
        selected.id,
        selection_provenance(source, selected),
        selection_reasons(source, selected),
    )
```

Require `eligible_recipes()` to validate source archetype, roof tag/shape, explicit parts, min-area-rect dimensions, courtyard constraints and material/detached/service tags. Every candidate set must be non-empty, include the broad base recipe as safe fallback, and have floating-point cumulative weights within 1e-12 of 1. Return no source-height/tag mutations.

- [ ] **Step 3: Emit metadata after landmark override, before volumes/profile assembly**

Place it after `landmark_override` is known so curated/stadium paths get a legacy-compatible recipe and cannot accidentally inherit a generic one, but before `volumes` are constructed in `normalize.py:1450-1600`. Add:

```python
protected_route = bool(landmark_override) or archetype in {'palace', 'stadium'}
selection = select_style(StyleInput(building_id, archetype, tags, polygon, height, levels, bool(part_groups.get(index))))
style_payload = {
    'schema': 1,
    'recipeId': legacy_style_id(archetype) if protected_route else selection.recipe_id,
    'source': 'legacy_default' if protected_route else selection.source,
    'eligibility': ['protected_geometry_route'] if protected_route else list(selection.eligibility),
}
feature['styleVariant'] = style_payload
buildings.append(feature)
```

Rename the existing full dictionary passed to `buildings.append` at `normalize.py:1616-1634` to `feature` and put these two statements directly after that dictionary. Do not otherwise shorten its fields. `legacy_style_id(archetype)` returns `27 + index` in the same 11-entry `ARCHETYPE_BY_ID` order as `src/shared/geometry.ts`; add a contract test for this mapping so protected palace/stadium routes preserve their previous facade parameters. Do not replace `archetype` in place. Include `building:material` in `tags_out` when present, bump payload minor version, and record the selected recipe count map plus style schema, `sourceDatasetId` and source-input hash in the manifest.

- [ ] **Step 4: Document and verify selection without regenerating the live city**

Write every eligible tag, structural threshold, weight, and fallback to `style-selection-rules.md`. Run:

```powershell
.venv\Scripts\python.exe -m unittest scripts.normalize.tests.test_style_recipes -v
pnpm run test:data
pnpm run typecheck
```

Expected: explicit roof/tag precedence, unchanged stable IDs and no style-conditional ground bands on elevated parts. Commit this isolated selector before geometry modules.

---

### Task 3: Wire resolved recipes into shaders without changing archetype semantics

**Files:**
- Modify: `src/city/facades/presets.ts`, `src/city/buildings/style.ts`, `src/shared/geometry.ts`, `src/engine/materials/facadeMaterial.ts`, `src/engine/shaders/facadeShader.ts`, `tests/unit/facades/facadeMaterial.test.ts`, `tests/fixtures/buildings.ts`

- [ ] **Step 1: Add failing tests for legacy, recipe and invalid-ID behavior**

```ts
it('resolves the previous facade when styleVariant is missing', () => {
  const result = styleForBuilding(squarePrismBuilding(), 0, true, 1);
  expect(result.recipe.name).toBe('legacy_default_panel');
  expect(result.floorHeight).toBe(presetFor('panel').floorHeight);
});

it('changes geometry-facing recipe and retains broad archetype for night/panel handling', () => {
  const feature = squarePrismBuilding({ styleVariant: { schema: 1, recipeId: 8, source: 'heuristic', eligibility: ['levels'] } });
  const result = styleForBuilding(feature, 2, true, 1);
  expect(result.archetype).toBe('panel');
  expect(result.recipe.name).toBe('staircore_spine');
  expect(unpackStyleBits(result.flags)).toMatchObject({ recipeId: 8 });
});
```

Add `styleVariant?: BuildingStyleVariant` to `MakeBuildingOptions` and propagate it. Assert missing/unknown IDs choose a valid default and never generate `-1`, `NaN`, or an out-of-range uniform index: legal IDs are family `0..26` plus legacy `27..37`.

- [ ] **Step 2: Resolve recipe on CPU**

Extend `BuildingStyle` with `recipe`, `detailModules` and resolved manager-specific values. Set `flags = packStyleBits(baseFlags, recipe.id)`. For old features, preserve the original `presetFor(archetype)` numeric values and hex palette exactly. For modern recipes, select colors from `recipe.palette` with `facadeHash11(seed)` only (no geometry-dependent seeding), and apply existing floor/ground overrides within structural source metres. Set `FACADE_PRESET_COUNT = 27 + ARCHETYPE_BY_ID.length` (38), while `ARCHETYPE_BY_ID` remains unchanged. Test the fragment uniform count and verify preset values for legacy `palace`, `stadium`, `small` and `panel`, not just generic panel.

- [ ] **Step 3: Route and mask existing shader code**

Set preset uniform index from `int(unpackedRecipeId)` clamped to `0..37`; retain `archetype = int(vFacadeStyle.x + 0.5)` for palace/stadium material semantics. Use `flags = packed & 255`, and make `FACADE_VERTEX_DECLARATIONS`, `FACADE_FRAGMENT_DECLARATIONS` and string-test assertions document the new packing.

Add these recipe-wide branches with preset-driven numeric parameters:

| Recipe facade branch | Required rule |
| --- | --- |
| `monument`, `historic`, `grid` | Ordered vertical/horizontal accents follow real coordinates and same rows |
| `loggia`, `balcony_stack` | Bounded dark band + slab/rail, selected whole bay segments only |
| `staircore` | Continuous vertical glazing over eligible upper volume height |
| `ribbon`, `clerestory` | Correct spandrel/sill and tall/industrial opening placement |
| `blank_service`, `assembly_hall` | Intentional sparse/blank portions, never accidental loss of all window types |

Do not add 27 `if` statements; dispatch by motif integer derived from recipe metadata. Night lit-window logic still runs exactly once for every visible opening and never emits for blank/trim/roof faces.

- [ ] **Step 4: Verify shader compilation/attribute tests and legacy mesh equality**

```powershell
pnpm exec vitest run tests/unit/facades/facadeMaterial.test.ts tests/unit/buildings/buildingsMesh.test.ts
pnpm run typecheck
```

Expect known shader patches/uniform arrays to exist, attributes matching item sizes, and legacy fixture bytes/index data to be identical for an unstyled input. Commit with `feat: drive facade materials from building recipes`.

---

### Task 4: Add bounded massing and modular facade geometry

**Files:**
- Create: `src/city/buildings/buildingProfiles.ts`, `facadeDetails.ts`
- Create: `tests/unit/buildings/buildingProfiles.test.ts`, `facadeDetails.test.ts`
- Modify: `src/city/buildings/buildingsMesh.ts`, `src/city/buildings/style.ts`, `tests/fixtures/buildings.ts`, `tests/unit/buildings/buildingsMesh.test.ts`

- [ ] **Step 1: Write failing source-envelope and triangle tests**

```ts
function explicitRecipe(recipeId: number): BuildingStyleVariant {
  return { schema: 1, recipeId, source: 'heuristic', eligibility: ['synthetic_gallery'] };
}

it('profiles inside the declared height and original footprint', () => {
  const building = squarePrismBuilding({ id: 'w-profile', styleVariant: explicitRecipe(10) });
  const result = buildBuildingsMesh([building], { facadeDetail: true, detailScale: 1 });
  const bounds = worldBounds(result.geometry);
  expect(bounds.max.y).toBeLessThanOrEqual(building.height + 0.05);
  expect(bounds.min.y).toBeGreaterThanOrEqual(-0.001);
  const positions = result.geometry.getAttribute('position').array as Float32Array;
  for (let i = 0; i < positions.length; i += 3) {
    expect(Number.isFinite(positions[i])).toBe(true);       // local east
    expect(positions[i + 1]).toBeLessThanOrEqual(building.height + 0.05);
    expect(Number.isFinite(positions[i + 2])).toBe(true);   // world z = -local north
    expect(pointInApprovedPlan(positions[i], -positions[i + 2], building.volumes, 0.45)).toBe(true);
  }
  expect(decodeMesh(result).every((t) => Number.isInteger(t.owner))).toBe(true);
});
```

Implement `worldBounds()` using `geometry.computeBoundingBox()` plus local `pointInApprovedPlan(x, y, volumes, 0.45)`: the latter accepts a point inside a source exterior ring, with courtyard-hole exclusions, or within 0.45 m of an approved exterior projection edge. Inspect every triangle/source point in plan (`position.x`, `-position.z`) against the reference exterior/hole rings, with an allowance of **0.45 m outward only for approved projections**. Do not use all points of an inward-offset output as proof unless all mandatory source sides remain capped. Compare the required wall/roof surface area and source IDs before/after profiling.

Additional failing cases: end pavilion on rectangle; stepped concave footprint; courtyard fallback; small volume safe skip; elevated `building:part` no ground band; a balcony between `baseHeight + storeyIndex * floorHeight` and upper balcony top within wall; explicit part/curated stadium signature unchanged.

- [ ] **Step 2: Implement source-preserving profiles**

```ts
export interface VolumeProfile {
  readonly volumes: BuildingVolume[];
  readonly changed: boolean;
}
export function profileVolumes(
  volumes: readonly BuildingVolume[],
  context: GeometryBuildContext,
): VolumeProfile {
  if (context.detailLevel === 'far' || !recipeSupportsProfile(context.recipe)) {
    return { volumes: [...volumes], changed: false };
  }
  return profileFor(context.recipe.profile, volumes, context);
}
```

This near adapter is an implementation detail; **far must be exported from the same source/profile representation or explicit style profile**, never call this near skip and recreate generic slabs by accident. `end_pavilion` operates on a supported simple rectangle/end region and reduces only non-preserved wall segments; `stepped` splits at a signed longitudinal coordinate and caps the step. Existing explicit parts always remain authoritative; courtyard profiles use `base`. Return a versioned profile and (from Task 7) serialize `sourceVolumes` where output differs.

- [ ] **Step 3: Implement shared facade geometry functions**

`facadeDetails.ts` consumes `MeshSink`, clean `RingInfo[]`, dimensions and `BuildingStyle`. `addFacadeFrame` emits per-edge piers/horizontal boxes with outward/inward/top/bottom/side faces. For a segment start `A=(ax,ay)`, end `B=(bx,by)`, unit wall normal `N=(nx,ny)`, depth `d` and height interval `[h0,h1]` form front plane shifted by `N*d`; UV `u` is along-edge metres, `v` is absolute metres above **ground volume** base. Preserve correctly outward normals in world space.

`addBalconyStack` selects contiguous whole bays between floor-aligned heights, clamps rail top to `wallTop` and keeps every projection within `sourceAABB expanded by 0.45 m`. `addEntranceTreatment` picks a longest edge only when it is at least one ground-floor bay long and places canopy/entrance framing below `min(groundFloorHeight, wallHeight)`; `height <= groundFloorHeight` gets only scaled door treatment, not an outside second storey.

Emit through `MeshSink.addQuad` / `addTriangle`; apply closed manifold faces for each solid, proper `FACE_KIND.trim`/`glass` attributes and same triangle owner. Avoid placing a clip-safe duplicate wall at the same depth as the original wall. Include material IDs same as its host recipe, not concrete colors independent of palette.

- [ ] **Step 4: Dispatch only after base walls and before finishing the tile mesh**

For every volume, in this order: clean boundaries, retain mandatory walls, emit roofs/profile, call chosen modules, then aggregate warnings. Curated `addCuratedLandmark`, stadium and city gate continue before generic dispatch. When a detail module throws, catch at that module boundary, preserve already-correct mandatory base, add a feature/module warning, and omit only that optional geometry. Add a flag in `BuildingMeshResult.stats` for source geometry vs decorative triangle/byte counts.

- [ ] **Step 5: Run finite/flat-normal/boundary tests and commit**

```powershell
pnpm exec vitest run tests/unit/buildings/buildingProfiles.test.ts tests/unit/buildings/facadeDetails.test.ts tests/unit/buildings/buildingsMesh.test.ts
pnpm run typecheck
```

Expected: all mandatory source walls retained; capped finite normals; no z-fighting coincident frames/walls; no invalid triangle/quad indices; deterministic triangle counts and IDs; curated mesh tests pass. Commit geometry only after reviewing at least rectangle, concave and courtyard sample geometry in the gallery test scaffold from Task 5.

---

### Task 5: Add distinctive eligible roof envelopes and the L1 gallery

**Files:**
- Create: `src/city/roofs/variantRoofs.ts`, `tests/unit/roofs/variantRoofs.test.ts`, `qa/building-gallery.html`, `src/qa/buildingGallery.ts`, `scripts/qa/building-gallery-capture.mjs`, `tests/e2e/buildingGallery.spec.ts`
- Modify: `src/city/roofs/envelope.ts`, `src/city/roofs/roofMesh.ts`, `src/city/buildings/buildingsMesh.ts`, `src/shared/appApi.ts` (QA-facing types only), `package.json`

- [ ] **Step 1: Add failing analytic roof tests**

```ts
it('mansard keeps the height envelope and closes the original eave', () => {
  const rings = boundaryRings(makeVolume([rectRing(0, 0, 24, 12)], 0, 10, 'hipped', 3));
  const roof = mansardSurface(rings[0].points, 10, 3, 0);
  expect(roof.heightAt(12, 6)).toBeLessThanOrEqual(13 + 1e-6);
  expect(roof.heightAt(0, 0)).toBeCloseTo(10, 5);
});

it('sawtooth ridge count and direction follow its eligible rectangle', () => {
  const roof = sawtoothSurface(rectRing(0, 0, 36, 16), 9, 1.8, 4, 0);
  expect(roof.facets).toHaveLength(8);
  expect(roof.breakLines).toHaveLength(5);
  expect(roof.heightAt(36, 8)).toBeCloseTo(9, 5);
});
```

A sawtooth has one plane per slope; `n` sawteeth require `2n` facet planes, `n+1` ridge/eave boundaries in the long-axis local direction (including margin orientations), and matching eave closing facets. Use the actual planar `HeightFacet`, `BreakLine` and `RoofSurface` formula shapes in `src/city/roofs/envelope.ts`: do not break the existing normal/winding contract. Test both orientations, all height values, inside-rectangle facets and unsupported small/holey/complex input fallback.

- [ ] **Step 2: Implement envelope functions with existing clipping/normals**

Mansard uses analytic hip/gambrel planes: the steep lower plane transitions at `relativeRun = 0.6` to the shallow upper cap. The slope is clipped so roof height at eaves is exact and peak never exceeds `eave + roofRise`. Supply min-eave and ridge break definitions to `addEaveClosings`.

For oriented sawtooth define local ridge coordinate:

```ts
const u = (x - cx) * Math.cos(direction) + (y - cy) * Math.sin(direction);
const bay = longSide / bayCount;
```

Between each `[i*bay, (i+1)*bay]`, lower hipped return or end facet with a planar clerestory face exactly at the rear of the bay. Provide `breakLines` corresponding to each repeated eave/upper joint. Clip facets with the existing `clipHalfPlane` and `triangulatePolygon`; do not emit arbitrary rotated quads outside the OSM outline.

Add explicit support guards `ringCount === 1`, finite height/rise/direction, bayCount clamped to 3..6, `longSide >= 15`, `rise > 1`, and avoid courtyards/elevated overlapping pieces. Return `null` on ineligible; caller retains original source roof. No `complex` fallback is silently retagged as gabled/mansard.

- [ ] **Step 3: Build a deterministic off-main gallery**

`buildingGallery.ts` renders one fixture per panel using production `buildBuildingsMesh`, facade material, standard orthographic aspect, fixed sun/time and exactly matching camera fields. Each recipe fixture must meet its declared geometry eligibility from the JSON catalog. Build 27 independent panels in recipe-ID order and a second seeded order; create a labeled grid showing recipe, height, floors, roof and geometry mode. Expose `window.__BUILDING_GALLERY__ = { ready, readyPanels, expectedPanels, consoleErrors }` to tests.

The gallery is a QA entry not a second public city selector. Reuse production lighting/settings helpers where feasible; don't tune its lighting inconsistently to make failures invisible.

- [ ] **Step 4: Capture and verify complete L1**

Capture all 27 at `90 m` close ortho height, `13` and `22` h, azimuth `π/4` and `5π/4`, plus clean/pixel-art cases for concave/courtyard/flat/mansard/sawtooth rows. Save PNGs to ignored `screenshots/building-quality/<sha>/gallery/` and per-case status/metrics to `docs/building-quality/gallery-results.json`. Assert no black or zero-triangle panel; request at least two facade triangles for every vertical face and at least one complete roof. Use screenshot read/review by a human before advancing.

- [ ] **Step 5: Record L1 and commit**

Record every row `pass`, or `fail` with the offending geometry/appearance and named owner. Do not report all 27 as passing before actually looking at their day/night/opposite-azimuth images. Commit code/tests and compact review records, then regenerate gallery for that exact commit SHA.

---

### Task 6: Generate a reviewed full-city style candidate and satisfy L2

**Files:**
- Modify: `scripts/normalize/normalize.py`, `src/shared/types.ts`, `scripts/geo_config.py`
- Create: `scripts/qa/freeze_building_baseline.py`, `building_contract_audit.py`, `building-review-capture.mjs`, `serve-building-candidate.mjs`, `docs/building-quality/review-cases.json`, `neighborhood-results.json`
- Modify: `package.json`, `docs/building-quality/REVIEW.md`, `.gitignore`

- [ ] **Step 1: Capture/compare baseline triangle count and source inputs**

Produce `BASELINE.json` including `startCommit`, `inputManifestSha256`, `tileCount`, `buildingCount`, `treeCount`, all tile hashes and tile bytes, daytime camera settings and baseline full-layer resource measurements. `freeze_building_baseline.py --tiles-dir <accepted-candidate>` is deterministic and reads geometry only; it does not mutate/normalize the existing working dataset.

- [ ] **Step 2: Implement fail-closed source/geometry audit**

```python
# CLI:
# python scripts/qa/building_contract_audit.py --before-dir <source> --after-dir <style-stage> --out docs/building-quality/style-audit.json
```

For every before-tile and after-tile compare source identifications. For each feature compare every `sourceVolume` (if changed) against original footprint, or `volumes` exactly if no style profile is intended; top bound within `0.05 m`; plan bounds `0.005 m` plus explicitly allowed projection. Count source-required vertices/surfaces separately from optional details. Verify `schema=1`, recipes matching registry, explicit `roof:shape`, inherited part height and `building:levels`, curated ID equality and full tile address count. Unknown fallback count must be zero for the accepted dataset; unsupported optional module count is documented rather than mislabeled missing source.

Style coverage assertion: every supported recipe appears in synthetic L1, full-city must contain at least 24 eligible recipe IDs and at least 3 distinct recipes for every broad generic archetype with ≥6 eligible source buildings. Report per-archetype/per-recipe counts, palette counts and all warnings. Do not treat styles that produced no geometry change as extra architectural variants.

- [ ] **Step 3: Generate into an isolated directory**

```powershell
.venv\Scripts\python.exe scripts/normalize/normalize.py --area city --tiles-dir data/staging/city-buildings --out data/staging/city-buildings-normalized.json --coverage-out data/staging/coverage_city_buildings.json --profile
```

Check `data/staging/` is ignored and cannot be used as a public dataset directory by accident. Add `data/staging/` to `.gitignore`; retain `.venv/`, `.pages/`, raw/interim and all existing scratch exclusions.

Existing `--tiles-dir` hooks permit staging; do not temporary-copy `public/data/city-tiles` over the working dataset. Add `serve-building-candidate.mjs --tiles-dir <absolute-staged-dir>` using Vite middleware: for the QA server only, map exactly `/data/city-tiles/manifest.json` and its listed tile paths to that directory, after resolving the path and rejecting escapes. Log the resolved staged path and source manifest hash. The request router must not fall through to old `public/data/city-tiles` when a staged tile is missing. No dataset-like previews are mapped under `public/data/tiles`, and this QA middleware never participates in Pages artifact assembly. Capture uses this exact QA base URL and records the actual manifest hash. When a normalizer module has unrelated B2 modifications, preserve them and isolate this styler change in a reviewed commit.

- [ ] **Step 4: Run audit, then capture exact-camera real-city L2**

```powershell
.venv\Scripts\python.exe scripts/qa/building_contract_audit.py --before-dir public/data/city-tiles-b2 --after-dir data/staging/city-buildings --out docs/building-quality/style-audit.json
$env:QA_BASE_URL='http://127.0.0.1:5173'; node scripts/qa/building-review-capture.mjs --cases docs/building-quality/review-cases.json --mode candidate
```

Implement readiness so all target tiles reach the requested `full` representation before capture. Lock `focusOnLocal`, `setCameraSettings`, time, pixel-art settings, viewport and internal resolution; record them in the result. Capture before state from baseline commit in an independent isolated browser context against its frozen data, without overwriting the candidate data. Full-city contacts must present both sides for the exact same real building IDs.

- [ ] **Step 5: Visual loop by failure category**

For each screenshot discrepancy categorize: source preservation, massing, roof/envelope, window rhythm, trim depth, material palette, night emission, classification or LOD. An unsupported classification is fixed through eligibility and the recipe audit, not by repeatedly regenerating until one neighborhood looks good by chance.

- [ ] **Step 6: Record L2 and commit while retaining the exact staged data hashes**

Advance only after all L1 and L2 visual rows have owner sign-off and near-building measured buffers/triangles meet ≤120% of baseline. Record any callback/coverage inspection results and preserve previous report artifacts as dated historical evidence rather than silently rewriting their claims.

---

### Task 7: Complete the full/far representation and pass L3

**Files:**
- Create: `src/engine/tiles/cityLodStreamer.ts`, `scripts/normalize/export_far.py`, `tests/unit/tiles/cityLodStreamer.test.ts`, `tests/e2e/cityLod.spec.ts`
- Modify: `src/engine/tiles/tileStreamer.ts`, `tileWorker.ts`, `serialization.ts`, `tileBuild.ts`, `src/engine/createCityApp.ts`, `src/shared/appApi.ts`, `src/shared/types.ts`
- Create/modify: `scripts/qa/building-runtime-audit.mjs`, `docs/building-quality/runtime-results.json`, `journey-results.json`

**Integration precondition:** inspect and reuse the branch's pending B2 full/far plan/module rather than replacing its byte-admission, grouped overview, or tree representation. This task adds building-style compatibility and closes missing building/transition behavior—not a parallel incompatible streamer implementation.

- [ ] **Step 1: Write failing per-layer instrumentation and coverage tests**

```ts
expect(payload.buildingRepresentation).toBe('full');
expect(payload.buildingGeometry?.triangleCount).toBeGreaterThan(0);
expect(payload.buildingGeometry?.bytes).toBeGreaterThan(0);
expect(payload.buildingSourceIds).toEqual(payload.buildingIds);
```

Define `full`/`far` metadata and `sourceIds` independent of generics ownership: a far representation may simplify renderer geometry but needs the same required source feature IDs. Add unit tests for incomplete far-request => visible `error` state, missing full tile => retained previous far geometry plus explicit loading signal, cancellation => stale old generation invisible, and `downloadGeneration` barriers => no stale destructive deletion.

- [ ] **Step 2: Export complete far from shared styled source data**

```python
python scripts/normalize/export_far.py --tiles-dir data/staging/city-buildings --out data/staging/city-buildings-far --area-schema docs/B2/area.json
```

Include every source feature ID, footprint, source height, roof profile/required style-derived principal massing, recipe ID and far palette. Preserve in-schema coordinates and metadata; don't invent flat box caps over mansard/sawtooth/stepped shapes. Group in the existing accepted B2 far grouping configuration; don't raise this to a new storage grid requirement. Record total far bytes, IDs, recipe IDs, tile address mapping and inherited source manifest hash.

- [ ] **Step 3: Implement atomic full/far tile states**

```ts
type TileRepresentationState =
  | { phase: 'far'; generation: number }
  | { phase: 'full'; generation: number }
  | { phase: 'far_to_full'; from: 'far'; to: 'full'; generation: number }
  | { phase: 'full_to_far'; from: 'full'; to: 'far'; generation: number }
  | { phase: 'error'; cause: string };
```

The public `visibleBuildings(tile)` must return **at most one** building representation at any moment, including transfers and aborted tasks. In `far_to_full`, existing far stays until newly full GPU buffers are installed and ready, then one atomic switch occurs; for `full_to_far`, acquire/install far before dropping required full geometry. Allow `switching` to hold coexistence in memory, never double opaque rendering. `disposeTileGeneration()` frees only superseded resources; cache failure retains last-valid representation and marks error visibly rather than pretending complete.

The overview manifest enumerates every required accepted tile address independently of resident full tile cap. Base plate must only be an explicit error/loading state, never default capture-ready content for a required building tile.

- [ ] **Step 4: Expose honest debug/performance snapshots**

Extend `datasetInfo()` and `getStats()`/worker metadata to report `farTiles`, `fullTiles`, `switchingTiles`, `missingRequiredTiles`, `buildingTriangles`, `buildingGeometryBytes`, `farGeometryBytes`, `transferBytes`, `groundBytes`, `treeBytes`, `activeFetchCount`, `activeBuildCount`, and `rendererPass` counters. `buildingPixelsTransitionCount` or a `BuildingTransitionProbe` allows QA to count `0`, `1`, or `2` visible representations per designated tile. Counter semantics must not claim measured GPU memory when they are calculated estimates.

- [ ] **Step 5: Add transition and coverage tests**

`tests/unit/tiles/cityLodStreamer.test.ts` must simulate simultaneous downloads, full completion, out-of-order stale completion, failed fetch, restore event, cancel, immediate zoom reversal, disposal and two consecutive overview→near trips. Exactly `full/far` required addresses are checked vs accepted manifest. L3 requires every tile account, zero duplicate visible modes, and no new global monotonically growing resource usage.

- [ ] **Step 6: Run five complete journeys and collect evidence**

Route: fitted whole-city overview → historic center → panel tower district → modern set → industrial edge → Lipki → four edges/corners → whole-city overview. Repeated 5 cycles; check each shot after target LOD has completed, and additionally inspect recorded transition video/frame times or sequential midpoint screenshots for popping/doubling. Compare complete source ID sets between far and full exports; trees/extent/landmarks/museum unchanged.

- [ ] **Step 7: Record L3 only with real evidence**

Record source IDs, missing-required-tile count (must be zero), visible-transition duplicates (must be zero), exact after-cycle resource changes (≤10% above warmed state), all view/frame-time metrics, renderer contexts and captured artifacts. `scripts/qa/building-runtime-audit.mjs --gpu 1` records actual GL vendor and renderer; if it contains SwiftShader, run retains screenshot/correctness value but FPS performance is not accepted. Full/far/worker tests and `pnpm test:e2e` are prerequisites. No output claim of "zero missing tiles" unless JSON lists `missingRequiredTiles: []`.

---

### Task 8: Run the measured-cost gate before committing heavier geometry

**Files:**
- Create: `scripts/qa/building-performance-report.mjs`, `docs/building-quality/performance-baseline.json`, `performance-candidate.json`, `performance-gate.json`
- Modify: `src/engine/renderer/renderStats.ts` if present; otherwise the existing `createCityApp.ts` stats owner
- Modify: relevant geometry/preset files when a measured limit fails

- [ ] **Step 1: Define baseline/candidate pairing**

The audit receives explicit baseline and candidate paths, never ones inferred from unrelated `screenshots/stats.json` runs. Record CPU, OS, GPU renderer, device pixels, internal render size, loaded tiles, active representation modes, color levels, pixel-art enabled, renderer version, time, keys and trail. Cold-start uses a clean browser profile; warm-start uses repeat navigation under same URL/build. `/tmp` transient logs remain in `screenshots/`, not published.

- [ ] **Step 2: Apply the actual numeric decision table**

| Comparison | Pass condition |
| --- | --- |
| Building-only near triangles/buffer bytes | ≤1.20 × matching baseline |
| Accepted-B2 far triangles/resources/draw calls | Existing absolute B2 ceilings still pass |
| Near scene draws | ≤1.02 × accepted-B2 comparison |
| Near district warm p95 | ≤22 ms preferred, and never >1.25 × baseline p95 |
| Overview/long journey | Existing B2 p95 and replacement resource limits still pass |
| Far style metadata | ≤2 MiB uncompressed all-city far |
| Peak replacement unique resources | Existing B2 ceiling, including transfer/upload/caches |
| Full/far cycles 1–5 | Returned resources ≤1.10 × warmed reference, no monotonic trend |

- [ ] **Step 3: If over budget, reduce true optional cost only**

Instrument triangles/bytes per detail kind in facade modules, roof module bay-count and ambient roof details. Remove invisible coincident surfaces, cap internal hidden projections and over-sampled roof returns, keep defining silhouette/facade pattern. Do not remove features from the complete-city manifest, switch source roofs to flat, or silently restore simpler wrong massing to improve numbers. Preserve copying to merged geometry—don't introduce draw calls just to reduce buffers.

- [ ] **Step 4: Re-verify failed-case visuals and commit gate results**

Before/after cost reduction images are compared at the same case settings. Gate output explicitly identifies the named visual row as pass/fail and any decreased details/metrics. No averaging of successful neighborhoods can hide a failing one.

---

### Task 9: Make the application full-city-only and safely hostable below a project path

**Files:**
- Create: `src/shared/assets.ts`
- Modify: `src/shared/config.ts`, `src/shared/museum.ts`, `src/app/App.tsx`, `src/engine/createCityApp.ts`, `src/engine/tiles/tileWorker.ts`, `src/engine/museum/museumLayer.ts`, `src/engine/tiles/tileWorkerPool.ts`, `vite.config.ts`, `tests/unit/config_sync.test.ts`
- Update dataset-selection/URL tests in `tests/e2e/city.spec.ts` and `museum.spec.ts`

- [ ] **Step 1: Write failing resolver tests**

```ts
it('always serves the complete city, including legacy links', () => {
  for (const search of ['', '?dataset=city', '?dataset=central', '?dataset=potato']) {
    expect(resolveDatasetName(search)).toBe('city');
    expect(resolveDataBaseUrl(search)).toBe('./data/city-tiles');
    expect(resolveManifestUrl(search)).toBe('./data/city-tiles/manifest.json');
    expect(resolveTileUrl('tiles/-11_-9.json', search)).toBe('./data/city-tiles/-11_-9.json');
  }
});
```

This blocks direct pilot links at application level, not only hide a UI selector. The `central` identifier can remain only as an internal test fixture tag; remove its public dataset union and conditional UI labels. Main initial view fits complete-city bounds; no central initial camera fallback can hide missing outer tiles.

- [ ] **Step 2: Implement one asset root for all fetches**

```ts
// src/shared/assets.ts
export function publicAssetUrl(path: string): string {
  export function publicAssetUrl(path: string, configuredBase = import.meta.env.BASE_URL): string {
  const base = configuredBase === '/' ? './' : configuredBase.endsWith('/') ? configuredBase : `${configuredBase}/`;
  return `${base}${path.replace(/^\/+/, '')}`;
}
}
```

`vite.config.ts` uses `base: './'`. Configure endpoints through `publicAssetUrl('data/city-tiles')` and `publicAssetUrl('data/museum')`; remove overrides back to `'/data/tiles'` and root-based museum URL. Test custom Vite `BASE_URL = '/VoxelMinsk/'` as another test invocation because string escapes `^/+` are not equivalent to independently rewritten host URLs. Correct URLs carry URL query only; worker `new URL()`/module-worker construction preserves the correct application parent and environment.

- [ ] **Step 3: Simplify full-city-only runtime and UI behavior**

Resolve `city` regardless of dataset query, retain existing `?focus=lipki` direct museum link as same-document interaction, and make subtitle/loading/status messages say whole city directly. Delete branches that reload `?dataset=city` or show `central district`. `DatasetName` equals `city`, streaming and fitted bounds drive from one manifest defined by the public resolver. Keep `?nolimit=1`, `?budget=…` from QA hidden debug only; deployment tests must not rely on them to pretend necessary full tiles resident.

- [ ] **Step 4: Prove paths below an unrelated project prefix**

Set local e2e server path base `/VoxelMinsk/`; check index, manifest, first tile, one of the palace/stadium tiles, museum manifest/exhibit binary, loadable worker and every captured network response returns 2xx or documented cache success. Assert `resolveDataBaseUrl('?dataset=central')` is full-city and actual panel reports exactly the payload's complete-city counts. Record response bytes and failed request list; no root `/data/tiles/manifest.json` calls.

- [ ] **Step 5: Run browser suite and commit**

```powershell
pnpm run typecheck
pnpm exec vitest run tests/unit/config_sync.test.ts
pnpm run test:e2e
git add src/shared src/app src/engine vite.config.ts tests package.json
git commit -m "feat: serve complete city from project-relative assets"
```

Review the diff before this broad command: only staging intended public-path tests/files, never unrelated local work.

---

### Task 10: Enforce publication licensing, provenance and artifact content

**Files:**
- Create: `public/.nojekyll`, `public/data/LICENSE-ODbL.txt`, `public/data/ATTRIBUTION.md`, `public/asset-licenses.json`, `LICENSE` when owner selects one
- Create: `scripts/qa/build-pages.mjs`, `scripts/qa/publication-audit.mjs`, `tests/unit/publication.test.ts`, `tests/e2e/publication.spec.ts`
- Modify: `scripts/qa/museum_licenses.py` only if its report omits upstream model/texture sources or redistribution rights
- Modify: `package.json`, `README.md`, `public/asset-licenses.json` after verification

- [ ] **Step 1: Inspect licenses before choosing or changing them**

```powershell
.venv\Scripts\python.exe scripts/qa/museum_licenses.py
```

Follow project read conventions for text files. Inspect the actual museum manifest/exhibit provenance and `assets/aviation-museum` licensing files, not only adapter source comments. List code, OSM-derived database, authored geometry, curated models, textures, fonts and any remote linked sources separately. Do not infer public permission from a file being local, a download URL, or a credit alone.

- [ ] **Step 2: Write failing artifact tests first**

```ts
it('contains one complete city and no alternate/reduced dataset', () => {
  const manifest = artifactManifest();
  expect(manifest.directories).toContain('data/city-tiles');
  expect(manifest.directories).not.toContain('data/tiles');
  expect(manifest.directories).not.toContain('data/city-tiles-current');
  expect(manifest.directories).not.toContain('data/city-tiles-b2');
  expect(manifest.totalBytes).toBeLessThan(900_000_000);
  expect(manifest.warningThresholdBytes).toBe(500 * 2 ** 20);
  expect(manifest.fatalError).toBe(manifest.totalBytes >= 900_000_000);
});
```

The 500 MiB threshold produces a warning only; the fatal artifact error is at `900_000_000 bytes`. The test checks warning/fatal classification, not a mandatory cut at 500 MiB. Do not delete city tiles to satisfy either threshold.

Additional failing assertions: each manifest tile file exists with exact byte count; published manifest equals validated candidate, tile addresses match accepted source; no OSM pbf/raw/interim/worktree/backups; code/trace secrets excluded; OSM notice linked and present; all third-party assets have `license`, `source`, `redistribution` true, `modified`, and `attribution` as applicable. An owner-selected source `LICENSE` is required before calling the repository open source.

- [ ] **Step 3: Add a deterministic whitelist assembler**

```js
// build-pages.mjs arguments: --dist dist --site .pages --city-dir public/data/city-tiles
// Validate resolved absolute inputs and repo before copying using approved node paths.
// Copy dist index/assets/etc excluding public data; then only these additions:
await cp(cityDirectory, join(siteRoot, 'data/city-tiles'), { recursive: true });
await cp(repoRoot('public/data/museum'), join(siteRoot, 'data/museum'), { recursive: true });
for (const name of ['.nojekyll', 'asset-licenses.json']) await copyFile(repoRoot(`public/${name}`), join(siteRoot, name));
await cp(repoRoot('public/data/ATTRIBUTION.md'), join(siteRoot, 'data/ATTRIBUTION.md'));
await cp(repoRoot('public/data/LICENSE-ODbL.txt'), join(siteRoot, 'data/LICENSE-ODbL.txt'));
```

Instead of deleting accidentally copied pilot/staging files, exclude them on input assembly; copying must never overwrite a live dataset. Generate `site-manifest.json` of path-sorted file names, sizes and SHA-256 digests after copying, including commit SHA and source city manifest hash. Fail if artifact contains `public/data/tiles`, other city directories, or files below human-training/cloud credentials. Scan repository tracked files for accidental token/history/private key/private config patterns where appropriate; do not hide a discovered secret by simply adding an ignore entry.

- [ ] **Step 4: Use license audit as an explicit release gate**

If an asset is proprietary or lacks redistribution right, stop and get owner permission/replacement instructions. Do **not** unobtrusively drop museum exhibits or change their license. `README.md` identifies whether repository is source-available (no license chosen) or open source under owner-selected license; preserve existing OSM attribution visible in the UI and offer the ODbL notice with derived tile download.

- [ ] **Step 5: Serve exact artifact at a project-prefixed path and rerun e2e**

`publication-audit.mjs --site .pages` first checks contents, then starts `pnpm preview` configured below `/VoxelMinsk/` (or serves the static manifest with equivalent nested-path middleware that preserves MIME types), verifies no `/data/tiles` or central paths, and exercises first view, all far/full absent-detection, museum selection, night, attribution and detailed view. No use of Vite dev-only fallback header override to disguise broken production paths.

- [ ] **Step 6: Commit the accepted artifact manifest, not screenshots or `.pages/`**

`publication-report.json` has committable compact results (counts, bytes, hashes, requested routes/statuses, legal audit status) and git SHA. `.pages/` stays ignored.

---

### Task 11: Add guarded GitHub Actions → GitHub Pages publication

**Files:**
- Create: `.github/workflows/pages.yml`, `scripts/qa/report-action-shas.mjs` if pin automation is chosen
- Modify: `pnpm-workspace.yaml` only if current pnpm configuration doesn't reproduce `pnpm install --frozen-lockfile`, `README.md`
- Generate: `.pages/` locally/CI artifact only

- [ ] **Step 1: Add test/validate job with deterministic installation**

```yaml
name: Complete city
on:
  push:
    branches: [main]
  pull_request:
  workflow_dispatch:
permissions:
  contents: read
concurrency:
  group: pages
  cancel-in-progress: false
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 10.32.1
      - uses: actions/setup-node@v6
        with:
          node-version: 24
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm run typecheck
      - run: pnpm test
      - run: python -m unittest discover -s scripts/normalize/tests -p "test_*.py" -v
```

Add stack-compatible Python dependency installation for geospatial tests (`python -m venv .venv`, `.venv/bin/pip install -r scripts/requirements.txt`, then use `.venv/bin/python`) and caching as supported. Require all committed full-city tile files and validated style/publication reports; do not run six-minute OSM normalization during every website deploy unless the chosen repo stores all accepted tile output under version control. Full publication only needs static verified candidate. `actions/deploy-pages@v5` is current upstream example; confirm each action release before committing and prefer commit SHAs recorded alongside upstream versions for security, not mutable refs without a resolved version note.

- [ ] **Step 2: Add artifact gate and deploy job**

```yaml
      - run: pnpm run build
      - run: node scripts/qa/build-pages.mjs --dist dist --site .pages --city-dir public/data/city-tiles
      - run: node scripts/qa/publication-audit.mjs --site .pages --static-only
      - run: node scripts/qa/building-gallery-capture.mjs --ci
```

Separate hardware-independent browser captures with explicit installed Playwright browser `pnpm exec playwright install chromium`; verify software WebGL readiness and exact screenshots, not hardware FPS. The main production URL is tested at project prefix when using `vite preview --base /VoxelMinsk/`; set the output base via validated `BASE_URL` supported by `vite.config.ts`, not a manually rewritten script tag. `outputs` on the verify job records only summary counts/build hash, not huge artifacts or secret values.

```yaml
  deploy:
    if: github.ref == 'refs/heads/main' && github.event_name != 'pull_request'
    needs: verify
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pages: write
      id-token: write
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - uses: actions/configure-pages@v5
      - uses: actions/upload-pages-artifact@v3
        with:
          path: .pages
      - id: deployment
        uses: actions/deploy-pages@v5
```

End the verify job with this explicit artifact handoff and start the deploy job with its two required setup steps before the upload step:

```yaml
      - uses: actions/upload-artifact@v4
        with:
          name: city-site-${{ github.sha }}
          path: .pages
          if-no-files-found: error
          retention-days: 3
# in deploy.steps, before actions/upload-pages-artifact:
      - uses: actions/checkout@v4
      - uses: actions/download-artifact@v4
        with:
          name: city-site-${{ github.sha }}
          path: .pages
```

Then run `configure-pages`, `upload-pages-artifact`, and `deploy-pages`. A runner's local `.pages` never crosses job boundaries. Keep the manifest hash exact on both jobs and test workflow syntax/version compatibility before merge.

- [ ] **Step 3: Configure the safe public repository and Pages**

Owner creates repository on GitHub website (`gh` CLI is not installed locally), provides owner/repository, selects GitHub Actions as Pages source, and retains public OSM/model licenses. Do not expose existing local git credentials in logs. Add remote with the owner-provisioned URL, push feature branch, inspect workflow, then use an ordinary reviewed merge into `main`. Do not force push old/canonical history.

- [ ] **Step 4: Verify actual release and artifact**

Inspect `actions/upload-pages-artifact` size/duration and `deploy-pages` 10-minute status, request homepage/arboreal tile/museum binary with `curl.exe -I`, check headers/404 fall-through, and test all far addresses from a browser network request audit. A HTTP 200 on an HTML 404 fallback is not a valid tile: compare exact JSON fields/tile bytes. `pages.yml` uses deploy job pass as success; owner opens `steps.deployment.outputs.page_url`.

- [ ] **Step 5: Keep the complete-city rollback release-safe**

Record release tag and source/build manifest SHA. If release fails after deployment, revert release commit while keeping whole-city scope; do not restore `src/shared/config.ts` central fallback or publish old `public/data/tiles`. Any public-data format change increments payload version following the compatibility policy and includes regeneration commands.

---

### Task 12: Final regression, documentation and L4 handoff

**Files:**
- Modify: `README.md`, `docs/ARCHITECTURE.md`, `docs/LIMITATIONS.md`, `docs/DATA_SOURCES.md`, `docs/PROGRESS.md`
- Create: `docs/building-quality/LIVE_REVIEW.md`, `HANDOFF.json`
- Modify: `package.json`, `.gitignore`
- Check: entire final diff and `git diff --cached --stat`

- [ ] **Step 1: Document actual architecture and heuristic limits**

Update data contracts to explain 27 recipe visual families inside 11 broad archetypes, profile/source volume exchange, far-tile coverage, bit packing and `legacy_default` behavior. Document exact full-city observed data and separate baseline/report dates. The old `12 × 12 km / 144 tile / 31,000 buildings / 400 max resident` comments belong only where they label historical evidence, not in current runtime instructions.

Document that start date/heights/district classification are heuristics, roof profile and decor is approximate, and which explicit OSM tags are honored. Keep museum permissions/attribution and the derived tile ODbL terms with actual release files.

- [ ] **Step 2: Final all-suite verification**

Run and collect verbatim outputs:

```powershell
pnpm run typecheck
pnpm run build
pnpm test
pnpm run test:data
pnpm run test:e2e
node scripts/qa/building-gallery-capture.mjs
node scripts/qa/building-review-capture.mjs --mode candidate --cases docs/building-quality/review-cases.json
$env:QA_GPU='1'; node scripts/qa/building-runtime-audit.mjs --journey
.venv\Scripts\python.exe scripts/qa/b2_staging_audit.py --tiles-dir public/data/city-tiles --coverage data/processed/coverage_city.json
node scripts/qa/publication-audit.mjs --site .pages
```

`public/data/city-tiles` is promoted only after complete source hashes/accepted physical-dir file moves are reviewed, with no change-stage copies remaining tracked. No direct destructive `rm -rf`, `Move-Item` or archive overwrite: validate absolute targets, compare source/dest hashes, preserve original B2 artifact, then use only intended declared paths. Ensure merged B2 data staging/provenance is retained.

Before this step, the B2 source/artifact must still be served from its frozen staging directory; never call the old 144-tile `city-tiles` baseline a pre-build. For release, `.gitignore` no longer ignores the accepted `public/data/city-tiles` release payload; add `.pages/` and `data/staging/`, retain raw/interim exclusions and all original candidate/current duplicates outside artifact version control. Stage the accepted full-city files explicitly and verify every manifest byte count and file SHA before CI. The GitHub default branch must actually contain the complete accepted city; a local ignored 282 MiB candidate cannot satisfy the deployment workflow.

Add focused scripts such as `qa:buildings:gallery`, `qa:buildings:audit`, `qa:buildings:runtime`, `site:build` and `site:audit` to package.json. `git status` must not contain unrelated user work from elsewhere merged into this release.

- [ ] **Step 3: Validate L4 from a fresh anonymous browser context**

Public project URL—not localhost and not the DSH GUI—is opened in a fresh/privacy browser on a real deployed host. Check all-city opening, neighborhoods, four edges, night shader, metadata picking, museum selection/model, attribution/license, no central mode, no unexpected failed network responses or hidden geometry errors. Save evidence URL/run/artifact hash, commit SHA and five-level review status for owner.

- [ ] **Step 4: Finalize every gate explicitly with reviewer-only honest statuses**

`HANDOFF.json` has `L0`–`L4`, `gitSha`, `sourceManifestSha256`, `artifactSha256`, `pagesUrl`, `workflowRunUrl`, real measurements and reviewer decisions. Owner must sign L1/L2/L4 manually; automatic counters/checks provide evidence but not visual approval.

- [ ] **Step 5: Commit and present the delivery plan outcome honestly**

```powershell
git add README.md docs/ARCHITECTURE.md docs/LIMITATIONS.md docs/DATA_SOURCES.md docs/PROGRESS.md docs/building-quality package.json .gitignore
# Verify staged paths before committing; do not include datasets that are not accepted.
git diff --cached --stat
git commit -m "docs: verify complete-city architecture and free publication"
git status --short
```

Do not blindly `git add src shared`; only actual intended tracked paths. Preserve a separate tag/commit for exact source tile payload. Summarize delivered work, verified numerical results, any local/remote limitations, exact L0–L4 status and source/derived-data licenses. Mark no gate completed solely because a workflow was added. Use the finishing-development-branch workflow after tests and owner acceptance, never before.

## Execution handoff

Choose implementation mode before starting Task 0:

1. **Subagent-driven (recommended):** each task is a fresh subagent implementation, with independent spec-compliance and quality/code review between tasks; architecture/LOD and road stabilization modifications remain protected from unrelated agents.
2. **Inline execution:** follow this plan sequentially with explicit same-task checks, screenshots and owner review gates.

Essential owner inputs at release time: repository owner/name, permission to create and push to GitHub, source-code license choice (or explicit source-available wording), and verified asset redistribution rights. None may be inferred from a public hosting request alone.
