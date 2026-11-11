"""Place the museum aircraft on the Lipki exhibition grounds.

The layout follows the annotated satellite view: transports along the apron edge
(east row), fighters in the middle rows, helicopters in the western/southern row.
Coordinates are local metres (origin = PILOT_CENTER, x east, y north); models are
baked with the nose along +X, so `heading` is the world yaw in degrees.

Output: assets/aviation-museum/placement.json
"""

from __future__ import annotations

import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / "assets" / "aviation-museum"
OUT = ASSETS / "placement.json"

# Spine of the open-air exhibition: from the hangar end (north-east) towards the
# south-west, matching the diagonal row on the satellite image.
SPINE_START = (9348.0, 776.0)
SPINE_END = (9208.0, 478.0)


def main() -> int:
    dx = SPINE_END[0] - SPINE_START[0]
    dy = SPINE_END[1] - SPINE_START[1]
    length = math.hypot(dx, dy)
    along = (dx / length, dy / length)          # down the exhibition line
    normal = (-along[1], along[0])              # towards the runway (east side)
    heading = math.degrees(math.atan2(normal[1], normal[0]))

    def point(t: float, offset: float) -> tuple[float, float]:
        return (
            round(SPINE_START[0] + along[0] * t + normal[0] * offset, 1),
            round(SPINE_START[1] + along[1] * t + normal[1] * offset, 1),
        )

    def row(slugs: list[str], offset: float, start: float, step: float) -> list[dict]:
        exhibits = []
        for index, slug in enumerate(slugs):
            x, y = point(start + index * step, offset)
            exhibits.append({
                "slug": slug,
                "x": x,
                "y": y,
                "heading": round(heading, 1),
            })
        return exhibits

    # Layout following the annotated satellite image (north at the top).
    # East row along the apron: airliners and transports, big spacing.
    exhibits: list[dict] = []
    exhibits += row(["tu-134", "il-18", "an-26", "citation-x", "yak-40"], 18.0, 22.0, 44.0)
    # Main row west of the path: combat aircraft and trainers.
    exhibits += row(
        ["an-2", "mig-15", "mig-19", "mig-23", "mig-27", "mig-25", "mig-29",
         "mig-17", "su-17", "su-24", "su-25", "mig-21", "yak-28"],
        -16.0, 16.0, 22.0,
    )
    # Outer row towards the forest: trainers, gliders and helicopters.
    exhibits += row(["yak-18", "l-29", "mi-2", "mi-24", "mi-1", "mi-8"], -40.0, 26.0, 24.0)
    # Heavy helicopters near the runway side.
    exhibits += row(["mi-26"], 42.0, 30.0, 26.0)

    document = {
        "area": "Minsk aviation museum, Lipki airfield",
        "spine": {"start": list(SPINE_START), "end": list(SPINE_END)},
        "headingDeg": round(heading, 1),
        "exhibits": exhibits,
        "missing": ["il-14", "su-7", "yak-25", "ka-26"],
    }
    OUT.write_text(json.dumps(document, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"Wrote {OUT.relative_to(ROOT)}: {len(exhibits)} exhibits, heading {heading:.1f}°")
    for exhibit in exhibits:
        print(f"  {exhibit['slug']:<8} ({exhibit['x']:.0f}, {exhibit['y']:.0f})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
