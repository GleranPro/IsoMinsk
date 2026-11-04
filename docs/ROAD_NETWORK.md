# Road network normalization (payload 0.3.0)

Status: implemented in the offline pipeline and consumed by the renderer. This
document is the contract for the normalized road payload; the geometry code
lives in `scripts/normalize/road_network.py` and `scripts/normalize/road_graph.py`,
the renderer modules in `src/city/roads/`.

Round 2 (markings pass) introduced direction-aware widths, merged two-way
corridor pieces, median pieces before paving and tram rails as network
centrelines. Round 3 (topology pass) replaced the pairwise buffer junction model
with an **OSM topology graph**: shared vertices become graph nodes/edges, each
junction gets an asphalt face polygon, lane tags are authoritative per way
(per direction), and slip/link/channelization connectors are no longer painted
as streets. The sections below describe the final state.

## Why this layer exists

Before 0.2.0 the pipeline emitted **one buffered polygon per OSM way**. At
junctions those buffers overlap: two one-way carriageways of the same avenue,
a slip road merging into a main road, a service aisle crossing a yard. Each
polygon was filled with a class tint and raised by a per-polygon height jitter,
so overlapping fills produced a visible patchwork and any new detail layer
(marking, zebra, surface tint) inevitably stacked on top of another layer.

Measured on the pilot payload before the rewrite:

| Metric | Value |
| --- | --- |
| Drivable polygons | 879 |
| Overlapping drivable pairs (> 1 m²) | 1 166 |
| Total overlap area | 73 994 m² |
| Overdraw (sum of polygon areas / union area) | 1.14 |
| Widths that ignored OSM `lanes` (`max(class_default, lanes*3.1)`) | 96 / 884 ways |
| Named streets with different widths between segments | 22 / 33 |

Root causes:

1. **Width model**: `max(class_default, lanes * 3.1)` made every `primary` way
   18 m wide regardless of `lanes` or `oneway`. Each carriageway of a dual
   carriageway therefore got the width of the *whole street* and overlapped
   its opposite carriageway by thousands of m² (Independence Avenue,
   Pobediteley Avenue, Nemiga, Gorodskoy Val, Bogdanovicha, Sverdlova,
   Pervomayskaya).
2. **Overlapping fills**: class tints plus per-polygon Y jitter turned the
   overlaps into a patchwork; a material tint or a marking had nowhere to go
   but "on top of another layer".
3. **No junction model**: junctions were just intersecting rectangles; kerbs,
   markings and zebras had no notion of a junction box.

## Two layers

### 1. Surface partition (`TileData.roadSurfaces`)

Non-overlapping polygons, one per layer:

| `kind` | Meaning | Renderer layer |
| --- | --- | --- |
| `drivable` | carriageway surface, split into material zones | `ENV_LAYER_Y.road` |
| `paving` | footways, cycleways, paths, pedestrian streets + synthetic pavements | `ENV_LAYER_Y.sidewalk` |
| `kerb` | 0.6 m shoulder strip between asphalt and pavement | `ENV_LAYER_Y.kerb` |
| `median` | strip between paired one-way carriageways | `ENV_LAYER_Y.median` (0.0635 m) |

Pieces of one kind **never overlap**. `drivable` is further split into
`material` zones (`asphalt | stone | concrete | unpaved`) by a priority
partition:

* priority order: class rank (motorway → … → service) → width → material rank
  (`asphalt` > `stone` > `concrete` > `unpaved`) → OSM id;
* each way's buffer is reduced by the already-assigned higher-priority
  geometry, so the material zones tile the drivable union exactly;
* the union of each material is emitted as its own polygon(s), so a material
  change is a **crisp shared edge**, never two stacked tints;
* bridge decks and bridge pavements are partitioned separately and rendered
  raised by `BRIDGE_RAISE_M` (they may legitimately overlap the ground surface
  below at a different height — that is grade separation, not an artefact).
  Only the drivable deck gets structural side skirts, and an edge where the
  ground carriageway continues is treated as a deck end (no wall across the
  avenue); bridge sidewalks are flat slabs on the deck, never a second wall.

