# Project progress — Isometric Minsk

Living document. Status is updated only after the work has actually run.
Legend: ✅ done & verified · 🟡 implemented, verification pending · ⏳ in progress · ❌ blocked

## Current state

**Phase 3 — pixel-art identity / visual polish.** The application boots, streams
real central-Minsk tiles and renders true 3D buildings with procedural facades,
roofs, parks, water, streets and trees through an isometric orthographic camera
with a real pixel-art postprocessing stage. Remaining work is art-direction
(brightness/palette) and final verification (full e2e, performance, screenshots).

## Milestones

| Milestone | Status | Evidence |
| --- | --- | --- |
| A — Geospatial foundation | ✅ | 654 buildings, 679 surfaces, 3811 road/rail polygons, 3775 trees in 16 × 512 m tiles; `scripts/validation/coverage_report.py` → PASS; `docs/COVERAGE_REPORT.md` |
| B — Real 3D buildings | ✅ | `buildBuildingsMesh` → 65 327 triangles for 905 volumes of 654 buildings, flat normals exact to 1e-6, no NaN; 53 unit tests; `scripts/qa/geometryAudit.ts` → PASS on all 16 tiles |
| C — Procedural facades | 🟡 | GLSL facade shader compiles and renders window grids, ground-floor bands, cornices, night windows; per-archetype presets; being tuned for brightness/contrast |
| D — Isometric pixel-art rendering | 🟡 | ortho camera + controls, tile streaming/LRU, low-res render target + depth edge pass + palette quantisation + nearest upscale; scene currently too dark (art fix in progress) |
| E — Streets and environment | ✅ | roads/pavements/kerbs/markings/tram rails/bridges from OSM; parks, water banding, deterministic trees; ≤ 10 666 env triangles per tile; 67 unit tests |
| F — User interaction | ✅ | pan/zoom/rotate/reset, building pick + info panel (verified in e2e), pixel toggle, facade toggle, time-of-day slider, loading indicator, visible ODbL attribution |
| Scaling (all Minsk) | ❌ not started | design ready in `docs/ARCHITECTURE.md` §7 |

## Verified numbers (headless Chromium, ANGLE/D3D11, RTX 3080, 1600×900)

* Scene: 642–654 buildings, 15–16 tiles resident, 170 987 triangles,
  46 draw calls, 52 FPS at 13:00 (vsync-limited in some runs to 60).
* Tile payload: 16 tiles, 1.7 MiB JSON total (uncompressed).
* Data coverage: 10.7 % explicit `height`, 55.4 % derived from
  `building:levels`, 33.8 % heuristic; 47 % explicit `roof:shape`.
* Geometry audit: 0 issues across 16 tiles (no NaN, normals present, aUV/aFace
  present, triangleOwner consistent, nothing below ground).

## Open issues (prioritised)

| # | Issue | Severity | Owner | Status |
| --- | --- | --- | --- | --- |
| 1 | Whole scene too dark (mean luminance 41/255 at 13:00; target 95–125) | high | renderer-dev + facade-artist | in progress |
| 2 | Palette quantisation muddies mid-tones; asphalt/roads near-black | high | facade-artist | in progress |
| 3 | Default camera framing does not centre the pilot district | medium | renderer-dev | in progress |
| 4 | Night scene unreadable outside lit windows | medium | renderer-dev | in progress |
| 5 | Facade window speckle at 70 m zoom (should be a clean 2–3 px grid) | medium | facade-artist | open |
| 6 | Roof-shape mix: 68 % pitched (heuristic for pre-war low-rise) — verify against the overview screenshot that it reads as Minsk | medium | Lead | open |
| 7 | Payload JSON uncompressed (binary/Brotli is a later optimisation) | low | Lead | open |
| 8 | Trees partly procedural — UI must not imply surveyed trees (documented) | low | Lead | done in docs |

## Next steps

1. Land lighting + palette fixes, verify with numeric luminance metrics and
   screenshots (overview / close-up / night / golden hour / rotated).
2. Re-run Playwright e2e (12 tests) and the capture pipeline against the final
   build; update `docs/QA_REPORT.md` with the real numbers.
3. Fix remaining visual defects found in the screenshots (P0/P1 only).
4. Commit the verified checkpoint, update README/PROGRESS, deliver.

## Multi-agent execution

Five parallel agents (geometry, facades, environment, renderer, QA) work in the
same checkout with disjoint file ownership; the Lead owns the pipeline, shared
contracts, the React shell and integration. See `docs/AGENT_TASKS.md`.
