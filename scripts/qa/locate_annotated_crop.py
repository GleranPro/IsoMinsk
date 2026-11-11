# -*- coding: utf-8 -*-
"""Locate the user's annotated crop inside the full drone photo (FFT correlation).

The crop carries new blue axis arrows; we need its scale and offset to transfer
them into full-photo pixel coordinates.
"""
import json
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
CROP = Path(r"C:\Users\DELL\.dsh\attachments\v1\objects\d8\d8f9f712c622687ff326c974397493e01e38fa5df03714cfb240f65bc5af8ee1")
PHOTO = ROOT / "data" / "interim" / "lipki_analysis" / "drone_grid1.png"
OUT = ROOT / "data" / "interim" / "lipki_analysis" / "crop_transform.json"

photo = np.asarray(Image.open(PHOTO).convert("L"), dtype=np.float64)
crop = Image.open(CROP).convert("L")

H, W = photo.shape
results = []
for k in [0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 1.0, 1.05]:
    tpl_img = crop.resize((max(2, int(round(crop.width * k))), max(2, int(round(crop.height * k)))), Image.BILINEAR)
    tpl = np.asarray(tpl_img, dtype=np.float64)
    th, tw = tpl.shape
    if th >= H or tw >= W:
        continue
    pad = np.zeros((H, W))
    pad[:th, :tw] = tpl
    # correlation of photo with template via FFT: sum(photo * tpl(x-dx))
    f_photo = np.fft.rfft2(photo)
    f_tpl = np.fft.rfft2(pad)
    corr = np.fft.irfft2(f_photo * np.conj(f_tpl), s=(H, W))
    # normalise by local energy
    ones = np.zeros((H, W))
    ones[:th, :tw] = 1.0
    energy = np.fft.irfft2(np.fft.rfft2(photo ** 2) * np.conj(np.fft.rfft2(ones)), s=(H, W))
    score = corr / np.sqrt(np.maximum(energy, 1e-6))
    # valid offsets: the template is stored at 0,0, so peak (dy,dx) means photo(y+dy,x+dx) ~ tpl(y,x)
    idx = np.unravel_index(np.argmax(score), score.shape)
    results.append((float(score[idx]), k, int(idx[1]), int(idx[0]), tw, th))
    print(f"scale {k:.2f}: peak {score[idx]:.4f} at dx={idx[1]} dy={idx[0]} (crop {tw}x{th})")

results.sort(reverse=True)
best = results[0]
print("\nbest:", best)
data = {
    "note": "crop px -> full photo px: photo = crop * scale + offset",
    "scale": best[1],
    "offset": [best[2], best[3]],
    "score": best[0],
    "cropSize": [crop.width, crop.height],
}
OUT.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
print(f"wrote {OUT.relative_to(ROOT)}")
