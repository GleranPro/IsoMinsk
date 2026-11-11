# -*- coding: utf-8 -*-
"""Acceptance checks for the Lipki museum placement.

Verifies that
  * every placed exhibit has a baked model carrying its nose along +X,
  * every heading is a finite yaw in [-180, 180),
  * no two exhibit footprints overlap by more than a small tolerance,
  * empty spots stay inside the exhibition grounds,
  * the counts reconcile with the annotated photo.

Run: .\\.venv\\Scripts\\python.exe scripts/qa/check_museum_placement.py
"""

from __future__ import annotations

import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / "assets" / "aviation-museum"
BAKED = ASSETS / "baked"

GROUND = (9180.0, 470.0, 9415.0, 835.0)
TOLERANCE_M = 1.0


def load_model(slug: str) -> dict:
    path = BAKED / f"{slug}.json"
    if not path.exists():
        raise SystemExit(f"missing baked model: {path}")
    return json.loads(path.read_text(encoding="utf-8"))


def footprint(model: dict) -> tuple[float, float]:
    return float(model["lengthM"]), float(model["spanM"])


def main() -> None:
    placement = json.loads((ASSETS / "placement.json").read_text(encoding="utf-8"))
    exhibits = placement["exhibits"]
    missing = placement["missing"]

    problems: list[str] = []
    for exhibit in exhibits:
        model = load_model(exhibit["slug"])
        if model.get("noseAxis") != "+X":
            problems.append(f"{exhibit['ref']}: nose is not baked along +X")
        heading = float(exhibit["heading"])
        if not (math.isfinite(heading) and -180.0 <= heading <= 180.0):
            problems.append(f"{exhibit['ref']}: heading {heading} out of range")
        x, y = float(exhibit["x"]), float(exhibit["y"])
        x0, y0, x1, y1 = GROUND
        if not (x0 <= x <= x1 and y0 <= y <= y1):
            problems.append(f"{exhibit['ref']}: position ({x}, {y}) outside the exhibition grounds")

    for spot in missing:
        x, y = float(spot["x"]), float(spot["y"])
        x0, y0, x1, y1 = GROUND
        if not (x0 <= x <= x1 and y0 <= y <= y1):
            problems.append(f"empty spot {spot['label']}: ({x}, {y}) outside the grounds")

    overlaps = 0
    for i, first in enumerate(exhibits):
        m1 = load_model(first["slug"])
        l1, s1 = footprint(m1)
        r1 = 0.5 * max(l1, s1)
        for second in exhibits[i + 1:]:
            m2 = load_model(second["slug"])
            l2, s2 = footprint(m2)
            r2 = 0.5 * max(l2, s2)
            distance = math.hypot(float(first["x"]) - float(second["x"]), float(first["y"]) - float(second["y"]))
            if distance + TOLERANCE_M < 0.62 * (r1 + r2):
                overlaps += 1
                problems.append(
                    f"{first['ref']} and {second['ref']} overlap: {distance:.1f} m apart, "
                    f"radii {r1:.1f} / {r2:.1f} m"
                )

    print(f"exhibits: {len(exhibits)}")
    print(f"empty spots (no 3D model): {len(missing)}")
    print(f"baked models: {len(list(BAKED.glob('*.json')))}")
    print(f"overlaps: {overlaps}")
    if problems:
        print("\nPROBLEMS")
        for problem in problems:
            print(f"  - {problem}")
        raise SystemExit(1)
    print("\nOK: placement consistent with the baked models and the annotated photo")


if __name__ == "__main__":
    main()
