#!/usr/bin/env python
"""Tree coverage report for parks, gardens, cemeteries and forests (B-1).

Matches every OSM `leisure=park|garden`, `landuse=cemetery|forest|
recreation_ground` and `natural=wood` polygon of the city extract with the
trees of the normalised city payload and rewrites `docs/COVERAGE_REPORT_CITY.md`.
The "before" columns come from `scripts/qa/tree_coverage_baseline.json`
(payload 0.4.2, measured before B-1).

    .venv/Scripts/python.exe scripts/qa/tree_coverage.py

Inputs: data/interim/city_raw.geojson, data/interim/city_trees.json,
data/processed/city_area_normalized.json, data/processed/coverage_city.json.
A tree counts for a polygon when it stands inside it; polygons overlap, so one
tree can count in several rows.
"""

from __future__ import annotations

import io
import json
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np
from pyproj import Transformer
from shapely import STRtree, points, transform
from shapely.geometry import box, shape

ROOT = Path(__file__).resolve().parents[2]
REPORT = ROOT / "docs/COVERAGE_REPORT_CITY.md"
BASELINE = ROOT / "scripts/qa/tree_coverage_baseline.json"
COVERAGE_JSON = ROOT / "data/processed/coverage_city.json"
RAW_GEOJSON = ROOT / "data/interim/city_raw.geojson"
NORMALIZED_JSON = ROOT / "data/processed/city_area_normalized.json"
TREES_JSON = ROOT / "data/interim/city_trees.json"
TILES_DIR = ROOT / "public/data/city-tiles"

CLASS_LABELS = {
    "park": "`leisure=park`",
    "forest/wood": "`landuse=forest`, `natural=wood`",
    "garden": "`leisure=garden`",
    "recreation_ground": "`landuse=recreation_ground`",
    "cemetery": "`landuse=cemetery`",
}

KEY_PLACES = [
    ("Парк Горького", "w30951233"),
    ("Парк Челюскинцев", "r14531592"),
    ("Парк Победы", "w99881325"),
    ("Лошицкий парк", "r8433815"),
    ("Севастопольский парк", "r9577162"),
    ("Парк 50-летия Октября", "r15326935"),
    ("Ботанический сад", "r222265"),
    ("Кальварийское кладбище", "w23586637"),
    ("Козыревское кладбище", "w194185323"),
    ("Военное кладбище", "w206516350"),
]


def classify(tags: dict) -> str | None:
    if tags.get("landuse") == "cemetery" or tags.get("amenity") == "grave_yard":
        return "cemetery"
    if tags.get("leisure") == "park":
        return "park"
    if tags.get("leisure") == "garden":
        return "garden"
    if tags.get("landuse") == "recreation_ground":
        return "recreation_ground"
    if tags.get("landuse") == "forest" or tags.get("natural") == "wood":
        return "forest/wood"
    return None


def fmt(value: float, digits: int = 0) -> str:
    text = f"{value:,.{digits}f}".replace(",", " ")
    return text.replace(".", ",")


def measure() -> tuple[list[dict], dict, dict]:
    coverage = json.loads(COVERAGE_JSON.read_text(encoding="utf-8"))
    origin_x, origin_y = coverage["area"]["originUtm"]
    area = coverage["area"]
    if "boundsLocal" in area:
        minx, miny, maxx, maxy = area["boundsLocal"]
    else:  # older coverage files: square pilot area
        half = area["pilotSizeM"] / 2
        minx, miny, maxx, maxy = -half, -half, half, half
    projector = Transformer.from_crs(4326, 32635, always_xy=True)

    def to_local(coords: np.ndarray) -> np.ndarray:
        x, y = projector.transform(coords[:, 0], coords[:, 1])
        return np.column_stack([np.asarray(x) - origin_x, np.asarray(y) - origin_y])

    raw = json.loads(RAW_GEOJSON.read_text(encoding="utf-8"))
    payload = json.loads(NORMALIZED_JSON.read_text(encoding="utf-8"))
    trees = payload["trees"]
    mapped_flags = np.array([bool(t["mapped"]) for t in trees])
    tree_index = STRtree(points([t["x"] for t in trees], [t["y"] for t in trees]))

    raw_trees = json.loads(TREES_JSON.read_text(encoding="utf-8"))["trees"]
    raw_xy = to_local(np.array([[t["lon"], t["lat"]] for t in raw_trees]))
    raw_index = STRtree(points(raw_xy[:, 0], raw_xy[:, 1]))

    frame = box(minx, miny, maxx, maxy)
    rows: list[dict] = []
    for feature in raw["features"]:
        if feature.get("kind") != "surface":
            continue
        tags = feature.get("tags") or {}
        cls = classify(tags)
        if cls is None:
            continue
        geom = transform(shape(feature["geometry"]), to_local)
        if not geom.is_valid:
            geom = geom.buffer(0)
        clipped = geom.intersection(frame)
        if clipped.is_empty:
            continue
        inside = tree_index.query(clipped, predicate="contains")
        mapped = int(mapped_flags[inside].sum())
        rows.append({
            "cls": cls,
            "osm": f"{feature['osm_type'][0]}{feature['osm_id']}",
            "name": tags.get("name", ""),
            "area": float(clipped.area),
            "raw_mapped": int(len(raw_index.query(clipped, predicate="contains"))),
            "mapped": mapped,
            "heuristic": int(len(inside)) - mapped,
        })
    return rows, coverage, payload


