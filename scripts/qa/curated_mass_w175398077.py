# -*- coding: utf-8 -*-
"""Rebuild the missing main mass of ЖК «У Троицкого» (w175398077).

The OSM outline carries the whole building, the 22 building:parts only describe
stages (terraces and upper floors). The normaliser cut the outline around every
part and extruded the remainder to 6 m, so the main mass is missing and only
the stages are drawn. Each remainder point takes the height of the nearest
reference stage: a ground-level stage gives its own top, an elevated stage gives
its `min_height` (the floors below it are the mass). Output is stored as data
(src/city/buildings/data/w175398077-mass.json) for curatedOverrides.ts.

Usage: .venv/Scripts/python.exe scripts/qa/curated_mass_w175398077.py
"""
import json
from pathlib import Path

import shapely
from shapely.geometry import MultiPoint, Polygon
from shapely.geometry.polygon import orient

ROOT = Path(__file__).resolve().parents[2]
TILE = ROOT / "public/data/city-tiles/-1_0.json"
OUT = ROOT / "src/city/buildings/data/w175398077-mass.json"
MIN_REF_AREA = 40.0
MIN_REF_HEIGHT = 20.0

tile = json.loads(TILE.read_text(encoding="utf-8"))
building = next(b for b in tile["buildings"] if b["id"] == "w175398077")
volumes = building["volumes"]
base_volumes = [v for v in volumes if not v.get("isPart")]
parts = [v for v in volumes if v.get("isPart")]
assert len(base_volumes) == 1, len(base_volumes)
base = Polygon(base_volumes[0]["footprint"][0], base_volumes[0]["footprint"][1:])
if not base.is_valid:
    base = base.buffer(0)

refs = []
for part in parts:
    poly = Polygon(part["footprint"][0])
    height = part["minHeight"] if part["minHeight"] > 0.5 else part["height"]
    if poly.area >= MIN_REF_AREA and height >= MIN_REF_HEIGHT:
        refs.append((poly.centroid, round(height, 2)))
print("reference stages:", [(round(c.x), round(c.y), h) for c, h in refs])

# Parts footprints are cut out of the base but must be solid mass too, so the
# cells are computed over the base grown by the parts, then the base is clipped.
sites = MultiPoint([c for c, _ in refs])
cells = list(shapely.voronoi_polygons(sites, extend_to=base.buffer(50)).geoms)

out = []
for cell in cells:
    centre = next(((c, h) for c, h in refs if cell.contains(c)), None)
    if centre is None:
        continue
    piece = base.intersection(cell)
    geoms = [piece] if piece.geom_type == "Polygon" else [g for g in getattr(piece, "geoms", []) if g.geom_type == "Polygon"]
    for geom in geoms:
        if geom.area < 2.0:
            continue
        geom = orient(geom, 1.0)  # CCW exterior, CW holes
        rings = [[[round(x, 2), round(y, 2)] for x, y in list(geom.exterior.coords)[:-1]]]
        rings += [[[round(x, 2), round(y, 2)] for x, y in list(r.coords)[:-1]] for r in geom.interiors]
        out.append({"footprint": rings, "height": centre[1]})
out.sort(key=lambda v: (v["height"], v["footprint"][0][0]))
OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text(json.dumps({"id": "w175398077", "volumes": out}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
print(len(out), "mass volumes, area", round(sum(Polygon(v["footprint"][0], v["footprint"][1:]).area for v in out)), "of", round(base.area), "->", OUT)
for v in out:
    print(v["height"], round(Polygon(v["footprint"][0], v["footprint"][1:]).area))
