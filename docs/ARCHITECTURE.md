# Architecture — Isometric Minsk

Interactive isometric pixel-art 3D map of central Minsk, generated from real
OpenStreetMap geometry. This document is the contract between the offline data
pipeline and the browser renderer, plus the module ownership map.

## 1. Data flow

Two datasets are produced from the same OSM extract (BBBike Minsk, with the
Geofabrik Belarus extract as the fallback for larger areas):

| Dataset | Extent | Tiles | Purpose | Committed |
| --- | --- | --- | --- | --- |
| `pilot` (default) | 1.6 × 1.6 km | 16 × 512 m | vertical slice, immediate `pnpm dev` | yes (~2.6 MiB JSON) |
| `city` | 12 × 12 km | 144 × 1024 m | whole inner-city belt, `?dataset=city` | no — generated with `pnpm run data:city` (~88.4 MiB JSON) |

```
BBBike Minsk .osm.pbf
        │  scripts/ingest/extract.py --area pilot|city   pyosmium, C++ node index
        ▼
data/interim/{minsk,city}_raw.geojson          WGS84 lon/lat + OSM tags + tree nodes
        │  scripts/normalize/normalize.py --area pilot|city   pyproj + shapely
        ▼
data/processed/{city_normalized,coverage}.json  validation / coverage source of truth
        │  projection → local metres → height/roof/archetype inference → tiling
        ▼
public/data/tiles/<x>_<y>.json                 512 m tiles (pilot, committed)
public/data/city-tiles/tiles/<x>_<y>.json      1024 m tiles (city, git-ignored)
<dataset>/manifest.json                        tile index, tileSize, bounds, counts
        │  scripts/validation/coverage_report.py --area pilot|city
        ▼
docs/COVERAGE_REPORT{,_CITY}.md                coverage + validity reports
        │  browser: src/engine/tiles (tile streamer, manifest.tileSize is authoritative)
        ▼
Three.js scene → pixel-art postprocessing → canvas
```

The renderer never touches raw geospatial data. The pipeline is deterministic:
same PBF + same scripts ⇒ same tiles. The dataset is selected by the URL
(`?dataset=city`) through `resolveDatasetName` / `resolveManifestUrl` in
`src/shared/config.ts`; the streamer reads `tileSize`, `tileRange`, `bounds` and
`pilotBounds` from the manifest and never hardcodes a grid.

## 2. Coordinate systems

| Space | Definition |
| --- | --- |
| Source | WGS84 (EPSG:4326), lon/lat degrees |
| Projected | EPSG:32635 (UTM 35N), metres |
| Local | `local = utm − originUtm`, metres, origin = pilot centre |
| Tile | `tile = floor(local / manifest.tileSize)` (512 m pilot, 1024 m city) |
| Renderer world | `(x, height, z) = (localX, y, −localY)` |

* Local `+X` = east, `+Y` = north. Renderer `−Z` = north, so at azimuth 0 the
  screen "up" is north.
* Rings are `[x, y]` arrays in local metres; exterior ring first, holes after.
  Exterior rings are normalised CCW in local metres by the pipeline.
* The renderer uses local coordinates directly (origin at the pilot centre) —
  for a 1.6–2 km area the float32 precision is more than sufficient (≈0.1 mm at
  2 km). For city-scale expansion the same scheme is used per loaded tile, with
  a fixed local origin. Camera panning does not rebase the scene origin.

Constants live in `src/shared/config.ts` and `scripts/geo_config.py`; a unit test
(`tests/unit/config_sync.test.ts`) guards that both agree.

## 3. Tile payload (`src/shared/types.ts`)

`TileData` is the only thing the renderer consumes:

