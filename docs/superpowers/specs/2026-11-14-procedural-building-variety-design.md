# Complete-city procedural architecture and free publication — technical design

**Date:** 2026-11-14  
**Decision:** approved direction — coherent style recipes with modular geometry, maximum variety with a measured performance increase.  
**Publication decision:** the public application exposes **only the complete expanded city**. There is no central-district selector, reduced public extent, or reduced-city fallback.  
**Audience:** the developer agent implementing this design; the project owner reviewing L0–L4 acceptance evidence.

## 1. Goal and non-goals

Replace the visual monotony of generic wall extrusion plus one window lattice with an extensible library of architecturally coherent building families. Preserve the real OSM geometry and the single static payload model, and publish the complete city on GitHub Pages free of paid hosting.

### In scope

- Offline style selection for every eligible existing building, deterministic across tile boundaries and repeated runs.
- Shared grammar for massing, facade modules, roofs, palettes, and style-specific window patterns.
- At least 27 useful recipes represented in a repeatable synthetic gallery; at least 24 recipes used in the accepted full city whenever sufficient eligible source buildings exist.
- Meaningful differences at close and neighborhood scales, not merely a larger palette.
- Existing per-tile merged geometry, per-triangle picking, day/night materials, and backward-compatible handling of old tile data.
- Full/far representations of the **same territory and building inventory**. Detail can change with zoom; required buildings and their principal massing cannot disappear.
- Canonical screenshot and performance evidence, a reproducible static build, and GitHub Pages deployment.
- A full repository publication audit: credentials, licenses, third-party models/textures, OSM attribution, payload size, and public URLs.

### Non-goals

- No city-wide substitute for surveyed LoD2/LoD3 architecture, no fictional building placement, and no generic church domes or landmark crowns inferred without evidence.
- No shortening the public extent to the previous 12 × 12 km dataset or to the central pilot. The source fixture used for geometry unit tests is not a public map mode.
- No new curated landmark campaign except preventing regressions in the five existing curated landmarks, palace accents, stadiums, ferris wheels, and Lipki museum.
- No paid APIs backend, live OSM requests, binary conversion project, terrain project, or unrelated road/tree redesign.
- No guarantee of phone performance. The existing desktop hardware baseline is the measured target.

## 2. Current implementation and unresolved dependency

The offline classifier in `scripts/normalize/normalize.py` selects one of 11 broad archetypes. `BuildingFeature.volumes` comes from real footprints and explicit `building:part` regions where present. Most generic buildings pass through `addVolumeWalls` and `addRoof` in `src/city/buildings/buildingsMesh.ts`; palace accents, stadium bowls, and curated landmarks are exceptions.

The presets in `src/city/facades/presets.ts` alter floor height, window proportions, colors, and flags. Balconies, pilasters, cornices, rustication, and shopfronts are mostly shader treatments. Ordinary buildings therefore share similar silhouettes and structural depth. At the close-neighborhood scale this reads as repeated slabs.

Baseline cameras and test support already exist:

- `scripts/qa/capture.mjs` supports a fixed viewport and waiting for meaningful renderer readiness.
- `CityAppHandle.focusOnLocal` and `setCameraSettings` can lock positions and projection.
- `window.__CITY_APP__` exposes archetype samples and dataset/streaming information through the QA object in `createCityApp.ts`.
- `tests/fixtures/buildings.ts` has concave, courtyard, multi-volume, roof, and synthetic-tile fixtures.

### B2 gate before public promotion

The present candidate, `public/data/city-tiles-b2/manifest.json`, has 437 tiles, 76,004 source buildings, 1,910,624 tree instances, and 295,295,334 bytes in tile payloads. Its bounds are `[-11264, -9216, 12288, 10240]`. This is the **baseline observed during design, not a permanent replacement for manifest-driven QA**.

Do not hardcode the older 144-tile or 400-resident-tile assumptions. The existing streamer can limit detailed residency and expose a base plate for missing geometry. The staged full/far solution in `docs/B2/RUNTIME_REVIEW_2026-11-10.md` must therefore be complete before public full-city acceptance. Raising a detailed tile cap while leaving 37 candidate tiles on a ground plate is not a compliant deliverable.

