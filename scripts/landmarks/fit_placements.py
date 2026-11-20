# -*- coding: utf-8 -*-
"""Fit every low-poly landmark model onto the OSM footprints it represents.

Models are authored at real-world size (accessor extents match the OSM
footprints), so the fit searches yaw + translation (+ a small scale range) by
maximising IoU between the model's top-view silhouette and the union of the
catalog entry's `fitTo` footprints. Node translation/scale inside the GLBs come
from an arbitrary Blender layout and are ignored.

Writes `placement` {x, y, yaw, scale, iou} back into the catalog (mesh origin in
local metres + CCW yaw in degrees) and renders an overlay PNG per landmark to
.tmp/landmarks/fit/.

Usage: fit_placements.py [slug ...]
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).parent))
from lm_common import *  # noqa: E402,F403

OUT = ROOT / ".tmp" / "landmarks" / "fit"
HALF = 200.0


def fit_rings_for(entry, buildings):
    rings = []
    for bid in entry["fitTo"]:
        b = buildings.get(bid)
        if b is None:
            print("   !! fitTo id missing from tiles:", bid)
            continue
        rings += building_outline_rings(b)
    return rings


def fit_one(entry, model, buildings, anchor):
    ras = Raster(anchor[0], anchor[1], HALF)
    target = ras.rings_mask(fit_rings_for(entry, buildings)).astype(np.float32)
    area_o = float(target.sum())
    target_fft = np.conj(np.fft.rfft2(target))
    mras = Raster(0, 0, HALF)

    def evaluate(yaw, scale):
        e, n, _ = model.plan(yaw, scale)
        ce, cn = (e.min() + e.max()) / 2, (n.min() + n.max()) / 2
        m = mras.triangles_mask(e - ce, n - cn, model.indices).astype(np.float32)
        r = np.fft.irfft2(target_fft * np.fft.rfft2(m), s=m.shape)
        # r[d] = sum_p target(p) * m(p + d): the model must move by -d to overlap
        idx = np.unravel_index(np.argmax(r), r.shape)
        inter = float(r[idx])
        area_m = float(m.sum())
        iou = inter / (area_m + area_o - inter + 1e-9)
        dy, dx = idx
        if dy > ras.size // 2:
            dy -= ras.size
        if dx > ras.size // 2:
            dx -= ras.size
        return iou, -dx / ras.ppm, dy / ras.ppm, ce, cn

    hint = model.node_yaw_deg
    if hint is None or entry.get("yawFree"):
        coarse_yaws = [float(v) for v in np.arange(-180, 180, 3.0)]
    else:
        coarse_yaws = [float(hint + d) for d in np.arange(-6, 6.01, 1.0)]
    scales = entry.get("scales", [round(v, 2) for v in np.arange(0.94, 1.041, 0.02)])
    coarse = []
    for yaw in coarse_yaws:
        iou, *_ = evaluate(yaw, scales[len(scales) // 2])
        coarse.append((iou, yaw))
    coarse.sort(reverse=True)
    print("   coarse top:", [(round(i, 3), round(y, 1)) for i, y in coarse[:3]])
    refined = []
    for _, yaw0 in coarse[:2]:
        for yaw in np.arange(yaw0 - 1.5, yaw0 + 1.51, 0.5):
            for scale in scales:
                iou, sx, sy, ce, cn = evaluate(float(yaw), scale)
                refined.append((iou, float(yaw), scale, sx, sy, ce, cn))
    refined.sort(reverse=True)
    iou, yaw, scale, sx, sy, ce, cn = refined[0]
    placement = {
        "x": round(float(anchor[0] + sx - ce), 2),
        "y": round(float(anchor[1] + sy - cn), 2),
        "yaw": round(float(yaw), 2),
        "scale": float(scale),
        "iou": round(float(iou), 3),
    }
    node_iou = evaluate(model.node_yaw_deg, 1.0)[0] if model.node_yaw_deg is not None else float('nan')
    return placement, node_iou


def render(entry, model, buildings, placement, anchor, cover=None):
    OUT.mkdir(parents=True, exist_ok=True)
    half = 150
    ras = Raster(anchor[0], anchor[1], half, 4.0)
    img = Image.new("RGB", (ras.size, ras.size), (244, 244, 246))
    d = ImageDraw.Draw(img, "RGBA")
    for bid, b in buildings.items():
        cx, cy = building_center(b)
        if abs(cx - anchor[0]) > half + 60 or abs(cy - anchor[1]) > half + 60:
            continue
        hit = bid in entry["fitTo"]
        covered = (cover or {}).get(bid, 0) >= COVER_HIDE
        for ring in building_rings(b):
            xs, ys = ras.px([p[0] for p in ring], [p[1] for p in ring])
            d.polygon(
                list(zip(xs.tolist(), ys.tolist())),
                fill=(70, 120, 200, 150) if hit else ((235, 170, 60, 150) if covered else (130, 130, 130, 120)),
                outline=(30, 60, 140, 255) if hit else (90, 90, 90, 255),
            )
    e, n, _ = model.plan(placement["yaw"], placement["scale"])
    px, py = ras.px(e + placement["x"], n + placement["y"])
    for t in model.indices:
        d.polygon([(float(px[i]), float(py[i])) for i in t], fill=(230, 60, 60, 60))
    for bid, b in buildings.items():
        cx, cy = building_center(b)
        if abs(cx - anchor[0]) > half or abs(cy - anchor[1]) > half:
            continue
        x, y = ras.px(cx, cy)
        d.text((float(x) - 20, float(y) - 5), bid[1:], fill=(0, 0, 0, 255))
    d.text(
        (6, 4),
        f"{entry['slug']} yaw={placement['yaw']} s={placement['scale']} iou={placement['iou']}",
        fill=(0, 0, 0, 255),
    )
    img.save(OUT / f"{entry['slug']}.png")


COVER_HIDE = 0.45


def place_point(entry, model, anchor):
    """Anchor a model by one point: the centre of its upper part (the shaft of an
    obelisk, the statue) sits on the OSM node/way centroid; yaw is given."""
    cfg = entry["point"]
    scale = float(cfg.get("scale", 1.0))
    if "targetHeight" in cfg:
        scale = float(cfg["targetHeight"]) / float(model.positions[:, 1].max())
    yaw = float(cfg.get("yaw", model.node_yaw_deg or 0.0))
    e, n, up = model.plan(yaw, scale)
    use = np.unique(model.indices[(up[model.indices] >= cfg.get("sliceMinUp", 0) * scale).all(axis=1)])
    if len(use) == 0:
        use = np.arange(len(e))
    ce, cn = float(e[use].mean()), float(n[use].mean())
    dx, dy = cfg.get("offset", (0.0, 0.0))  # imagery-measured shift from the OSM anchor, metres east/north
    return {
        "x": round(anchor[0] + dx - ce, 2),
        "y": round(anchor[1] + dy - cn, 2),
        "yaw": round(yaw, 2),
        "scale": round(scale, 4),
        "iou": None,
    }


def coverage(model, buildings, placement, anchor):
    """Fraction of each nearby building's footprint lying under the model silhouette."""
    ras = Raster(anchor[0], anchor[1], HALF)
    e, n, _ = model.plan(placement["yaw"], placement["scale"])
    mask = ras.triangles_mask(e + placement["x"], n + placement["y"], model.indices)
    out = {}
    for bid, b in buildings.items():
        cx, cy = building_center(b)
        if abs(cx - anchor[0]) > HALF - 5 or abs(cy - anchor[1]) > HALF - 5:
            continue
        bm = ras.rings_mask(building_rings(b))
        area = bm.sum()
        if area == 0:
            continue
        frac = float((bm & mask).sum() / area)
        if frac > 0.05:
            out[bid] = round(frac, 3)
    return out


