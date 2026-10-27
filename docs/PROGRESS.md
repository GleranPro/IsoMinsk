# Project progress — Isometric Minsk

Living document. Status is updated only after the work has actually run.
Legend: ✅ done & verified · 🟡 implemented, verification pending · ⏳ in progress · ❌ blocked

## Current milestone

**Phase 2 — architectural quality.** The vertical slice loads real central-Minsk
geometry in the browser; Milestone A (geodata) is complete and validated;
Milestone B/C/D/E (roofs, facades, isometric pixel-art renderer, environment)
are being finished by the engineering team.

## Status board

| Area | Status | Evidence / notes |
| --- | --- | --- |
| Repo skeleton, TS/Vite/Three/React toolchain | ✅ | `pnpm install`, `pnpm exec vite --version` → 7.3.7 |
| OSM acquisition (BBBike Minsk extract, 35 MB; Geofabrik Belarus fallback) | ✅ | `scripts/ingest/download.ps1`, PBF dated 2026-10-24 |
| OSM extraction of pilot area (pyosmium, 3 passes) | ✅ | 6762 raw buildings, 19 456 highways, 3816 surfaces, 1231 trees in the 4.9 km window |
| Projection to local metric (EPSG:32635, local origin) | ✅ | landmark check near Independence Square: Palace of the Republic–scale civic building (45 m) at local (−27, 116), Waldorf Astoria hotel footprint present |
| Height/roof/archetype inference with provenance | ✅ | 10.7 % explicit height, 55.4 % from `building:levels`, 33.8 % heuristic; 47 % explicit `roof:shape` |
| `building:part` volume resolution (no double rendering) | ✅ | 398 parts attached to parent buildings, 2 orphans rendered standalone |
| Tile generation (16 × 512 m tiles, 1.7 MiB JSON) | ✅ | `public/data/tiles/*.json` + `manifest.json` |
| Data validation + coverage report | ✅ | `scripts/validation/coverage_report.py` → PASS, `docs/COVERAGE_REPORT.md` |
| Tile streaming + isometric camera + lighting | ⏳ | renderer-dev; stub renderer boots, loads 16 tiles at 60 FPS, 30 draw calls |
| Procedural building geometry (walls, roofs, parts) | ⏳ | geometry-dev; walls/roof-envelope modules landing |
| Procedural facade shader (windows, floors, balconies) | ⏳ | facade-artist; shader was not compiling (`patch` reserved word), fix in progress |
| Environment (roads, pavements, parks, water, trees, rail) | ⏳ | environment-dev; triangulation/road/tree modules landing |
| Pixel-art postprocessing (outlines, quantise, upscale) | ⏳ | renderer-dev |
| Picking + info panel | ⏳ | API + UI exist; picking uses the stub geometry |
| Playwright e2e + screenshots | ⏳ | qa-dev; browser installed, suite written, awaiting a non-black render |
| Docs: architecture, data sources, art reference | ✅ | `docs/ARCHITECTURE.md`, `docs/DATA_SOURCES.md`, `docs/ART_REFERENCE.md` |
| README with startup commands | ✅ | `README.md` |
| Streaming/scalability for all Minsk districts | ❌ not started | design in `docs/ARCHITECTURE.md` §7 |
| Seasons, transport animation, terrain, landmarks | ❌ out of MVP scope | architecture hooks only |

## Data facts (generated 2026-10-27)

* Pilot area: 1600 × 1600 m centred on 53.9022 / 27.5610 (October/Independence
  Square), tiles 512 m → tile indices x ∈ [−2, 1], y ∈ [−2, 1].
* 671 buildings (669 footprints + 2 orphan parts), 679 ground surfaces,
  3811 road/pavement/rail polygons after tile clipping, 3775 trees
  (216 OSM-mapped + 3559 deterministically placed in park polygons).
* Water: 274 000 m² (Svislach river and ponds) inside the pilot area.
* Payload: 1.7 MiB uncompressed JSON for 16 tiles (target for binary encoding
  later: ~0.4 MiB).

## Open issues

| # | Issue | Severity | Owner |
| --- | --- | --- | --- |
| 1 | Facade shader must compile in Chrome (`patch` reserved word) | high | facade-artist |
| 2 | Environment material must consume the vertex-colour attribute written by the mesh builder | high | environment-dev / renderer-dev |
| 3 | Ground layers must not z-fight (use `GROUND_LAYER_Y`) | high | environment-dev |
| 4 | Pixel-art pass must not be a CSS filter — needs depth outlines + quantisation | high | renderer-dev |
| 5 | Low building density in the NE corner (river/rail area) — confirm real, not a parsing gap | medium | Lead |
| 6 | ODbL attribution must be visibly on the map, not only in a collapsed panel | medium | Lead |
| 7 | Heuristic archetype mix (33 % historic) is an estimate; document clearly in the UI | medium | Lead |
| 8 | Road class distribution looked light on tertiary/residential — verify after render | low | Lead |
| 9 | Trees are partly procedural; the UI must not imply surveyed trees | low | Lead |
| 10 | Payload JSON is uncompressed (Brotli/binary is a later optimisation) | low | Lead |

## Next priorities

1. Get the real geometry + facade shader + environment rendering in the browser
   (no black scene), then capture overview / close-up / night screenshots.
2. Fix everything visible in the screenshots (missing roofs, floating
   buildings, z-fighting, monotone facades).
3. Wire the pixel-art post pass and verify it produces crisp, stable pixels.
4. Run Playwright e2e + performance measurement, record real numbers.
5. Only then: expand area / add atmosphere (night lamps, seasons).
