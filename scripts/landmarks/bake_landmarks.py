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

# --- curated decorations ----------------------------------------------------
# The Yandex Victory Monument GLB stops at the paved platform; the OSM way
# 1308903766 (Вечны агонь) is a 9 m diamond slab south-west of the obelisk that
# the model does not carry. Emit it here so the exhibit keeps its eternal flame.
# Plan coordinates are absolute local metres (OSM geometry), shifted by the
# landmark anchor at bake time so a moved placement keeps the flame on its slab.
VICTORY_FLAME_RING = (
    (900.991, 716.637),
    (896.243, 712.393),
    (900.505, 707.654),
    (905.254, 711.898),
)
VICTORY_FLAME_CENTRE = (900.748, 712.146)
VICTORY_FLAME_SLAB_HEIGHT = 0.45
VICTORY_FLAME_BODY_TOP = 2.05
VICTORY_FLAME_CORE_TOP = 2.75
VICTORY_FLAME_SLAB_RGB = (110, 111, 107)   # dark granite slab
VICTORY_FLAME_BODY_RGB = (224, 122, 31)    # flame body
VICTORY_FLAME_CORE_RGB = (245, 194, 75)    # hot core


def victory_flame_geometry(anchor: tuple[float, float]):
    """(vertices (N,3), triangles (T,3), colours (T,3)) for the eternal flame."""
    verts: list[tuple[float, float, float]] = []
    tris: list[tuple[int, int, int]] = []
    cols: list[tuple[int, int, int]] = []
    ax, ay = anchor
    ring = tuple((x - ax, y - ay) for x, y in VICTORY_FLAME_RING)

    def tri(a, b, c, colour):
        base = len(verts)
        verts.extend([a, b, c])
        tris.append((base, base + 1, base + 2))
        cols.append(colour)

    # Slab side walls (the ring is CCW, so a->b->b_top winds outward).
    for i in range(len(ring)):
        a = ring[i]
        b = ring[(i + 1) % len(ring)]
        a0 = (a[0], a[1], 0.0)
        b0 = (b[0], b[1], 0.0)
        b1 = (b[0], b[1], VICTORY_FLAME_SLAB_HEIGHT)
        a1 = (a[0], a[1], VICTORY_FLAME_SLAB_HEIGHT)
        tri(a0, b0, b1, VICTORY_FLAME_SLAB_RGB)
        tri(a0, b1, a1, VICTORY_FLAME_SLAB_RGB)
    # Slab deck.
    centre = (VICTORY_FLAME_CENTRE[0] - ax, VICTORY_FLAME_CENTRE[1] - ay)
    top = VICTORY_FLAME_SLAB_HEIGHT
    for i in range(len(ring)):
        a = ring[i]
        b = ring[(i + 1) % len(ring)]
        tri((centre[0], centre[1], top), (a[0], a[1], top), (b[0], b[1], top),
            VICTORY_FLAME_SLAB_RGB)
    # Flame body and hot core: two pyramids on the slab, aligned with the ring.
    for scale, base_y, apex_y, colour in (
        (0.40, top, VICTORY_FLAME_BODY_TOP, VICTORY_FLAME_BODY_RGB),
        (0.16, top + 1.4, VICTORY_FLAME_CORE_TOP, VICTORY_FLAME_CORE_RGB),
    ):
        apex = (centre[0], centre[1], apex_y)
        for i in range(len(ring)):
            a = ring[i]
            b = ring[(i + 1) % len(ring)]
            pa = (centre[0] + (a[0] - centre[0]) * scale,
                  centre[1] + (a[1] - centre[1]) * scale, base_y)
            pb = (centre[0] + (b[0] - centre[0]) * scale,
                  centre[1] + (b[1] - centre[1]) * scale, base_y)
            tri(pa, pb, apex, colour)

    return (np.asarray(verts, dtype=np.float64),
            np.asarray(tris, dtype=np.int64),
            np.asarray(cols, dtype=np.uint8))


def landmark_decoration(slug: str, placement: dict):
    """Per-landmark extra geometry the source GLB does not contain."""
    if slug == "victory-monument":
        return victory_flame_geometry((float(placement["x"]), float(placement["y"])))
    return None


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
        decoration = landmark_decoration(entry["slug"], placement)
        if decoration is not None:
            extra_verts, extra_tri, extra_colors = decoration
            base = int(e.size)
            e = np.concatenate([e, extra_verts[:, 0]])
            n = np.concatenate([n, extra_verts[:, 1]])
            up = np.concatenate([up, extra_verts[:, 2]])
            tri = np.concatenate([tri, extra_tri + base])
            colors = np.concatenate([colors, extra_colors])
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
