# Project progress — Isometric Minsk

Living document. Status is updated only after the work has actually run.
Legend: ✅ done & verified · 🟡 implemented, verification pending · ⏳ in progress · ❌ blocked

## Current state

**Phase 3/4 — pixel-art identity, final verification.** The application runs,
streams real central-Minsk tiles and renders them as a stylized isometric
pixel-art 3D city: real buildings with walls/roofs/windows, real avenues, parks,
the Svislach river, trees, tram rails, day/night lighting, building selection.
Remaining work: cast-shadow strength/update (renderer), final e2e re-run and the
acceptance capture.

## Milestones

| Milestone | Status | Evidence |
| --- | --- | --- |
| A — Geospatial foundation | ✅ | 654 buildings, 679 surfaces, 3811 road/rail polygons, 3775 trees in 16 × 512 m tiles; validation PASS; `docs/COVERAGE_REPORT.md` |
| B — Real 3D buildings | ✅ | `buildBuildingsMesh` → ~65 000 triangles for 905 volumes of 654 buildings; flat normals exact; 53 unit tests; geometry audit 0 issues on all 16 tiles |
| C — Procedural facades | ✅ | GLSL facade material: window grids, dark day glass, ground-floor bands + shopfronts, cornices, balconies, night windows, LOD detail; per-archetype presets; 60 facade tests |
| D — Isometric pixel-art rendering | 🟡 | ortho camera + custom controls, tile streaming with LRU/cancel/worker, low-res target + depth-outline + dither/quantise post pass, nearest upscale; pixel-art vs clean-3D toggle verified. Cast shadows present but need the update-on-tile-load fix + stronger intensity |
| E — Streets and environment | ✅ | roads/pavements/kerbs/markings/tram rails/bridges, parks, water banding, deterministic trees; ≤10.7k env tris/tile; 67 unit tests |
| F — User interaction | ✅ | pan/zoom/rotate/reset, picking + info panel with stable OSM ids (verified in e2e), pixel toggle, facade toggle, wireframe, time-of-day slider, loading indicator, visible ODbL attribution |
| Scaling (all Minsk) | ❌ not started | design in `docs/ARCHITECTURE.md` §7; streaming/LRU already in place for a larger tile range |

## Verified numbers (headless Chromium, ANGLE/D3D11, RTX 3080 Laptop, 1600×900)

* Scene: 654 buildings, 16 tiles resident, ~182 000 triangles, 50 draw calls,
  60 FPS at 13:00 (vsync-limited), 640×360 internal pixel-art resolution,
  24.2 MB GPU geometry, 0 console/page errors.
* Data payload: 16 tiles, 1706 KiB raw JSON / **406 KiB gzipped** (23.8 %).
* Day overview: mean luminance ~97–140 depending on time-of-day preset, 0 %
  near-black pixels, ~3 900 distinct colours.
* Data coverage: 10.6 % explicit `height`, 56 % derived from
  `building:levels`, 33.5 % heuristic; 46.6 % explicit `roof:shape`.
* Unit tests: 224/224 green. E2E: 12/12 on hardware GPU.

## Open issues

| # | Issue | Severity | Owner | Status |
| --- | --- | --- | --- | --- |
| 1 | Cast shadows do not appear in the normal frame loop: the shadow map is rendered before the tiles finish loading and never refreshed | high | renderer-dev | in progress (root cause proven: works with `shadowMap.autoUpdate=true`) |
| 2 | Shadow strength too subtle at pixel-art scale (0.34) | medium | renderer-dev | in progress |
| 3 | Night scene dark (mean ~22/255), lit windows hard to see | medium | renderer-dev | in progress |
| 4 | Roof-shape mix is 68 % pitched (heuristic default for pre-war low-rise) — plausible for this part of the centre, worth a final visual sanity check | low | Lead | open |
| 5 | Payload is uncompressed JSON (Brotli/binary encoding later) | low | Lead | open |
| 6 | Some trees are procedurally placed inside parks (documented, not surveyed) | low | Lead | documented |

## Multi-agent execution

Five parallel agents (geometry, facades, environment, renderer, QA) worked in the
same checkout with disjoint file ownership; the Lead owned the data pipeline,
shared contracts, the React shell and integration. See `docs/AGENT_TASKS.md`.
