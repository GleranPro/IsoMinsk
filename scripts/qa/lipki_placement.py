# -*- coding: utf-8 -*-
"""Real Lipki exhibit placement from the satellite-image analysis.

Replaces the synthetic grid in `assets/aviation-museum/placement.json` with the
positions and headings measured on the clean Yandex screenshot
(`analysis/final_dataset.json`, see `analysis/report_lipki.md`):

* coordinates: local metres, origin = PILOT_CENTER (53.9022 N, 27.5610 E),
  x east, y north - the same frame `scripts/geo_config.py` uses;
* heading: world yaw in degrees CCW from +X (east). Baked models carry the
  nose along +X, so `heading = 90 deg - nose azimuth (compass, 0 = N, CW)`;
* aircraft whose 3D model is missing get NO placeholder - their spots stay
  empty and are listed in `missing` with measured positions.

Sources: registry aviapix.ru (GPS per exhibit), museum inventory
(aircraft-museum.ucoz.ru, kpopov.ru), OSM, and the programmatic contour
analysis in `analysis/`.
"""
from __future__ import annotations

import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / "assets" / "aviation-museum"
ANALYSIS = ASSETS / "analysis" / "final_dataset.json"
OUT = ASSETS / "placement.json"

# slug per analysed object id (only types that have baked 3D models)
SLUG_OF = {
    "A01": "su-24",      # Су-24М [25]
    "A04": "yak-40",     # Як-40 [EW-88187]
    "A05": "citation-x", # Cessna 750 Citation X
    "A08": "mi-2",       # Ми-2У [EW-121AO]
    "A11": "su-24",      # Су-24М [26]
    "A12": "su-25",      # Су-25 [51]
    "A13": "an-26",      # Ан-26ЛЛ [22]
    "A14": "mig-27",     # МиГ-27К [05]
    "A15": "mig-29",     # МиГ-29УБ [65]
    "A16": "yak-28",     # Як-28ПП [14]
    "A17": "mig-25",     # МиГ-25БМ [78]
    "A21": "mig-27",     # МиГ-27К [17]
    "A22": "mig-29",     # МиГ-29 (9-13) [29]
    "A23": "mig-25",     # МиГ-25ПУ [20]
    "A24": "su-17",      # Су-17М [35]
    "A25": "mig-23",     # МиГ-23УБ [95]
    "A26": "mig-23",     # МиГ-23УБ [71] «88 белый»
    "A28": "mig-21",     # МиГ-21СМТ [53]
    "A31": "il-18",      # Ил-18В [СССР-75781]
    "A33": "mig-19",     # МиГ-19П [11]
    "A34": "mig-17",     # МиГ-17 [28]
    "A37": "tu-134",     # Ту-134А [СССР-65038]
    "A39": "mig-15",     # МиГ-15УТИ [18]
    "A40": "yak-18",     # Як-18 [6]
    "A41": "yak-40",     # Як-40 [СССР-87855]
    "A42": "mi-26",      # Ми-26 [07]
    "A43": "mi-2",       # Ми-2 [EW-225AO] (на перроне у входа)
    "A44": "mi-8",       # Ми-8Т [36]
    "A45": "an-2",       # Ан-2Т [СССР-48527]
}

# nose-azimuth corrections applied after visual re-check (see report)
NOSE_OVERRIDES = {
    "A01": 250,  # Су-24М [25]: нос на ЗЮЗ (правило дальнего конца ошиблось из-за тени)
    "A13": 45,   # Ан-26: нос на СВ, как весь восточный ряд (otsu-блоб был смещён тенью)
    "A14": 210,  # МиГ-27К [05]: нос на ЮЮЗ, как у парного МиГ-27К [17]
}

# measured/estimated entries not present in the analysis JSON
MANUAL = [
    {"slug": "mi-24", "x": 9210.0, "y": 541.0, "heading": -130.0, "ref": "visual",
     "note": "Ми-24П [16]: тёмный камуфляж не сегментировался; центр и курс по фото-кропу"},
    {"slug": "l-29", "x": 9297.0, "y": 588.0, "heading": -160.0, "ref": "visual",
     "note": "Л-29 [34]: положение триангуляцией по трём ориентирам на дрон-фото, курс оценочный"},
    {"slug": "mi-1", "x": 9327.5, "y": 796.7, "heading": 28.0, "ref": "registry",
     "note": "Ми-1М [27]: вне кадра скриншота, позиция из реестра aviapix; курс приближённый"},
]