## 3. Architectural boundaries

```text
Frozen OSM input + explicit parts + area contract
                  |
                  v
      Existing geometry normalization
                  |
      retain sourceVolume provenance
                  |
                  v
         StyleSelector (offline only)
       evidence -> eligibility -> stable hash
                  |
                  v
     versioned StyleRecipe + palette + seed
                  |
      +-----------+------------+
      |                        |
      v                        v
Near geometry + material    Far presentation:
real source volumes,         all source footprints,
declared style profile,      principal source/style profile,
modular details              colors and averaged facades
      |                        |
      +-----------+------------+
                  |
         full/far transition rule
       never both in same tile region
                  |
             renderer / QA
```

Responsibilities:

| Module | Owns | Must not own |
| --- | --- | --- |
| Offline style selector | Eligibility, deterministic variant choice, provenance | Camera state or scene objects |
| Recipe catalog | Names, eligibility limits, module parameters, facade parameters, supported LOD | Per-instance random decisions |
| Geometry adapters | Modular projection/crown/roof functions and metric UVs | OSM reclassification or current time |
| Facade runtime | Shared attributes, materials, style-dependent rhythm, night pattern | Unbounded allocations per building per frame |
| Full/far streamer | Geometry readiness, tile coverage, replacement exclusivity | Dropping mapped objects for performance |
| QA/evidence tools | Locked captures, indexes, measured budgets, human-review checklist | Declaring success without captures/measurement output |

A style is not a list of mutually independent random decorations. The recipe jointly chooses facade family, treatment of the ground and crown, balcony/window rhythm, roof-compatible components, and a small coordinated palette family. Only minor variation uses a per-building hash.

## 4. Public payload and attribute contract

Extend `BuildingFeature` without changing existing fields:

```ts
export type BuildingStyleSource = 'osm_hint' | 'heuristic' | 'legacy_default';

export interface BuildingStyleVariant {
  /** Version of the selection rules; change only with a reviewed migration. */
  schema: 1;
  /** Stable id in the shared StyleRecipeMap. */
  recipeId: number;
  /** osm_hint when a direct type/material/roof/date tag constrained the choice. */
  source: BuildingStyleSource;
  /** Keep for audit; not an assertion of measured construction era/material. */
  eligibility: string[];
}

// On BuildingFeature:
styleVariant?: BuildingStyleVariant;
```

An integer ID avoids repeating long style names in 76,004 records. Retain `archetype`, `height`, all volume positions, and all tags. Do not add a second enum that forces the shader's broad archetype IDs to change for every new recipe.

If style-dependent roof/crown profiles split walls or adjust the eave below the original top, retain for QA:

```ts
sourceVolumes?: BuildingVolume[];
```

`sourceVolumes` records input volumes; `volumes` becomes the rendered profile. Omit `sourceVolumes` when identical, making old data and unmodified features byte-compatible apart from the explicit style record.

### Registry and extension convention

- `src/shared/buildingStyles.ts` defines recipe IDs, the `StyleRecipe` interface, and an immutable lookup. Python's selector imports no TypeScript; `scripts/normalize/style_recipes.py` mirrors it.
- `src/shared/geometry.ts` packs `aFace.y` as `flags | (recipeId << 8)`, with recipe IDs `0..255` for schema 1. Bits 0–7 retain the current `STYLE_FLAG` values; the renderer masks them before calling `facadeFlag`.
- `aStyle` remains exactly four floats. No new per-vertex style attribute is needed. No >24-bit packed style integer is permitted, so float32 keeps exact integers.
- Existing roof semantics of `aFace.w` do not change. Details choose `FACE_KIND.wall`, `ground`, `glass`, `roof`, `roofRidge`, or `trim`; `Face` kind remains the material discriminator.
- `BuildingStyle` carries the resolved recipe. `styleForBuilding` optionally returns geometry modules and resolved palette in addition to its current vectors and flags.
- Old fixtures/tiles with no `styleVariant` receive a versioned `legacy_default_<archetype>` mapping reproducing the exact prior preset. Reserve runtime/payload IDs `27..37` for those 11 legacy archetype presets; family recipe IDs remain `0..26`. This prevents legacy `palace`/`stadium` from colliding with modern-family IDs. Special protected routes serialize their appropriate `27 + ARCHETYPE_ID[archetype]` default ID; unknown/mismatched IDs warn once per worker and route to the same default, never a missing building or out-of-range shader index.
- Facade preset uniform arrays contain **38 entries** (27 families + 11 legacy presets), indexed by packed recipe ID, while broad archetype semantics still use the original 11 archetype IDs. The shader masks flags, clamps the recipe index to `0..37`, and is compiled/checked on the supported WebGL2 renderer.
- Raise the tile payload minor version and record `styleSchema: 1`, `sourceDatasetId`, and style run ID in the manifest. Runtime parsing accepts the previous tile payload for unit fixtures. Deployment publishes only a single reviewed dataset version.

