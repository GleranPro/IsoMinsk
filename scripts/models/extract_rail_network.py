# -*- coding: utf-8 -*-
"""Extract railway centrelines from the accepted city tiles.

Reads `public/data/city-tiles/*.json`, collects `ground.strokes` with
`k == 'rail'` (ground-level only: `b !== 1`), deduplicates the per-tile
clipping copies and writes the compact runtime payload:

    public/data/mobility/rail/network.json

The payload feeds the ambient rail-traffic layer (`src/engine/rail`). It is a
*visual model*: OSM gives the geometry, but there is no public timetable for
commuter or freight services, so the layer animates trains along these
segments without stops.

Stitching across junctions was tried and rejected: tile-clipped strokes
duplicate each other near tile borders, and every merge rule ended up
chaining *different* lines into city-spanning zig-zags. The payload therefore
ships the longest individual track pieces (each is a genuine OSM way piece,
up to ~1.4 km). The wrap at a segment end happens off-screen for almost any
camera position, and geometry stays exactly what OSM says.

Bridge-deck rails (`ground.decks`) are intentionally excluded: they have no
elevation in this payload, and a train floating over a bridge would look
worse than a gap.

Usage (from the repo root):
    .venv/Scripts/python.exe scripts/models/extract_rail_network.py
"""

from __future__ import annotations

import datetime as _dt
import glob
import json
import math
import os

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
TILES_DIR = os.path.join(ROOT, "public", "data", "city-tiles")
OUTPUT_DIR = os.path.join(ROOT, "public", "data", "mobility", "rail")

PAYLOAD_VERSION = 1
# Segments shorter than this are sidings/stubs and never receive a train.
MIN_CHAIN_M = 500.0
MAX_CHAINS = 48

# Tile clipping duplicates the same physical track in adjacent tiles with
# slightly different endpoints. A coarse signature (endpoints + length)
# collapses those copies.
SIGNATURE_SNAP_M = 32.0
SIGNATURE_LENGTH_M = 25.0


def stroke_key(stroke: dict) -> bool:
    if stroke.get("k") != "rail":
        return False
    if stroke.get("b") == 1:
        return False
    points = stroke.get("p")
    return isinstance(points, list) and len(points) >= 6 and len(points) % 2 == 0


def quantize(value: float, step: float) -> int:
    return int(round(value / step))


def polyline_length(points: list[float]) -> float:
    length = 0.0
    for index in range(2, len(points), 2):
        dx = points[index] - points[index - 2]
        dy = points[index + 1] - points[index - 1]
        length += math.hypot(dx, dy)
    return length


def signature_for(points: list[float]) -> tuple:
    start = (
        quantize(points[0], SIGNATURE_SNAP_M),
        quantize(points[1], SIGNATURE_SNAP_M),
    )
    end = (
        quantize(points[-2], SIGNATURE_SNAP_M),
        quantize(points[-1], SIGNATURE_SNAP_M),
    )
    if start > end:
        start, end = end, start
    length_bucket = int(polyline_length(points) / SIGNATURE_LENGTH_M)
    return (start, end, length_bucket)


def simplify(points: list[float], tolerance: float = 1.5) -> list[float]:
    """Douglas-Peucker on a flat polyline; keeps the payload small."""
    if len(points) <= 6:
        return points

    def perpendicular(point, start, end) -> float:
        dx, dy = end[0] - start[0], end[1] - start[1]
        length = math.hypot(dx, dy)
        if length < 1e-9:
            return math.hypot(point[0] - start[0], point[1] - start[1])
        return abs((point[0] - start[0]) * dy - (point[1] - start[1]) * dx) / length

    def simplify_range(lo: int, hi: int) -> list[int]:
        if hi <= lo + 1:
            return [lo, hi]
        start = (points[lo * 2], points[lo * 2 + 1])
        end = (points[hi * 2], points[hi * 2 + 1])
        best_index, best_distance = lo, -1.0
        for index in range(lo + 1, hi):
            distance = perpendicular(
                (points[index * 2], points[index * 2 + 1]), start, end
            )
            if distance > best_distance:
                best_index, best_distance = index, distance
        if best_distance <= tolerance:
            return [lo, hi]
        left = simplify_range(lo, best_index)
        right = simplify_range(best_index, hi)
        return left[:-1] + right

    keep = simplify_range(0, len(points) // 2 - 1)
    result: list[float] = []
    for index in keep:
        result.extend((points[index * 2], points[index * 2 + 1]))
    return result


def collect_strokes() -> list[dict]:
    """Collect ground-level rail strokes and drop tile-clipping duplicates."""
    strokes: list[dict] = []
    signatures: dict[tuple, dict] = {}
    files = sorted(glob.glob(os.path.join(TILES_DIR, "*.json")))
    if not files:
        raise SystemExit(f"no city tiles found in {TILES_DIR}")
    seen = 0
    for path in files:
        with open(path, encoding="utf-8") as handle:
            tile = json.load(handle)
        ground = tile.get("ground") or {}
        for stroke in ground.get("strokes") or []:
            if not stroke_key(stroke):
                continue
            seen += 1
            points = list(stroke["p"])
            length = polyline_length(points)
            if length < MIN_CHAIN_M:
                continue
            signature = signature_for(points)
            known = signatures.get(signature)
            if known is not None:
                if length > known["lengthM"]:
                    known["points"] = points
                    known["lengthM"] = length
                continue
            item = {"points": points, "lengthM": length}
            signatures[signature] = item
            strokes.append(item)
    print(f"[rail] tiles={len(files)} railStrokes={seen} longUnique={len(strokes)}")
    return strokes


def main() -> None:
    strokes = collect_strokes()
    strokes.sort(key=lambda item: item["lengthM"], reverse=True)
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    segments = []
    for index, chain in enumerate(strokes[:MAX_CHAINS]):
        rounded = [round(value, 1) for value in simplify(chain["points"])]
        segments.append(
            {
                "id": f"rail-{index:03d}",
                "lengthM": round(chain["lengthM"], 1),
                "points": rounded,
            }
        )
    payload = {
        "version": PAYLOAD_VERSION,
        "generatedAt": _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": "OpenStreetMap ground strokes (railway=rail), extracted from the accepted city tiles",
        "licence": "(c) OpenStreetMap contributors, ODbL 1.0",
        "note": (
            "Visual ambient model: trains follow these segments without a timetable. "
            "Segments are individual OSM way pieces, not stitched across junctions; "
            "bridge-deck rails are not included (no elevation in the tile payload)."
        ),
        "minChainM": MIN_CHAIN_M,
        "segments": segments,
    }
    output = os.path.join(OUTPUT_DIR, "network.json")
    with open(output, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=1)
        handle.write("\n")
    total = sum(segment["lengthM"] for segment in segments)
    print(
        f"[rail] segments={len(segments)} totalKm={total / 1000:.1f} "
        f"bytes={os.path.getsize(output)} -> {output}"
    )


if __name__ == "__main__":
    main()
