# QA Report — Isometric Minsk

**Report time:** 2026-10-27 ~15:45 local (Europe/Warsaw) — **final verification round**
**Author:** QA & Integration agent (qa-dev)
**Repo state:** no git commits (all files untracked, working-tree only). Five agents work in one directory; QA does not edit `src/**` — defects are reported to their owners, never fixed by QA.

---

## 1. Executive summary — final verification PASSED

| Check | Command | Latest result |
| --- | --- | --- |
| Unit + data tests (whole repo) | `pnpm test` | **224/224 passed** (14 files, 30.0 s) |
| QA-owned unit + data tests | `pnpm exec vitest run tests/unit/data tests/unit/tile_math.test.ts tests/unit/config_sync.test.ts` | **44/44 passed** |
| Typecheck | `pnpm exec tsc --noEmit` | **clean, exit 0** |
| E2E (real GPU) | `$env:QA_GPU='1'; pnpm exec playwright test` | **12/12 passed (1.0 min)** |
| E2E (default software SwiftShader) | `pnpm exec playwright test` | 10/12 in the milestone run — one HMR-race failure + one screenshot-timeout failure (fixed and re-verified); see §4.2 |
| Screenshots + stats | `$env:QA_GPU='1'; pnpm run qa:capture` | exit 0, 6/6 shots, **16/16 tiles**, 60 FPS, 0 console/page errors |
| Screenshot metrics | `node scripts/qa/analyze-screenshots.mjs` | 6/6 canonical PNGs, **0.0 % near-black**, `screenshots/analysis.json` |
| Geometry audit (Lead's tool) | `pnpm exec tsx scripts/qa/geometryAudit.ts` | **GEOMETRY AUDIT PASSED**, 0 issues |

**Application status:** the milestone build is complete and healthy. The district is fully
visible in the intended warm pixel-art palette — 654 buildings with window facades, pitched
and flat roofs, roads with markings, the Svislach river, parks/trees, correct isometric
framing — with 60 FPS / 50 draw calls / 182 303 triangles on a real GPU, no console or page
errors, working picking, time-of-day, pixel-art toggle and reload. **All P0/P1 defects
reported before this round are fixed**, including the HUD performance-panel freeze (D12) and
the dark pixel-art palette (D13). The 23:00 night preset is now readable but still lacks lit
windows/street lights (D4, minor art polish; marked known).

---

## 2. Environment

| Item | Value |
| --- | --- |
| OS | Windows 11, PowerShell (`pwsh`) |
| Node / pnpm | v24.13.0 / 11.22.0 |
| Vite dev server | 7.1.x on `http://127.0.0.1:5173` (started by QA, left running for the team) |
| Playwright | 1.64.1 (`@playwright/test`), Chromium 156.0.8078.4 |
| WebGL — default e2e/capture | WebGL 2.0 via ANGLE/SwiftShader (software): `ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)))` |
| WebGL — `QA_GPU=1` mode | WebGL 2.0 via ANGLE/D3D11 on the real GPU: `ANGLE (NVIDIA, NVIDIA GeForce RTX 3080 Laptop GPU, Direct3D11 vs_5_0)` — verified |
| Python pipeline | project `.venv`; source PBF `data/raw/belarus-latest.osm.pbf` (351 MB) |

Playwright installation (the one allowed `package.json` edit, done through pnpm so the
lockfile stayed consistent):

```powershell
pnpm add -D @playwright/test        # -> @playwright/test 1.64.1
pnpm exec playwright install chromium
pnpm exec playwright --version      # Version 1.64.1
```

`QA_GPU=1` is a QA-only opt-in (default remains SwiftShader for CI determinism): headless
Chromium + `--use-gl=angle --use-angle=d3d11 --ignore-gpu-blocklist --enable-gpu` gives
hardware rendering and ~30× the FPS, making e2e fast and FPS numbers meaningful.

---

## 3. Deliverables (QA scope)

| File | Purpose | State |
| --- | --- | --- |
| `playwright.config.ts` | e2e config: dev-server `webServer` (5173, strictPort, reuseExisting), `testDir tests/e2e`, `workers: 1`, `retries: 0`, 90 s/test, 1600×900, `outputDir test-results/`, SwiftShader default + `QA_GPU=1` hardware mode | verified |
| `tests/e2e/city.spec.ts` | 12 e2e tests (shell, `__CITY_APP__` contract, geometry, non-flat canvas, pan/zoom/rotate, time-of-day, pixel toggle, building pick, 5 s interaction, reload) + bounded boot retry + 60 s screenshot timeout | **12/12** |
| `scripts/qa/capture.mjs` | standalone capture: reuses/starts server, waits for readiness **and 16/16 tiles**, rejects <5000 triangles, 500 ms settle per shot, writes 6 PNGs + `stats.json` + `console.log`; exits 1 with evidence on failure | exit 0 |
| `scripts/qa/analyze-screenshots.mjs` | decodes the 6 canonical PNGs in Chromium → `screenshots/analysis.json` (colours, luminance, near-black share, content bbox); `QA_ANALYZE_ALL=1` includes other agents' PNGs | run |
| `scripts/qa/geometryAudit.ts` | Lead-owned headless mesh audit over all real tiles → `screenshots/geometry-audit.json` | PASSED (kept, referenced) |
| `tests/unit/tile_math.test.ts` | 20 tile-index/bounds/round-trip/geometry tests | 20/20 |
| `tests/unit/config_sync.test.ts` | 13 Python↔TypeScript config parity + physical-invariant tests | 13/13 |
| `tests/unit/data/tiles.test.ts` | 11 real-data validation tests | 11/11 |
| `docs/QA_REPORT.md` | this report | final |
| `docs/LIMITATIONS.md` | data / renderer / test limitations | updated |
| `docs/TESTING.md` | how to run everything on Windows PowerShell | updated |

---

## 4. Test results — final runs

### 4.1 Unit + data suites — 224/224 PASS

```
$ pnpm test
 Test Files  14 passed (14)
      Tests  224 passed (224)
   Duration  29.97s
```

`pnpm exec tsc --noEmit` → exit code **0** (clean).

QA-owned subset: **44/44** (13 config-sync + 20 tile-math + 11 data). Verified against the
real regenerated tiles (14:37 data revision), all passing:

- 16 tiles, tileRange −2..1, tileSize 512 m, EPSG 32635, origin UTM `[536859.254, 5972786.284]`, centre `53.9022, 27.561`;
- `manifest.bounds` = tile-grid extent `[-1024, -1024, 1024, 1024]`; `manifest.pilotBounds` = `[-800, -800, 800, 800]` inside bounds;
- counts agree with payload sums: **654 buildings** (69 explicit OSM height, 366 derived from `building:levels`, 219 heuristic; 305 explicit roof shapes), 679 surfaces, 3 811 roads, 3 775 trees;
- all building ids match plain `^[wr]\d+$` (multipolygon parts merged into volumes — 0 split ids), unique across ALL tiles;
- absent optional `levels` omitted (no JSON `null`); present levels are integers 1..100;
- heights 2.5–115.5 m within the 2..400 m contract; footprints are valid rings with ≥ 3 finite points, non-zero area, no NaN;
- roads/surfaces/trees valid; `crossingBuildingIds` correct; every tile near the pilot centre has roads or surfaces.

Geometry audit (Lead's tool): `GEOMETRY AUDIT PASSED` — 654 buildings, 65 372 building +
117 856 environment triangles, y range 0.0–115.9 m, no NaN, all attributes present,
triangle-owner maps consistent, no building without triangles.

### 4.2 E2E suite — 12/12 PASS (final build, real GPU, 1.0 min)

Final run: `$env:QA_GPU='1'; pnpm exec playwright test` → **12 passed (1.0m)**.

| # | Test | Duration | Observed values (final run) |
| --- | --- | --- | --- |
| 1 | app shell, non-zero canvas, no console/page errors | 5.3 s | loading overlay hidden, 0 errors |
| 2 | `window.__CITY_APP__ = { ready, app, stats }` within 60 s | 2.6 s | 19/19 `CityAppHandle` methods, EngineStats exposed |
| 3 | real Minsk geometry (triangles > 1000, buildings > 100) | 2.2 s | **fps 60, frameMs 16.7, drawCalls 38, triangles 153 703, buildings 572, 12 tiles, render 640×360, geometryMB 20.72** (mid-stream snapshot; after streaming completes it is 182 303 tri / 654 buildings / 16 tiles — see capture) |
| 4 | canvas is a real image | 4.2 s | 7 812 unique colours, luminance σ=51.9, mean=105.5 |
| 5 | mouse-drag pan changes the rendered image | 5.8 s | **image diff 0.638** |
| 6 | wheel zoom changes `orthoHeight` | 3.2 s | 659.7 → 348.1 |
| 7 | rotation changes `azimuth` | 3.2 s | 0.785 → 2.356 rad |
| 8 | time-of-day slider changes the rendered image | 4.8 s | `getTimeOfDay()=23`, label 23:00, **diff 0.953** |
| 9 | pixel-effect toggle changes the rendered image | 5.4 s | enabled→disabled→enabled, **diff 0.193** (lower now that both modes share the same bright palette) |
| 10 | clicking a building opens the info panel | 4.0 s | selected `w25432666` (khrushchev), OSM id validated, panel closes |
| 11 | no uncaught errors during 5 s of interaction | 11.0 s | 0 page errors, 0 console errors |
| 12 | page reload re-renders the city | 6.5 s | ready again, non-flat canvas, 0 errors |

Earlier runs (kept for honesty):
- **Milestone run before the art/palette pass** on real GPU: 12/12 in 1.8 min; test 3 then
  reported 50.3 FPS / 178 025 triangles / 48 draw calls / 654 buildings / 16 tiles.
- **Default SwiftShader run:** 10/12 in 10.2 min. Failures: (a) test 5 — mid-test Vite HMR
  reload destroyed the page execution context while agents were saving files (harness race,
  not an app bug; passed in GPU runs); (b) test 9 — 15 s Playwright screenshot timeout at
  1.9 FPS. **Fixed:** canvas screenshots allow 60 s; the test was re-run in software mode:
  **PASS (47.5 s, diff 0.892)**. A full software-mode 12/12 run was not repeated end-to-end
  (≈10 min); the GPU run is the clean suite.

### 4.3 Typecheck

`pnpm exec tsc --noEmit` → **exit 0, no errors** across `src`, `tests`, `scripts` and both Vite configs.

---

## 5. Screenshots and visual QA — final baseline

Captured with `$env:QA_GPU='1'; pnpm run qa:capture` (exit 0, 6/6 shots, **16/16 tiles
loaded before the first shot**, 0 console errors, 0 page errors). Files in `screenshots/`;
engine stats in `screenshots/stats.json`; console in `screenshots/console.log`; metrics in
`screenshots/analysis.json`. HUD numbers in the screenshots are the app's own auto-updated
values (the earlier D12 "Refresh stats" workaround was removed and the panel updates on its
own — proof the fix works).

Canonical metrics (`node scripts/qa/analyze-screenshots.mjs`):

| Screenshot | Bytes | Unique colours | Mean luminance | Near-black (<8/255) | Content bbox |
| --- | --- | --- | --- | --- | --- |
| `01-overview.png` | 556 KB | 7 518 | 105.5 | **0.0 %** | 1596×900 |
| `02-closeup-residential.png` | 459 KB | 4 575 | 95.9 | **0.0 %** | 1596×900 |
| `03-closeup-landmark.png` | 591 KB | 7 408 | 99.7 | **0.0 %** | 1596×900 |
| `04-night.png` | 447 KB | 2 210 | 37.9 | 0.0 % | 1596×900 |
| `05-clean-3d.png` | 604 KB | 8 315 | **111.4** | 0.0 % | 1596×900 |
| `06-rotated.png` | 545 KB | 7 129 | 100.5 | 0.0 % | 1596×900 |

(The `screenshots/` folder also contains PNGs written by other agents — `dev-baseline.png`,
`measure.png`, `02-closeup.png`, `03-detail.png`, `07-golden.png`, `probe-*.png`,
`check-now.png`, etc. They are not produced by `capture.mjs`; the canonical set is exactly
the six files above.)

Pixel-art / visual assessment (read from the final PNGs):

1. **Overview (`01`)** — complete, centred district in the intended pixel-art style: warm
   orange/red roofs, light grey-white walls, dark grey roads with dashed markings, deep-blue
   Svislach river, green parks/tree masses; readable HUD + attribution; 60 FPS, 182 303
   triangles, 16 tiles, 654 buildings at 640×360 internal resolution. Looks like a
   deliberate isometric pixel-art city, not a renderer stub.
2. **Residential close-up (`02`)** — crisp pixel-art Khrushchev blocks with window grids,
   floor bands, orange pitched roofs, courtyard greens, tree-lined streets and crisp road
   markings; dithering is coherent at this zoom.
3. **Landmark close-up (`03`)** — large civic building near October Square with roof volumes;
   dense surrounding blocks and parks; facades/rooflines read correctly.
4. **Night preset (`04`)** — 23:00 now produces a readable blue-tinted night scene (mean
   luminance 37.9, 2 210 colours; previously 21.9 / 451). Buildings, river and roads are
   discernible; it still has **no lit windows or street lights** (see D4 — minor art polish,
   known).
5. **Clean 3D (`05`)** — pixel effect off at full 1600×900: bright albedo/geometry reference
   (mean 111.4, 8 315 colours). Its brightness now closely matches the pixel-art view
   (105.5) — the D13 darkness defect is fixed; the pixel pipeline no longer crushes the
   palette.
6. **Rotated (`06`)** — 90° azimuth: complete district, river and parks, framing stays
   centred (D3 fixed); HUD correct.
7. HUD performance panel numbers in all six PNGs are current and correct (60 FPS, 16 tiles,
   654 buildings, 182 303 triangles in the full-view shots) — D12 fixed and visually verified.

### Performance (real GPU, final build)

| Run | Renderer | FPS | frameMs | drawCalls | triangles | tiles | buildings | render size | geometryMB |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| final e2e (test 3, mid-stream) | ANGLE/D3D11 RTX 3080 | **60** | 16.7 | 38 | 153 703 | 12 | 572 | 640×360 | 20.72 |
| final capture (after 16/16 tiles) | ANGLE/D3D11 RTX 3080 | **60** (vsync cap) | 16.7 | 50 | 182 303 | 16 | 654 | 640×360 | 24.23 |
| early-GPU milestone run | ANGLE/D3D11 RTX 3080 | 50.3 | 19.9 | 48 | 178 025 | 16 | 654 | 640×360 | 24.23 |
| default software run | ANGLE/SwiftShader | 1.9 | 516.7 | 48 | 178 025 | 16 | 654 | 640×360 | 24.23 |

The 60 FPS figure is the display cap; ~182 k triangles / ~50 draw calls / 24 MB GPU geometry
is comfortable for the RTX 3080 Laptop. SwiftShader is software rasterisation — it is only
why the default e2e path is slow, never a performance claim.

---

## 6. Defect status — final

| ID | Priority | Status | Notes / evidence |
| --- | --- | --- | --- |
| D1 | P0 | ✅ **FIXED** | Environment renders: ground, roads/markings, river, parks, trees visible; near-black share 0.0 % (was 38–59 %). `01`, `05`. |
| D2 | P0 | ✅ **FIXED** | Facade shader compiles; buildings lit with windows/roofs; 0 console errors; e2e 12/12. |
| D3 | P1 | ✅ **FIXED** | Camera frames the pilot correctly: overview and rotated views centred (`01`, `06`); default orthoHeight ≈ 660–692 m. |
| D4 | P1 | 🟡 **IMPROVED / minor polish** | Night preset now readable (mean lum 37.9, 2 210 colours; was 21.9 / 451) and clearly blue-tinted, but has no lit windows/street lights. Known art polish; not a functional defect. Evidence `04-night.png`. |
| D5 | P1 | ✅ **RESOLVED (accepted)** | Close-range roof/facade stipple is deliberate pixel-art dithering, coherent in the final close-ups (`02`, `03`) and clean-3D render; not z-fighting. |
| D6 | P2 | ✅ FIXED (data 14:37) | `manifest.bounds` = tile extent ±1024 m; new `manifest.pilotBounds` = ±800 m; `types.ts` updated; data test asserts both. |
| D7 | P2 | ✅ FIXED (data 14:37) | Multipolygon parts merged: all 654 ids plain `^[wr]\d+$`, 0 split ids. |
| D8 | P2 | ✅ FIXED (data 14:37) | Absent `levels` omitted, never `null`. |
| D9 | P2 | ✅ FIXED | `LoadingOverlay` stays visible while an error is set (source verified). |
| D10 | P3 | ✅ FIXED | `geometryMB` now 24.23 MB for 182 k triangles (was 0.046 MB). |
| D11 | P3 | 🟢 MITIGATED | Dev-server HMR can still destroy a page mid-test while agents edit files (one software-run failure). `openApp()` reloads once for a never-booted document; mid-test reloads fail honestly. Run e2e when `src/` is quiet. |
| D12 | P2 | ✅ **FIXED** | HUD performance panel froze because the renderer re-emitted one mutated `EngineStats` reference; the shell now stores a copy (`src/app/App.tsx`: `const snapshot = { ...next }; setStats(snapshot);`). Verified: HUD auto-shows `16 tiles / 654 buildings / 182 303 tri` with no "Refresh stats" click; the capture-time refresh workaround was removed and screenshots still show correct values. |
| D13 | P2 | ✅ **FIXED** | Pixel-art mode no longer darkens/desaturates the scene: same view now mean luminance 105.5 vs 111.4 for clean-3D (was 74.6 vs 114.8), 7 518 vs 8 315 colours. Pixel-mode overview is the intended bright look. |
| D14 | P3 | ℹ️ Note (not a defect) | In `04-night.png` the HUD label still reads 13:00 because the capture script calls the scene API directly (`setTimeOfDay(23)`), bypassing the React slider state. A real user moving the slider sees the label follow (e2e test 8 asserts label `23:00`). |

No open functional defects remain at this milestone. D4 is art polish (lit windows at night);
D11/D14 are harness notes.

---

## 7. Verified vs. not verified (honesty section)

**Verified:**
- 224/224 unit tests, 44/44 QA tests, clean `tsc --noEmit`;
- **12/12 e2e passed** on the final build (real GPU, 1.0 min) with all interactions asserted by image diffs/app state;
- canonical 6/6 screenshots for the final build, full 16/16 tiles, 0 console/page errors, correct auto-updated HUD;
- 0.0 % near-black on all six canonical shots; environment, framing, river/parks/roads confirmed visually;
- pre/post palette comparison (D13) and night improvement (D4) measured from PNGs;
- performance measured on this machine's real GPU (60 FPS, 182 303 triangles, 50 draw calls, 24.23 MB).

**Not verified / caveats:**
- **Default SwiftShader 12/12 run**: only 10/12 was observed at the milestone; the two causes were an HMR race and a screenshot timeout, the latter fixed and re-verified in isolation (test 9 PASS, 47.5 s). The full software suite was not re-run end-to-end (~10 min at 1.9 FPS) — the clean suite is the GPU run.
- **Integrated-GPU / older-hardware performance** not measured.
- **D4 lit-window night look** is future art polish, not verified (not implemented yet).
- D9 error-overlay with a *forced* data failure was not re-triggered in the browser; fix verified by source inspection.

---

## 8. Next steps (owner: QA)

1. Keep `pnpm test` (224) and `pnpm exec tsc --noEmit` green; run `$env:QA_GPU='1'; pnpm exec playwright test` for fast clean e2e verification.
2. If further art changes land (e.g. lit windows for D4), re-run `$env:QA_GPU='1'; pnpm run qa:capture` + `node scripts/qa/analyze-screenshots.mjs`, re-read the PNGs and update §5/D4.
3. Optionally add a CI job: unit+typecheck always; e2e in SwiftShader mode (slow) or on a hardware runner with `QA_GPU=1`.
4. Optionally add golden-image regression for the six canonical screenshots once art is frozen (currently manual review + numeric metrics only).
