# Requirements — Isometric Minsk

> **Provenance.** This document is a *reconstruction* of the project requirements,
> written on 2026-10-29 from the original project brief and the change requests
> made during the working sessions. The original brief was never stored as a
> repository artifact — this file is the requirements baseline going forward.
> Where a requirement was added later it is marked as a change request (§5).
> Verification status is only claimed from artifacts that actually exist
> (tests, audits, captures, commits), never from intent.

## 1. Product goal

Build a **working, interactive isometric pixel-art 3D map of central Minsk**,
generated from **real OpenStreetMap geometry**, visually inspired by
[bedirhanyildirim.com/warsaw-izo](https://bedirhanyildirim.com/warsaw-izo/).

Priorities, in the order stated by the project owner:

1. A working application first (not a static mock-up or a data dump).
2. Accurate real footprints, positions and heights — nothing invented where OSM
   has data; inferred values must be labelled as inferred.
3. Recognisable architecture: real facades, roofs, landmarks and park features.
4. A genuine pixel-art rendering pipeline (not a CSS filter over a 3D scene).
5. Full camera control, tile streaming, tests and honest documentation.
6. Then widen the area: at least one full city district, ideally the whole city,
   to judge how the procedural generator handles different urban fabric.

## 2. Functional requirements

Status legend: ✅ delivered & verified · 🟡 partially delivered · ⏳ planned ·
❌ not planned.

| ID | Requirement | Status | Evidence |
| --- | --- | --- | --- |
| FR-1 | Offline data pipeline from a public OSM extract (WGS84 → local metres) producing per-tile JSON payloads: buildings with volumes/roofs, roads, surfaces/water, trees, rails | ✅ | `scripts/ingest/extract.py`, `scripts/normalize/normalize.py`, `docs/ARCHITECTURE.md` §1–3, `docs/COVERAGE_REPORT*.md` |
| FR-2 | Real building massing: extruded footprints, every OSM `roof:shape` (flat, gabled, hipped, pyramidal, skillion, dome, complex fallback), heights from OSM with provenance (`heightSource`) | ✅ | `src/city/buildings/**`, `src/city/roofs/**`, 321 unit tests, `docs/LIMITATIONS.md` §3 |
| FR-3 | Procedural facades with no textures: window grids, ground-floor bands/shopfronts, cornices, balconies, night windows, LOD detail; archetype-driven presets | ✅ | `src/city/facades/**`, facade shader tests, `docs/screenshots/03-night.png` |
| FR-4 | Environment: roads/pavements/kerbs/markings/tram rails/bridges, parks/forest/grass, water surfaces, deterministic vegetation (mapped + heuristic), correct layer ordering | ✅ | `src/city/environment/**`, `src/city/roads/**`, environment tests, `docs/screenshots/19-komsomolskoye-islands.png` |
| FR-5 | True isometric orthographic camera (45° azimuth, `atan(1/√2)` elevation) with pan, cursor-anchored zoom, rotation and reset | ✅ | `src/engine/camera/**`, e2e tests 5–7, `src/shared/config.ts` |
| FR-6 | Real pixel-art pipeline: low-resolution raster target, depth/normal outline, colour quantisation + dithering, nearest-neighbour upscale; clean-3D comparison toggle | ✅ | `src/engine/postprocess/**`, e2e test 9, `docs/ART_REFERENCE.md` |
| FR-7 | Tile streaming with nearest-first order, bounded resident set (LRU), cancellation, worker-pool geometry build; no geometry cracks across tiles; tiles revalidated so data updates appear on refresh | ✅ | `src/engine/tiles/**`, `scripts/qa/cache-check.mjs`, e2e tests 2–3, 11 |
| FR-8 | Building picking with info panel (name, address, archetype, height, floors, roof, OSM tags, stable OSM id) | ✅ | `src/engine/picking/**`, `src/app/**`, e2e test 10 |
| FR-9 | Time-of-day slider (night windows), facade-detail toggle, pixel-art toggle, debug wireframe, loading indicator, visible ODbL attribution with data-sources panel | ✅ | `src/app/**`, e2e tests 8–9 |
| FR-10 | Two datasets: a small committed pilot (instant start) and a generated 12 × 12 km city belt via `?dataset=city` (`pnpm run data:city`) | ✅ | `public/data/tiles/`, `docs/PROGRESS.md` verified numbers |
| FR-11 | Curated landmark kit: iconic buildings get dedicated procedural geometry derived from real OSM footprints/parts instead of generic extrusion | 🟡 5 of 9 planned: Minsk Gate, National Library, Victory obelisk, Red Church, TV tower. Remaining: Bolshoi Theatre, railway station, Minsk-Arena, Holy Spirit Cathedral | `src/city/buildings/landmarks.ts` + `cityGate.ts`, `nationalLibrary.ts`, `victoryObelisk.ts`, `redChurch.ts`, `tvTower.ts`; landmark tests and screenshots 11–18, 25–28 |
| FR-12 | Park attractions as real geometry: the two Minsk ferris wheels (Gorky Park, Chelyuskintsev Park) with supports, rims, cabins, platform and beacon | ✅ | `src/city/environment/ferrisWheel.ts`, `TileData.attractions`, 19 wheel tests, `docs/screenshots/22`–`24` |
| FR-13 | Reported visual/data defects must be diagnosed from data and fixed (not hidden): trees in impossible places, flooded park, missing river islands, wrong Palace facade, stadium as slab, missing Minsk Gate, TV tower as a prism, misplaced eternal flame, stale tiles after data regeneration | ✅ | defect table in `docs/PROGRESS.md`; commits `8d8741f`, `2fbeb30`, `85e66fa`, `7703158`, `11a8b3d`, `4916455`, `3e50014` |
| FR-14 | Documentation set: architecture, data sources/licences, progress/roadmap, limitations, QA report, testing guide, requirements | ✅ | `docs/ARCHITECTURE.md`, `DATA_SOURCES.md`, `PROGRESS.md`, `LIMITATIONS.md`, `QA_REPORT.md`, `TESTING.md`, this file |
| FR-15 | Automated QA: unit/data tests, browser e2e, geometry audit, data validation, screenshot capture, tile-cache regression | ✅ | `pnpm test` 321/321, `pnpm test:e2e` 12/12, `scripts/qa/**`, `docs/TESTING.md` |

## 3. Non-functional requirements

| ID | Requirement | Status | Evidence |
| --- | --- | --- | --- |
| NFR-1 | Deterministic pipeline: same PBF + same scripts produces byte-identical tiles | ✅ | documented in README; `data:all` workflow |
| NFR-2 | Licensing discipline: only ODbL/permissive sources; non-commercial datasets excluded and documented | ✅ | `docs/DATA_SOURCES.md` (§4 licence conclusions) |
| NFR-3 | Honesty: every inferred height/roof documented; known gaps listed rather than papered over | ✅ | `docs/LIMITATIONS.md`, provenance fields in the data |
| NFR-4 | Performance: 60 FPS at the pilot overview and at full-city residency on the reference machine; interactive picking/controls | ✅ | 60 FPS, city 4 010 150 triangles / 424 draw calls / 540 MB geometry |
| NFR-5 | Maintainability: strict TypeScript, frozen shared contracts, single-responsibility modules, no committed generated bulk data | ✅ | `tsc --noEmit` clean, `src/shared/**`, `.gitignore` (city tiles ignored) |
| NFR-6 | Reproducibility: documented one-command data, dev, test, e2e, capture workflows | ✅ | `README.md` quick start, `docs/TESTING.md` |
| NFR-7 | Budget discipline: the work must not balloon in time/cost; reuse of existing assets/references instead of re-modelling everything | ✅ | city dataset reused from one PBF; landmark kit derived from measured references |
| NFR-8 | Windows 11 / PowerShell working environment, Python 3.11 + pnpm toolchain | ✅ | README requirements, scripts |

## 4. Acceptance criteria

| ID | Criterion | Current result |
| --- | --- | --- |
| AC-1 | App loads the committed dataset and renders a non-empty city with no console/page errors | ✅ e2e 1–4; 0 errors |
| AC-2 | Camera controls change the rendered image / camera state | ✅ e2e 5–7 |
| AC-3 | Display toggles and time of day visibly change the frame | ✅ e2e 8–9 |
| AC-4 | Clicking a building opens the info panel with real OSM metadata | ✅ e2e 10 |
| AC-5 | Five-minute interaction run and page reload stay error-free | ✅ e2e 11–12 |
| AC-6 | Full unit/data suite and typecheck are green | ✅ 321/321, `tsc` clean |
| AC-7 | City belt renders at 60 FPS with all 144 tiles resident | ✅ 424 draws, 4 010 150 tris, 540 MB |
| AC-8 | Every reported defect has a documented root cause, a verified fix and a screenshot/regression check where visual | ✅ defect table + screenshots 19–28, cache-check script |
| AC-9 | Docs let a new maintainer rebuild data, run tests and understand what is inferred vs surveyed | ✅ README, ARCHITECTURE, DATA_SOURCES, LIMITATIONS, TESTING |

## 5. Change requests (scope evolution)

| # | Request (chronological) | Outcome |
| --- | --- | --- |
| CR-1 | Fix reported defects: trees in impossible places, Yanka Kupala park flooded diagonally, wrong Palace of the Republic facade, Dynamo stadium as an oval slab | ✅ fixed (`8d8741f`): exclusion masks, polygon-only water, `palace`/`stadium` archetypes |
| CR-2 | Extend coverage at least to one full district, preferably the whole city, to test the procedural generator on diverse fabric | ✅ 12 × 12 km city dataset (`c4892e4`), all 144 tiles verified |
| CR-3 | Curate iconic landmarks (Minsk Gate first, then National Library, Victory obelisk, Red Church) | ✅ `2fbeb30`, `b5e4e4a`; landmark contract + registry + 4 modules |
| CR-4 | «Почему ворота города отсутствуют?» — investigate missing City Gate | ✅ root cause: malformed OSM relation + broken aggregate ways + coarse dedupe; curated fix |
| CR-5 | Remove the park flooding and restore missing river islands | ✅ relation assembly by roles, GeoJSON ring order, short member ways kept (`85e66fa`, `11a8b3d`) |
| CR-6 | Add the two ferris wheels as real models | ✅ `11a8b3d`; OSM `attraction=big_wheel` nodes + curated dimensions |
| CR-7 | Replace `way/1158101395` (a white prism) with the real TV/radio lattice mast | ✅ `4916455`; 176 m procedural lattice from the measured profile |
| CR-8 | Fix the eternal flame of Victory Square (should stand in the square, not against the obelisk) | ✅ `3e50014`; real OSM position of `way/1308903766` |
| CR-9 | After a data regeneration the page kept showing old geometry — explain/fix | ✅ `7703158`; tiles are revalidated (`no-cache`), regression check `scripts/qa/cache-check.mjs` |
| CR-10 | Make the roadmap and the initial-requirements doc available | ✅ this file + roadmap section in `docs/PROGRESS.md` |

## 6. Explicit non-goals

* No interiors, no per-floor detail, no stairs/elevators.
* No terrain/DEM: the ground is flat (`docs/LIMITATIONS.md` §6).
* No underground objects (metro, passages) as visible surfaces.
* No live OSM updates or backend: the app is a static Vite site over generated JSON.
* No photorealistic textures: facades are procedural shader geometry.
* No custom model for every building: only the curated landmark kit is bespoke;
  everything else is the procedural generator.
* No turn-by-turn navigation, routing or search beyond the building info panel.
* Not a commercial product; the data licences keep it an ODbL/non-commercial
  prototype (see `docs/DATA_SOURCES.md`).

## 7. Traceability quick index

| Area | Source of truth |
| --- | --- |
| Coordinates & payload schema | `src/shared/types.ts`, `src/shared/config.ts`, `docs/ARCHITECTURE.md` §2–3 |
| Data pipeline | `scripts/ingest/extract.py`, `scripts/normalize/normalize.py`, `scripts/geo_config.py` |
| Curated data fixes / landmarks / attractions | `docs/DATA_SOURCES.md` §7, `src/city/buildings/landmarks.ts`, `ATTRACTION_CURATION` in `normalize.py` |
| Renderer | `src/engine/**`, `docs/ARCHITECTURE.md` §4 |
| Geometry | `src/city/**`, tests under `tests/unit/{buildings,roofs,environment,facades}` |
| QA evidence | `docs/QA_REPORT.md`, `docs/COVERAGE_REPORT*.md`, `screenshots/` (git-ignored), `scripts/qa/**` |
| Known gaps | `docs/LIMITATIONS.md`, open-issues table in `docs/PROGRESS.md` |

## 8. Revision history

| Date | Change |
| --- | --- |
| 2026-10-29 | Reconstructed the requirements baseline from the project brief and change requests; added the current verification matrix and non-goals. |
