# -*- coding: utf-8 -*-
"""Measure aircraft plan axes in the photo and calibrate against the blue arrows."""
import json
import math
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
PHOTO = np.asarray(Image.open(ROOT / "data" / "interim" / "lipki_analysis" / "drone_grid1.png").convert("RGB"), dtype=np.float32)
GRAY = PHOTO.mean(axis=2)
H, W = GRAY.shape

BLUE = {int(a["n"]): a for a in json.loads((ROOT / "assets" / "aviation-museum" / "analysis" / "blue_axes_crop.json").read_text(encoding="utf-8"))}
PLACEMENT = json.loads((ROOT / "assets" / "aviation-museum" / "placement.json").read_text(encoding="utf-8"))

A = np.array([[0.210128517, -0.005781065], [0.024360907, -0.217185299]])


def patch_mask(cx, cy, radius=48):
    y0, y1 = max(0, int(cy - radius)), min(H, int(cy + radius))
    x0, x1 = max(0, int(cx - radius)), min(W, int(cx + radius))
    patch = GRAY[y0:y1, x0:x1]
    if patch.size == 0:
        return None, None
    # aircraft are the bright objects; local Otsu threshold
    hist, _ = np.histogram(patch, bins=32, range=(0, 255))
    total = hist.sum()
    best_t, best_var, acc, acc_sum = 0.0, -1.0, 0, 0.0
    for i in range(32):
        acc += hist[i]
        acc_sum += hist[i] * (i + 0.5) * 255 / 32
        if acc == 0 or acc == total:
            continue
        w0 = acc / total
        w1 = 1 - w0
        m0 = acc_sum / acc
        m1 = (patch.sum() - acc_sum) / max(total - acc, 1)
        var = w0 * w1 * (m0 - m1) ** 2
        if var > best_var:
            best_var, best_t = var, (i + 1) * 255 / 32
    mask = patch > max(best_t, 110)
    return mask.astype(np.float32), (x0, y0)


def axis_of(points, weights):
    w = weights.reshape(-1)
    px = points[:, 0] - np.average(points[:, 0], weights=w)
    py = points[:, 1] - np.average(points[:, 1], weights=w)
    cov = np.cov(np.stack([px, py]) * np.sqrt(w))
    evals, evecs = np.linalg.eigh(cov)
    v = evecs[:, -1]
    angle = math.degrees(math.atan2(v[1], v[0])) % 180.0
    return angle, float(evals[-1] / max(evals[0], 1e-6))


print(f"{'ref':<24} {'blueAz':>7} {'pcaAz':>6} {'diff':>6} {'elong':>6}")
for exhibit in PLACEMENT["exhibits"]:
    if exhibit["axisSource"] != "blue":
        continue
    px, py = exhibit["photo"]
    mask, origin = patch_mask(px, py)
    if mask is None:
        continue
    ys, xs = np.nonzero(mask)
    if len(xs) < 50:
        print(f"{exhibit['ref']:<24} too few pixels in patch")
        continue
    pts = np.stack([xs + origin[0], ys + origin[1]], axis=1).astype(float)
    angle, elong = axis_of(pts, mask[ys, xs])
    blue = BLUE[int(exhibit["noseArrow"])]
    blue_az = blue["az"] % 180.0
    diff = abs(((angle - blue_az + 90) % 180) - 90)
    print(f"{exhibit['ref']:<24} {blue_az:7.1f} {angle:6.1f} {diff:6.1f} {elong:6.1f}")