The Python recipe mirror, TypeScript registry, and serialized IDs are unit tested against one canonical JSON contract, not manually synchronized by convention.

## 5. Catalog: 27 recipes and eligibility

The catalog below identifies a **visual family**, not surveyed historic attribution. Explicit tags override heuristics only when the tag actually addresses the characteristic. Height and floor count alone cannot “prove” an era or construction material.

| ID | Broad archetype | Style family | Distinguishing treatment |
| --- | --- | --- | --- |
| 0 | `stalin` | `ensemble_symmetric` | Organized pilaster bays, strong cornice, formal entrance/ground band |
| 1 | `stalin` | `end_pavilion` | Projecting end bays and restrained crown, source-height bounded |
| 2 | `stalin` | `restrained_monument` | Broad plaster piers, less ornament, tighter regular openings |
| 3 | `khrushchev` | `brick_punched` | Narrow punched windows, short lintels, sparse small balconies |
| 4 | `khrushchev` | `balcony_slab` | Alternating balcony stacks, quiet cornice, end-wall entrance band |
| 5 | `khrushchev` | `pitched_low_block` | Hipped/main roof and low attic treatment where source eligibility allows |
| 6 | `panel` | `recessed_loggia` | Repeated dark loggia strips and balcony rails, readable floor slab rhythm |
| 7 | `panel` | `endwall_tower` | Windowless end-wall zones, small stairwell openings, joint grid |
| 8 | `panel` | `staircore_spine` | Vertical glazed core against subdued panel bands, flat crown |
| 9 | `modern` | `podium_tower` | Existing multi-volume podium/tower emphasis; never invent an unbounded tower |
| 10 | `modern` | `stepped_residential` | Bounded stepped-wall/crown profile, terrace parapets, grouped balcony bays |
| 11 | `modern` | `framed_residential` | Vertical frame strips, inset/loggia glazing and panel-clad portions |
| 12 | `office` | `curtain_ribbon` | Continuous ribbon glazing, regular narrow mullions, opaque spandrels |
| 13 | `office` | `framed_stone_grid` | Solid vertical/horizontal grid around dark glazing, heavier base |
| 14 | `office` | `commercial_podium` | Entrance canopy, storefront ribbon, restrained signage-free fascia |
| 15 | `historic` | `plaster_street_house` | Narrow bays, rusticated base, cornice, compatible gabled/hipped roof |
| 16 | `historic` | `brick_gabled_house` | Warm masonry palette, taller windows, restrained gable treatment |
| 17 | `historic` | `mansard_attic` | Compact gambrel/mansard envelope only on eligible low-rise footprints |
| 18 | `industrial` | `sawtooth_factory` | Repeating roof ridges/clerestories on sufficiently long, tall halls |
| 19 | `industrial` | `broad_clerestory_hall` | Large blank wall areas, upper glazing, expansive compatible roof |
| 20 | `industrial` | `service_workshop` | Low doors, utility parapet, small attached-looking annex treatment in bounds |
| 21 | `small` | `hipped_house` | Domestic proportions, hip roof, modest eaves; detached-house tags preferred |
| 22 | `small` | `flat_service_annex` | Quiet walls, blank garage/service panels, low flat/parapet cap |
| 23 | `small` | `gabled_workshop` | Modest gabled roof, utility doors, no scaled-down apartment facade |
| 24 | `civic` | `school_hospital_wings` | Regular teaching/ward bays, entrance canopy, differentiated connecting wing |
| 25 | `civic` | `public_colonnade` | Ordered vertical bays/piers and formal entrance, not a generic dome |
| 26 | `civic` | `assembly_hall` | Higher blank wall mass with sparse high glazing, compatible top profile |

