# -*- coding: utf-8 -*-
"""Measure which Lipki exhibits stand on the museum walkway.

Uses the clean north-up reference render (known camera) to detect the beige
walkway, projects every exhibit footprint into that image and reports the share
of walkway pixels under it. The second stage proposes a perpendicular push that
clears the walkway.
"""
import json
import math
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
REF = ROOT / "screenshots" / "museum" / "ref-north.png"
REF_META = json.loads((ROOT / "screenshots" / "museum" / "ref-north.json").read_text(encoding="utf-8"))
MANIFEST = json.loads((ROOT / "public" / "data" / "museum" / "manifest.json").read_text(encoding="utf-8"))

img = np.asarray(Image.open(REF).convert("RGB"), dtype=np.int16)
H, W = img.shape[:2]
meta = REF_META
px_per_m = meta["pxPerMetre"]
sin_el = meta["sinElevation"]
cx, cy = meta["center"]["x"], meta["center"]["y"]

R, G, B = img[:, :, 0], img[:, :, 1], img[:, :, 2]
path = (R > 120) & (G > 100) & (B > 70) & (R - B > 25) & (R - B < 90) & (G - B > 10)
print("path pixels:", int(path.sum()))

# Sanity: print the colour under a known path point.
sample_world = (9297.0, 700.0)
su = W / 2 + (sample_world[0] - cx) * px_per_m
sv = H / 2 - (sample_world[1] - cy) * px_per_m * sin_el
print("sample colour at", (round(su), round(sv)), img[int(sv), int(su)])


def world_to_px(x, y):
    return (W / 2 + (x - cx) * px_per_m, H / 2 - (y - cy) * px_per_m * sin_el)


def coverage(exhibit):
    length = exhibit["lengthM"]
    span = exhibit["spanM"]
    heading = math.radians(exhibit["heading"])
    cos_h, sin_h = math.cos(heading), math.sin(heading)
    inside = 0
    total = 0
    for ix in range(-4, 5):
        for iy in range(-3, 4):
            lx = length / 2 * ix / 4
            ly = span / 2 * iy / 3
            wx = exhibit["x"] + lx * cos_h - ly * sin_h
            wy = exhibit["y"] + lx * sin_h + ly * cos_h
            u, v = world_to_px(wx, wy)
            ui, vi = int(round(u)), int(round(v))
            if 0 <= ui < W and 0 <= vi < H:
                total += 1
                if path[vi, ui]:
                    inside += 1
    return inside / max(total, 1)


rows = []
for exhibit in MANIFEST["exhibits"]:
    share = coverage(exhibit)
    rows.append((share, exhibit["slug"], exhibit["ref"], exhibit["x"], exhibit["y"]))
rows.sort(reverse=True)
print(f"{'share':>6} {'slug':<11} ref")
for share, slug, ref, x, y in rows:
    print(f"{share:6.2f} {slug:<11} {ref:<26} ({x:.1f}, {y:.1f})")