def render(rows: list[dict], coverage: dict) -> str:
    baseline = json.loads(BASELINE.read_text(encoding="utf-8"))
    agg: dict[str, dict] = defaultdict(lambda: {"polygons": 0, "area_ha": 0.0, "raw_mapped": 0,
                                                "mapped": 0, "heuristic": 0, "empty_over_02ha": 0})
    for row in rows:
        a = agg[row["cls"]]
        a["polygons"] += 1
        a["area_ha"] += row["area"] / 1e4
        a["raw_mapped"] += row["raw_mapped"]
        a["mapped"] += row["mapped"]
        a["heuristic"] += row["heuristic"]
        a["empty_over_02ha"] += int(row["mapped"] + row["heuristic"] == 0 and row["area"] > 2000)
    by_osm = {row["osm"]: row for row in rows}

    environment = coverage.get("environment") or {}

    def tree_stat(key: str, default="—"):
        return environment.get(key, default)

    manifest = TILES_DIR / "manifest.json"
    version = (json.loads(manifest.read_text(encoding="utf-8")).get("version", "?")
               if manifest.exists() else "?")

    area = coverage.get("area", {})
    if "boundsLocal" in area:
        aminx, aminy, amaxx, amaxy = area["boundsLocal"]
        frame_text = f"Рамка {(amaxx - aminx) / 1000:.2f} × {(amaxy - aminy) / 1000:.2f} км"
    else:
        frame_text = "Рамка 12 × 12 км"
    lines: list[str] = []
    lines.append("# Деревья в парках и на кладбищах: покрытие городского датасета")
    lines.append("")
    lines.append(f"Отчёт пересчитан `scripts/qa/tree_coverage.py` по payload "
                 f"{version}. "
                 "Колонки «до» — замер payload 0.4.2 перед задачей B-1 "
                 f"(`scripts/qa/tree_coverage_baseline.json`). {frame_text}. Дерево "
                 "относится к полигону, если стоит внутри него; полигоны пересекаются, "
                 "поэтому одно дерево может войти в несколько строк.")
    if "boundsLocal" in area and (
        abs((amaxx - aminx) - 12000) > 1
        or abs((amaxy - aminy) - 12000) > 1
    ):
        lines.append("")
        lines.append("Внимание: рамка отличается от 12-км baseline B-1 — "
                     "сравнение «до/после» по этому baseline для неё не сопоставимо.")
    lines.append("")
    lines.append("## Итог по городу")
    lines.append("")
    total_before = baseline["total"]
    lines.append("| Показатель | До (0.4.2) | После |")
    lines.append("| --- | ---: | ---: |")
    total_after = tree_stat("treesMapped", 0) + tree_stat("treesHeuristic", 0)
    lines.append(f"| Деревьев всего | {fmt(total_before['trees'])} | {fmt(total_after)} |")
    lines.append(f"| Размеченных (точки + ряды) | {fmt(total_before['mapped'])} | "
                 f"{fmt(tree_stat('treesMapped', 0))} "
                 f"({fmt(tree_stat('treesMappedPoints', 0))} + {fmt(tree_stat('treesMappedRows', 0))}) |")
    lines.append(f"| Эвристических | {fmt(total_before['heuristic'])} | {fmt(tree_stat('treesHeuristic', 0))} |")
    lines.append(f"| Треугольников деревьев (по тирам) | {fmt(total_before['triangles'])} | "
                 f"{fmt(tree_stat('treesTriangles', 0))} |")
    lines.append(f"| Максимум треугольников на тайл | {fmt(total_before['max_tile_triangles'])} | "
                 f"{fmt(tree_stat('treesMaxTrianglesPerTile', 0))} |")
    lines.append(f"| Максимум деревьев на тайл | {fmt(total_before['max_tile_trees'])} | "
                 f"{fmt(tree_stat('treesMaxPerTile', 0))} |")
    lines.append(f"| Деревьев, отброшенных клиентом (> 4 000 на тайл) | "
                 f"{fmt(total_before['client_dropped'])} | 0 |")
    scale = tree_stat("treesBudgetScale", None)
    if scale is not None:
        lines.append(f"| Коэффициент бюджета эвристики `k` | — | {str(scale).replace('.', ',')} |")
    lines.append("")
    lines.append("## По классам OSM")
    lines.append("")
    lines.append("| Класс | Полигонов | Площадь, га | Размечено в OSM | Размеченных в payload, до → после | "
                 "Эвристических, до → после | Пустых > 0,2 га, до → после |")
    lines.append("| --- | ---: | ---: | ---: | ---: | ---: | ---: |")
    for cls, label in CLASS_LABELS.items():
        a = agg.get(cls)
        b = baseline["classes"].get(cls)
        if a is None:
            continue
        lines.append(
            f"| {label} | {a['polygons']} | {fmt(a['area_ha'], 1)} | {fmt(a['raw_mapped'])} | "
            f"{fmt(b['mapped']) if b else '—'} → {fmt(a['mapped'])} | "
            f"{fmt(b['heuristic']) if b else '—'} → {fmt(a['heuristic'])} | "
            f"{b['empty_over_02ha'] if b else '—'} → {a['empty_over_02ha']} |")
    lines.append("")
    lines.append("«Размечено в OSM» — точки `natural=tree` внутри полигона; ряды "
                 "`natural=tree_row` туда не входят, в payload они размечены как `mapped`. "
                 "«Пустой до» считался по эвристике, «пустой после» — по всем деревьям.")
    lines.append("")
    lines.append("## Ключевые места")
    lines.append("")
    lines.append("| Место | OSM | Площадь, га | Размеченных, до → после | Эвристических, до → после | На гектар после |")
    lines.append("| --- | --- | ---: | ---: | ---: | ---: |")
    for title, osm in KEY_PLACES:
        row = by_osm.get(osm)
        before = baseline["places"].get(osm, {})
        if row is None:
            lines.append(f"| {title} | {osm} | — | вне рамки | — | — |")
            continue
        per_ha = (row["mapped"] + row["heuristic"]) / (row["area"] / 1e4)
        lines.append(
            f"| {title} | {osm} | {fmt(row['area'] / 1e4, 1)} | "
            f"{before.get('mapped', '—')} → {row['mapped']} | "
            f"{before.get('heuristic', '—')} → {row['heuristic']} | {fmt(per_ha)} |")
    lines.append("| Северное кладбище | r1692227 | — | вне рамки (≈ 53,9865° с. ш.), относится к B-2 | — | — |")
    lines.append("")
    empty = sorted(
        (row for row in rows
         if row["cls"] in {"park", "cemetery", "garden"} and row["area"] >= 1e4
         and row["mapped"] + row["heuristic"] == 0),
        key=lambda row: -row["area"],
    )
    lines.append("## Пустые парки, сады и кладбища площадью от 1 га")
    lines.append("")
    if not empty:
        lines.append("Нет.")
    else:
        lines.append("| OSM | Название | Класс | Площадь, га |")
        lines.append("| --- | --- | --- | ---: |")
        for row in empty:
            lines.append(f"| {row['osm']} | {row['name'] or '—'} | {row['cls']} | {fmt(row['area'] / 1e4, 1)} |")
    lines.append("")
    lines.append("## Скриншоты")
    lines.append("")
    lines.append("`screenshots/b1-before/` (payload 0.4.2) и `screenshots/b1-after/` "
                 "(промежуточный вариант с бюджетом 140 000): парк Горького, парк Челюскинцев, "
                 "Кальварийское кладбище, Лошицкий парк, парк Победы. `screenshots/b1-full/`: "
                 "полная плотность (текущая), Челюскинцев, Победы, Кальварийское "
                 "(`scripts/qa/road-shots.mjs`, `QA_FOCUS`).")
    lines.append("")
    return "\n".join(lines)


