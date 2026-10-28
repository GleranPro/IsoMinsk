# Data coverage report — central Minsk pilot area

*Generated automatically by `scripts/validation/coverage_report.py` from the actual generated tile payloads.*

## Source

- Source: OpenStreetMap
- Extract: `Minsk.osm.pbf`
- Extraction date: 2026-10-27T14:27:36Z
- Attribution: © OpenStreetMap contributors, ODbL 1.0
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
| Buildings using `building:part` volumes | 75 |

### Archetype distribution (heuristic classification)

| Archetype | Buildings |
| --- | --- |
| historic | 172 |
| small | 151 |
| stalin | 117 |
| civic | 92 |
| office | 85 |
| khrushchev | 34 |
| panel | 14 |
| industrial | 3 |
| stadium | 2 |
| palace | 1 |

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
| Ground surface polygons | 544 |
| Road/rail/pavement polygons | 3193 |
| OSM-mapped trees | 146 |
| Heuristically placed trees | 6091 |

## External height data

- Used: **no**
- No external height dataset is used. GlobalBuildingAtlas LoD1/height data is licensed non-commercially and was not integrated; OSM height/level tags plus documented architectural heuristics are the only height sources.

## Tiles

| Tile | Buildings | Surfaces | Roads | Trees | Bytes |
| --- | --- | --- | --- | --- | --- |
| -2_-2 | 35 | 48 | 205 | 25 | 75,862 |
| -2_-1 | 61 | 16 | 210 | 80 | 96,894 |
| -2_0 | 77 | 29 | 265 | 1 | 120,222 |
| -2_1 | 8 | 53 | 95 | 17 | 41,398 |
| -1_-2 | 46 | 20 | 169 | 64 | 78,395 |
| -1_-1 | 97 | 43 | 415 | 5 | 155,721 |
| -1_0 | 93 | 111 | 531 | 83 | 241,311 |
| -1_1 | 44 | 51 | 304 | 267 | 123,729 |
| 0_-2 | 23 | 55 | 228 | 188 | 91,651 |
| 0_-1 | 71 | 84 | 394 | 577 | 196,326 |
| 0_0 | 29 | 64 | 298 | 174 | 113,021 |
| 0_1 | 3 | 26 | 106 | 1627 | 167,011 |
| 1_-2 | 27 | 10 | 79 | 131 | 45,990 |
| 1_-1 | 19 | 24 | 178 | 972 | 136,640 |
| 1_0 | 9 | 12 | 130 | 1872 | 197,206 |
| 1_1 | 12 | 25 | 94 | 154 | 44,397 |

Total payload: **1881 KiB** across 16 tiles (uncompressed JSON).

## Validation result

**PASS** — 0 errors, 0 warning(s)


## Known data limitations

- Building heights are only partially tagged in OSM; inferred heights are estimated from `building:levels` or architectural heuristics and are **not** surveyed measurements.
- Roof shapes are usually inferred from archetype, not tagged in OSM.
- Architectural archetype classification is heuristic (building tags + distance to Independence Avenue), not authoritative.
- Trees marked *heuristic* are procedurally placed inside land-use polygons; they do not represent individually surveyed trees.
- Underground infrastructure is intentionally not drawn: Minsk metro lines (`railway=subway`, 5 ways in the pilot area) and underground roads are skipped, because drawing them as ground surfaces paints black strips across the squares. Surface tram tracks are rendered.
- Flat terrain: no DEM is used yet. See docs/DATA_SOURCES.md.
