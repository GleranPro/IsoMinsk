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
| Legacy road/rail polygons (rails only in 0.2.0) | 0 |
| OSM-mapped trees | 149 |
| Heuristically placed trees | 8410 |

## Road network (payload 0.2.0)

Non-overlapping surface partition + semantic network layer; see `docs/ROAD_NETWORK.md` for the width/material model.

| Metric | Value |
| --- | --- |
| Surface pieces (tile-split) | 1321 |
| — by kind | {'drivable': 295, 'kerb': 454, 'median': 20, 'paving': 552} |
| — by material | {'(kerb)': 454, '(median)': 20, '(paving)': 552, 'asphalt': 183, 'concrete': 2, 'stone': 110} |
| Network pieces (centrelines) | 1055 |
| Junction boxes | 519 |
| Pedestrian crossings | 180 |
| Named streets with a consistent width | 43 / 43 |
| OSM ways processed | 2843 |
| Widths normalized | 70 |
| Material overrides (curated) | 0 |
| Materials (ways) | {'asphalt': 1761, 'stone': 1068, 'concrete': 4, 'unpaved': 10} |

## External height data

- Used: **no**
- No external height dataset is used. GlobalBuildingAtlas LoD1/height data is licensed non-commercially and was not integrated; OSM height/level tags plus documented architectural heuristics are the only height sources.

## Tiles

| Tile | Buildings | Surfaces | Rails | Road surfaces | Network | Junctions | Crossings | Trees | Bytes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| -2_-2 | 35 | 35 | 0 | 64 | 61 | 24 | 14 | 67 | 79,552 |
| -2_-1 | 61 | 15 | 0 | 104 | 74 | 44 | 13 | 80 | 108,370 |
| -2_0 | 77 | 28 | 0 | 103 | 82 | 36 | 7 | 3 | 129,921 |
| -2_1 | 8 | 50 | 0 | 35 | 22 | 11 | 2 | 18 | 47,108 |
| -1_-2 | 46 | 20 | 0 | 76 | 64 | 39 | 12 | 62 | 84,817 |
| -1_-1 | 97 | 37 | 0 | 148 | 166 | 78 | 26 | 12 | 165,664 |
| -1_0 | 93 | 95 | 0 | 173 | 112 | 56 | 27 | 84 | 240,499 |
| -1_1 | 44 | 50 | 0 | 68 | 42 | 15 | 7 | 264 | 115,029 |
| 0_-2 | 23 | 55 | 0 | 79 | 71 | 37 | 16 | 187 | 98,603 |
| 0_-1 | 71 | 77 | 0 | 145 | 137 | 66 | 22 | 595 | 205,524 |
| 0_0 | 29 | 53 | 0 | 104 | 74 | 43 | 16 | 1408 | 219,579 |
| 0_1 | 3 | 26 | 0 | 29 | 20 | 1 | 3 | 2373 | 233,836 |
| 1_-2 | 27 | 10 | 0 | 31 | 36 | 30 | 0 | 135 | 51,331 |
| 1_-1 | 19 | 24 | 0 | 89 | 47 | 18 | 11 | 1016 | 152,197 |
| 1_0 | 9 | 12 | 0 | 38 | 24 | 11 | 2 | 2033 | 209,676 |
| 1_1 | 12 | 25 | 0 | 35 | 23 | 10 | 2 | 222 | 51,618 |

Total payload: **2142 KiB** across 16 tiles (uncompressed JSON).

## Validation result

**PASS** — 0 errors, 0 warning(s)


## Known data limitations

- Building heights are only partially tagged in OSM; inferred heights are estimated from `building:levels` or architectural heuristics and are **not** surveyed measurements.
- Roof shapes are usually inferred from archetype, not tagged in OSM.
- Architectural archetype classification is heuristic (building tags + distance to Independence Avenue), not authoritative.
- Trees marked *heuristic* are procedurally placed inside land-use polygons; they do not represent individually surveyed trees.
- Underground infrastructure is intentionally not drawn: Minsk metro lines (`railway=subway`, 5 ways in the pilot area) and underground roads are skipped, because drawing them as ground surfaces paints black strips across the squares. Surface tram tracks are rendered.
- Flat terrain: no DEM is used yet. See docs/DATA_SOURCES.md.
