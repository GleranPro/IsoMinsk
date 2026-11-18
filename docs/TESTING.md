# Testing — Isometric Minsk (Windows / PowerShell)

Latest application verification: 2026-11-15, Windows 11 / PowerShell (`pwsh`).
Earlier road/data audit results retain their checkpoint dates; they were not
rerun as part of the vegetation change or this documentation update.
Commands assume the repository root: `D:\Workk\VoxelMinsk`.

Mobile/touch checkpoint 2026-11-15 (merged complete-city release): typecheck and
build passed; **562 Vitest passed (5 skipped, 34 files)**. The mobile suite passed
**7/7** and **30 of 31** hardware-WebGL browser scenarios passed; the remaining
`trees.spec.ts` scenario still expects the old 16-tile pilot and cannot pass on
the complete-city payload (pre-existing; CI does not run Playwright). New
coverage: the DOM-free gesture state machine (24 unit tests) and phone-emulated
touch at 390×844 / 320×568 with real CDP multi-touch input.
See `tests/e2e/mobile.spec.ts` and `docs/BACKLOG.md` B-6.

Rail LOD checkpoint 2026-11-06: typecheck/build passed; **440 Vitest passed
(5 skipped), 14 hardware-WebGL Playwright tests passed**. Browser coverage checks
rail colour/area across texel sizes and exact ground/deck pixel agreement.
Same-camera comparisons: [RAIL_LOD_2026-11-06.md](RAIL_LOD_2026-11-06.md).

Vegetation checkpoint 2026-11-06: typecheck/build passed; 434 Vitest passed
(5 skipped), 13 hardware-WebGL Playwright tests passed. New coverage includes
tree instance buffers, shared-template lifetime, canopy appearance, cancellation
and the inline fallback. Full-city memory/performance and visual captures:
[TREE_INSTANCING_2026-11-06.md](TREE_INSTANCING_2026-11-06.md).

| Suite | Command | What it covers | Typical time |
| --- | --- | --- | --- |
| Unit + data | `pnpm test` | 562 passed, 5 skipped across 34 files; geometry, data, roads/rail LOD, landmarks, instancing, transfer/resource lifetime, publication contract and the multi-pointer gesture state machine | ~9 s on the reference machine |
| Data pipeline | `pnpm run data:all` | download → extract → normalize (writes tiles + manifest) → coverage report | several minutes |
| Road normalization unit | `pnpm run test:data` | 30 Python unittest cases for the lane/width model, topology-graph junction faces, asymmetric direction lanes, link suppression, material partition, crossings, medians and merged corridors (`scripts/normalize/tests/test_road_network.py`) | ~1 s |
| Road payload audit | `pnpm run qa:road-audit` | independent audit of the generated tiles: same-layer overlaps, tile-seam coverage gaps (all surface layers), street width spread (name+direction+lane signature, merged pieces excluded), road centrelines inside the drivable surface (rails/merged excluded by design), junction/crossing sanity; writes `data/processed/road-audit.json` | ~5 s |
| Road paint audit | `pnpm run qa:road-paint-audit` | renderer-level audit: no lane/zebra paint inside or near junction faces/surfaces, lane-line counts match the tagged lanes, rails continuous and paint-free; writes `screenshots/road-paint-audit.json` | ~10 s |
| Geometry audit | `pnpm exec tsx scripts/qa/geometryAudit.ts` | builds building/environment meshes from the real tiles without a browser; writes `screenshots/geometry-audit.json`; exits 1 on invalid geometry | ~5 s |
| QA unit only | `pnpm exec vitest run tests/unit/data tests/unit/tile_math.test.ts tests/unit/config_sync.test.ts` | QA-owned tests | ~1 s |
| E2E (real GPU) | `$env:QA_GPU='1'; pnpm exec playwright test` | 31 browser scenarios: 24 desktop (public payload, shell, camera, controls, pick, reload, museum, rail LOD, trees, gallery, nested release) + 7 mobile/touch; 30 pass — the pre-existing `trees.spec.ts` expects 16 loaded tiles | **~4.5 min** |
| E2E (default software) | `pnpm exec playwright test` | same tests on SwiftShader (deterministic CI mode) | ~10 min |
| Screenshots | `$env:QA_GPU='1'; pnpm run qa:capture` | 6 fixed screenshots + `screenshots/stats.json` + `screenshots/console.log` (waits for all 16 tiles) | ~45 s |
| Road screenshots | `$env:QA_GPU='1'; pnpm run qa:road-shots` | 23 close-up shots: canonical junctions, the seven user-reported places, the Ulyanovskaya × Lenina face and the Lenina 1+2 approach into `screenshots/roads/` | ~2 min |
| Screenshot metrics | `node scripts/qa/analyze-screenshots.mjs` | `screenshots/analysis.json` (colour / luminance / near-black share / content bbox) for the canonical 6 | ~5 s |
| Tile cache freshness | `node scripts/qa/cache-check.mjs` | proves a changed tile payload is revalidated on reload instead of served stale from the HTTP cache (mutates + restores `city-tiles/-1_-2.json`; needs `?dataset=city`) | ~40 s |
| Typecheck | `pnpm run typecheck` | `tsc --noEmit` over `src`, `tests`, `scripts` | ~10 s |
| Tree buffers | `pnpm exec tsx scripts/qa/tree-memory.ts city screenshots/tree-instancing/memory.json` | same 144 tiles / 316 704 trees, exact old/new buffer totals; fails below 75% reduction or on a count mismatch | tens of seconds |
| Tree GPU performance | `node scripts/qa/tree-perf.mjs label screenshots/tree-instancing/perf.json` | 6 fixed views, GPU-synced mean/p95, full 144-tile residency; select old path with `QA_TREE_STYLE=legacy` | ~1 min |
| Tree visual review | `node scripts/qa/tree-review.mjs` | A/B/C specimens, street rows and dense park through the real pixel-art renderer | ~20 s |
| Real-map tree captures | `node scripts/qa/tree-map-capture.mjs` | overview, Gorky Park and Chelyuskintsev Park; set `QA_TREE_STYLE` for matching before/after views | ~25 s |