* `buildings: BuildingFeature[]` — one record per OSM building, with one or more
  **non-overlapping** `volumes` (the pipeline resolves `building:part` overlaps
  so the renderer can extrude each volume blindly). Every volume carries
  `footprint` (rings), `minHeight`, `height` (eave), `roofShape`, `roofHeight`,
  optional `roofDirection` and the `heightSource` provenance. Relation features
  arrive as proper `Polygon`/`MultiPolygon` geometry (member roles honoured at
  extraction); water polygons keep island holes, so surfaces are triangulated
  with holes respected (`src/city/environment/surfaceMeshes.ts`).
* **Procedural style recipe** (payload 0.5.0) — every building carries an
  optional `styleVariant: { schema: 1, recipeId, source, eligibility[] }`.
  `recipeId` `0..26` is a family in the canonical catalog
  (`src/shared/building-style-recipes.json`, mirrored by
  `scripts/normalize/style_recipes.py`); `27..37` are the frozen legacy
  archetype presets used by protected routes (curated landmarks, palace,
  stadium) and by old data. A building whose `volumes` differ from the mapped
  source massing also records `sourceVolumes` for QA. See
  `docs/building-quality/style-selection-rules.md` for the offline rules.
* **Curated landmarks** — five buildings carry a `landmark` id
  (`minsk-gate`, `national-library`, `victory-obelisk`, `red-church`, `tv-tower`) plus the
  untrimmed original OSM footprint in `outline` (see `docs/DATA_SOURCES.md` §7).
  `src/city/buildings/landmarks.ts` routes them to dedicated geometry modules
  that replace the generic extrusion (rhombicuboctahedron, obelisk, church
  massing); the Minsk Gate crown is additive and stays in `cityGate.ts`. All
  other buildings use the generic volume builder.
* `surfaces` — parks, grass, forests, water, plazas (already clipped to the tile).
* `ground` (payload 0.4.x, current default) — raster-compositor fills/strokes,
  lane/crossing data and clip bounds. Ground roads, landcover and rails are
  painted into a texture; bridge decks remain separate geometry/texture atlases.
  The optional `roadSurfaces` / `roadNetwork` contracts below describe the older
  vector path and compatibility payloads, not a promise they exist in current tiles.
* `roadSurfaces` (optional, payload 0.2.0) — the normalized, **non-overlapping**
  road surface partition: `drivable` pieces split into material zones
  (`asphalt/stone/concrete/unpaved`), `paving`, `kerb` and `median`. Rendered at
  fixed layer heights without per-polygon jitter; see `docs/ROAD_NETWORK.md`.
* `roadNetwork` (optional, payload 0.2.0) — semantic centrelines with
  normalized `width`/`lanes`/`oneway`/`material`, dash-phase
  `centerlineOffset` (may overhang the tile by 4 m so a border-straddling dash
  is emitted once). Round 2 additions: `kind: 'rail'` pieces (merged tram/rail
  centrelines, ballast + two heads rendered by `networkMeshes.ts`) and
  `merged: true` two-way corridor pieces (opposite one-way carriageways that
  overlap merged into one piece, lanes summed, double solid centre painted).
  Markings/zebras/rails are derived from this layer, never from the surface
  polygons.
* `junctions` / `crossings` (optional, payload 0.2.0) — junction boxes (centre +
  clearance radius + number of approaches) and OSM pedestrian crossings
  projected onto the widest carriageway that contains the node.
* `roads` — legacy buffered road/pavement/rail polygons. Payload 0.2.0 tiles
  now carry **no** legacy polygons (`roads: []`; rails moved to `roadNetwork`);
  older/demo tiles still render through the legacy path.
* `trees` — deterministic tree instances; `mapped` marks OSM tree points or
  points sampled along OSM tree rows, rather than heuristic vegetation fill.
* `attractions` (optional) — non-building park props, currently ferris wheels:
  centre, rim radius, hub height, cabin count and wheel-plane yaw. Built by
  `src/city/environment/ferrisWheel.ts` and rendered as a separate shadow-casting
  mesh/material, independent of foliage colour and visibility.
* `crossingBuildingIds` — spatial-index hints for buildings owned by a
  neighbouring tile (geometry is never duplicated).

