#!/usr/bin/env python
"""Tree placement audit (B-1): no tree trunk inside a building, water or a carriageway.

Reads the served tiles, so it checks exactly what the browser renders:

    .venv/Scripts/python.exe scripts/qa/tree_audit.py            # pilot tiles
    .venv/Scripts/python.exe scripts/qa/tree_audit.py --dataset city

A tree violates the audit when its trunk point lies strictly inside
- a building volume footprint,
- a `water` / `river` surface,
- a road carriageway (ground stroke `k=road`, buffered by half its width `w`;
  pavements `sw`, kerbs and parking lanes are NOT carriageway),
- a rail/tram track bed (ground stroke `k=rail|tram`, half width).

Prints counts per violation type (mapped / heuristic) and a few examples.
Exit code 1 when any violation is found.
"""

from __future__ import annotations

import argparse
import io
import json
import sys
from collections import Counter
from pathlib import Path

from shapely import STRtree, points
from shapely.geometry import LineString, Polygon

ROOT = Path(__file__).resolve().parents[2]
TILE_DIRS = {"pilot": ROOT / "public/data/tiles", "city": ROOT / "public/data/city-tiles"}


def ring_polygon(rings):
    try:
        poly = Polygon(rings[0], [ring for ring in rings[1:]])
    except Exception:
        return None
    if not poly.is_valid:
        poly = poly.buffer(0)
    return None if poly.is_empty else poly


def stroke_line(stroke):
    coords = stroke.get("p") or []
    pairs = list(zip(coords[0::2], coords[1::2]))
    if len(pairs) < 2:
        return None
    line = LineString(pairs)
    return None if line.length <= 0 else line


def load(dataset: str):
    tiles = sorted(p for p in TILE_DIRS[dataset].glob("*_*.json"))
    if not tiles:
        raise SystemExit(f"no tiles in {TILE_DIRS[dataset]}")
    trees: list[dict] = []
    geoms: dict[str, list] = {"building": [], "water": [], "carriageway": [], "track": []}
    seen_buildings: set = set()
    seen_strokes: set = set()
    for path in tiles:
        tile = json.loads(path.read_text(encoding="utf-8"))
        trees.extend(tile.get("trees") or [])
        for building in tile.get("buildings") or []:
            if building.get("id") in seen_buildings:
                continue
            seen_buildings.add(building.get("id"))
            for volume in building.get("volumes") or []:
                poly = ring_polygon(volume["footprint"])
                if poly is not None:
                    geoms["building"].append(poly)
        for surface in tile.get("surfaces") or []:
            if surface.get("kind") in {"water", "river"}:
                poly = ring_polygon(surface["polygon"])
                if poly is not None:
                    geoms["water"].append(poly)
        for stroke in (tile.get("ground") or {}).get("strokes") or []:
            kind = stroke.get("k")
            if kind not in {"road", "rail", "tram"}:
                continue
            key = (kind, stroke.get("id"), tuple(stroke.get("p") or ()))
            if key in seen_strokes:
                continue
            seen_strokes.add(key)
            line = stroke_line(stroke)
            if line is None:
                continue
            band = line.buffer(float(stroke["w"]) / 2.0, cap_style="flat")
            geoms["carriageway" if kind == "road" else "track"].append(band)
    return tiles, trees, geoms


def main() -> int:
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--dataset", choices=sorted(TILE_DIRS), default="pilot")
    parser.add_argument("--examples", type=int, default=5)
    args = parser.parse_args()

    tiles, trees, geoms = load(args.dataset)
    if not trees:
        print("no trees in the payload")
        return 1
    tree_points = points([t["x"] for t in trees], [t["y"] for t in trees])
    index = STRtree(tree_points)
    counts: Counter = Counter()
    examples: list[str] = []
    flagged: set[int] = set()
    for kind, polys in geoms.items():
        for poly in polys:
            for i in index.query(poly, predicate="contains_properly"):
                i = int(i)
                if (kind, i) in flagged:
                    continue
                flagged.add((kind, i))
                tree = trees[i]
                counts[(kind, "mapped" if tree["mapped"] else "heuristic")] += 1
                if len(examples) < args.examples:
                    examples.append(f"  {kind}: tree at ({tree['x']}, {tree['y']}) mapped={tree['mapped']}")

    mapped = sum(1 for t in trees if t["mapped"])
    print(f"Tree audit ({args.dataset}): {len(tiles)} tiles, {len(trees):,} trees "
          f"({mapped:,} mapped, {len(trees) - mapped:,} heuristic)")
    print("Checked geometry: " + ", ".join(f"{k} {len(v):,}" for k, v in geoms.items()))
    total = sum(counts.values())
    for kind in geoms:
        m, h = counts[(kind, "mapped")], counts[(kind, "heuristic")]
        print(f"  in {kind:<11}: {m + h:>5} (mapped {m}, heuristic {h})")
    if examples:
        print("Examples:")
        print("\n".join(examples))
    print("RESULT: " + ("OK, 0 violations" if total == 0 else f"FAIL, {total} violation(s)"))
    return 0 if total == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
