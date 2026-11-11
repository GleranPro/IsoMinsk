# -*- coding: utf-8 -*-
"""Build the Lipki museum placement from the annotated drone photo.

Ground truth is the user's annotation on `drone_grid1.png`:
  * white labels with thin leaders identify the type of each aircraft,
  * red arrows give the NOSE heading relative to north AND mark the aircraft:
    the user places every exhibit at the arrow's tip or middle.

`analysis/drone_nose_arrows.json` holds the arrows (tail -> tip, photo pixels).
`analysis/placement_table.json` is the curated assignment arrow -> model: it was
reviewed against the photo and the user's correction memo (parallel Yak-18 /
MiG-15UTI, two MiG-27 flanking the L-29, MiG-25PU between MiG-27 and Su-17M,
MiG-21SMT between MiG-23UB and MiG-19P, both Su-24M / Yak-28PP / second Yak-40
present).

Position = arrow midpoint (offset by the table where two exhibits would touch);
heading = arrow direction mapped through the photo->local affine, so the camera
tilt of the photo is compensated. Baked models carry the nose along local +X.

Output: assets/aviation-museum/placement.json
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / "assets" / "aviation-museum"
ANALYSIS = ASSETS / "analysis"
TABLE = ANALYSIS / "placement_table.json"
ARROWS = ANALYSIS / "drone_nose_arrows.json"
BLUE = ANALYSIS / "blue_axes_crop.json"
OUT = ASSETS / "placement.json"

# photo px -> local metres (x east, y north); fitted on ten registry-verified aircraft
A = np.array([[0.210128517, -0.005781065], [0.024360907, -0.217185299]])
T = np.array([9190.37425, 807.127018])


def normalize(angle: float) -> float:
    while angle <= -180.0:
        angle += 360.0
    while angle > 180.0:
        angle -= 360.0
    return round(angle, 1)


def arrow_heading(arrow: dict) -> float:
    dx = float(arrow["tip"][0] - arrow["tail"][0])
    dy = float(arrow["tip"][1] - arrow["tail"][1])
    local = np.dot(A, np.array([dx, dy], dtype=float))
    return normalize(math.degrees(math.atan2(local[1], local[0])))


def arrow_centre(arrow: dict) -> tuple[float, float]:
    u = 0.5 * (arrow["tip"][0] + arrow["tail"][0])
    v = 0.5 * (arrow["tip"][1] + arrow["tail"][1])
    x, y = np.dot(A, np.array([u, v], dtype=float)) + T
    return float(x), float(y)


def model_sizes() -> dict[str, float]:
    sizes = {}
    for path in (ASSETS / "baked").glob("*.json"):
        payload = json.loads(path.read_text(encoding="utf-8"))
        sizes[payload["slug"]] = 0.5 * max(float(payload["lengthM"]), float(payload["spanM"]))
    return sizes


def main() -> None:
    table = json.loads(TABLE.read_text(encoding="utf-8"))
    arrows = {int(a["n"]): a for a in json.loads(ARROWS.read_text(encoding="utf-8"))}
    blue = {int(a["n"]): a for a in json.loads(BLUE.read_text(encoding="utf-8"))}
    sizes = model_sizes()

    exhibits = []
    for item in table["exhibits"]:
        if "blue" in item:
            # Blue axis arrow: tail -> nose, the aircraft sits on its middle.
            source = blue[int(item["blue"])]
            note = "ось: синяя стрелка"
        else:
            # Red leader arrow: shows which aircraft the label refers to.
            source = arrows[int(item["arrow"])]
            note = "ось: красная стрелка (синей разметки нет)"
        x, y = arrow_centre(source)
        dx, dy = item.get("offset", [0.0, 0.0])
        exhibits.append(
            {
                "slug": item["slug"],
                "x": round(x + dx, 1),
                "y": round(y + dy, 1),
                "heading": arrow_heading(source),
                "ref": item["ref"],
                "photo": [round(0.5 * (source["tip"][0] + source["tail"][0]), 1),
                          round(0.5 * (source["tip"][1] + source["tail"][1]), 1)],
                "noseArrow": int(item.get("blue", item.get("arrow"))),
                "axisSource": "blue" if "blue" in item else "red",
                "note": note,
            }
        )

    missing = []
    for item in table["missing"]:
        arrow = arrows[int(item["arrow"])]
        x, y = arrow_centre(arrow)
        missing.append(
            {
                "label": item["label"],
                "x": round(x, 1),
                "y": round(y, 1),
                "heading": arrow_heading(arrow),
                "photo": [round(0.5 * (arrow["tip"][0] + arrow["tail"][0]), 1),
                          round(0.5 * (arrow["tip"][1] + arrow["tail"][1]), 1)],
                "noseArrow": int(item["arrow"]),
                "note": "нет 3D-модели — место остаётся пустым",
            }
        )

    # Minimal separation pass: annotations of the dense fighter rows can put two
    # aircraft closer than their wingspans allow. Push footprints apart along the
    # centre line, keeping headings.
    for _ in range(40):
        moved = False
        for i, first in enumerate(exhibits):
            for second in exhibits[i + 1:]:
                radius_a = sizes.get(first["slug"], 5.0)
                radius_b = sizes.get(second["slug"], 5.0)
                minimum = 0.62 * (radius_a + radius_b) + 1.0
                dx = second["x"] - first["x"]
                dy = second["y"] - first["y"]
                distance = math.hypot(dx, dy)
                if distance >= minimum:
                    continue
                if distance < 1e-6:
                    dx, dy, distance = 1.0, 0.0, 1.0
                push = (minimum - distance) / 2.0
                ux, uy = dx / distance, dy / distance
                first["x"] = round(first["x"] - ux * push, 1)
                first["y"] = round(first["y"] - uy * push, 1)
                second["x"] = round(second["x"] + ux * push, 1)
                second["y"] = round(second["y"] + uy * push, 1)
                moved = True
        if not moved:
            break

    document = {
        "area": "Minsk aviation museum, Lipki airfield (UMMI)",
        "coordinateSystem": {
            "origin": "PILOT_CENTER 53.9022N 27.5610E (scripts/geo_config.py)",
            "units": "metres, x east, y north (EPSG:32635 minus origin)",
            "heading": "world yaw degrees CCW from +X (east); every baked model carries its nose along +X",
        },
        "provenance": (
            "Built from the user-annotated drone photo (drone_grid1.png): each exhibit sits on its red "
            "nose arrow (midpoint) and the arrow direction gives the heading, mapped through the "
            "photo->local affine (fitted on ten registry-verified aircraft, rms 4.4 m). Layout reviewed "
            "against the user's correction memo; models without a 3D asset remain empty spots."
        ),
        "dropped": {
            "CRJ200": "not present on the photo (arrived later); the old row was a survey copy",
            "Беркут-ВЛ": "not annotated on the photo (the row duplicated the An-26 leader)",
        },
        "exhibits": exhibits,
        "missing": missing,
    }
    OUT.write_text(json.dumps(document, ensure_ascii=False, indent=1), encoding="utf-8")

    print(f"exhibits: {len(exhibits)} (models), empty spots: {len(missing)}")
    for e in exhibits:
        print(f"  {e['slug']:<11} {e['ref']:<24} ({e['x']:7.1f},{e['y']:6.1f}) heading {e['heading']:7.1f}")


if __name__ == "__main__":
    main()