---

## 1. Prerequisites (one-time)

```powershell
node --version        # v24.x
pnpm --version        # 11.x
pnpm install
pnpm exec playwright install chromium   # downloads Chromium 156 + headless shell + ffmpeg
pnpm exec playwright --version          # 1.64.1
```

The data pipeline needs Python 3.11+ in the project virtualenv
(`.venv\Scripts\python.exe`); the npm scripts invoke it directly, no activation
needed. If you want to run Python by hand:

```powershell
.\.venv\Scripts\Activate.ps1
python --version
```

If PowerShell blocks activation: `Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass`.

Headless WebGL uses ANGLE/SwiftShader (software) by default and is configured in
`playwright.config.ts`; no GPU is required for tests, but it is slow with the full
city (~1.9 FPS → ~10 min for the e2e suite). On a machine with a GPU, opt into
hardware rendering for fast, representative runs:

```powershell
$env:QA_GPU='1'   # ANGLE/D3D11 in headless Chromium (verified: RTX 3080 Laptop)
pnpm exec playwright test
node scripts/qa/capture.mjs
```

The same variable also works for `scripts/qa/capture.mjs`. Default remains
SwiftShader for CI determinism. The tree performance/review/map scripts explicitly
request hardware ANGLE/D3D11. Set `QA_BASE_URL` for their server URL. Playwright
accepts `QA_PORT` (default 5173) and reuses an existing server on that port.
For a different browser cache, set `PLAYWRIGHT_BROWSERS_PATH` to that directory.

---

## 2. Generate the data (only when `public/data/` is missing or stale)

The renderer needs `public/data/tiles/manifest.json` + `public/data/tiles/*.json`.
The current pipeline is entirely Python: `scripts/normalize/normalize.py` writes both
the tile payloads and the manifest (the old `data:tiles` tsx step no longer exists).
The npm scripts call `.venv\Scripts\python.exe` directly, so no activation is needed:

```powershell
pnpm run data:download     # scripts/ingest/download.ps1 -> data/raw/belarus-latest.osm.pbf (~351 MB)
pnpm run data:extract      # OSM PBF -> data/processed (GeoJSON-ish intermediates)
pnpm run data:normalize    # heights, archetypes, roof shapes -> public/data/tiles/*.json + manifest
pnpm run data:validate     # coverage statistics -> docs/COVERAGE_REPORT.md
# or all at once:
pnpm run data:all
```

