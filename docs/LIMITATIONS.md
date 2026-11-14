# Limitations — Isometric Minsk

This document records what the map, its data and its tests **do not** claim or
cover. It is deliberately blunt: an isometric pixel-art map built from
OpenStreetMap is an interpretation, not a survey.

Last updated: 2026-11-06. Current counts come from manifests and tile files
(payload 0.4.3, generated 2026-11-05); current renderer measurements come from
[the instancing checkpoint](TREE_INSTANCING_2026-11-06.md). Pilot height/roof
provenance below is distinct from city-wide totals.

---

## 1. Coverage and scope

- Two datasets are supported: the **1.6 × 1.6 km pilot** (16 × 512 m tiles,
  654 buildings) and the **12 × 12 km city belt** (`?dataset=city`, 144 × 1024 m
  tiles, 31 783 buildings). City tiles are generated locally and git-ignored.
  Coverage does not include all Minsk inside MKAD; expansion remains B-2.
- The pilot grid is 4 × 4 cells of 512 m (`tileRange −2..1`). Ingestion is padded
  by `INGEST_MARGIN_M = 320 m` so buildings straddling the pilot edge are complete,
  but the padded ring is used for completeness only, not as extra map.
- No interaction beyond pan / zoom / rotate / time-of-day / pixel-art toggle /
  building info: no search, geocoding, routing, measurement, date slider, POI
  directories, floor plans, interiors, transit overlay or live data.
- Tree totals are 6 555 in the pilot (374 mapped, 6 181 heuristic) and 316 704
  in the city (12 193 mapped points/row samples, 304 511 heuristic). Current
  tile-file totals agree with the manifests.

## 2. Source data

- Single map-data source: OpenStreetMap, with BBBike Minsk as primary extract
  and Geofabrik Belarus as fallback (see `DATA_SOURCES.md`).
  ODbL 1.0 — attribution is shown in the UI and the manifest; redistribution of
  derived data carries ODbL obligations.
- **No external height dataset** is used. GlobalBuildingAtlas LoD1 was considered
  and rejected (non-commercial licence). No cadastral footprints, no official
  address register, no terrain model, no imagery.
- OSM completeness varies by feature class and neighbourhood. Untagged buildings,
  missing heights, missing landuse polygons and missing footpaths are inherited
  from the source as-is.
- The offline pipeline supports manual regeneration; there is no automatic live
  OSM refresh. Treat extracts as dated snapshots.
- Coverage reports describe their generation checkpoints. Current data counts
  come from manifests plus tiles; current render-buffer/triangle numbers come
  from the instancing report, not the older B-1 coverage comparison.
- QA's data tests validate the generated JSON as-is; they do not validate OSM
  correctness.

## 3. Heights, floors and roof shapes are inferred

Pilot manifest provenance (654 buildings; not city-wide percentages):

| Height provenance | Buildings |
| --- | --- |
| Explicit OSM `height` tag | 57 (8.7 %) |
| Derived from OSM `building:levels` × floor height | 366 (56.0 %) |
| **Heuristic estimate** (archetype + district rules) | 231 (35.3 %) |

- Observed rendered heights span **2.5 m – 115.5 m**; the pipeline clamps to
  `MIN_BUILDING_HEIGHT_M = 2.5 m` / `MAX_BUILDING_HEIGHT_M = 400 m`.
- Explicit `height` values below `MIN_PLAUSIBLE_HEIGHT_M = 2.5 m` are treated as
  missing data (12 pilot / ~48 city buildings carry such typos, e.g.
  `height=0.01`), so they fall back to `building:levels` or heuristics instead of
  rendering as 7 m blocks.
- Explicit `roof:shape` tags cover 305 buildings (46.6 %); the rest are inferred
  from archetype. Pitched roofs are approximated; `complex` roofs fall back to
  flat (`complex` is present in the schema but the mesh builder logs a warning and
  renders it flat).
- Architectural archetype (`stalin`, `khrushchev`, `panel`, …, `palace`, `stadium`)
  is a heuristic classification from tags and distance to Independence Avenue — **not**
  authoritative. It drives facade style, colours and window rhythm, so visual style
  errors follow from misclassification. The union was extended in the 16:13 data
  revision for the Palace of the Republic (`palace`) and stadium geometry
  (`stadium`); only one `palace` building exists in the pilot area and no
  `stadium` is inside the current extent.
