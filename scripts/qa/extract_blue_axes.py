# -*- coding: utf-8 -*-
"""Extract the blue fuselage-axis arrows from the user's annotated crop.

Crop coordinates -> photo coordinates: photo = crop + (237, 410) at scale 1.0
(verified by identical red-arrow signatures in both images).
"""
import json
import math
from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[2]
CROP = Path(r"C:\Users\DELL\.dsh\attachments\v1\objects\d8\d8f9f712c622687ff326c974397493e01e38fa5df03714cfb240f65bc5af8ee1")
PHOTO = ROOT / "data" / "interim" / "lipki_analysis" / "drone_grid1.png"
OUT = ROOT / "data" / "interim" / "lipki_analysis" / "blue_axes.json"
MARKED = ROOT / "data" / "interim" / "lipki_analysis" / "blue_axes_marked.png"
OFFSET = (237, 410)

im = Image.open(CROP).convert("RGB")
a = np.asarray(im, dtype=np.int16)
R, G, B = a[:, :, 0], a[:, :, 1], a[:, :, 2]
blue = (B > 200) & (G > 140) & (R < 90) & (B - G < 80)
print("blue px:", int(blue.sum()))

H, W = blue.shape
lab = np.zeros((H, W), dtype=np.int32)
arrows = []
nxt = 0
for y0, x0 in np.argwhere(blue):
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
                if 0 <= yy < H and 0 <= xx < W and blue[yy, xx] and not lab[yy, xx]:
                    lab[yy, xx] = nxt
                    q.append((yy, xx))
    if len(pts) < 60:
        continue
    ys = np.array([p[0] for p in pts], float)
    xs = np.array([p[1] for p in pts], float)
    cx, cy = xs.mean(), ys.mean()
    X = np.stack([xs - cx, ys - cy])
    evals, evecs = np.linalg.eigh(X @ X.T / len(xs))
    v = evecs[:, -1]
    if v[0] < 0:
        v = -v
    t = X.T @ v
    s = -(xs - cx) * v[1] + (ys - cy) * v[0]
    t0, t1 = float(t.min()), float(t.max())
    length = t1 - t0
    nb = 14
    bins = np.clip(((t - t0) / max(length, 1e-6) * nb).astype(int), 0, nb - 1)
    prof = np.zeros(nb)
    for b in range(nb):
        sel = s[bins == b]
        if len(sel):
            prof[b] = sel.max() - sel.min()
    # The head is the end with the larger short-range width (chevron/triangle).
    head_pos = prof[-3:].mean() >= prof[:3].mean()
    tip_t = t1 if head_pos else t0
    tail_t = t0 if head_pos else t1
    tip_c = (cx + v[0] * tip_t, cy + v[1] * tip_t)
    tail_c = (cx + v[0] * tail_t, cy + v[1] * tail_t)
    tip_p = (tip_c[0] + OFFSET[0], tip_c[1] + OFFSET[1])
    tail_p = (tail_c[0] + OFFSET[0], tail_c[1] + OFFSET[1])
    az = math.degrees(math.atan2(tip_p[0] - tail_p[0], -(tip_p[1] - tail_p[1]))) % 360.0
    arrows.append(
        {
            "n": len(arrows) + 1,
            "n_px": len(pts),
            "tip": [round(float(tip_p[0]), 1), round(float(tip_p[1]), 1)],
            "tail": [round(float(tail_p[0]), 1), round(float(tail_p[1]), 1)],
            "az": round(float(az), 1),
            "len": round(length, 1),
            "w_head": round(float(prof[-3:].mean() if head_pos else prof[:3].mean()), 1),
            "w_tail": round(float(prof[:3].mean() if head_pos else prof[-3:].mean()), 1),
            "elongation": round(float(evals[-1] / max(evals[0], 1e-6)), 1),
        }
    )

arrows.sort(key=lambda x: (x["tail"][1], x["tail"][0]))
for i, arow in enumerate(arrows, 1):
    arow["n"] = i
OUT.write_text(json.dumps(arrows, ensure_ascii=False, indent=1), encoding="utf-8")

vis = Image.open(PHOTO).convert("RGB")
d = ImageDraw.Draw(vis)
for arow in arrows:
    d.line([*arow["tail"], *arow["tip"]], fill=(255, 0, 255), width=3)
    d.ellipse([arow["tip"][0] - 6, arow["tip"][1] - 6, arow["tip"][0] + 6, arow["tip"][1] + 6], outline=(255, 0, 255), width=2)
    d.text((arow["tip"][0] + 8, arow["tip"][1] - 14), f"B{arow['n']}", fill=(255, 0, 255))
vis.crop((200, 380, 1000, 900)).resize((1600, 1040), Image.LANCZOS).save(MARKED)
print(f"blue arrows: {len(arrows)}")
for arow in arrows:
    print(
        f"  B{arow['n']:>2} tip ({arow['tip'][0]:6.1f},{arow['tip'][1]:6.1f}) tail ({arow['tail'][0]:6.1f},{arow['tail'][1]:6.1f}) "
        f"az {arow['az']:6.1f} len {arow['len']:5.1f} wh {arow['w_head']:4.1f} wt {arow['w_tail']:4.1f} elong {arow['elongation']}"
    )
