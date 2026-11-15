# Isometric Minsk

Interactive isometric **pixel-art 3D map of the complete city of Minsk**,
generated from real OpenStreetMap geometry: real buildings with walls, roofs and
procedural facades; real avenues, squares, parks and the Svislach embankment; an
orthographic isometric camera you can pan, zoom and rotate; and a real pixel-art
rendering pipeline (low-resolution rasterisation → outline/quantise →
nearest-neighbour upscale).

Inspired by [bedirhanyildirim.com/warsaw-izo](https://bedirhanyildirim.com/warsaw-izo/).

**Status:** the application exposes **one dataset only — the complete expanded
city** (437 × 1024 m tiles, 76,004 source buildings, 1,910,624 trees, ~295 MB of
tile payload, current tile payload **0.5.0**). There is no central-district
selector, no reduced public extent and no pilot fallback: legacy links such as
`?dataset=city` or `?dataset=central` simply load the whole city. Buildings now
carry a **versioned procedural style recipe** (27 coherent architectural
families in 11 broad archetypes) assigned offline, rendered with shared massing
profiles, modular facade geometry, distinctive roof envelopes and recipe-driven
facade material presets.

The road topology introduced in **payload 0.3.0** uses a non-overlapping surface
partition (asphalt/stone/concrete/unpaved material zones, pavements, kerbs,
medians and one asphalt face per graph junction) plus an **OSM topology graph**
with per-direction lane tags, junction faces and pedestrian crossings — so road
seams, junction patchwork and stacked detail layers are gone. Lane markings,
zebras and tram rails are derived from that network (see
`docs/ROAD_NETWORK.md`). See `docs/REQUIREMENTS_ORIGINAL.md` for the original
brief, `docs/REQUIREMENTS.md` for the compliance matrix, `docs/PROGRESS.md` for
milestone/roadmap status and `docs/LIMITATIONS.md` for what is inferred vs.
surveyed.

---

## Quick start (Windows 11 / PowerShell)

Requirements: **Node.js 24+**, **pnpm 10+**, **Python 3.11+** (only needed to
regenerate the data; the accepted tile payload is generated locally).

```powershell
cd D:\Workk\VoxelMinsk

# 1. Install JavaScript dependencies
pnpm install

# 2. Start the app (the complete city must be present in public/data/city-tiles)
pnpm dev
#    → open http://127.0.0.1:5173
```

The app needs no backend: it is a static Vite site plus JSON tiles.

## One dataset: the complete city

The public application serves exactly `public/data/city-tiles`: **437 tiles of
1024 m** covering the first MKAD ring and the Lipki airfield complex, with
**76,004 source buildings**, **1,910,624 trees**, five curated landmarks (Minsk
Gate clock/emblem towers, National Library diamond, Victory Square obelisk, the
Red Church and the TV tower) and the Lipki aviation museum. Regenerate it from
the frozen OSM extract with:

```powershell
pnpm run data:city:extract     # B-2 area window from scripts/geo_config.py
pnpm run data:city:normalize   # writes public/data/city-tiles
pnpm run data:city:validate    # coverage report
```

The tile payload carries an optional per-building `styleVariant` record
(`schema: 1`, recipe id `0..37`, provenance, eligibility tokens) and the manifest
records `styleSchema`, `sourceDatasetId`, `sourceInputSha256`, `styleRunId` and
`styleRecipeCounts`. Older payloads without the style record still render: they
resolve the frozen legacy archetype presets (`27..37`) and reproduce the exact
previous facade values.

### Lipki aviation museum

The open-air exhibition at Lipki airfield is curated geometry: 29 aircraft
(baked from the decimated museum models) placed exactly as annotated on the
drone photo, with 9 empty spots where no 3D model exists. The exhibits are a
static payload (`public/data/museum/`, ~2.3 MiB binary, 87 k triangles) loaded
next to the streamed tiles.

Open **http://127.0.0.1:5173/?focus=lipki** or press
**«Авиамузей «Липки»»** in the control panel. Clicking an aircraft opens a card
with a rotatable 3D model, a short description and links to the museum website.
Regenerate the payload after changing the placement with:

```powershell
.\.venv\Scripts\python.exe scripts/qa/export_museum_web.py
```

Placement provenance, the annotation convention (blue arrows = fuselage axes)
and the per-exhibit checks are documented in
[`assets/aviation-museum/analysis/report_lipki.md`](assets/aviation-museum/analysis/report_lipki.md).


## Regenerating the complete-city data (optional)

The offline pipeline extracts the B-2 area window from the frozen OSM extract,
normalises/projects/infers heights, assigns the style recipes and writes the tile
payloads.

```powershell
# once: python environment with the geospatial stack
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r scripts/requirements.txt

# download the BBBike Minsk OSM extract (~35 MB, cached; -Full for Geofabrik Belarus)
pnpm run data:download

# complete city: extract → normalise → validate (≈9 min; the tree budget is 2 M)
pnpm run data:city
```

Outputs:

| Path | Content |
| --- | --- |
| `data/raw/Minsk.osm.pbf` | raw BBBike Minsk extract (git-ignored) |
| `data/interim/city_raw_b2.geojson` | complete-city features in WGS84 (git-ignored) |
| `public/data/city-tiles/manifest.json` | tile index, counts, attribution, style run |
| `public/data/city-tiles/<x>_<y>.json` | per-tile renderer payload (1024 m tiles) |
| `data/processed/coverage_city_b2.json` | coverage + provenance statistics |
| `docs/COVERAGE_REPORT_CITY.md` | generated coverage/validity report |

The area rectangle and tile size are configured in `scripts/geo_config.py`
(mirrored in `src/shared/config.ts`). The same PBF produces byte-identical tiles
apart from the deliberately recorded `generatedAt` field.

## Tests

```powershell
pnpm run typecheck      # TypeScript, strict
pnpm test               # Vitest: geometry, roofs, facades, style registry,
                        #   environment, road surfaces/network, tile maths,
                        #   config sync, curated landmarks, real-tile data
pnpm run test:data      # Python unit tests (style selector, road rules, trees)
pnpm run qa:road-audit  # independent audit of the generated road payload
pnpm run test:e2e       # Playwright: browser tests (WebGL; SwiftShader by default)
$env:QA_GPU='1'; pnpm run test:e2e   # same, but on the hardware GPU (faster, realistic FPS)
pnpm run qa:buildings:gallery   # 27-recipe L1 gallery capture + gallery-results.json
pnpm run qa:buildings:audit     # styled-city contract audit (source preservation)
pnpm run qa:capture     # 6 canonical screenshots + stats.json + console.log
pnpm run qa:road-shots  # close-up road/junction screenshot sweep
```

**Building-quality evidence:** `docs/building-quality/` holds the frozen baseline,
the L0 review-case registry, the style-selection rules, the L1 gallery results and
the styled-city contract audit; `docs/building-quality/REVIEW.md` records the
honest L0–L4 status. Screenshots live in the git-ignored
`screenshots/building-quality/<sha>/`.

**Verified 2026-11-15 (mobile/touch):** mobile/touch work landed on top of the
complete-city release. Touch gestures (one-finger pan, pinch zoom, two-finger
pan/twist with 45° snap, tap select, double-tap focus), a foldable settings panel
that starts folded on phones and a phone-adapted HUD are implemented.
Browser-emulated touch, not a real-phone performance claim; full seasons remain
unfinished. Merged-release verification: **562 Vitest passed (5 skipped, 34
files)**; the mobile suite passed **7/7** and **30 of 31** hardware-WebGL browser
scenarios passed. The remaining `trees.spec.ts` scenario still expects the old
16-tile pilot and cannot pass on the complete-city payload (pre-existing; GitHub
CI does not run Playwright).

**Verified 2026-11-06 (historical, before the building-variety work):** TypeScript/build
passed, **440 Vitest passed (5 skipped)** and **14 hardware-WebGL Playwright tests
passed**. Rail heads keep the same palette and physical width across ground/deck
LODs; see [`docs/RAIL_LOD_2026-11-06.md`](docs/RAIL_LOD_2026-11-06.md). The default
trees use rounded, asymmetric instanced crowns (review C). Canopy
palette/visibility can change without rebuilding tiles; mobile/touch and full
seasons remain unfinished.

On the reference RTX 3080 Laptop (ANGLE/D3D11, 1600×900, internal 640×360), the
historical 144-tile comparison reduced tree buffers by **87.95%** and the resident
buffer counter from **731.20 to 378.42 MiB**. Those numbers describe the old
12 × 12 km dataset and are kept as dated evidence only; see
[`docs/TREE_INSTANCING_2026-11-06.md`](docs/TREE_INSTANCING_2026-11-06.md).

## Controls

| Input | Action |
| --- | --- |
| Left-drag / WASD / arrows | Pan |
| Mouse wheel | Zoom (cursor-anchored) |
| `Q` / `E` or right-drag | Rotate camera |
| Left click | Select building (info panel with OSM metadata) |
| One-finger drag | Pan (touch) |
| Pinch | Zoom at the pinch midpoint (touch) |
| Two-finger twist | Rotate; snaps to the 45° compass on release (touch) |
| Tap / double-tap | Select / focus on the tapped point (touch) |
| Rotate ⟲ / ⟳ 45° buttons | Step the camera azimuth by 45° |
| Reset isometric view button | Restore the default isometric view |

The **Settings** panel folds to a compact pill; on phones it starts folded so the
map keeps the screen, and the choice is remembered per browser. Coarse-pointer
styles enlarge every control to a touch target, the HUD respects phone safe
areas, and building/museum cards become full-width bottom cards.

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
