# Project progress — Isometric Minsk

Living document. Status is updated only after the work has actually run.
Legend: ✅ done & verified · 🟡 implemented, verification pending · ⏳ in progress · ❌ blocked

## Current state

**Delivered: an interactive isometric pixel-art 3D map of central Minsk, generated
from real OpenStreetMap geometry.** The browser app streams 16 × 512 m tiles of
the October Square / Independence Avenue area and renders them as a stylized
pixel-art city: real buildings with walls, roofs and procedural windows, avenues,
pavements, tram rails, parks, the Svislach river, deterministic trees, cast
shadows, day/night lighting, building selection with OSM metadata.

Acceptance screenshots: `docs/screenshots/` (overview, close-up, detail, night,
golden hour, clean 3D debug).

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

## Verified numbers (headless Chromium, ANGLE/D3D11, RTX 3080 Laptop, 1600×900)

* Scene: 654 buildings, 16 tiles resident, 181 011 triangles, 49 draw calls,
  60 FPS (vsync-limited), 640×360 internal pixel-art resolution, 24.1 MB GPU
  geometry, 0 console/page errors.
* Day overview: mean luminance 108/255, 0 % near-black, 2 000–3 700 distinct
  colours (palette-quantised by design).
* Night (22:30): mean luminance 39/255, sparse warm lit windows across the
  district, roofs and streets readable.
* Data payload: 16 tiles, 1699 KiB raw JSON / ~406 KiB gzipped (23.8 %).
* Tests: 224/224 unit (Vitest), 12/12 browser e2e (Playwright, hardware GPU),
  18/18 Lead integration checks (controls, picking, streaming, brightness,
  night contrast, no console errors), `tsc --noEmit` clean.
* Data coverage: 10.6 % explicit `height`, 56 % derived from `building:levels`,
  33.5 % heuristic; 46.6 % explicit `roof:shape`.

## Open issues / known limitations (all documented)

| # | Issue | Severity | Notes |
| --- | --- | --- | --- |
| 1 | Roof-shape mix is ~68 % pitched (heuristic for pre-war low-rise) | low | plausible for this part of the centre; heuristic provenance is recorded per volume |
| 2 | Payload is uncompressed JSON | low | gzip gives 406 KiB; binary/Brotli encoding is the next scalability step |
| 3 | Some trees are procedurally placed inside mapped parks | low | `TreeInstance.mapped` distinguishes surveyed from inferred; UI/docs say so |
| 4 | Underground objects (metro, passages) are not rendered | low | deliberate: they painted black strips on squares in an early build |
| 5 | Flat terrain (no DEM) | low | terrain-height provider is the extension point; see `docs/DATA_SOURCES.md` |
| 6 | Global palette LUT is debug-only; final colour comes from materials + dither/levels | low | intentional art decision |

## Multi-agent execution

Five parallel agents (building geometry, facades/art direction, environment,
renderer, QA) worked in the same checkout with disjoint file ownership; the Lead
owned the data pipeline, shared contracts, the React shell, integration and final
acceptance. See `docs/AGENT_TASKS.md`.
