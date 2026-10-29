# Isometric Minsk

Interactive isometric **pixel-art 3D map of central Minsk**, generated from real
OpenStreetMap geometry: real buildings with walls, roofs and procedural facades;
real avenues, squares, parks and the Svislach embankment; an orthographic
isometric camera you can pan, zoom and rotate; and a real pixel-art rendering
pipeline (low-resolution rasterisation → outline/quantise → nearest-neighbour
upscale).

Inspired by [bedirhanyildirim.com/warsaw-izo](https://bedirhanyildirim.com/warsaw-izo/).

**Status:** the October Square / Independence Avenue pilot (1.6 × 1.6 km, 512 m
tiles) plus a generated 12 × 12 km city-belt dataset (`?dataset=city`), fully
generated offline, streamed and rendered in the browser. The streets carry real
road detail derived from OSM centrelines: lane markings, zebra crossings with
stop lines and signal heads, medians, parking stalls, cycle lanes and bridge
parapets (`docs/ROADS_DETAIL.md`). See
`docs/REQUIREMENTS_ORIGINAL.md` for the original brief, `docs/REQUIREMENTS.md`
for the compliance matrix, `docs/PROGRESS.md` for milestone/roadmap status and
`docs/LIMITATIONS.md` for what is inferred vs. surveyed.

---

## Quick start (Windows 11 / PowerShell)

Requirements: **Node.js 24+**, **pnpm 10+**, **Python 3.11+** (only needed to
regenerate the data; the generated tiles are committed).

```powershell
cd D:\Workk\VoxelMinsk

# 1. Install JavaScript dependencies
pnpm install

# 2. Start the app (data is already generated in public/data)
pnpm dev
#    → open http://127.0.0.1:5173
```

The app needs no backend: it is a static Vite site plus JSON tiles.

## Two datasets: the pilot district and the whole city belt

The repository ships a **1.6 × 1.6 km central district** (16 × 512 m tiles,
~2 MiB) so the app runs immediately after `pnpm install`.

A **12 × 12 km city dataset** (144 × 1024 m tiles, ~60 MB, 31 783 buildings
including panel/historic/industrial/stadium/palace archetypes across all inner
districts, plus five curated landmarks: Minsk Gate clock/emblem towers, National
Library diamond, Victory Square obelisk, the Red Church and the TV tower) can be
generated locally from the same OSM extract — it is git-ignored because of its
size:

```powershell
pnpm run data:city        # extract + normalise + validate, ~6 min, no new downloads
```

Then open **http://127.0.0.1:5173/?dataset=city** — the engine fits the camera
to the city bounds, streams tiles nearest-first and keeps a bounded resident set.

## Regenerating the pilot data (optional)

The offline pipeline downloads the OSM extract for Minsk, extracts the pilot
area, normalises/projects/infers heights and writes the tile payloads.

```powershell
# once: python environment with the geospatial stack
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r scripts/requirements.txt

# download the BBBike Minsk OSM extract (~35 MB, cached; -Full for Geofabrik Belarus)
pnpm run data:download

# extract → normalise → validate (≈1 min total)
pnpm run data:all
```

Outputs:

| Path | Content |
| --- | --- |
| `data/raw/Minsk.osm.pbf` | raw BBBike Minsk extract (git-ignored) |
| `data/interim/minsk_raw.geojson` | pilot-area features in WGS84 (git-ignored) |
| `public/data/tiles/manifest.json` | tile index, counts, attribution |
| `public/data/tiles/<x>_<y>.json` | per-tile renderer payload (512 m tiles) |
| `data/processed/coverage.json` | coverage + provenance statistics |
| `docs/COVERAGE_REPORT.md` | generated coverage/validity report |

The pilot area and tile size are configured in `scripts/geo_config.py`
(mirrored in `src/shared/config.ts`). The whole pipeline (`data:all`) takes about
two minutes from scratch and is deterministic: the same PBF produces byte-identical
tiles.

## Tests

```powershell
pnpm run typecheck      # TypeScript, strict
pnpm test               # Vitest: 356 tests — geometry, roofs, facades, environment,
                        #   tile maths, config sync, curated landmarks, road detail,
                        #   real-tile data
pnpm run test:e2e       # Playwright: 12 browser tests (real WebGL)
$env:QA_GPU='1'; pnpm run test:e2e   # same, but on the hardware GPU (faster, realistic FPS)
pnpm run qa:capture     # 6 canonical screenshots + stats.json + console.log
node scripts/qa/road-detail-shots.mjs  # 16 close-ups of markings/zebras/parking/bridges
node scripts/qa/geometryAudit.ts    # headless geometry audit of all tiles (needs tsx)
```

Measured on the reference machine (RTX 3080 Laptop, 16 GB VRAM, Chromium
ANGLE/D3D11, 1600×900): **60 FPS, 49 draw calls, ~199k visible triangles
(368 871 in the resident set), 640×360 internal pixel-art resolution, 26 MB GPU
geometry, 0 console errors**. The 12 km city belt renders 4.03 M triangles in
424 draw calls at full residency on the same machine.
Screenshots are written to `screenshots/` (git-ignored) and a copy of the
QA set plus the City Gate landmark shots is kept under `docs/screenshots/`
(also git-ignored, local evidence for the docs).

## Controls

| Input | Action |
| --- | --- |
| Left-drag / WASD / arrows | Pan |
| Mouse wheel | Zoom (cursor-anchored) |
| `Q` / `E` or right-drag | Rotate camera |
| Left click | Select building (info panel with OSM metadata) |
| Reset isometric view button | Restore the default isometric view |

UI also exposes: pixel-art toggle (debug comparison with the clean 3D render),
facade-detail toggle (debugging), debug wireframe, time-of-day slider (night
windows light up), live performance stats, and a visible **© OpenStreetMap
contributors · ODbL 1.0** attribution badge with an expandable data-sources panel.

## Project layout

```
src/
  app/        React shell: panels, controls, loading indicator (no scene objects)
  engine/     Three.js: camera, renderer, tile streaming, materials, shaders,
              postprocessing, picking — implements CityAppHandle
  city/       procedural city geometry: buildings, roofs, facades, roads,
              environment (pure functions → BufferGeometry)
  shared/     schemas, constants, coordinate/tile maths, app↔engine API
scripts/      offline pipeline: ingest, normalize, tiles, validation, QA
public/data/  generated tiles (static hosting)
tests/        unit (Vitest), integration, e2e (Playwright)
docs/         requirements, architecture, data sources, roadmap/progress,
              limitations, QA report, testing guide
```

See `docs/REQUIREMENTS_ORIGINAL.md` (original brief, verbatim),
`docs/REQUIREMENTS.md` (compliance matrix and change requests),
`docs/PROGRESS.md` for the roadmap and verified numbers,
`docs/ARCHITECTURE.md` for the coordinate conventions, tile payload schema,
renderer pipeline and module ownership.

## Data sources & licensing

* **© OpenStreetMap contributors**, data licensed under
  [ODbL 1.0](https://opendatacommons.org/licenses/odbl/). The app displays
  attribution; derived tile data keeps the same licence obligations
  (see `docs/DATA_SOURCES.md`).
* Extract provided by [Geofabrik](https://download.geofabrik.de/europe/belarus.html).

Restricted datasets (e.g. GlobalBuildingAtlas non-commercial height data) are
**not** integrated; see `docs/DATA_SOURCES.md`.
