# Building-quality review log (L0–L4)

Evidence root: `docs/building-quality/`. Screenshots live in the git-ignored
`screenshots/building-quality/<revision>/`; only compact manifests, measurements,
provenance and review records belong in this directory.

**Status vocabulary.** A row is `pass` only with named evidence. Otherwise it is
`fail` with the offending geometry/appearance and a named owner, or `blocked`
with the concrete blocking condition. `not reviewed` is never approval.

## Baseline (frozen before any style code)

| Item | Value |
| --- | --- |
| Start commit | see `BASELINE.json.startCommit` (branch `procedural-building-variety`) |
| Accepted dataset | `public/data/city-tiles`, payload `0.4.3` |
| Manifest sha256 | `19a97f50949d100fc9f79218ea3e7b8ed38205e08fe2081957721042046495da` |
| Tiles | 437 (inclusive range x −11…11, y −9…9, 1024 m tiles) |
| Buildings | 76,004 |
| Trees | 1,910,624 |
| Tile bytes | 295.27 MB |
| Bounds (local m) | −11264, −9216, 12288, 10240 |
| Baseline suites | typecheck pass; vitest 443 passed / 5 skipped; python data tests 157 passed |

The dataset above is the B-2 437-address complete city already promoted to
`public/data/city-tiles`. `scripts/qa/b2_staging_audit.py` re-derives the address
book from the reviewed raw-input bounds in `scripts/geo_config.py` instead of
trusting the historical 399/400-address reports; it passes 35/35 checks
(`docs/B2/STAGING_AUDIT.json`, schema 2, with `addressReconciliation`).

## L0 — baseline and inventory

| Check | Result | Evidence |
| --- | --- | --- |
| Full-city inventory and address book | pass | `BASELINE.json`, `docs/B2/STAGING_AUDIT.json` (35 checks, 0 failed) |
| Review cases frozen before styling | pass | `review-cases.json` (31 cases: 11 archetypes, 3 panel neighbourhoods, 3 pre-war areas, 5 landmarks, modern tower district, industrial area, small edge, 4 corners, river/bridge, Lipki) |
| Before images at 420 m / 90 m for every case | partial | `building-review-capture.mjs` captures the frozen camera matrix against the accepted dataset; the full 31-case before/after matrix has not finished in this session (see the L2 row) |
| No hidden dataset selector can route to the pilot | pass | `src/shared/config.ts` resolves `city` for every search string; `tests/unit/config_sync.test.ts` (23 tests) and the e2e complete-city contract cover it |

L0 is **conditionally signed off**: inventory, address book and the frozen case
registry pass; the visual before-state is captured by the same script that
produces the L2 pairs and is still incomplete for all 31 cases.

## L1 — building-family gallery

| Item | Result | Evidence |
| --- | --- | --- |
| 27-recipe gallery, day/night, two azimuths | **fail — one named family** | `gallery-results.json`: 26/27 panels pass; every panel has ≥2 wall triangles and ≥1 roof triangle and day/night frames cover pixels. **Recipe 18 `sawtooth_factory` fails visual review:** the analytic sawtooth envelope left see-through gaps between the teeth (the near-vertical clerestory strip is not watertight in the facet mesher). The variant roof is disabled in `planRecipeRoof` until that is fixed, so the panel now renders the source flat roof plus the clerestory facade motif. Images: `screenshots/building-quality/<sha>/gallery/` |
| Deterministic second order (seeded) | pass | `grid-seeded-order-day.png` contact sheet; panel order derived from a fixed golden-ratio stride |
| Per-family visual sign-off | partial | agent review: mansard (17) reads as a gambrel envelope with a readable eave/cap; staircore (8) shows the continuous glazed spine; public_colonnade (25) shows pilasters, tall windows and a cornice; loggia (6) shows repeated glazed bays. Recipe 18 fails (above). Owner sign-off of all 27 families is still required |
| Renderer for L1 | note | captured on ANGLE SwiftShader (correctness only, no FPS claim) |