`palace` and `stadium` remain dedicated archetypes; curated landmark routes still replace generic geometry. All 27 families apply only after structural and tag-based eligibility.

### Structural eligibility examples

- `sawtooth_factory`: single flat-roofed industrial volume, oriented minimum-area rectangle at least 15 m wide, height at least 6 m, no courtyard, 3–6 roof bays maximum, no declared incompatible `roof:shape`.
- `mansard_attic`: historic, height at most 14 m, footprint area at most 900 m², minimum side at least 5 m, no explicit incompatible roof or elevated part.
- `podium_tower`: modern, multi-volume evidence already present; rendering never adds a tower above `height + 0.05 m`.
- `brick_punched`: `khrushchev`; explicit `building:material=brick` is an `osm_hint`, otherwise the family is marked `heuristic` in selection provenance.
- `flat_service_annex`: explicit service/garage/utility tags preferred; never automatically convert a tagged detached home to a garage.
- `end_pavilion` and stepped profiles: only convex or concave ring geometries supported by the profile adapter. Unsupported complex courtyards retain the base profile and use a facade-only recipe.
- A declared `roof:shape` stays authoritative; only compatible embellishments are allowed. A complex fallback must not silently become a gable, mansard, hip, or sawtooth.

### Information budget

Only mapped `amenity`, `building`, `building:material`, `building:levels`, `start_date`, `roof:*`, footprint shape, and documented district context influence choice. The selector must not inspect rendered color, unrelated building IDs, current process state, or random seeds. Selection input is stable for a stable feature.

## 6. Modular geometry and facade design

### Massing profile adapter

The profile adapter consumes allowed `BuildingVolume` values and emits planar, capped wall volumes:

```ts
export interface GeometryBuildContext {
  readonly recipe: StyleRecipe;
  readonly detailLevel: 'far' | 'near';
  readonly seed: number;
}

export function profileVolumes(
  building: BuildingFeature,
  context: GeometryBuildContext,
): BuildingVolume[];
```

It never translates footprint centres, changes source metadata, raises a wall above a tagged total height, or replaces curated volumes. Crown variation is produced by lowering eligible wall segments while preserving the declared maximum at an end/spine or existing explicit part. Interpolated seams are capped; no detached “architectural decorations” are placed in roads or courtyards.

### Reusable detail modules

A small number of reusable functions delivers variety without one file per building:

- `addFacadeFrame`: finite projecting piers, spandrel bands, plinths, cornices and parapets using outward-oriented ring normals.
- `addBalconyStack`: floor-aligned slabs and opaque/glazed rail faces, in eligible bays only; open rail elements simplified to a lit band at distance.
- `addEntranceTreatment`: canopy and formal entrance/pilasters at the longest valid street-facing edge; no invented text.
- `addRoofService`: small vents/housings on sufficiently large flat roofs, with bounded count and no conflicts with explicit parts or roof edges.
- `addMansardEnvelope`: lower steep slope + upper shallow cap; exact ridge direction and gable closures, min dimensions enforced.
- `addIndustrialRoof`: sawtooth or clerestory cap on a correctly oriented min-area rectangle, footprint clipped if needed.

All return geometry into the same `MeshSink`; all produce explicit normals, finite coordinates, complete cap normals, metric UVs, and `triangleOwner`. There is no draw call per balcony, window, door, or building. A geometry module must not call `computeVertexNormals()`.

### Facade grammar

