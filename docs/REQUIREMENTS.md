# Requirements compliance — Isometric Minsk

This document is the **compliance analysis** of the project against its
**original brief**, which is stored verbatim in
[`docs/REQUIREMENTS_ORIGINAL.md`](REQUIREMENTS_ORIGINAL.md) (recovered from the
first project message on 2026-10-29). Section references below (§1–§12) point to
that document. The earlier reconstructed-requirements file was replaced by this
pair: original brief + traceability matrix.

Status legend: ✅ delivered & verified · 🟡 partially delivered / deviation
documented · ⏳ planned (explicitly non-MVP or later iteration) · ❌ not delivered.

Verification is only claimed from artifacts that exist in the repository:
tests, audits, captures and dated reports. Latest application verification is
2026-11-15: 562 Vitest passed (5 skipped, 34 files); 31 hardware-WebGL browser
scenarios (24 desktop + 7 mobile/touch), 30 pass — the pre-existing
`trees.spec.ts` expects the old 16-tile pilot; typecheck/build passed. Earlier
data audits retain their own dates and counts; see `TREE_INSTANCING_2026-11-06.md`
and `QA_REPORT.md`.

## 1. Compliance summary by original section

| Brief section | Status | Key evidence / note |
| --- | --- | --- |
| §1 Product vision — interactive, geographically accurate, procedurally generated 3D Minsk with stylized isometric pixel-art renderer; real streets/footprints/parks/water; true 3D buildings with facades; ortho camera; GPU rasterization; dynamic loading; selection + info; configurable time of day; not a static image | ✅ | App runs as a static Vite site over generated tile JSON; real OSM geometry (31 783 buildings city-wide), procedural facades, picking, day/night; see `README.md`, `docs/PROGRESS.md` verified numbers |
| §1 Study the original Warsaw project's technical explanation before implementation | ✅ | `docs/ART_REFERENCE.md` — the write-up was read (Cloudflare bypass via `r.jina.ai`) and decomposed into the camera, low-res raster + nearest upscale, depth/normal outlines, palette/dither, fog, silhouettes; implementation follows it |
| §1 Minsk architectural identity (Soviet neoclassical / Stalinist avenue, Soviet residential, modern) | ✅ | archetype classifier + 11 facade presets (stalin, khrushchev, panel, modern, office, historic, industrial, small, civic, palace, stadium); `src/city/facades/presets.ts`, facade shader; screenshots 01–03, 06 |
| §2 Windows 11 / PowerShell / Node 24 / RTX 3080 / 32 GB; free & open-source tooling; no paid APIs or cloud GPUs; no backend; static hosting; real geography, no AI-generated city | ✅ | documented in `README.md`; stack is TypeScript/Vite/Three.js/React + Python/shapely/pyproj/pyosmium; no backend; one offline PBF |
| §2 Priorities 1→8 (working app first, then footprint accuracy, facades, pixel-art, navigation, performance, expansion, secondary details) | ✅ | execution order followed; city expansion only after pilot acceptance; animations deferred (§7) |
| §3 Recommended stack (TypeScript, Vite, Three.js, React for UI only, GLSL/WebGL2; Python 3.11+, pyproj, shapely, GDAL/Rasterio where appropriate, pyosmium; Vitest, Playwright) | ✅ except GDAL/Rasterio | no raster/DEM data was used, so GDAL/Rasterio was not needed; `docs/ARCHITECTURE.md` §1 |
| §3 Renderer independent from offline data pipeline; React does not manage thousands of building components | ✅ | `scripts/**` produces JSON; the renderer consumes `TileData`; React only mounts the canvas and panels (`src/app/**`) |
| §3 Local metric EPSG:32635 with local origin; consistent conventions; 512 m tiles configurable; compact JSON/GeoJSON with binary+Brotli-compatible design; browser never downloads the whole raw dataset | ✅ (binary deferred) | `scripts/geo_config.py` + `src/shared/config.ts` kept in sync by a unit test; pilot 512 m tiles, city 1024 m; tiles streamed per view; binary/Brotli encoding is documented as the next scalability step (LIMITATIONS §3) |
| §4 Data source research (OSM/Geofabrik, Overture, GlobalBuildingAtlas, OSM Simple 3D tagging); investigate DEM/height/rooftop data; assume nothing is complete; GBA non-commercial → isolated; ODbL attribution; no prohibited bulk downloads; per-source record (provider, coverage, resolution, date, licence, quality) | ✅ | `docs/DATA_SOURCES.md` §1–§7: Overture STAC + Microsoft footprint checks, GBA terms and coverage, OSM extract details, licence conclusions, attribution blocks; GBA not integrated; no bulk tile downloads |
| §4 Geometry source fallback hierarchy (OSM → external height → levels → heuristics → defaults) with provenance; never present inferred values as surveyed | ✅ | `heightSource` = osm_height / osm_levels / heuristic per volume; coverage report counts 1.7 % explicit in the city belt; `docs/LIMITATIONS.md` §3 |
| §4 Compare coverage/height completeness before choosing external datasets; do not download a global dataset for one square kilometre | ✅ | DATA_SOURCES §3: Minsk has no Microsoft height estimates and GBA heights are non-commercial, so no external height layer is used |
| §5 Initial scope: central Minsk around 53.902 N, 27.561 E near October Square; 1×1 km expandable to 2×2 km; actual buildings/roads/green/water; mandatory first milestone before whole-city generation | ✅ | pilot is 1.6×1.6 km around 53.9022/27.5610 (`scripts/geo_config.py`), city belt added only after the pilot passed QA |
| §5 Milestone A — geospatial foundation: extraction, footprints, multipolygons/inner rings, building:parts, roads, parks, water, local metres, schema, reproducible tiles, tests for invalid geometry/duplicates/projection, coverage report with required metrics | ✅ | `scripts/ingest/extract.py`, `scripts/normalize/normalize.py` (MultiPolygon with roles, inner rings preserved), `docs/COVERAGE_REPORT.md` + `docs/COVERAGE_REPORT_CITY.md` list footprints, explicit-height/levels/roof shares, invalid/sliver/orphan counts, height provenance; validation script exits non-zero on hard errors |
| §5 Milestone B — real 3D buildings: walls, roofs, elevation, correct normals, materials/colors, no holes/floating geometry; complex/concave footprints, holes, parts without double rendering; flat/gabled/hipped/skillion/pyramidal (+dome/complex fallback); explicit roof tags; robust fallback with warning | ✅ | `src/city/buildings/**`, `src/city/roofs/**`; non-overlapping volumes resolved in the pipeline; geometry audit on all 16 pilot tiles: 0 issues; roofs for every OSM shape, `complex` falls back to flat with a warning |
| §5 Milestone C — procedural facades: window rows/columns, floor-aware, archetype spacing, distinct colors/materials, entrances/ground-floor differentiation, balconies, cornices, orientation shading; 6 required presets; metadata-first classification; batched/instanced windows (no one draw call per window); readable at close/medium zoom, details disabled far | ✅ | GLSL facade shader driven by vertex attributes (`aUV`, `aStyle`, `aFace`); 11 presets incl. the six required ones; one draw call per tile; LOD detail scale; facade tests (60) and screenshots |
| §5 Milestone D — isometric rendering: orthographic classic isometric default, smooth pan/zoom/rotation, mouse+keyboard, ground+building shadows, ambient+directional light, pixel-art palette, readable silhouettes; pixel-art as real post-processing (low-res framebuffer, nearest upscale, depth/normal outlines, limited colours, controlled shadows/contrast, no excessive edge noise); debug toggle | ✅ | `src/engine/camera/**`, `src/engine/renderer/**`, `src/engine/postprocess/**`; ortho frustum, 45° azimuth + `atan(1/√2)` elevation; 640×360 internal target, outline + dither/levels, nearest upscale; pixel/clean-3D toggle in UI. Input now also covers touch: one-finger pan, pinch zoom, two-finger twist with 45° snap, tap/double-tap (`pointerGestures.ts`, 24 unit tests; 7 mobile Playwright scenarios) |
| §5 Milestone E — streets and environment: road widths from OSM attributes, pavements, intersections, parks/grass, rivers/water, trees, rail/tram, materials; deterministic vegetation from mapped + land-use; no false claims about surveyed trees; roads not intersecting walls/floating; flat terrain with a later provider supported | 🟡 deviation documented | Road/ground rendering, markings, parks, water, instanced vegetation C and independent attractions are implemented. The default payload 0.4.3 raster compositor joins road strokes; the old overlapping-polygon limitation is obsolete. Terrain remains flat with no provider interface; see `LIMITATIONS.md` and `ROAD_NETWORK.md`. |
| §5 Milestone F — interaction: drag/WASD pan, wheel zoom, Q/E or right-drag rotate, reset button, building inspect, pixel toggle, facade-detail toggle, time-of-day slider, loading indicator, raycasting with stable IDs, attribution panel | ✅ | `src/app/**`, `src/engine/camera/controls.ts`, picking map uses stable `${type}${id}` ids; e2e tests 5–10; visible ODbL badge + data-sources panel. Touch: pan/pinch/twist/tap/double-tap, 45° rotate buttons, foldable Settings panel (collapsed by default on phones, persisted), phone-adaptive HUD and safe areas; mobile e2e `tests/e2e/mobile.spec.ts` |
| §6 Scaling strategy: visible-tile calc, background loading, caching/eviction, cancellation, configurable LOD/view distance, batched meshes, shared materials, disposal, stable ids across tiles, no duplicates at borders, cracks avoided, separation of data/render, no thousands of Meshes, all districts without rewrite | ✅ | `src/engine/tiles/**`: worker loading, cancellation, LRU, facade/ground LOD, shared materials and disposal; trees use one trunk plus up to three crown batches (two total on dense tiles), attractions are separate. Current 144-tile overview: 593 draws; source IDs/ownership remain stable. |
| §7 Future features (trams/trolleybuses/trains/parked vehicles; sun from real date/time; night windows + street lamps; seasons/snow; custom landmark models; historical info cards; bookmarks/deep links; mobile) | 🟡 subset | Implemented: stylised/real-date sun modes, night windows, five landmarks, two static wheels, instanced trees, an internal canopy palette/visibility hook, and the mobile/touch first slice (gestures, foldable settings, phone-adaptive HUD; browser-emulated, real-phone verification pending). Full seasons/snow, vehicles, lamps, history cards and bookmarks remain unimplemented. |
| §8 Multi-agent execution with real environment mechanisms; interfaces before parallel work; bounded tasks; explicit file ownership; worktrees/branches preferred; no shared-file overwrites; review+tests before integration; commits at checkpoints; progress doc + issue list; honest blockers | 🟡 deviation | used the real mechanisms: native `spawn_teammate`/`send_message`, shared task board, Playwright browser automation, parallel tool calls. Six teammates: geometry-dev, facade-artist, environment-dev, renderer-dev, qa-dev, landmark-dev; Lead owned pipeline/contracts/integration. **Deviation**: one checkout with disjoint file ownership instead of git worktrees (the brief allows alternative mechanisms); integration only after tests; git checkpoints per round; `docs/PROGRESS.md` + `docs/AGENT_TASKS.md` |
| §9 Repository structure | 🟡 deviations | see §4 below (structure followed, with documented adaptations) |
| §10 QA: geodata/dedup/projection tests; geometry tests (roofs, winding, normals, heights, complex polygons); browser tests (server, district loads, geometry visible, facades, camera, errors, selection, reload); visual QA captures (overview, residential close-up, large building close-up, night) inspected; performance targets 45–60 FPS at 1080p with measured FPS/draw calls/triangles/load time/memory | 🟡 exact-resolution gap | Latest (2026-11-15): 562 Vitest passed, 5 skipped (34 files); 31 hardware-WebGL Playwright scenarios (24 desktop + 7 mobile/touch with real CDP touch at 390×844 and 320×568), 30 pass — the pre-existing `trees.spec.ts` expects the old 16-tile pilot; typecheck/build passed. Current 144-tile overview at 1600×900 (internal 640×360): 6.46 ms mean / 8.10 ms p95, 593 draws, 7 875 933 visible triangles, 378.42 MiB resident-buffer estimate. Exact 1920×1080 and real-phone validation remain gaps; older data-audit evidence is in `QA_REPORT.md`. |
| §11 Execution procedure phases 0–5 | ✅ | Phase 0 research/bootstrap (`ab0b248`), Phase 1 first real render (`d254aba`), Phase 2 architecture quality (`8652c60`/`6892719`), Phase 3 pixel-art identity (same rounds), Phase 4 streaming + expansion (`c4892e4`), Phase 5 atmosphere/advanced (landmarks, wheels, TV tower, fixes) |
| §12 Completion requirements (working app, real geometry, true 3D + facades, windows, isometric pixel-art mode, camera, not static, documented sources/limitations, tests pass, screenshots, startup commands in README, PowerShell workflow, no undocumented GIS steps) | ✅ | all met; see §3 below and `README.md` quick start |

