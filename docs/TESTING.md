# Testing — Isometric Minsk (Windows / PowerShell)

Everything here was run on Windows 11 with PowerShell (`pwsh`) on 2026-10-27.
Commands assume the repository root: `D:\Workk\VoxelMinsk`.

| Suite | Command | What it covers | Typical time |
| --- | --- | --- | --- |
| Unit + data | `pnpm test` | all `tests/unit/**/*.test.ts` incl. QA tile-math, config-sync and real-data validation | ~2–20 s |
| QA unit only | `pnpm exec vitest run tests/unit/data tests/unit/tile_math.test.ts tests/unit/config_sync.test.ts` | 44 QA-owned tests | ~1 s |
| E2E | `pnpm exec playwright test` | 12 browser tests against the real app + dev server | ~3.5–4 min |
| Screenshots | `node scripts/qa/capture.mjs` | 6 fixed screenshots + `screenshots/stats.json` + `screenshots/console.log` | ~30 s |
| Screenshot metrics | `node scripts/qa/analyze-screenshots.mjs` | `screenshots/analysis.json` (colour/luminance/near-black/content bbox) | ~5 s |
| Typecheck | `pnpm run typecheck` | `tsc --noEmit` over `src`, `tests`, `scripts` | ~10 s |

---

## 1. Prerequisites (one-time)

```powershell
node --version        # v24.x
pnpm --version        # 11.x
pnpm install
pnpm exec playwright install chromium   # downloads Chromium 156 + headless shell + ffmpeg
pnpm exec playwright --version          # 1.64.1
```

The data pipeline needs Python 3.11+ with the project virtualenv:

```powershell
# activate the existing venv (created by the data agent)
.\.venv\Scripts\Activate.ps1
python --version
```

If PowerShell blocks activation: `Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass`.

Headless WebGL uses ANGLE/SwiftShader (software) and is configured in
`playwright.config.ts`; no GPU is required for tests.

---

## 2. Generate the data (only when `public/data/` is missing or stale)

The renderer needs `public/data/tiles/manifest.json` + `public/data/tiles/*.json`.

```powershell
.\.venv\Scripts\Activate.ps1
pnpm run data:extract     # Python: OSM PBF -> normalised GeoJSON (needs data/raw/*.osm.pbf)
pnpm run data:normalize   # Python: heights, archetypes, roof shapes
pnpm run data:tiles       # tsx: local-metre tiles + manifest
pnpm run data:coverage    # Python: docs/COVERAGE_REPORT.md statistics
# or all at once:
pnpm run data:all
```

Check the output:

```powershell
Get-Content public/data/tiles/manifest.json -Raw | ConvertFrom-Json | Select-Object counts
Get-ChildItem public/data/tiles | Measure-Object
```

`scripts/ingest/extract.py` expects the Geofabrik Belarus extract at
`data/raw/belarus-latest.osm.pbf` (351 MB). Downloading is a manual step; the
retrieval command is documented in `docs/DATA_SOURCES.md`.

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
  manifest schema/attribution, tile file existence/bytes/parse, counts, unique
  building ids, heights 2..400 m, valid rings with ≥ 3 finite points, roads/
  surfaces/trees geometry, crossing-building ownership, central coverage.
  If `public/data/tiles/manifest.json` is absent the suite is **skipped with a
  warning** — check the "skipped" count, a skip is not a pass.

Note: `tests/unit/environment/**` and `tests/unit/buildings/**` are owned by
other modules; they run in the same `pnpm test` invocation.

---

## 4. E2E tests (Playwright)

```powershell
pnpm exec playwright test                       # headless, one worker, auto-starts dev server
pnpm exec playwright test --headed              # watch it in a real window
pnpm exec playwright test --grep "zoom"         # filter by test title
pnpm exec playwright test tests/e2e/city.spec.ts -g "10\."
$env:PWDEBUG='1'; pnpm exec playwright test     # step through with Inspector
pnpm exec playwright show-report                # open the HTML report (playwright-report/)
pnpm exec playwright show-trace test-results\<failed-test>\trace.zip
```

Behaviour:

- `playwright.config.ts` starts `pnpm exec vite --port 5173 --strictPort --host 127.0.0.1`
  itself via `webServer`; if a dev server is **already** running on 5173 it is
  reused (`reuseExistingServer: true`). Never start a second one on that port.