The existing shader continues global screen-space LOD, daytime/night lighting, view-time/palette handling and albedo/emissive integration. It retrieves recipe-compatible window grouping, vertical accent mapping, balcony pattern and blank-wall regions. `facadeUpperFloors` uses the masked base-flags plus recipe-specific preset rows; it does not assume palette variation means architectural variation.

- Loggias are ordered deep-dark glazing bands bounded by slab/rail geometry, not arbitrary dark rectangles.
- Stair cores span continuous storeys where physical upper-storey floor alignment is available.
- Blank industrial/end-wall areas have an intentional bounded zone; the rest of the facade must retain its appropriate openings.
- Pilasters and cornice geometry align with `aUV` origins and the same story metrics as painted windows. Elevated parts still receive no ground-floor band.
- Ground patterns use real metres above a ground-volume base. There is no plinth or lobby on a volume ten metres in the air.
- Facade accents must not erase all windows or turn every building into glass.

Every module has a safe skip condition. On an ineligible volume it returns no details while keeping the mandatory base wall and roof. On an invalid recipe it falls back to the previous unmodified profile rather than emitting NaNs or omitting the building.

## 7. Determinism, authenticity and fallback rules

1. Stable choice is `blake2b("<featureId>|style-schema-1", digest_size=8)`, combined with eligible weights that sum to exactly 1. The existing height seed is not changed.
2. Completing one tile or changing an unrelated building cannot change another building's recipe or palette.
3. Explicit part topology and a tagged roof always dominate heuristic selection.
4. Report a recipe as heuristic visually and in QA metadata where appropriate; do not present architecture estimates as surveyed architectural fact in the info panel.
5. Never silently discard a volume to make a module succeed. Degenerate normalization data follows the existing warnings/error policy; the coverage audit compares mandatory base geometry independently of optional trim.
6. A module validation failure emits a warning including feature ID and module, removes only that module, and either retains a correct generic base or fails the staging audit if a mandatory volume is broken.
7. The same input directory and manifest version yields byte-identical generated tiles except for deliberately recorded metadata excluded from the existing stable-manifest hash.

## 8. Detail levels and “no cuts” invariant

`far` and `near` are render levels, **not different geographic products**.

For each tile in the accepted manifest:

- The same set of required feature IDs exists in the complete dataset.
- Every source footprint contributes to at least one required base-massing polygon in both representations.
- Tagged footprint positions and dimensions are unchanged within 0.005 m; any approved style-derived wall profile is reflected correctly in far, not just near.
- Source total height can decrease only when an explicitly selected crown/step profile redistributes mass within the approved original envelope; documented tolerance is 0.05 m at the preserved maximum. No overall tower/roof addition exceeds the original maximum.
- Principal roof form and silhouette are retained at far; shallow rails, mullions, service boxes and window frames may be averaged or omitted. A distant building must not become an unrelated generic box.
- No source height, levels, roof, or building tags are rewritten to pretend a heuristic variant was observed.
- Transitions maintain a per-tile representation state: `far`, `full`, or `switching` with only one visible representation. Transfers must not render both opaque buildings in the same tile.
- A tile is capture-ready only when the required representation for its camera distance is visible and no stale base plate covers its mandatory geometry.
- No tree counts, geographic extents, landmarks, road layers, or museum artifacts are traded away for building detail.

Records in QA explicitly distinguish mandatory base mass from optional detail. Comparing triangle totals alone can never prove completeness.

## 9. Performance decision and budgets

Benchmark the same revision pair, camera route, viewport, renderer, GPU, pixel-art setup and viewport after a warm-up. Record cold/warm loads separately. SwiftShader is used for correctness and visual checks, not for a hardware frame-rate claim.

Reference environment: the existing Windows machine / RTX 3080 Laptop / ANGLE D3D11, 1600×900 external viewport, internal 640×360 baseline unless a deliberately locked test overrides it. Record actual `renderWidth` and `renderHeight`; do not infer them from UI screenshot size.

### Hard stop limits