def hide_list(entry, cover, buildings):
    """OSM buildings the model replaces: the fit targets plus everything mostly under it."""
    ids = set(entry["fitTo"]) | {bid for bid, frac in cover.items() if frac >= COVER_HIDE}
    return sorted(i for i in ids if i in buildings)


def cover_rows(cover, buildings):
    return [(bid, f, buildings[bid]) for bid, f in sorted(cover.items(), key=lambda kv: -kv[1])]


def main():
    only = set(sys.argv[1:])
    catalog = load_catalog()
    osm = json.loads((ROOT / ".tmp" / "osm_landmarks.json").read_text(encoding="utf-8"))
    by_osm = {v["osm"].replace("way/", "w").replace("node/", "n"): v for v in osm.values()}
    models = load_models(catalog)
    for entry in catalog["landmarks"]:
        if only and entry["slug"] not in only:
            continue
        print("##", entry["slug"])
        if entry.get("status") == "unplaced":
            print("   skipped (unplaced)")
            entry.pop("placement", None)
            entry.pop("hide", None)
            continue
        cx, cy = by_osm[entry["osm"]]["centroid"]
        model = models[entry["slug"]]
        if entry.get("point"):
            placement = place_point(entry, model, (cx, cy))
            print("   point placement:", placement)
            entry["placement"] = placement
            buildings = buildings_near(cx, cy, 400)
            cover = coverage(model, buildings, placement, (cx, cy))
            entry["hide"] = hide_list(entry, cover, buildings)
            for bid, frac, b in cover_rows(cover, buildings):
                print(f"   {'FIT' if bid in entry['fitTo'] else '   '} {bid:>12} cov={frac:.2f} h={b['height']:>5}")
            render(entry, model, buildings, placement, (cx, cy), cover)
            continue
        if not entry["fitTo"]:
            print("   node landmark: anchored at the OSM node, yaw from node (review manually)")
            entry["placement"] = {
                "x": cx,
                "y": cy,
                "yaw": round(model.node_yaw_deg or 0.0, 2),
                "scale": 1.0,
                "iou": None,
            }
            continue
        buildings = buildings_near(cx, cy, 400)
        placement, node_iou = fit_one(entry, model, buildings, (cx, cy))
        print("   fit:", placement, "| IoU at node yaw:", round(node_iou, 3), "node yaw:", model.node_yaw_deg and round(model.node_yaw_deg, 1))
        entry["placement"] = placement
        cover = coverage(model, buildings, placement, (cx, cy))
        entry["hide"] = hide_list(entry, cover, buildings)
        for bid, frac, b in cover_rows(cover, buildings):
            mark = "FIT" if bid in entry["fitTo"] else "   "
            print(f"   {mark} {bid:>12} cov={frac:.2f} h={b['height']:>5} {b.get('name') or ''}".encode("ascii", "replace").decode())
        render(entry, model, buildings, placement, (cx, cy), cover)
    CATALOG.write_text(json.dumps(catalog, ensure_ascii=False, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