- `workers: 1`, `retries: 0`, 90 s per test, 60 s allowed for engine readiness,
  viewport 1600×900. Failure artefacts (screenshot, trace, video off) land in
  `test-results/`; the HTML report lands in `playwright-report/`.
- Tests fail with explicit messages if `window.__CITY_APP__` is missing, if the
  city never becomes ready, or if a control does not affect the rendered image.

The 12 tests: shell + console-error-free load, `window.__CITY_APP__` contract,
geometry budget (`triangles > 1000`, `buildings > 100`), non-flat canvas,
pan/zoom/rotate, time-of-day slider, pixel-effect toggle, building pick → info
panel (OSM id), error-free 5 s interaction, reload.

### If the whole page fails to boot mid-run

While other agents are editing `src/`, the Vite dev server can reload modules
between test steps; a test can then see a blank document (`canvasCount: 0`). This
is not an app failure — re-run the affected test:

```powershell
pnpm exec playwright test --grep "5\. mouse-drag pan"
```

---

## 5. Screenshot QA

```powershell
node scripts/qa/capture.mjs
```

- Reuses a dev server on `http://127.0.0.1:5173` or starts one and kills it after.
- Waits for real readiness (`window.__CITY_APP__.ready`, then `triangles > 5000`),
  settles before every shot, and **fails with exit code 1** (no misleading images)
  if the app reports a fatal error or no geometry renders.
- Writes `screenshots/01-overview.png` … `06-rotated.png`,
  `screenshots/stats.json` (EngineStats + per-shot metadata),
  `screenshots/console.log` (all browser console output). On failure it also
  writes `screenshots/00-failure.png` and a `failed: true` stats file.

Environment variables (PowerShell):

```powershell
$env:QA_HEADLESS='0'                 # watch the capture in a visible browser
$env:QA_BASE_URL='http://127.0.0.1:5173'   # attach to a server instead of starting one
$env:QA_PORT='5174'                  # different port (dev-server mode)
$env:QA_READY_TIMEOUT_MS='120000'    # longer readiness budget on slow machines
node scripts/qa/capture.mjs
```

Then quantify the images:

```powershell
node scripts/qa/analyze-screenshots.mjs
# -> screenshots/analysis.json   (unique colours, luminance, near-black share, content bbox)
```

`nearBlackShare` is the fraction of sampled pixels with luminance < 8/255. The
current intermediate renderer shows 38–59 % near-black because the ground layer
is not drawing — see `docs/QA_REPORT.md` §6, defect D1.

---

## 6. Typecheck

```powershell
pnpm run typecheck      # tsc --noEmit
```

`tsconfig.json` includes `src`, `tests`, `scripts` and both Vite configs but **not**
`playwright.config.ts` (Playwright loads that itself). During parallel development
`tsc` may fail in another agent's in-progress `src/engine/**` files; check the
reported paths before treating a failure as yours.

---

## 7. Common problems

| Symptom | Cause / fix |
| --- | --- |
| `Error: Port 5173 is already in use` (strictPort) | A dev server is already running — reuse it, or kill it: `Get-NetTCPConnection -LocalPort 5173 -State Listen \| ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }`. Do not run two servers. |
| Playwright: `Executable doesn't exist … chromium` | `pnpm exec playwright install chromium`. |
| E2E: `City app did not report ready`, overlay has "Failed to load city data" | `public/data/tiles/manifest.json` missing → run the data pipeline (§2). |
| E2E: readiness timeout with `canvasCount: 0` | Vite dev-server reload while files were being saved; re-run the test (see §4). |
| Screenshots are black | Renderer/environment modules not finished (see `docs/QA_REPORT.md` §6). Not a test bug. |
| WebGL context creation fails in `pnpm exec playwright test` | Keep the SwiftShader flags from `playwright.config.ts` (`--enable-unsafe-swiftshader --use-angle=swiftshader`). |
| `node scripts/qa/capture.mjs` hangs at startup | It may be building Vite's dependency cache; first run can take ~20 s. Use `QA_BASE_URL` to attach to an already-warm server. |
| Data tests report `10 skipped` | Tiles not generated. Skips are printed with a warning on stderr. |
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
pnpm exec playwright test
node scripts/qa/capture.mjs
node scripts/qa/analyze-screenshots.mjs
```

On Linux CI the same Playwright config works; the `webServer.command` uses
`pnpm exec vite …` which is portable. Upload `screenshots/`, `test-results/` and
`playwright-report/` as artefacts.