Ownership rule: each building lives in exactly one tile (the tile of its
centroid). The renderer loads tiles with a one-tile margin so buildings that
cross a border are already present. Tiles are never split, so there are no
geometry cracks.

## 4. Renderer pipeline

```
TileManager (fetch/cache/LRU/cancel)
      │ TileData
      ▼
tile builder: buildBuildingsMesh() + buildEnvironmentMeshes()
      │ worker payload: static geometry + compact tree instance buffers
      ▼
static tile meshes + InstancedMesh trees with shared indexed templates
      │ facade / ground / trunk / crown / attraction materials
      │
      ▼
low-resolution render target (depth + normals)
      │ post pass: outline / quantise / dither
      ▼
nearest-neighbour upscale to the canvas (image-rendering: pixelated)
```

Key properties:

* **Batching per tile** — buildings and static layers are merged; trees use
  one trunk and up to three crown instance batches (two batches total on dense
  tiles). Attractions have a separate mesh/material. No mesh per tree/building.
* **Tile payloads are revalidated on every load** (`cache: 'no-cache'` for the
  manifest and every tile fetch). Tile URLs are stable while their content
  changes whenever the data pipeline is re-run, so a page refresh must never
  reuse a stale payload from the browser HTTP cache; unchanged tiles still cost
  only a `304 Not Modified`. `scripts/qa/cache-check.mjs` guards this.
* **Facades are procedural**: no textures, no per-window meshes. Window rhythm
  comes from vertex attributes (`aUV`, `aStyle`, `aFace`) interpreted in the
  fragment shader, which also gets `uNight` and `uDetailScale` for night
  windows and LOD.
* **Pixel-art is a real postprocessing stage**, not a CSS filter: the scene is
  rasterised at ~320–420 px tall, edges are detected from depth/normal, colours
  are quantised/dithered, then the framebuffer is upscaled with nearest
  filtering. `setPixelEffectEnabled(false)` bypasses it for debugging.

### Building style pipeline (payload 0.5.0)

```
offline selector (Python)                    runtime (TypeScript)
evidence ─► eligibility ─► weighted hash  ─► styleVariant.recipeId
                                             │
                          ┌──────────────────┴───────────────────┐
                          ▼                                      ▼
            preset row 0..37 (uPresetA/B)              geometry modules
            motif id (uRecipeMotif)                    (profiles, frames,
            flags | recipeId << 8  → aFace.y            balconies, entrances,
                                                        variant roofs)
```

* **Bit packing.** `aFace.y = flags | (recipeId << 8)` (16 bits, exact in
  float32). The fragment shader masks the low byte for `facadeFlag` tests and
  reads the high byte as the preset row index, clamped to `0..37`; the broad
  archetype id stays in `aStyle.x` for palace/stadium semantics.
* **Preset rows.** `uPresetA/B` have 38 rows: `0..26` are family recipes
  (`src/city/facades/presets.ts` derives them from the archetype preset plus a
  per-family rhythm override and a motif flag adjustment), `27..37` are the
  frozen legacy archetype presets. A feature without `styleVariant` resolves
  `legacyRecipeFor(archetype)` and reproduces the exact previous values.
* **Motif dispatch.** One `uRecipeMotif[38]` float array selects a small motif
  integer (`monument`, `historic`, `grid`, `loggia`, `balcony_stack`,
  `staircore`, `ribbon`, `clerestory`, `blank_service`, `assembly_hall`, or `-1`
  for legacy rows) instead of 27 shader branches. Each motif reuses the same
  real-metre UVs as the punched-window lattice, so painted openings and the
  geometry frames stay aligned.
* **Massing profiles** (`src/city/buildings/buildingProfiles.ts`) split a convex
  single-ring footprint by a half-plane along its minimum-area rectangle and
  lower one side (`end_pavilion`, `stepped`). Explicit `building:part`
  topology, courtyards, concave rings, small volumes and the far level keep the
  source volumes unchanged. The preserved maximum never exceeds the source
  height (+0.05 m).
