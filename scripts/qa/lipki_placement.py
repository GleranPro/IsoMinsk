# -*- coding: utf-8 -*-
"""FINAL Lipki placement from the user's annotated drone photos.

Ground truth:
 - drone_grid.png : identification arrows (label -> aircraft)
 - drone_grid1.png: nose-direction arrows per aircraft
 - affine drone->local fitted on 10 registry-verified aircraft (rms 4.4 m)
 - aircraft absent from the drone photo (CRJ-200) from the Yandex analysis
 - missing 3D models -> empty spots, listed in `missing`
"""
import json
import math
from pathlib import Path

import numpy as np

BASE = Path("data/interim/lipki_analysis")
ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "assets" / "aviation-museum"

S_IM2, TX_IM2, TY_IM2 = 6.8936, -63212.3, 5125.3

# affine drone px -> local metres (fitted earlier, rms 4.4 m)
_A = np.array([
    [642, 512, 9321.5, 713.1],
    [831, 572, 9357.0, 698.2],
    [746, 706, 9347.8, 671.4],
    [669, 848, 9328.3, 644.9],
    [651, 951, 9320.1, 615.3],
    [586, 1066, 9311.8, 591.1],
    [566, 1192, 9301.0, 562.4],
    [544, 1313, 9291.5, 536.9],
    [453, 1373, 9281.5, 517.3],
    [106, 1366, 9203.5, 511.9],
], dtype=float)
A = np.stack([_A[:, 0], _A[:, 1], np.ones(len(_A))], axis=1)
M, *_ = np.linalg.lstsq(A, _A[:, 2:4], rcond=None)

def drone_to_local(u, v):
    x, y = np.array([u, v, 1.0]) @ M
    return float(x), float(y)

# ---------------------------------------------------------------- ground truth
# label -> (drone x, y, nose azimuth deg) -- positions from ID-arrow heads,
# noses from the matched nose arrows of drone_grid1.png (see reconcile step).
GT = {
    "Ми-1М":        (663, 130, 262.1),
    "Ми-26":        (846, 485, 258.0),
    "Ту-154":       (642, 512, 339.2),
    "Ту-134":       (831, 572, 260.7),
    "МиГ-15УТИ":    (494, 566, 330.9),
    "PZL-104 Вильга": (340, 593, 55.4),
    "L-13 Blaník":  (313, 639, 111.9),
    "Як-52":        (299, 722, 54.6),
    "Ил-18В":       (746, 706, 240.3),
    "МиГ-19П":      (529, 740, 79.9),
    "МиГ-21СМТ":    (419, 766, 172.0),
    "МиГ-23УБ (88)": (503, 743, 353.3),
    "Ан-2Т":        (268, 777, 54.0),
    "МиГ-25ПУ":     (443, 810, 155.8),
    "МиГ-23УБ (2-й)": (529, 810, 167.3),
    "Ан-12Б":       (669, 848, 269.1),
    "МиГ-29 (9-13)": (236, 900, 51.2),
    "Су-17М":       (332, 918, 153.3),
    "МиГ-27К (1)":  (521, 913, 150.1),
    "Як-25М":       (207, 953, 47.2),
    "Ан-24Б":       (651, 951, 269.6),
    "МиГ-25БМ":     (309, 1019, 149.4),
    "МиГ-29УБ":     (376, 1043, 60.3),
    "Ан-26ЛЛ":      (586, 1066, 270.6),
    "МиГ-27К (2)":  (428, 1058, 68.3),
    "Ил-14П":       (566, 1192, 269.1),
    "Ми-24П":       (137, 1227, 60.8),
    "Cessna 750 Citation X": (544, 1313, 282.0),
    "Ка-26":        (90, 1282, 61.5),
    "Ми-8Т":        (106, 1366, 52.4),
    "Як-40 (южн)":  (453, 1373, 273.5),
    "ОВ-1":         (155, 1403, 54.7),
    "Су-24М [25] (южн)": (327, 1454, 290.7),
    "Ми-2У":        (248, 1232, 172.6),
    "Су-7":         (474, 958, 278.0),
    "Л-29":         (522, 985, 262.0),
    "Беркут-ВЛ":    (586, 1066, 147.7),
    "Як-40 (сев)":  (503, 474, 347.5),
    "Су-24М [26] (зап)": (197, 1120, 39.8),
    "Як-28ПП":      (215, 1047, 51.7),
}

