# Project progress — Isometric Minsk

Living document. Status is updated only after the work has actually run.
Legend: ✅ done & verified · 🟡 implemented, verification pending · ⏳ in progress · ❌ blocked

## Current state

**Delivered: an interactive isometric pixel-art 3D map of Minsk, generated from
real OpenStreetMap geometry.** Two datasets are supported:

* **central pilot (committed, default)** — 1.6 × 1.6 km around October /
  Independence Square, 16 × 512 m tiles, ~1.9 MiB; and
* **city belt (generated locally, `?dataset=city`)** — 12 × 12 km, 144 × 1024 m
  tiles, 31 779 buildings, ~59 MiB, all inner districts (`pnpm run data:city`).

The renderer streams tiles nearest-first with a bounded resident set, fits the
camera to the dataset bounds, and draws real buildings with walls, roofs and
procedural facades, avenues, pavements, tram rails, parks, the Svislach river,
deterministic vegetation, cast shadows, day/night lighting and building
selection with OSM metadata.

Acceptance screenshots: `docs/screenshots/` (overview, close-up, detail, night,
golden hour, clean 3D debug).

### Defect-fix round (after first visual review)

| Reported defect | Root cause | Fix |
| --- | --- | --- |
| Trees in impossible places | heuristic trees scattered by a jittered grid over any green polygon, no exclusion masks | STRtree exclusion masks (buildings, roads, water, pitches, plazas, construction, rail), density by land-use class, narrow-strip rejection, mapped OSM trees filtered out of hard surfaces (70 of 216 dropped) |
| Yanka Kupala park "flooded diagonally" | river/canal **centre lines** were buffered into 20+ m water bands, synthesising water where OSM only has an axis | water only from mapped areas; centre lines limited to ≤6 m streams and skipped where an area exists; unpaved footways that are >50 % over water dropped |
| Palace of the Republic facade wrong | generic `civic` preset | new `palace` archetype + preset (colonnade rhythm, glazed loggia, paired windows, double cornice) and massing accents (plinth/cornice/attic bands) |
| Dynamo stadium was an oval slab | every `building=*` was extruded | new `stadium` archetype: arena bowl (outer wall, sloped stands, inner rim, pitch), grandstands as blank rakes; 18 stadiums in the city dataset |


## Milestones

| Milestone | Status | Evidence |
| --- | --- | --- |
| A — Geospatial foundation | ✅ | 654 buildings, 679 surfaces, 3251 road/rail polygons, 3775 trees in 16 × 512 m tiles; validation PASS; `docs/COVERAGE_REPORT.md` |
| B — Real 3D buildings | ✅ | merged per-tile geometry; ~65 000 triangles for 905 volumes; flat normals exact; all roof shapes; 53 unit tests; geometry audit 0 issues on all 16 tiles |
| C — Procedural facades | ✅ | GLSL facade material: window grids, dark day glass, ground-floor bands + shopfronts, cornices, balconies, night windows, LOD detail; 9 archetype presets; 60 facade tests |
| D — Isometric pixel-art rendering | ✅ | ortho camera + custom controls, tile streaming with LRU/cancel/worker pool, low-res target + depth-outline + dither/levels post pass, nearest upscale, artt-directed shadows, pixel-art vs clean-3D toggle |
| E — Streets and environment | ✅ | roads/pavements/kerbs/markings/tram rails/bridges, parks, water banding, deterministic trees; ≤10.7k env tris/tile; 67 unit tests |
| F — User interaction | ✅ | pan/zoom/rotate/reset, picking + info panel with stable OSM ids, pixel toggle, facade toggle, wireframe, time-of-day slider, loading indicator, visible ODbL attribution |
| Scaling (all Minsk) | ❌ not started | design in `docs/ARCHITECTURE.md` §7; streaming/LRU already in place for a larger tile range |

## Verified numbers (headless Chromium, ANGLE/D3D11, RTX 3080 Laptop)

**Central pilot dataset** (1600×900):
* 654 buildings, 16 tiles resident, 368 411 triangles (data grew after the
  vegetation/water/stadium fixes), 81 draw calls, 60 FPS, 640×360 internal
  pixel-art resolution, ~26 MB GPU geometry, 0 console/page errors.

**City dataset** (12 × 12 km, 1900×1000):
* Full overview with **all 144 tiles resident: 424 draw calls, 4 025 546
  triangles, 31 779 buildings, 542 MB GPU geometry, 60 FPS**; app ready in
  8.6 s warm / 23.9 s cold. The ground plate hides itself once the resident set
  covers the view, so the finished overview is a clean floating diamond.
* District (orthoHeight 1400): 60 FPS, 95 draws, 902 670 triangles, 49 visible
  tiles. Close-up (orthoHeight 80): 60 FPS, 12 draws, 200 870 triangles, shadows
  enabled. Shadows auto-disable above 3.2 km orthoHeight (a 2048² map across a
  10 km footprint would show its edge).
* Payload: 144 × 1024 m tiles, 58.7 MiB JSON uncompressed (git-ignored; generated
  locally with `pnpm run data:city`).

**General**
* Day overview: mean luminance 108/255, 0 % near-black. Night (22:30): mean
  39/255 with sparse warm lit windows.
* Tests: **237/237 unit** (Vitest), **12/12 browser e2e** (Playwright, hardware
  GPU), 18/18 Lead integration checks, `tsc --noEmit` clean, `vite build` ✓.
* Data coverage (pilot): 10.6 % explicit `height`, 56 % from `building:levels`,
  33.5 % heuristic; 46.6 % explicit `roof:shape`. City belt: 1.9 % / 37.7 % /
  60.4 %, reflecting sparser tagging outside the centre.
* Archetype spread in the city belt: small 20 240, historic 3 917, panel 2 166,
  Khrushchev 1 650, office 1 684, civic 991, industrial 817, Stalin 431,
  modern 80, palace 5, stadium 18.

## Open issues / known limitations (all documented)

| # | Issue | Severity | Notes |
| --- | --- | --- | --- |
| 1 | Roof-shape mix is heuristic outside tagged buildings (~68 % pitched in the centre, similar in the city) | medium | `heightSource`/`roofShapeExplicit` provenance is recorded per volume; a statistical roof model per district is the next quality step |
| 2 | Palace/landmark trim bands (plinth/cornice/attic, 0.35 m overhang) read as a dashed 1-px outline at far zoom | cosmetic | visible on the Palace of the Republic roof edge; reduce overhang or merge into the roof face if it bothers |
| 3 | Payload is uncompressed JSON (58.7 MiB for the city belt) | low | gzip ≈ 24 %; binary + Brotli encoding is the next scalability step |
| 4 | Some vegetation is procedurally placed (140 000 instances city-wide) | low | `TreeInstance.mapped` distinguishes surveyed from inferred; UI/docs say so |
| 5 | Underground objects (metro, passages) are not rendered | low | deliberate: they painted black strips on squares in an early build |
| 6 | Flat terrain (no DEM) | low | terrain-height provider is the extension point; see `docs/DATA_SOURCES.md` |
| 7 | Landmark facades are still generic presets (no per-building modelling except the palace archetype) | medium | a landmark kit (20–40 curated buildings) is the highest-value next investment |

## Multi-agent execution

Five parallel agents (building geometry, facades/art direction, environment,
renderer, QA) worked in the same checkout with disjoint file ownership; the Lead
owned the data pipeline, shared contracts, the React shell, integration and final
acceptance. See `docs/AGENT_TASKS.md`.
