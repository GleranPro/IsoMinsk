# Data sources & licensing — Isometric Minsk

_Research snapshot verified 2026-10-27. Scope: pilot area around October Square, Minsk (53.9022 N, 27.5610 E), EPSG:32635, 512 m tiles. Companion: [ART_REFERENCE.md](ART_REFERENCE.md)._

## 1. What this project actually uses

Pipeline: `data/raw/Minsk.osm.pbf` (BBBike city extract, primary) → `scripts/ingest/extract.py` (pyosmium) → normalize → `public/data/tiles/*.json` + `manifest.json` → three.js renderer. The Geofabrik Belarus country extract (`data/raw/belarus-latest.osm.pbf`) is the documented fallback (`npm run data:download -- -Full`) for areas outside the city extract.

- **Only data source today: OpenStreetMap** (BBBike Minsk extract; Geofabrik Belarus as fallback). No DEM, no orthophoto, no external footprint or height dataset.
- Geometry: building footprints + `building:part`, roads/rails/waterways, landuse/parks/water, mapped trees.
- Heights: `height` → `building:levels` × 3 m → archetype heuristic → default; provenance is kept per volume (`HeightSource` in `src/shared/types.ts`).
- Roofs: `roof:shape` when tagged, otherwise flat. OSM carries footprints plus tags, **not LoD2 roof meshes**; roof height/direction are inferred when the tags are absent.
- Attribution UI: `src/app/AttributionPanel.tsx`, fed by `manifest.attribution[]`.

## 2. Dataset matrix

