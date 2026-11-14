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
| Before images at 420 m / 90 m for every case | blocked | needs the QA capture tooling added in Task 5/6; no before image may be claimed before it exists |
| No hidden dataset selector can route to the pilot | blocked | application resolver still offers `?dataset=city` (Task 9); tracked, not yet fixed |

L0 is therefore **not** signed off yet: the inventory half passes, the visual
before-state is blocked on capture tooling. No style code is allowed to claim a
quality improvement before that gate closes.

## L1 — building-family gallery

| Item | Result | Evidence |
| --- | --- | --- |
| 27-recipe gallery, day/night, two azimuths | pending | Task 5 |

## L2 — neighbourhood architectural quality

| Item | Result | Evidence |
| --- | --- | --- |
| Real-city before/after pairs, style coverage audit | pending | Task 6 |

## L3 — complete city, LOD and journey

| Item | Result | Evidence |
| --- | --- | --- |
| Full/far coverage, transitions, journeys | pending | Task 7 |

## L4 — public artifact and release

| Item | Result | Evidence |
| --- | --- | --- |
| GitHub Pages project-path release | blocked | owner must choose repository owner/name and the source-code licence, and confirm third-party redistribution rights; no identity or licence is invented here |

## Open blockers carried in this branch

1. **Owner inputs for publication (L4):** repository owner/name, source-code
   licence choice, and verified third-party museum asset redistribution rights.
2. **Hardware performance evidence (L3/L8 gate):** FPS claims require a hardware
   GPU run (`QA_GPU=1`); SwiftShader runs only prove correctness.
3. **Uncommitted B-2 state in the root checkout:** imported into this branch as
   commit `chore: import B-2 city area and data-pipeline baseline…`; the root
   checkout keeps its own working-tree changes untouched.
