# -*- coding: utf-8 -*-
"""Re-bake the museum models with the nose guaranteed along +X.

Input: `data/interim/museum_meshes/<slug>.npz` (dumped by Blender).
Output: `assets/aviation-museum/baked/<slug>.json` and a verification sheet.

The original bake trusted axis-aligned source geometry, which left a third of the
collection rotated 27-58 degrees in plan (Mi-1, Mi-2, Su-17, Tu-134, Yak-40 ...).
This bake measures the fuselage axis from plan-view mirror symmetry (an aircraft
is symmetric about it), normalises the fuselage to +X and then detects which end
carries the tail fin, so the nose points along +X.

Override table: `assets/aviation-museum/analysis/model_nose.json`
    {"<slug>": {"flip": true}}  # force a 180-degree turn after auto-detection
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / "assets" / "aviation-museum"
MESHES = ROOT / "data" / "interim" / "museum_meshes"
BAKED = ASSETS / "baked"
ANALYSIS = ASSETS / "analysis"
OVERRIDES = ANALYSIS / "model_nose.json"
SHEET = ANALYSIS / "model_bake_sheet.png"

# Real length / wingspan (metres).
SPECS = {
    "an-2": (12.4, 18.2),
    "an-26": (23.8, 29.2),
    "citation-x": (22.0, 19.4),
    "il-18": (35.9, 37.4),
    "l-29": (10.6, 10.3),
    "mig-15": (10.1, 10.1),
    "mig-17": (11.3, 9.6),
    "mig-19": (12.6, 9.0),
    "mig-21": (15.8, 7.2),
    "mig-23": (16.7, 7.8),
    "mig-25": (23.8, 14.0),
    "mig-27": (17.1, 7.8),
    "mig-29": (17.3, 11.4),
    "su-17": (18.7, 10.0),
    "su-24": (22.5, 17.6),
    "su-25": (15.5, 14.4),
    "tu-134": (37.1, 29.0),
    "yak-18": (8.6, 10.6),
    "yak-28": (20.0, 12.5),
    "yak-40": (20.4, 25.0),
    "mi-1": (12.1, 14.3),
    "mi-2": (11.4, 14.6),
    "mi-8": (18.2, 21.3),
    "mi-24": (17.5, 17.3),
    "mi-26": (40.0, 32.0),
}

GRID = 256

# Rotor discs dominate the plan bounding box of helicopters, so the length/span
# aspect test that picks the fuselage axis for fixed-wing models cannot be used.
HELICOPTERS = {"mi-1", "mi-2", "mi-8", "mi-24", "mi-26"}


# --------------------------------------------------------------------------- raster
def rasterize(xy: np.ndarray, idx: np.ndarray, size: int = GRID) -> Image.Image:
    lo, hi = xy.min(axis=0), xy.max(axis=0)
    span = max(float((hi - lo).max()), 1e-6)
    pad = 0.05 * span
    scale = (size - 1) / (span + 2 * pad)

    def to_px(p):
        return (
            float((p[0] - lo[0] + pad) * scale),
            float(size - 1 - (p[1] - lo[1] + pad) * scale),
        )

    image = Image.new("L", (size, size), 0)
    draw = ImageDraw.Draw(image)
    for tri in idx:
        draw.polygon([to_px(xy[i]) for i in tri], fill=255)
    return image


def symmetry_angle(mask: Image.Image, coarse: float = 2.0, fine: float = 0.25) -> tuple[float, float]:
    best = (-1.0, 0.0)

    def score(angle: float) -> float:
        rotated = mask.rotate(angle, resample=Image.BILINEAR, expand=False)
        arr = (np.asarray(rotated, dtype=np.float32) / 255.0 > 0.5).astype(np.float32)
        if arr.sum() <= 1:
            return 0.0
        ys, xs = np.nonzero(arr)
        cyi = int(round(float(np.average(ys, weights=arr[ys, xs]))))
        mirrored = np.zeros_like(arr)
        for src in range(arr.shape[0]):
            dst = 2 * cyi - src
            if 0 <= dst < arr.shape[0]:
                mirrored[dst] = arr[src]
        inter = float((arr * mirrored).sum())
        union = float(np.clip(arr + mirrored, 0, 1).sum())
        return inter / union if union else 0.0

    angle = -90.0
    while angle < 90.0:
        value = score(angle)
        if value > best[0]:
            best = (value, angle)
        angle += coarse
    center = best[1]
    angle = center - coarse
    while angle <= center + coarse:
        value = score(angle)
        if value > best[0]:
            best = (value, angle)
        angle += fine
    return best[1], best[0]


def plan_rotate(xy: np.ndarray, degrees: float) -> np.ndarray:
    """Rotate plan coordinates by a mathematical (CCW) angle."""
    a = math.radians(degrees)
    c, s = math.cos(a), math.sin(a)
    return np.stack([xy[:, 0] * c - xy[:, 1] * s, xy[:, 0] * s + xy[:, 1] * c], axis=1)


def subset_mesh(xy: np.ndarray, idx: np.ndarray, keep: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Restrict a mesh to vertices flagged keep, remapping triangle indices."""
    sel = np.nonzero(keep)[0]
    remap = -np.ones(len(xy), dtype=np.int64)
    remap[sel] = np.arange(len(sel), dtype=np.int64)
    triangle_mask = keep[idx].all(axis=1)
    return xy[sel], remap[idx[triangle_mask]]


