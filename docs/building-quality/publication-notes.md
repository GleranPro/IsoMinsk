# Publication notes — Tasks 10–11 (scratch record)

Owner: agent-2. Branch: `procedural-building-variety` (worktree). These notes
record the provenance/rights findings, the publication contract, what was
verified and what still needs an owner decision. They are not a legal opinion.

## 1. Provenance inspection (not only comments)

Inspected: `scripts/qa/museum_licenses.py`, `assets/aviation-museum/MODELS.json`,
per-model `assets/aviation-museum/raw/<slug>/ATTRIBUTION.txt`,
`assets/aviation-museum/LICENSES.md`, `public/data/museum/manifest.json`,
`scripts/qa/export_museum_web.py`, `docs/DATA_SOURCES.md`, `README.md`,
`public/data/city-tiles/manifest.json`, `package.json`, `vite.config.ts`.

| Asset class | Where | Rights evidence in the repository | Decision |
| --- | --- | --- | --- |
| Authored code (TS/GLSL/Python/tests) | `src/`, `scripts/`, `tests/` | **No `LICENSE`/`COPYING` file exists.** GitHub hosting is not a licence grant. | `owner_required` (`asset-licenses.json#code`); the artifact is *source-available*, not open source. No licence invented. |
| OSM-derived tile database | `public/data/city-tiles/` (437 tiles + manifest, 295,267,617 tile bytes) | OSM ODbL 1.0 (BBBike Minsk extract, Geofabrik fallback), attribution in `public/data/city-tiles/manifest.json` and `docs/DATA_SOURCES.md` §5 | ODbL 1.0, `redistribution: true`, `modified: true`; notice shipped as `data/LICENSE-ODbL.txt`, `data/ATTRIBUTION.md` |
| Authored geometry / curation (landmark overrides, ferris wheels, de-overlap) | `src/city/**`, `scripts/normalize/**` | Derived from ODbL source; the database is published under ODbL | Covered by the ODbL database entry; source code licence still owner-required |
| Curated museum models (25 downloaded: 1 CC0 + 24 CC-BY) | `assets/aviation-museum/raw|decimated|baked/**`, payload in `public/data/museum/` | `MODELS.json` records label/licence/author/uid; each Sketchfab model has a tracked `raw/<slug>/ATTRIBUTION.txt`; CC0 An-2 from OpenGameArt | `redistribution: true` with author/licence/source/attribution, `modified: true` (decimated, baked). Upstream licence pages are **not archived** — owner re-verification required before commercial use. |
| Museum textures | `assets/aviation-museum/raw/an-2/*.png|psd` (CC0 source); other GLBs embed textures | Covered by the same per-model licence record | No texture image is shipped in the artifact; `data/museum/exhibits.bin` is vertex-coloured only. Raw textures exist only in the source repository under their model licences. |
| Fonts | none | No font files in `src/`, `public/`, `tests/`, `assets/`; UI uses the system font stack | Nothing to license or publish; documented in `ATTRIBUTION.md`. |
| Remote-linked sources | museum card links, OSM copyright, Sketchfab pages | Links only, no runtime asset fetch | Not redistributed; documented in `ATTRIBUTION.md`. |
| Bundled JS dependencies | `dist/assets/*.js` (React, React DOM + scheduler, three.js) | MIT `LICENSE` files in `node_modules/{react,react-dom,three}` | MIT, `redistribution: true`, full texts recorded in `asset-licenses.json#bundled-js-dependencies`. |

### `museum_licenses.py` finding

`.venv\Scripts\python.exe scripts/qa/museum_licenses.py` succeeds (`Wrote
assets\aviation-museum\LICENSES.md (214 lines)`). The committed `LICENSES.md`
is **stale**: it has 205 lines and omits the shipped Cessna Citation X exhibit
(`citation-x`, author SnowCrow). The generator output adds it. `LICENSES.md` is
outside this task's file ownership, so the file was restored byte-identically
after the audit; the publication audit therefore emits
`licenses-report-stale` as a **warning**. Regenerate and commit `LICENSES.md`
before release (owner/Lead).

