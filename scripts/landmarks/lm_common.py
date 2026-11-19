# -*- coding: utf-8 -*-
"""Shared helpers for the low-poly landmark pipeline.

Coordinates: local metres, x east / y north, origin = pilot centre (see
scripts/geo_config.py). glTF is y-up with +x east and -z north, so a glTF
vertex (x, y, z) maps to plan (east=x, north=-z, up=y).
"""

from __future__ import annotations

import glob
import io
import json
import math
import struct
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[2]
MODEL_DIR = ROOT / "assets" / "landmarks" / "low-poly"
CATALOG = ROOT / "src" / "shared" / "landmarks" / "catalog.json"
TILE_DIR = ROOT / "public" / "data" / "city-tiles"
TILE_SIZE = 1024.0


@dataclass
class Model:
    slug: str
    path: Path
    positions: np.ndarray  # (N,3) glTF space
    uvs: np.ndarray  # (N,2)
    indices: np.ndarray  # (T,3)
    texture: Image.Image
    node_yaw_deg: float | None

    def plan(self, yaw_deg: float = 0.0, scale: float = 1.0):
        """Plan-view (east, north, up) after yaw (CCW, degrees) and scale."""
        e = self.positions[:, 0] * scale
        n = -self.positions[:, 2] * scale
        up = self.positions[:, 1] * scale
        c, s = math.cos(math.radians(yaw_deg)), math.sin(math.radians(yaw_deg))
        return e * c - n * s, e * s + n * c, up


def _accessor(j, blob, index):
    a = j["accessors"][index]
    bv = j["bufferViews"][a["bufferView"]]
    off = bv.get("byteOffset", 0) + a.get("byteOffset", 0)
    comps = {"SCALAR": 1, "VEC2": 2, "VEC3": 3}[a["type"]]
    dt = {5126: "<f4", 5125: "<u4", 5123: "<u2", 5121: "<u1"}[a["componentType"]]
    return np.frombuffer(blob, dtype=dt, count=a["count"] * comps, offset=off).reshape(a["count"], comps)


def load_glb(path: Path, slug: str) -> Model:
    with open(path, "rb") as handle:
        handle.read(12)
        length, _ = struct.unpack("<II", handle.read(8))
        j = json.loads(handle.read(length).decode("utf-8"))
        handle.read(8)
        blob = handle.read()
    prim = j["meshes"][0]["primitives"][0]
    positions = _accessor(j, blob, prim["attributes"]["POSITION"]).astype(np.float64)
    uvs = _accessor(j, blob, prim["attributes"]["TEXCOORD_0"]).astype(np.float64)
    indices = _accessor(j, blob, prim["indices"]).reshape(-1, 3).astype(np.int64)
    image = j["images"][0]
    bv = j["bufferViews"][image["bufferView"]]
    start = bv.get("byteOffset", 0)
    texture = Image.open(io.BytesIO(blob[start : start + bv["byteLength"]])).convert("RGB")
    q = j["nodes"][0].get("rotation", [0, 0, 0, 1])
    qx, qy, qz, qw = q
    yaw: float | None
    if abs(qx) < 1e-3 and abs(qz) < 1e-3:
        # pure rotation about the vertical axis: keep the mesh raw, remember the yaw as a hint
        yaw = math.degrees(2 * math.atan2(qy, qw))
    else:
        # the author tilted the mesh (z-up export): bake the whole rotation
        r = _quat_matrix(qx, qy, qz, qw)
        positions = positions @ r.T
        positions[:, 1] -= positions[:, 1].min()
        yaw = None
    return Model(slug, Path(path), positions, uvs, indices, texture, yaw)


def _quat_matrix(x, y, z, w):
    return np.array(
        [
            [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
            [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
            [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
        ]
    )


def load_catalog() -> dict:
    return json.loads(CATALOG.read_text(encoding="utf-8"))


def load_models(catalog: dict | None = None) -> dict[str, Model]:
    catalog = catalog or load_catalog()
    return {e["slug"]: load_glb(MODEL_DIR / e["glb"], e["slug"]) for e in catalog["landmarks"]}


# ---------------------------------------------------------------- tiles / OSM

_tile_cache: dict[tuple[int, int], dict] = {}


def load_tile(tx: int, ty: int) -> dict | None:
    key = (tx, ty)
    if key not in _tile_cache:
        path = TILE_DIR / f"{tx}_{ty}.json"
        _tile_cache[key] = json.loads(path.read_text(encoding="utf-8")) if path.exists() else None
    return _tile_cache[key]


def buildings_near(x: float, y: float, radius: float) -> dict[str, dict]:
    """All building features whose tile intersects the window, de-duplicated."""
    found: dict[str, dict] = {}
    x0, x1 = math.floor((x - radius) / TILE_SIZE), math.floor((x + radius) / TILE_SIZE)
    y0, y1 = math.floor((y - radius) / TILE_SIZE), math.floor((y + radius) / TILE_SIZE)
    for tx in range(x0, x1 + 1):
        for ty in range(y0, y1 + 1):
            tile = load_tile(tx, ty)
            if not tile:
                continue
            for b in tile["buildings"]:
                found.setdefault(b["id"], b)
    return found


def building_rings(building: dict) -> list[list[list[float]]]:
    """Exterior rings of every volume (de-overlapped parts)."""
    rings = []
    for vol in building.get("volumes", []):
        for poly in vol["footprint"][:1]:
            rings.append(poly)
    return rings


def building_outline_rings(building: dict) -> list[list[list[float]]]:
    outline = building.get("outline")
    if outline:
        return [outline[0]]
    return building_rings(building)


def ring_centroid(ring) -> tuple[float, float]:
    xs = [p[0] for p in ring]
    ys = [p[1] for p in ring]
    return sum(xs) / len(xs), sum(ys) / len(ys)


def building_center(building: dict) -> tuple[float, float]:
    rings = building_rings(building)
    pts = [p for ring in rings for p in ring]
    return (min(p[0] for p in pts) + max(p[0] for p in pts)) / 2, (
        min(p[1] for p in pts) + max(p[1] for p in pts)
    ) / 2


# ---------------------------------------------------------------- rasterising

PPM = 2.0  # pixels per metre


class Raster:
    """Square window (metres) centred on (cx, cy)."""

    def __init__(self, cx: float, cy: float, half: float, ppm: float = PPM):
        self.cx, self.cy, self.half, self.ppm = cx, cy, half, ppm
        self.size = int(2 * half * ppm)

    def px(self, x, y):
        return (np.asarray(x) - self.cx + self.half) * self.ppm, (self.half - (np.asarray(y) - self.cy)) * self.ppm

    def blank(self):
        return Image.new("L", (self.size, self.size), 0)

    def polygon(self, draw: ImageDraw.ImageDraw, ring, fill=255):
        xs, ys = self.px([p[0] for p in ring], [p[1] for p in ring])
        draw.polygon(list(zip(xs.tolist(), ys.tolist())), fill=fill)

    def rings_mask(self, rings) -> np.ndarray:
        img = self.blank()
        d = ImageDraw.Draw(img)
        for ring in rings:
            self.polygon(d, ring)
        return np.asarray(img) > 0

    def triangles_mask(self, e, n, tris) -> np.ndarray:
        img = self.blank()
        d = ImageDraw.Draw(img)
        px, py = self.px(e, n)
        for t in tris:
            d.polygon([(px[i], py[i]) for i in t], fill=255)
        return np.asarray(img) > 0