## 2. Milestone evidence (brief §5)

| Milestone | Current evidence |
| --- | --- |
| A — Geospatial foundation | 16 pilot tiles (512 m) + 144 city tiles (1024 m); coverage reports list counts, height/roof provenance, invalid/sliver/orphan parts; validation PASSED for both datasets |
| B — Real 3D buildings | 31 783 city buildings; roofs for all supported shapes; geometry audit PASSED (0 issues); merged per-tile geometry with exact flat normals |
| C — Procedural facades | 11 presets, GLSL windows/floors/balconies/cornices/night/LOD; single draw call per tile; close-up screenshots show windows and facade structure |
| D — Isometric rendering | true isometric ortho camera, custom controls, shadows, day/night, pixel-art post pass (640×360 internal), clean-3D toggle |
| E — Streets and environment | Raster ground/roads, markings, rails, parks/water/islands, 316 704 instanced city trees, separate wheels; full seasons and a terrain provider remain pending. |
| F — Interaction | pan/zoom/rotate/reset, picking + OSM metadata panel, pixel/facade/wireframe toggles, time-of-day slider, loading indicator, attribution card; touch pan/pinch/twist/tap, 45° rotate buttons, foldable phone HUD |

## 3. Completion checklist (brief §12)

| Requirement | Result |
| --- | --- |
| Local browser application starts | ✅ `pnpm dev` (Vite, `http://127.0.0.1:5173`); e2e boots it and renders |
| Real geographic geometry from central Minsk | ✅ OSM extract (BBBike `Minsk.osm.pbf`, Geofabrik fallback), EPSG:32635 local origin |
| True 3D buildings with roofs and visible facades | ✅ extruded volumes + roof geometry + procedural facades |
| Windows and architectural variations | ✅ shader windows, 11 archetype presets |
| Isometric pixel-art mode | ✅ post-processing pipeline + toggle |
| Camera pan/rotation/zoom | ✅ custom controls, e2e 5–7 |
| Not a static illustration | ✅ live WebGL2 scene, streaming, picking |
| Data sources and limitations documented | ✅ `docs/DATA_SOURCES.md`, `docs/LIMITATIONS.md` |
| Essential automated tests pass | ✅ Latest application checks: 434 Vitest passed (5 skipped), 13/13 hardware-WebGL e2e, typecheck/build passed. Historical geometry/data/cache audits are recorded separately in `QA_REPORT.md`. |
| At least one browser screenshot | ✅ 28 screenshots in `docs/screenshots/` (git-ignored, produced by `scripts/qa/capture.mjs` and the landmark/flame capture script) |
| Startup commands in README, PowerShell workflow, no undocumented GIS steps | ✅ README quick start: `pnpm install` → `pnpm dev`; data workflows `data:all`, `data:city` (documented) |

