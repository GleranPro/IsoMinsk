"""Aerodrome surfaces (B-2): runways, taxiways, aprons and helipads.

OSM maps the Lipki airfield as `aeroway=*` ways. The building pipeline ignores
them, so the airfield rendered as empty grass. These records feed the existing
ground raster compositor instead: runways and taxiways become wide concrete
strokes, aprons and helipads become concrete fills. No new payload section and
no new renderer pass are needed.
"""

from __future__ import annotations

from collections import Counter
from typing import Sequence

DEFAULT_WIDTHS = {"runway": 40.0, "taxiway": 18.0}
MAX_WIDTH = 120.0
MIN_FILL_AREA = 20.0


def _flat(geometry) -> list[float]:
    coords = (
        geometry.exterior.coords
        if geometry.geom_type == "Polygon"
        else geometry.coords
    )
    out: list[float] = []
    for x, y in coords:
        out.extend((round(float(x), 2), round(float(y), 2)))
    return out


def _width(tags: dict, kind: str) -> float:
    raw = (tags.get("width") or "").strip().lower().replace("m", "").replace(",", ".")
    try:
        value = float(raw)
    except ValueError:
        value = 0.0
    if not (1.0 <= value <= MAX_WIDTH):
        value = DEFAULT_WIDTHS.get(kind, 20.0)
    return value


def _material(tags: dict) -> str:
    surface = (tags.get("surface") or "").strip().lower()
    if surface in {"asphalt", "chipseal"}:
        return "asphalt"
    return "concrete"


def build_aeroway(features: Sequence[dict]) -> tuple[list[dict], list[dict], dict]:
    """(strokes, fills, stats) for the ground raster compositor.

    `features` come from the normaliser projection: `{"osm_id", "tags",
    "type": "line"|"polygon", "line"|"polygon"}` in local metres.
    """
    strokes: list[dict] = []
    fills: list[dict] = []
    stats: Counter = Counter()
    for index, feature in enumerate(features):
        tags = feature.get("tags") or {}
        kind = tags.get("aeroway") or ""
        material = _material(tags)
        if feature.get("type") == "line" and kind in {"runway", "taxiway"}:
            line = feature.get("line")
            if line is None or line.is_empty or line.length < 1.0:
                continue
            strokes.append({
                "id": int(feature.get("osm_id") or index),
                "k": "aeroway",
                "c": "service",
                "w": round(_width(tags, kind), 2),
                "p": _flat(line),
                "s0": 0.0,
                "r": 0,
                "mat": material,
            })
            stats["strokes"] += 1
            stats[f"stroke_{kind}"] += 1
        elif feature.get("type") == "polygon" and kind in {"apron", "helipad"}:
            poly = feature.get("polygon")
            if poly is None or poly.is_empty or poly.area < MIN_FILL_AREA:
                continue
            fills.append({"m": material, "c": "service", "p": _flat(poly)})
            stats["fills"] += 1
            stats[f"fill_{kind}"] += 1
    return strokes, fills, dict(stats)