* **Detail modules** (`src/city/buildings/facadeDetails.ts`) emit closed solids
  (piers, plinth/cornice bands, balcony slabs/rails, entrance canopy, roof
  service boxes) through `MeshSink`, with explicit outward normals, metric UVs,
  the host recipe's palette and every projection inside the source AABB + 0.45 m.
  Each module is called in its own try/catch: a failure drops only that module
  and keeps the mandatory walls/roof.
* **Variant roofs** (`src/city/roofs/variantRoofs.ts`) provide analytic mansard
  and oriented sawtooth envelopes plus a shallow clerestory cap. They are only
  tried when the *mapped* roof is flat and the volume is eligible; the roof rise
  is reserved inside the declared height by lowering the wall eave, so the
  silhouette maximum is preserved.
* **Envelope discipline.** Decorative trim (flat-roof parapet, variant roof,
  detail boxes) never adds mass above the mapped maximum; `BuildingMeshResult`
  reports `stats.sourceTriangles` vs `stats.detailTriangles` so QA can compare
  mandatory geometry with optional detail separately.
### Camera input and touch gestures (2026-11-15)

Input is split into a DOM-free state machine and a thin browser adapter:

* `src/engine/camera/pointerGestures.ts` — pure pointer-event state machine. It
  tracks every active pointer by id, classifies tap vs drag by device-specific
  slop (`TAP_SLOP_PX`), detects double taps/click from two completed taps within
  `DOUBLE_TAP_INTERVAL_MS`/`DOUBLE_TAP_DISTANCE_PX`, and owns the two-pointer
  gesture: incremental pinch factor anchored at the finger midpoint,
  midpoint panning, and twist rotation after a `TWIST_DEAD_ZONE_RAD` (0.1 rad)
  dead zone. A rotation gesture calls `onRotateEnd` on release, which snaps the
  azimuth to the 45° compass, matching the existing mouse right-drag rule.
* `src/engine/camera/controls.ts` — adapts DOM `PointerEvent`s into samples,
  converts client points to NDC for anchored zoom/focus, captures each pointer,
  and keeps the unchanged wheel and keyboard paths. It also owns the
  double-tap → `focusOnLocal` hand-off used by the engine.

Gesture invariants that matter for UX and tests: a two-pointer gesture never
produces a tap (so pinching never selects a building); a drag breaks a pending
double-tap chain; when one finger of a pair lifts, the remaining finger is
re-baselined so the image does not jump; a `pointercancel` (OS interruption)
ends the gesture and snaps rotation. Mouse behaviour is unchanged: left-drag
pans, right-drag rotates, wheel zooms, double-click focuses.

The React HUD is independent of the renderer. `ControlPanel` folds into a
compact pill, persisted under `localStorage['minsk.hud.controlsCollapsed']`; the
default is folded on `(max-width: 820px), (pointer: coarse) and (max-width: 1100px)`.
`App` exposes 45° rotate buttons through `CityAppHandle.setCameraSettings`. The
engine exposes no mobile-only camera or quality path: renderer resolution,
shadows and tree LOD are unchanged, so emulated-phone tests prove interaction
and layout, not phone performance.

### Instanced vegetation (2026-11-06)

