# -*- coding: utf-8 -*-
"""Quick isometric preview of the landmark models (painter's algorithm).

Used for QA only: shows what the baked per-triangle colours look like before the
engine renders them. Usage: preview.py [slug ...]  -> .tmp/landmarks/preview/
"""

from __future__ import annotations

import math
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).parent))
from lm_common import *  # noqa: E402,F403
from lm_bake import triangle_colors  # noqa: E402

OUT = ROOT / ".tmp" / "landmarks" / "preview"


def render(model, size=640, az=45.0, elev=30.0):
    e, n, up = model.plan(0.0, 1.0)
    pts = np.stack([e, n, up], axis=1)
    a = math.radians(az)
    # camera looks from south-west... rotate the plan by az, tilt by elevation
    x = pts[:, 0] * math.cos(a) - pts[:, 1] * math.sin(a)
    y = pts[:, 0] * math.sin(a) + pts[:, 1] * math.cos(a)
    el = math.radians(elev)
    sx = x
    sy = pts[:, 2] * math.cos(el) + y * math.sin(el)
    depth = y * math.cos(el) - pts[:, 2] * math.sin(el)
    colors = triangle_colors(model)
    tri = model.indices
    order = np.argsort(-depth[tri].mean(axis=1))
    span = max(sx.max() - sx.min(), sy.max() - sy.min()) * 1.1
    scale = size / span
    ox = (sx.max() + sx.min()) / 2
    oy = (sy.max() + sy.min()) / 2
    img = Image.new("RGB", (size, size), (222, 228, 236))
    d = ImageDraw.Draw(img)
    light = np.array([-0.4, -0.5, 0.75])
    light /= np.linalg.norm(light)
    for ti in order:
        i, j, k = tri[ti]
        p0, p1, p2 = pts[i], pts[j], pts[k]
        nrm = np.cross(p1 - p0, p2 - p0)
        ln = np.linalg.norm(nrm)
        shade = 0.72
        if ln > 1e-9:
            nrm = nrm / ln
            nrm_rot = np.array([nrm[0] * math.cos(a) - nrm[1] * math.sin(a), nrm[0] * math.sin(a) + nrm[1] * math.cos(a), nrm[2]])
            shade = 0.55 + 0.45 * abs(float(np.dot(nrm_rot, light)))
        c = tuple(int(min(255, v * shade)) for v in colors[ti])
        poly = [((sx[q] - ox) * scale + size / 2, size / 2 - (sy[q] - oy) * scale) for q in (i, j, k)]
        d.polygon(poly, fill=c)
    return img


def main():
    only = set(sys.argv[1:])
    OUT.mkdir(parents=True, exist_ok=True)
    catalog = load_catalog()
    models = load_models(catalog)
    for entry in catalog["landmarks"]:
        if only and entry["slug"] not in only:
            continue
        img = render(models[entry["slug"]])
        ImageDraw.Draw(img).text((6, 4), entry["slug"], fill=(0, 0, 0))
        img.save(OUT / f"{entry['slug']}.png")
        print("saved", entry["slug"])


if __name__ == "__main__":
    main()