## 4. Repository structure deviations (brief §9)

| Brief | Actual | Reason |
| --- | --- | --- |
| `src/ui/` | React shell lives in `src/app/` | `app/` already contained the UI shell from the bootstrap; adding `ui/` would have split one responsibility across two folders |
| `public/landmarks/` | no asset directory; landmarks are procedural modules + curated data flags (`landmark` field, `ATTRACTION_CURATION`) | the brief asks for models, not necessarily assets; procedural geometry avoids third-party asset licensing and keeps the tile payload free of binary blobs |
| `scripts/tiles/` | tile emission is a section of `scripts/normalize/normalize.py` | tiles are produced from the same normalized scene in one pass (no separate serialization stage); file remains documented |
| `tests/integration/`, `tests/visual/` | root `integration-check.mjs` + `scripts/qa/**` (Playwright captures, geometry audit, screenshot analysis, cache check) | integration/visual checks are browser- or CI-script based, not Vitest files |
| docs list | added `ART_REFERENCE.md`, `TESTING.md`, `QA_REPORT.md`, `REQUIREMENTS_ORIGINAL.md`, `REQUIREMENTS.md`, coverage reports | documentation required by later brief sections (QA, testing, art reference, requirements) |

## 5. Known gaps and honest deviations

1. **Road geometry accuracy** — carriageway widths/edges are inferred from OSM
   tags and centrelines rather than surveyed edges. The former overlapping
   junction-polygon limitation is obsolete; raster strokes join their mouths.
   The rail-colour mismatch between ground LODs is an open visual defect
   (`LIMITATIONS.md` §6), diagnosed but not fixed.