Equivalent manual invocation if the npm scripts need overriding:

```powershell
.\.venv\Scripts\Activate.ps1
python scripts/ingest/extract.py
python scripts/normalize/normalize.py --tiles-dir public/data/tiles
python scripts/validation/coverage_report.py
```

Check the output:

```powershell
Get-Content public/data/tiles/manifest.json -Raw | ConvertFrom-Json | Select-Object counts,tileRange,pilotBounds
(Get-ChildItem public/data/tiles/*.json | Measure-Object).Count   # should be 17 (16 tiles + manifest)
```

---

## 3. Unit + data tests (Vitest)

```powershell
pnpm test                                        # all unit tests
pnpm test -- tests/unit/tile_math.test.ts        # single file
pnpm exec vitest run tests/unit/data             # real generated-data validation
pnpm exec vitest watch                           # watch mode
```

QA-owned tests:

- `tests/unit/tile_math.test.ts` — tile indexing/bounds/round-trips, ring/polygon
  area+bounds, world mapping, `tilesInRect`, `emptyTile`.
- `tests/unit/config_sync.test.ts` — parses `scripts/geo_config.py` and
  `src/shared/config.ts` textually and asserts `PILOT_SIZE_M`, `TILE_SIZE_M`,
  `INGEST_MARGIN_M`, centre lat/lon, EPSG codes, height constants, camera
  invariants. **Fails if the Python and TS configs drift.**
- `tests/unit/data/tiles.test.ts` — validates the *real* generated tiles:
  manifest schema/attribution, `bounds` vs `pilotBounds`, tile file existence and
  bytes, counts, plain unique building ids, heights 2..400 m, valid rings with
  ≥ 3 finite points, omitted-when-unknown `levels`, roads/surfaces/trees
  geometry, crossing-building ownership, central coverage. If
  `public/data/tiles/manifest.json` is absent the suite is **skipped with a
  warning** — check the "skipped" count, a skip is not a pass.

Note: `tests/unit/environment/**`, `tests/unit/buildings/**` etc. are owned by
other modules; they run in the same `pnpm test` invocation.

### 3.1 Geometry audit (no browser, real tiles)

Validates that the building mesh builder and environment mesh builder can consume
every generated tile: attributes present, no NaN, nothing below ground, triangle
owner maps consistent, no building emits zero triangles. Exits non-zero on issues.

```powershell
pnpm exec tsx scripts/qa/geometryAudit.ts
# writes screenshots/geometry-audit.json, prints per-tile totals and
# "GEOMETRY AUDIT PASSED" on success
```

---

## 4. E2E tests (Playwright)

```powershell
pnpm exec playwright test                       # headless SwiftShader, one worker, ~10 min at full city
$env:QA_GPU='1'; pnpm exec playwright test      # headless REAL GPU (ANGLE/D3D11), ~1 min — use this
pnpm exec playwright test --headed              # watch it in a real window
pnpm exec playwright test --grep "zoom"         # filter by test title
pnpm exec playwright test tests/e2e/city.spec.ts -g "10\."
$env:PWDEBUG='1'; pnpm exec playwright test     # step through with Inspector
pnpm exec playwright show-report                # open the HTML report (playwright-report/)
pnpm exec playwright show-trace test-results\<failed-test>\trace.zip
```

Behaviour:

- `playwright.config.ts` starts Vite through `webServer` on `QA_PORT` (default
  5173); a server already running on that port is reused
  (`reuseExistingServer: true`).
- `workers: 1`, `retries: 0`, 90 s per test, 60 s allowed for engine readiness,
  viewport 1600×900. Failure artefacts (screenshot, trace, video off) land in
  `test-results/`; the HTML report lands in `playwright-report/`.
- `QA_GPU=1` swaps the SwiftShader launch flags for ANGLE/D3D11 hardware flags.
  Without it, the full-city scene runs at ~1.9 FPS in software (measured), which
  can make the suite slow or hit action timeouts. The latest 30/31 run used
  `QA_GPU=1`; the complete current suite has not been rerun in software mode.