- Near-building triangle count and resident building-buffer bytes: **≤120% of the corresponding measured baseline**, measured separately from trees and multipass rendering.
- The far representation remains within the B2 accepted triangle/memory/draw budgets. New style metadata in far consumes at most **2 MiB uncompressed across the complete far payload**.
- Scene draw calls do not increase per detail module. For near scenes, at most a **2% increase over accepted-B2 draw calls** is allowed, and all existing B2 visible/full/far/pass limits still apply.
- Near full-district p95 frame time is preferably ≤22 ms; after warm-up, any accepted comparative regression is capped at **125% of baseline p95**. For overview and LOD journeys, the B2 p95 and absolute memory ceilings are not relaxed.
- Transition unique-peak accounted resources remain within the documented B2 replacement cap. Indexed geometry, textures, CPU tile caches, transfer arrays and upload-in-flight copies are listed separately; existing `geometryMB` is not mislabeled total GPU use.
- Built Pages artifact must be **≤900,000,000 bytes**, retaining at least 100,000,000 bytes headroom below the 1 GB rule. The same test is stricter than a 1 GiB limit and does not justify cutting city data. The workflow times out at **10 minutes**. Track actual uncompressed bytes, transfer bytes where observable, and object counts because JSON shrinkage is not resident-memory shrinkage.

If a geometry family exceeds the limit, first reduce invisible coplanar faces, subdivisions, repeated rail segments and roof equipment density. Do not simplify below the recipe's defining silhouette or delete mapped objects. Re-measure after reducing cost; no exceptions are accepted without owner review.

## 10. Visual acceptance levels L0–L4

Evidence root: `docs/building-quality/`. `baseline/` is the frozen before-state; `candidate/` is the exact tested revision. `review-cases.json` determines every sample before the candidate is changed, preserves tile keys/building IDs/local coordinates, and lists an equivalent route through center, historic streets, residential tower district, new development, civic ensemble, industrial zone, detached/small-building edge, plus every curated landmark and a museum view.

Each capture records commit SHA, dataset manifest hash, tile readiness, camera focus, orthographic height, azimuth, elevation, time, pixel settings, renderer/GL backend, viewport, internal dimensions, and `far`/`full` representation state.

| Gate | Required evidence and visual checklist | Automated evidence | Advancement rule |
| --- | --- | --- | --- |
| **L0 — Baseline and inventory** | Before images for every comparison case at `420 m` neighborhood overview and `90 m` close ortho height; all required types, boundaries, four corners and caption-free contact sheets. Confirm no hidden dataset selector can route to the pilot. | Full candidate inventory and address book pass; before screenshots have proof of readiness; screen/per-style case manifest frozen; baseline metrics recorded. | Owner/developer agrees the baseline samples and geometry-preservation contract. Cannot compare quality before this gate. |
| **L1 — Building-family gallery** | All 27 synthetic/building fixture recipes at close camera, day/night and two opposing azimuths. Each family has a readable ground/base, upper wall, crown/roof relationship. Related buildings are distinguishable by at least two architectural attributes; not every variant is just a color shift. Complex footprints have no open gables, floating trim, invalid balconies, detached roof pieces or vertical window seams. | 27 IDs select correctly; repeated generation is deterministic; every geometry/attribute test passes; explicit height/parts boundaries verified by bounding checks; curated-route geometry signatures unchanged. | Every gallery row passes its per-recipe checklist. No global gallery-average hiding one failed family. |
| **L2 — Neighborhood architectural quality** | Real-city before/after pairs at all L0 neighborhoods, close and neighborhood zoom, 13:00 day, warm evening and 22:00 night, plus pixel-art on/off for the courtyard case and one industrial case. Street blocks read as related but not cloned; balconies, entrances, wall/crown junctions, roof pitch and material contrast look intentional. Windows/dark bands do not sparkle or become noisy/mushy. | At least 24 eligible real recipes used; ≥3 meaningful recipes per broad generic archetype with ≥6 eligible real buildings; style-frequency and warning audit passes; full-city source invariants pass; near budgets pass. | Human visual sign-off for each sampled neighborhood and day/night set. Any implausible classification is fixed by eligibility, not by requiring a lucky random seed. |
| **L3 — Complete city, LOD and journey** | Whole city at fitted overview, four edges, corners, North cemetery, river/bridge, multiple close-district destinations. Zoom/pan/rotate transitions have no vanishing region, doubled silhouette, persistent ground plate over required geometry, abrupt wrong palette, stair-step boundary artifact or shimmering roof/facade. All landmarks and Lipki remain present. | Complete known tile inventory is represented by required far/near data independent of resident full-tile cap; source ID sets agree; no same-layer double rendering in transition probe; five overview→district→far journeys return resources within 10% of warmed state; full/far and frame budgets recorded. Zero fatal/unexpected console errors. | No geographic or object-count cut is allowed. Pass on hardware GPU plus software-WebGL correctness run. Performance proof uses hardware runs only. |
| **L4 — Public artifact and release** | Live URL at a user- or organization-level **project path**, fresh anonymous browser profile, first load, neighborhood close, museum click/model, night and attribution/limits panels. Mobile only gets a smoke check if phone hardware is available, not a desktop performance claim. | Authored code license decided; raw/core assets licensed; OSM ODbL notice and downloadable data provenance present; artifact includes exactly one complete city and required museum/static assets. Under a nested `/VoxelMinsk/` route no missing `/data` URLs, 404s, uncaught errors, mixed content or accidental central map. Artifact limit and workflow run pass. | Owner approves the live URL and signed visual/runtime evidence. Publication cannot replace subjective failure with green unit tests or build success. |