def align_fuselage(xy: np.ndarray, z: np.ndarray, idx: np.ndarray) -> tuple[np.ndarray, float, float]:
    # Helicopter rotor discs are rotationally symmetric and would win the
    # symmetry search, so measure the fuselage axis on the lower half only.
    zmin, zmax = float(z.min()), float(z.max())
    keep = z <= zmin + 0.6 * (zmax - zmin) if zmax - zmin > 1e-6 else np.ones(len(z), dtype=bool)
    xy_sub, idx_sub = subset_mesh(xy, idx, keep)
    mask = rasterize(xy_sub, idx_sub)
    angle, score = symmetry_angle(mask)
    # PIL rotates counter-clockwise in image space (y down), i.e. clockwise in
    # model space, so apply the opposite sign and let the residual check close.
    rotated = plan_rotate(xy, angle)
    for _ in range(3):
        xy_sub2, idx_sub2 = subset_mesh(rotated, idx, keep)
        mask2 = rasterize(xy_sub2, idx_sub2)
        residual, s2 = symmetry_angle(mask2)
        if abs(residual) < 0.6:
            score = max(score, s2)
            break
        rotated = plan_rotate(rotated, residual)
        angle += residual
    return rotated, angle, score


def nose_direction(xy: np.ndarray, z: np.ndarray, idx: np.ndarray, length: float) -> tuple[int, dict]:
    """Return +1 if the nose is at +X, -1 if at -X, plus diagnostics."""
    xs = xy[:, 0]
    lo, hi = float(xs.min()), float(xs.max())
    bins = 40
    edges = np.linspace(lo, hi, bins + 1)
    max_z = np.zeros(bins)
    span_y = np.zeros(bins)
    area = np.zeros(bins)
    zmin, zmax = float(z.min()), float(z.max())
    low = z <= zmin + 0.55 * (zmax - zmin)
    for i in range(bins):
        mask = (xs >= edges[i]) & (xs < edges[i + 1])
        if not mask.any():
            continue
        max_z[i] = float(z[mask].max())
        span_y[i] = float(xy[mask, 1].max() - xy[mask, 1].min())
        area[i] = float((mask & low).sum())

    z_scale = max(float(max_z.max()), 1e-6)
    span_scale = max(float(span_y.max()), 1e-6)
    fin = (max_z >= 0.70 * z_scale) & (span_y <= 0.30 * span_scale)
    fin_x = float((edges[:-1] + edges[1:])[fin].mean()) if fin.any() else None

    # Area asymmetry: for helicopters the cabin end carries most of the plan area.
    total_area = float(area.sum())
    com_x = float((area * (edges[:-1] + edges[1:]) / 2).sum() / total_area) if total_area else 0.0
    rel_com = (com_x - (lo + hi) / 2) / max(hi - lo, 1e-6)

    rel_fin = None if fin_x is None else (fin_x - (lo + hi) / 2) / max(hi - lo, 1e-6)
    if rel_fin is not None and abs(rel_fin) >= 0.22:
        nose = -int(np.sign(rel_fin))
        method = "fin"
    elif abs(rel_com) >= 0.02:
        nose = int(np.sign(rel_com))
        method = "area"
    else:
        nose = 1
        method = "default"
    diagnostics = {
        "finRel": None if rel_fin is None else round(rel_fin, 3),
        "comRel": round(rel_com, 3),
        "method": method,
    }
    return nose, diagnostics


