# -*- coding: utf-8 -*-
"""Align the user's annotated product screenshot with the reference north-up view.

Reference: screenshots/museum/ref-north.png (azimuth 0, ortho 200 m, hidden HUD).
The product ortho projection at azimuth 0 is linear:
    u = W/2 + (x - cx) * s
    v = H/2 - (y - cy) * s * sin(elevation)
so once the reference is matched inside the user's image, every marked arrow can
be converted back to world metres.
"""
import json
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
import sys

REF_NAME = sys.argv[1] if len(sys.argv) > 1 else "ref-north"
REF = ROOT / "screenshots" / "museum" / f"{REF_NAME}.png"
REF_META = ROOT / "screenshots" / "museum" / f"{REF_NAME}.json"
USER = Path(r"C:\Users\DELL\.dsh\attachments\v1\objects\e0\e092603522d4306063d477ae866738175b10d0b0627114d2c23b086da3f46d43")
OUT = ROOT / "screenshots" / "museum" / f"align-{REF_NAME}.json"

user_img = Image.open(USER).convert("RGB")
ref_img = Image.open(REF).convert("RGB")
U = np.asarray(user_img, dtype=np.float32)
W, H = user_img.size
print("user", user_img.size, "ref", ref_img.size)

# Drop the red annotation ink from the correlation.
R, G, B = U[:, :, 0], U[:, :, 1], U[:, :, 2]
red = (R > 150) & (R - G > 70) & (R - B > 70)
grey = U.mean(axis=2)
grey[red] = np.nan

ref_grey = np.asarray(ref_img.convert("L"), dtype=np.float32)

# Downsample for the search.
step = 4
u_small = grey[::step, ::step]
valid = ~np.isnan(u_small)
u_filled = np.where(valid, u_small, 0.0)
u_weight = valid.astype(np.float32)

hs, ws = u_small.shape
best = None
for k in [1.2 + 0.05 * i for i in range(50)]:
    tw, th = int(round(ref_img.width * k / step)), int(round(ref_img.height * k / step))
    if tw >= ws or th >= hs:
        continue
    template = np.asarray(ref_img.convert("L").resize((tw, th), Image.BILINEAR), dtype=np.float32)
    template = template - template.mean()
    # numerator/denominator via FFT with the valid mask.
    shape = (hs, ws)
    f_img = np.fft.rfft2(u_filled)
    f_tpl = np.fft.rfft2(template, s=shape)
    corr = np.fft.irfft2(f_img * np.conj(f_tpl), s=shape)
    f_w = np.fft.rfft2(u_weight)
    f_one = np.fft.rfft2(np.ones_like(template), s=shape)
    # sums of image over the template window and sums of squares
    sum_img = np.fft.irfft2(f_img * np.conj(f_one), s=shape)
    sum_img2 = np.fft.irfft2(np.fft.rfft2(u_filled ** 2) * np.conj(f_one), s=shape)
    count = np.fft.irfft2(f_w * np.conj(f_one), s=shape)
    tpl_sum = template.sum()
    tpl_sq = (template ** 2).sum()
    var_img = np.maximum(sum_img2 - sum_img ** 2 / np.maximum(count, 1e-6), 1e-6)
    denom = np.sqrt(var_img * tpl_sq)
    score = (corr - sum_img * tpl_sum / np.maximum(count, 1e-6)) / np.maximum(denom, 1e-6)
    score[count < 0.5 * count.max()] = -2
    idx = np.unravel_index(np.argmax(score), score.shape)
    value = float(score[idx])
    if best is None or value > best[0]:
        best = (value, k, int(idx[1]) * step, int(idx[0]) * step, tw * step, th * step)
    print(f"k={k:.2f} score={value:.4f}")

print("best", best)
score, k, dx, dy, tw, th = best
meta = json.loads(REF_META.read_text(encoding="utf-8"))
data = {
    "scale": k,
    "offset": [dx, dy],
    "score": score,
    "ref": meta,
    "note": "user_px = ref_px * scale + offset; ref_px = (u,v) of ref-north.png",
}
OUT.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
print("wrote", OUT)

# Visual check: paste the unwarped reference at the found scale into the user's image.
check = user_img.copy()
placement = ref_img.resize((tw, th), Image.BILINEAR)
check.paste(Image.blend(check.crop((dx, dy, dx + tw, dy + th)).convert("RGB"), placement, 0.55), (dx, dy))
check.save(ROOT / "screenshots" / "museum" / "align-check.png")
print("wrote align-check.png")