### Visual-review details that must be verifiable

- Before/after framing is genuinely identical: same camera and renderer parameters on the paired run, with enough neighborhood to avoid cherry-picking one exceptional building.
- Compare at least two opposite azimuths for profile, corner, courtyard and roof cases.
- Check pixel-art mode for final output and clean mode to distinguish geometry seams from quantisation artifacts.
- Review the largest dominant group of ordinary buildings, not only curated landmarks and theatres.
- Collect a per-case result with `pass`, or `fail` plus an actionable issue and file/module ownership. Blank `not reviewed` is not approval.
- Where visual judgment is subjective, record the reviewer and date. Automated image diffing can flag a change, but cannot certify that an architectural family looks plausible.

## 11. Implementation sequence and review checkpoints

1. **Branch and isolated baseline:** record `git status`, preserve unrelated normalization modifications, create isolated feature work, run geometry/detail-neutral tests and capture L0.
2. **Complete-city contract:** update the frozen area and coverage references to the reviewed 437-tile candidate; run all source invariants. Fix pre-existing B2 data or LOD blockers before styling them.
3. **Shared schema and style selector:** add canonical recipe contract, conservative selector, stable palette choice, and legacy fallback. Test Python/TypeScript ID parity and fixture baseline behavior.
4. **Geometry foundations:** reusable well-capped frames, balcony and entrance detail, profile adapter. Unit test on axis-aligned/concave/courtyard/elevated-part fixtures.
5. **Style-specific roofs and facade grammar:** add mansard/sawtooth/clerestory and shared style presets/shader dispatch. Preserve roof semantics and day/night shader compatibility.
6. **Complete catalog and gallery:** cover L1 before full-city regeneration. Use at least two visual orders (recipe order and seeded-city order) to catch palette/variant collapse.
7. **Candidate generation and real-city review:** stage outside the active public tile path, audit counts/invariants, route through L2 samples and build detector/metric probes.
8. **Full/far integration:** shared data representation, per-tile atomic swaps, no overlaps/gaps, complete unfetched far coverage, and repeat-journey memory tests.
9. **L3 acceptance and measured cost reduction if needed:** fix actual causes and only reduce optional microdetail density. Preserve source invariants.
10. **Publication hardening:** full-city-only resolver, relative paths for tiles/museum/dynamic workers, asset/license audit, deployment whitelist, and offline smoke server with a project-prefixed path.
11. **GitHub Pages release:** CI builds and tests the reviewed artifact, reviewer inspects L4 and live URL, then `main` deploys on success.
12. **Handoff:** update README, architecture, limitations and provenance; remove stale 12×12 km / dataset-current claims from actual release documentation while preserving historical reports as dated evidence.

