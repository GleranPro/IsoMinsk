# Limitations — Isometric Minsk

This document records what the map, its data and its tests **do not** claim or
cover. It is deliberately blunt: an isometric pixel-art map built from
OpenStreetMap is an interpretation, not a survey.

Last updated: 2026-10-27 (pilot milestone). Numbers below come from the actual
generated milestone data (`public/data/tiles/manifest.json`,
`docs/COVERAGE_REPORT.md`) and from QA measurements.

---

## 1. Coverage and scope

- **Only a 1600 m × 1600 m pilot area is rendered**: October Square / Independence
  Avenue, central Minsk, projected around `53.9022 N, 27.5610 E`. Everything
  outside the 16 generated tiles is empty. This is not a map of Minsk.
- The tile grid is 4 × 4 cells of 512 m (`tileRange −2..1`). Ingestion is padded
  by `INGEST_MARGIN_M = 320 m` so buildings straddling the pilot edge are complete,
  but the padded ring is used for completeness only, not as extra map.
- No interaction beyond pan / zoom / rotate / time-of-day / pixel-art toggle /
  building info: no search, geocoding, routing, measurement, date slider, POI
  directories, floor plans, interiors, transit overlay or live data.
- 654 building features are rendered (manifest count after the 14:37 regeneration;
  multipolygon parts merged into one feature with multiple volumes). Manifest
  counts, tile payloads and `docs/COVERAGE_REPORT.md` agree.

## 2. Source data

- Single source: OpenStreetMap, Geofabrik Belarus extract
  (`data/raw/belarus-latest.osm.pbf`, 351 MB, extract timestamp 2026-10-27T13:21:39Z).
  ODbL 1.0 — attribution is shown in the UI and the manifest; redistribution of
  derived data carries ODbL obligations.
- **No external height dataset** is used. GlobalBuildingAtlas LoD1 was considered
  and rejected (non-commercial licence). No cadastral footprints, no official
  address register, no terrain model, no imagery.
- OSM completeness varies by feature class and neighbourhood. Untagged buildings,
  missing heights, missing landuse polygons and missing footpaths are inherited
  from the source as-is.
- The extract is a one-shot snapshot; there is no update pipeline. Data will drift
  from the live map.
- QA's data tests validate the generated JSON as-is; they do not validate OSM
  correctness.

## 3. Heights, floors and roof shapes are inferred

From the generated milestone data:

| Height provenance | Buildings |
| --- | --- |
| Explicit OSM `height` tag | 69 (10.6 %) |
| Derived from OSM `building:levels` × floor height | 366 (56.0 %) |
| **Heuristic estimate** (archetype + district rules) | 219 (33.5 %) |

- Observed rendered heights span **2.5 m – 115.5 m**; the pipeline clamps to
  `MIN_BUILDING_HEIGHT_M = 2.5 m` / `MAX_BUILDING_HEIGHT_M = 400 m`.
- Explicit `roof:shape` tags cover 305 buildings (46.6 %); the rest are inferred
  from archetype. Pitched roofs are approximated; `complex` roofs fall back to
  flat (`complex` is present in the schema but the mesh builder logs a warning and
  renders it flat).
- Architectural archetype (`stalin`, `khrushchev`, `panel`, …) is a heuristic
  classification from tags and distance to Independence Avenue — **not**
  authoritative. It drives facade style, colours and window rhythm, so visual
  style errors follow from misclassification.
- Floor counts and floor heights are nominal (`DEFAULT_FLOOR_HEIGHT_M = 3.0 m`),
  not surveyed; the same building can be 5 %–20 % off in reality.
- There is no terrain elevation: every building sits on the local y = 0 plane.
  Minsk is hilly in places; slopes are not represented, so stair-step buildings
  and river banks are flattened.

## 4. Geometry and topology

- Footprints are OSM polygons projected to local metres. Invalid/sliver rings are
  repaired or dropped at generation time (coverage report: 120 slivers dropped,
  0 invalid geometries kept, 51 tunnels skipped, 2 orphan `building:part`
  polygons rendered standalone). What the pipeline drops is gone from the map.
- Multi-polygon relations are merged into a **single** `BuildingFeature` with one
  `footprint` volume per polygon part; ids are plain `${type}${id}`. Volume count
  is therefore not the same as OSM part count, and a relation may render as
  several disconnected volumes.
- Absent optional fields (`levels`, `name`, `address`, …) are omitted from the
  JSON; consumers must treat `undefined` as unknown. (`levels: null` appeared in
  an earlier data revision and was fixed at 14:37.)
- Buildings crossing tile boundaries are owned by exactly one tile and referenced
  from other tiles via `crossingBuildingIds`; they are never rendered twice.
  Picking relies on that ownership map.
- No interiors, no boolean-cut openings, no stairs, no antennas/chimneys except as
  simplified roof volumes.