- Tests fail with explicit messages if `window.__CITY_APP__` is missing, if the
  city never becomes ready, or if a control does not affect the rendered image.
- Canvas screenshots allow a 60 s timeout (Playwright's default action timeout is
  15 s, too short for software WebGL).
- The renderer exposes `window.__CITY_APP__ = { ready, app, stats }` and
  `window.__CITY_STATS__`; the e2e suite drives the app through `CityAppHandle`
  and asserts image differences for visual controls.

The 12 core scenarios: shell + console-error-free load, `window.__CITY_APP__` contract,
geometry budget (`triangles > 1000`, `buildings > 100`), non-flat canvas,
pan/zoom/rotate, time-of-day slider, pixel-effect toggle, building pick → info
panel (OSM id), error-free 5 s interaction, reload. One scenario covers
instanced real-map trees, finite bounds, in-place canopy appearance changes,
unchanged instance storage and both worker/inline execution. Two museum scenarios
cover the Lipki exhibits and the city-dataset deep link; one covers rail LOD.

### Mobile / touch suite

`tests/e2e/mobile.spec.ts` uses a per-file Playwright context:

```ts
test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
```

- Real multi-touch is injected through the Chrome DevTools Protocol
  (`Input.dispatchTouchEvent` in `tests/e2e/support/touch.ts`), because
  `page.touchscreen` only supports single taps. This exercises Chromium's
  touch → pointer-event pipeline including `touch-action: none`.
- Covered: folded-by-default Settings panel, expand/fold, `localStorage`
  persistence, 45° rotate buttons, one-finger pan, pinch zoom, two-finger twist
  with compass snap, tap-to-select against a building found in the real tile
  data, no accidental selection after a gesture, a 320 px viewport without
  horizontal overflow, and a desktop test proving the panel still starts
  expanded there.
- Run only the mobile suite:

  ```powershell
  $env:QA_GPU='1'; pnpm exec playwright test tests/e2e/mobile.spec.ts --reporter=list
  ```

- These are emulated-phone checks in desktop Chromium. They are **not** a
  real-phone performance, iOS Safari or memory verifier; see
  `docs/LIMITATIONS.md` §7.

### If the whole page fails to boot mid-run

While other agents are editing `src/`, the Vite dev server can reload modules
between test steps; a test can then see a blank document (`canvasCount: 0`). The
e2e helper detects this (no canvas, no `__CITY_APP__`, no `#root` children for
10 s) and reloads the page **once**, recording a `document-boot-retry` annotation;
a real crash still fails on the retry. A mid-test HMR reload cannot be recovered —
re-run when `src/` is quiet:

```powershell
pnpm exec playwright test --grep "5\. mouse-drag pan"
```

---

## 5. Screenshot QA

```powershell
node scripts/qa/capture.mjs      # or the package.json alias:
pnpm run qa:capture
```

- Reuses a dev server on `http://127.0.0.1:5173` or starts one and kills it after.
- Waits for real readiness (`window.__CITY_APP__.ready`) **and for all manifest tiles
  to stream in** (`triangles > 5000` and `loadedTiles == manifest.tiles.length`;
  currently 16/16), settles ≥ 500 ms, and **fails with exit code 1** (no misleading
  images) if the app reports a fatal error or the city never finishes streaming.
- Writes `screenshots/01-overview.png` … `06-rotated.png`,
  `screenshots/stats.json` (EngineStats, WebGL renderer, capture mode, per-shot
  metadata incl. HUD numbers), `screenshots/console.log` (all browser console
  output). On failure it also writes `screenshots/00-failure.png` and a
  `failed: true` stats file.

Environment variables (PowerShell):

```powershell
$env:QA_GPU='1'                      # hardware GPU in headless Chromium (recommended;
                                     # default is SwiftShader software)
$env:QA_HEADLESS='0'                 # watch the capture in a visible browser
$env:QA_BASE_URL='http://127.0.0.1:5173'   # attach to a server instead of starting one
$env:QA_PORT='5174'                  # different port (dev-server mode)
$env:QA_READY_TIMEOUT_MS='120000'    # longer readiness budget on slow machines
pnpm run qa:capture                  # or: node scripts/qa/capture.mjs
```