Junction asphalt is a **separate surface piece family** (`drivable`,
`junction: true`, payload 0.3.0): every graph junction node with three or more
distinct approaches gets one face polygon derived from its approach
cross-sections (corner-joined ring; if that ring is degenerate, the union of the
approach mouth rectangles). Faces are subtracted from the material zones, so
they never stack on top of asphalt/stone; pavements and kerbs are cut around
them. No per-polygon height jitter is used for these layers.

Round 2/3 refinements of this partition:

* **Median slots are computed before paving.** The gap strips between paired
  opposite one-way carriageways are turned into `median` pieces, and paving is
  computed as corridors minus drivable minus the **emitted** median pieces. A
  median fragment that is dropped (too small / clipped by a junction) therefore
  leaves paving in place instead of a hole.
* **Paving is side bands, not buffer cap rings.** Pavements follow the
  carriageway edge (mapped `sidewalk=left/right/both`, or a 3 m fallback band on
  the main street classes) and are clipped by the drivable surface; no flat
  corridor caps extend past way ends, which used to read as fake roads/forks at
  junctions. A 0.15 m closing removes sub-decimetre slivers between sidewalk
  fragments.
* **Channelization connectors are paving.** Unnamed short connectors that end
  at a junction, `highway=*_link` roads and service aisles keep their asphalt
  mouth inside the junction face but the rest renders as paving, so they cannot
  be mistaken for an anonymous roadway fork.
* **Paving/kerb never fills a junction face**; the face itself is asphalt and
  the renderer paints no lane markings on it.

### 2. Road network (`TileData.roadNetwork`)

Per-way semantic centrelines used to draw markings and crossings, never the
surface polygons:

```ts
interface RoadNetworkPiece {
  kind: 'road' | 'footway' | 'rail';
  class: RoadClass;
  width: number;          // normalized carriageway width, metres
  lanes?: number;         // this direction for one-way, total for two-way
  lanesForward?: number;  // 0.3.0: lanes in the centerline direction
  lanesBackward?: number; // 0.3.0: lanes against it (two-way only)
  lanesSource?: 'tag' | 'default'; // 0.3.0 QA provenance
  oneway?: boolean;
  link?: boolean;         // 0.3.0: highway=*_link (never painted)
  roundabout?: boolean;   // 0.3.0: ring, no centre line
  material?: RoadMaterial;
  surface?: string;
  bridge?: boolean;
  name?: string;
  merged?: boolean;       // synthetic two-way corridor (round 2)
  centerline: number[];   // flat [x0,y0,...]; overhangs the tile by 4 m
  centerlineOffset: number; // arc length at centerline[0], metres (dash phase)
}
```

**Topology graph (0.3.0).** `scripts/normalize/road_graph.py` reconstructs the
OSM graph from the projected geometry: shared vertices (same OSM node) become
graph nodes, each way is split at them into edges, and nodes with three or more
distinct approach directions are junctions. The graph supplies the junction
faces, graph-based channelization detection and dual-carriageway pairing. No
node ids are needed because every shared OSM node appears at the identical
projected vertex in every way.

**Lane model (0.3.0).** Lane tags are authoritative per way:
`lanes:forward`/`lanes:backward` when present, else `lanes` split floor/ceil for
two-way (or the direction count for one-way), else a per-class-per-direction
default. Width is derived from the lanes (`total_lanes × 3.0 m + 0.6 m`), with
an explicit `width` used only when physically compatible (≥2.6 m per lane); the
old width-derived lane inference and class-default width floor are gone.
**Slip/link roads, service aisles and unnamed short channelization connectors
are not emitted as network pieces** — they keep their junction mouth as asphalt
and render the rest as paving, with no lane paint. That removed the anonymous
"fork" at Ulyanovskaya × Lenina.

