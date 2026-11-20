# Attribution and licensing — Isometric Minsk complete city

This artifact publishes **one** dataset: the complete-city tile database in
`data/city-tiles/`, together with the curated Lipki aviation-museum payload in
`data/museum/`, the public-transport payloads in `data/mobility-city/`
(complete city) and `data/mobility/` (two demo corridors), and the static
application.

The GitHub Pages URL is provisioned by the repository owner. No repository
owner/name, domain or source-code licence is assumed or invented in this file.

## 1. OpenStreetMap tile database — ODbL 1.0

Contains information from **OpenStreetMap**, which is made available here under
the [Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/1-0/).

* © OpenStreetMap contributors — <https://www.openstreetmap.org/copyright>
* Database: `data/city-tiles/` (`manifest.json` plus one JSON payload per
  1024 m tile), a **derivative database** of the OpenStreetMap extract.
* Name of the database: *Isometric Minsk complete-city tile database*.
* Licence: **ODbL 1.0**. Full licence text: `data/LICENSE-ODbL.txt`.
* Database contents: Database Contents License (DbCL) 1.0 —
  <https://opendatacommons.org/licenses/dbcl/1-0/>.
* Source extract: BBBike Minsk city extract
  (<https://download.bbbike.org/osm/bbbike/Minsk/>), dated 2026-10-24;
  Geofabrik Belarus (`<https://download.geofabrik.de/europe/belarus.html>`,
  ODbL 1.0) is the documented fallback.
* Modifications: projection to a local metric frame (UTM zone 35N,
  EPSG:32635), 1024 m tiling, de-overlap of building volumes, inferred or
  curated heights and roof shapes, procedural facade and road-surface
  derivation, and tree placement. Heights, roof profiles and some trees are
  inferred, not surveyed — see `docs/LIMITATIONS.md` in the source repository.
* The adapted database itself is offered under ODbL 1.0 at exactly the URL of
  this artifact's `data/city-tiles/` directory, free of charge.
* Visible attribution: the application always shows
  “© OpenStreetMap contributors · ODbL 1.0” in the HUD, with a link to
  <https://www.openstreetmap.org/copyright>.

No noncommercial source (for example GlobalBuildingAtlas `CC BY-NC 4.0`) is
mixed into this tile database.

## 2. Lipki aviation museum — curated 3D models

The `data/museum/exhibits.bin` payload is baked from models downloaded for the
exhibition. Each model was **decimated** (usually to ~2 500 triangles) and
**baked to vertex colours**; no texture image files are redistributed in this
artifact. Every exhibit below is present in the shipped payload and has a
recorded upstream licence, author and source. The machine-readable inventory is
`asset-licenses.json`; the original download records are
`assets/aviation-museum/MODELS.json` and per-model
`assets/aviation-museum/raw/<slug>/ATTRIBUTION.txt` in the source repository.

| Exhibit (slug) | Aircraft | Author | Upstream licence | Source |
| --- | --- | --- | --- | --- |
| an-2 | Ан-2 | Mehozavr | CC0 | <https://opengameart.org/content/an-2-airplane-lowpoly> |
| an-26 | Ан-26ЛЛ | 42manako | CC Attribution | <https://sketchfab.com/3d-models/df3d6b1359144a459d170abef262211d> |
| il-18 | Ил-18В | manilov.ap | CC Attribution | <https://sketchfab.com/3d-models/8293d12da39d4b6a94d892f7c0dd288c> |
| l-29 | Л-29 | UraTera | CC Attribution | <https://sketchfab.com/3d-models/d0a2ac6316514d2fb6328076e1d7a98b> |
| mig-15 | МиГ-15УТИ | govindu94 | CC Attribution | <https://sketchfab.com/3d-models/66d424d54ea64054aa37f15aa17df45c> |
| mig-17 | МиГ-17 | manilov.ap | CC Attribution | <https://sketchfab.com/3d-models/672ef502523b4cbe9aced1e4252c0cca> |
| mig-19 | МиГ-19С | KROTOS | CC Attribution | <https://sketchfab.com/3d-models/056bde58c01345c59793aaac7e1764bc> |
| mig-21 | МиГ-21бис | 42manako | CC Attribution | <https://sketchfab.com/3d-models/dfa91ea83d484fd2b8d52034b582cc00> |
| mig-23 | МиГ-23УБ | citizensnip | CC Attribution | <https://sketchfab.com/3d-models/dd4e5995803b4ba28929323f20a18b3d> |
| mig-25 | МиГ-25ПУ/БМ | manilov.ap | CC Attribution | <https://sketchfab.com/3d-models/afe67617c5294dce9056106a22f640ff> |
| mig-27 | МиГ-27К | manilov.ap | CC Attribution | <https://sketchfab.com/3d-models/a9d22acdb582444a91c2adc8b123d674> |
| mig-29 | МиГ-29 | lucas.rdrgz | CC Attribution | <https://sketchfab.com/3d-models/c0f08d656dae4214b82b8647614f3ec4> |
| su-17 | Су-17М | manilov.ap | CC Attribution | <https://sketchfab.com/3d-models/a5dfc3d488c8441c8468a75ffad1ab75> |
| su-24 | Су-24М | 42manako | CC Attribution | <https://sketchfab.com/3d-models/17ca351ca78149d09393b3926db66454> |
| su-25 | Су-25 | 42manako | CC Attribution | <https://sketchfab.com/3d-models/947ef770b49742c3aa439177daabcf51> |
| tu-134 | Ту-134 | manilov.ap | CC Attribution | <https://sketchfab.com/3d-models/2e6826aa0f2142cca046e7499305db6a> |
| yak-18 | Як-18 | manilov.ap | CC Attribution | <https://sketchfab.com/3d-models/2b6d63da394a47458e07d52f6b88f169> |
| yak-28 | Як-28ПП | 42manako | CC Attribution | <https://sketchfab.com/3d-models/d8fb2ad3d871437392453568c0c8bfe8> |
| yak-40 | Як-40 | SeVka | CC Attribution | <https://sketchfab.com/3d-models/96ec4aa169e14c49ae7c268954bd0c21> |
| mi-1 | Ми-1 | manilov.ap | CC Attribution | <https://sketchfab.com/3d-models/33ab9ac87c7646eda6f0c6bba9dd68bf> |
| mi-8 | Ми-8Т | tnikita | CC Attribution | <https://sketchfab.com/3d-models/aaa58674609e40feafe816909de65ff9> |
| mi-24 | Ми-24П | duanesmind | CC Attribution | <https://sketchfab.com/3d-models/004d68143e1a4df88e136dbc0a05f181> |
| mi-26 | Ми-26 | SavyTheCreator | CC Attribution | <https://sketchfab.com/3d-models/272597d721e74a45914f7ffb846dda2a> |
| citation-x | Cessna 750 Citation X | SnowCrow | CC Attribution | <https://sketchfab.com/3d-models/1d7bb0b48301482f8145cb121268dd7f> |

The Li-2 beside the Museum of the History of the Great Patriotic War
(`data/warmuseum`, not part of the Lipki collection) is based on "Li 2"
(<https://sketchfab.com/3d-models/li-2-2b860a70497f4f3c86b560c4419d225d>) by
3Ddesmark (<https://sketchfab.com/3digrm>), licensed under CC-BY-4.0
(<http://creativecommons.org/licenses/by/4.0/>); it was decimated and repainted
in the livery of the real aircraft c/n 33444309.

A model that is not in this table is not shipped. The exhibition has empty
spaces where no model exists (Ту-154, Ан-12Б, Ан-24Б, Як-25М, Ил-14П, Ка-26,
PZL-104 Вильга, L-13 Blaník, Як-52); those spots contain no third-party
content.

**Rights status — honest limits.** The licences above are recorded from the
upstream metadata captured at download time (`MODELS.json` and per-model
`ATTRIBUTION.txt`); the upstream licence pages themselves are not archived in
the repository. No additional permission is claimed beyond the recorded
CC0 / CC-BY terms. The repository owner must verify each upstream licence and
the actual redistributed files before any commercial use or before relying on
this inventory as legal advice. The committed
`assets/aviation-museum/LICENSES.md` report is generated from `MODELS.json` and
may lag behind newly added exhibits; regenerate it with
`scripts/qa/museum_licenses.py` before a release.

## 3. Public transport payloads — ODbL geometry, demo timetable

`data/mobility-city/` is the **complete-city** transport payload: route
geometry, stops, signal nodes and street-network edges for 195 route numbers
(344 directed variants) are derived from the same OpenStreetMap extract as the
tile database, under **ODbL 1.0**. `data/mobility/` is the lightweight
demonstration subset with two verified corridors (bus 39, tram 9). Timetables
are synthetic (`scheduleStatus` in each `manifest.json` names the source).
They are **not** the Minsktrans public schedule and must not be presented as
one; no Minsktrans data is redistributed here.

* Databases: `data/mobility-city/` and `data/mobility/` (`manifest.json`,
  `chunks/*.json`, `routes/*.json`).
* Source: OpenStreetMap contributors, via the extract described in section 1.
* Modifications: directed street/rail network, lane offsets, stop projection,
  bridge heights, and a procedural timetable with demo calendars.
* Licence: **ODbL 1.0**; full text in `data/LICENSE-ODbL.txt`.

## 4. Bundled JavaScript dependencies — MIT

The built bundle includes **React**, **React DOM** (including its bundled
`scheduler`) and **three.js**, all MIT-licensed. Their copyright lines and full
MIT licence texts are recorded in the `bundled-js-dependencies` entry of
`asset-licenses.json`.

## 5. Source code licence — owner decision required

The repository contains **no** `LICENSE`/`COPYING` file. The code is
**source-available, not open source**: hosting it on GitHub is not a licence
grant. The owner must select a source-code licence before the project may be
described as open source. No licence is invented in this artifact.

## 6. Fonts and remote-linked sources

* **Fonts:** no webfont files are bundled; the UI uses the system font stack.
* **Remote links only:** the interface links to OpenStreetMap copyright, the
  museum website and the Sketchfab model pages above. Those pages are not
  assets fetched at runtime and are not redistributed here.
* Nothing else is fetched from a third-party origin to render the map.