## 12. GitHub Pages deployment design

### Repository publication audit

Publish tracked raw/model/license assets only after checking their compatibility with public redistribution. Untracked working changes do not enter the release accidentally. Keep pbf extracts, `.venv`, old city duplicates and development images out of the site artifact. Do not commit screenshots, raw OSM extracts, plan-generated QA screenshots or working-data snapshots.

Code and content license decisions remain explicit:

- If no code-license file is selected, GitHub can host the public repository but it is not thereby an open-source grant; do not label the project “open source” without a license.
- Preserve the OSM credits displayed in the HUD and add a durable ODbL notice next to the published data. Do not mix any noncommercial source into the tile database.
- Every museum model/texture must have a documented upstream asset license or documented permission compatible with the chosen public redistribution. `scripts/qa/museum_licenses.py` is a starting point, not proof by itself. An unsupported asset cannot be published under a made-up license; its ownership must be resolved before release rather than silently removing a required exhibit.

### Artifact and routing

A whitelist, not a broad `cp public/*`, assembles the validated Pages artifact: built HTML/JS/CSS/maps, `data/city-tiles/**`, `data/museum/**`, licenses, `.nojekyll`, and required display assets. Old `tiles/` (pilot) and `city-tiles-current/`/staging directories are not public entry points or artifact content. There is no runtime selector that falls back to a local pilot on error.

Use `base: './'` or `GITHUB_REPOSITORY`-derived base and resolve all data through `import.meta.env.BASE_URL`. All `fetch()` calls and worker URLs must run successfully below `/<owner>.github.io/VoxelMinsk/`, not just at `/`. A static-site deep-link uses query parameters only; no server rewrite or paid edge service is required.

### Workflow

A GitHub Actions workflow runs `pnpm install --frozen-lockfile`, data/publication audits, strict TypeScript check, unit tests, build, artifact assertions, and `pnpm preview` under the chosen test project's path. Playwright smoke/correctness captures run where a browser is feasible; hardware frame-rate evidence remains an owner-machine artifact.

Only after validation, `actions/configure-pages@v5`, `actions/upload-pages-artifact@v3`, and `actions/deploy-pages@v5` publish to the `github-pages` environment. Permissions are `contents: read`, `pages: write`, `id-token: write`; deployments use `group: pages` and `cancel-in-progress: false`. A plain `push` to a feature branch can run artifact checks but does not deploy. Committed results include the published URL and workflow run.

The official [GitHub Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits) are a release constraint—not a claim that unlimited traffic is free. The existing 282 MiB payload size alone fits the 1 GB publication limit, but bandwidth still needs separate tracking; avoid publishing multiple redundant city payloads.

## 13. Deliverables and rollback

Each review checkpoint is a small commit with tests and evidence. The final handoff includes:

- Generator/style schemas, shared recipe registry, geometry modules, facade material and tests.
- Full-city candidate and accepted source/shape/style coverage reports.
- Synthetic recipe gallery + complete-city comparisons + machine-readable runtime/capture evidence for L0–L4.
- A single static full-city application, its reproducible deployment workflow and instructions for recreating it.
- Documentation of provisional architecture, attribution, source datasets, limits, and review decisions.

Use `git revert` on the release commit rather than restoring the old central demo. Keep the previous complete-city release tag and exact source input manifest so it can be rebuilt and promoted again. The old pilot source fixture is not a rollback product and must never appear as a user-facing degraded error screen.

## 14. Open decisions resolved for implementation

- Approach: **modular style recipes**, not only palette expansion or city-wide bespoke reconstruction.
- Desired variety: **maximum across generic buildings**, with conservative compatibility and coherent styles.
- Cost: **measured increases**, bounded independently for near detail and already accepted B2 full/far limits.
- Public extent: **only the whole expanded city, no cuts**.
- Hosting: **GitHub Pages**, no backend or paid host. Domain purchase is optional; the default project URL is sufficient.
- License: no source-code license currently present. This is a release audit item requiring owner selection if the repository is to be described as open source; no license is invented for the owner or for third-party assets.