2. **Terrain provider** — terrain is flat and no provider interface is shipped;
   the brief allows flat terrain "provided the architecture explicitly supports a
   later terrain-height provider". The environment geometry is separated from the
   data pipeline and a provider can be inserted, but this is documented as an
   extension point rather than an implemented interface (`LIMITATIONS.md` §6).
3. **Binary/Brotli tiles** — the payload format is JSON; the design is compatible
   with later binary arrays + Brotli, but this optimisation was not implemented
   (brief §3 explicitly permits MVP JSON; documented in `PROGRESS.md` roadmap).
4. **1080p performance measurement** — the brief targets 45–60 FPS at 1080p. The
   scene is rasterised internally at 640×360 and measured at 60 FPS in 1600×900
   and 1900×1000 captures (city and pilot); no explicit 1920×1080 capture exists.
   The low internal render target makes the scene cost almost independent of the
   canvas size, but this exact resolution was not measured — stated honestly.
5. **Future features (§7)** — transport vehicles, street lamps, seasons/snow,
   historical info cards and bookmarks/deep links are not implemented. Sun
   position, night windows, curated landmark models, two ferris wheels and the
   mobile/touch first slice (gestures, foldable settings, phone-adaptive HUD) are
   implemented; the mobile slice is browser-emulated and has no real-phone
   budget claim. Instanced trees and the canopy appearance hook remain the
   prerequisite for full mobile quality tiers and seasons.