The default tree style is `asymmetric` (review candidate C), with rounded,
uneven crowns inspired by the summer appearance of
[Warsaw Izo](https://bedirhanyildirim.com/warsaw-izo/). Geometry is generated
locally; no reference-site assets or tree positions are imported.

`treeInstances.ts` validates/caps the original `TreeInstance[]` and builds
compact typed-array batches in the worker. `TileWirePayload.trees` contains
the style, density tier, tree/triangle counts, a trunk batch and up to three
crown batches. Each batch transfers matrices, RGB colours and deterministic
variations. `attractions` is separate. The source JSON schema is unchanged.

The existing density thresholds (160 / 320 / 600) and 16,000-tree input cap
remain. Dense tiles share one crown template, varying yaw and proportions per
tree: 97% of city trees are in this tier, so three crown draws per dense tile
would add unnecessary overhead. Other tiers retain three silhouettes. The
selected style uses 56 / 44 / 36 / 28 triangles per tree, including the trunk.

`instancedTrees.ts` creates indexed templates once per streamer. Standard
Lambert materials use flat shading and instance colours. Instance meshes adopt
the transferred matrix/colour arrays and calculate bounds across all instances.
An eviction disposes `InstancedMesh` resources, leaving shared geometry alive;
`geometryMB` remains an approximate resident-buffer counter
that also includes raster textures, not a measurement of total GPU allocation.

The internal `setCanopyAppearance({palette?, visible?})` updates existing colour
buffers/visibility, remembers state for future tiles, and invalidates shadows.
It does not rebuild geometry, alter trunks/attractions, or add a seasonal UI.
Diagnostic hooks are available at `__CITY_DEBUG__.trees()` and
`__CITY_DEBUG__.setCanopyAppearance(...)`; `CityAppHandle` is unchanged.

QA parameters: `?treeStyle=faceted|clustered|asymmetric`, explicit old reference
`?treeStyle=legacy`, and synthetic comparison scene `?treeReview=1`.
See [the verification report](TREE_INSTANCING_2026-11-06.md).

## 5. Module ownership

| Path | Owner | Responsibility |
| --- | --- | --- |
| `scripts/**` | Lead | ingestion, normalisation, tiling, validation |
| `src/shared/**` | Lead | schemas, constants, tile maths, app↔engine API |
| `src/app/**` | Lead | React shell (menus, panels, loading) |
| `src/city/buildings/**`, `src/city/roofs/**` | geometry-dev | extrusion, roofs, merged building mesh |
| `src/city/facades/**`, `src/engine/shaders/**`, `src/engine/materials/facadeMaterial.ts` | facade-artist | facade shader, presets, palette |
| `src/city/roads/**`, `src/city/environment/**` | environment-dev | normalized road surfaces/network, markings, crossings, pavements, parks, water, trees, rail |
| `src/engine/{renderer,camera,tiles,picking,postprocess}/**`, `src/engine/createCityApp.ts` | renderer-dev | renderer, controls, streaming, lighting, post, picking |
| `tests/e2e/**`, `scripts/qa/**`, `docs/QA_REPORT.md` | qa-dev | browser tests, screenshots, performance, visual QA |

Rules: contracts in `src/shared/**` are frozen without Lead approval; nobody
writes outside their ownership; React never creates scene objects.

## 6. Rendering defaults

* Orthographic camera, true isometric: azimuth 45°, elevation `atan(1/√2)`.
* Ortho half-height 420 m default, clamp 40…2600 m.
* Sun uses Minsk latitude/longitude and time of day, with stylised summer-solstice
  elevation/azimuth by default; `?realsun=1` enables the real date. The shadow map
  is fitted to the visible footprint.
* Ground layers are separated vertically (`GROUND_LAYER_Y`) to avoid z-fighting:
  base 0.00, landuse 0.02, grass 0.03, water 0.04, sidewalk 0.05, road 0.07,
  markings 0.09 m. The normalized road partition adds `median` at 0.0635 m
  (between rail ballast and kerb) and places `drivable/paving/kerb/median` at
  their exact layer height — those pieces never overlap, so they need no
  per-polygon jitter. Jitter remains only for the legacy path and for
  landcover categories that can overlap in OSM.

## 7. Scaling plan

The tile manager already works on an arbitrary tile range; expanding the city
means increasing `PILOT_SIZE_M` in the pipeline (or generating multiple regions)
and raising the LRU budget. Stable building ids (`w<id>`/`r<id>` from OSM) make
selection and future bookmarks survive tile eviction. Binary encoding + Brotli
is the planned next step for payload size; the JSON payload is designed so each
array maps 1:1 onto a flat typed array.
