# -*- coding: utf-8 -*-
"""Heading audit: draw every exhibit's nose against the red arrow it is pinned to.

For each exhibit the red arrow is the one recorded in `noseArrow`; the drawing
shows the model nose (green) and the arrow direction in local metres (red).
They must coincide: the arrow direction *is* the heading contract.

Output: assets/aviation-museum/analysis/heading_check.png
"""
from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / "assets" / "aviation-museum"
OUT = ASSETS / "analysis" / "heading_check.png"

A = np.array([[0.210128517, -0.005781065], [0.024360907, -0.217185299]])
RED_BY_ID = {int(a["n"]): a for a in json.loads((ASSETS / "analysis" / "drone_nose_arrows.json").read_text(encoding="utf-8"))}
BLUE_BY_ID = {int(a["n"]): a for a in json.loads((ASSETS / "analysis" / "blue_axes_crop.json").read_text(encoding="utf-8"))}
PLACEMENT = json.loads((ASSETS / "placement.json").read_text(encoding="utf-8"))

X0, X1, Y0, Y1 = 9185.0, 9400.0, 490.0, 825.0
W, H = 900, 1400
PX_PER_M = W / (X1 - X0)


def to_px(x: float, y: float) -> tuple[float, float]:
    return ((x - X0) * PX_PER_M, H - (y - Y0) * PX_PER_M)


def main() -> None:
    image = Image.new("RGB", (W, H), (252, 252, 250))
    draw = ImageDraw.Draw(image)
    for x in range(int(X0), int(X1), 25):
        draw.line([to_px(x, Y0), to_px(x, Y1)], fill=(238, 238, 238))
    for y in range(int(Y0), int(Y1), 25):
        draw.line([to_px(X0, y), to_px(X1, y)], fill=(238, 238, 238))

    try:
        font = ImageFont.truetype("C:/Windows/Fonts/segoeui.ttf", 16)
    except OSError:
        font = ImageFont.load_default()

    worst = 0.0
    for exhibit in PLACEMENT["exhibits"]:
        source = exhibit.get("axisSource", "red")
        arrow = (BLUE_BY_ID if source == "blue" else RED_BY_ID)[int(exhibit["noseArrow"])]
        d = np.dot(A, np.array([arrow["tip"][0] - arrow["tail"][0], arrow["tip"][1] - arrow["tail"][1]], float))
        arrow_deg = math.degrees(math.atan2(d[1], d[0]))
        delta = (float(exhibit["heading"]) - arrow_deg + 180.0) % 360.0 - 180.0
        worst = max(worst, abs(delta))

        x, y = float(exhibit["x"]), float(exhibit["y"])
        px, py = to_px(x, y)
        nose = (math.cos(math.radians(float(exhibit["heading"]))), math.sin(math.radians(float(exhibit["heading"]))))
        draw.line([px, py, px + nose[0] * 55, py - nose[1] * 55], fill=(0, 150, 60), width=3)
        draw.line(
            [px, py, px + math.cos(math.radians(arrow_deg)) * 55, py - math.sin(math.radians(arrow_deg)) * 55],
            fill=(210, 40, 40),
            width=1,
        )
        draw.ellipse([px - 4, py - 4, px + 4, py + 4], fill=(0, 110, 40))
        draw.text((px + 6, py + 5), exhibit["slug"], font=font, fill=(30, 30, 30))

    draw.text((12, 12), "green = model nose, red = red arrow from the photo (local metres)", font=font, fill=(0, 0, 0))
    image.save(OUT)
    print(f"wrote {OUT.relative_to(ROOT)}; max heading deviation from the arrows: {worst:.2f} deg")


if __name__ == "__main__":
    main()