- Floor counts and floor heights are nominal (`DEFAULT_FLOOR_HEIGHT_M = 3.0 m`),
  not surveyed; the same building can be 5 %–20 % off in reality.
- **Landmark geometry is curated, not generic.** Five landmarks have dedicated
  geometry, flagged in the data as `landmark`: the Minsk Gate
  (`minsk-gate`: flat parapet, clock/emblem medallions, corner turrets), the
  National Library (`national-library`: terraced podium rebuilt from the OSM
  outline + a true rhombicuboctahedron with a 24.67 m edge, 11.0–70.7 m), the
  Victory Square obelisk (`victory-obelisk`: stepped pedestal, tapering shaft,
  gold star), the Red Church (`red-church`: brick nave, twin towers with
  spires and gold crosses) and the TV tower (`tv-tower`: 176 m lattice mast
  with platform bands and the 160 m octagonal platform). Their massing is derived
  from real OSM footprints / `building:part` positions, but all decorative
  details are procedural approximations: the gate clock is a fixed 10:10 disc,
  the library curtain wall is colour bands + mullion rims rather than 16×22
  glazing panels per face, the church ornament is simplified and the TV mast's
  truss is a stylised 4-leg lattice rather than the real member-by-member frame.
  All remaining landmarks (Bolshoi Theatre, railway station, Minsk-Arena, Holy
  Spirit Cathedral, …) still use the generic archetype presets. Seven OSM
  features needed hand-reviewed metadata overrides; they are listed in
  `docs/DATA_SOURCES.md` §7.
- **Park attractions are curated and static.** Both ferris wheels are real
  geometry (Gorky Park 54 m / Ø51 m / 36 cabins, Chelyuskintsev Park 28 m /
  18 cabins) but they do not rotate — the environment geometry is baked per tile,
  so adding animation would need a separately animated scene object. Their
  dimensions and wheel-plane bearings are curated (`ATTRACTION_CURATION`), since
  OSM only tags the wheel nodes with `attraction=big_wheel` + `height`.
- There is no terrain elevation: every building sits on the local y = 0 plane.
  Minsk is hilly in places; slopes are not represented, so stair-step buildings
  and river banks are flattened.

## 4. Geometry and topology

- Footprints are OSM polygons projected to local metres. Invalid/sliver rings are
  repaired or dropped at generation time (coverage report: 120 slivers dropped,
  0 invalid geometries kept, 51 tunnels skipped, 2 orphan `building:part`
  polygons rendered standalone). What the pipeline drops is gone from the map.
- Multi-polygon relations are assembled at extraction time **with their member
  roles** (`outer` shells, `inner` holes) and may therefore arrive as
  `MultiPolygon` features; a relation may render as several disconnected
  volumes. Water polygons keep their island holes, so surveyed islands are not
  painted over by the enclosing water surface. Curated landmark records keep the
  untrimmed original footprint in `outline`. Ids are plain `${type}${id}`.
- The duplicate detector uses a coarse 2 m centroid / 20 m² area signature but
  verifies each candidate against the real footprint before dropping it (area
  within 15 %, centroid within 3 m). Three hand-reviewed aggregate ways around
  the Minsk Gate are skipped entirely (`CURATED_DUPLICATE_IDS`); their lobes
  duplicate separately mapped buildings, which now render.
- Absent optional fields (`levels`, `name`, `address`, …) are omitted from the
  JSON; consumers must treat `undefined` as unknown. (`levels: null` appeared in
  an earlier data revision and was fixed at 14:37.)
- Buildings crossing tile boundaries are owned by exactly one tile and referenced
  from other tiles via `crossingBuildingIds`; they are never rendered twice.
  Picking relies on that ownership map.
- No interiors, no boolean-cut openings, no stairs, no antennas/chimneys except as
  simplified roof volumes.
