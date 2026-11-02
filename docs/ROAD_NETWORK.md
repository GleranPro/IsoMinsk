# Road network normalization (payload 0.2.0)

Status: implemented in the offline pipeline and consumed by the renderer. This
document is the contract for the normalized road payload; the geometry code
lives in `scripts/normalize/road_network.py`, the renderer modules in
`src/city/roads/`.

Round 2 (markings pass) additionally introduced: direction-aware width groups,
merged two-way corridor pieces for near-coincident opposite one-way pairs,
median pieces computed before paving, junction corner fillets and tram rails as
network centrelines. The sections below describe the final state.

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

At junctions the geometry is simply the union of the corridors: the asphalt is
continuous, kerbs run along the outer boundary and stop at the junction
"mouths", and pavements fill the corners (a synthetic 3 m pavement ring minus
the drivable surface). No per-polygon height jitter is used for these layers.

Round 2 refinements of this partition:

* **Median slots are computed before paving.** The gap strips between paired
  opposite one-way carriageways are turned into `median` pieces, and paving is
  computed as corridors minus drivable minus the **emitted** median pieces. A
  median fragment that is dropped (too small / clipped by a junction) therefore
  leaves paving in place instead of a hole — this was the beige wedge cutting
  into the asphalt at Bogdanovicha × Yanka Kupala.
* **Paving sliver closing.** A 0.15 m morphological closing of the paving union
  (followed by re-asserting the 2 cm asphalt/median margins) removes
  sub-decimetre splits between narrow sidewalk fragments that grid snapping
  produced.
* **Junction corner fillets.** A closing limited to junction neighbourhoods
  (radius 4.5 m, mitre join, clipped to junction boxes + 6 m) fills the narrow
  unfilled notches that roads meeting at shallow angles leave between their
  buffers. The filled area is claimed as `asphalt` only where no other material
  already covers it, so the partition stays disjoint. This fixes the reported
  "artifact at the crossing" (small wedges + kerb line through the junction
  asphalt).

### 2. Road network (`TileData.roadNetwork`)

Per-way semantic centrelines used to draw markings and crossings, never the
surface polygons:

```ts
interface RoadNetworkPiece {
  kind: 'road' | 'footway' | 'rail';  // round 2: rail centrelines live here
  class: RoadClass;
  width: number;          // normalized carriageway width, metres
  lanes?: number;         // this direction for one-way, total for two-way
  oneway?: boolean;       // oneway=yes/1/-1 or junction=roundabout
  material?: RoadMaterial;
  surface?: string;       // raw OSM value, debug/QA
  bridge?: boolean;
  name?: string;
  /** Round 2: synthetic two-way corridor merging two opposite carriageways.
   *  No `oneway`; `lanes` summed; `width` = whole corridor; renderer paints a
   *  double solid centre line. */
  merged?: boolean;
  centerline: number[];   // flat [x0,y0,...]; overhangs the tile by 4 m
  centerlineOffset: number; // arc length at centerline[0], metres (dash phase)
}
```