# slug per ground-truth label; absent = no 3D model -> empty spot
SLUG_OF = {
    "Ми-26": "mi-26", "Ту-134": "tu-134", "МиГ-15УТИ": "mig-15",
    "Ил-18В": "il-18", "МиГ-19П": "mig-19", "МиГ-21СМТ": "mig-21",
    "МиГ-23УБ (88)": "mig-23", "Ан-2Т": "an-2", "МиГ-25ПУ": "mig-25",
    "МиГ-23УБ (2-й)": "mig-23", "МиГ-27К (1)": "mig-27",
    "МиГ-29 (9-13)": "mig-29", "Су-17М": "su-17", "Як-25М": None,
    "Ан-24Б": None, "МиГ-25БМ": "mig-25", "МиГ-29УБ": "mig-29",
    "Ан-26ЛЛ": "an-26", "МиГ-27К (2)": "mig-27", "Ил-14П": None,
    "Ми-24П": "mi-24", "Cessna 750 Citation X": "citation-x",
    "Ка-26": None, "Ми-8Т": "mi-8", "Як-40 (южн)": "yak-40",
    "ОВ-1": None, "Су-24М [25] (южн)": "su-24", "Ми-1М": "mi-1",
    "CRJ200": None, "Ми-2У": "mi-2", "Су-7": None, "Л-29": "l-29",
    "Беркут-ВЛ": None, "Як-40 (сев)": "yak-40",
    "Су-24М [26] (зап)": "su-24", "Як-28ПП": "yak-28", "Ту-154": None,
    "PZL-104 Вильга": None, "L-13 Blaník": None, "Як-52": None,
}

# baked models' own nose offset in model space (deg CCW from +X)
MODEL_NOSE_THETA = {
    "an-2": 180.0, "an-26": 180.0, "citation-x": 180.0, "il-18": 180.0,
    "l-29": 180.0, "mi-1": 135.0, "mi-2": 135.0, "mi-24": 270.0,
    "mi-26": 180.0, "mi-8": 270.0, "mig-15": 0.0, "mig-17": 225.0,
    "mig-19": 0.0, "mig-21": 0.0, "mig-23": 0.0, "mig-25": 225.0,
    "mig-27": 225.0, "mig-29": 0.0, "su-17": 135.0, "su-24": 0.0,
    "su-25": 180.0, "tu-134": 225.0, "yak-18": 180.0, "yak-28": 180.0,
    "yak-40": 180.0,
}

def normalize(h):
    while h <= -180.0:
        h += 360.0
    while h > 180.0:
        h -= 360.0
    return round(h, 1)

def main():
    exhibits = []
    missing = []
    seen_slug = {}
    for lbl, (du, dv, az) in GT.items():
        x, y = drone_to_local(du, dv)
        slug = SLUG_OF.get(lbl)
        entry = {"label": lbl, "x": round(x, 1), "y": round(y, 1), "nose_az": az}
        if slug is None:
            missing.append(entry)
            continue
        n = seen_slug.get(slug, 0) + 1
        seen_slug[slug] = n
        exhibits.append({
            "slug": slug, "x": round(x, 1), "y": round(y, 1),
            "heading": normalize(90.0 - az - MODEL_NOSE_THETA[slug]),
            "ref": f"{lbl}" + (f" #{n}" if n > 1 else ""),
        })

    # aircraft absent from the drone photo but present now (Yandex analysis)
    exhibits.append({"slug": "mi-2", "x": 9344.5, "y": 740.6,
                     "heading": normalize(90.0 - 178.0 - 135.0),
                     "ref": "Ми-2 [EW-225AO] (перрон)"})
    # МиГ-17 [28] - второй борт пары с МиГ-19П (стрелка пользователя не извлеклась)
    exhibits.append({"slug": "mig-17", "x": 9306.0, "y": 673.0,
                     "heading": normalize(90.0 - 86.0 - 225.0),
                     "ref": "МиГ-17 [28] (пара с МиГ-19П)"})
    # Як-18 [6] - позиция по реестру/блобу, курс по стрелке пользователя
    exhibits.append({"slug": "yak-18", "x": 9286.1, "y": 713.3,
                     "heading": normalize(90.0 - 337.7 - 180.0),
                     "ref": "Як-18 [6]"})
    missing.append({"label": "CRJ200", "x": 9280.4, "y": 503.7,
                    "nose_az": 240.0, "note": "EW-100PJ; в дрон-фото нет, прибыл 2025"})

    json.dump({"exhibits": exhibits, "missing": missing},
              open(BASE / "final_placement_gt.json", "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)

    print(f"exhibits: {len(exhibits)}, empty spots: {len(missing)}")
    for e in exhibits:
        print(f"  {e['slug']:<10} {e['ref']:<22} ({e['x']:7.1f},{e['y']:6.1f}) heading {e['heading']:7.1f}")


if __name__ == "__main__":
    main()
