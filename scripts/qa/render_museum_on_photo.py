# -*- coding: utf-8 -*-
"""Overlay the placed museum models on the annotated drone photo.

This is the visual acceptance check for `placement.json`: every model silhouette
is projected back through the photo->local affine, so a correct placement puts
each silhouette exactly over its aircraft in the photo with the nose along the
red arrow.

Output: assets/aviation-museum/analysis/placement_on_photo.jpg
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / "assets" / "aviation-museum"
BAKED = ASSETS / "baked"
PHOTO = ROOT / "data" / "interim" / "lipki_analysis" / "drone_grid1.png"
OUT = ASSETS / "analysis" / "placement_on_photo.jpg"

A = np.array([[0.210128517, -0.005781065], [0.024360907, -0.217185299]])
T = np.array([9190.37425, 807.127018])
A_INV = np.linalg.inv(A)


def local_to_photo(x: float, y: float) -> tuple[float, float]:
    uv = np.dot(A_INV, np.array([x, y], dtype=float) - T)
    return float(uv[0]), float(uv[1])


def load_model(slug: str) -> dict | None:
    path = BAKED / f"{slug}.json"
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def colour_for(slug: str) -> tuple[int, int, int]:
    h = sum(ord(c) for c in slug) * 37
    return (60 + h % 120, 90 + (h // 7) % 120, 110 + (h // 13) % 120)


def main() -> None:
    if not PHOTO.exists():
        raise SystemExit(
            "annotated photo not found: "
            + str(PHOTO)
            + "\nIt is git-ignored; place drone_grid1.png there to re-run the overlay."
        )
    placement = json.loads((ASSETS / "placement.json").read_text(encoding="utf-8"))
    image = Image.open(PHOTO).convert("RGB")
    overlay = Image.new("RGBA", image.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)

    for exhibit in placement["exhibits"]:
        model = load_model(exhibit["slug"])
        if model is None:
            continue
        pos = np.asarray(model["positions"], dtype=float).reshape(-1, 3)
        idx = np.asarray(model["indices"], dtype=int).reshape(-1, 3)
        yaw = math.radians(exhibit["heading"])
        c, s = math.cos(yaw), math.sin(yaw)
        wx = pos[:, 0] * c - pos[:, 1] * s + exhibit["x"]
        wy = pos[:, 0] * s + pos[:, 1] * c + exhibit["y"]
        local = np.stack([wx, wy], axis=1)
        uv = (local - T) @ A_INV.T
        colour = colour_for(exhibit["slug"])
        order = np.argsort(pos[idx, 2].mean(axis=1))
        for tri in order:
            pts = [(float(uv[i, 0]), float(uv[i, 1])) for i in idx[tri]]
            shade = 0.55 + 0.45 * float(pos[idx[tri], 2].mean()) / max(float(pos[:, 2].max()), 1e-6)
            fill = (
                int(colour[0] * shade),
                int(colour[1] * shade),
                int(colour[2] * shade),
                160,
            )
            draw.polygon(pts, fill=fill)

    composed = Image.alpha_composite(image.convert("RGBA"), overlay).convert("RGB")
    composed.save(OUT, quality=92)
    print(f"wrote {OUT.relative_to(ROOT)} ({composed.width}x{composed.height})")

    # A tighter crop around the exhibition rows is easier to review.
    crop = composed.crop((30, 380, 990, 1500))
    crop.save(OUT.with_name("placement_on_photo_crop.jpg"), quality=92)
    print(f"wrote {OUT.with_name('placement_on_photo_crop.jpg').relative_to(ROOT)}")


if __name__ == "__main__":
    main()