Then quantify the images:

```powershell
node scripts/qa/analyze-screenshots.mjs
# -> screenshots/analysis.json   (unique colours, luminance, near-black share, content bbox)
$env:QA_ANALYZE_ALL='1'; node scripts/qa/analyze-screenshots.mjs   # include other agents' PNGs too
```

`nearBlackShare` is the fraction of sampled pixels with luminance < 8/255. At the
final milestone the canonical day shots are **0.0 %** near-black (the earlier
intermediate renderer was 38–59 %). The folder may also contain PNGs written by
other agents (`dev-baseline.png`, `measure.png`, `02-closeup.png`, `03-detail.png`,
`07-golden.png`, `probe-*.png`, etc.); by default only the six canonical capture
files are analysed.

---

## 6. Typecheck

```powershell
pnpm run typecheck      # tsc --noEmit
```

`tsconfig.json` includes `src`, `tests`, `scripts` and both Vite configs but **not**
`playwright.config.ts` (Playwright loads that itself). At the final milestone this
is clean (exit 0).

---

## 7. Common problems

| Symptom | Cause / fix |
| --- | --- |
| `Error: Port 5173 is already in use` (strictPort) | A dev server is already running — reuse it, or kill it: `Get-NetTCPConnection -LocalPort 5173 -State Listen \| ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }`. Do not run two servers. |
| Playwright: `Executable doesn't exist … chromium` | `pnpm exec playwright install chromium`. |
| E2E: `City app did not report ready`, overlay has "Failed to load city data" | `public/data/tiles/manifest.json` missing → run the data pipeline (§2). |
| E2E: readiness timeout with `canvasCount: 0` | Vite dev-server reload while files were being saved; re-run the test (see §4). |
| E2E suite takes ~10 min / tests time out on screenshots | You are on the default software renderer (~1.9 FPS at full city). Use `$env:QA_GPU='1'` for hardware WebGL. |
| Night screenshot (`04-night.png`) looks dark | Night windows are implemented; the old D4 report is historical. Check the time/facade-detail settings. Street lamps remain unimplemented. |
| Screenshots are completely black / empty | Renderer not ready or data missing: check `screenshots/00-failure.png` and `screenshots/console.log`, and whether `public/data/tiles/manifest.json` exists. |
| WebGL context creation fails in `pnpm exec playwright test` | Keep the SwiftShader flags from `playwright.config.ts` (`--enable-unsafe-swiftshader --use-angle=swiftshader`), or use `QA_GPU=1` on a GPU machine. |
| `QA_GPU=1` shows SwiftShader anyway | The machine has no usable GPU in the session; check `WEBGL_debug_renderer_info` in the app console, or fall back to the default mode. |
| `node scripts/qa/capture.mjs` hangs at startup | It may be building Vite's dependency cache; first run can take ~20 s. Use `QA_BASE_URL` to attach to an already-warm server. |
| Data tests report skips | Tiles not generated. Skips are printed with a warning on stderr. |
| Vitest fails on `ringArea` sign | Known contract mismatch (`docs/LIMITATIONS.md` §5) — the doc says positive = CCW, implementation is opposite. |
| `pnpm` warns `The "pnpm" field in package.json is no longer read` | Pre-existing workspace warning, harmless. |

---

## 8. CI notes (not set up yet)

There is no CI pipeline. A future pipeline should run, in order:

```powershell
pnpm install --frozen-lockfile
pnpm exec playwright install --with-deps chromium
pnpm run typecheck
pnpm test
pnpm exec playwright test          # add QA_GPU=1 on a hardware runner
node scripts/qa/capture.mjs        # add QA_GPU=1 on a hardware runner
node scripts/qa/analyze-screenshots.mjs
```

On Linux CI the same Playwright config works; the `webServer.command` uses
`pnpm exec vite …`, which is portable. CI machines usually have no GPU, so they run
the default SwiftShader mode (slow: budget ~10–15 min for the e2e step, or split
tests). `QA_GPU=1` is intended for local/hardware runners. Upload `screenshots/`,
`test-results/` and `playwright-report/` as artefacts.