def transform(slug: str) -> dict:
    data = np.load(MESHES / f"{slug}.npz")
    pos = data["positions"].astype(np.float64).reshape(-1, 3)
    colors = data["colors"].reshape(-1, 3)
    idx = data["indices"].astype(np.int64).reshape(-1, 3)
    xy = pos[:, :2].copy()
    z = pos[:, 2].copy()

    xy, angle, score = align_fuselage(xy, z, idx)
    # After aligning, make sure the longer plan axis (fuselage) is X.
    ext_x = float(xy[:, 0].max() - xy[:, 0].min())
    ext_y = float(xy[:, 1].max() - xy[:, 1].min())
    length, span = SPECS[slug]
    if slug not in HELICOPTERS and abs(ext_x / max(ext_y, 1e-9) - length / span) > abs(
        ext_y / max(ext_x, 1e-9) - length / span
    ):
        xy = plan_rotate(xy, 90.0)
        angle += 90.0

    nose, diagnostics = nose_direction(xy, z, idx, length)
    override = {}
    if OVERRIDES.exists():
        override = json.loads(OVERRIDES.read_text(encoding="utf-8")).get(slug, {})
    if override.get("flip"):
        nose = -nose
        diagnostics["method"] = "override"
    if nose < 0:
        xy = -xy

    lo, hi = xy.min(axis=0), xy.max(axis=0)
    ext_x = float(hi[0] - lo[0])
    ext_y = float(hi[1] - lo[1])
    scale = length / max(ext_x, 1e-6)
    cx, cy = (lo[0] + hi[0]) / 2.0, (lo[1] + hi[1]) / 2.0
    zmin = float(z.min())
    out = np.empty_like(pos)
    out[:, 0] = (xy[:, 0] - cx) * scale
    out[:, 1] = (xy[:, 1] - cy) * scale
    out[:, 2] = (z - zmin) * scale

    return {
        "slug": slug,
        "lengthM": length,
        "spanM": round(ext_y * scale, 2),
        "heightM": round(float(out[:, 2].max()), 2),
        "triangles": int(len(idx) // 3),
        "noseAxis": "+X",
        "bake": diagnostics,
        "symmetryDeg": round(angle, 2),
        "symmetryIou": round(score, 3),
        "positions": [round(float(v), 3) for v in out.reshape(-1)],
        "colors": [int(v) for v in colors.reshape(-1)],
        "indices": [int(v) for v in idx.reshape(-1)],
    }


# --------------------------------------------------------------------------- sheet
CELL = 300


def draw_cell(draw: ImageDraw.ImageDraw, model: dict, box: tuple[int, int]) -> None:
    ox, oy = box
    pos = np.asarray(model["positions"], dtype=float).reshape(-1, 3)
    idx = np.asarray(model["indices"], dtype=int).reshape(-1, 3)
    xy = pos[:, :2]
    lo, hi = xy.min(axis=0), xy.max(axis=0)
    size = max(float(hi[0] - lo[0]), 1e-6)
    scale = (CELL - 24) / size
    cx = ox + CELL / 2 - (lo[0] + hi[0]) / 2 * scale
    cy = oy + CELL / 2 + (lo[1] + hi[1]) / 2 * scale

    order = np.argsort(pos[idx, 2].mean(axis=1))
    for tri in order:
        shade = 150
        pts = []
        for i in idx[tri]:
            pts.append((cx + xy[i, 0] * scale, cy - xy[i, 1] * scale))
        draw.polygon(pts, fill=(shade, shade - 8, shade - 14), outline=(90, 90, 90))

    # Nose marker: big green arrow along +X.
    x_hi = cx + float(hi[0]) * scale
    y_mid = cy - float(xy[:, 1].mean()) * scale
    draw.line([(cx, y_mid), (x_hi + 6, y_mid)], fill=(0, 150, 60), width=2)
    draw.polygon(
        [(x_hi + 12, y_mid), (x_hi, y_mid - 7), (x_hi, y_mid + 7)],
        fill=(0, 150, 60),
    )
    draw.text((ox + 6, oy - 20), model["slug"], fill=(10, 10, 10))


def write_sheet(models: list[dict]) -> None:
    cols = 5
    rows = math.ceil(len(models) / cols)
    sheet = Image.new("RGB", (cols * CELL + 40, rows * (CELL + 22) + 20), (250, 250, 247))
    draw = ImageDraw.Draw(sheet)
    for i, model in enumerate(models):
        col, row = i % cols, i // cols
        ox = 12 + col * CELL
        oy = 18 + row * (CELL + 22) + 18
        draw_cell(draw, model, (ox, oy))
    sheet.save(SHEET)


def main() -> None:
    BAKED.mkdir(parents=True, exist_ok=True)
    models = []
    for slug in sorted(SPECS):
        if not (MESHES / f"{slug}.npz").exists():
            print(f"[skip] {slug}: no mesh")
            continue
        model = transform(slug)
        models.append(model)
        with open(BAKED / f"{slug}.json", "w", encoding="utf-8") as handle:
            json.dump(model, handle, separators=(",", ":"), ensure_ascii=False)
        b = model["bake"]
        print(
            f"[bake] {slug:<11} L{model['lengthM']:5.1f} S{model['spanM']:5.1f} "
            f"axis {model['symmetryDeg']:7.2f} iou {model['symmetryIou']:.3f} "
            f"nose {b['method']:<8} fin {str(b['finRel']):>6} com {b['comRel']}"
        )
    write_sheet(models)
    print(f"[sheet] {SHEET.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
