# Data coverage report — central Minsk pilot area

*Generated automatically by `scripts/validation/coverage_report.py` from the actual generated tile payloads.*

## Source

- Source: OpenStreetMap
- Extract: `Minsk.osm.pbf`
- Extraction date: 2026-10-31T22:48:41Z
- Attribution: (c) OpenStreetMap contributors, ODbL 1.0
- Pilot area: 1600.0 m × 1600.0 m, tile size 512.0 m, projection EPSG:32635
- Local origin (UTM 35N): [536859.254, 5972786.284]

## Buildings

| Metric | Value |
| --- | --- |
| Building footprints rendered | 654 |
| With explicit OSM `height` | 57 (8.7%) |
| With `building:levels` (height derived) | 366 (56.0%) |
| Height inferred by heuristic | 231 (35.3%) |
| With explicit `roof:shape` | 305 (46.6%) |
| Pitched roofs rendered | 445 |
| Buildings using `building:part` volumes | 74 |

### Archetype distribution (heuristic classification)

| Archetype | Buildings |
| --- | --- |
| historic | 197 |
| small | 137 |
| stalin | 97 |
| civic | 88 |
| office | 80 |
| khrushchev | 34 |
| panel | 19 |
| industrial | 3 |
| palace | 1 |
| stadium | 1 |

### Roof shape distribution

| Roof shape | Buildings |
| --- | --- |
| gabled | 330 |
| flat | 211 |
| hipped | 105 |
| dome | 8 |
| skillion | 2 |
| pyramidal | 1 |

## Geometry validity

| Check | Count |
| --- | --- |
| Invalid building geometries (repaired or dropped) | 0 |
| Sliver polygons dropped | 119 |
| Buildings left without volumes | 0 |
| Orphan `building:part` polygons (rendered standalone) | 2 |
| Tunnels skipped (not rendered as surface) | 0 |

## Environment

| Metric | Value |
| --- | --- |
| Ground surface polygons | 484 |
| Legacy road/rail polygons (rails only in legacy tiles) | 0 |
| OSM-mapped trees | 149 |
| Heuristically placed trees | 8420 |

## Road network (payload 0.3.0)

Non-overlapping surface partition + semantic network layer; see `docs/ROAD_NETWORK.md` for the width/material model.

| Metric | Value |
| --- | --- |
| Surface pieces (tile-split) | 2067 |
| — by kind | {'drivable': 1007, 'kerb': 477, 'median': 22, 'paving': 561} |
| — by material | {'(kerb)': 477, '(median)': 22, '(paving)': 561, 'asphalt': 867, 'concrete': 2, 'stone': 138} |
| Network pieces (centrelines) | 297 |
| Junction boxes | 288 |
| Pedestrian crossings | 179 |
| Named streets with a consistent width | 71 / 71 |
| OSM ways processed | 2843 |
| Widths normalized | 4 |
| Material overrides (curated) | 0 |
| Materials (ways) | {'asphalt': 1761, 'stone': 1068, 'concrete': 4, 'unpaved': 10} |

## External height data

- Used: **no**
- No external height dataset is used. GlobalBuildingAtlas LoD1/height data is licensed non-commercially and was not integrated; OSM height/level tags plus documented architectural heuristics are the only height sources.

## Tiles

| Tile | Buildings | Surfaces | Rails | Road surfaces | Network | Junctions | Crossings | Trees | Bytes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| -2_-2 | 35 | 35 | 0 | 92 | 19 | 17 | 13 | 64 | 91,043 |
| -2_-1 | 61 | 15 | 0 | 169 | 16 | 24 | 14 | 80 | 122,912 |
| -2_0 | 77 | 28 | 0 | 107 | 15 | 10 | 7 | 4 | 124,787 |
| -2_1 | 8 | 50 | 0 | 39 | 7 | 6 | 2 | 18 | 49,207 |
| -1_-2 | 46 | 20 | 0 | 123 | 7 | 17 | 12 | 66 | 92,246 |
| -1_-1 | 97 | 37 | 0 | 253 | 45 | 45 | 26 | 14 | 196,982 |
| -1_0 | 93 | 95 | 0 | 288 | 40 | 37 | 26 | 84 | 269,189 |
| -1_1 | 44 | 50 | 0 | 116 | 23 | 18 | 7 | 264 | 141,187 |
| 0_-2 | 23 | 55 | 0 | 145 | 19 | 17 | 16 | 185 | 112,285 |
| 0_-1 | 71 | 77 | 0 | 250 | 28 | 44 | 22 | 605 | 227,830 |
| 0_0 | 29 | 53 | 0 | 166 | 25 | 25 | 16 | 1422 | 238,119 |
| 0_1 | 3 | 26 | 0 | 50 | 13 | 7 | 3 | 2363 | 242,362 |
| 1_-2 | 27 | 10 | 0 | 46 | 6 | 5 | 0 | 137 | 48,580 |
| 1_-1 | 19 | 24 | 0 | 130 | 23 | 10 | 11 | 1010 | 160,676 |
| 1_0 | 9 | 12 | 0 | 43 | 5 | 1 | 2 | 2033 | 207,245 |
| 1_1 | 12 | 25 | 0 | 50 | 6 | 5 | 2 | 220 | 54,216 |

Total payload: **2323 KiB** across 16 tiles (uncompressed JSON).

## Validation result

**PASS** — 0 errors, 0 warning(s)


## Known data limitations

- Building heights are only partially tagged in OSM; inferred heights are estimated from `building:levels` or architectural heuristics and are **not** surveyed measurements.
- Roof shapes are usually inferred from archetype, not tagged in OSM.
- Architectural archetype classification is heuristic (building tags + distance to Independence Avenue), not authoritative.
- Trees marked *heuristic* are procedurally placed inside land-use polygons; they do not represent individually surveyed trees.
- Underground infrastructure is intentionally not drawn: Minsk metro lines (`railway=subway`, 5 ways in the pilot area) and underground roads are skipped, because drawing them as ground surfaces paints black strips across the squares. Surface tram tracks are rendered.
- Flat terrain: no DEM is used yet. See docs/DATA_SOURCES.md.
