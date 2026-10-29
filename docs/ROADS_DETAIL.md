# Road detail — centreline payload and street furniture

Status: **implemented and verified** for the committed pilot dataset (manifest
`0.2.0`). The payload fields are additive and optional, so tiles written by
older pipelines still render (the renderer keeps the polygon-axis fallback for
markings). Numbers from the verified run are at the bottom of this document.

## Goal

Make the street network read like real Minsk at close zoom without new data
sources: lane markings, zebra crossings, stop lines, signal heads, medians,
parking stalls, cycle lanes, one-sided sidewalks and bridge parapets. Everything
is derived from OSM tags that were already in the extract but not extracted.

## Payload contract (`src/shared/types.ts`)

`RoadPolygon` (additive, optional fields):

| Field | Type | Meaning |
| --- | --- | --- |
| `centerline` | `number[]` | flat `[x0,y0,x1,y1,…]`, local metres, clipped to the tile piece, open polyline |
| `centerlineOffset` | `number` | metres from the way start to the first centreline point (dash phase across tiles) |
| `lanes` | `number` | total marked lanes, 1..8, from OSM `lanes` |
| `oneway` | `boolean` | `oneway=yes/true/1/-1` or `junction=roundabout` |
| `surface` | `string` | one of `asphalt, paving_stones, paved, concrete, cobblestone, ground, dirt, compacted` |
| `cycleway` | `'lane' \| 'track'` | on-carriageway cycling provision |
| `sidewalk` | `'both' \| 'left' \| 'right' \| 'none'` | where pavements were emitted |
| `sidewalkWidth` | `number` | metres |

`TileData.crossings?: CrossingFeature[]` — crossing point projected onto the
crossed road's centreline: `x, y, angle` (road direction, rad CCW from +X),
`width` (carriageway), `kind` (`zebra` / `unmarked` / `signals`), `roadClass`,
`span` (crossing width along the road, default 4 m).

`SurfaceKind` gains `parking` (`amenity=parking` polygons, excluding
underground / multi-storey / rooftop).

Manifest `counts.crossings` / `counts.parking` are optional. Manifest `version`
becomes `0.2.0` for regenerated data.

## Pipeline (`scripts/`)

`extract.py`
* keep `cycleway`, `sidewalk`, `sidewalk:*:width`, `crossing*`,
  `traffic_signals`, `parking`, `junction`, `lanes:forward/backward` tags;
* `amenity=parking` closed ways are surfaces (`parking` kind);
* new node pass: `highway=crossing` and `highway=traffic_signals` nodes inside
  the window become `kind: "crossing"` point features.

`normalize.py`
* roads carry the centreline + derived attributes; the centreline is clipped
  per tile piece and the dash phase (`centerlineOffset`) is stored;
* pavements follow `sidewalk=both/left/right/no|separate` and
  `sidewalk:*:width` (default 3 m, clamped 1..8 m);
* crossings are projected to the nearest drivable road line
  (STRtree, ≤ 40 m), snapped to its width, deduplicated per road+station
  (2.5 m) and assigned to the tile of the crossing point;
* parking surfaces are emitted with `kind: "parking"`;
* determinism: sort crossings by OSM id, no set iteration order in the output.

Budget: the pilot payload should grow by no more than ~15 % and the renderer
must keep ≤ ~4 000 extra marking triangles per tile (hard caps in the builders).

## Renderer (`src/city/roads/`)

* `roadPath.ts` — flatten/validate the flat centreline and resample it into
  arc-length stations with tangents (pure, unit-tested).
* `markingLayout.ts` — lane markings from the centreline: dashed centre line,
  double solid centre on avenues, lane dividers, edge lines; emitted as
  rectangles clipped to the road polygon. Falls back to `roadDashes()` when a
  tile has no centreline.
* `crossings.ts` — zebra bars, stop lines and signal poles from
  `TileData.crossings`, matched to the road polygon that contains the point.
* `medianMesh.ts` — raised lawn/stone median between directions on wide
  two-way avenues; breaks at crossings and at junctions with other roads.
* `bridgeMesh.ts` — parapets/railings + piers on `bridge=yes` decks.
* `roadMeshes.ts` — wiring, surface tints, red cycle lanes, per-tile triangle
  caps, diagnostics counters.