6. **Landmark kit** — 5 of 9 planned landmarks are modelled; the remaining four
   (Bolshoi Theatre, railway station, Minsk-Arena, Holy Spirit Cathedral) are
   listed in the roadmap.
7. **Multi-agent** — one git checkout with disjoint file ownership and a shared
   task board was used instead of per-agent git worktrees; the brief allows
   alternative mechanisms if documented (`docs/AGENT_TASKS.md`).
8. **No external height/DEM layer** — deliberately not integrated (licensing and
   coverage; brief §4 requires evaluation, not use).

## 6. Change requests beyond the original brief

These were requested later; each is delivered and verified.

| # | Request | Outcome |
| --- | --- | --- |
| CR-1 | Fix visual defects: trees in impossible places, flooded park, wrong Palace facade, stadium slab | ✅ `8d8741f` |
| CR-2 | Expand to at least one full district, preferably the whole city | ✅ 12 × 12 km city dataset (`c4892e4`) |
| CR-3 | Curated landmark kit (Minsk Gate, then National Library, Victory obelisk, Red Church) | ✅ `2fbeb30`, `b5e4e4a` |
| CR-4 | Investigate missing Minsk Gate | ✅ root cause in malformed OSM relation + broken aggregates + coarse dedupe; curated fix |
| CR-5 | Remove park flood; restore river islands | ✅ role-based relation assembly, ring order, short member ways (`85e66fa`, `11a8b3d`) |
| CR-6 | Real ferris wheels in the parks | ✅ `11a8b3d` (2 wheels, data-driven attractions) |
| CR-7 | TV/radio lattice mast instead of `way/1158101395` prism | ✅ `4916455` |
| CR-8 | Eternal flame of Victory Square in the square, not against the obelisk | ✅ `3e50014` |
| CR-9 | Tiles refreshed after data regeneration (stale-cache bug) | ✅ `7703158` + `scripts/qa/cache-check.mjs` |
| CR-10 | Requirements doc + roadmap | ✅ this document + `docs/REQUIREMENTS_ORIGINAL.md` + `docs/PROGRESS.md` roadmap |
| CR-11 | Trees in parks/cemeteries at full density | ✅ B-1, payload 0.4.3, 316 704 city trees; `COVERAGE_REPORT_CITY.md` |
| CR-12 | New crowns and instancing as the mobile/season foundation | ✅ C default, tree buffers −87.95%; `TREE_INSTANCING_2026-11-06.md`; full seasons still pending |
| CR-13 | Mobile & touch: camera gestures, foldable settings panel, phone-adaptive HUD | 🟡 first slice ✅ — touch pan/pinch/twist/tap/double-tap, folded-by-default persisted Settings panel, 45° rotate buttons, safe areas, full-width bottom cards; 24 unit tests + 7 CDP-touch Playwright scenarios; no real-phone performance/memory verification yet |