| Dataset | Provider / URL | Coverage for Minsk | Version / date | Licence | Attribution requirement | Quality & limitations | Status |
|---|---|---|---|---|---|---|---|
| OpenStreetMap (BBBike Minsk city extract) | [download.bbbike.org/osm/bbbike/Minsk/](https://download.bbbike.org/osm/bbbike/Minsk/) | Full city (~18 × 18 km around Minsk) | Extract dated 2026-10-24, 35 MB, rebuilt weekly | **ODbL 1.0** | "© OpenStreetMap contributors" + ODbL link, visible | Heights and `roof:shape` coverage measured by our pipeline (see docs/COVERAGE_REPORT.md); no LoD2 meshes | **USED (primary)** |
| OpenStreetMap (Geofabrik Belarus) | [download.geofabrik.de/europe/belarus.html](https://download.geofabrik.de/europe/belarus.html) | Full country; best streets/landuse/buildings | Extract to `2026-10-26T00:32:07Z`, 351 MB, daily refresh | **ODbL 1.0** | "© OpenStreetMap contributors" + ODbL link, visible | Same tagging quality; larger download, slower extraction (≈40 s vs ≈4 s per pass over 35 MB) | **USED (fallback)** |
| Overture Maps — buildings | [docs.overturemaps.org/getting-data](https://docs.overturemaps.org/getting-data/); `s3://overturemaps-us-west-2/release/2026-10-21.0/theme=buildings/type=building/*` | Global; z12 MVT tile over central Minsk verified (~330 KB, layer `buildings`) | Release **2026-10-21.0** (latest), schema v2.0.0 | **ODbL 1.0** (theme, not CDLA) | "© OpenStreetMap contributors, Overture Maps Foundation" + per-source notices | `height`/`roof_shape` often null; mixed provenance; Minsk counts unmeasured | OPTIONAL |
| Microsoft Global ML Building Footprints | [github.com/microsoft/GlobalMLBuildingFootprints](https://github.com/microsoft/GlobalMLBuildingFootprints) | Belarus present (`RegionName=Belarus` tiles) | 2026-08-13 refresh; 1.4 B footprints, 30,340 tiles, 225 regions | **CDLA-Permissive 2.0** | None for results; ship licence text if Data is redistributed | **No height estimates at Minsk**; ML footprints, Europe IoU 65.1%, FP ~1.4% | OPTIONAL |
| Google Open Buildings | [sites.research.google/gr/open-buildings](https://sites.research.google/gr/open-buildings/) | **None** — Africa, South/SE Asia, Latin America, Caribbean only | v3 (May 2023 imagery) | CC BY 4.0 **or** ODbL 1.0 | n/a | No Belarus in country list → unusable | **BLOCKED (coverage)** |
| GlobalBuildingAtlas | [github.com/zhu-xlab/GlobalBuildingAtlas](https://github.com/zhu-xlab/GlobalBuildingAtlas); [mediaTUM](https://mediatum.ub.tum.de/1782307) | Global claim; Belarus not sampled | v1 2025, generated to 2025-04-30 | **CC BY-NC 4.0** (`GBA.Polygon`, `.LoD1`, `.Height`); ODbL for `.ODbLPolygon` | Citation + licence link + indicate changes | 3 m × 3 m height raster, LoD1; RMSE 1.5–8.9 m; **non-commercial** | **BLOCKED (licence)** |
| Copernicus DEM GLO-30 | [dataspace.copernicus.eu COP-DEM](https://dataspace.copernicus.eu/explore-data/data-collections/copernicus-contributing-missions/collections-description/COP-DEM); [GEE mirror](https://developers.google.com/earth-engine/datasets/catalog/COPERNICUS_DEM_GLO30_2024_1) | Worldwide; Minsk 53.9 N covered | GLO-30 `2024_1` | Free worldwide Copernicus/WorldDEM-30 licence | Exact DLR/Airbus notice (below) | DSM (includes buildings/vegetation), 30 m, EGM2008 — **not bare earth** | OPTIONAL |
| SRTM 1 arc-second | [USGS EROS SRTM](https://www.usgs.gov/centers/eros/science/usgs-eros-archive-digital-elevation-shuttle-radar-topography-mission-srtm-1) | 60° N–56° S; Minsk covered | Mission 2000; 1 arc-sec product | Public domain (US Gov) | None; credit USGS/NASA | Above 50° N sampled **2 arc-sec N–S × 1 arc-sec E–W** (~60 × 30 m); 2000 vintage, noisy in city | OPTIONAL |
| OSM Simple 3D Buildings | [wiki.openstreetmap.org/wiki/Simple_3D_Buildings](https://wiki.openstreetmap.org/wiki/Simple_3D_Buildings) | Tagging scheme (not a dataset) | Wiki rev. 3106809 | Wiki text CC BY-SA 2.0 | n/a | Defines the tags we already parse | **USED (tags)** |

## 3. Checks performed (not assumed)

- Geofabrik page (`belarus-latest.osm.pbf`, <https://download.geofabrik.de/europe/belarus-latest.osm.pbf>), 2026-10-27: "contains all OSM data up to 2026-10-25T21:21:21Z", 334 MB; footer licence "ODbL 1.0". The PBF omits user names/IDs and changeset IDs (GDPR); full-metadata extracts are OSM-contributor-only.
- Overture STAC `latest` = `2026-10-21.0`. A byte-range read of `https://tiles.overturemaps.org/2026-10-21.0/buildings.pmtiles` returned a z12 tile over central Minsk (~330 KB gzip) whose first MVT layer is `buildings` → coverage confirmed.
- Overture buildings theme licence is **ODbL, not CDLA**; the attribution page lists OSM, Esri (CC BY 4.0), Microsoft (ODbL), Google (CC BY 4.0), USGS 3DEP, CLSM (CC BY 4.0), IGN/BTN (CC BY 4.0).
- Microsoft `dataset-links.csv` (2026-08-13, 6.4 MB) contains `RegionName=Belarus` tiles → footprints exist.
- Microsoft `buildings-with-height-coverage.geojson` (66,510 quads): **no quad contains the Minsk point** → no height estimates for Minsk (`height = -1`).
- Google Open Buildings v3 country list contains no Belarus.
- GBA terms: "**You may not use the material for commercial purposes.**" GBA.Polygon fuses ODbL and NC sources; the README itself warns that combining parts "may create license implications".

## 4. Licence conclusions

**Usable now:** OSM (ODbL), Microsoft footprints (CDLA-Permissive 2.0), Overture buildings (ODbL), Copernicus GLO-30 (free, attribution), SRTM (public domain).

**Blocked:** Google Open Buildings (no coverage); GlobalBuildingAtlas `GBA.Polygon`/`GBA.LoD1`/`GBA.Height` (CC BY-NC 4.0, and incompatible with our ODbL tiles).

**Conditional:** `GBA.ODbLPolygon` is ODbL and technically usable, but it only contains OSM + Microsoft footprints — no roof shapes, no gain for us.

**Never mix NC into the tiles.** A CC BY-NC layer inside an ODbL derivative database cannot be redistributed under ODbL; the whole tile set inherits the conflict. If the project ever becomes commercial, drop NC entirely; OSM/Microsoft/Overture/Copernicus stay valid.

## 5. ODbL obligations that apply to derived tiles

| Artefact | ODbL category | Obligation |
|---|---|---|
| `public/data/tiles/*.json` (extracted geometry + tags) | **Derivative Database** | If publicly conveyed: license it under ODbL 1.0, include the licence URI, keep notices (4.2), share-alike (4.4), no TPM restrictions |
| Rendered frames / screenshots | **Produced Work** | Notice under 4.3 only; no share-alike on the image |
| Interactive map UI | Produced Work (display) | Visible attribution + clear ODbL statement |

Practical rules:

1. Put "© OpenStreetMap contributors" **on the map**, not only inside a collapsed `<details>` panel.
2. Link to <https://www.openstreetmap.org/copyright> and name ODbL 1.0.
3. Tiles fetched by the browser are conveyed: publish them under ODbL (a NOTICE + licence link next to `/data`).
4. Do not add DRM that restricts the data (ODbL "Open" condition).
5. Do not imply OSMF or Geofabrik endorses the project.
6. Keep `manifest.attribution[]` truthful for every source actually merged.

ODbL 4.3 example notice (verbatim from the licence): `Contains information from DATABASE NAME, which is made available here under the Open Database License (ODbL).`

## 6. Attribution text blocks

```ts
// manifest.attribution[] / AttributionPanel fallback
export const REQUIRED_ATTRIBUTION: AttributionEntry[] = [
  {
    name: 'OpenStreetMap',
    url: 'https://www.openstreetmap.org/copyright',
    licence: 'ODbL 1.0',
    note: '© OpenStreetMap contributors. Map data available under the Open Database License.',
  },
];
```

Visible HUD line: `© OpenStreetMap contributors · ODbL 1.0`

Optional add-ons (only for sources actually used):

```text
Buildings: © Microsoft, CDLA-Permissive 2.0
Buildings: © OpenStreetMap contributors, Overture Maps Foundation — ODbL 1.0
Terrain: © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved.
Terrain (modified): produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved.
Liability: The organisations in charge of the Copernicus programme by law or by delegation do not incur any liability for any use of the Copernicus WorldDEM-30.
Buildings/height: GlobalBuildingAtlas © Zhu et al. (2025), CC BY-NC 4.0 — non-commercial use only.
```

## 7. Curated landmark corrections (manual review)

The pipeline is procedural end-to-end, but four landmarks needed hand review
before the geometry could be rendered truthfully: the Minsk Gate, the National
Library, the Victory Square obelisk and the Red Church. Every override lives in
`scripts/normalize/normalize.py` (`LANDMARK_OVERRIDES`,
`CURATED_DUPLICATE_IDS`) and is echoed into `data/processed/coverage_city.json`
under `curation`, so the curation is auditable rather than silent.

| OSM feature | Problem found | Correction |
| --- | --- | --- |
| `relation/9383682` «Вароты Мінска» | Malformed multipolygon: four member rings (two 7-storey tower blocks and their 11-storey `building:part` tiers) flattened into one invalid polygon with two outer rings; no `height`/`building:levels` tags | Curated `landmark = "minsk-gate"` + `archetype = "stalin"`. The volumes (two 24.5 m base blocks, two 38.5 m tower tiers) still come from the OSM `building:part` polygons; only the metadata is overridden. The renderer adds the flat parapet, clock/emblem medallions and corner turrets (`src/city/buildings/cityGate.ts`) |
| `way/602639195` | `building=residential` with `height=0.01`; its single ring traces the gate tower + Bobruiskaya 15 + Ulyanovskaya 34 at once | Aggregate record skipped. Those three buildings are mapped separately and were previously being deleted by the duplicate detector — now they render |
| `way/602639199` | Same defect pattern; one ring traces the other gate tower + Bobruiskaya 13 + Leningradskaya 7 | Aggregate record skipped; the separately mapped buildings render |
| `way/25319604` Нацыянальная бібліятэка Беларусі | The stylobate is one 89-point footprint and the rhombicuboctahedron shell is split into many `building:part` polygons (some with unusable heights); no single volume describes the real massing | Curated `landmark = "national-library"`, `height = 71.6 m`. The renderer rebuilds the terraced podium from the curated `outline` (the untrimmed OSM footprint, now emitted for landmarks) and generates the true rhombicuboctahedron (edge 24.67 m, 11.0–70.7 m) — `src/city/buildings/nationalLibrary.ts` |
| `way/346312699` Манумент Победы | The obelisk is mapped as a 16×16 m "building" with a bogus `height=4` plus pedestal/pyramidion parts; the real monument is ~38 m tall | Curated `landmark = "victory-obelisk"`, `height = 38.2 m`; geometry rebuilt from the footprint and the OSM part heights (`src/city/buildings/victoryObelisk.ts`) |
| `way/100418249` Касцёл Св. Сымона і Св. Алены | Detailed `building:part`s (nave 25 m gabled, towers to 50 m) but no way to render the brick neo-gothic massing, twin spires and crosses | Curated `landmark = "red-church"`, `height = 50.0 m`; geometry rebuilt from the outline + tower part positions (`src/city/buildings/redChurch.ts`) |

Curated landmarks also receive an extra `outline` field (the untrimmed original
OSM footprint), because the generic per-tile de-overlap cuts the base footprint
into pieces around `building:part` volumes. The renderer replaces the whole
generic extrusion for these features (`src/city/buildings/landmarks.ts`
registry); non-landmark buildings are untouched.

Related general fixes made in the same revisions:

- Explicit `height` values below `MIN_PLAUSIBLE_HEIGHT_M = 2.5 m` are treated as
  missing data (a door is taller than 1 m). This removes the `height=0.01`
  typo class from the render instead of producing 7 m blocks.
- The duplicate detector keeps its coarse 2 m / 20 m² signature but now verifies
  every collision against the actual footprint area (≤ 15 % difference) and
  centroid (≤ 3 m) before dropping a record, and it never drops a curated
  landmark. `geometry.duplicatesDropped` / `geometry.nearMissCollisionsKeptApart`
  report both outcomes (city belt: 3 dropped, 0 false collisions).

Reference for the landmark appearance: the Wikimedia Commons photo of
Privokzalnaya Square (flat-topped pylon towers, one 3.5 m clock on one tower, a
round BSSR emblem medallion on the other; no spires). No new data source was
introduced — the corrections are metadata overrides of ODbL data.

## 8. Gaps and UNVERIFIED items

- **Local PBF snapshot date — UNVERIFIED.** File is 351,118,849 B vs 334 MB current; no download timestamp/hash recorded.
- **Overture Minsk feature count / height completeness — UNVERIFIED.** Only tile presence was checked. Inspect `sources[].dataset` on extracted features to see whether they are OSM-derived.
- **GBA coverage for Belarus — UNVERIFIED.** Docs claim global coverage; no Belarus sample taken.
- **Microsoft footprint quality in Minsk — UNVERIFIED.** Only global/Europe metrics published; no local validation.
- National Belarus LoD2/orthophoto sources were **not investigated** in this pass (no open equivalent to Poland's GUGiK identified).
- Commercial status: treated as a non-commercial prototype per the project brief. Any monetisation invalidates the CC BY-NC row.