All geometry is merged into the single per-tile roads geometry (no new draw
calls). Old tiles (no new fields) keep the current look.

## Verification

1. `pnpm typecheck` + `pnpm test` (unit) + tile-data tests.
2. Pipeline rerun: `pnpm run data:extract`, `data:normalize`, `data:validate`;
   determinism check by running normalize twice and diffing tiles.
3. `scripts/qa/geometryAudit.ts` on the pilot tiles.
4. Close-zoom screenshots (day + night) reviewed for artifacts, plus an
   independent browser QA pass by a subagent.

## Verified result — pilot dataset (manifest 0.2.0)

Pipeline (`extract.py --area pilot` + `normalize.py --area pilot`, run twice,
byte-identical output):

| Metric | Value |
| --- | --- |
| tiles | 16 × 512 m |
| road / pavement / rail polygons | 3 538 (was 3 777; pavements now follow `sidewalk=*`) |
| drivable `kind:"road"` pieces | 1 056 |
| pieces with `centerline` | 1 026 (97.2 %) |
| pieces with `lanes` / `oneway` / `surface` / `sidewalk` | 302 / 289 / 677 / 146 |
| crossings | 204 (signals 134, zebra 57, unmarked 13); 74 mapped nodes merged, 1 unmatched |
| parking surface polygons (tiles) | 132 across 15 tiles |
| payload size | 2 224 206 B (2 172 KiB) vs 2 139 060 B baseline → **+85 146 B = +4.0 %** |

Why the pilot has 204 crossings and not 1 000+: the pilot is 1.6 × 1.6 km inside
a ~4 km extraction window; the window contains 1 904 crossing/signal nodes, the
pilot only 279. Likewise 115 parking areas are inside the pilot (132 after tile
splitting). This is the data extent, not missing extraction.

Renderer (`node scripts/qa/geometryAudit.ts`, `screenshots/roads/`):

* environment triangles 156 000 → **190 834** (+22 %) at 49–81 draw calls and
  60 FPS; total pilot geometry 257 822 triangles (audit), geometry audit PASSED;
* `pnpm typecheck`, `vite build`, 356 unit tests (22 files) pass, including
  `tests/unit/environment/roadDetail.test.ts` (23) and `parking.test.ts` (10);
* screenshots: `screenshots/roads/01-junction-zebras-pixel.png`,
  `03-junction-close-pixel.png`, `04-avenue-median-pixel.png`,
  `06-parking-lot-pixel.png`, `08-bridge-parapets-pixel.png`,
  `11-night-junction.png`, `12-district-overview.png` (script
  `scripts/qa/road-detail-shots.mjs`, 16 shots incl. clean-3D variants).

Known limits (deliberate, documented):

* crossings on the same road within 18 m are merged (one zebra between the two
  mapped signal heads); crossing nodes are snapped to the nearest drivable road
  centreline within 22 m;
* lane/centre/edge paint stops 11 m from a crossing street's centreline
  (directional test: >30° apart), 4 m from a parallel one and 7 m from the way
  ends, so markings do not run through junction boxes;
* medians are only derived for `motorway/trunk/primary/secondary` two-way
  carriageways ≥ 14 m wide with ≥ 4 lanes (or ≥ 17 m), and break at crossings,
  at junctions with another street centreline and 8 m from the piece ends;
* parking stalls are derived from the minimum-area rectangle (two edge rows,
  single row on narrow bays, 0.22 m lines so they survive the pixel-art render,
  caps 200 tri/polygon, 600 tri/tile);
* medians are not synthesised between two one-way carriageways of a dual
  carriageway mapped as separate ways — that gap is whatever the mapped land
  cover/road geometry shows;
* bridge parapets are a stylistic 0.95 m concrete wall + posts on the deck edges
  (a shared edge between two overlapping bridge ways gets one parapet only), the
  deck skirt covers the longitudinal edges only (no black wall across a
  tile/deck cut) and piers are derived every ~20 m;
* tiles generated by older pipelines (no centreline) keep the previous
  single-dashed-axis look and no crossings/parking detail.

