# -*- coding: utf-8 -*-
"""Bake the placed low-poly landmark models into a compact web payload.

Reads src/shared/landmarks/catalog.json (placement + hide lists, written by
fit_placements.py) and the GLBs in assets/landmarks/low-poly, and writes

  public/data/landmarks/manifest.json
  public/data/landmarks/landmarks.bin
    [east int16][height int16][north int16][r u8][g u8][b u8]   (decimetres)
    non-indexed, 3 vertices per triangle, flat colour per triangle

Positions are relative to each landmark's own anchor (placement x/y, local
metres) so int16 decimetres (+-3.2 km) never overflows across a 24 km city; the
engine places one mesh per landmark at the anchor.

Entries with `status: "unplaced"` or without `placement` are skipped.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from lm_common import *  # noqa: E402,F403
from lm_bake import triangle_colors  # noqa: E402

OUT_DIR = ROOT / "public" / "data" / "landmarks"
SCALE = 10.0  # int16 decimetres


def main() -> None:
    catalog = load_catalog()
    models = load_models(catalog)
    xs, hs, ys, rgb = [], [], [], []
    entries = []
    cursor = 0
    for entry in catalog["landmarks"]:
        placement = entry.get("placement")
        if entry.get("status") == "unplaced" or not placement:
            print("skip", entry["slug"])
            continue
        model = models[entry["slug"]]
        e, n, up = model.plan(placement["yaw"], placement["scale"])
        up = up - float(up.min()) if abs(float(up.min())) < 0.5 else up  # sit exactly on the ground
        tri = model.indices
        colors = triangle_colors(model)
        qe = np.round(e[tri].reshape(-1) * SCALE)
        qn = np.round(n[tri].reshape(-1) * SCALE)
        qh = np.round(up[tri].reshape(-1) * SCALE)
        for name, arr in (("east", qe), ("north", qn), ("height", qh)):
            if np.abs(arr).max() > 32000:
                raise SystemExit(f"{entry['slug']}: {name} overflows int16 ({np.abs(arr).max() / SCALE:.0f} m)")
        count = int(qe.size)
        xs.append(qe.astype("<i2"))
        hs.append(qh.astype("<i2"))
        ys.append(qn.astype("<i2"))
        rgb.append(np.repeat(colors, 3, axis=0))
        entries.append(
            {
                "slug": entry["slug"],
                "label": entry["label"],
                "osm": entry["osm"],
                "x": placement["x"],
                "y": placement["y"],
                "yaw": placement["yaw"],
                "scale": placement["scale"],
                "hide": entry.get("hide", []),
                "start": cursor,
                "count": count,
                "triangles": count // 3,
                "extent": [
                    round(float(qe.min()) / SCALE, 1),
                    round(float(qn.min()) / SCALE, 1),
                    round(float(qe.max()) / SCALE, 1),
                    round(float(qn.max()) / SCALE, 1),
                ],
                "heightM": round(float(qh.max()) / SCALE, 1),
            }
        )
        cursor += count

    x = np.concatenate(xs)
    h = np.concatenate(hs)
    y = np.concatenate(ys)
    colors = np.concatenate(rgb).astype(np.uint8)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    bin_path = OUT_DIR / "landmarks.bin"
    with open(bin_path, "wb") as handle:
        handle.write(x.tobytes())
        handle.write(h.tobytes())
        handle.write(y.tobytes())
        handle.write(colors.tobytes())
    vertices = int(x.size)
    manifest = {
        "version": 1,
        "positionScale": SCALE,
        "vertices": vertices,
        "triangles": vertices // 3,
        "byteLength": bin_path.stat().st_size,
        "sections": [
            {"name": "east", "type": "int16", "count": vertices, "offset": 0},
            {"name": "height", "type": "int16", "count": vertices, "offset": vertices * 2},
            {"name": "north", "type": "int16", "count": vertices, "offset": vertices * 4},
            {"name": "rgb", "type": "uint8", "count": vertices * 3, "offset": vertices * 6},
        ],
        "landmarks": entries,
    }
    (OUT_DIR / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")
    print(
        f"wrote {bin_path.relative_to(ROOT)} ({bin_path.stat().st_size / 1024:.0f} KiB), "
        f"{len(entries)} landmarks, {vertices // 3} triangles"
    )


if __name__ == "__main__":
    main()