# aircraft at measured spots but without a 3D model - leave empty, record them
MISSING = [
    {"type": "tu-154", "x": 9325.0, "y": 706.0, "note": "Ту-154М EW-85815, борт президента РБ (A38)"},
    {"type": "crj-100", "x": 9280.0, "y": 504.0, "note": "Bombardier CRJ-100ER EW-100PJ (A03)"},
    {"type": "il-14", "x": 9301.0, "y": 561.0, "note": "Ил-14М СССР-41865 (A10)"},
    {"type": "su-7", "x": 9275.0, "y": 536.0, "note": "Су-7БМК [71] (A06)"},
    {"type": "su-27", "x": 9216.0, "y": 560.0, "note": "Су-27П [19], под навесом у ЮЗ угла (A09)"},
    {"type": "yak-25", "x": 9236.0, "y": 613.0, "note": "Як-25М [10] (A20)"},
    {"type": "l-13", "x": 9261.0, "y": 690.0, "note": "планер Let L-13 Blaník EW-103AS (A35, в паре с SZD-48)"},
    {"type": "szd-48", "x": 9261.0, "y": 690.0, "note": "планер PZL-Bielsko SZD-48 Jantar Standard EW-107AS (A36, в паре с L-13)"},
    {"type": "pzl-104", "x": 9252.0, "y": 660.0, "note": "PZL-104 Вильга EW-1525OA (A29)"},
    {"type": "yak-52", "x": 9258.0, "y": 675.0, "note": "Як-52 EW-32070HM (A32)"},
    {"type": "l-39", "x": 9276.0, "y": 661.0, "note": "вероятно Aero L-39C [05], прибыл 06.2026 (A30)"},
    {"type": "ka-26", "x": 9208.0, "y": 531.0, "note": "Ка-26 EW-331CM (A07/реестр)"},
    {"type": "ka-26", "x": 9175.0, "y": 542.0, "note": "Ка-26 №055 EW-24304 у западной кромки кадра"},
    {"type": "berkut-vl", "x": 9304.0, "y": 609.0, "note": "опытный вертолёт «Беркут-ВЛ» [001] (A18)"},
    {"type": "ow-1", "x": 9211.0, "y": 503.0, "note": "кольцеплан Нарушевича ОВ-1 EW-555AO (A02)"},
]


def heading_from_azimuth(az: float) -> float:
    """Compass nose azimuth (0=N, CW) -> world yaw CCW from +X (east)."""
    h = 90.0 - az
    while h <= -180.0:
        h += 360.0
    while h > 180.0:
        h -= 360.0
    return round(h, 1)


def main() -> int:
    analysis = json.loads(ANALYSIS.read_text(encoding="utf-8"))
    by_id = {a["id"]: a for a in analysis["aircraft"]}

    exhibits = []
    for aid, slug in SLUG_OF.items():
        a = by_id[aid]
        x, y = a["centroid_local_m"]
        nose = NOSE_OVERRIDES.get(aid, a["nose_az_deg"])
        exhibits.append({
            "slug": slug,
            "x": round(x, 1),
            "y": round(y, 1),
            "heading": heading_from_azimuth(nose),
            "ref": aid,
            "note": a["name"],
        })

    for m in MANUAL:
        exhibits.append({
            "slug": m["slug"],
            "x": m["x"],
            "y": m["y"],
            "heading": m["heading"],
            "ref": m["ref"],
            "note": m["note"],
        })

    # sanity: every exhibit must have a baked model
    baked = {p.stem for p in (ASSETS / "baked").glob("*.json")}
    unknown = sorted({e["slug"] for e in exhibits} - baked)
    if unknown:
        raise SystemExit(f"no baked model for: {unknown}")

    document = {
        "area": "Minsk aviation museum, Lipki airfield (UMMI)",
        "coordinateSystem": {
            "origin": "PILOT_CENTER 53.9022N 27.5610E (scripts/geo_config.py)",
            "units": "metres, x east, y north (EPSG:32635 minus origin)",
            "heading": "world yaw deg CCW from +X (east); model nose is baked along +X",
        },
        "provenance": (
            "Positions/headings measured programmatically on the clean Yandex "
            "screenshot (analysis/final_dataset.json) and matched to the exhibit "
            "registry (aviapix.ru) + museum inventory (aircraft-museum.ucoz.ru); "
            "see analysis/report_lipki.md"
        ),
        "exhibits": exhibits,
        "missing": MISSING,
    }
    OUT.write_text(json.dumps(document, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"Wrote {OUT.relative_to(ROOT)}: {len(exhibits)} exhibits, {len(MISSING)} empty spots")
    for e in exhibits:
        print(f"  {e['slug']:<10} ref={e['ref']:<7} ({e['x']:7.1f}, {e['y']:6.1f})  heading {e['heading']:7.1f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
