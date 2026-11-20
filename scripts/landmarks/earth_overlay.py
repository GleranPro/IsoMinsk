# -*- coding: utf-8 -*-
"""QA helper: draw OSM footprints (and optionally a placed landmark silhouette)
over a top-down Google Earth screenshot.

usage: earth_overlay.py SHOT.jpg LAT LON M_PER_PX OUT.png [slug x y yaw scale] [dx dy]
The screenshot is assumed north-up, nadir; (LAT, LON) is the pixel (cx, cy).
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from pyproj import Transformer

sys.path.insert(0, str(Path(__file__).parent))
import lm_common as L  # noqa: E402

ORIGIN = (536859.254, 5972786.284)
TO_UTM = Transformer.from_crs(4326, 32635, always_xy=True)


def main() -> None:
    shot, lat, lon, mpp, out = sys.argv[1], float(sys.argv[2]), float(sys.argv[3]), float(sys.argv[4]), sys.argv[5]
    rest = sys.argv[6:]
    dx = dy = 0.0
    if len(rest) >= 2 and rest[0].lstrip("-").replace(".", "").isdigit():
        dx, dy = float(rest[0]), float(rest[1])
        rest = rest[2:]
    img = Image.open(shot).convert("RGB")
    w, h = img.size
    if os.environ.get("BLANK"):
        img = Image.new("RGB", (w, h), (70, 70, 80))
    cx, cy = w / 2 + dx, h / 2 + dy
    ux, uy = TO_UTM.transform(lon, lat)
    mx, my = ux - ORIGIN[0], uy - ORIGIN[1]

    def px(x: float, y: float) -> tuple[float, float]:
        return cx + (x - mx) / mpp, cy - (y - my) / mpp

    draw = ImageDraw.Draw(img, "RGBA")
    near = L.buildings_near(mx, my, 150)
    for bid, b in near.items():
        for ring in L.building_rings(b):
            pts = [px(p[0], p[1]) for p in ring]
            draw.line(pts + [pts[0]], fill=(0, 255, 255, 230), width=2)
    if rest:
        slug, x, y, yaw, scale = rest[0], *map(float, rest[1:5])
        cat = L.load_catalog()
        entry = next(e for e in cat["landmarks"] if e["slug"] == slug)
        model = L.load_glb(L.MODEL_DIR / entry["glb"], slug)
        e, n, up = model.plan(yaw, scale)
        tri = model.indices
        if os.environ.get("SOLID"):
            from lm_bake import triangle_colors

            colors = triangle_colors(model)
            order = np.argsort(up[tri].mean(axis=1))
            for k in order:
                pts = [px(x + e[i], y + n[i]) for i in tri[k]]
                draw.polygon(pts, fill=tuple(int(v) for v in colors[k][:3]) + (255,))
        else:
            for t in tri[:: max(1, len(tri) // 6000)]:
                pts = [px(x + e[i], y + n[i]) for i in t]
                draw.polygon(pts, fill=(255, 40, 40, 70), outline=(255, 40, 40, 160))
    img.save(out)


if __name__ == "__main__":
    main()
