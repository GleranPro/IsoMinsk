# -*- coding: utf-8 -*-
"""Align the user's annotated crop to the full photo using the red arrows.

Red label arrows are identical in both images, so matching them by length and
direction votes for the crop offset.
"""
import json
import math
from collections import Counter, deque
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
PHOTO = ROOT / "data" / "interim" / "lipki_analysis" / "drone_grid1.png"
CROP = Path(r"C:\Users\DELL\.dsh\attachments\v1\objects\d8\d8f9f712c622687ff326c974397493e01e38fa5df03714cfb240f65bc5af8ee1")
OUT = ROOT / "data" / "interim" / "lipki_analysis" / "crop_transform.json"


def red_components(path):
    im = np.asarray(Image.open(path).convert("RGB"), dtype=np.int16)
    R, G, B = im[:, :, 0], im[:, :, 1], im[:, :, 2]
    red = (R > 140) & (R - G > 55) & (R - B > 55)
    H, W = red.shape
    lab = np.zeros((H, W), dtype=np.int32)
    out = []
    nxt = 0
    for y0, x0 in np.argwhere(red):
        if lab[y0, x0]:
            continue
        nxt += 1
        q = deque([(y0, x0)])
        lab[y0, x0] = nxt
        pts = []
        while q:
            y, x = q.popleft()
            pts.append((y, x))
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    yy, xx = y + dy, x + dx
                    if 0 <= yy < H and 0 <= xx < W and red[yy, xx] and not lab[yy, xx]:
                        lab[yy, xx] = nxt
                        q.append((yy, xx))
        if len(pts) < 150:
            continue
        ys = np.array([p[0] for p in pts], float)
        xs = np.array([p[1] for p in pts], float)
        cx, cy = xs.mean(), ys.mean()
        X = np.stack([xs - cx, ys - cy])
        evals, evecs = np.linalg.eigh(X @ X.T / len(xs))
        v = evecs[:, -1]
        t = X.T @ v
        length = float(t.max() - t.min())
        az = math.degrees(math.atan2(v[0], -v[1])) % 180.0
        out.append({"cx": float(cx), "cy": float(cy), "len": length, "az": az, "n_px": len(pts)})
    return out


crop_arrows = red_components(CROP)
photo_arrows = red_components(PHOTO)
print(f"crop red arrows: {len(crop_arrows)}, photo red arrows: {len(photo_arrows)}")

votes = Counter()
for ca in crop_arrows:
    for pa in photo_arrows:
        if abs(ca["len"] - pa["len"]) > max(6.0, 0.12 * pa["len"]):
            continue
        d_az = abs(((ca["az"] - pa["az"] + 90) % 180) - 90)
        if d_az > 6.0:
            continue
        dx = int(round(pa["cx"] - ca["cx"]))
        dy = int(round(pa["cy"] - ca["cy"]))
        votes[(dx // 2 * 2, dy // 2 * 2)] += 1

best = votes.most_common(8)
for (dx, dy), count in best:
    print(f"offset ({dx},{dy}) votes {count}")
if best:
    (dx, dy), _ = best[0]
    OUT.write_text(json.dumps({"scale": 1.0, "offset": [dx, dy], "method": "red-arrow vote"}), encoding="utf-8")
    print("wrote", OUT)