Merged corridor pieces (round 2, tightened in round 3): opposite one-way ways
of one street are merged only when their buffers overlap, their lane counts
differ by at most one, the total is ≤8 and the corridor is wide enough for the
lanes; otherwise they stay separate. Independence Avenue is 25 merged corridor
tile pieces (up to ≈24.9 m, 8 lanes → double solid + three divider rows per
side); the bogus 27 m / 10-lane Lenina corridor is gone.

Rails: merged tram/rail centrelines are emitted as `kind: 'rail'` pieces
(`width` = ballast width, 2.2 m tram / 3.4 m heavy rail, no material/oneway/
lanes). Near-duplicate parallel tracks of one tram line are collapsed
(Hausdorff ≤ 3.5 m), and the remaining lines are noded with `linemerge` before
tile clipping, so rails are continuous through junctions and across tile
borders. `TileData.roads` is now **empty** for new tiles (legacy rail polygons
still render on old 0.1.x demo tiles).

The 4 m overhang exists so a dash that straddles a tile border is generated by
exactly one tile (the renderer culls bars whose centre is outside the tile
bounds). `centerlineOffset` anchors the dash phase to the source way, so the
dash pattern is continuous across tile borders. Rail strips are clipped to tile
bounds instead of whole-piece ownership, so a rail crossing a border is drawn
half by each tile with matching cross-sections (halves meet exactly).

### Junctions (`TileData.junctions`) and crossings (`TileData.crossings`)

```ts
interface JunctionFeature {
  id: string; x; y; radius; approaches;
  polygon?: Polygon;      // 0.3.0 asphalt face ring(s)
  approachEdges?: { angle; width; lanesForward; lanesBackward; oneway; link; stopLine? }[];
  fallback?: boolean;
}
interface CrossingFeature { x; y; angle; width; span; kind: 'zebra'|'signals'|'unmarked'; roadClass; material?; oneway? }
```

Junctions are graph nodes with ≥3 distinct approach directions, at most one per
node, capped at a 30 m radius. The face is the corner-joined approach ring, or
(for degenerate corners) the union of the approach mouth rectangles — never an
arbitrary circle; 8 pilot faces use the mouth fallback and no face uses the
radius circle. The renderer clips lane paint out of the face polygon buffered by
`0.5 m + 0.5 × paint-element length` (chunk-aware), and also clips against the
`junction: true` asphalt surface pieces themselves, so even a face sliver whose
record was dropped cannot receive paint. Junctions without a 0.3.0 face polygon
(old 0.2.0 tiles) keep the legacy clearance radius. Approach stop lines are
authoritative `approachEdges[].stopLine` bars placed on the face boundary for
one-way approaches flowing into the junction; two-way approaches keep the
crossing-derived stop lines.

Crossings are OSM `highway=crossing` / `highway=traffic_signals` nodes
projected onto the **widest drivable carriageway whose asphalt actually
contains the node** (within `width/2 + 1 m`, ≤22 m), deduplicated (≤18 m on one
street, ≤8 m otherwise, same direction) and sorted by OSM id (determinism). A
signalised pedestrian crossing (`crossing=traffic_signals` on a crossing node)
is emitted as `zebra` — zebra bars *and* stop lines; a bare
`highway=traffic_signals` signal head is emitted as `signals` (stop line only).
The pilot yields 179 crossings from 279 mapped nodes.

## Width model (0.3.0: lanes first)

* **Lane tags are authoritative per way.** `lanes:forward`/`lanes:backward`
  when present; else `lanes` split floor/ceil for two-way, the direction count
  for one-way; else `DEFAULT_LANES_PER_DIRECTION` (primary/secondary/tertiary 2,
  residential/service/unknown 1, motorway/trunk 2).
* Width = `total_lanes × 3.0 m + 0.6 m` shoulders, clamped 4–40 m for roads
  (0.5–10 m for paths). An explicit `width` is used only when physically
  compatible (≥2.6 m per lane); a 7.5 m width with `lanes=4` is treated as a
  mapping error and the lanes win.
