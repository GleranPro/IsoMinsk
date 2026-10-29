# Data coverage report — central Minsk pilot area

*Generated automatically by `scripts/validation/coverage_report.py` from the actual generated tile payloads.*

## Source

- Source: OpenStreetMap
- Extract: `Minsk.osm.pbf`
- Extraction date: 2026-10-28T15:47:51Z
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
| Ground surface polygons | 484 |
| Road/rail/pavement polygons | 3243 |
| OSM-mapped trees | 150 |
| Heuristically placed trees | 8380 |

## External height data

- Used: **no**
- No external height dataset is used. GlobalBuildingAtlas LoD1/height data is licensed non-commercially and was not integrated; OSM height/level tags plus documented architectural heuristics are the only height sources.

## Tiles

| Tile | Buildings | Surfaces | Roads | Trees | Bytes |
| --- | --- | --- | --- | --- | --- |
| -2_-2 | 35 | 35 | 205 | 66 | 78,551 |
| -2_-1 | 61 | 15 | 210 | 80 | 96,788 |
| -2_0 | 77 | 28 | 265 | 1 | 120,994 |
| -2_1 | 8 | 50 | 95 | 17 | 41,478 |
| -1_-2 | 46 | 20 | 169 | 64 | 78,065 |
| -1_-1 | 97 | 37 | 415 | 4 | 155,519 |
| -1_0 | 93 | 95 | 531 | 83 | 240,235 |
| -1_1 | 44 | 50 | 307 | 267 | 124,086 |
| 0_-2 | 23 | 55 | 228 | 179 | 90,752 |
| 0_-1 | 71 | 77 | 394 | 605 | 198,209 |
| 0_0 | 29 | 53 | 320 | 1427 | 224,535 |
| 0_1 | 3 | 26 | 142 | 2359 | 238,158 |
| 1_-2 | 27 | 10 | 79 | 143 | 47,031 |
| 1_-1 | 19 | 24 | 178 | 972 | 136,827 |
| 1_0 | 9 | 12 | 133 | 2040 | 212,357 |
| 1_1 | 12 | 25 | 106 | 223 | 52,731 |

Total payload: **2086 KiB** across 16 tiles (uncompressed JSON).

## Validation result

**PASS** — 0 errors, 0 warning(s)


## Known data limitations

- Building heights are only partially tagged in OSM; inferred heights are estimated from `building:levels` or architectural heuristics and are **not** surveyed measurements.
- Roof shapes are usually inferred from archetype, not tagged in OSM.
- Architectural archetype classification is heuristic (building tags + distance to Independence Avenue), not authoritative.
- Trees marked *heuristic* are procedurally placed inside land-use polygons; they do not represent individually surveyed trees.
- Underground infrastructure is intentionally not drawn: Minsk metro lines (`railway=subway`, 5 ways in the pilot area) and underground roads are skipped, because drawing them as ground surfaces paints black strips across the squares. Surface tram tracks are rendered.
- Flat terrain: no DEM is used yet. See docs/DATA_SOURCES.md.