Museum coverage is still enforced: every shipped exhibit slug must have a
`MODELS.json` downloaded record with licence/author/source, an
`asset-licenses.json` entry with `redistribution: true`, and its author named in
`data/ATTRIBUTION.md`; otherwise the audit fails.

## 2. Publication contract implemented

- `src/qa/publication.ts` — typed, Node-only contract shared by the two CLIs,
  the unit test and the e2e spec: whitelist planner, manifest builder
  (path-sorted files, sizes, SHA-256, commit SHA, city manifest hash),
  path/content policy, licence inventory validation, artifact audit and the
  `/VoxelMinsk/` static server.
- `scripts/qa/build-pages.mjs` — `--dist dist --site .pages --city-dir
  public/data/city-tiles`; copies built app files (excluding `dist/data`, which
  Vite copies from `public/`) and only these additions: `data/city-tiles`,
  `data/museum`, `.nojekyll`, `asset-licenses.json`, `data/ATTRIBUTION.md`,
  `data/LICENSE-ODbL.txt`. Writes `.pages/site-manifest.json`, then runs the
  audit. `--site` must resolve to exactly `.pages` inside the repository;
  it refuses to delete anything else.
- `scripts/qa/publication-audit.mjs` — `--site .pages [--static-only]`; content
  audit first, then (default) mounts the artifact below `/VoxelMinsk/` and
  checks index + first script, city manifest, first tile (coordinates/bytes),
  museum manifest + binary, attribution, ODbL text, licence inventory,
  site-manifest and that `data/tiles`, `data/city-tiles-current`,
  `data/city-tiles-b2` and host-root paths are **not** served. Results go to
  `publication-report.json` (committable, compact).
- Thresholds: warning at 500 MiB (`524,288,000` B), fatal error at
  `900,000,000` B. The accepted-city part of the artifact is 297,681,996 B
  (444 files: 437 tiles + manifest, 2 museum files, 4 notices/additions); the
  complete artifact from the existing `dist/` build is **307,436,371 B / 450
  files** (built app assets including source maps add ~9.75 MB), so no
  warning/fatal classification applies.
- Forbidden: `data/tiles`, `data/city-tiles-current`, `data/city-tiles-b2`,
  `data/raw|interim|processed|staging`, screenshots/worktrees/backups,
  raw/model/archive extensions, credential file names and secret-like content.

## 3. Owner decisions / blockers (not invented here)

1. **The complete-city payload is git-ignored** (`.gitignore` line:
   `public/data/city-tiles/`). A fresh GitHub Actions checkout therefore has no
   `public/data/city-tiles`, and `build-pages.mjs` fails closed. The owner must
   choose how CI obtains the accepted payload: commit the 295 MB tile output,
   store it via Git LFS/release artifact, cache it between jobs, or regenerate
   it in CI (the plan discourages six-minute OSM normalization per deploy).
   Until then the `verify` job cannot pass on a clean checkout.
2. **Source-code licence**: none present. Nothing was invented. The repository
   must not be described as open source until the owner selects a licence;
   `asset-licenses.json#code.status` is `owner_required` and the audit reports
   `pass_with_owner_required`.
3. **Repository owner/name, Pages URL and Pages source**: owner-provisioned
   (Task 11 Step 3). `ATTRIBUTION.md` deliberately names no repository/domain.
4. **Upstream museum model licence verification**: recorded at download time,
   upstream pages not archived. Owner should re-verify before commercial use;
   no extra redistribution permission is claimed.
5. **Stale `assets/aviation-museum/LICENSES.md`** (missing `citation-x`):
   regenerate with `museum_licenses.py` and commit.
