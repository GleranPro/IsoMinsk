# Data coverage report — central Minsk pilot area

*Generated automatically by `scripts/validation/coverage_report.py` from the actual generated tile payloads.*

## Source

- Source: OpenStreetMap
- Extract: `Minsk.osm.pbf`
- Extraction date: 2026-10-27T13:21:39Z
- Attribution: © OpenStreetMap contributors, ODbL 1.0
- Pilot area: 1600.0 m × 1600.0 m, tile size 512.0 m, projection EPSG:32635
- Local origin (UTM 35N): [536859.254, 5972786.284]

## Buildings

| Metric | Value |
| --- | --- |
| Building footprints rendered | 654 |
| With explicit OSM `height` | 69 (10.6%) |
| With `building:levels` (height derived) | 366 (56.0%) |
| Height inferred by heuristic | 219 (33.5%) |
| With explicit `roof:shape` | 305 (46.6%) |
| Pitched roofs rendered | 447 |
| Buildings using `building:part` volumes | 75 |

### Archetype distribution (heuristic classification)

| Archetype | Buildings |
| --- | --- |
| historic | 177 |
| small | 146 |
| stalin | 117 |
| civic | 95 |
| office | 85 |
| khrushchev | 34 |
| panel | 14 |
| industrial | 3 |

### Roof shape distribution

| Roof shape | Buildings |
| --- | --- |
| gabled | 334 |
| flat | 217 |
| hipped | 108 |
| dome | 9 |
| skillion | 2 |
| pyramidal | 1 |

## Geometry validity

| Check | Count |
| --- | --- |
| Invalid building geometries (repaired or dropped) | 0 |
| Sliver polygons dropped | 120 |
| Buildings left without volumes | 0 |
| Orphan `building:part` polygons (rendered standalone) | 2 |
| Tunnels skipped (not rendered as surface) | 51 |

## Environment

| Metric | Value |
| --- | --- |
| Ground surface polygons | 543 |
| Road/rail/pavement polygons | 3257 |
| OSM-mapped trees | 216 |
| Heuristically placed trees | 3559 |

## External height data

- Used: **no**
- No external height dataset is used. GlobalBuildingAtlas LoD1/height data is licensed non-commercially and was not integrated; OSM height/level tags plus documented architectural heuristics are the only height sources.

## Tiles

| Tile | Buildings | Surfaces | Roads | Trees | Bytes |
| --- | --- | --- | --- | --- | --- |
| -2_-2 | 35 | 48 | 207 | 87 | 81,932 |
| -2_-1 | 61 | 16 | 211 | 63 | 95,579 |
| -2_0 | 77 | 29 | 266 | 33 | 123,185 |
| -2_1 | 8 | 54 | 96 | 87 | 47,870 |
| -1_-2 | 46 | 20 | 170 | 137 | 84,907 |
| -1_-1 | 97 | 43 | 418 | 90 | 163,580 |
| -1_0 | 93 | 113 | 533 | 223 | 254,518 |
| -1_1 | 44 | 52 | 307 | 215 | 121,026 |
| 0_-2 | 23 | 56 | 228 | 328 | 103,879 |
| 0_-1 | 71 | 83 | 396 | 339 | 176,184 |
| 0_0 | 29 | 66 | 327 | 110 | 114,440 |
| 0_1 | 3 | 27 | 143 | 781 | 104,151 |
| 1_-2 | 27 | 11 | 79 | 136 | 46,621 |
| 1_-1 | 19 | 22 | 180 | 489 | 95,280 |
| 1_0 | 9 | 13 | 139 | 498 | 82,897 |
| 1_1 | 12 | 26 | 111 | 159 | 48,465 |

Total payload: **1704 KiB** across 16 tiles (uncompressed JSON).

## Validation result

**PASS** — 0 errors, 0 warning(s)


## Known data limitations

- Building heights are only partially tagged in OSM; inferred heights are estimated from `building:levels` or architectural heuristics and are **not** surveyed measurements.
- Roof shapes are usually inferred from archetype, not tagged in OSM.
- Architectural archetype classification is heuristic (building tags + distance to Independence Avenue), not authoritative.
- Trees marked *heuristic* are procedurally placed inside land-use polygons; they do not represent individually surveyed trees.
- Flat terrain: no DEM is used yet. See docs/DATA_SOURCES.md.
