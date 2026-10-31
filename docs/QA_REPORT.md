# QA Report — Isometric Minsk

> **Revision addendum — 2026-10-28 (post-landmark round).** The report body below
> documents the 2026-10-27 16:30 QA round. Since then the data pipeline gained
> curated landmark fixes (Minsk Gate, National Library, Victory obelisk, Red
> Church, TV tower), two ferris wheels, multipolygon/relation repairs and a
> tile-cache fix; the pilot tiles were regenerated and new unit suites were
> added. Re-verified on this revision: `pnpm test` → **321/321 passed** (20 files); `pnpm test:e2e` →
> **12/12 passed** (software SwiftShader, 5.4 min); `tsc --noEmit` clean;
> `vite build` ✓; `data:validate` pilot + city → **VALIDATION PASSED**; geometry
> audit PASSED; full-city capture (hardware GPU) → 144/144 tiles, **4 010 150
> triangles / 424 draws / 60 FPS**, 0 console errors; tile-cache revalidation
> check PASS. City belt holds **31 783 buildings**; the five curated landmarks
> render (`docs/screenshots/11`–`18`, `25`–`26`), both ferris wheels render
> (`22`–`24`), and
> the relation fixes restored the Svislach river through Yanka Kupala park (`21`)
> plus the surveyed islands (`19`). A misplaced eternal flame at the Victory obelisk was fixed (it now sits on its own 9 × 9 m platform at the real OSM position, `docs/screenshots/27-victory-flame.png`). A stale-cache bug was also fixed: tile
> payloads used to be fetched with `cache: 'force-cache'`, so after a dataset
> regeneration the map kept the old geometry even on refresh (manifest updated,
> tiles did not); tiles are now revalidated (`no-cache`, guarded by
> `scripts/qa/cache-check.mjs`). Everything else in this report remains the
> historical 2026-10-27 record.
>
> **Revision addendum — 2026-11-01 (road network normalization, payload 0.2.0).**
> The road layer was rewritten: one non-overlapping surface partition (drivable
> material zones `asphalt/stone/concrete/unpaved`, paving, kerbs, medians) plus a
> semantic centreline network with junction boxes and pedestrian crossings.
> Overlapping class-tinted per-way buffers are gone (measured before the rewrite:
> 1 166 overlapping drivable pairs, 73 994 m² of stacked surface, 1.14 overdraw;
> both one-way carriageways of a dual carriageway were 18 m wide because the
> width model used the class default as a floor). After the rewrite
> (`pnpm run qa:road-audit`): same-layer overlap **0.0 m²**, drivable×paving
> overlap **0.0 m²**, worst tile-seam gap **0.0 m**, street width spread
> **0.0 m**, 16 031/16 031 centreline samples inside the drivable surface.
> Payload 0.2.0: 1 324 surface pieces, 1 075 network pieces, 520 junction
> records (tile-duplicated), 183 crossings (81 zebra / 89 signal heads /
> 13 unmarked), 13 medians; **2 166 247 B (+1.4 %)** versus 0.1.0. Materials:
> 186 asphalt + 111 stone + 2 concrete drivable zones, 36 405 m² of stone
> (Karl Marx Street sett/cobblestone section verified against OSM).
> Verification: `pnpm test` **348/348** (22 files), Python road tests **24/24**,
> `tsc --noEmit` clean, `data:validate` **PASSED**, geometry audit **PASSED**
> (envTriangles 164 832, +5.7 %, 0 invalid), e2e **12/12 passed** (hardware GPU,
> 52.8 s), canonical capture 6/6 (**60 FPS, 49 draw calls, 0 console/page
> errors**), road focus sweep **13/13 shots** with 0 console/page errors
> (`screenshots/roads/`). Known limits: bridge decks remain raised slabs
> without ramps (structural side skirts only; bridge sidewalks are flat slabs
> on the deck), and lane paint stops at junction boxes and crossings — see
> `docs/ROAD_NETWORK.md`.

**Report time:** 2026-10-27 ~16:30 local (Europe/Warsaw) — **final verification round, data revision 16:13**
**Author:** QA & Integration agent (qa-dev)
**Repo state:** no git commits (all files untracked, working-tree only). Five agents work in one directory; QA does not edit `src/**` — defects are reported to their owners, never fixed by QA.

---

## 1. Executive summary — all green