- Road geometry is **buffered centrelines**, not carriageway edges: road widths
  are inferred from the OSM class (motorway … footway). Junctions are not
  filleted; overlapping road surfaces rely on layer offsets to avoid z-fighting.
- Surface polygons (landuse/leisure/natural) may be nested or overlapping in OSM;
  the pipeline flattens them with small y offsets (`GROUND_LAYER_Y`), so extreme
  close-ups can show layering artefacts.
- Water bodies are flat polygons at y ≈ 0.04 m; no depth, no reflections, no
  shoreline treatment.
- Trees: only 216 are explicitly mapped in OSM; **3 559 are heuristically placed**
  inside green polygons. Tree species, age and season are not modelled.
  Street furniture, lamps, benches, fences, parking markings, tram wires and
  overhead lines are absent.

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
  Laptop: **50–60 FPS** for 178–182 k triangles / 48–50 draw calls at 640×360;
  the SwiftShader path is ~1.9 FPS and is only used for correctness, never for
  performance claims.
- Pixel-art look: with the effect on, the scene is rendered at a reduced internal
  resolution (currently **640×360** for a 1600×900 viewport) and upscaled with
  `image-rendering: pixelated`; with the effect off it renders at full canvas
  resolution. Fine detail is physically impossible in pixel mode, and image-diff
  percentages for subtle changes are damped by the upscaling.
- Lighting is one directional sun + hemisphere light, with a 2048² shadow map
  covering only ~1800 m. No global illumination, no AO baking, no reflections,
  no volumetric effects, no bloom (pixel-art palette quantisation is applied in a
  post-process instead). **As of this milestone the pixel-art post-process makes
  the scene noticeably darker/desaturated than the clean-3D render** (mean
  luminance 74.6 vs 114.8 in QA screenshots); a brightness/palette art pass is
  in progress. The 23:00 night preset is currently too dark to read and has no
  lit windows yet.
- Tile streaming is progressive: tiles load around the camera and all 16 pilot
  tiles eventually load (QA's capture script waits for 16/16 before shooting).
  A larger area would need unloading/LOD policies that do not exist yet.
- Building picking is CPU raycasting against triangle→building-id maps. Thin
  geometry, overhangs and overlapping parts can pick a neighbouring building or
  nothing; transparent surfaces are not considered for occlusion.
- `EngineStats.geometryMB` is now plausible (~24 MB for ~182 k triangles). FPS is
  a rolling average and includes the pixel-art post-process; the panel only
  refreshes when React re-renders because the renderer passes the same mutated
  `EngineStats` object reference every tick (QA defect D12) — the built-in
  "Refresh stats" button forces an update.

## 7. Test / QA limitations

- E2E tests run in headless Chromium. They verify *presence of change*, not visual
  beauty: image-diff thresholds (1–2 %) only prove that a control affects output.
  The default mode uses software WebGL (SwiftShader; ~1.9 FPS at 182 k triangles),
  which makes the full suite ~10 min; `QA_GPU=1` switches to the real GPU
  (ANGLE/D3D11) and brings the suite down to ~1.8 min — use it for verification
  runs that include performance numbers.
- There are no committed golden-image baselines yet: `screenshots/` is git-ignored
  by design. The milestone PNGs + `screenshots/analysis.json` + `stats.json` are
  the evidence trail. Visual quality is reviewed manually by reading PNGs.
- Screenshots currently click the built-in "Refresh stats" button before each shot
  because the HUD performance panel does not auto-update (defect D12). The PNGs
  show correct numbers, but that is a documented workaround; the default UI panel
  is stale until clicked.
- The data suite is skipped with a warning when
  `public/data/tiles/manifest.json` is absent; a green run therefore does not
  prove data exists unless the count of executed tests is checked.
- `playwright.config.ts` assumes port 5173, a 1600×900 viewport and one worker.
  While other agents edit `src/`, the dev server can HMR-reload mid-test and cause
  spurious failures (observed once: `Execution context was destroyed … navigation`).
  Mitigation: `openApp()` detects a never-executed document (no canvas/globals/
  `#root` children for 10 s) and reloads once, logging a `document-boot-retry`
  annotation; a genuine crash still fails. Mid-test reloads cannot be recovered.
- Canvas screenshots allow 60 s (not Playwright's default 15 s action timeout)
  because a software-rendered 1600×900 screenshot can take that long at ~2 FPS.
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

- The UI and manifest credit "© OpenStreetMap contributors, ODbL 1.0" plus the
  Geofabrik extract source. If the rendered tiles or derived geometry are
  redistributed, ODbL share-alike obligations apply to the derived database.
- Architectural heuristics, inferred heights and procedurally placed trees are
  original work and are not OSM facts; they should not be presented as surveyed
  data.