6. **Real artifact run:** `dist/` appeared during this session (built by a
   concurrent agent), so the real 295 MB payload was assembled and audited:
   `build-pages.mjs` → 450 files / 307,436,371 B (5.2 s, audit pass, 2
   warnings); `publication-audit --static-only` → PASS; served-mode audit →
   PASS with 14 recorded requests (all expected 200s, legacy/root probes 404,
   16/16 checks pass, 0 failures); `playwright test
   tests/e2e/publication.spec.ts` → 3/3 passed (23.9 s), including the
   application-shell boot below `/VoxelMinsk/`. The generated `.pages/` stays
   git-ignored; `publication-report.json` is the committable compact result.
   The full run is only reproducible on a clean checkout once the tile-payload
   CI delivery question in blocker 1 is resolved.

## 4. `package.json` entries the Lead may want (do not add in this task)

```json
"qa:pages": "node scripts/qa/build-pages.mjs --dist dist --site .pages --city-dir public/data/city-tiles",
"qa:publication": "node scripts/qa/publication-audit.mjs --site .pages",
"qa:publication:static": "node scripts/qa/publication-audit.mjs --site .pages --static-only"
```

## 5. Verification evidence (worktree, 2026-11-14)

Command results are recorded verbatim in the task report (`tests[]`). Summary:

- `.venv\Scripts\python.exe scripts/qa/museum_licenses.py` → exit 0,
  `Wrote assets\aviation-museum\LICENSES.md (214 lines)`; file restored after.
- `pnpm exec vitest run tests/unit/publication.test.ts` → **21 passed**.
- `pnpm run typecheck` → exit 0.
- `pnpm exec playwright test tests/e2e/publication.spec.ts --list` → 3 tests,
  suite explicitly marks the skip reason when `.pages/` is absent; with the
  real artifact present the spec runs and **3/3 pass**.
- Real-data plan audit (library call): 444 files, 437 city tiles,
  297,681,996 bytes, `warning=false`, `fatalError=false`, 0 errors,
  2 warnings (`code-license-owner-required`, `licenses-report-stale`),
  legal `pass_with_owner_required`, 27 third-party inventory entries.
- Real artifact: `node scripts/qa/build-pages.mjs --dist dist --site .pages
  --city-dir public/data/city-tiles` → 450 files / 307,436,371 B, commit
  `8975900…`, city manifest SHA `8ae027c4…`, `audit: pass (0 errors, 2
  warnings)`. `node scripts/qa/publication-audit.mjs --site .pages
  --static-only` → PASS. Served mode → 14 requests, 16/16 checks pass,
  0 failures; `publication-report.json` (4.5 KB) written.
- Synthetic CLI smoke test (independent of the real data): `build-pages` →
  10 files / 67,743 B, audit PASS; served routes all 200 below `/VoxelMinsk/`,
  legacy and root paths 404; negative controls (deleted tile, stale
  site-manifest, `.env` in dist, wrong `--site`) all exit 1 with explicit
  errors.

## 6. Workflow notes (`.github/workflows/pages.yml`)

- `verify` (10 min): checkout, pnpm 10.32.1, Node 24, Python 3.11 + geospatial
  requirements, `pnpm install --frozen-lockfile`, typecheck, unit tests,
  `python -m unittest discover -s scripts/normalize/tests`, `pnpm run build`,
  `build-pages`, `publication-audit --static-only`, summary outputs
  (counts/hash only), `actions/upload-artifact@v4` (name
  `city-site-${{ github.sha }}`, 3-day retention, error if absent).
- `deploy` (10 min, `main` + not PR, `needs: verify`): checkout,
  `download-artifact`, `configure-pages@v5`, `upload-pages-artifact@v3`,
  `deploy-pages@v5`; permissions `contents: read`, `pages: write`,
  `id-token: write`; environment `github-pages`.
- Workflow-level `concurrency: {group: pages, cancel-in-progress: false}` and
  `permissions: contents: read`.
- Every action version is a mutable major tag today; the file states that each
  release must be confirmed upstream and a resolved commit SHA recorded before
  merge (the plan asks for this review).
- The plan's optional `node scripts/qa/building-gallery-capture.mjs --ci` step
  is **not** wired in: that script does not exist on this branch yet, so adding
  it would fail the release gate. Add it when Task 8 lands. Hardware-GPU
  captures remain an owner-machine artifact.
