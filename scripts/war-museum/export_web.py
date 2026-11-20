# -*- coding: utf-8 -*-
"""Export the War Museum Li-2 as a compact binary web payload.

The format is identical to the Lipki museum payload (see
`scripts/qa/export_museum_web.py`), so the engine can reuse `MuseumLayer`:
  public/data/warmuseum/manifest.json
  public/data/warmuseum/exhibits.bin
    [x int16][z int16][y int16][r u8][g u8][b u8], decimetres, non-indexed
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / "assets" / "war-museum"
OUT_DIR = ROOT / "public" / "data" / "warmuseum"
SCALE = 10.0  # int16 decimetres

PAD_INNER_RADIUS = 11.9
PAD_OUTER_RADIUS = 12.6
PAD_HEIGHT = 0.12
PAD_INNER_COLOR = (186, 183, 173)
PAD_EDGE_COLOR = (150, 148, 141)


def pad_geometry() -> tuple[list[float], list[int]]:
    """Non-indexed triangle list for the round concrete pad under the Li-2."""
    segments = 48
    positions: list[float] = []
    colors: list[int] = []

    def tri(a, b, c, color):
        for point in (a, b, c):
            positions.extend(point)
            colors.extend(color)

    center = (0.0, 0.0, PAD_HEIGHT)
    inner = [
        (
            PAD_INNER_RADIUS * math.cos(2 * math.pi * i / segments),
            PAD_INNER_RADIUS * math.sin(2 * math.pi * i / segments),
            PAD_HEIGHT,
        )
        for i in range(segments)
    ]
    outer = [
        (
            PAD_OUTER_RADIUS * math.cos(2 * math.pi * i / segments),
            PAD_OUTER_RADIUS * math.sin(2 * math.pi * i / segments),
            PAD_HEIGHT,
        )
        for i in range(segments)
    ]
    for i in range(segments):
        j = (i + 1) % segments
        tri(center, inner[i], inner[j], PAD_INNER_COLOR)
        tri(inner[i], outer[i], outer[j], PAD_EDGE_COLOR)
        tri(inner[i], outer[j], inner[j], PAD_EDGE_COLOR)
    return positions, colors


def main() -> None:
    placement = json.loads((ASSETS / "placement.json").read_text(encoding="utf-8"))
    model = json.loads((ASSETS / "baked" / "li-2.json").read_text(encoding="utf-8"))
    positions = np.asarray(model["positions"], dtype=np.float64).reshape(-1, 3)
    colors = np.asarray(model["colors"], dtype=np.uint8).reshape(-1, 3)

    origin = (float(placement["origin"][0]), float(placement["origin"][1]))
    chunks_x, chunks_z, chunks_y, chunks_rgb = [], [], [], []
    entries = []
    vertex_cursor = 0
    min_x = min_z = 1e9
    max_x = max_z = -1e9

    for exhibit in placement["exhibits"]:
        heading = math.radians(float(exhibit["heading"]))
        c, s = math.cos(heading), math.sin(heading)
        wx = positions[:, 0] * c - positions[:, 1] * s + float(exhibit["x"])
        wy = positions[:, 0] * s + positions[:, 1] * c + float(exhibit["y"])
        z = positions[:, 2]
        rel_x = wx - origin[0]
        rel_y = wy - origin[1]

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
                "count": int(qx.size),
                "triangles": int(qx.size // 3),
                "axisSource": exhibit.get("axisSource", "map-annotation"),
                "lengthM": float(model.get("lengthM", 0.0)),
                "spanM": float(model.get("spanM", 0.0)),
            }
        )
        vertex_cursor += int(qx.size)

    # The real exhibit stands on a round concrete pad inside a green fence. The
    # OSM park surface is grass, so add the pad to the payload: it keeps the
    # aircraft from looking parked on a lawn and matches the satellite view.
    pad_positions, pad_colors = pad_geometry()
    pad_x = np.round(np.asarray(pad_positions[0::3]) * SCALE).astype(np.int16)
    pad_z = np.round(np.asarray(pad_positions[2::3]) * SCALE).astype(np.int16)
    pad_y = np.round(np.asarray(pad_positions[1::3]) * SCALE).astype(np.int16)
    chunks_x.append(pad_x)
    chunks_z.append(pad_z)
    chunks_y.append(pad_y)
    chunks_rgb.append(np.asarray(pad_colors, dtype=np.uint8).reshape(-1, 3))
    entries.append(
        {
            "slug": "pad",
            "ref": "Бетонная площадка",
            "x": origin[0],
            "y": origin[1],
            "heading": 0.0,
            "start": vertex_cursor,
            "count": int(pad_x.size),
            "triangles": int(pad_x.size // 3),
            "axisSource": "generated",
            "lengthM": 25.2,
            "spanM": 25.2,
        }
    )
    vertex_cursor += int(pad_x.size)

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
        "origin": [origin[0], origin[1]],
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
            for spot in placement.get("missing", [])
        ],
        "bounds": {
            "minX": round(min_x, 2),
            "maxX": round(max_x, 2),
            "minY": round(min_z, 2),
            "maxY": round(max_z, 2),
        },
    }
    (OUT_DIR / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8"
    )
    print(
        f"wrote {bin_path.relative_to(ROOT)} ({bin_path.stat().st_size / 1024:.0f} KiB), "
        f"{len(entries)} exhibit(s), {vertices} vertices, {vertices // 3} triangles"
    )
    print(f"wrote {(OUT_DIR / 'manifest.json').relative_to(ROOT)}")


if __name__ == "__main__":
    main()