- Road geometry is **buffered centrelines**, not surveyed carriageway edges.
  Payload 0.3.0 builds an OSM topology graph from shared vertices: each junction
  node with ≥3 distinct approaches gets one asphalt face polygon derived from
  the approach cross-sections (corner ring or union of approach mouths); lane
  tags are authoritative per way (`lanes:forward`/`lanes:backward`, else
  `lanes`, else a class default), width is derived from the lanes, and an
  explicit `width` is used only when physically compatible (≥2.6 m per lane).
  A tagged segment keeps its own count — Ulyanovskaya renders 3 lanes, Lenina
  renders 1+2 asymmetric. Unnamed short connectors that end at a junction,
  `highway=*_link` roads and service aisles are **channelization**: their mouths
  are part of the junction face but they render as paving (no asphalt fork, no
  lane paint). Opposite one-way ways are merged into one two-way corridor only
  when their buffers overlap and the lane counts/corridor width are consistent.
  The partition guarantees drivable/paving/kerb/median pieces never overlap
  above the 0.35 m² rounding tolerance (residual cm² slivers remain from the
  1 cm payload grid), so the old per-polygon Y jitter is gone; see
  `docs/ROAD_NETWORK.md`.
- Road **material** comes from OSM `surface`, folded into
  `asphalt/stone/concrete/unpaved`. Explicit tags are authoritative; untagged
  segments inherit the street's length-weighted majority. OSM gaps or wrong
  tags therefore render as asphalt unless a hand-reviewed
  `SURFACE_OVERRIDES` entry is added. Material changes are crisp shared edges
  inside the partition, not stacked tints. There is no per-class road tint any
  more: street hierarchy is read from width and markings.
- **Bridges** are raised decks (2.5 m) without ramps: the deck steps up from
  the ground carriageway at its ends, structural side skirts are drawn only
  where the deck is not adjacent to a ground road (bridge sidewalks are flat
  slabs on the deck). This reads as a stylised bridge at isometric zoom but is
  not a true approach ramp.
- **Markings** are derived from the network centrelines (paint only on
  asphalt): two-way layouts are asymmetric from `lanesForward`/`lanesBackward`,
  with double solid centre from 12.5 m or dashed centre from 5.5 m; one-way
  roads get `lanes−1` dividers (the tagged count is not width-clamped); solid
  edge lines are drawn on motorway/trunk/primary/secondary. `link`, service and
  channelization pieces get no lane paint; roundabouts get edge lines only. OSM
  `highway=crossing` / `highway=traffic_signals` nodes drive zebras and stop
  lines; a junction without a mapped crossing gets no zebra. Signalised
  pedestrian crossings are rendered as zebra bars + stop lines, a bare signal
  head gets a stop line only. Dash phase is anchored per way, so it restarts at
  OSM way joins (most of which are junctions, where markings stop anyway).
  Every paint type is clipped out of the junction face polygons with
  chunk-aware clearance and out of junction asphalt surface slivers; dashes are
  clipped out of crossing spans. Zebra bars and stop lines must have all corners
  inside asphalt/stone, so a mis-projected crossing is dropped rather than
  painted over paving. Paint widths are 0.15–0.5 m: the 0.15 m lines can alias
  away in the 640×360 pixel-art pass at far zoom and read correctly at close
  zoom; this is a deliberate pixel-art trade-off, not missing data. Bridge paint
  is raised with the deck.
- **Tram/rail centrelines** are merged OSM lines rendered as a ballast strip and
  two 0.34 m rail heads by the network layer; near-duplicate parallel tracks of
  the same tram line are collapsed (Hausdorff ≤ 3.5 m), so a single-track tram
  street gets one rail pair, not two. Rails are clipped to tile bounds (halves
  meet with matching cross-sections) rather than owned whole by one tile, so a
  rail crossing a tile border is drawn half by each tile; there are no painted
  markings on rail pieces and no junction clearance for rails (they run through
  junctions by design). Heavy rail (non-tram) uses a 3.4 m ballast strip.
- Surface polygons may be nested/overlapping in OSM. The default raster ground
  paints them in layer order; the older vector path uses small y offsets.
- Water is flat ground artwork in the default raster path; no water depth,
  reflections or physical shoreline model is implemented.
- Trees use asymmetric style C and instancing. Species and age are not identified;
  samples along mapped rows are not individually surveyed trunks. Independent
  canopy palette/visibility is implemented, but full seasons, winter branches
  and snow are not. Street lamps, benches, fences, tram wires and overhead lines
  remain absent.

## 5. Projection and coordinate conventions

- WGS84 (EPSG:4326) → WGS 84 / UTM zone 35N (EPSG:32635), translated so the pilot
  centre maps to local (0, 0). At a 1.6 km extent the UTM scale error is
  negligible (< 0.05 %), but the output is a planar approximation: no geodesic
  distances, no true north correction beyond the grid convergence baked into UTM.