* A **tagged** segment keeps its own lane count; only untagged segments inherit
  the street-direction mode. This is why Ulyanovskaya renders 3 lanes and Lenina
  renders asymmetric `lanes:forward=1 / lanes:backward=2`; the old street-wide
  width median and the renderer's width clamp were what turned a 3-lane street
  into 2 lanes.
* Width consistency is checked per (street, direction, lane signature) in the
  coverage report and road audit; merged corridors are excluded (derived).
* Slip/link roads (`highway=*_link`), service aisles and unnamed short
  connectors that end at a junction are **channelization**: width capped at
  3.0 m, one lane, no network piece and paving instead of asphalt. The
  user-reported anonymous fork at Ulyanovskaya × Lenina was such a connector.

Pilot result: 4 ways needed a width correction after canonicalization; all
named street/direction/lane groups have a 0.0 m width spread.

## Material model

OSM `surface` values are folded into four renderer materials:

| OSM `surface` | material |
| --- | --- |
| `asphalt`, `paved`, `chipseal`, missing | `asphalt` |
| `sett`, `cobblestone`, `cobblestone:flattened`, `unhewn_cobblestone`, `paving_stones` | `stone` |
| `concrete`, `concrete:plates` | `concrete` |
| `ground`, `dirt`, `earth`, `unpaved`, `gravel`, `fine_gravel`, `compacted`, `sand`, `grass`, `wood` | `unpaved` |
| anything else | `asphalt` + counted in the coverage stats |

The renderer maps the material to one flat tone (`SURFACE_COLORS` in
`src/engine/materials/palette.ts`). There are **no per-class tints** any more:
class hierarchy is read from width and markings.

### Material canonicalization

* An explicit OSM `surface` is authoritative for its way — a long street may
  legitimately change material along its length. The stone/asphalt change is a
  crisp shared edge inside the same street, not an overlapping tint.
* Ways without a `surface` inherit the street's length-weighted majority
  material.
* `SURFACE_OVERRIDES` in `road_network.py` is the curated escape hatch for
  mapping errors (same convention as the building `LANDMARK_OVERRIDES`); every
  entry must be justified here.

### Worked example: Karl Marx Street

The user-reported case: “улица Карла Маркса, отрезок идущий к улице Янки
Купалы — выложена камнем”.

OSM data (pilot extract):

| Way | Tag | Length |
| --- | --- | --- |
| `w25228907` | `residential`, `surface=sett`, `lanes=2` | 190.6 m |
| `w519622802` + `w762532131` | `residential`, `surface=cobblestone` | 55.9 m |
| `w1520785219` | `residential`, `surface=asphalt` (junction apron at Yanka Kupala) | 23.8 m |
| continuation (`w29699895` and connecting ways) | `secondary/tertiary/residential`, `surface=asphalt` | ≈ 1 130 m |

The pipeline keeps the explicit stone run (sett + cobblestone) as `stone`
zones and the continuation as `asphalt`; the street-level median width is
7.8 m. The junction with Yanka Kupala is claimed by the higher-class asphalt
street in the priority partition, exactly like a real asphalt junction.
Result: the descent from the House of Officers towards Yanka Kupala renders as
stone, without overlapping polygons or a tint patch where the materials meet.

## Jitter and layer heights

* `drivable/paving/kerb/median` pieces are placed at their fixed semantic
  layer height — no per-polygon jitter, because they never overlap;
* lane paint at `ENV_LAYER_Y.markings` (0.09 m); zebra bars at +1.5 mm, stop
  lines at +2.5 mm above lane paint (separate heights avoid z-fighting where
  paint families cross); bridge paint at `markings + BRIDGE_RAISE_M`;
* rails: ballast strip at `ENV_LAYER_Y.railBallast` (0.06 m, hidden under
  asphalt because roads are at 0.07 m; visible on grass/paving), two rail heads
  at `ENV_LAYER_Y.railTrack` (0.099 m), both raised on bridges;
* bridge decks are raised by `BRIDGE_RAISE_M` with vertical skirts;
* legacy tiles (payload 0.1.x) still render through the old `roads` path with
  its jitter; new tiles keep `roads` empty and render rails from `roadNetwork`.

