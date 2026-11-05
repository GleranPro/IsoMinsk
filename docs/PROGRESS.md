# Project progress — Isometric Minsk

Living document. Status is updated only after the work has actually run.
Legend: ✅ done & verified · 🟡 implemented, verification pending · ⏳ in progress · ❌ blocked

Original project brief: [`docs/REQUIREMENTS_ORIGINAL.md`](REQUIREMENTS_ORIGINAL.md)
(verbatim). Compliance matrix and change-request log:
[`docs/REQUIREMENTS.md`](REQUIREMENTS.md).
Next iterations: see the [roadmap](#roadmap-next-iterations) at the bottom.
Planned but not started work: [`docs/BACKLOG.md`](BACKLOG.md).

## Current state

**Delivered: an interactive isometric pixel-art 3D map of Minsk, generated from
real OpenStreetMap geometry.** Two datasets are supported:

* **central pilot (committed, default)** — 1.6 × 1.6 km around October /
  Independence Square, 16 × 512 m tiles, ~2.0 MiB; and
* **city belt (generated locally, `?dataset=city`)** — 12 × 12 km, 144 × 1024 m
  tiles, 31 783 buildings, ~60.2 MB, all inner districts (`pnpm run data:city`).

The renderer streams tiles nearest-first with a bounded resident set, fits the
camera to the dataset bounds, and draws real buildings with walls, roofs and
procedural facades, avenues, pavements, tram rails, parks, the Svislach river,
deterministic vegetation, cast shadows, day/night lighting and building
selection with OSM metadata.

**Roads (payload 0.3.0)** are a non-overlapping surface partition
(asphalt/stone/concrete/unpaved material zones, pavements, kerbs, medians and
one asphalt face per graph junction) plus a semantic centreline network with an
OSM topology graph, per-direction lane tags, junction faces and pedestrian
crossings. Lane markings, zebras and tram rails are derived from the network;
slip/link roads, service aisles and unnamed channelization connectors are
paving (not painted streets), and junction paint is clipped by the face
polygons. See `docs/ROAD_NETWORK.md`.

**Curated landmarks** (`landmark` field in the data, dedicated geometry modules):
«Ворота Минска» (clock/emblem towers), Национальная библиотека (rhombicuboctahedron
"diamond" on its terraced podium), Монумент Победы obelisk on Victory Square, the
Red Church (brick neo-gothic, twin spires) and the TV tower on Kamunistyčnaja
street (176 m lattice mast with platform bands and the 160 m octagonal platform).
See `docs/DATA_SOURCES.md` §7 for the hand-reviewed OSM fixes behind them.

**Park attractions**: both Minsk ferris wheels are rendered as real geometry —
54 m / Ø51 m / 36 cabins in Gorky Park and 28 m / 18 cabins in Chelyuskintsev
Park (`TileData.attractions`, built by `src/city/environment/ferrisWheel.ts` and
merged with the vegetation geometry). Wheel dimensions and plane bearings are
curated (OSM only carries `attraction=big_wheel` + height), see §7.

Acceptance screenshots: `docs/screenshots/` — overview, close-up, detail, night,
golden hour, clean 3D; landmarks `11`–`18`, `25`–`28`; park attractions `22`–`24`;
water/islands and the restored Svislach river `19`, `21`; flame placement `27`,
`28`.

### Defect-fix round (after first visual review)

| Reported defect | Root cause | Fix |
| --- | --- | --- |
| Trees in impossible places | heuristic trees scattered by a jittered grid over any green polygon, no exclusion masks | STRtree exclusion masks (buildings, roads, water, pitches, plazas, construction, rail), density by land-use class, narrow-strip rejection, mapped OSM trees filtered out of hard surfaces (70 of 216 dropped) |
| Yanka Kupala park "flooded diagonally" | river/canal **centre lines** were buffered into 20+ m water bands, synthesising water where OSM only has an axis | water only from mapped areas; centre lines limited to ≤6 m streams and skipped where an area exists; unpaved footways that are >50 % over water dropped |
| Palace of the Republic facade wrong | generic `civic` preset | new `palace` archetype + preset (colonnade rhythm, glazed loggia, paired windows, double cornice) and massing accents (plinth/cornice/attic bands) |
| Dynamo stadium was an oval slab | every `building=*` was extruded | new `stadium` archetype: arena bowl (outer wall, sloped stands, inner rim, pitch), grandstands as blank rakes; 18 stadiums in the city dataset |
| Minsk Gate («Ворота Минска») absent | OSM relation `9383682` is a malformed multipolygon with two outer rings; two `height=0.01` aggregate ways traced several unrelated buildings at once, and the old duplicate detector deleted the whole ensemble and four real neighbouring buildings | new `landmark: "minsk-gate"` contract + `src/city/buildings/cityGate.ts`: flat parapet, clock/emblem medallions and corner turrets on both tower tiers (38.5 m); two broken aggregates skipped (`CURATED_DUPLICATE_IDS`), real ways (Bobruiskaya 13/15, Leningradskaya 7, Ulyanovskaya 34) now render; height sanity (<2.5 m ignored) and footprint-verified dedupe added |
| Yanka Kupala park "flooded", all river islands missing | `extract.py` concatenated every multipolygon member ring into one `Polygon` (member roles ignored); `make_valid` repaired the Svislach water relation `14605048` into a ~13 ha blob over the park. `normalize.py` then re-polygonised the rings, so island holes (inner rings) were dropped instead of being kept | relation assembly now respects `outer`/`inner` roles (noded linework → `polygonize` → shells minus holes, MultiPolygon output); GeoJSON ring order (exterior + holes) is preserved, so water polygons keep their islands — 15 city water polygons with 42 island holes now render (Komsomolskoye Lake 11, Drozdy 4, Svislach 1, …). A follow-up fix keeps **2-point member ways** in the assembly: the Svislach river and the park boundary are split into many short segments, and dropping them had left those rings open — the river relation was lost and that river section rendered as dry land. Both relations restore (park 104 474 m², Svislach 76 118 m² + 26 182 m²) while the bogus flood stays gone. A regression this exposed in the Minsk Gate — its ring-shaped relation no longer captured the tower parts — is fixed by the curated `CURATED_PART_PARENTS` mapping, so the clock/emblem crown is back |
| Victory obelisk: eternal flame against the monument base corner | the flame slab was placed at `baseExtent + 2.6 m` along local −Y, so a 5.2 m slab touched the pedestal base and sat at the obelisk instead of in the square | the flame is its own 9 × 9 m platform at the real OSM position (`way/1308903766` «Вечны агонь», centroid 24 m west-south of the monument centre, `FLAME_OFFSET` in `src/city/buildings/victoryObelisk.ts`), i.e. in the middle of the square in front of the obelisk (`docs/screenshots/27-victory-flame.png`) |


## Milestones

| Milestone | Status | Evidence |
| --- | --- | --- |
| A — Geospatial foundation | ✅ | 654 buildings, 679 surfaces, 3251 road/rail polygons, 3775 trees in 16 × 512 m tiles; validation PASS; `docs/COVERAGE_REPORT.md` |
| B — Real 3D buildings | ✅ | merged per-tile geometry; ~65 000 triangles for 905 volumes; flat normals exact; all roof shapes; 53 unit tests; geometry audit 0 issues on all 16 tiles |
| C — Procedural facades | ✅ | GLSL facade material: window grids, dark day glass, ground-floor bands + shopfronts, cornices, balconies, night windows, LOD detail; 9 archetype presets; 60 facade tests |
| D — Isometric pixel-art rendering | ✅ | ortho camera + custom controls, tile streaming with LRU/cancel/worker pool, low-res target + depth-outline + dither/levels post pass, nearest upscale, artt-directed shadows, pixel-art vs clean-3D toggle |
| E — Streets and environment | ✅ | roads/pavements/kerbs/markings/tram rails/bridges, parks, water banding, deterministic trees; ≤10.7k env tris/tile; 67 unit tests |
| E2 — Road network normalization (payload 0.2.0) | ✅ | non-overlapping surface partition (material zones/paving/kerb/median) + network centrelines + 520 junction records + 183 crossings (81 zebra/89 signals/13 unmarked) + 13 medians; same-layer overlaps 0.0 m² (was 73 994 m² stacked), tile-seam gaps 0.0 m, street width spread 0.0 m; 2 166 247 B payload (+1.4 % vs 0.1.0); envTriangles 164 832 (+5.7 %); 348 unit tests, 24 Python road tests; `docs/ROAD_NETWORK.md`; 13 road screenshots |
| E3 — Road markings round 2 (payload 0.2.0) | ✅ | full lane layout on all asphalt classes (tagged `lanes`, clamped), double solid centre + dividers on 25 merged four-lane corridor pieces (20 area-global pairs, 13 on Independence Ave), edge lines, bridge paint raised; junction/crossing clipping for every paint type and asphalt containment for zebra bars/stop lines (51 + 68 dropped); tram rails from 2 merged network centrelines (6 tile pieces, ballast + 2 heads, continuous through junctions and tile borders); direction-aware length-weighted widths (70 ways normalized), medians computed before paving, 0.15 m paving sliver closing, junction fillets (2 443 m²) removing the Bogdanovicha × Yanka Kupala crossing artifact; 364 Vitest, 27 Python tests; road audit 0 same-layer overlaps / 0 seam gaps / 0 width spread; 2 142 KiB payload (+1.3 % vs the 0.1.0 baseline); 20-shot `qa:road-shots` sweep; `docs/ROAD_NETWORK.md` |
| E4 — Road topology/lane-model rewrite (payload 0.3.0) | ✅ | OSM topology graph (`road_graph.py`) + one asphalt face per graph junction (corner ring or approach-mouth union; 288 tile records / 274 unique, 0 invalid rings); lane tags authoritative per way and direction (`lanesForward`/`lanesBackward`; Ulyanovskaya 3 lanes, Lenina 1+2), width derived from lanes with a physical-compatibility guard; link/service/channelization roads render as paving, not painted streets (anonymous fork removed); renderer asymmetric lane layout without width clamping, chunk-aware junction-face/junction-surface paint clipping (lane paint inside faces = 0, near-face = 0), authoritative approach stop bars (209 unique), 23-shot sweep; 382 Vitest, 30 Python tests; road audit 0 same-layer overlaps > tolerance / 0 seam gaps > 0.01 m / 0 width spread; 2 326 KiB payload; `docs/ROAD_NETWORK.md` |
| F — User interaction | ✅ | pan/zoom/rotate/reset, picking + info panel with stable OSM ids, pixel toggle, facade toggle, wireframe, time-of-day slider, loading indicator, visible ODbL attribution |
| Scaling (all Minsk) | ✅ | 12 × 12 km city-belt dataset, 144 × 1024 m tiles, 31 783 buildings, 4.01 M triangles at full residency and 60 FPS on an RTX 3080; `?dataset=city` / `pnpm run data:city`, see `docs/ARCHITECTURE.md` §7 |
| Landmark kit (curated) | 🟡 5 of 9 planned landmarks modelled | Minsk Gate (clock/emblem towers, parapet, turrets), National Library (rhombicuboctahedron + terraced podium), Victory Square obelisk (pedestal + shaft + gold star), Red Church (brick nave, twin spires, gold crosses), TV tower (176 m red/white lattice mast with platform bands and the 160 m octagonal platform). Remaining: Bolshoi Theatre, railway station, Minsk-Arena, Holy Spirit Cathedral — they still use archetype presets |
| Park attractions (curated) | ✅ | both ferris wheels as real geometry: Gorky Park (54 m, Ø51 m, 36 cabins) and Chelyuskintsev Park (28 m, 18 cabins), with A-frame supports, rims/spokes, upright cabins, boarding deck, hub sign and the trees cleared around them; `TileData.attractions` + `src/city/environment/ferrisWheel.ts`, 19 tests |

## Verified numbers (headless Chromium, ANGLE/D3D11, RTX 3080 Laptop)

**Central pilot dataset** (1600×900):
* 654 buildings, 16 tiles resident, 222 702 triangles (≈67 000 building +
  ≈156 000 environment/trees; geometry audit passes), 49 draw calls, 60 FPS,
  640×360 internal pixel-art resolution, ~28.5 MB GPU geometry, 0 console/page
  errors. The restored park/forest relations added ~25 k environment triangles.

**City dataset** (12 × 12 km, 1900×1000):
* Full overview with **all 144 tiles resident: 424 draw calls, 4 010 150
  triangles, 31 783 buildings, 540 MB GPU geometry, 60 FPS**; app ready in
  8.6 s warm / 23.9 s cold. The ground plate hides itself once the resident set
  covers the view, so the finished overview is a clean floating diamond.
* District (orthoHeight 1400): 60 FPS, 95 draws, 902 670 triangles, 49 visible
  tiles. Close-up (orthoHeight 80): 60 FPS, 12 draws, 200 870 triangles, shadows
  enabled. Shadows auto-disable above 3.2 km orthoHeight (a 2048² map across a
  10 km footprint would show its edge).
* Payload: 144 × 1024 m tiles, ~60.2 MB (58 758 KiB) JSON uncompressed
  (git-ignored; generated locally with `pnpm run data:city`).
* Landmark checks (city dataset, 0 console/page errors): Minsk Gate — clock face
  and gold emblem medallion readable on the two towers; National Library —
  faceted diamond + glazed podium skirt; Victory obelisk — stepped pedestal,
  bronze bands, gold star and eternal flame; Red Church — brick twin-tower
  facade with slate spires and gold crosses; TV tower — 176 m red/white lattice
  mast with platform bands, the octagonal 160 m platform, antenna arrays and the
  red beacon. The five curated landmarks total ~5 600 triangles (TV tower 2 522,
  library 1 779, church 690, gate crown ~516, obelisk 120) and replace the
  generic extrusions (`docs/screenshots/25-tv-tower.png`,
  `docs/screenshots/26-tv-tower-clean.png`).
* Park attractions: both ferris wheels render as real geometry — Gorky Park
  (54 m, Ø51 m, 36 cabins / 4 open, 1 710 triangles) and Chelyuskintsev Park
  (28 m, 18 cabins, 1 402 triangles), merged with the vegetation geometry;
  heuristic trees are cleared in a radius + 10 m around each wheel
  (`docs/screenshots/22-ferris-wheel-gorky.png`,
  `docs/screenshots/23-ferris-wheel-chelyuskintsev.png`).
* Water/islands check: 15 city water polygons with 42 surveyed island holes
  render (Komsomolskoye Lake, Drozdy reservoir, the Svislach islands); the
  Svislach river runs through the Yanka Kupala park correctly (76 118 +
  26 182 m² water polygons) while the bogus flood is gone
  (`docs/screenshots/19-komsomolskoye-islands.png`,
  `docs/screenshots/21-yanka-kupala-river.png`).

**General**
* Day overview: mean luminance 108/255, 0 % near-black. Night (22:30): mean
  39/255 with sparse warm lit windows.
* Tests: **382/382 unit** (Vitest, 22 files) including 47 road marking/
  junction-surface renderer tests, **30/30 Python** road network tests, **12/12
  browser e2e** (Playwright, software SwiftShader), `tsc --noEmit` clean,
  `vite build` ✓; pilot captured on hardware GPU (RTX 3080, ANGLE/D3D11) at
  60 FPS with 0 console errors.
* Road payload (pilot, 0.3.0): 2 067 surface pieces (incl. 248 junction-face
  pieces), 297 network pieces (incl. 6 rail tile pieces and 25 merged-corridor
  tile pieces), 288 junction tile records / 274 unique graph junctions,
  179 crossings, `roads: []`, 2 326 KiB; 0 same-layer overlaps above the
  0.35 m² rounding tolerance (residual cm² slivers total 2.7 m², max 0.061 m²),
  0 tile-seam coverage gaps above 0.01 m, 0 width spread; geometry audit
  207 483 env triangles; paint audit: 0 lane paint inside junction faces/on
  junction surfaces/near faces, lane-line counts match the tagged lanes.
* Data coverage (pilot): 8.7 % explicit `height`, 56 % from `building:levels`,
  35.3 % heuristic; 46.6 % explicit `roof:shape`. City belt: 1.7 % / 37.8 % /
  60.5 %, reflecting sparser tagging outside the centre.
* Archetype spread in the city belt: small 20 209, historic 3 885, panel 2 149,
  Khrushchev 1 651, office 1 668, civic 895, industrial 813, Stalin 435,
  modern 80, palace 5, stadium 16.
* Vegetation: 140 000 city instances (2 415 mapped OSM trees) and 8 530 in the
  pilot (150 mapped); restored park/forest relations account for the pilot
  increase. The tree LOD tiers keep dense tiles within budget.

## Open issues / known limitations (all documented)

| # | Issue | Severity | Notes |
| --- | --- | --- | --- |
| 1 | Roof-shape mix is heuristic outside tagged buildings (~68 % pitched in the centre, similar in the city) | medium | `heightSource`/`roofShapeExplicit` provenance is recorded per volume; a statistical roof model per district is the next quality step |
| 2 | Palace/landmark trim bands (plinth/cornice/attic, 0.35 m overhang) read as a dashed 1-px outline at far zoom | cosmetic | visible on the Palace of the Republic roof edge; reduce overhang or merge into the roof face if it bothers |
| 3 | Payload is uncompressed JSON (~60 MB for the city belt) | low | gzip ≈ 24 %; binary + Brotli encoding is the next scalability step |
| 4 | Some vegetation is procedurally placed (140 000 instances city-wide) | low | `TreeInstance.mapped` distinguishes surveyed from inferred; UI/docs say so |
| 5 | Underground objects (metro, passages) are not rendered | low | deliberate: they painted black strips on squares in an early build |
| 6 | Flat terrain (no DEM) | low | terrain-height provider is the extension point; see `docs/DATA_SOURCES.md` |
| 7 | Landmark geometry is curated for 5 of the iconic buildings only | medium | done: Minsk Gate, National Library, Victory obelisk, Red Church, TV tower. Next candidates (same pattern: data flag + dedicated module in `src/city/buildings/landmarks.ts`): Bolshoi Theatre, railway station, Minsk-Arena, Holy Spirit Cathedral |

## Roadmap (next iterations)

Ordered by expected visual/value gain per effort. Nothing here is started unless
it also appears as delivered above.

**Now — finish the curated kit (highest value per effort)**
1. Remaining four landmarks, same pattern (data flag + dedicated geometry module
   in `src/city/buildings/landmarks.ts`): Bolshoi Theatre, Minsk railway station
   (with the platforms/canopy), Minsk-Arena, Holy Spirit Cathedral. Each needs a
   measured reference (photo / old X-Plane model) like the five existing ones.
2. Landmark LOD/decoration pass: the library's curtain-wall mullion grid and
   LED band, the gate's sculpture groups, the church's buttresses/rose-window
   tracery; landmark night lighting hints (lit clock, TV-tower warning lights).

**Next — data quality and performance headroom**
3. Roof-shape model for the ~60 % heuristic city buildings (per-district
   statistics instead of one global heuristic) — the largest remaining visual
   error outside the centre.
4. Binary/Brotli tile encoding (city payload is ~60 MB uncompressed JSON;
   gzip ≈ 24 %).
5. Dense-forest tree tier if the tree triangle budget on 2 000+-tree tiles
   becomes a bottleneck again (the current LOD tiers hold 60 FPS).
6. Multipolygon edge cases: relations with missing members or broken ring order
   still fall back to a heuristic assembly; log/count them in the coverage report.
7. Animation layer: slow wheel rotation (8 min/turn), blinking aviation lights,
   animated night windows — needs a separate animated scene object, so it is a
   renderer task, not a tile-geometry task.

**Later / optional**
8. Terrain (DEM) support — flat ground is the current documented limitation.
9. Mobile/touch camera controls (currently mouse + keyboard).
10. Additional datasets (e.g. a zoomed-in "hero" dataset around Independence
    Square) if tile load time becomes the limiting factor.

## Multi-agent execution

Five parallel agents (building geometry, facades/art direction, environment,
renderer, QA) worked in the same checkout with disjoint file ownership; the Lead
owned the data pipeline, shared contracts, the React shell, integration and final
acceptance. See `docs/AGENT_TASKS.md`.