| Check | Command | Latest result |
| --- | --- | --- |
| Unit + data tests (whole repo) | `pnpm test` | **237/237 passed** (15 files, 21.6 s) |
| QA-owned unit + data tests | `pnpm exec vitest run tests/unit/data tests/unit/tile_math.test.ts tests/unit/config_sync.test.ts` | **44/44 passed** |
| Typecheck | `pnpm exec tsc --noEmit` | **clean, exit 0** |
| E2E (real GPU) | `$env:QA_GPU='1'; pnpm exec playwright test` | **12/12 passed (1.2 min)** |
| E2E (default software SwiftShader) | `pnpm exec playwright test` | 10/12 in the earlier milestone run — one HMR-race failure + one screenshot-timeout failure (fixed and re-verified); see §4.2 |
| Screenshots + stats | `$env:QA_GPU='1'; pnpm run qa:capture` | exit 0, 6/6 shots, **16/16 tiles**, 58–60 FPS, 0 console/page errors |
| Screenshot metrics | `node scripts/qa/analyze-screenshots.mjs` | 6/6 canonical PNGs, **0.0 % near-black**, `screenshots/analysis.json` |
| Geometry audit (Lead's tool) | `pnpm exec tsx scripts/qa/geometryAudit.ts` | **GEOMETRY AUDIT PASSED**, 0 issues |

**Application status:** the build is complete and healthy. The district is fully visible in
the intended warm pixel-art palette — 654 buildings with window facades, pitched/flat roofs,
the Palace of the Republic (new `palace` archetype), roads with markings, the Svislach river,
parks/trees — with **58–60 FPS / 49 draw calls / 199 630 triangles** on a real GPU, no console
or page errors, working picking, time-of-day, pixel-art toggle and reload. All previously
reported P0/P1 defects are fixed, including the HUD stats freeze (D12) and the dark palette
(D13). The 23:00 night preset is readable but still lacks lit windows/street lights (D4, minor
art polish).

> **Data revision note (16:13):** the pipeline added the `palace`/`stadium` archetypes
> (`src/shared/types.ts`, `ARCHETYPE_ID` 9/10) and refreshed tree/surface coverage — tile data
> now contains `w25327560` “Палац Рэспублікі” (`palace`, 45 m); counts changed to
> 654 buildings / 671 surfaces / 3 790 roads / **6 235 trees** (was 3 775). QA’s data test’s
> allowed-archetype set was updated (`palace`, `stadium`) and the full round re-run against
> this revision: everything in §4–§5 below is from the 16:13 data. Note:
> `docs/COVERAGE_REPORT.md` was not regenerated for this revision and still shows the previous
> tree/surface totals — QA validates the manifest + tile payloads directly (flagged to the
> data owner).

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
| `tests/unit/data/tiles.test.ts` | 11 real-data validation tests (allowed archetypes now include `palace`, `stadium`) | 11/11 |
| `docs/QA_REPORT.md` | this report | final |
| `docs/LIMITATIONS.md` | data / renderer / test limitations | updated |
| `docs/TESTING.md` | how to run everything on Windows PowerShell | updated |

---

## 4. Test results — final runs (data revision 16:13)

### 4.1 Unit + data suites — 237/237 PASS

```
$ pnpm test
 Test Files  15 passed (15)
      Tests  237 passed (237)
   Duration  21.63s
```

`pnpm exec tsc --noEmit` → exit code **0** (clean).

QA-owned subset: **44/44** (13 config-sync + 20 tile-math + 11 data). Data facts verified
against the real tiles:

- 16 tiles, tileRange −2..1, tileSize 512 m, EPSG 32635, origin UTM `[536859.254, 5972786.284]`, centre `53.9022, 27.561`;
- `manifest.bounds` = tile-grid extent `[-1024, -1024, 1024, 1024]`; `manifest.pilotBounds` = `[-800, -800, 800, 800]` inside bounds;
- counts agree with payload sums: **654 buildings** (69 explicit OSM height, 366 derived from `building:levels`, 219 heuristic; 305 explicit roof shapes), 671 surfaces, 3 790 roads, **6 235 trees**;
- archetype values all belong to the shared union, including the new `palace` (1 building — the Palace of the Republic, `w25327560`, 45 m) and `stadium` (supported, 0 present in the pilot area);
- all building ids match plain `^[wr]\d+$` (multipolygon parts merged into volumes — 0 split ids), unique across ALL tiles;
- absent optional `levels` omitted (no JSON `null`); present levels are integers 1..100;
- heights 2.5–115.5 m within the 2..400 m contract; footprints are valid rings with ≥ 3 finite points, non-zero area, no NaN;
- roads/surfaces/trees valid (incl. 6 235 tree instances); `crossingBuildingIds` correct; every tile near the pilot centre has roads or surfaces.

Geometry audit (Lead's tool, re-run on this revision): `GEOMETRY AUDIT PASSED` — 654
buildings, **66 326 building triangles + 133 302 environment triangles** (45 630 roof /
81 216 wall), y range 0.0–115.9 m, no NaN, all attributes present, triangle-owner maps
consistent, no building without triangles, 101.4 triangles/building.

### 4.2 E2E suite — 12/12 PASS (final, real GPU, 1.2 min)

Final run: `$env:QA_GPU='1'; pnpm exec playwright test` → **12 passed (1.2m)**.

| # | Test | Duration | Observed values (final run) |
| --- | --- | --- | --- |
| 1 | app shell, non-zero canvas, no console/page errors | 7.1 s | loading overlay hidden, 0 errors |
| 2 | `window.__CITY_APP__ = { ready, app, stats }` within 60 s | 1.7 s | 19/19 `CityAppHandle` methods, EngineStats exposed |
| 3 | real Minsk geometry (triangles > 1000, buildings > 100) | 1.7 s | **fps 59.5, frameMs 16.8, drawCalls 19, triangles 82 862, buildings 359, 6 tiles, render 640×360, geometryMB 12.02** (mid-stream snapshot; full city after streaming: 199 630 tri / 654 buildings / 16 tiles — see capture) |
| 4 | canvas is a real image | 3.1 s | 7 002 unique colours, luminance σ=64.2, mean=109.3 |
| 5 | mouse-drag pan changes the rendered image | 4.3 s | **image diff 0.640** |
| 6 | wheel zoom changes `orthoHeight` | 1.9 s | 659.7 → 554.5 |
| 7 | rotation changes `azimuth` | 1.9 s | 0.785 → 2.356 rad |
| 8 | time-of-day slider changes the rendered image | 4.1 s | `getTimeOfDay()=23`, label 23:00, **diff 0.934** |
| 9 | pixel-effect toggle changes the rendered image | 4.1 s | enabled→disabled→enabled, **diff 0.181** |
| 10 | clicking a building opens the info panel | 3.5 s | selected `w25432666` (khrushchev), OSM id validated, panel closes |
| 11 | no uncaught errors during 5 s of interaction | 15.7 s | 0 page errors, 0 console errors |
| 12 | page reload re-renders the city | 13.7 s | ready again, non-flat canvas, 0 errors |

Earlier runs (kept for honesty):
- The previous data revision's GPU runs: 12/12 (1.0–1.8 min), 178 025–182 303 triangles.
- **Default SwiftShader run:** 10/12 in 10.2 min. Failures: (a) test 5 — mid-test Vite HMR
  reload destroyed the page execution context while agents were saving files (harness race,
  not an app bug; passed in GPU runs); (b) test 9 — 15 s Playwright screenshot timeout at
  1.9 FPS. **Fixed:** canvas screenshots allow 60 s; the test was re-run in software mode:
  **PASS (47.5 s)**. A full software-mode 12/12 run was not repeated end-to-end (~10 min);
  the GPU run is the clean suite.

### 4.3 Typecheck

`pnpm exec tsc --noEmit` → **exit 0, no errors** across `src`, `tests`, `scripts` and both Vite configs.

---

## 5. Screenshots and visual QA — final baseline (data revision 16:13)

Captured with `$env:QA_GPU='1'; pnpm run qa:capture` (exit 0, 6/6 shots, **16/16 tiles
loaded before the first shot**, 0 console errors, 0 page errors). Files in `screenshots/`;
engine stats in `screenshots/stats.json`; console in `screenshots/console.log`; metrics in
`screenshots/analysis.json`. HUD numbers in the screenshots are the app's own auto-updated
values (D12 fixed; no refresh workaround).

Canonical metrics (`node scripts/qa/analyze-screenshots.mjs`):

| Screenshot | Bytes | Unique colours | Mean luminance | Near-black (<8/255) | Content bbox |
| --- | --- | --- | --- | --- | --- |
| `01-overview.png` | 471 KB | 6 658 | 109.3 | **0.0 %** | 1596×900 |
| `02-closeup-residential.png` | 428 KB | 4 437 | 83.0 | **0.0 %** | 1596×900 |
| `03-closeup-landmark.png` | 534 KB | 6 789 | 86.3 | **0.0 %** | 1596×900 |
| `04-night.png` | 453 KB | 3 725 | 40.2 | 0.01 % | 1596×900 |
| `05-clean-3d.png` | 577 KB | 6 689 | **113.1** | 0.0 % | 1596×900 |
| `06-rotated.png` | 447 KB | 6 573 | 114.5 | 0.0 % | 1596×900 |

(The `screenshots/` folder also contains PNGs written by other agents — `dev-baseline.png`,
`measure.png`, `02-closeup.png`, `03-detail.png`, `07-golden.png`, `probe-*.png`,
`check-now.png`, etc. They are not produced by `capture.mjs`; the canonical set is exactly
the six files above.)

Pixel-art / visual assessment (read from the final PNGs):

1. **Overview (`01`)** — complete, centred district in the intended pixel-art style: warm
   orange/red roofs, light grey-white walls, dark grey roads with dashed markings, deep-blue
   Svislach river, green parks/tree masses; readable HUD + attribution; 58–60 FPS,
   199 630 triangles, 16 tiles, 654 buildings at 640×360 internal resolution. Looks like a
   deliberate isometric pixel-art city.
2. **Residential close-up (`02`)** — crisp Khrushchev blocks with window grids, floor bands,
   pitched roofs, courtyard greens, tree-lined streets and road markings; coherent dithering.
3. **Landmark close-up (`03`)** — the capture's focus target is now the **Palace of the
   Republic** (`w25327560`, `palace`, 45 m) — the new archetype renders correctly with its
   colonnade-style facade; dense surrounding blocks and parks read well.
4. **Night preset (`04`)** — 23:00 blue-tinted night scene, mean luminance 40.2 / 3 725 colours
   (was 21.9 / 451 in the first milestone) — buildings, river, parks and roads are discernible.
   Still **no lit windows or street lights** (D4, minor art polish).
5. **Clean 3D (`05`)** — pixel effect off at full 1600×900: bright albedo/geometry reference
   (mean 113.1, 6 689 colours). Its brightness closely matches the pixel-art view (109.3) —
   D13 fixed; the pixel pipeline no longer crushes the palette.
6. **Rotated (`06`)** — 90° azimuth: complete district, river and parks, framing stays centred
   (D3 fixed); HUD current and correct.
7. HUD performance numbers in all six PNGs are live/auto-updated (58–60 FPS, 16 tiles,
   654 buildings, 199 630 triangles in the full-view shots) — D12 fixed and visually verified.

### Performance (real GPU, final build/data revision)

| Run | Renderer | FPS | frameMs | drawCalls | triangles | tiles | buildings | render size | geometryMB |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| final e2e (test 3, mid-stream) | ANGLE/D3D11 RTX 3080 | **59.5** | 16.8 | 19 | 82 862 | 6 | 359 | 640×360 | 12.02 |
| final capture (after 16/16 tiles) | ANGLE/D3D11 RTX 3080 | **58–60** | 17.2 | 49 | 199 630 | 16 | 654 | 640×360 | 26.12 |
| previous data revision (capture) | ANGLE/D3D11 RTX 3080 | 60 (cap) | 16.7 | 50 | 182 303 | 16 | 654 | 640×360 | 24.23 |
| default software (previous revision) | ANGLE/SwiftShader | 1.9 | 516.7 | 48 | 178 025 | 16 | 654 | 640×360 | 24.23 |

The 58–60 FPS figures are at/under the display cap; ~200 k triangles / ~49 draw calls / 26 MB
GPU geometry is comfortable for the RTX 3080 Laptop. SwiftShader is software rasterisation —
it is only why the default e2e path is slow, never a performance claim.

---

## 6. Defect status — final

| ID | Priority | Status | Notes / evidence |
| --- | --- | --- | --- |
| D1 | P0 | ✅ **FIXED** | Environment renders: ground, roads/markings, river, parks/trees; near-black share 0.0 % (was 38–59 %). `01`, `05`. |
| D2 | P0 | ✅ **FIXED** | Facade shader compiles; buildings lit with windows/roofs; 0 console errors; e2e 12/12. |
| D3 | P1 | ✅ **FIXED** | Camera frames the pilot correctly: overview and rotated views centred (`01`, `06`); default orthoHeight ≈ 660 m. |
| D4 | P1 | 🟡 **IMPROVED / minor polish** | Night preset is a readable blue-tinted scene (mean lum 40.2, 3 725 colours; was 21.9 / 451) but still has no lit windows/street lights. Known art-polish item. |
| D5 | P1 | ✅ **RESOLVED (accepted)** | Close-range roof/facade stipple is deliberate pixel-art dithering, coherent in the final close-ups (`02`, `03`) and clean-3D render; not z-fighting. |
| D6 | P2 | ✅ FIXED (data 14:37) | `manifest.bounds` = tile extent ±1024 m; `manifest.pilotBounds` = ±800 m; `types.ts` updated; data test asserts both. |
| D7 | P2 | ✅ FIXED (data 14:37) | Multipolygon parts merged: all 654 ids plain `^[wr]\d+$`, 0 split ids. |
| D8 | P2 | ✅ FIXED (data 14:37) | Absent `levels` omitted, never `null`. |
| D9 | P2 | ✅ FIXED | `LoadingOverlay` stays visible while an error is set (source verified). |
| D10 | P3 | ✅ FIXED | `geometryMB` now 26.12 MB for ~200 k triangles (was 0.046 MB). |
| D11 | P3 | 🟢 MITIGATED | Dev-server HMR can still destroy a page mid-test while agents edit files. `openApp()` reloads once for a never-booted document; mid-test reloads fail honestly. Run e2e when `src/` is quiet. |
| D12 | P2 | ✅ **FIXED** | HUD performance panel froze because the renderer re-emitted one mutated `EngineStats` reference; the shell now stores a copy (`src/app/App.tsx`: `const snapshot = { ...next }; setStats(snapshot);`). Verified: HUD auto-shows live 16-tile / 654-building / 199 630-triangle values with no refresh click; the capture-time refresh workaround was removed. |
| D13 | P2 | ✅ **FIXED** | Pixel-art mode no longer darkens/desaturates: mean luminance 109.3 vs 113.1 clean-3D (was 74.6 vs 114.8), 6 658 vs 6 689 colours. |
| D14 | P3 | ℹ️ Note (not a defect) | In `04-night.png` the HUD label reads 13:00 because the capture script calls the scene API directly (`setTimeOfDay(23)`), bypassing the React slider state. A real user moving the slider sees the label follow (e2e test 8 asserts label `23:00`). |
| D15 | P3 | ✅ Resolved in QA scope | New data revision introduced `palace`/`stadium` archetypes; QA's data-validation allowed-archetype set was stale and failed. Updated + full suite re-run: **237/237 pass**. `w25327560` Palace of the Republic renders correctly (capture landmark target). |

No open functional defects remain. D4 is art polish (lit windows at night); D11/D14 are harness
notes; D15 was a QA test-data sync issue (fixed).

---

## 7. Verified vs. not verified (honesty section)

**Verified:**
- 237/237 unit tests (incl. new `palace`/`stadium` archetype data), 44/44 QA tests, clean `tsc --noEmit`;
- **12/12 e2e passed** on the current data revision (real GPU, 1.2 min) with all interactions asserted by image diffs/app state;
- canonical 6/6 screenshots, full 16/16 tiles, 0 console/page errors, live HUD numbers;
- 0.0 % near-black on all six canonical shots; environment, framing, river/parks/roads/Palace confirmed visually;
- palette (D13) and night (D4) improvements measured from PNGs;
- performance measured on this machine's real GPU (58–60 FPS, 199 630 triangles, 49 draw calls, 26.12 MB).

**Not verified / caveats:**
- **Default SwiftShader 12/12 run**: only 10/12 was observed at the earlier milestone; both
  causes were an HMR race and a screenshot timeout, the latter fixed and re-verified in
  isolation. The full software suite was not re-run end-to-end (~10 min at 1.9 FPS) — the
  clean suite is the GPU run.
- **Integrated-GPU / older-hardware performance** not measured.
- **D4 lit-window night look** is future art polish, not implemented yet.
- D9 error-overlay with a *forced* data failure was not re-triggered in the browser; fix verified by source inspection.

---

## 8. Next steps (owner: QA)

1. Keep `pnpm test` (237) and `pnpm exec tsc --noEmit` green; run `$env:QA_GPU='1'; pnpm exec playwright test` for fast clean e2e verification.
2. If further data/art revisions land (e.g. lit windows for D4), re-run
   `$env:QA_GPU='1'; pnpm run qa:capture` + `node scripts/qa/analyze-screenshots.mjs`, re-read
   the PNGs and update §5/D4.
3. Optionally add a CI job: unit+typecheck always; e2e in SwiftShader mode (slow) or on a hardware runner with `QA_GPU=1`.
4. Optionally add golden-image regression for the six canonical screenshots once art is frozen (currently manual review + numeric metrics only).