- Renderer world mapping: `worldX = localX`, `worldY = height`,
  `worldZ = −localY` (north is −Z). Heights are metres above the local ground
  plane, not above sea level.
- Ring winding: `src/shared/tileMath.ts` documents `ringArea()` as
  "positive = CCW", but the implementation returns **negative for CCW** rings and
  positive for CW. The pipeline and `polygonArea()` currently use `Math.abs()` so
  nothing breaks today, but the documented contract is wrong and is fragile if
  anyone starts using the sign for winding/normal decisions. Another agent's
  triangulation test (`tests/unit/environment/triangulation.test.ts`) assumes the
  same (incorrect) convention — this deserves a decision + doc fix.
- `manifest.bounds` is the **full tile-grid extent** (±1024 m). The rendered pilot
  area is the optional `manifest.pilotBounds` (±800 m), which lies inside the tile
  grid. Renderers/cameras must frame on `pilotBounds ?? bounds`; treating the tile
  extent as the visible city will show the ingest-margin ring and frame the
  district off-centre.

## 6. Renderer constraints

- **Orthographic isometric projection only** (default azimuth π/4, elevation
  atan(1/√2) ≈ 35.26°); perspective is not implemented. The default camera
  auto-fits the pilot area (orthoHeight ≈ 660–692 m at 1600×900).
- **WebGL2 is required**; there is no WebGL1/2D fallback. Playwright runs use
  ANGLE/SwiftShader (software) by default for deterministic CI behaviour; QA can
  opt into the real GPU with `QA_GPU=1` (ANGLE/D3D11). Measured on an RTX 3080
  Laptop, the current 144-tile overview takes **6.46 ms mean / 8.10 ms p95**
  with **593 draws / 7 875 933 visible triangles** at internal 640×360.
  This GPU-synced benchmark disables vsync/FPS limiting. Software results must
  not be used for hardware performance claims.
- Pixel-art look: with the effect on, the scene is rendered at a reduced internal
  resolution (currently **640×360** for a 1600×900 viewport) and upscaled with
  `image-rendering: pixelated`; with the effect off it renders at full canvas
  resolution. Fine detail is physically impossible in pixel mode, and image-diff
  percentages for subtle changes are damped by the upscaling.
- Lighting uses a directional sun, hemisphere ambient and fill light, with a
  shadow map fitted to the view. Sun elevation/azimuth are stylised by default;
  `?realsun=1` enables the real date. Night windows are implemented; street
  lamps are not. No global illumination, AO baking, reflections or bloom.
- Streaming, worker cancellation, LRU eviction, facade LOD and ground-texture
  LOD are implemented. Tree detail is chosen by tile density, not projected
  screen size. Mobile budgets and touch controls remain unimplemented/unverified.
- **Rail LOD mismatch fixed 2026-11-06.** Ground and bridge decks now use one
  rail-head painter at every tier: the same family palette, 0.15 m head width
  and 1.44 m gauge, with subtexel coverage instead of one-texel widening.
  Distant detail still blends into ballast; coarse texels and pixel quantisation
  cannot reproduce individual heads. Same-camera comparisons and regression
  checks: [RAIL_LOD_2026-11-06.md](RAIL_LOD_2026-11-06.md).
- Building picking is CPU raycasting against triangle→building-id maps. Thin
  geometry, overhangs and overlapping parts can pick a neighbouring building or
  nothing; transparent surfaces are not considered for occlusion.
- `EngineStats.geometryMB` approximates resident buffers, including raster
  textures and instance data; it is not measured total GPU allocation. Same-city
  comparison: 731.20 → 378.42 MiB, tree buffers −87.95%. Detailed crowns increase
  overview mean frame time from 4.70 to 6.46 ms (+37.4%); a universal speed-up
  and phone readiness are not claimed. FPS is a rolling average.

## 7. Test / QA limitations

- E2E tests run in headless Chromium. They verify *presence of change*, not visual
  beauty: image-diff thresholds (1–2 %) only prove that a control affects output.
  The default mode uses software WebGL (SwiftShader; ~1.9 FPS at ~200 k triangles),
  which makes the full suite ~10 min; `QA_GPU=1` switches to the real GPU
  (ANGLE/D3D11) and brings the suite down to ~1–2 min — use it for verification
  runs that include performance numbers.