## Renderer lane-marking layout (0.3.0)

`src/city/roads/networkMeshes.ts` derives paint from `width`,
`lanesForward`/`lanesBackward` (fallback `lanes`), `oneway`, `class`,
`material` (asphalt only), `link`/`roundabout`:

* one-way: `lanes − 1` dashed dividers, no centre line; the tagged lane count is
  not clamped down by width (only an absurd-tag guard cap 8 and
  `floor(width/2.2)+1`);
* two-way: asymmetric layout — centre offset `(f−b)/2 × laneWidth`, lane pitch
  `(width−0.6)/(f+b)` clamped [2.6, 3.4] m, dividers only on sides with >1 lane;
  double solid centre from 12.5 m width, else dashed centre from 5.5 m;
* solid 0.15 m edge lines on motorway/trunk/primary/secondary from 7 m width;
* `link` and `service` get **zero** lane paint; `roundabout` keeps edge lines
  only (no centre/divider);
* every paint type is clipped out of junction face polygons and `junction:true`
  surface pieces with chunk-aware clearance `0.5 m + 0.5 × element length`;
  legacy 0.2.0 junctions without a polygon keep the clearance radius; solids are
  emitted as 2 m chunks so they can be clipped;
* zebra bars require all four corners inside an asphalt/stone drivable piece of
  the same bridge flag and are clipped out of junction faces by their span;
  stop lines come from `junction.approachEdges[].stopLine` for one-way
  approaches (authoritative boundary elements) or from crossings otherwise,
  inset 0.4 m from the kerb;
* paint budgets: 8 192 lane-paint triangles/tile, 600 zebra triangles/tile;
  flat surfaces remain one merged road geometry per tile (single draw call).

## Verification

* `pnpm run test:data` — 30 Python unit tests of the lane/width model,
  graph junction faces, asymmetric direction lanes, link suppression,
  material partition, crossings, medians and merged corridors;
* `pnpm test` — 382 Vitest tests, including 47 renderer tests for the marking
  layout, junction-face/surface clipping, approach stop lines and rails;
* `pnpm run qa:road-audit` — independent audit of the generated payload
  (same-layer overlaps = 0 above the 0.35 m² tolerance, tile-seam coverage gap
  = 0.01 m, width spread = 0.0 m, road centrelines inside the drivable surface,
  junction/crossing sanity). Rail and merged-corridor centrelines are excluded
  by design;
* `pnpm run qa:road-paint-audit` — renderer-level paint audit: 0 lane-paint
  triangles inside junction faces, on junction surfaces or within 0.45 m
  outside; lane-line count matches the tagged lanes per piece; rails continuous
  and paint-free;
* `pnpm run data:validate` — coverage report, includes the same-layer overlap
  and width checks;
* `pnpm exec tsx scripts/qa/geometryAudit.ts` — per-tile geometry contract;
* `pnpm run qa:road-shots` — 23 close-up screenshots (canonical junctions, the
  seven user-reported places, and the Ulyanovskaya × Lenina face).

Final pilot payload: 16 tiles, 2 067 surface pieces (incl. 248 `junction: true`
face pieces), 297 network pieces (incl. 6 rail tile pieces from 2 merged tram
centrelines; 25 merged-corridor tile pieces), 288 junction tile records
(274 unique graph junctions, 8 mouth-face fallbacks, 0 invalid rings),
179 crossings, `roads: []`; 2 381 701 B (+8.6 % versus the round-2 payload of
2 193 324 B, +11.5 % versus 0.1.0); 0 same-layer overlaps above the 0.35 m²
rounding tolerance (residual cm² slivers total ~2.7 m² across 231 pairs, max
0.061 m²), 0 seam gaps above 0.01 m. The renderer emits 39 702 lane-paint,
736 zebra and 574 stop/crossing triangles (incl. 209 authoritative approach
stop bars) and 3 168 rail triangles (530 strips); 4 313 paint elements were
clipped by junction faces and 2 by junction surface slivers.
