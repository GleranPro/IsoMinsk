# Data coverage report — central Minsk pilot area

*Generated automatically by `scripts/validation/coverage_report.py` from the actual generated tile payloads.*

## Source

- Source: OpenStreetMap
- Extract: `Minsk.osm.pbf`
- Extraction date: 2026-10-29T13:16:35Z
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
| Pitched roofs rendered | 447 |
| Buildings using `building:part` volumes | 74 |

### Archetype distribution (heuristic classification)

| Archetype | Buildings |
| --- | --- |
| historic | 169 |
| small | 149 |
| stalin | 117 |
| civic | 88 |
| office | 81 |
| khrushchev | 34 |
| panel | 14 |
| industrial | 3 |
| palace | 1 |
| stadium | 1 |

### Roof shape distribution

| Roof shape | Buildings |
| --- | --- |
| gabled | 332 |
| flat | 209 |
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
| Tunnels skipped (not rendered as surface) | 51 |

## Environment

| Metric | Value |
| --- | --- |
| Ground surface polygons | 599 |
| Road/rail/pavement polygons | 3053 |
| OSM-mapped trees | 150 |
| Heuristically placed trees | 8410 |

## External height data

- Used: **no**
- No external height dataset is used. GlobalBuildingAtlas LoD1/height data is licensed non-commercially and was not integrated; OSM height/level tags plus documented architectural heuristics are the only height sources.

## Road detail (v0.2 additive payload)

| Metric | Value |
| --- | --- |
| Road pieces with OSM centreline | 1026 |
| Crossings projected onto drivable roads | 212 |
| Parking surface polygons (amenity=parking) | 132 |

### Crossings by kind

| Kind | Count |
| --- | --- |
| zebra | 59 |
| signals | 138 |
| unmarked | 15 |

## Tiles

| Tile | Buildings | Surfaces | Parking | Roads | Centrelines | Crossings | Trees | Bytes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| -2_-2 | 35 | 39 | 4 | 191 | 65 | 16 | 69 | 84,794 |
| -2_-1 | 61 | 20 | 5 | 202 | 74 | 18 | 80 | 105,090 |
| -2_0 | 77 | 35 | 7 | 257 | 77 | 9 | 2 | 129,192 |
| -2_1 | 8 | 53 | 3 | 95 | 22 | 4 | 19 | 44,625 |
| -1_-2 | 46 | 30 | 10 | 164 | 61 | 12 | 64 | 83,659 |
| -1_-1 | 97 | 54 | 17 | 378 | 165 | 29 | 9 | 168,620 |
| -1_0 | 93 | 116 | 21 | 503 | 106 | 30 | 83 | 250,622 |
| -1_1 | 44 | 57 | 7 | 294 | 40 | 8 | 262 | 127,098 |
| 0_-2 | 23 | 68 | 13 | 207 | 65 | 18 | 174 | 95,525 |
| 0_-1 | 71 | 88 | 11 | 358 | 132 | 25 | 603 | 205,447 |
| 0_0 | 29 | 61 | 8 | 293 | 76 | 19 | 1421 | 228,680 |
| 0_1 | 3 | 26 | 0 | 125 | 19 | 5 | 2366 | 239,000 |
| 1_-2 | 27 | 19 | 9 | 77 | 33 | 0 | 149 | 50,897 |
| 1_-1 | 19 | 30 | 6 | 156 | 42 | 14 | 997 | 140,643 |
| 1_0 | 9 | 13 | 1 | 132 | 25 | 2 | 2040 | 215,055 |
| 1_1 | 12 | 35 | 10 | 106 | 24 | 3 | 222 | 55,972 |

Total tile payload: **2,224,919 bytes** (2173 KiB) across 16 tiles (uncompressed JSON); with the tile manifest: **2,227,704 bytes**.

## Validation result

**PASS** — 0 errors, 0 warning(s)


## Known data limitations

- Building heights are only partially tagged in OSM; inferred heights are estimated from `building:levels` or architectural heuristics and are **not** surveyed measurements.
- Roof shapes are usually inferred from archetype, not tagged in OSM.
- Architectural archetype classification is heuristic (building tags + distance to Independence Avenue), not authoritative.
- Trees marked *heuristic* are procedurally placed inside land-use polygons; they do not represent individually surveyed trees.
- Underground infrastructure is intentionally not drawn: Minsk metro lines (`railway=subway`, 5 ways in the pilot area) and underground roads are skipped, because drawing them as ground surfaces paints black strips across the squares. Surface tram tracks are rendered.
- Flat terrain: no DEM is used yet. See docs/DATA_SOURCES.md.
