# QA Report — Isometric Minsk

**Report time:** 2026-10-27 ~15:25 local (Europe/Warsaw) — renderer milestone
**Author:** QA & Integration agent (qa-dev)
**Repo state:** no git commits (all files untracked, working-tree only). Five agents work in one directory; nothing in this report was "fixed by QA" — `src/**` is outside QA's write scope, defects are reported to their owners.

---

## 1. Executive summary — milestone verification PASSED

| Check | Command | Latest result |
| --- | --- | --- |
| Unit + data tests (whole repo) | `pnpm test` | **221/221 passed** (14 files, 21.6 s) |
| QA-owned unit + data tests | `pnpm exec vitest run tests/unit/data tests/unit/tile_math.test.ts tests/unit/config_sync.test.ts` | **44/44 passed** |
| Typecheck | `pnpm exec tsc --noEmit` | **clean, exit 0** |
| E2E (real GPU) | `$env:QA_GPU='1'; pnpm exec playwright test` | **12/12 passed** (1.8 min) |
| E2E (default software SwiftShader) | `pnpm exec playwright test` | 10/12 — one HMR-race failure (test 5) and one screenshot-timeout failure (test 9, fixed and **re-run: PASS**); see §4.2 |
| Screenshots + stats | `$env:QA_GPU='1'; pnpm run qa:capture` | exit 0, 6/6 shots, **16/16 tiles**, 0 console/page errors |
| Screenshot metrics | `node scripts/qa/analyze-screenshots.mjs` | `screenshots/analysis.json` — **0 % near-black** on canonical day shots (was 38–59 % before the fix) |
| Geometry audit (Lead's tool) | `pnpm exec tsx scripts/qa/geometryAudit.ts` | **GEOMETRY AUDIT PASSED**, 0 issues |

**Application status at this milestone:** the district is fully visible and interactive —
654 buildings with facades and roofs, roads with markings, the Svislach river/water,
parks and trees, correct isometric framing, building picking, time-of-day, pixel-art
toggle, clean console, 50–60 FPS on the real GPU. **Known transient art issue:** with the
pixel-art post-effect on, the render is noticeably darker/desaturated than the clean-3D
view (global brightness + palette fix is still being worked by art direction, per the Lead);
the 23:00 night preset is currently too dark to read. Both are marked as known/transient
below, not as unexplained defects.

Visual quality at the milestone can be judged from: `screenshots/01-overview.png`,
`02-closeup-residential.png`, `03-closeup-landmark.png`, `05-clean-3d.png`,
`06-rotated.png`; the night preset is `screenshots/04-night.png`.

---

## 2. Environment

| Item | Value |
| --- | --- |
| OS | Windows 11, PowerShell (`pwsh`) |
| Node / pnpm | v24.13.0 / 11.22.0 |
| Vite dev server | 7.1.x on `http://127.0.0.1:5173` (started by QA and left running for the team) |
| Playwright | 1.64.1 (`@playwright/test`), Chromium 156.0.8078.4 |
| WebGL — default e2e/capture | WebGL 2.0 via ANGLE/SwiftShader (software): `ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)))` |
| WebGL — `QA_GPU=1` mode | WebGL 2.0 via ANGLE/D3D11 on the real GPU: `ANGLE (NVIDIA, NVIDIA GeForce RTX 3080 Laptop GPU, Direct3D11 vs_5_0)` — verified |
| Python pipeline | project `.venv`; source PBF `data/raw/belarus-latest.osm.pbf` (351 MB) |

Playwright installation (the one allowed `package.json` edit, done via pnpm so the
lockfile stayed consistent):

```powershell
pnpm add -D @playwright/test        # -> @playwright/test 1.64.1
pnpm exec playwright install chromium
pnpm exec playwright --version      # Version 1.64.1
```

`QA_GPU=1` is a QA-only opt-in added in this round (default remains SwiftShader for CI
determinism): headless Chromium + `--use-gl=angle --use-angle=d3d11 --ignore-gpu-blocklist
--enable-gpu` gives hardware rendering and ~30× the FPS, which makes e2e fast and FPS
numbers meaningful. It was verified with `WEBGL_debug_renderer_info`.

---

## 3. Deliverables (QA scope)

| File | Purpose | State |
| --- | --- | --- |
| `playwright.config.ts` | e2e config: dev-server `webServer` (port 5173, strictPort, reuseExisting), `testDir tests/e2e`, `workers: 1`, `retries: 0`, 90 s/test, 1600×900, `outputDir test-results/`, SwiftShader default + `QA_GPU=1` hardware mode | verified |
| `tests/e2e/city.spec.ts` | 12 e2e tests (shell, `__CITY_APP__` contract, geometry, non-flat canvas, pan/zoom/rotate, time-of-day, pixel toggle, building pick, 5 s interaction, reload) + bounded document-boot retry, 60 s screenshot timeout | 12/12 on GPU |
| `scripts/qa/capture.mjs` | standalone capture: reuses/starts server, waits for readiness **and all 16 tiles**, rejects <5000 triangles, 500 ms settle + HUD stats refresh per shot, writes 6 PNGs + `stats.json` + `console.log`; exits 1 with evidence on failure | exit 0 at milestone |
| `scripts/qa/analyze-screenshots.mjs` | decodes PNGs in Chromium → `screenshots/analysis.json` (colours, luminance, near-black share, content bbox) | run |
| `scripts/qa/geometryAudit.ts` | Lead-owned headless mesh audit over all real tiles → `screenshots/geometry-audit.json` | PASSED (kept, referenced, not modified) |
| `tests/unit/tile_math.test.ts` | 20 tile-index/bounds/round-trip/geometry tests | 20/20 |
| `tests/unit/config_sync.test.ts` | 13 Python↔TypeScript config parity + physical-invariant tests | 13/13 |
| `tests/unit/data/tiles.test.ts` | 11 real-data validation tests (new data contract) | 11/11 |
| `docs/QA_REPORT.md` | this report | updated at milestone |
| `docs/LIMITATIONS.md` | data / renderer / test limitations | updated at milestone |
| `docs/TESTING.md` | how to run everything on Windows PowerShell | updated at milestone |

---

## 4. Test results — actual latest runs

### 4.1 Unit + data suites — 221/221 PASS

```
$ pnpm test
 ✓ tests/unit/tile_math.test.ts (20 tests)
 ✓ tests/unit/config_sync.test.ts (13 tests)
 ✓ tests/unit/data/tiles.test.ts (11 tests)
 ... (other modules' suites)
 Test Files  14 passed (14)
      Tests  221 passed (221)
   Duration  21.60s
```

`pnpm exec tsc --noEmit` → exit code **0** (clean, all repo files).

QA-owned subset: **44/44** (13 config-sync + 20 tile-math + 11 data).

Data facts verified against the **real** regenerated tiles (14:37 data revision):

- 16 tiles, tileRange −2..1, tileSize 512 m, EPSG 32635, origin UTM `[536859.254, 5972786.284]`, centre `53.9022, 27.561`;
- `manifest.bounds` = tile-grid extent `[-1024, -1024, 1024, 1024]`; `manifest.pilotBounds` = `[-800, -800, 800, 800]` (inside bounds);
- counts agree with payload sums: **654 buildings** (69 explicit OSM height, 366 derived from levels, 219 heuristic; 305 explicit roof shapes), 679 surfaces, 3 811 roads, 3 775 trees;
- all building ids match plain `^[wr]\d+$` (multipolygon parts merged into one feature with volumes — 0 split ids), unique across ALL tiles;
- absent optional `levels` omitted (no JSON `null`); present levels are integers 1..100;
- heights 2.5–115.5 m, within the 2..400 m contract; footprints are valid rings with ≥ 3 finite points and non-zero area; no NaN;
- roads/surfaces/trees geometry valid; `crossingBuildingIds` correct; every tile near the pilot centre has roads or surfaces.

Auxiliary geometry audit (`pnpm exec tsx scripts/qa/geometryAudit.ts`, Lead's tool):
`GEOMETRY AUDIT PASSED` — 654 buildings, 65 372 building triangles + 117 856 environment
triangles + 48 930 roof / 82 524 wall triangles, y range 0.0–115.9 m, no NaN, all
attributes present, triangle-owner maps consistent, no building without triangles.
These totals agree with the renderer's reported 182 303 drawn triangles.

### 4.2 E2E suite — 12/12 PASS on real GPU (clean run)

**Run A (default SwiftShader, before the screenshot-timeout fix):** 10 passed / 2 failed,
10.2 min, at 1.9 FPS software rendering:

- test 5 (pan): `page.evaluate: Execution context was destroyed, most likely because of a
  navigation` inside the image-diff helper — a Vite HMR reload happened mid-test because
  other agents were saving files (also proof that the bounded boot-retry cannot hide
  mid-test reloads; it only handles a never-booted document).
- test 9 (pixel toggle): `page.screenshot: Timeout 15000ms exceeded` — Playwright's action
  timeout was too short for a 1600×900 screenshot while the software renderer was at
  ~2 FPS. **Fixed in QA scope:** canvas screenshots now allow 60 s. Re-ran the test in the
  same default software mode afterwards: **PASS (47.5 s, pixel-toggle image diff 0.892)**.
- test 5 (pan) is not fixable in the harness — it needs a moment when no agent is saving
  `src/` files (a mid-test HMR reload destroyed the execution context); it passed in the
  GPU run and in an isolated re-run earlier.

**Run B (real GPU, `QA_GPU=1`, after the fix): 12/12 passed, 1.8 min.**

| # | Test | Duration | Observed values |
| --- | --- | --- | --- |
| 1 | app shell, non-zero canvas, no console/page errors | 21.9 s | loading overlay hidden, 0 errors |
| 2 | `window.__CITY_APP__ = { ready, app, stats }` within 60 s | 8.3 s | 19/19 `CityAppHandle` methods, EngineStats exposed |
| 3 | real Minsk geometry (triangles > 1000, buildings > 100) | 8.1 s | **fps 50.3, frameMs 19.9, drawCalls 48, triangles 178 025, buildings 654, tiles 16, render 640×360, geometryMB 24.23** |
| 4 | canvas is a real image (non-uniform pixels) | 8.8 s | 4 150 unique colours, luminance σ=50.5, mean=67.6 |
| 5 | mouse-drag pan changes the rendered image | 14.3 s | **image diff 0.773** |
| 6 | wheel zoom changes `orthoHeight` | 6.2 s | 692.4 → 582.2 (new renderer auto-fits the pilot: default ≈ 660–692) |
| 7 | rotation changes `azimuth` | 3.1 s | 0.785 → 2.356 rad |
| 8 | time-of-day slider changes the rendered image | 5.2 s | `getTimeOfDay()=23`, label 23:00, **diff 0.951** |
| 9 | pixel-effect toggle changes the rendered image | 5.2 s | enabled→disabled→enabled, **diff 0.888** |
| 10 | clicking a building opens the info panel | 3.3 s | selected `w25432666` (khrushchev), OSM id validated, panel closes |
| 11 | no uncaught errors during 5 s of interaction | 10.8 s | 0 page errors, 0 console errors |
| 12 | page reload re-renders the city | 4.6 s | ready again, non-flat canvas, 0 errors |

E2E test 9's failure mode is fixed but **has not been re-verified under the default
SwiftShader mode** after the fix (the clean 12/12 was on GPU). The fix is a timeout only;
the next default-mode run will confirm it (see §7).

### 4.3 Typecheck

`pnpm exec tsc --noEmit` → **exit 0, no errors** (previously 10 errors in in-progress
renderer files; those were fixed by the renderer owner).

---

## 5. Screenshots and visual QA (milestone baseline)

Captured with `$env:QA_GPU='1'; pnpm run qa:capture` (exit 0, 6/6 shots, 16/16 tiles
loaded before the first shot, 0 console errors, 0 page errors). Files in `screenshots/`;
engine stats in `screenshots/stats.json`; console in `screenshots/console.log`; metrics in
`screenshots/analysis.json`.

Canonical metrics (from `node scripts/qa/analyze-screenshots.mjs`):

| Screenshot | Bytes | Unique colours | Mean luminance | Near-black (<8/255) | Content bbox |
| --- | --- | --- | --- | --- | --- |
| `01-overview.png` | 486 KB | 3 591 | 74.6 | **0.0 %** | 1596×900 |
| `02-closeup-residential.png` | 476 KB | 3 471 | 75.1 | **0.0 %** | 1596×900 |
| `03-closeup-landmark.png` | 567 KB | 4 601 | 79.0 | **0.0 %** | 1596×900 |
| `04-night.png` | 166 KB | 451 | 21.9 | 0.0 % | 1596×900 |
| `05-clean-3d.png` | 580 KB | 7 196 | **114.8** | 0.2 % | 1596×900 |
| `06-rotated.png` | 460 KB | 2 962 | 70.8 | 0.0 % | 1596×900 |

For comparison, the pre-milestone renderer had **38.3–58.9 %** near-black pixels in the
same shots (missing environment) — that defect is gone. (The `screenshots/` folder also
contains PNGs written by other agents — `dev-baseline.png`, `measure.png`,
`02-closeup.png`, `03-detail.png`, `probe-*.png`; they are not produced by
`capture.mjs` and are excluded from the canonical table.)

Pixel-art / visual assessment (read from the PNGs):

1. **Overview (`01`)** — complete, correctly centred district in classic isometric view;
   roads with dashed markings, the Svislach river/water (top-right blue), green parks and
   tree clusters, building blocks with grey/white roofs and beige/red-brick walls; grey sky
   gradient; header, attribution and HUD all legible. HUD at capture: 60 FPS, 182 303
   triangles, 16 tiles, 654 buildings, render 640×360. **The image is noticeably darker and
   more desaturated than the clean-3D view** — the pending brightness/palette fix.
2. **Residential close-up (`02`)** — Khrushchev block with readable window grid, floor
   bands, courtyard, trees, road markings; pixel dithering is visible but coherent at this
   zoom. This is a genuine "isometric pixel-art city" look.
3. **Landmark close-up (`03`)** — large civic building near October Square with roof
   volumes and surrounding dense blocks; facades and roofline read correctly.
4. **Night preset (`04`)** — 23:00 changes the global lighting (mean luminance 21.9, only
   451 colours) but the city is barely legible and has no lit windows/street lights yet.
   Known pending art work (Lead). HUD time label still reads 13:00 because the capture
   script calls the scene API directly (`setTimeOfDay(23)`), bypassing React state — script
   artefact, not a UI bug.
5. **Clean 3D (`05`)** — pixel effect off reveals the intended albedo/lighting: bright
   beige/white buildings, saturated green parks, blue river, mean luminance 114.8 and
   7 196 colours (2× the pixel-mode colour count). This is the best reference for judging
   geometry and palette; the pixel-art pipeline currently darkens it significantly (D13).
6. **Rotated (`06`)** — 90° azimuth view; complete district, water and parks visible;
   framing stays centred (D3 fixed). HUD numbers refreshed correctly.
7. **HUD perf panel is stale by default** — the screenshots were captured after pressing
   the built-in "Refresh stats" button; without that, the panel freezes at the first stats
   sample (see D12). All canonical PNGs therefore show correct 16-tile / 654-building HUD
   numbers, but this is a documented workaround, not proof the panel updates on its own.

### Performance (real GPU, measured at milestone)

| Run | Renderer | FPS | frameMs | drawCalls | triangles | tiles | buildings | render size | geometryMB |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| e2e test 3 | ANGLE/D3D11 RTX 3080 | **50.3** | 19.9 | 48 | 178 025 | 16 | 654 | 640×360 | 24.23 |
| capture final | ANGLE/D3D11 RTX 3080 | **60** (vsync cap) | 16.7 | 50 | 182 303 | 16 | 654 | 640×360 | 24.23 |
| e2e default (software) | ANGLE/SwiftShader | 1.9 | 516.7 | 48 | 178 025 | 16 | 654 | 640×360 | 24.23 |

The 60 FPS figure is the display cap; the geometry budget (~182 k triangles, ~50 draw
calls, 16 tiles, 24 MB GPU geometry) is comfortable for the RTX 3080 Laptop. The
SwiftShader figure is software rasterisation — not representative; it is only why the
default e2e suite is slow on machines without GPU access. `geometryMB` is now plausible
(24.23 MB; the old stub reported 0.046 MB — D10 fixed).

---

## 6. Defect status at the milestone

| ID | Priority | Status | Notes / evidence |
| --- | --- | --- | --- |
| D1 | P0 | ✅ **FIXED** | Environment (ground, roads, river, parks, trees) renders. Near-black share 0.0 % vs 38–59 % before; river/parks/road markings clearly visible in `01` / `05`. Environment geometry (117 856 tris) confirmed by the geometry audit. |
| D2 | P0 | ✅ **FIXED** | Facade shader compiles; buildings are lit with windows/roofs (see `02`/`03`); clean console; e2e 12/12. |
| D3 | P1 | ✅ **FIXED** | Camera now frames the pilot correctly: overview centred (`01`), rotated view centred (`06`). Default orthoHeight auto-fits to ≈660–692 m. |
| D4 | P1 | 🟡 **KNOWN / TRANSIENT** | 23:00 night preset is functionally applied but far too dark to read (mean lum 21.9, 451 colours), no lit windows. Lead confirmed brightness/palette art fixes are still coming. Evidence: `04-night.png`. |
| D5 | P1 | ✅ **RESOLVED (accepted)** | Roof/facade stipple at close range is deliberate pixel-art dithering, not z-fighting/aliasing — checked in `02`/`03` and in the clean-3D render (`05`). Art sign-off still welcome, but no longer a defect. |
| D6 | P2 | ✅ FIXED (data 14:37) | `manifest.bounds` = tile extent ±1024 m, new `manifest.pilotBounds` = ±800 m, `types.ts` updated; data test asserts both. |
| D7 | P2 | ✅ FIXED (data 14:37) | Multipolygon parts merged: all 654 ids match plain `^[wr]\d+$`, 0 split ids. |
| D8 | P2 | ✅ FIXED (data 14:37) | Absent `levels` omitted (no `null`). |
| D9 | P2 | ✅ FIXED | `LoadingOverlay` stays visible while an error is set; confirmed in source. (Browser re-check requires a forced data failure; not re-performed at milestone.) |
| D10 | P3 | ✅ FIXED | `geometryMB` now 24.23 MB for 182 k triangles (was 0.046). |
| D11 | P3 | 🟢 MITIGATED | Dev-server HMR can still destroy a page mid-test while agents edit files (one such failure in the software run). `openApp()` reloads once for a never-booted document; mid-test reloads still fail honestly. Run e2e when `src/` is quiet. |
| **D12** | **P2** | 🔴 **OPEN (reported to Lead)** | **HUD performance panel does not auto-update.** The renderer reuses/mutates one `EngineStats` object and passes the same reference to `onStats` every tick; React's `setStats(next)` bails on identical reference, so the panel freezes at the first sample. Probe evidence: HUD showed `11 tiles / 569 buildings / 142 688 triangles` while `window.__CITY_STATS__` reported `16 / 654 / 182 303`; clicking `[data-testid="refresh-stats"]` immediately corrected the HUD. Suggested one-line fix (renderer or shell): pass a copy — `options.onStats?.({ ...stats })` in `src/engine/createCityApp.ts`, or `setStats({ ...next })` in `src/app/App.tsx`. Not fixable by QA (`src/**` out of scope). |
| **D13** | **P2** | 🟡 **KNOWN / TRANSIENT** | Pixel-art mode is much darker and more desaturated than the clean-3D render: mean luminance 74.6 vs 114.8 and 3 591 vs 7 196 colours on the same view (`01` vs `05`). Lead confirmed a global brightness + palette pass is still coming; treat as known/transient, not a hidden bug. |
| D14 | P3 | ℹ️ Note (not a defect) | In `04-night.png` the HUD time label reads 13:00 while the scene is at 23:00 because the capture script calls the scene API directly instead of the slider. A real user moving the slider sees the label follow (e2e test 8 asserts `23:00`). |

---

## 7. Verified vs. not verified (honesty section)

**Verified:**
- 221/221 unit tests, 44/44 QA tests, clean `tsc --noEmit`;
- clean 12/12 e2e run on real GPU with all interactions asserted by image diffs/state;
- canonical screenshots exist for the current build, full 16 tiles, 0 console/page errors;
- 0 % near-black on day shots; environment, framing, water/parks/roads confirmed visually;
- performance numbers on this machine's real GPU (50–60 FPS, 178–182 k triangles, 48–50 draw calls).

**Not verified / still open:**
- **Final palette/brightness** (D13) and **night readability** (D4): art fixes pending per Lead; screenshots will be re-captured afterwards.
- **Default SwiftShader e2e re-run**: the 60 s screenshot-timeout fix is verified only in the GPU run; the full software-mode suite has not been re-run after the fix (it is ~10 min at 1.9 FPS). The software run's two failures were both explained and one was fixed.
- **Integrated-GPU / older-hardware FPS**: only the RTX 3080 Laptop was measured.
- **D9 error-overlay browser verification** with a forced data failure was not re-performed; source inspection confirms the fix.

---

## 8. Next steps (owner: QA)

1. When the brightness/palette art pass lands: re-run `$env:QA_GPU='1'; pnpm run qa:capture`
   + `node scripts/qa/analyze-screenshots.mjs`, review the new PNGs, update §5 and D4/D13.
2. Re-run the full e2e once more (GPU) after the art pass and once in default SwiftShader
   mode to confirm the 60 s screenshot timeout fixed the software-mode failure.
3. When D12 is fixed (either side), re-capture screenshots **without** the "Refresh stats"
   workaround and resume judging HUD numbers from the PNGs.
4. Keep suites green: `pnpm test` (221 tests) and `pnpm exec tsc --noEmit`.
5. Keep `screenshots/analysis.json` and `screenshots/stats.json` alongside the final PNGs as
   the evidence trail for this report.
