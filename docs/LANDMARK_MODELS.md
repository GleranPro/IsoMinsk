# Low-poly landmark models

Hand-made GLB models of Minsk landmarks (`assets/landmarks/low-poly/*.glb`,
sources in `landmarks.blend`) are placed on the OSM map and replace the generic
extruded buildings underneath them.

## Pipeline

```
assets/landmarks/low-poly/*.glb
        │  scripts/landmarks/fit_placements.py   (pnpm run landmarks:fit)
        ▼
src/shared/landmarks/catalog.json   placement {x,y,yaw,scale}, hide[] per landmark
        │  scripts/landmarks/bake_landmarks.py   (pnpm run landmarks:bake)
        ▼
public/data/landmarks/{manifest.json,landmarks.bin}
        │  src/engine/landmarks/landmarkLayer.ts   one flat-shaded mesh per landmark
        ▼
scene (same Lambert + pixel-art look as the museum exhibits)
```

* The GLBs are texture atlases; the bake samples one colour per triangle from
  the atlas (`lm_bake.py`) and stores int16 decimetres relative to each
  landmark's own anchor, so the 24 km city never overflows int16.
* **Node translation/scale inside the GLBs are ignored**: they come from an
  arbitrary Blender layout. Accessor extents are real-world metres; only the
  yaw (or, for the Victory Monument, the whole tilt rotation) is meaningful.
* `fit_placements.py` searches yaw (±6° around the node yaw), a 0.94–1.04 scale
  and the translation by maximising IoU between the model's top-view
  silhouette and the OSM footprints in `fitTo`. Overlays are written to
  `.tmp/landmarks/fit/<slug>.png` (blue = fit target, amber = also hidden,
  red = model). Entries with `point` (statues, the obelisk, the arena bowl,
  the park gate) are anchored by one point and a given yaw instead.

## One model can stand for several OSM objects

`hide` lists every OSM building the model replaces; it is `fitTo` plus every
building at least 45 % under the fitted silhouette. The tile payloads are never
touched: `buildBuildingsMesh` receives the set as `hiddenBuildingIds` (passed by
`tileBuild.ts`) and emits no geometry for those ids.

| Landmark | Hidden OSM objects |
| --- | --- |
| Holy Spirit cathedral | `w538208752` cathedral, `w25387248` Bernardine monastery, `w1019411792` gatehouse |
| Railway station | `w358224860` hall, `w135566700` 54 m tower |
| National Art Museum | `w25327627` museum block, `w25327631` Kirova 25 house (the dark hipped-roof tail of the model) |
| Gorky Park gate | `r11788611` (the colonnade; the two round pylons `w1144853023`/`w1144927252` stay) |
| Minsk-Arena | `w292848094` bowl plus the stand/ramp pieces under the model (`w336355464`, `w1011195295`, `w1011403922`, `w1011422678`, `w1011422679`) |
| every other placed landmark | its own building |

## Models that are not at real-world size

The later models (art museum, Karl Marx 24, Gorky gate, Minsk-Arena) were
authored at roughly 1/2.5–1/2.8 of real size, so their placement scale is not
~1.0: art museum 2.6, Karl Marx 24 2.5, gate 2.8, arena 2.5 (`scales` /
`point.scale` in the catalog). They were fixed against Google Earth imagery
(historical imagery, 26 Sep 2025, nadir): the cross-shaped skylights and the hip
roof of the museum, the colonnade length of the gate and the roof rim of the
arena line up with the model at those scales. `scripts/landmarks/earth_overlay.py`
draws OSM footprints and a placed model over such a screenshot for re-checking.

## Open items

* Karl Marx 24 (`w25327593`): fitted by silhouette only (IoU 0.60), scale taken
  from the museum model; the OSM strip is thinner than the model.
* Archangel statue is anchored on its OSM node; its yaw is a guess (a 7 m statue
  is not readable on the imagery).
* Minsk-Arena: the OSM circle is offset from the roof seen on the imagery, so the
  bowl is placed from the imagery (`point.offset`), not on the OSM circle. The
  model's low wedge on the south-west side has no counterpart on the ground.
* QA: `?dataset=city&focus=<slug>` frames a placed landmark.
