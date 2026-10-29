# Agent tasks & ownership

Five engineering agents plus the Lead build this project in parallel in the same
working directory. This file records the delegation contract so that parallel
work stays conflict-free. See `docs/ARCHITECTURE.md` §5 for the module map.

## Team

| Agent | Scope (files it may write) | Deliverable |
| --- | --- | --- |
| **Lead** | `scripts/**`, `src/shared/**`, `src/app/**`, `src/main.tsx`, `docs/**`, `README.md`, `package.json`, configs | architecture, data pipeline, integration, final QA |
| **geometry-dev** | `src/city/buildings/**`, `src/city/roofs/**`, `tests/unit/buildings/**`, `tests/unit/roofs/**` | procedural walls/roofs for all roof shapes, merged `BufferGeometry` with facade attributes, triangle→building mapping |
| **facade-artist** | `src/city/facades/**`, `src/engine/materials/facadeMaterial.ts`, `src/engine/materials/palette.ts`, `src/engine/shaders/**`, `src/engine/postprocess/palette.ts`, `tests/unit/facades/**` | procedural GLSL facade shader (windows, floors, balconies, cornices, night, LOD), architectural presets, palette |
| **environment-dev** | `src/city/roads/**`, `src/city/environment/**`, `tests/unit/environment/**` | roads/pavements/rail surfaces, parks/water, trees, hills — all merged geometries, correct layer heights |
| **renderer-dev** | `src/engine/createCityApp.ts`, `src/engine/camera/**`, `src/engine/renderer/**`, `src/engine/tiles/**`, `src/engine/picking/**`, `src/engine/postprocess/**` (except palette.ts), `src/engine/materials/environmentMaterial.ts` | isometric ortho camera + controls, tile streaming/cache/LRU, lighting + time of day, pixel-art post pass, picking, `CityAppHandle` implementation |
| **qa-dev** | `playwright.config.ts`, `tests/e2e/**`, `tests/unit/data/**`, `tests/unit/tile_math.test.ts`, `tests/unit/config_sync.test.ts`, `scripts/qa/**`, `docs/QA_REPORT.md`, `docs/LIMITATIONS.md`, `docs/TESTING.md` | Playwright suite, screenshot capture, performance measurement, honest QA report, data validation tests |

## Frozen contracts (Lead-owned; changes require Lead approval)

* `src/shared/types.ts` — tile/building/road payload schema.
* `src/shared/config.ts` + `scripts/geo_config.py` — pilot area, tile size,
  projection, layer heights, camera defaults (kept in sync by a unit test).
* `src/shared/geometry.ts` — building vertex attribute contract
  (`position`, `normal`, `aUV`, `aColor`, `aStyle`, `aFace`) and the
  `FACE_KIND` / `STYLE_FLAG` / `ARCHETYPE_ID` / `ROOF_SHAPE_ID` tables.
* `src/shared/appApi.ts` — `CityAppHandle` interface between React and engine.
* `src/shared/tileMath.ts` — tile/coordinate maths.

## Interface handoffs

```
Lead → tiles (TileData JSON)
  → renderer-dev (TileManager) → geometry-dev + environment-dev (mesh builders)
  → facade-artist (material consuming vertex attributes) → renderer-dev (post pass)
  → qa-dev (browser tests, screenshots)
```

* `buildingsMesh.ts` exports `buildBuildingsMesh(buildings, options) =>
  { geometry, triangleOwner, buildingIds, triangleCount, warnings? }`.
* `environmentMeshes.ts` exports `buildEnvironmentMeshes(tile, options) =>
  { ground, roads, trees, triangleCount }`.
* `facadeMaterial.ts` exports `createFacadeMaterial`, `updateFacadeUniforms`,
  `disposeFacadeMaterial`, `createEnvironmentMaterial`.
* `presets.ts` exports `FACADE_PRESETS`, `presetFor`, `styleFlagsFor`,
  `roofColorFor`, `PIXEL_PALETTE` — imported by the geometry builder.

## Working rules

1. No agent writes outside its scope; no agent rewrites another agent's file.
2. `src/shared/**` is frozen; ask the Lead before changing a contract.
3. No `git commit` by agents; the Lead commits at verified checkpoints.
4. Every module ships with unit tests; TypeScript must typecheck.
5. Nothing is reported as "done" without an actual command output or screenshot.