def main() -> int:
    global REPORT, COVERAGE_JSON, RAW_GEOJSON, NORMALIZED_JSON, TREES_JSON, TILES_DIR
    import argparse

    parser = argparse.ArgumentParser(description="Tree coverage report (city dataset)")
    parser.add_argument("--coverage", default=None,
                        help="coverage JSON (default: data/processed/coverage_city.json)")
    parser.add_argument("--raw", default=None,
                        help="raw geojson (default: data/interim/city_raw.geojson)")
    parser.add_argument("--normalized", default=None,
                        help="normalized payload (default: data/processed/city_area_normalized.json)")
    parser.add_argument("--trees", default=None,
                        help="mapped trees JSON (default: data/interim/city_trees.json)")
    parser.add_argument("--tiles-dir", default=None,
                        help="tile dataset dir (default: public/data/city-tiles)")
    parser.add_argument("--report", default=None,
                        help="output markdown (default: docs/COVERAGE_REPORT_CITY.md)")
    args = parser.parse_args()
    if args.coverage:
        COVERAGE_JSON = Path(args.coverage)
    if args.raw:
        RAW_GEOJSON = Path(args.raw)
    if args.normalized:
        NORMALIZED_JSON = Path(args.normalized)
    if args.trees:
        TREES_JSON = Path(args.trees)
    if args.tiles_dir:
        TILES_DIR = Path(args.tiles_dir)
    if args.report:
        REPORT = Path(args.report)

    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
    rows, coverage, _payload = measure()
    REPORT.write_text(render(rows, coverage), encoding="utf-8")
    try:
        shown = REPORT.relative_to(ROOT)
    except ValueError:
        shown = REPORT
    print(f"Wrote {shown} ({len(rows)} polygons)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