Merged corridor pieces (round 2): for every street, opposite one-way ways whose
buffers **overlap** (`inner gap <= 0`) and that run parallel over most of their
length are replaced by one synthetic two-way piece — midline centreline,
`width = separation + (w_a + w_b)/2`, `lanes = lanes_a + lanes_b`, `merged:
true`. Pairs that stay apart (`inner gap > 0`) keep their two one-way pieces and
get a `median` surface strip in the slot. Independence Avenue is 13 merged
corridor pieces (≈24 m, 8 lanes → double solid + three divider rows per side).

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
interface JunctionFeature { x; y; radius; approaches }  // box centre + clearance radius
interface CrossingFeature { x; y; angle; width; span; kind: 'zebra'|'signals'|'unmarked'; roadClass; material?; oneway? }
```

Junction boxes are the union of pairwise buffer intersections of *different
streets* (area ≥ 2 m², min width ≥ 2 m, crossing angle ≥ 20°), clustered and
capped at a 30 m radius. The renderer keeps every paint type out of
`radius + 0.5 m` (dashes additionally by half a dash) and suppresses dashes near
a crossing. Crossings are OSM `highway=crossing` / `highway=traffic_signals`
nodes projected onto the **widest drivable carriageway whose asphalt actually
contains the node** (within `width/2 + 1 m`, ≤ 22 m), deduplicated (≤ 18 m on
one street, ≤ 8 m otherwise, same direction) and sorted by OSM id
(determinism). Round 2 changed the matching from "nearest centreline / highest
class" to "widest containing carriageway": a crossing of a 9.6 m avenue no
longer snaps to a 4 m slip link that happens to be classed higher. A signalised
pedestrian crossing (`crossing=traffic_signals` on a crossing node) is emitted
as `zebra` — it gets zebra bars *and* stop lines; a bare
`highway=traffic_signals` signal head is emitted as `signals` (stop line only).
The pilot yields 180 crossings (80 zebra, 88 signal heads, 12 unmarked) from
279 mapped nodes.

## Width model

* explicit `width` tag → carriageway width (clamped 4–40 m for roads, 0.5–10 m
  for paths);
* otherwise `lanes × 3.0 m + 0.6 m` shoulders (for a one-way way `lanes`
  describes that direction; for a two-way way it is the total lane count);
* otherwise a class default. The **one-way default is roughly half of the
  two-way class default** (primary 9.5 vs 18 m etc.) — the old `max()` floor is
  gone;
* named streets are grouped by `name`/`name:ru`/`name:be` **and direction**
  (one-way vs two-way) and all segments of a group get the
  **length-weighted median** width of the group (this removes steps at OSM way
  joins, and prevents a 1-lane one-way section being widened by a 4-lane
  two-way section of the same street — the user saw that on Engels Street);

Pilot result: 70 vehicle ways got a width independent of `lanes` corrected;
43 named street+direction groups have a 0.0 m width spread. Merged corridor
pieces are excluded from that invariant (they are legitimately wider than a
carriageway; see below).

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

## Renderer lane-marking layout (round 2)

`src/city/roads/networkMeshes.ts` derives paint from `width`, `lanes`,
`oneway`, `class`, `material` (asphalt only):

* two-way at least 12.5 m: **double solid centre** (2 × 0.15 m at ±0.25 m);
  otherwise a 3 m / 7 m dashed centre line (0.5 m wide) from 5.5 m width;
* lane dividers are dashed 2 m / 6 m / 0.15 m, `laneCount` taken from the
  `lanes` tag when present (clamped to a 2.4 m minimum pitch), else from width;
* solid 0.15 m edge lines on motorway/trunk/primary/secondary from 7 m width;
* every paint type is clipped out of junction boxes and (for dashes) crossings;
  solids are emitted as 2 m chunks so they can be clipped;
* zebra bars and stop lines require all four corners inside an asphalt/stone
  drivable piece of the same bridge flag; stop lines are additionally dropped
  when centred inside a junction radius (+0.5 m), and inset 0.4 m from the
  carriageway edge so their corners are not exactly on the polygon boundary;
* paint budgets: 8 192 lane-paint triangles/tile (measured max demand 7 868),
  600 zebra triangles/tile. Flat surfaces remain one merged road geometry per
  tile (single draw call).

## Verification

* `pnpm run test:data` — 27 Python unit tests of the width (incl. direction
  groups)/material/partition/junction/crossing (incl. widest-carriageway
  matching)/median/merged-corridor rules;
* `pnpm test` — 364 Vitest tests, including 30 renderer tests for the marking
  layout, crossing containment and rails;
* `pnpm run qa:road-audit` — independent audit of the generated payload
  (same-layer overlaps = 0, tile-seam coverage gap = 0.0 m, width spread =
  0.0 m, road centrelines inside the drivable surface, junction/crossing
  sanity). Rail and merged-corridor centrelines are excluded from the
  inside-asphalt check by design;
* `pnpm run data:validate` — coverage report, includes the same-layer overlap
  and width checks;
* `pnpm exec tsx scripts/qa/geometryAudit.ts` — per-tile geometry contract;
* `pnpm run qa:road-shots` — 20 close-up screenshots (16 deterministic
  junctions + the seven user-reported places).

Final pilot payload: 16 tiles, 1 321 surface pieces (incl. 20 median tile
pieces), 1 055 network pieces (incl. 6 rail tile pieces from 2 merged tram
centrelines; 25 merged-corridor tile pieces), 519 junction boxes, 180 crossings,
`roads: []`; 2 142 KiB (+1.3 % versus the 0.1.0 payload of 2 115 KiB);
0 same-layer overlaps (was 73 994 m² of stacked road surface); 0 seam gaps.
Junction fillets claim 2 443 m² of asphalt in 108 small pieces. The renderer
emits 47 256 lane-paint triangles (8 423 dashes, 15 040 solid chunks, 543 zebra
bars, 165 stop lines) and 3 168 rail triangles (530 strips); 51 crossing
elements and 68 stop lines were dropped by containment/junction rules.
