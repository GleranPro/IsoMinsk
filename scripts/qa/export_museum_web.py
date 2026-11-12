# -*- coding: utf-8 -*-
"""Export the placed Lipki museum exhibits as a compact binary web payload.

Reads `assets/aviation-museum/placement.json` and `baked/<slug>.json`, applies
each exhibit's heading/position, converts to the engine's world convention
(x east, y up, -y north) relative to a museum origin, quantises to int16
decimetres and writes:

  public/data/museum/manifest.json   metadata + per-exhibit vertex ranges
  public/data/museum/exhibits.bin    [x int16][z int16][y int16][r u8][g u8][b u8]

Positions are non-indexed (the bake duplicates vertices per triangle corner), so
the engine can upload `position`/`color` directly and get flat-shaded normals.
"""

from __future__ import annotations

import json
import math
import struct
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / "assets" / "aviation-museum"
OUT_DIR = ROOT / "public" / "data" / "museum"
ORIGIN = (9300.0, 650.0)          # local metres: centre of the exhibition grounds
SCALE = 10.0                       # int16 decimetres


def load_model(slug: str) -> dict:
    with open(ASSETS / "baked" / f"{slug}.json", encoding="utf-8") as handle:
        return json.load(handle)


def main() -> None:
    placement = json.loads((ASSETS / "placement.json").read_text(encoding="utf-8"))
    exhibits = placement["exhibits"]

    chunks_x: list[np.ndarray] = []
    chunks_z: list[np.ndarray] = []
    chunks_y: list[np.ndarray] = []
    chunks_rgb: list[np.ndarray] = []
    entries = []
    vertex_cursor = 0
    min_x = min_z = 1e9
    max_x = max_z = -1e9

    for exhibit in exhibits:
        model = load_model(exhibit["slug"])
        positions = np.asarray(model["positions"], dtype=np.float64).reshape(-1, 3)
        colors = np.asarray(model["colors"], dtype=np.uint8).reshape(-1, 3)
        count = positions.shape[0]
        heading = math.radians(float(exhibit["heading"]))
        c, s = math.cos(heading), math.sin(heading)
        wx = positions[:, 0] * c - positions[:, 1] * s + float(exhibit["x"])
        wy = positions[:, 0] * s + positions[:, 1] * c + float(exhibit["y"])
        rel_x = wx - ORIGIN[0]
        rel_y = wy - ORIGIN[1]
        z = positions[:, 2]

        qx = np.round(rel_x * SCALE).astype(np.int16)
        qy = np.round(rel_y * SCALE).astype(np.int16)
        qz = np.round(z * SCALE).astype(np.int16)
        chunks_x.append(qx)
        chunks_z.append(qz)
        chunks_y.append(qy)
        chunks_rgb.append(colors)

        min_x = min(min_x, float(qx.min() / SCALE))
        max_x = max(max_x, float(qx.max() / SCALE))
        min_z = min(min_z, float(qy.min() / SCALE))
        max_z = max(max_z, float(qy.max() / SCALE))

        entries.append(
            {
                "slug": exhibit["slug"],
                "ref": exhibit["ref"],
                "x": exhibit["x"],
                "y": exhibit["y"],
                "heading": exhibit["heading"],
                "start": vertex_cursor,
                "count": count,
                "triangles": count // 3,
                "axisSource": exhibit.get("axisSource", "red"),
                "lengthM": model["lengthM"],
                "spanM": model["spanM"],
            }
        )
        vertex_cursor += count

    x = np.concatenate(chunks_x).astype("<i2")
    z = np.concatenate(chunks_z).astype("<i2")
    y = np.concatenate(chunks_y).astype("<i2")
    rgb = np.concatenate(chunks_rgb).astype(np.uint8)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    bin_path = OUT_DIR / "exhibits.bin"
    with open(bin_path, "wb") as handle:
        handle.write(x.tobytes())
        handle.write(z.tobytes())
        handle.write(y.tobytes())
        handle.write(rgb.tobytes())

    vertices = int(x.size)
    manifest = {
        "version": 1,
        "origin": list(ORIGIN),
        "positionScale": SCALE,
        "vertices": vertices,
        "triangles": vertices // 3,
        "byteLength": bin_path.stat().st_size,
        "sections": [
            {"name": "x", "type": "int16", "count": vertices, "offset": 0},
            {"name": "z", "type": "int16", "count": vertices, "offset": vertices * 2},
            {"name": "y", "type": "int16", "count": vertices, "offset": vertices * 4},
            {"name": "rgb", "type": "uint8", "count": vertices * 3, "offset": vertices * 6},
        ],
        "exhibits": entries,
        "missing": [
            {"label": spot["label"], "x": spot["x"], "y": spot["y"], "heading": spot["heading"]}
            for spot in placement["missing"]
        ],
        "bounds": {
            "minX": round(min_x, 2),
            "maxX": round(max_x, 2),
            "minY": round(min_z, 2),
            "maxY": round(max_z, 2),
        },
    }
    (OUT_DIR / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")
    print(
        f"wrote {bin_path.relative_to(ROOT)} ({bin_path.stat().st_size / 1024:.0f} KiB), "
        f"{len(entries)} exhibits, {vertices} vertices, {vertices // 3} triangles"
    )
    print(f"wrote {(OUT_DIR / 'manifest.json').relative_to(ROOT)}")


if __name__ == "__main__":
    main()