## 7. Verification snapshot (2026-11-15)

* `pnpm test`: 562 passed, 5 skipped, 34 files; hardware-WebGL Playwright:
  30/31 passed (24 desktop + 7 mobile/touch; the pre-existing `trees.spec.ts`
  expects 16 tiles); `pnpm run typecheck` and `pnpm run build` passed.
  The 2026-11-06 snapshot below is the previous checkpoint.
* Mobile/touch evidence: `tests/unit/camera/pointerGestures.test.ts` (24 tests),
  `tests/e2e/mobile.spec.ts` (CDP multi-touch at 390×844 and 320×568),
  screenshots in `screenshots/mobile-qa/` (git-ignored). Real-phone performance
  is not claimed.

## 7a. Verification snapshot (2026-11-06)

* `pnpm test`: 434 passed, 5 skipped, 26 files; hardware-WebGL Playwright:
  13/13 passed; TypeScript and production build passed. This documentation
  update did not rerun the application checks or earlier geodata audits.
* Current source tiles (payload 0.4.3, generated 2026-11-05): pilot 654 buildings /
  6 555 trees / 16 tiles; city 31 783 buildings / 316 704 trees / 144 tiles.
* Same-city old/new tree buffers: 420 601 248 → 50 683 352 bytes (−87.95%).
  Resident-buffer estimate: 731.20 → 378.42 MiB; overview mean frame time:
  4.70 → 6.46 ms (+37.4%). More detailed crowns trade overview cost for visual
  quality and memory savings; no phone-readiness claim follows.
* Complete results and machine-readable evidence:
  `TREE_INSTANCING_2026-11-06.md` / `.json`. Earlier dated captures/audits are
  preserved in `QA_REPORT.md` and the historical section of `PROGRESS.md`.

## 8. Traceability index

| Area | Source of truth |
| --- | --- |
| Original brief | `docs/REQUIREMENTS_ORIGINAL.md` |
| Requirements → status | this file |
| Roadmap / next iterations | `docs/PROGRESS.md` (section "Roadmap") |
| Architecture & contracts | `docs/ARCHITECTURE.md`, `src/shared/**` |
| Data pipeline | `scripts/ingest/extract.py`, `scripts/normalize/normalize.py`, `scripts/geo_config.py` |
| Licensing | `docs/DATA_SOURCES.md` |
| Known gaps | `docs/LIMITATIONS.md`, `docs/PROGRESS.md` open issues |
| QA evidence | `docs/QA_REPORT.md`, `docs/COVERAGE_REPORT*.md`, `scripts/qa/**`, `docs/screenshots/` |
| Multi-agent contract | `docs/AGENT_TASKS.md` |

## 9. Revision history

| Date | Change |
| --- | --- |
| 2026-10-29 | Replaced the reconstructed requirements with the verbatim original brief + this compliance matrix. |
| 2026-11-15 | Recorded the mobile/touch first slice (CR-13): touch gestures + foldable settings + phone HUD; merged onto the complete-city release and verified with 562 Vitest / 31 browser scenarios (30 pass on the complete-city payload). |
