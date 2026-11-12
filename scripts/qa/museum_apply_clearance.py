# -*- coding: utf-8 -*-
"""Apply the curated walkway-clearance offsets reviewed on the product view.

The offsets were computed by `museum_path_clear.py` (5x5 footprint sampling
against the tight walkway mask) and then reviewed against the user's annotated
product screenshot: the An-26 arrow points south-east, so its computed west push
is flipped.
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TABLE_PATH = ROOT / "assets" / "aviation-museum" / "analysis" / "placement_table.json"

OFFSETS = {
    "МиГ-27К [17]": [0.8, 4.9],
    "МиГ-29 (9-13)": [-3.7, 1.6],
    "Як-40 (южн)": [4.3, -2.5],
    "Як-40 (сев)": [0.2, -4.0],
    "Ту-134": [3.2, -2.4],
    "МиГ-21СМТ": [2.1, 3.4],
    "Су-17М": [0.1, -4.0],
    "МиГ-27К [05]": [-2.8, 2.9],
    "Л-29": [-1.8, 3.6],
    "Ан-26ЛЛ": [6.8, -1.6],
    "Cessna 750 Citation X": [7.0, -3.8],
    "Ми-24П": [-3.5, 2.0],
    "Ми-8Т": [-4.0, -0.5],
    "Су-25 [51]": [-4.0, 0.3],
}

TABLE = json.loads(TABLE_PATH.read_text(encoding="utf-8"))
applied = 0
for item in TABLE["exhibits"]:
    offset = OFFSETS.get(item["ref"])
    if offset is None:
        continue
    # keep offsets that were already part of the curated table (e.g. Tu-134)
    existing = item.get("offset", [0.0, 0.0])
    item["offset"] = [round(existing[0] + offset[0], 1), round(existing[1] + offset[1], 1)]
    applied += 1

TABLE["exhibits"] = [item for item in TABLE["exhibits"] if item.get("ref") != "МиГ-23УБ [71]"]
TABLE_PATH.write_text(json.dumps(TABLE, ensure_ascii=False, indent=1), encoding="utf-8")
print(f"applied {applied} offsets, removed МиГ-23УБ [71], {len(TABLE['exhibits'])} exhibits")