- There are no committed golden-image baselines yet: `screenshots/` is git-ignored
  by design. The final PNGs + `screenshots/analysis.json` + `stats.json` are the
  evidence trail. Visual quality is reviewed manually by reading PNGs. Only the six
  canonical capture files are analysed by default (`QA_ANALYZE_ALL=1` includes
  other agents' PNGs in that folder).
- The data suite is skipped with a warning when
  `public/data/tiles/manifest.json` is absent; a green run therefore does not
  prove data exists unless the count of executed tests is checked.
- `playwright.config.ts` uses `QA_PORT` (default 5173), a 1600×900 viewport and one worker.
  While other agents edit `src/`, the dev server can HMR-reload mid-test and cause
  spurious failures (observed once: `Execution context was destroyed … navigation`).
  Mitigation: `openApp()` detects a never-executed document (no canvas/globals/
  `#root` children for 10 s) and reloads once, logging a `document-boot-retry`
  annotation; a genuine crash still fails. Mid-test reloads cannot be recovered.
- Canvas screenshots allow 60 s (not Playwright's default 15 s action timeout)
  because a software-rendered 1600×900 screenshot can take that long at ~2 FPS.
- The latest complete **13/13** suite passed on hardware WebGL. The complete
  current suite has not been rerun on SwiftShader. Vitest passed **434 tests**,
  with **5 skipped**; skips are not accepted as executed checks.
- No CI pipeline exists yet; all commands are Windows/PowerShell-local.
- Typecheck (`tsc --noEmit`) covers `src`, `tests`, `scripts`, both Vite configs,
  but **not** `playwright.config.ts` (tsconfig `include` list); Playwright loads it
  itself.
- `scripts/qa/geometryAudit.ts` (Lead-owned) duplicates a little validation that
  also exists in the unit/data suite; it exercises the mesh builders headlessly and
  is a complement, not a replacement for the browser e2e tests.
- Only the RTX 3080 Laptop GPU was measured; integrated/low-end GPUs and the
  default SwiftShader path may be much slower.

## 8. Legal / attribution

- The UI and manifest credit "© OpenStreetMap contributors, ODbL 1.0" and
  extract provenance. If the rendered tiles or derived geometry are
  redistributed, ODbL share-alike obligations apply to the derived database.
- Architectural heuristics, inferred heights and procedurally placed trees are
  original work and are not OSM facts; they should not be presented as surveyed
  data.

## 9. Procedural building style recipes (payload 0.5.0)

- The 27 style recipes are **visual families, not surveyed architectural
  attribution**. A recipe is chosen from mapped evidence (broad archetype,
  explicit `building:material`, `roof:shape`, `start_date`, `building:levels`,
  footprint geometry) plus a stable hash of the feature id; the payload records
  whether the choice was `osm_hint` or `heuristic`. The info panel must not
  present it as a measured era or construction material.
- Massing profiles (`end_pavilion`, `stepped`) only split convex single-ring
  footprints inside the declared envelope. Courtyards, concave rings, explicit
  `building:part` topology and small volumes deliberately keep the source
  massing, so some buildings of a family look simpler than the family's
  catalogue description.
- Facade detail modules (piers, cornices, balconies, canopies, roof boxes) are
  bounded decorative geometry: they never exceed the mapped total height and
  never project more than 0.45 m outside the source footprint. They are not
  surveyed balconies or entrances.
- Variant roof envelopes (mansard, sawtooth, clerestory) are only attempted on
  flat mapped roofs whose footprint is eligible; a declared sloped `roof:shape`
  always stays authoritative. The roof rise is taken from the top slice of the
  declared height, so the silhouette maximum is preserved but the eave line can
  sit slightly lower than the source `height`.
- The far representation of the same territory is still the single accepted
  streamer path in this branch: the atomic full/far state machine, far export and
  transition probe specified for Task 7 are **not implemented**, so no L3
  full/far coverage or journey evidence exists yet.
- Performance evidence for the heavier geometry is **not** recorded in this
  branch: SwiftShader captures prove correctness only, and the hardware-GPU
  near-scene triangle/byte/frame-time gate (Task 8) still has to be run on the
  reference machine.
- L1 gallery captures are software-WebGL correctness images; L2 neighbourhood
  pairs are scripted but the complete 31-case before/after matrix and the
  owner's visual sign-off are outstanding (see `docs/building-quality/REVIEW.md`).