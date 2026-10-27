# QA Report — Isometric Minsk

**Report time:** 2026-10-27 ~14:35 local (Europe/Warsaw)
**Author:** QA & Integration agent
**Repo state:** no git commits (all files untracked, working-tree only). The app and data pipeline are being written concurrently by five agents; this report distinguishes *observed defects* from *work in progress*.

---

## 1. Executive summary

**Test infrastructure: ready and operational.**
Playwright is installed (1.64.1 + Chromium 156), `playwright.config.ts` starts/reuses the Vite dev server on `http://127.0.0.1:5173`, and all QA-owned tests exist. The first full e2e run executed **12 tests: 11 passed, 1 failed**. The single failure was **not an assertion failure** — the page never booted (`canvasCount: 0`, `window.__CITY_APP__` undefined), which matches a Vite HMR reload race while two other agents were saving files. The same test passed on isolated re-run (pan image diff 0.379). So at the time of writing the functional e2e behaviour is **effectively 12/12**, but the suite has **not yet produced a single clean all-12 run** (will re-run after the renderer milestone).

**Unit + data tests: 44/44 QA-owned tests pass** against the real generated data (13 config-sync, 20 tile-math, 11 data-validation). The full repo unit suite (all agents' files) is currently **108/108 passing**.

**Application: functionally alive, visually incomplete.** The renderer loads 16 tiles / 670 buildings / 72k building + 124k environment triangles with 24–36 draw calls and no page errors. **However the city is not yet readable:** all environment surfaces (ground, roads, sidewalks, greenery, water) render **black**, and the default camera does not centre the district. The renderer is being rewritten in parallel (facade shader compile error `'patch': Illegal use of reserved word`, environment material attribute mismatch `color` vs `aColor` — reported by the Lead). These visual defects are expected to be transient; the screenshots in `screenshots/` are an **intermediate baseline**, not the final look. An auxiliary geometry audit proves the environment meshes exist (123,683 triangles) — the black ground is a **material/shader** defect, not missing geometry.

**No QA test currently fails because of an application assertion.** The open QA risks are visual (see §6), not functional plumbing.

---

## 2. Environment

| Item | Value |
| --- | --- |
| OS | Windows 11, PowerShell (`pwsh`) |
| Node | v24.13.0 |
| pnpm | 11.22.0 |
| Vite | 7.1.x (dev server, port 5173) |
| Playwright | 1.64.1 (`@playwright/test`), Chromium 156.0.8078.4 |
| WebGL in headless Chromium | WebGL 2.0 via ANGLE/SwiftShader (software) — verified `UNMASKED_RENDERER_WEBGL = ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)))` |
| Python pipeline | `.venv` present; source PBF `data/raw/belarus-latest.osm.pbf` (351 MB) |
| Dev server used | `http://127.0.0.1:5173` (reused by tests; one server at a time, `workers: 1`) |

**Playwright installation (one allowed `package.json` edit, done via pnpm so the lockfile stayed consistent):**

```powershell
pnpm add -D @playwright/test        # -> @playwright/test 1.64.1
pnpm exec playwright install chromium
pnpm exec playwright --version      # Version 1.64.1
```

Chromium + headless shell + FFmpeg downloaded successfully from `cdn.playwright.dev`. No network failure occurred.

---

## 3. Deliverables landing in this scope

| File | Purpose | Status |
| --- | --- | --- |
| `playwright.config.ts` | e2e config: dev-server `webServer`, `testDir tests/e2e`, `workers: 1`, `retries: 0`, 90 s timeout, 1600×900, `outputDir test-results/`, SwiftShader launch flags | ✅ written, exercised |
| `scripts/qa/capture.mjs` | standalone screenshot capture: reuses/starts server, waits for real readiness, requires > 5000 triangles, 6 fixed screenshots + `screenshots/stats.json` + `screenshots/console.log`; exits 1 with evidence if the app is not ready | ✅ written, exercised (success + failure path) |
| `scripts/qa/analyze-screenshots.mjs` | decodes captured PNGs in Chromium and emits `screenshots/analysis.json` (colour count, luminance, near-black share, content bbox) | ✅ written, exercised |
| `scripts/qa/geometryAudit.ts` | Lead-provided auxiliary audit: builds building + environment meshes from the real tiles without a browser, checks NaN/attributes/ownership, writes `screenshots/geometry-audit.json` | ✅ run: **GEOMETRY AUDIT PASSED** (0 issues) |
| `tests/e2e/city.spec.ts` | 12 e2e tests (shell, globals, geometry, non-flat canvas, pan/zoom/rotate, time-of-day, pixel toggle, building pick, error-free interaction, reload) | ✅ written, exercised |
| `tests/unit/tile_math.test.ts` | 20 tile-index/bounds/round-trip/geometry tests | ✅ 20/20 pass |
| `tests/unit/config_sync.test.ts` | 13 Python↔TypeScript config parity + physical-invariant tests | ✅ 13/13 pass |
| `tests/unit/data/tiles.test.ts` | 11 real-data validation tests (schema, tile files, counts, ids, heights, rings, roads/surfaces/trees, crossings, centre coverage) | ✅ 11/11 pass |
| `docs/QA_REPORT.md` | this report | ✅ |
| `docs/LIMITATIONS.md` | data/technical/renderer limitations | ✅ |
| `docs/TESTING.md` | how to run everything on Windows PowerShell | ✅ |

---

## 4. Test results (actual latest runs)

### 4.1 Unit + data suites — PASS

Command: `pnpm exec vitest run tests/unit/data tests/unit/tile_math.test.ts tests/unit/config_sync.test.ts`

```
 ✓ tests/unit/config_sync.test.ts (13 tests) 8ms
 ✓ tests/unit/tile_math.test.ts (20 tests) 77ms
 ✓ tests/unit/data/tiles.test.ts (11 tests) 80ms
 Test Files  3 passed (3)
      Tests  44 passed (44)
```

Full repo unit suite (all agents' tests, run afterwards): `Test Files 10 passed (10) — Tests 108 passed (108)`, 2.21 s. Earlier in the day 7 tests owned by other modules were failing; those were fixed by their owners before this run.

Notable data facts these tests verify against the *real* files (not fixtures), all passing:

- manifest: EPSG 32635, tileSize 512, origin UTM `[536859.254, 5972786.284]`, centre `53.9022, 27.561`, attribution credits OpenStreetMap (ODbL 1.0) + Geofabrik;
- 16 tile files (4×4 grid, tileRange −2..1), every file exists, parses, byte size matches the manifest, payload bounds match `tileBounds()`;
- manifest counts agree with payload sums: **670 buildings, 679 surfaces, 3 811 roads, 3 775 trees** (manifest regenerated at 14:29; the e2e/screenshot run at 14:21–14:28 used the slightly older 671-building snapshot);
- building ids unique across ALL tiles (exactly one owning tile; 0 duplicates);
- building heights within 2..400 m (observed range 2.5 m – 115.5 m); footprints are valid rings with ≥ 3 finite points and non-zero area; no NaN;
- roads/surfaces polygons valid; trees have finite positions and plausible height/radius;
- `crossingBuildingIds` never claim ownership and always reference real buildings;
- every tile intersecting the central 300 m has roads or surfaces, and the centre has buildings.

> **Data regeneration note:** while QA was running, the data agent regenerated the tiles at
> 14:29 (manifest + all 16 tiles). The regenerated set has **670 buildings** (was 671),
> 71 with explicit OSM height, 372 with `building:levels`, 227 heuristic heights, 315 with
> explicit roof shape. The QA data suite was re-run against the regenerated files and is
> green (11/11). E2E numbers quoted below were measured on the 14:21 snapshot; they are
> statistically equivalent.

### 4.2 E2E suite — 11 passed / 1 infrastructure failure; failing test passes in isolation

Command: `pnpm exec playwright test` (server started by the config, one worker, ~3.5 min):

| # | Test | Result | Duration | Observed values |
| --- | --- | --- | --- | --- |
| 1 | app shell loads, non-zero WebGL canvas, no console/page errors | ✅ pass | 5.4 s | loading overlay reaches `hidden`; 0 errors |
| 2 | `window.__CITY_APP__ = { ready, app, stats }` within 60 s | ✅ pass | 6.7 s | 19/19 `CityAppHandle` methods present; EngineStats exposed |
| 3 | renders real Minsk geometry (triangles > 1000, buildings > 100) | ✅ pass | 6.7 s | `triangles=39 378, buildings=671, loadedTiles=16, drawCalls=30, fps=27.9` |
| 4 | canvas is a real image (non-uniform pixels) | ✅ pass | 8.9 s | 1 292 unique colours, luminance σ=99.6, mean=93.3 |
| 5 | mouse-drag pan changes the rendered image | ⚠️ failed (infra), ✅ isolated re-run | 1.1 min / 15.7 s | page never booted: `canvasCount=0`, no globals (HMR race); re-run: **pan diff ratio 0.379** |
| 6 | wheel zoom changes `orthoHeight` | ✅ pass | 4.0 s | 420.0 → 204.4 |
| 7 | rotation changes `azimuth` (API setter + right-drag) | ✅ pass | 8.4 s | 0.785 → 2.356 rad |
| 8 | time-of-day slider changes the rendered image | ✅ pass | 13.4 s | `getTimeOfDay()=23`, label `23:00`, **image diff 0.666** |
| 9 | pixel-effect toggle changes the rendered image | ✅ pass | 25.8 s | `isPixelEffectEnabled()` true→false→true, **diff 0.043** |
| 10 | clicking a building opens the info panel with real OSM data | ✅ pass | 10.7 s | selected `w25432666` (khrushchev), OSM id format validated, panel closes |
| 11 | no uncaught errors during 5 s of interaction | ✅ pass | 24.3 s | 0 page errors, 0 console errors, renderer still > 1000 triangles |
| 12 | page reload re-renders the city | ✅ pass | 26.7 s | ready again, non-flat canvas, 0 errors |

Verbatim failure text from test 5 (first run):

```
Error: City app did not report ready within 60s.
Last snapshot: {
  "cityAppGlobal": "undefined",
  "ready": null,
  "hasAppHandle": false,
  "cityStatsGlobal": "undefined",
  "stats": null,
  "canvasCount": 0,
  "loadingOverlayClass": null
}
Renderer error overlay: (none)
```

Interpretation: the document never executed (`canvasCount: 0` means not even React mounted). This is consistent with a Vite dev-server module reload while other agents were writing `src/app/App.tsx` (browser console showed `[vite] hot updated: /src/app/App.tsx`). It is **not** an application bug: the same test passed on isolated re-run, and tests 6–12 (which boot the same app) passed in the same run. Re-run command: `pnpm exec playwright test --grep "5\. mouse-drag pan"` → `1 passed (19.1s)`.

### 4.3 Typecheck (`tsc --noEmit`)

At the time of the latest check the repo typecheck **fails only in renderer-owned files that were being edited concurrently**, not in QA files:

```
src/engine/createCityApp.ts(493,16): error TS2339: Property 'bounds' does not exist on type 'never'.
src/engine/tiles/serialization.ts(223,28): error TS2345: Argument of type 'ArrayBuffer' is not assignable to parameter of type 'number'.
src/engine/tiles/tileStreamer.ts(526,18): error TS2339: Property 'inlineResult' does not exist on type 'InflightTask'.
... (10 errors, all in src/engine/**)
```

`tests/e2e`, `tests/unit` contain **0 TypeScript errors**. This is a transient state of the renderer rewrite and must be re-checked at the milestone.

### 4.4 Auxiliary geometry audit (Lead's `scripts/qa/geometryAudit.ts`)

Command: `pnpm exec tsx scripts/qa/geometryAudit.ts` → writes `screenshots/geometry-audit.json`.

```
Per-tile: ... (16 tiles)
Totals: {"buildings":670,"triangles":72760,"envTriangles":123683,
         "roofTriangles":49548,"wallTriangles":82628,"trees":3775}
Triangle per building: 108.6
GEOMETRY AUDIT PASSED
```

Zero issues across all 16 tiles: no NaN positions, no geometry below ground
(y range 0.0 – 115.9 m), all expected attributes (`position`, `normal`, `aUV`,
`aColor`, `aStyle`, `aFace`) present, triangle-owner maps consistent with
building ids, no building without emitted triangles. **Key finding:** the
environment builder emits **123,683 triangles** (ground + roads + trees), so the
black environment in the screenshots is a *material/shader* problem (D1), not
missing geometry.

---

## 5. Screenshots and quantitative analysis

Captured with `node scripts/qa/capture.mjs` (exit code 0, 6/6 shots, 16 tiles loaded, 0 console errors, 0 page errors). Files are in `screenshots/`; the engine stats next to them are in `screenshots/stats.json`; the browser console log is `screenshots/console.log`. Quantitative metrics (from `node scripts/qa/analyze-screenshots.mjs` → `screenshots/analysis.json`):

| Screenshot | Size | Unique colours | Mean luminance | Near-black pixels | What it shows now |
| --- | --- | --- | --- | --- | --- |
| `screenshots/01-overview.png` | 165 KB | 1 918 | 113.7 | **38.3 %** | default iso view; district visible right-of-centre on a black ground slab; light-grey sky; buildings tan/grey |
| `screenshots/02-closeup-residential.png` | 111 KB | 986 | 42.6 | **58.9 %** | khrushchev block close-up; facades show window rhythms; ground missing (black) |
| `screenshots/03-closeup-landmark.png` | 142 KB | 1 332 | 47.6 | **54.2 %** | civic building near October Square (45 m); roofs/floors visible; black voids between buildings |
| `screenshots/04-night.png` | 131 KB | 1 516 | 31.3 | 21.6 % | 23:00 preset; sky turns dark blue, city mostly silent dark mass; no window glow yet |
| `screenshots/05-clean-3d.png` | 248 KB | 1 982 | 113.8 | 38.2 % | pixel effect off; render size 1600×900 (vs 569×320 with effect on); geometry readable |
| `screenshots/06-rotated.png` | 115 KB | 962 | 100.4 | **43.3 %** | 90° rotated view; district sits in the lower half of the frame |
| `screenshots/dev-baseline.png` | 86 KB | 2 064 | 105.9 | 38.2 % | reference image left in `screenshots/` by another agent (not produced by capture.mjs) |

### Pixel-art / visual quality observations (made by reading the PNGs)

1. **Missing ground layer dominates the frame.** The 2240 m tile footprint renders as a flat black quadrilateral (38–59 % of pixels below luminance 8). Roads, sidewalks, parks, water and tree meshes are effectively invisible. One large pale-grey disc shape (bottom-right of the overview) is the only ground-like surface that draws — it looks like a mis-materialised surface polygon. This matches the Lead-reported environment-material attribute mismatch, and is the single biggest visual blocker.
2. **Buildings themselves are drawn.** Wall colours (tan/beige), grey roofs and window rhythms are visible in close-ups; the earlier "nearly black" state (facade shader compile error) has visibly improved at capture time. Roofs show a dense white/grey stipple pattern at close range (02/03) that currently reads as noise rather than a deliberate pixel-art dither — needs art-direction confirmation.
3. **Framing is off-centre.** In `01-overview.png` the district is pushed to the right ~60 % of the frame with a large empty left area; in `06-rotated.png` it sits in the bottom half. The default/reset camera is not centring on the pilot area (likely the stub's `cameraTarget = bounds[0] + 200` heuristic; `manifest.bounds` semantics differ — see defect D6).
4. **Night preset works but is too dark to read.** `04-night.png` changes sky/fog colour as expected (image diff 0.666 vs day in test 8), but without emissive windows or stronger ambient the city becomes a nearly uniform dark mass. No lit-window effect is visible.
5. **Pixel-art mode works mechanically.** With pixel mode on the render buffer is 569×320 upscaled to 1600×900 (blocky, `image-rendering: pixelated`); with it off the buffer is 1600×900 (`05-clean-3d.png` is visibly sharper). The toggle changes ~4.3 % of sampled canvas pixels (test 9 — lower than expected because the black ground dominates the frame).
6. **HUD/UI reads correctly.** Header "ISOMETRIC MINSK", "671 buildings · 16 tiles" (screenshot-time dataset; the current regenerated manifest says 670), control panel, stats grid, OpenStreetMap attribution line ("© OpenStreetMap contributors · ODbL 1.0 · generated 2026-10-27") all render legibly. The time-of-day label in `04-night.png` still says 13:00 because the screenshot script called the scene API directly (`setTimeOfDay(23)`) without going through React state — expected script artefact, not a UI bug.

### Performance numbers (from `screenshots/stats.json`)

```json
{ "fps": 13.75, "frameMs": 72.74, "drawCalls": 36, "triangles": 98273,
  "visibleTiles": 16, "loadedTiles": 16, "buildings": 671,
  "renderWidth": 569, "renderHeight": 320, "geometryMB": 0.046 }
```

E2E snapshot at test 3: `fps=27.9, frameMs=35.8, drawCalls=30, triangles=39 378, 16 tiles` (e2e ran against the 14:21 dataset, 671 buildings; the manifest was regenerated at 14:29 with 670 buildings — statistically equivalent, data suite re-verified green on the new set). HUD inside screenshots showed 5–52 FPS depending on shot (software renderer + full-frame pixel dither). **These numbers are not representative of real-GPU performance** — headless Chromium is using SwiftShader (software). Geometry budget (~98k drawn triangles, 24–36 draw calls, 16 tiles) is comfortably small; the FPS ceiling here is a software-rasterisation artefact. `geometryMB: 0.046` looks suspiciously low for 98k triangles and should be re-checked by the renderer owner (likely a count vs bytes bug).

---

## 6. Prioritised defects / visual issues (with evidence)

| ID | Priority | Area | Observation | Evidence |
| --- | --- | --- | --- | --- |
| D1 | **P0** | Environment/ground rendering | Ground, roads, sidewalks, greenery, water, trees are invisible — the whole tile footprint is black. One pale disc polygon draws with a wrong/fallback material. | `screenshots/01-overview.png`, `05-clean-3d.png`; 38.3 % near-black; Lead-reported `color` vs `aColor` attribute mismatch; `src/city/environment/**` |
| D2 | **P0** | Facade shader compile | Facade shader previously failed to compile (`'patch': Illegal use of reserved word`), scene near-black; at capture time buildings are lit but this must be verified fixed in the final shader. | Lead report + visual change between 14:21 and 14:28 captures; `src/engine/materials/facadeMaterial.ts`, `src/city/facades/**` |
| D3 | **P1** | Camera framing | Default/reset view does not centre the district: overview shifted right (~60 %), rotated view shifted down. | `screenshots/01-overview.png`, `06-rotated.png`; `src/engine/createCityApp.ts` `resetCamera()` / target heuristic |
| D4 | **P1** | Night lighting | 23:00 preset is functionally applied but the city is too dark to read; no emissive windows/street lights. | `screenshots/04-night.png` (mean luminance 31.3, 21.6 % near-black) |
| D5 | **P1** | Roof/facade stipple | Dense white/grey stipple on roofs at close range reads as noise; verify it is intended pixel-art dithering, not z-fighting/shader aliasing. | `screenshots/02-closeup-residential.png`, `03-closeup-landmark.png` |
| D6 | **P2** | Manifest schema/doc drift | `manifest.bounds` = pilot area `[-800,‑800,800,800]`, but `src/shared/types.ts` documents it as "total bounds covered by all tiles" (tile range extends to ±1024 m). `manifest.generatedAt` is a date only (`2026-10-27`), not a full timestamp. | `public/data/tiles/manifest.json`; `src/shared/types.ts`; data test comment |
| D7 | **P2** | Data contract deviation | 16 building ids carry a multipolygon split suffix (`w25387552_224`, `r21417_636`, …) while `FeatureId` is documented as `${osmType[0]}${osmId}`. Ids remain unique and prefix-consistent; InfoPanel shows the base id. | `tests/unit/data/tiles.test.ts` warning output; `src/shared/types.ts` |
| D8 | **P2** | Data contract deviation | 290 of 670 buildings serialise absent optional `levels` as JSON `null` instead of omitting the field (`levels?: number`). UI currently tolerates it (`?? '—'`). | data inspection + `src/shared/types.ts`, `src/app/InfoPanel.tsx` |
| D9 | **P2** | Error UX | When city data fails to load, the loading overlay is hidden by `visible && !error ? '' : ' hidden'` — the user sees a blank light-grey map with **no error message** even though `[data-testid="error-message"]` exists in the DOM. Observed during the pre-data capture (blank canvas, error overlay opacity 0). | `src/app/LoadingOverlay.tsx:9`; earlier `screenshots/stats.json` had `rendererError` set while overlay class was `hidden` |
| D10 | **P3** | Perf metric | `EngineStats.geometryMB` = 0.046 MB for ~98k triangles looks wrong (count/bytes mixup). | `screenshots/stats.json` |
| D11 | **P3** | Test infra | Full e2e suite can fail spuriously while other agents save files mid-run (Vite HMR/restart → blank document). No retries by design; re-run required. | test 5 failure above (`canvasCount: 0`) |

Nothing above was "fixed by QA": `src/**` is outside my write scope. D1/D2 are known renderer work in progress per the Lead; D3–D5 need renderer/art confirmation; D6–D8 are data/schema decisions for the Lead + data agent; D9 is a small UI fix in `src/app/LoadingOverlay.tsx`.

---

## 7. Blocked / not yet verifiable

- **Final visual quality** (the point of the screenshots) is blocked on the renderer/environment modules landing. Current PNGs are an intermediate baseline; they will be re-captured on the Lead's milestone signal.
- **Real-GPU FPS** cannot be measured in this headless setup (SwiftShader). Any "60 FPS" claim needs a headed run on the target machine (`$env:QA_HEADLESS='0'`).
- **Shadows/lighting quality** cannot be judged while the ground is black and the facade shader may be mid-fix.
- **A single clean 12/12 e2e run** is pending: the last full run had one dev-server race failure; isolated re-run passed. Re-running the full suite while other agents edit `src/` will stay flaky by nature.

---

## 8. Next steps (owner: QA)

1. Re-run `pnpm exec playwright test` and `node scripts/qa/capture.mjs` + `analyze-screenshots.mjs` as soon as the Lead announces the renderer milestone; update this report with the new screenshots/stats and defect statuses.
2. Re-check `pnpm exec tsc --noEmit` — must be 0 errors at the milestone (currently 10 renderer-file errors from in-progress edits).
3. Re-review D1–D5 against the new PNGs; drop fixed items, keep evidence paths.
4. Keep unit suites green: `pnpm exec vitest run` (44 QA tests + full repo suite).
