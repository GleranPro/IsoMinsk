"""Извлечение исходной сети общественного транспорта из OSM PBF.

Отдельный конвейер мобильности (см. `docs/mobility/CONTRACT.md`): он не меняет
`scripts/ingest/extract.py` и не переиспользует его выход, потому что тому нужны
порядок и роли членов route-отношений, исходные OSM ID узлов и turn
restrictions, которых в тайловом payload нет.

Проходы по файлу (каждый — один `osmium.FileProcessor`):

  A. relations: выбранные route-отношения (`corridors.json`) и все
     `type=restriction` для последующей фильтрации по выбранным way.
  B. ways (с локациями узлов): геометрия выбранных route-отношений.
  C. nodes: остановки/платформы членов отношений, сигналы, переходы и via-узлы
     ограничений в окне области (B-2 + `CITY_HALO_M`).

Выход `data/processed/mobility/network_raw.json` содержит только исходные
данные (ID, теги, порядок членов, локальные метры UTM 35N), без догадок о
движении. Любая привязка/склейка — задача `build_network.py`.

CLI:
    python scripts/mobility/extract_network.py --pbf data/raw/Minsk.osm.pbf \
        --corridors scripts/mobility/corridors.json \
        --out data/processed/mobility/network_raw.json --area city

Режим `--survey` печатает таблицу кандидатов (см. `docs/mobility/ROUTES.md`) и
ничего не записывает; он нужен для воспроизводимого выбора коридоров.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
import time
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import osmium  # noqa: E402
from pyproj import Transformer  # noqa: E402
from shapely.geometry import LineString, Point  # noqa: E402
from shapely.strtree import STRtree  # noqa: E402

from geo_config import (  # noqa: E402
    CITY_HALO_M,
    EPSG_UTM35N,
    EPSG_WGS84,
    area_bounds_m,
)
from geo_window import ORIGIN_X, ORIGIN_Y, area_window_wgs84  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_PBF = ROOT / "data/raw/Minsk.osm.pbf"
DEFAULT_CORRIDORS = ROOT / "scripts/mobility/corridors.json"
DEFAULT_OUT = ROOT / "data/processed/mobility/network_raw.json"
CITY_MANIFEST = ROOT / "public/data/city-tiles/manifest.json"

ROUTE_MODES = ("bus", "trolleybus", "tram")
STOP_ROLES = {"stop", "stop_entry_only", "stop_exit_only"}
PLATFORM_ROLES = {"platform", "platform_entry_only", "platform_exit_only"}

# Радиусы, в которых исходные объекты считаются относящимися к коридору.
# Это отбор данных, а не привязка: привязка выполняется в build_network.py.
SIGNAL_RADIUS_M = 80.0
CROSSING_RADIUS_M = 120.0
STOP_RADIUS_M = 60.0
# Трамвайный коридор должен иметь регулируемый узел на трассе/подходе.
TRAM_SIGNAL_CHECK_M = 25.0
# Допуск проверки «внутри B-2»: узлы ways на границе не должны отбраковываться
# из-за округления координат.
BOUNDS_TOLERANCE_M = 1.0
# Стоп-член отношения считается стоящим на трассе, если он не дальше этого.
STOP_ON_CHAIN_M = 30.0

_TO_UTM = Transformer.from_crs(EPSG_WGS84, EPSG_UTM35N, always_xy=True)

NODE_INTEREST_VALUES = {
    "highway": {"bus_stop", "traffic_signals", "crossing"},
    "railway": {"tram_stop", "signal", "level_crossing"},
    "public_transport": {"stop_position", "platform"},
}


# ---------------------------------------------------------------------------
# Общие помощники (используются и build_network.py)
# ---------------------------------------------------------------------------


def to_local(lon: float, lat: float) -> tuple[float, float]:
    """(lon, lat) WGS84 -> локальные метры UTM 35N относительно origin тайлов."""
    x, y = _TO_UTM.transform(lon, lat)
    return x - ORIGIN_X, y - ORIGIN_Y


def node_local(node: dict) -> tuple[float, float]:
    return float(node["x"]), float(node["y"])


def tags_of(obj) -> dict[str, str]:
    return {tag.k: tag.v for tag in obj.tags}


def relation_members(rel) -> list[dict]:
    """Члены отношения в исходном порядке с типом и ролью."""
    return [
        {"type": str(member.type), "ref": int(member.ref), "role": member.role or ""}
        for member in rel.members
    ]


def is_stop_role(role: str) -> bool:
    return role in STOP_ROLES


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def assemble_chain(
    member_way_ids: list[int],
    ways: dict[int, dict],
    nodes: dict[int, dict],
) -> dict:
    """Склеить упорядоченные way-члены отношения по общим узлам.

    Направление каждого way определяется **только** по номерам узлов: way
    считается продолжением, если его первый или последний узел совпадает с
    последним узлом уже собранной цепочки. Близость координат не используется,
    поэтому параллельные проезжие части и мост над дорогой не склеиваются.

    Пробуются обе ориентации первого way; выбирается вариант с меньшим числом
    разрывов, затем с меньшей суммой «недостающих» расстояний. Разрыв не
    склеивается: он попадает в `gaps` и делает цепочку непригодной для
    проверенного варианта (решение принимает вызывающий код).

    Возвращает ``segments`` (ориентация каждого way), ``chainNodes`` (узлы
    сквозной цепочки), ``coords`` (локальные метры) и ``gaps``.
    """

    def attempt(first_reversed: bool) -> dict:
        segments: list[dict] = []
        chain: list[int] = []
        gaps: list[dict] = []
        for index, way_id in enumerate(member_way_ids):
            way = ways.get(way_id)
            if way is None:
                gaps.append({"wayId": way_id, "reason": "missing-way-geometry"})
                continue
            way_nodes: list[int] = way["nodes"]
            if len(way_nodes) < 2:
                gaps.append({"wayId": way_id, "reason": "degenerate-way"})
                continue
            gap_here = False
            if index == 0 and not segments and not chain:
                reversed_way = first_reversed
            elif not chain:
                reversed_way = False
            elif way_nodes[0] == chain[-1]:
                reversed_way = False
            elif way_nodes[-1] == chain[-1]:
                reversed_way = True
            else:
                gap_here = True
                # Разрыв: фиксируем, насколько далеко конец цепочки от ближайшего
                # конца следующего way (диагностика, не «починка»).
                last = nodes.get(chain[-1])
                start = nodes.get(way_nodes[0])
                end = nodes.get(way_nodes[-1])
                distance = math.inf
                if last is not None and start is not None:
                    distance = math.hypot(last["x"] - start["x"], last["y"] - start["y"])
                if last is not None and end is not None:
                    distance = min(
                        distance,
                        math.hypot(last["x"] - end["x"], last["y"] - end["y"]),
                    )
                gaps.append({
                    "wayId": way_id,
                    "reason": "no-shared-node",
                    "expectedNode": chain[-1],
                    "wayStartNode": way_nodes[0],
                    "wayEndNode": way_nodes[-1],
                    "distanceM": round(distance, 3) if math.isfinite(distance) else None,
                })
                reversed_way = False
            oriented = list(reversed(way_nodes)) if reversed_way else list(way_nodes)
            # При разрыве первый узел way НЕ совпадает с концом цепочки, поэтому
            # его нельзя отбрасывать: иначе теряется начало участка.
            if chain and not gap_here:
                oriented = oriented[1:]
            chain.extend(oriented)
            segments.append({"wayId": way_id, "reversed": reversed_way})
        coords: list[list[float]] = []
        for node_id in chain:
            node = nodes.get(node_id)
            if node is None:
                continue
            x, y = node_local(node)
            if coords and abs(coords[-1][0] - x) < 1e-9 and abs(coords[-1][1] - y) < 1e-9:
                continue
            coords.append([round(x, 3), round(y, 3)])
        gap_distance = sum(g.get("distanceM") or 0.0 for g in gaps)
        return {
            "segments": segments,
            "chainNodes": chain,
            "coords": coords,
            "gaps": gaps,
            "gapDistanceM": round(gap_distance, 3),
            "firstReversed": first_reversed,
        }

    if not member_way_ids:
        return {
            "segments": [],
            "chainNodes": [],
            "coords": [],
            "gaps": [{"reason": "no-way-members"}],
            "gapDistanceM": 0.0,
            "firstReversed": False,
        }
    attempts = [attempt(False), attempt(True)]
    attempts.sort(key=lambda item: (len(item["gaps"]), item["gapDistanceM"], item["firstReversed"]))
    return attempts[0]


def chain_length(coords: list[list[float]]) -> float:
    if len(coords) < 2:
        return 0.0
    return LineString(coords).length


def inside_bounds(x: float, y: float, bounds: tuple[float, float, float, float]) -> bool:
    minx, miny, maxx, maxy = bounds
    return (
        minx - BOUNDS_TOLERANCE_M <= x <= maxx + BOUNDS_TOLERANCE_M
        and miny - BOUNDS_TOLERANCE_M <= y <= maxy + BOUNDS_TOLERANCE_M
    )


# ---------------------------------------------------------------------------
# Чтение PBF
# ---------------------------------------------------------------------------


def read_route_relations(
    pbf: Path,
    wanted_ids: set[int] | None,
    modes: tuple[str, ...] = ROUTE_MODES,
) -> tuple[dict[int, dict], list[dict]]:
    """Прочитать route-отношения (при wanted_ids — только их) и restrictions."""
    routes: dict[int, dict] = {}
    restrictions: list[dict] = []
    for rel in osmium.FileProcessor(str(pbf), entities=osmium.osm.RELATION):
        tags = tags_of(rel)
        kind = tags.get("type")
        if kind == "restriction":
            restrictions.append({
                "id": rel.id,
                "tags": tags,
                "members": relation_members(rel),
            })
            continue
        if kind != "route":
            continue
        if wanted_ids is not None and rel.id not in wanted_ids:
            continue
        if tags.get("route") not in modes:
            continue
        members = relation_members(rel)
        routes[rel.id] = {
            "id": rel.id,
            "tags": tags,
            "members": members,
        }
    return routes, restrictions


def selected_way_ids(routes: dict[int, dict]) -> set[int]:
    return {
        member["ref"]
        for route in routes.values()
        for member in route["members"]
        if member["type"] == "w"
    }


def read_ways(pbf: Path, way_ids: set[int]) -> dict[int, dict]:
    """Геометрия и все теги выбранных ways; узлы — с локальными координатами."""
    ways: dict[int, dict] = {}
    if not way_ids:
        return ways
    processor = (
        osmium.FileProcessor(str(pbf))
        .with_locations("flex_mem")
        .with_filter(osmium.filter.EntityFilter(osmium.osm.WAY))
    )
    for way in processor:
        if way.id not in way_ids:
            continue
        node_ids: list[int] = []
        coords: list[list[float]] = []
        missing = 0
        for node_ref in way.nodes:
            node_ids.append(node_ref.ref)
            if not node_ref.location.valid():
                missing += 1
                continue
        ways[way.id] = {
            "id": way.id,
            "tags": tags_of(way),
            "nodes": node_ids,
            "missingLocations": missing,
        }
    return ways


class NodeIndex:
    """Узлы интереса (остановки, сигналы, переходы) в окне области."""

    def __init__(self) -> None:
        self.records: dict[int, dict] = {}

    def add(self, node, x: float, y: float, tags: dict[str, str]) -> None:
        self.records[node.id] = {
            "x": round(x, 3),
            "y": round(y, 3),
            "lat": round(node.location.lat, 7),
            "lon": round(node.location.lon, 7),
            "tags": tags,
        }


def read_interest_nodes(
    pbf: Path,
    needed_ids: set[int],
    window: tuple[float, float, float, float],
) -> NodeIndex:
    """Узлы остановок/сигналов/переходов и обязательные узлы по ID."""
    index = NodeIndex()
    min_lat, min_lon, max_lat, max_lon = window
    for node in osmium.FileProcessor(str(pbf), entities=osmium.osm.NODE):
        if not node.location.valid():
            continue
        tags = tags_of(node)
        lat, lon = node.location.lat, node.location.lon
        wanted = node.id in needed_ids
        if not wanted:
            if not (min_lat <= lat <= max_lat and min_lon <= lon <= max_lon):
                continue
            for key, values in NODE_INTEREST_VALUES.items():
                if tags.get(key) in values:
                    wanted = True
                    break
        if not wanted:
            continue
        x, y = to_local(lon, lat)
        index.add(node, x, y, tags)
    return index


# ---------------------------------------------------------------------------
# Отбор объектов вокруг коридора
# ---------------------------------------------------------------------------


def way_lines(way_ids: list[int], ways: dict[int, dict], nodes: dict[int, dict]):
    lines = []
    for way_id in way_ids:
        way = ways.get(way_id)
        if not way:
            continue
        coords = [node_local(nodes[n]) for n in way["nodes"] if n in nodes]
        if len(coords) >= 2:
            lines.append(LineString(coords))
    return lines


def near_distance(point: Point, tree: STRtree, lines: list[LineString], limit: float) -> float:
    best = math.inf
    for index in tree.query(point.buffer(limit)):
        distance = lines[int(index)].distance(point)
        if distance < best:
            best = distance
    return best


def classify_nodes(
    index: NodeIndex,
    ways: dict[int, dict],
    nodes: dict[int, dict],
) -> dict:
    """Отделить остановки, сигналы и переходы; отфильтровать по близости к путям."""
    lines = way_lines(sorted(ways), ways, nodes)
    tree = STRtree(lines) if lines else None
    stops: list[dict] = []
    signals: list[dict] = []
    crossings: list[dict] = []
    for node_id in sorted(index.records):
        record = index.records[node_id]
        tags = record["tags"]
        point = Point(record["x"], record["y"])
        if tree is not None:
            if tags.get("highway") in {"bus_stop", "traffic_signals", "crossing"} or (
                tags.get("railway") in {"tram_stop", "signal", "level_crossing"}
                or tags.get("public_transport") in {"stop_position", "platform"}
            ):
                limit = max(SIGNAL_RADIUS_M, CROSSING_RADIUS_M, STOP_RADIUS_M)
                distance = near_distance(point, tree, lines, limit)
            else:
                distance = math.inf
        else:
            distance = math.inf
        record_base = {
            "osmType": "node",
            "osmId": node_id,
            "x": record["x"],
            "y": record["y"],
            "lat": record["lat"],
            "lon": record["lon"],
            "tags": tags,
        }
        is_stop = (
            tags.get("highway") == "bus_stop"
            or tags.get("railway") == "tram_stop"
            or tags.get("public_transport") in {"stop_position", "platform"}
        )
        if is_stop and distance <= STOP_RADIUS_M:
            record_base["distanceToWayM"] = round(distance, 3)
            stops.append(record_base)
        if tags.get("highway") == "traffic_signals" or tags.get("railway") == "signal":
            if distance <= SIGNAL_RADIUS_M:
                record_base["distanceToWayM"] = round(distance, 3)
                signals.append(record_base)
        if tags.get("highway") == "crossing" or tags.get("railway") == "level_crossing":
            if distance <= CROSSING_RADIUS_M:
                record_base["distanceToWayM"] = round(distance, 3)
                crossings.append(record_base)
    return {"stops": stops, "signals": signals, "crossings": crossings}


def filter_restrictions(
    restrictions: list[dict],
    selected_ways: set[int],
    way_nodes: set[int],
) -> list[dict]:
    """Turn restrictions, затрагивающие выбранные пути.

    Ограничение относится к коридору, если его from/to/via way или via-узел
    входит в выбранные пути: только такие правила влияют на движение по нему.
    """
    kept: list[dict] = []
    for restriction in restrictions:
        touch = False
        for member in restriction["members"]:
            if member["type"] == "w" and member["ref"] in selected_ways:
                touch = True
                break
            if member["type"] == "n" and member["ref"] in way_nodes:
                touch = True
                break
        if touch:
            kept.append(restriction)
    return kept


# ---------------------------------------------------------------------------
# Режим обзора кандидатов
# ---------------------------------------------------------------------------


def survey(pbf: Path, area: str) -> int:
    """Таблица кандидатов route-отношений для выбора коридоров."""
    bounds = area_bounds_m(area)
    window = area_window_wgs84(area)
    routes, _ = read_route_relations(pbf, None)
    ways = read_ways(pbf, selected_way_ids(routes))
    stop_ids = {
        member["ref"]
        for route in routes.values()
        for member in route["members"]
        if member["type"] == "n" and is_stop_role(member["role"])
    }
    # Для честной длины цепочки в обзор нужны ВСЕ узлы ways, а не только
    # остановки: иначе полилиния «режет» углы по хордам.
    required_nodes = set(stop_ids)
    for way_record in ways.values():
        required_nodes.update(way_record["nodes"])
    nodes = read_interest_nodes(pbf, required_nodes, window).records

    signal_points = [
        Point(record["x"], record["y"])
        for record in nodes.values()
        if record["tags"].get("highway") == "traffic_signals"
    ]
    signal_tree = STRtree(signal_points) if signal_points else None

    rows: list[dict] = []
    for relation_id in sorted(routes):
        route = routes[relation_id]
        tags = route["tags"]
        member_ways = [m["ref"] for m in route["members"] if m["type"] == "w"]
        if not member_ways:
            continue
        chain = assemble_chain(member_ways, ways, nodes)
        coords = chain["coords"]
        length = chain_length(coords)
        line = LineString(coords) if len(coords) >= 2 else None
        stop_members = [
            m["ref"] for m in route["members"] if m["type"] == "n" and is_stop_role(m["role"])
        ]
        stop_s: list[float] = []
        stop_off: list[float] = []
        for stop_id in stop_members:
            record = nodes.get(stop_id)
            if record is None or line is None:
                continue
            point = Point(record["x"], record["y"])
            distance = line.distance(point)
            stop_off.append(round(distance, 2))
            if distance <= STOP_ON_CHAIN_M:
                stop_s.append(line.project(point))
        on_chain = len(stop_s)
        monotonic = all(stop_s[i] <= stop_s[i + 1] + 1e-6 for i in range(len(stop_s) - 1))
        inside = all(inside_bounds(x, y, bounds) for x, y in coords) if coords else False
        signals_near = 0
        if line is not None and signal_tree is not None:
            # STRtree.query отдаёт кандидатов по bbox: расстояние проверяется
            # по геометрии, иначе в счёт попадут все сигналы габаритного bbox.
            for index in signal_tree.query(line.buffer(TRAM_SIGNAL_CHECK_M)):
                if line.distance(signal_points[int(index)]) <= TRAM_SIGNAL_CHECK_M:
                    signals_near += 1
        rows.append({
            "relationId": relation_id,
            "mode": tags.get("route"),
            "ref": tags.get("ref"),
            "from": tags.get("from"),
            "to": tags.get("to"),
            "name": tags.get("name"),
            "ways": len(member_ways),
            "lengthM": round(length, 1),
            "gaps": len(chain["gaps"]),
            "gapDistanceM": chain["gapDistanceM"],
            "stops": len(stop_members),
            "stopsOnChain": on_chain,
            "monotonic": monotonic,
            "insideB2": inside,
            "signals25": signals_near,
            "minX": round(min((c[0] for c in coords)), 1) if coords else None,
            "maxX": round(max((c[0] for c in coords)), 1) if coords else None,
            "minY": round(min((c[1] for c in coords)), 1) if coords else None,
            "maxY": round(max((c[1] for c in coords)), 1) if coords else None,
            "continue": max_straight_stop_run(stop_s),
        })

    print("SURVEY\trelationId\tmode\tref\tways\tlenM\tgaps\tgapM\tstops\tonChain\tmonotonic\tinsideB2\tsig25\tminX\tminY\tmaxX\tmaxY\tfrom\tto")
    for row in rows:
        print(
            "SURVEY\t{relationId}\t{mode}\t{ref}\t{ways}\t{lengthM}\t{gaps}\t{gapDistanceM}\t"
            "{stops}\t{stopsOnChain}\t{monotonic}\t{insideB2}\t{signals25}\t{minX}\t{minY}\t"
            "{maxX}\t{maxY}\t{from}\t{to}".format(**{k: ("" if v is None else v) for k, v in row.items()})
        )

    eligible = [
        row for row in rows
        if row["gaps"] == 0 and row["insideB2"] and row["stopsOnChain"] >= 3
        and row["monotonic"] and row["mode"] in ("bus", "tram")
    ]
    grouped: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for row in eligible:
        grouped[(row["mode"], row["ref"] or "")].append(row)
    print("\nPAIRS\tmode\tref\taId\tbId\tshared\treversed\taLenM\tbLenM\taSig25\tbSig25")
    for (mode, ref), group in sorted(grouped.items()):
        if mode != "bus" and mode != "tram":
            continue
        for i, first in enumerate(group):
            for second in group[i + 1:]:
                a = route_stop_ids(routes[first["relationId"]])
                b = route_stop_ids(routes[second["relationId"]])
                shared = len(a & b)
                if shared < 3:
                    continue
                order_a = [s for s in a]
                order_b = [s for s in b]
                # Направления противоположны, если общие остановки идут в обратном порядке.
                common = [s for s in stop_order(routes, ways, nodes, first["relationId"]) if s in b]
                reversed_order = len(common) >= 3 and stop_order(
                    routes, ways, nodes, second["relationId"]
                )[: len(common)] == list(reversed(common))
                print(
                    f"PAIRS\t{mode}\t{ref}\t{first['relationId']}\t{second['relationId']}\t"
                    f"{shared}\t{reversed_order}\t{first['lengthM']}\t{second['lengthM']}\t"
                    f"{first['signals25']}\t{second['signals25']}"
                )
    print(f"\nSURVEY relations={len(routes)} ways={len(ways)} nodes={len(nodes)} eligible={len(eligible)}")
    return 0


def max_straight_stop_run(stop_s: list[float]) -> int:
    """Наибольшая возрастающая (неубывающая) серия остановок вдоль трассы."""
    best = 0
    run = 0
    previous = -math.inf
    for value in stop_s:
        if value >= previous:
            run += 1
        else:
            run = 1
        best = max(best, run)
        previous = value
    return best


def stop_order(routes: dict[int, dict], ways: dict[int, dict], nodes: dict[int, dict], relation_id: int):
    """Порядок stop-членов отношения, спроецированный на собранную цепочку."""
    route = routes[relation_id]
    member_ways = [m["ref"] for m in route["members"] if m["type"] == "w"]
    chain = assemble_chain(member_ways, ways, nodes)
    if len(chain["coords"]) < 2:
        return []
    line = LineString(chain["coords"])
    result: list[tuple[float, int]] = []
    for member in route["members"]:
        if member["type"] != "n" or not is_stop_role(member["role"]):
            continue
        record = nodes.get(member["ref"])
        if record is None:
            continue
        point = Point(record["x"], record["y"])
        if line.distance(point) > STOP_ON_CHAIN_M:
            continue
        result.append((line.project(point), member["ref"]))
    result.sort()
    return [ref for _, ref in result]


def route_stop_ids(route: dict) -> set[int]:
    return {
        member["ref"]
        for member in route["members"]
        if member["type"] == "n" and is_stop_role(member["role"])
    }


# ---------------------------------------------------------------------------
# Извлечение коридоров
# ---------------------------------------------------------------------------


def origin_utm() -> tuple[float, float]:
    """origin тайлов (метры UTM 35N); проверяется против geo_window."""
    if CITY_MANIFEST.exists():
        manifest = json.loads(CITY_MANIFEST.read_text(encoding="utf-8"))
        pair = manifest.get("originUtm")
        if isinstance(pair, list) and len(pair) == 2:
            return float(pair[0]), float(pair[1])
    return ORIGIN_X, ORIGIN_Y


def load_corridors(path: Path) -> dict:
    data = json.loads(path.read_text(encoding="utf-8"))
    if "corridors" not in data:
        raise SystemExit(f"corridors file has no 'corridors': {path}")
    relation_ids: set[int] = set()
    for corridor in data["corridors"]:
        for variant in corridor.get("variants", []):
            relation_id = variant.get("relationId")
            if not isinstance(relation_id, int):
                raise SystemExit(f"variant without relationId in {path}: {variant}")
            if relation_id in relation_ids:
                raise SystemExit(f"duplicate relationId {relation_id} in {path}")
            relation_ids.add(relation_id)
    data["_relationIds"] = sorted(relation_ids)
    return data


def extract(args) -> int:
    pbf = Path(args.pbf)
    if not pbf.exists():
        print(f"ERROR: PBF not found: {pbf}", file=sys.stderr)
        return 1
    corridors_path = Path(args.corridors)
    corridors = load_corridors(corridors_path)
    wanted = set(corridors["_relationIds"])
    bounds = area_bounds_m(args.area)
    window = area_window_wgs84(args.area)
    started = time.time()

    pbf_sha256 = sha256_file(pbf)
    header = osmium.io.Reader(str(pbf)).header()
    replication = header.get("osmosis_replication_timestamp")
    print(f"PBF: {pbf} ({pbf.stat().st_size / 1e6:.1f} MB, sha256 {pbf_sha256[:12]}…)")
    print(f"Area: {args.area}; bounds {bounds}; halo {CITY_HALO_M} m")

    # Проход A: отношения.
    routes, restrictions = read_route_relations(pbf, wanted)
    missing_relations = sorted(wanted - set(routes))
    if missing_relations:
        print(
            "ERROR: corridors reference relations that are not route relations in the PBF: "
            f"{missing_relations}",
            file=sys.stderr,
        )
        return 1
    print(f"[pass A] route relations: {len(routes)}, restriction relations: {len(restrictions)}")

    # Проход B: геометрия выбранных ways.
    route_ways = selected_way_ids(routes)
    ways = read_ways(pbf, route_ways)
    missing_ways = sorted(route_ways - set(ways))
    if missing_ways:
        print(f"WARNING: {len(missing_ways)} way members have no geometry: {missing_ways[:10]}")
    print(f"[pass B] ways: {len(ways)} with geometry")

    # Узлы цепочек добавляются в выход (нужны для геометрии и from/to). Их
    # координаты берутся из прохода C, поэтому в ways хранятся только ID узлов.
    nodes: dict[int, dict] = {}
    needed_node_ids: set[int] = set()
    for way in ways.values():
        needed_node_ids.update(way["nodes"])
    for route in routes.values():
        for member in route["members"]:
            if member["type"] == "n":
                needed_node_ids.add(member["ref"])
    for restriction in restrictions:
        for member in restriction["members"]:
            if member["type"] == "n":
                needed_node_ids.add(member["ref"])

    node_index = read_interest_nodes(pbf, needed_node_ids, window)
    for node_id, record in node_index.records.items():
        nodes[node_id] = record
    print(f"[pass C] nodes: {len(nodes)} ({len(needed_node_ids)} required ids)")

    # В выход попадают только узлы коридора: узлы его ways, остановки, сигналы,
    # переходы и via-узлы ограничений. Остальные узлы окна не нужны и раздувают
    # промежуточный файл.
    restrictions = filter_restrictions(
        restrictions,
        set(ways),
        {node_id for way in ways.values() for node_id in way["nodes"]},
    )
    classified = classify_nodes(node_index, ways, nodes)
    keep_ids = {node_id for way in ways.values() for node_id in way["nodes"]}
    keep_ids.update(record["osmId"] for record in classified["stops"])
    keep_ids.update(record["osmId"] for record in classified["signals"])
    keep_ids.update(record["osmId"] for record in classified["crossings"])
    for restriction in restrictions:
        for member in restriction["members"]:
            if member["type"] == "n":
                keep_ids.add(member["ref"])
    nodes = {node_id: nodes[node_id] for node_id in sorted(keep_ids) if node_id in nodes}
    print(f"[trim] nodes kept: {len(nodes)}")

    # Геометрия ways ссылается на узлы; если узла нет — это неполные исходные
    # данные, фиксируем их в отчёте, а не выбрасываем молча.
    missing_locations = {
        way_id: [n for n in way["nodes"] if n not in nodes]
        for way_id, way in ways.items()
    }
    missing_locations = {k: v for k, v in missing_locations.items() if v}

    corridor_records = []
    for corridor in corridors["corridors"]:
        variants = []
        for variant in corridor["variants"]:
            relation = routes[variant["relationId"]]
            variants.append({
                "relationId": relation["id"],
                "direction": int(variant["direction"]),
                "headSign": variant["headSign"],
                "from": variant.get("from", relation["tags"].get("from")),
                "to": variant.get("to", relation["tags"].get("to")),
                "tags": relation["tags"],
                "members": relation["members"],
            })
        corridor_records.append({
            "mode": corridor["mode"],
            "ref": corridor["ref"],
            "variants": variants,
        })

    document = {
        "header": {
            "source": "OpenStreetMap",
            "pbf": pbf.name,
            "pbfPath": str(pbf.relative_to(ROOT)) if pbf.is_relative_to(ROOT) else str(pbf),
            "pbfBytes": pbf.stat().st_size,
            "pbfSha256": pbf_sha256,
            "replicationTimestamp": replication,
            "extractedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "area": args.area,
            "epsg": EPSG_UTM35N,
            "sourceSrs": EPSG_WGS84,
            "originUtm": [round(origin_utm()[0], 3), round(origin_utm()[1], 3)],
            "targetBounds": list(bounds),
            "window": list(window),
            "haloM": CITY_HALO_M,
            "corridors": str(corridors_path.relative_to(ROOT))
            if corridors_path.is_relative_to(ROOT) else str(corridors_path),
            "corridorsSha256": sha256_file(corridors_path),
            "attribution": "(c) OpenStreetMap contributors, ODbL 1.0",
            "note": (
                "Raw source data: OSM ids, tags and member order preserved. "
                "No geometry merging, lane inference or stop binding is done here."
            ),
        },
        "corridors": corridor_records,
        "nodes": {str(node_id): nodes[node_id] for node_id in sorted(nodes)},
        "ways": {str(way_id): ways[way_id] for way_id in sorted(ways)},
        "stops": classified["stops"],
        "signals": classified["signals"],
        "crossings": classified["crossings"],
        "restrictions": restrictions,
        "missing": {
            "relations": missing_relations,
            "ways": missing_ways,
            "nodeLocations": {str(k): v for k, v in sorted(missing_locations.items())},
        },
    }

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(document, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    out.write_text(text + "\n", encoding="utf-8")
    print(
        f"Wrote {out} ({out.stat().st_size / 1e3:.1f} kB): "
        f"{len(routes)} relations, {len(ways)} ways, {len(nodes)} nodes, "
        f"{len(classified['stops'])} stops, {len(classified['signals'])} signals, "
        f"{len(classified['crossings'])} crossings, {len(restrictions)} restrictions"
    )
    print(f"Total time: {time.time() - started:.1f}s")
    return 0


def write_city_corridors(pbf: Path, area: str, out_path: Path) -> int:
    """Записать corridors-файл со всеми проверенными маршрутами города.

    Переиспользует проверки `--survey`: берутся только отношения с непрерывной
    геометрией, всеми узлами внутри B-2 и хотя бы тремя остановками на цепочке.
    Направления внутри (mode, ref) размечаются по порядку id: 0/1; это
    модельная метка, а не утверждение о реальном направлении.
    """
    bounds = area_bounds_m(area)
    window = area_window_wgs84(area)
    routes, _ = read_route_relations(pbf, None)
    ways = read_ways(pbf, selected_way_ids(routes))
    stop_ids = {
        member["ref"]
        for route in routes.values()
        for member in route["members"]
        if member["type"] == "n" and is_stop_role(member["role"])
    }
    required_nodes = set(stop_ids)
    for way_record in ways.values():
        required_nodes.update(way_record["nodes"])
    nodes = read_interest_nodes(pbf, required_nodes, window).records

    rows: list[dict] = []
    for relation_id in sorted(routes):
        route = routes[relation_id]
        tags = route["tags"]
        mode = tags.get("route")
        if mode not in ("bus", "trolleybus", "tram"):
            continue
        member_ways = [m["ref"] for m in route["members"] if m["type"] == "w"]
        if not member_ways:
            continue
        chain = assemble_chain(member_ways, ways, nodes)
        coords = chain["coords"]
        if len(coords) < 2:
            continue
        line = LineString(coords)
        stop_members = [
            m["ref"] for m in route["members"] if m["type"] == "n" and is_stop_role(m["role"])
        ]
        stop_s = [
            line.project(Point(nodes[stop_id]["x"], nodes[stop_id]["y"]))
            for stop_id in stop_members
            if stop_id in nodes
            and line.distance(Point(nodes[stop_id]["x"], nodes[stop_id]["y"])) <= STOP_ON_CHAIN_M
        ]
        monotonic = all(stop_s[i] <= stop_s[i + 1] + 1e-6 for i in range(len(stop_s) - 1))
        inside = all(inside_bounds(x, y, bounds) for x, y in coords)
        if chain["gaps"] or not inside or len(stop_s) < 3 or not monotonic:
            continue
        rows.append({
            "relationId": relation_id,
            "mode": mode,
            "ref": tags.get("ref") or "",
            "from": tags.get("from") or "",
            "to": tags.get("to") or "",
            "name": tags.get("name") or "",
            "lengthM": round(chain_length(coords), 1),
            "stops": len(stop_s),
            "signals25": 0,
        })

    grouped: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for row in rows:
        grouped[(row["mode"], row["ref"])].append(row)
    corridors: list[dict] = []
    for (mode, ref), group in sorted(grouped.items()):
        group.sort(key=lambda item: item["relationId"])
        variants = []
        for index, row in enumerate(group):
            # Пары одного ref идут подряд по возрастанию id: направления 0/1.
            direction = index % 2
            head_sign = row["to"] if direction == 0 else row["from"]
            variants.append({
                "relationId": row["relationId"],
                "direction": direction,
                "headSign": head_sign,
                "from": row["from"],
                "to": row["to"],
                "lengthM": row["lengthM"],
                "stops": row["stops"],
            })
        corridors.append({
            "mode": mode,
            "ref": ref,
            "name": f"{mode} {ref}: {group[0]['name'] or (group[0]['from'] + ' — ' + group[0]['to'])}",
            "variants": variants,
        })

    document = {
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "area": area,
        "note": (
            "Все проверенные маршрутные отношения города (непрерывная геометрия, "
            ">=3 остановки на цепочке, все узлы внутри B-2). Направления — модельные "
            "метки 0/1 внутри пары ref, а не измеренная схема."
        ),
        "selection": {
            "method": "scripts/mobility/extract_network.py --write-city-corridors",
            "pbfSha256": sha256_file(pbf),
            "relations": len(rows),
            "corridors": len(corridors),
        },
        "corridors": corridors,
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(
        json.dumps(document, ensure_ascii=False, sort_keys=True, indent=1) + "\n",
        encoding="utf-8",
    )
    by_mode: dict[str, int] = defaultdict(int)
    for row in rows:
        by_mode[row["mode"]] += 1
    print(
        f"Wrote {out_path}: {len(rows)} relations, {len(corridors)} routes "
        f"({dict(by_mode)}), {sum(1 for c in corridors for _ in c['variants'])} variants"
    )
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pbf", default=str(DEFAULT_PBF))
    parser.add_argument("--corridors", default=str(DEFAULT_CORRIDORS))
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    parser.add_argument("--area", choices=["pilot", "city"], default="city")
    parser.add_argument(
        "--survey",
        action="store_true",
        help="напечатать таблицу кандидатов route-отношений и не записывать файл",
    )
    parser.add_argument(
        "--write-city-corridors",
        default="",
        help="записать corridors-файл со всеми проверенными маршрутами города",
    )
    args = parser.parse_args()
    if args.survey:
        return survey(Path(args.pbf), args.area)
    if args.write_city_corridors:
        return write_city_corridors(Path(args.pbf), args.area, Path(args.write_city_corridors))
    return extract(args)


if __name__ == "__main__":
    raise SystemExit(main())
