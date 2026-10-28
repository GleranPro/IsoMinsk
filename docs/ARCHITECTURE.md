# Architecture — Isometric Minsk

Interactive isometric pixel-art 3D map of central Minsk, generated from real
OpenStreetMap geometry. This document is the contract between the offline data
pipeline and the browser renderer, plus the module ownership map.

## 1. Data flow

Two datasets are produced from the same OSM extract (BBBike Minsk, with the
Geofabrik Belarus extract as the fallback for larger areas):

| Dataset | Extent | Tiles | Purpose | Committed |
| --- | --- | --- | --- | --- |
| `pilot` (default) | 1.6 × 1.6 km | 16 × 512 m | vertical slice, immediate `pnpm dev` | yes (~1.9 MiB) |
| `city` | 12 × 12 km | 144 × 1024 m | whole inner-city belt, `?dataset=city` | no — generated with `pnpm run data:city` (~59 MiB) |

```
BBBike Minsk .osm.pbf
        │  scripts/ingest/extract.py --area pilot|city   pyosmium, C++ node index
        ▼
data/interim/{minsk,city}_raw.geojson          WGS84 lon/lat + OSM tags + tree nodes
        │  scripts/normalize/normalize.py --area pilot|city   pyproj + shapely
        ▼
data/processed/{city_normalized,coverage}.json  validation / coverage source of truth
        │  projection → local metres → height/roof/archetype inference → tiling
        ▼
public/data/tiles/<x>_<y>.json                 512 m tiles (pilot, committed)
public/data/city-tiles/tiles/<x>_<y>.json      1024 m tiles (city, git-ignored)
<dataset>/manifest.json                        tile index, tileSize, bounds, counts
        │  scripts/validation/coverage_report.py --area pilot|city
        ▼
docs/COVERAGE_REPORT{,_CITY}.md                coverage + validity reports
        │  browser: src/engine/tiles (tile streamer, manifest.tileSize is authoritative)
        ▼
Three.js scene → pixel-art postprocessing → canvas
```

The renderer never touches raw geospatial data. The pipeline is deterministic:
same PBF + same scripts ⇒ same tiles. The dataset is selected by the URL
(`?dataset=city`) through `resolveDatasetName` / `resolveManifestUrl` in
`src/shared/config.ts`; the streamer reads `tileSize`, `tileRange`, `bounds` and
`pilotBounds` from the manifest and never hardcodes a grid.

## 2. Coordinate systems

| Space | Definition |
| --- | --- |
| Source | WGS84 (EPSG:4326), lon/lat degrees |
| Projected | EPSG:32635 (UTM 35N), metres |
| Local | `local = utm − originUtm`, metres, origin = pilot centre |
| Tile | `tile = floor(local / 512 m)` |
| Renderer world | `(x, height, z) = (localX, y, −localY)` |

* Local `+X` = east, `+Y` = north. Renderer `−Z` = north, so at azimuth 0 the
  screen "up" is north.
* Rings are `[x, y]` arrays in local metres; exterior ring first, holes after.
  Exterior rings are normalised CCW in local metres by the pipeline.
* The renderer uses local coordinates directly (origin at the pilot centre) —
  for a 1.6–2 km area the float32 precision is more than sufficient (≈0.1 mm at
  2 km). For city-scale expansion the same scheme is used per loaded tile, with
  a floating origin applied to the camera when the target moves far from 0.

Constants live in `src/shared/config.ts` and `scripts/geo_config.py`; a unit test
(`tests/unit/config_sync.test.ts`) guards that both agree.

## 3. Tile payload (`src/shared/types.ts`)

`TileData` is the only thing the renderer consumes:

* `buildings: BuildingFeature[]` — one record per OSM building, with one or more
  **non-overlapping** `volumes` (the pipeline resolves `building:part` overlaps
  so the renderer can extrude each volume blindly). Every volume carries
  `footprint` (rings), `minHeight`, `height` (eave), `roofShape`, `roofHeight`,
  optional `roofDirection` and the `heightSource` provenance.
