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
generated offline, streamed and rendered in the browser (current tile payload
**0.4.3**). The road topology introduced in **payload 0.3.0** uses a
non-overlapping surface partition
(asphalt/stone/concrete/unpaved material zones, pavements, kerbs, medians and
one asphalt face per graph junction) plus an **OSM topology graph** with
per-direction lane tags, junction faces and pedestrian crossings — so road
seams, junction patchwork and stacked detail layers are gone. Lane markings,
zebras and tram rails are derived from that network: double solid centres on
merged four-lane corridors, asymmetric per-direction lane layouts (a tagged
3-lane street renders 3 lanes), link/service/channelization roads rendered as
paving instead of painted streets, paint clipped out of junction faces, and
rails that run continuously through junctions and tile borders (see
`docs/ROAD_NETWORK.md`). See `docs/REQUIREMENTS_ORIGINAL.md` for the original
brief, `docs/REQUIREMENTS.md` for the compliance matrix, `docs/PROGRESS.md` for
milestone/roadmap status and `docs/LIMITATIONS.md` for what is inferred vs.
surveyed.

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
~2.6 MiB JSON) so the app runs immediately after `pnpm install`.

A **12 × 12 km city dataset** (144 × 1024 m tiles, ~93 MB JSON, 31 783 buildings
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

### Lipki aviation museum

The open-air exhibition at Lipki airfield is curated geometry: 29 aircraft
(baked from the decimated museum models) placed exactly as annotated on the
drone photo, with 9 empty spots where no 3D model exists. The exhibits are a
static payload (`public/data/museum/`, ~2.3 MiB binary, 87 k triangles) loaded
next to the streamed tiles.

Open **http://127.0.0.1:5173/?dataset=city&focus=lipki** or press
**«Авиамузей «Липки»»** in the control panel (from the central district the
button switches to the city dataset). Clicking an aircraft opens a card with a rotatable 3D model, a short description and links to the museum website. Regenerate the payload after changing the
placement with:

```powershell
.\.venv\Scripts\python.exe scripts/qa/export_museum_web.py
```

Placement provenance, the annotation convention (blue arrows = fuselage axes)
and the per-exhibit checks are documented in
[`assets/aviation-museum/analysis/report_lipki.md`](assets/aviation-museum/analysis/report_lipki.md).


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
pnpm test               # Vitest: geometry, roofs, facades, environment,
                        #   road surfaces/network, tile maths, config sync,
                        #   curated landmarks, real-tile data
pnpm run test:data      # Python unit tests of the road normalization rules
pnpm run qa:road-audit  # independent audit of the generated road payload
pnpm run test:e2e       # Playwright: 13 browser tests (WebGL; SwiftShader by default)
$env:QA_GPU='1'; pnpm run test:e2e   # same, but on the hardware GPU (faster, realistic FPS)
pnpm run qa:capture     # 6 canonical screenshots + stats.json + console.log
pnpm run qa:road-shots  # close-up road/junction screenshot sweep
pnpm exec tsx scripts/qa/geometryAudit.ts  # headless geometry audit of pilot tiles
```

**Verified 2026-11-06:** TypeScript/build passed, **440 Vitest passed (5 skipped)**
and **14 hardware-WebGL Playwright tests passed**. Rail heads now keep the same
palette and physical width across ground/deck LODs; see
[`docs/RAIL_LOD_2026-11-06.md`](docs/RAIL_LOD_2026-11-06.md). The default trees use
rounded, asymmetric instanced crowns (review C); all **316 704 city trees** retain
their positions and nominal dimensions. Canopy palette/visibility can change
without rebuilding tiles; mobile/touch and full seasons remain unfinished.

On the reference RTX 3080 Laptop (ANGLE/D3D11, 1600×900, internal 640×360),
the same 144-tile comparison reduces tree buffers by **87.95%** and the resident
buffer counter from **731.20 to 378.42 MiB**. The detailed crowns increase
overview frame time from **4.70 to 6.46 ms** (p95 6.10 → 8.10 ms), with
**593 draw calls / 7 875 933 visible triangles**. Vsync and the FPS cap were off
for this benchmark; these are desktop results, not phone verification. See
[`docs/TREE_INSTANCING_2026-11-06.md`](docs/TREE_INSTANCING_2026-11-06.md)
for per-view results and review commands. Screenshots are in `screenshots/`
(git-ignored); current comparisons are under `screenshots/tree-instancing/`.

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
`docs/BACKLOG.md` for the planned work backlog,
`docs/ROAD_NETWORK.md` for the road width/material/junction model, and
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