L1 is **not** signed off: one family (recipe 18, sawtooth) fails visual review
and its variant roof is disabled, and the owner must still review all 27 families
at day, night and the opposite azimuth.

## L2 — neighbourhood architectural quality

| Item | Result | Evidence |
| --- | --- | --- |
| Styled complete-city candidate generated | pass | `data/staging/city-buildings`: 437 tiles, 309.37 MB, 76,004 buildings, 1,910,624 trees, payload 0.5.0, manifest sha256 `c6f74953…` |
| Source/geometry/style contract audit | pass | `style-audit.json`: 16 checks, 0 building failures over 76,004 buildings; every source volume preserved within 0.05 m top / 0.005 m plan; 27 family recipes used; ≥3 recipes for all 9 generic archetypes |
| Style coverage | pass | recipe counts per id and per archetype in `style-audit.json.style`; legacy ids 27/35/36/37 only for protected routes |
| Before/after pairs for all 31 cases | partial | 12 representative categories captured with the frozen camera at close (90 m) day and night: candidate `neighborhood-results.json` 12/12 pass on the styled v0.5.0 dataset; baseline `neighborhood-results-baseline.json` 12/12 pass on the accepted v0.4.3 dataset (no `styleVariant`), same cameras and client. Measured example (`panel_neighborhood_1`): 537,959 > 566,191 triangles (+5.3%), 60 > 60 draw calls. The remaining 19 cases (full 155-frame matrix) and the paired image review are outstanding |
| Human visual sign-off | blocked | depends on the full capture set |

## L3 — complete city, LOD and journey

| Item | Result | Evidence |
| --- | --- | --- |
| Full/far coverage, transitions, journeys | blocked | the accepted B-2 streamer in this branch still renders one representation per tile; the atomic far/full state machine (`cityLodStreamer.ts`), far export and the journey probe are specified in Task 7 but not implemented in this session |

## L4 — public artifact and release

| Item | Result | Evidence |
| --- | --- | --- |
| Whitelisted static artifact | pass (local) | `site:build` + `site:audit`: 450 files, 307,436,371 bytes, `data/city-tiles` only, museum payload, `.nojekyll`, ODbL text and attribution present; legacy/alternate dataset paths 404 below `/VoxelMinsk/` |
| GitHub Actions → Pages workflow | pass (static review) | `.github/workflows/pages.yml` matches the plan (verify + deploy jobs, pinned action majors, 10-minute timeouts, `group: pages`) |
| Live URL, anonymous fresh profile, owner sign-off | blocked | owner must choose repository owner/name and the source-code licence, confirm museum asset redistribution rights, and run the workflow on `main` |

## Open blockers carried in this branch

1. **Owner inputs for publication (L4):** repository owner/name, source-code
   licence choice, and verified third-party museum asset redistribution rights.
2. **Dataset availability in CI:** `public/data/city-tiles/` is git-ignored, so a
   fresh GitHub Actions checkout has no 295 MB dataset and the artifact step
   fails closed. The owner must decide how CI obtains the accepted payload
   (commit it, LFS/release artifact, cache, or regenerate).
3. **Hardware performance evidence (L3/L8 gate):** FPS claims require a hardware
   GPU run (`QA_GPU=1`); SwiftShader runs only prove correctness.
4. **Full L2 capture matrix** (31 cases × 5 views) and the owner's visual
   sign-off are outstanding.
5. **L3 far/full representation** is specified but not implemented in this
   session; the accepted streamer still uses a single representation.
6. **Museum licence report:** `assets/aviation-museum/LICENSES.md` is stale
   (missing the shipped `citation-x` exhibit); regenerate it before release.
7. **Uncommitted B-2 state in the root checkout:** imported into this branch as
   commit `chore: import B-2 city area and data-pipeline baseline…`; the root
   checkout keeps its own working-tree changes untouched.