* **Curated landmarks** — four buildings carry a `landmark` id
  (`minsk-gate`, `national-library`, `victory-obelisk`, `red-church`) plus the
  untrimmed original OSM footprint in `outline` (see `docs/DATA_SOURCES.md` §7).
  `src/city/buildings/landmarks.ts` routes them to dedicated geometry modules
  that replace the generic extrusion (rhombicuboctahedron, obelisk, church
  massing); the Minsk Gate crown is additive and stays in `cityGate.ts`. All
  other buildings use the generic volume builder.
* `surfaces` — parks, grass, forests, water, plazas (already clipped to the tile).
* `roads` — buffered road/pavement/rail polygons (already clipped to the tile).
* `trees` — deterministic tree instances, `mapped` = real OSM node.
* `crossingBuildingIds` — spatial-index hints for buildings owned by a
  neighbouring tile (geometry is never duplicated).

Ownership rule: each building lives in exactly one tile (the tile of its
centroid). The renderer loads tiles with a one-tile margin so buildings that
cross a border are already present. Tiles are never split, so there are no
geometry cracks.

## 4. Renderer pipeline

```
TileManager (fetch/cache/LRU/cancel)
      │ TileData
      ▼
tile builder: buildBuildingsMesh() + buildEnvironmentMeshes()
      │ merged BufferGeometries (attributes per src/shared/geometry.ts)
      ▼
facade material (procedural GLSL windows/balconies/cornices) + environment material
      │
      ▼
low-resolution render target (depth + normals)
      │ post pass: outline / quantise / dither
      ▼
nearest-neighbour upscale to the canvas (image-rendering: pixelated)
```

Key properties:

* **One merged mesh per category per tile** — a tile with 400 buildings is a
  couple of draw calls, never 400.
* **Facades are procedural**: no textures, no per-window meshes. Window rhythm
  comes from vertex attributes (`aUV`, `aStyle`, `aFace`) interpreted in the
  fragment shader, which also gets `uNight` and `uDetailScale` for night
  windows and LOD.
* **Pixel-art is a real postprocessing stage**, not a CSS filter: the scene is
  rasterised at ~320–420 px tall, edges are detected from depth/normal, colours
  are quantised/dithered, then the framebuffer is upscaled with nearest
  filtering. `setPixelEffectEnabled(false)` bypasses it for debugging.

## 5. Module ownership

| Path | Owner | Responsibility |
| --- | --- | --- |
| `scripts/**` | Lead | ingestion, normalisation, tiling, validation |
| `src/shared/**` | Lead | schemas, constants, tile maths, app↔engine API |
| `src/app/**` | Lead | React shell (menus, panels, loading) |
| `src/city/buildings/**`, `src/city/roofs/**` | geometry-dev | extrusion, roofs, merged building mesh |
| `src/city/facades/**`, `src/engine/shaders/**`, `src/engine/materials/facadeMaterial.ts` | facade-artist | facade shader, presets, palette |
| `src/city/roads/**`, `src/city/environment/**` | environment-dev | roads, pavements, parks, water, trees, rail |
| `src/engine/renderer|camera|tiles|picking|postprocess/**`, `src/engine/createCityApp.ts` | renderer-dev | renderer, controls, streaming, lighting, post, picking |
| `tests/e2e/**`, `scripts/qa/**`, `docs/QA_REPORT.md` | qa-dev | browser tests, screenshots, performance, visual QA |

Rules: contracts in `src/shared/**` are frozen without Lead approval; nobody
writes outside their ownership; React never creates scene objects.

## 6. Rendering defaults

* Orthographic camera, true isometric: azimuth 45°, elevation `atan(1/√2)`.
* Ortho half-height 420 m default, clamp 40…2600 m.
* Sun from a real Minsk latitude/longitude + time-of-day computation; shadow map
  fitted to the visible footprint.
* Ground layers are separated vertically (`GROUND_LAYER_Y`) to avoid z-fighting:
  base 0.00, landuse 0.02, grass 0.03, water 0.04, sidewalk 0.05, road 0.07,
  markings 0.09 m.

## 7. Scaling plan

The tile manager already works on an arbitrary tile range; expanding the city
means increasing `PILOT_SIZE_M` in the pipeline (or generating multiple regions)
and raising the LRU budget. Stable building ids (`w<id>`/`r<id>` from OSM) make
selection and future bookmarks survive tile eviction. Binary encoding + Brotli
is the planned next step for payload size; the JSON payload is designed so each
array maps 1:1 onto a flat typed array.
