"""Детерминированный экспорт мобильности в `public/data/mobility/`.

Вход: `data/processed/mobility/network.json` (+ `schedule.json`, если он уже
импортирован). Выход строго по типам `src/shared/mobility.ts`:

    public/data/mobility/manifest.json
    public/data/mobility/chunks/<cx>_<cy>.json      (MobilityChunk)
    public/data/mobility/routes/<variantId>.json    (MobilityRouteFile)

Решения по формату:

* **version** — `MOBILITY_VERSION` (сейчас 1).
* **chunkSize = 512 м** — независимый от тайлов слой. Объект принадлежит ровно
  одному chunk по своему «якорю»: ребро — середина осевой по длине, остановка и
  сигнальный узел — собственные (x, y). Дубликатов на границе нет; если позже
  понадобятся, это допустимо только с одинаковыми id (правило в
  `docs/mobility/ROUTES.md`).
* **округление до 1 см** (`MOBILITY_POSITION_SCALE = 100`): координаты, высоты,
  накопленные длины и `s` остановок. Накопленные длины пересчитываются уже по
  округлённым координатам, поэтому `s` согласована с геометрией.
* **детерминизм**: порядок ключей и массивов фиксирован, `generatedAt` берётся
  из `network.json` (не текущее время), поэтому повторный запуск на тех же
  входах даёт те же sha256. Временная метка появляется только при пересборке
  сети.
* **release**: `network` — sha256 файла сети, `schedule` — sha256 файла
  расписания или `"absent"`, `bindings` — sha256 канонической проекции
  привязок остановок (вариант, seq, stopId, edgeId, laneIndex, s).
* **расписание отсутствует**: маршруты экспортируются с `trips: []`, явный
  `note` в provenance и `warnings` в stdout; это не ошибка.

CLI:
    python scripts/mobility/export.py \
        --network data/processed/mobility/network.json \
        --out public/data/mobility
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_NETWORK = ROOT / "data/processed/mobility/network.json"
DEFAULT_SCHEDULE = ROOT / "data/processed/mobility/schedule.json"
DEFAULT_OUT = ROOT / "public/data/mobility"

MOBILITY_VERSION = 1
CHUNK_SIZE_M = 512.0
DEFAULT_TIME_ZONE = "Europe/Minsk"
STOP_MATCH_M = 60.0
# Допуск упорядоченного сопоставления остановок табло и OSM-отношения.
STOP_MATCH_TOLERANT_M = 90.0


# ---------------------------------------------------------------------------
# Помощники
# ---------------------------------------------------------------------------


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def canonical_json(document) -> str:
    """Канонический JSON для хешей и детерминированной записи."""
    return json.dumps(document, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def round_cm(value: float) -> float:
    """Округлить метры до 1 см; −0.0 приводится к 0.0."""
    result = round(float(value) * 100.0) / 100.0
    return 0.0 if result == 0.0 else result


def round_rad(value: float) -> float:
    result = round(float(value), 6)
    return 0.0 if result == 0.0 else result


def round_polyline(polyline: dict) -> dict:
    """Полилиния: координаты/высоты до 1 см, `s` пересчитана по ним."""
    p = polyline["p"]
    points = [
        (round_cm(p[index]), round_cm(p[index + 1]), round_cm(p[index + 2]))
        for index in range(0, len(p), 3)
    ]
    flat: list[float] = []
    cumulative: list[float] = []
    total = 0.0
    for index, (x, y, h) in enumerate(points):
        if index > 0:
            total += math.hypot(x - points[index - 1][0], y - points[index - 1][1])
        flat.extend((x, y, h))
        cumulative.append(round_cm(total))
    return {"p": flat, "s": cumulative}


def polyline_xy(polyline: dict) -> list[tuple[float, float]]:
    p = polyline["p"]
    return [(p[index], p[index + 1]) for index in range(0, len(p), 3)]


def polyline_length(polyline: dict) -> float:
    return polyline["s"][-1] if polyline["s"] else 0.0


def sample_polyline(polyline: dict, distance: float) -> tuple[float, float, float, float]:
    p = polyline["p"]
    s = polyline["s"]
    count = len(s)
    if count == 0:
        return 0.0, 0.0, 0.0, 0.0
    if count == 1:
        return p[0], p[1], p[2], 0.0
    clamped = min(max(distance, 0.0), s[-1])
    low, high = 0, count - 1
    while low + 1 < high:
        mid = (low + high) >> 1
        if s[mid] <= clamped:
            low = mid
        else:
            high = mid
    s0, s1 = s[low], s[low + 1]
    span = s1 - s0
    t = (clamped - s0) / span if span > 1e-9 else 0.0
    ax, ay, ah = p[low * 3], p[low * 3 + 1], p[low * 3 + 2]
    bx, by, bh = p[high * 3], p[high * 3 + 1], p[high * 3 + 2]
    dx, dy = bx - ax, by - ay
    heading = math.atan2(dy, dx) if math.hypot(dx, dy) > 1e-9 else 0.0
    return ax + (bx - ax) * t, ay + (by - ay) * t, ah + (bh - ah) * t, heading


def bbox_of(points: list[tuple[float, float]]) -> list[float]:
    if not points:
        return [0.0, 0.0, 0.0, 0.0]
    xs = [point[0] for point in points]
    ys = [point[1] for point in points]
    return [round_cm(min(xs)), round_cm(min(ys)), round_cm(max(xs)), round_cm(max(ys))]


def merge_bbox(first: list[float] | None, second: list[float]) -> list[float]:
    if first is None:
        return list(second)
    return [
        round_cm(min(first[0], second[0])),
        round_cm(min(first[1], second[1])),
        round_cm(max(first[2], second[2])),
        round_cm(max(first[3], second[3])),
    ]


def chunk_key_for(x: float, y: float) -> str:
    return f"{math.floor(x / CHUNK_SIZE_M)}_{math.floor(y / CHUNK_SIZE_M)}"


def chunk_bounds(key: str) -> list[float]:
    cx, cy = (int(part) for part in key.split("_"))
    return [
        float(cx) * CHUNK_SIZE_M,
        float(cy) * CHUNK_SIZE_M,
        float(cx + 1) * CHUNK_SIZE_M,
        float(cy + 1) * CHUNK_SIZE_M,
    ]


def route_file_name(variant_id: str) -> str:
    """Имя файла маршрута: `:` недопустим в именах файлов Windows."""
    return "routes/" + variant_id.replace(":", "_") + ".json"


# ---------------------------------------------------------------------------
# Подготовка сети к экспорту
# ---------------------------------------------------------------------------


def prepare_network(network: dict) -> tuple[list[dict], list[dict], list[dict]]:
    """Округлить геометрию, пересчитать `s` и позиции кузовов остановок."""
    edges: list[dict] = []
    edges_by_id: dict[str, dict] = {}
    for edge in network["edges"]:
        export_edge = {
            "id": edge["id"],
            "wayId": int(edge["wayId"]),
            "from": edge["from"],
            "to": edge["to"],
            "modes": list(edge["modes"]),
            "oneway": bool(edge["oneway"]),
            "layer": int(edge.get("layer", 0)),
            "widthM": round_cm(edge["widthM"]),
            "centerline": round_polyline(edge["centerline"]),
            "lanes": [
                {
                    "index": int(lane["index"]),
                    "offset": round_cm(lane["offset"]),
                    "widthM": round_cm(lane["widthM"]),
                    "centerline": round_polyline(lane["centerline"]),
                }
                for lane in edge["lanes"]
            ],
        }
        if edge.get("bridge"):
            export_edge["bridge"] = True
        if edge.get("tunnel"):
            export_edge["tunnel"] = True
        if edge.get("next"):
            export_edge["next"] = list(edge["next"])
        edges.append(export_edge)
        edges_by_id[export_edge["id"]] = export_edge

    variants: list[dict] = []
    for variant in network["variants"]:
        stop_calls: list[dict] = []
        for call in variant["stops"]:
            edge = edges_by_id[call["edgeId"]]
            lane = edge["lanes"][call["laneIndex"]]
            lane_length = polyline_length(lane["centerline"])
            s = round_cm(min(max(call["s"], 0.0), lane_length))
            x, y, h, heading = sample_polyline(lane["centerline"], s)
            stop_calls.append({
                "seq": int(call["seq"]),
                "stopId": call["stopId"],
                "edgeId": call["edgeId"],
                "laneIndex": int(call["laneIndex"]),
                "s": s,
                "heading": round_rad(heading),
                "x": round_cm(x),
                "y": round_cm(y),
                "h": round_cm(h),
                "dwellS": int(round(call["dwellS"])),
                "timed": bool(call.get("timed", False)),
                "binding": call["binding"],
            })
        length = 0.0
        points: list[tuple[float, float]] = []
        for edge_id in variant["edges"]:
            edge = edges_by_id[edge_id]
            used_lane = len(edge["lanes"]) - 1 if variant["mode"] != "tram" else 0
            used_lane = min(used_lane, len(edge["lanes"]) - 1)
            length += polyline_length(edge["lanes"][used_lane]["centerline"])
            points.extend(polyline_xy(edge["centerline"]))
        export_variant = {
            "id": variant["id"],
            "mode": variant["mode"],
            "ref": variant["ref"],
            "headSign": variant["headSign"],
            "direction": 0 if variant["direction"] == 0 else 1,
            "edges": list(variant["edges"]),
            "stops": stop_calls,
            "lengthM": round_cm(length),
            "sourceRelationId": int(variant["sourceRelationId"]),
            "verified": bool(variant["verified"]),
            "bounds": bbox_of(points),
        }
        if variant.get("issues"):
            export_variant["issues"] = list(variant["issues"])
        variants.append(export_variant)

    stops = [
        {
            "id": stop["id"],
            "name": stop.get("name", ""),
            "modes": sorted(set(stop["modes"])),
            "x": round_cm(stop["x"]),
            "y": round_cm(stop["y"]),
            "osmIds": sorted({int(value) for value in stop.get("osmIds", [])}),
        }
        for stop in network["stops"]
    ]
    # Полигоны платформ не экспортируются: в текущем снимке OSM привязка
    # использует узлы платформ, а поле `platform` в контракте опционально.
    signals = [round_signal_node(node) for node in network["signals"]]
    return edges, variants, stops, signals


def round_signal_node(node: dict) -> dict:
    """Округлить сигнальный узел до 1 см, сохранив структуру контракта."""
    movements = []
    for movement in node["movements"]:
        movements.append({
            "id": movement["id"],
            "kind": movement["kind"],
            "approach": {
                "edgeId": movement["approach"]["edgeId"],
                "laneIndex": int(movement["approach"]["laneIndex"]),
            },
            "exitEdgeId": movement.get("exitEdgeId", ""),
            "path": round_polyline(movement["path"]),
            "group": int(movement["group"]),
            "clearanceLengthM": round_cm(movement["clearanceLengthM"]),
        })
    stop_lines = [
        {
            "movement": int(line["movement"]),
            "edgeId": line["edgeId"],
            "laneIndex": int(line["laneIndex"]),
            "s": round_cm(line["s"]),
            "line": [round_cm(value) for value in line["line"]],
            "heading": round_rad(line["heading"]),
        }
        for line in node["stopLines"]
    ]
    heads = [
        {
            "id": head["id"],
            "group": int(head["group"]),
            "x": round_cm(head["x"]),
            "y": round_cm(head["y"]),
            "facing": round_rad(head["facing"]),
            "kind": head["kind"],
            "heightM": round_cm(head["heightM"]),
        }
        for head in node["heads"]
    ]
    groups = [
        {
            "id": group["id"],
            "kind": group["kind"],
            "aspects": list(group["aspects"]),
        }
        for group in node["groups"]
    ]
    phases = [
        {
            "green": [int(value) for value in phase["green"]],
            "greenS": int(round(phase["greenS"])),
            "yellowS": int(round(phase["yellowS"])),
            "allRedS": int(round(phase["allRedS"])),
        }
        for phase in node["program"]["phases"]
    ]
    zones = [
        [round_cm(value) for value in ring]
        for ring in node.get("zones", [])
    ]
    result = {
        "id": node["id"],
        "kind": node["kind"],
        "x": round_cm(node["x"]),
        "y": round_cm(node["y"]),
        "groups": groups,
        "movements": movements,
        "stopLines": stop_lines,
        "heads": heads,
        "program": {
            "id": node["program"]["id"],
            "phases": phases,
            "offsetS": int(round(node["program"]["offsetS"])),
        },
        "conflicts": [[int(first), int(second)] for first, second in node["conflicts"]],
    }
    if zones:
        result["zones"] = zones
    return result


# ---------------------------------------------------------------------------
# Расписание
# ---------------------------------------------------------------------------


def load_schedule(path: Path) -> tuple[dict | None, str, list[str]]:
    """Прочитать schedule.json; вернуть (документ, версия, warnings)."""
    if not path.exists():
        return None, "absent", []
    raw = path.read_bytes()
    version = sha256_bytes(raw)
    try:
        document = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        return None, "absent", [f"schedule.json unreadable: {error}"]
    return document, version, []


SCHEDULE_STATUSES = {"ready", "partial", "unavailable", "synthetic", "absent"}

# --- городской демо-режим: расписание синтезируется в рантайме --------------
# В payload не хранятся десятки тысяч рейсов: вместо этого манифест описывает
# модель (интервал, скорость движения, стоянка), а симулятор строит рейсы сам.
CITY_SYNTHETIC_MODEL = {
    "id": "city-demo-v2",
    # 24 часа без «мёртвых» окон: ночью реже, но транспорт есть всегда.
    "headwayS": {"bus": 900, "trolleybus": 900, "tram": 600},
    "nightHeadwayS": {"bus": 2400, "trolleybus": 2400, "tram": 1800},
    "nightStartS": 23 * 3600,
    "nightEndS": 5 * 3600 + 30 * 60,
    "firstDepartureS": 0,
    "lastDepartureS": 86_340,
    "cruiseMps": {"bus": 7.0, "trolleybus": 7.0, "tram": 6.5},
    "dwellS": {"bus": 20, "trolleybus": 20, "tram": 12},
    "calendarId": "cal:synthetic-city",
}
CITY_SYNTHETIC_CALENDAR = {
    "id": "cal:synthetic-city",
    "startDate": "2026-01-01",
    "endDate": "2027-12-31",
    "weekdays": [0, 1, 2, 3, 4, 5, 6],
    "timeZone": "Europe/Minsk",
}


def schedule_publication(schedule: dict | None) -> tuple[str, str, bool]:
    """Честный статус расписания в релизе: (status, note, publishable).

    Публикуются только `ready`/`partial` с непустыми маршрутами. Данные со
    статусом `unavailable` (нет разрешения на переиспользование) и синтетические
    фикстуры по умолчанию НЕ публикуются: пустое расписание лучше выдуманного.
    Синтетика допускается только явным флагом `--allow-synthetic-timetable` и
    остаётся помеченной `synthetic` в манифесте.
    """
    if schedule is None:
        return (
            "absent",
            "data/processed/mobility/schedule.json отсутствует: рейсы не экспортируются, "
            "времена не выдумываются",
            False,
        )
    status = str(schedule.get("status") or "unavailable")
    source = schedule.get("source") or {}
    note = str(source.get("note") or schedule.get("note") or "")
    if status not in SCHEDULE_STATUSES:
        status = "unavailable"
    has_routes = bool(schedule.get("routes"))
    if status in {"ready", "partial"}:
        return status, note, has_routes
    if status == "synthetic":
        return (
            "synthetic",
            note or "синтетическое расписание: только для проверки движения, не публичное",
            has_routes,
        )
    return "unavailable", note or "публичное расписание недоступно", False


def fill_variant_stop_times(
    calls: list[dict],
    mapped: list[dict],
    speed_mps: float = 6.5,
) -> tuple[list[dict], int]:
    """Достроить времена всех остановок варианта по сопоставленным.

    Табло и OSM-отношение почти никогда не совпадают по числу остановок: в одном
    из источников части остановок нет. Для сопоставленных берём реальное время,
    для остальных — линейную интерполяцию по расстоянию, на краях — экстраполяцию
    с модельной скоростью. Возвращает (полный список, сколько интерполировано).
    """
    by_seq = {int(item["seq"]): item for item in mapped}
    known = sorted(by_seq)
    if len(known) < 2:
        return [], len(calls)
    ordered = sorted(calls, key=lambda call: int(call["seq"]))
    if len(known) == len(ordered):
        return [
            {
                "seq": int(item["seq"]),
                "arrivalS": int(item["arrivalS"]),
                "departureS": int(item["departureS"]),
            }
            for item in sorted(mapped, key=lambda item: int(item["seq"]))
        ], 0
    cumulative = {int(ordered[0]["seq"]): 0.0}
    for index in range(1, len(ordered)):
        previous, current = ordered[index - 1], ordered[index]
        cumulative[int(current["seq"])] = cumulative[int(previous["seq"])] + math.hypot(
            float(current["x"]) - float(previous["x"]),
            float(current["y"]) - float(previous["y"]),
        )

    def time_at(seq_a: int, seq_b: int, time_a: float, time_b: float, seq: int) -> float:
        span = cumulative[seq_b] - cumulative[seq_a]
        if span <= 1e-6:
            return float(time_a)
        return float(time_a) + (float(time_b) - float(time_a)) * (
            cumulative[seq] - cumulative[seq_a]
        ) / span

    first, last = known[0], known[-1]
    result: list[dict] = []
    interpolated = 0
    for call in ordered:
        seq = int(call["seq"])
        if seq in by_seq:
            arrival = int(by_seq[seq]["arrivalS"])
            departure = int(by_seq[seq]["departureS"])
        elif seq < first:
            arrival = int(
                round(float(by_seq[first]["arrivalS"]) - (cumulative[first] - cumulative[seq]) / speed_mps)
            )
            departure = arrival
            interpolated += 1
        elif seq > last:
            arrival = int(
                round(float(by_seq[last]["departureS"]) + (cumulative[seq] - cumulative[last]) / speed_mps)
            )
            departure = arrival
            interpolated += 1
        else:
            left = max(seq_k for seq_k in known if seq_k < seq)
            right = min(seq_k for seq_k in known if seq_k > seq)
            arrival = int(round(time_at(left, right, by_seq[left]["arrivalS"], by_seq[right]["arrivalS"], seq)))
            departure = int(round(time_at(left, right, by_seq[left]["departureS"], by_seq[right]["departureS"], seq)))
            if departure < arrival:
                departure = arrival
            interpolated += 1
        result.append({"seq": seq, "arrivalS": arrival, "departureS": departure})
    for index in range(1, len(result)):
        if result[index]["arrivalS"] < result[index - 1]["departureS"]:
            shift = result[index - 1]["departureS"] - result[index]["arrivalS"]
            result[index]["arrivalS"] += shift
            result[index]["departureS"] = max(result[index]["departureS"] + shift, result[index]["arrivalS"])
    return result, interpolated


def match_schedule(
    variants: list[dict],
    schedule: dict | None,
    stop_names: dict[str, str],
    unavailable_note: str = "",
) -> tuple[dict[str, list[dict]], list[dict], list[dict], list[str]]:
    """Сопоставить маршруты/остановки расписания с геометрией.

    Возвращает (рейсы по вариантам, календари, отчёт покрытия, warnings).
    Сопоставление остановок: сначала по `seq`, затем (если координаты дальше
    допуска) по имени среди ещё не занятых остановок; несопоставленное
    перечисляется, а не выбрасывается молча.
    """
    warnings: list[str] = []
    trips_by_variant: dict[str, list[dict]] = defaultdict(list)
    coverage: list[dict] = []
    calendars: list[dict] = []
    if schedule is None:
        note = "schedule absent"
        if unavailable_note:
            note = "schedule not published: " + unavailable_note
        for variant in variants:
            coverage.append({
                "variantId": variant["id"],
                "scheduledStops": 0,
                "matchedStops": 0,
                "scheduledTrips": 0,
                "exportedTrips": 0,
                "note": note,
            })
        if unavailable_note:
            warnings.append("schedule unavailable: " + unavailable_note)
        return dict(trips_by_variant), calendars, coverage, warnings

    calendars = list(schedule.get("calendars") or [])
    calendar_ids = {calendar.get("id") for calendar in calendars}
    routes_by_key: dict[tuple[str, str, int], dict] = {}
    for route in schedule.get("routes") or []:
        key = (str(route.get("mode")), str(route.get("ref")), int(route.get("direction", 0)))
        routes_by_key[key] = route

    def endpoints_distance(variant: dict, route: dict) -> tuple[float, float] | None:
        """Совпадение конечных точек: (прямой порядок, обратный порядок)."""
        scheduled_stops = route.get("stops") or []
        calls = variant.get("stops") or []
        if len(scheduled_stops) < 2 or len(calls) < 2:
            return None

        def distance(first: dict, second: dict) -> float:
            return math.hypot(
                float(first.get("x", 1e9)) - float(second.get("x", 1e9)),
                float(first.get("y", 1e9)) - float(second.get("y", 1e9)),
            )

        forward = distance(calls[0], scheduled_stops[0]) + distance(calls[-1], scheduled_stops[-1])
        backward = distance(calls[0], scheduled_stops[-1]) + distance(calls[-1], scheduled_stops[0])
        return forward, backward

    def find_route(variant: dict) -> tuple[dict, bool] | None:
        """Расписание по (mode/ref/direction) с учётом ориентации.

        Метка направления в OSM и на табло может не совпадать; порядок остановок
        на табло может быть обратным порядку нашего варианта. Возвращает
        (маршрут, reversed): во втором случае остановки и времена табло нужно
        читать в обратном порядке.
        """
        candidates: list[dict] = []
        direct = routes_by_key.get((variant["mode"], variant["ref"], variant["direction"]))
        if direct is not None:
            candidates.append(direct)
        for direction in (0, 1):
            candidate = routes_by_key.get((variant["mode"], variant["ref"], direction))
            if candidate is not None and all(candidate is not item for item in candidates):
                candidates.append(candidate)
        best_forward: tuple[float, dict] | None = None
        best_backward: tuple[float, dict] | None = None
        for candidate in candidates:
            scores = endpoints_distance(variant, candidate)
            if scores is None:
                continue
            forward, backward = scores
            if forward <= 1500.0 and (best_forward is None or forward < best_forward[0]):
                best_forward = (forward, candidate)
            if backward <= 1500.0 and (best_backward is None or backward < best_backward[0]):
                best_backward = (backward, candidate)
        # Прямой порядок всегда предпочтительнее: обратный — только запасной путь.
        if best_forward is not None:
            return best_forward[1], False
        if best_backward is not None:
            return best_backward[1], True
        return None

    for variant in variants:
        matched_route = find_route(variant)
        route = None if matched_route is None else matched_route[0]
        reversed_order = False if matched_route is None else matched_route[1]
        if route is None:
            coverage.append({
                "variantId": variant["id"],
                "scheduledStops": 0,
                "matchedStops": 0,
                "scheduledTrips": 0,
                "exportedTrips": 0,
                "note": "no schedule route for mode/ref/direction",
            })
            warnings.append(f"schedule: no route for {variant['id']}")
            continue
        scheduled_stops = sorted(route.get("stops") or [], key=lambda item: int(item.get("seq", 0)))
        seq_remap: dict[int, int] = {}
        if reversed_order:
            # Табло перечисляет остановки в обратном порядке: разворачиваем список
            # и перенумеровываем seq, чтобы дальнейшее сопоставление шло в порядке
            # нашего варианта.
            count = len(scheduled_stops)
            seq_remap = {
                int(stop.get("seq", 0)): count - 1 - index
                for index, stop in enumerate(scheduled_stops)
            }
            scheduled_stops = [
                {**stop, "seq": seq_remap[int(stop.get("seq", 0))]}
                for stop in reversed(scheduled_stops)
            ]
        ordered_calls = sorted(variant["stops"], key=lambda call: int(call["seq"]))
        mapping: dict[int, int] = {}
        unmatched: list[dict] = []
        cursor = 0
        # Упорядоченное сопоставление с окном: табло и OSM-отношение могут
        # отличаться числом остановок, но порядок вдоль трассы сохраняется.
        for stop in scheduled_stops:
            seq = int(stop.get("seq", -1))
            stop_x = float(stop.get("x", 1e9))
            stop_y = float(stop.get("y", 1e9))
            name = str(stop.get("name") or "")
            best: tuple[float, int, float, bool] | None = None
            for offset in range(0, min(6, len(ordered_calls) - cursor)):
                candidate = ordered_calls[cursor + offset]
                distance = math.hypot(stop_x - candidate["x"], stop_y - candidate["y"])
                candidate_name = stop_names.get(candidate["stopId"], "")
                same_name = bool(name) and bool(candidate_name) and (
                    name in candidate_name or candidate_name in name
                )
                score = distance if distance <= STOP_MATCH_TOLERANT_M else distance + (
                    0.0 if same_name else 500.0
                )
                if best is None or score < best[0]:
                    best = (score, cursor + offset, distance, same_name)
            if best is not None and (best[2] <= STOP_MATCH_TOLERANT_M or best[3]):
                mapping[seq] = int(ordered_calls[best[1]]["seq"])
                cursor = best[1] + 1
            else:
                unmatched.append({"seq": seq, "name": name})
        if unmatched:
            warnings.append(
                f"schedule: {len(unmatched)} stop(s) of {route.get('name') or variant['ref']} "
                f"direction {variant['direction']} not matched: "
                + ", ".join(str(item["seq"]) for item in unmatched[:8])
            )
        scheduled_trips = route.get("trips") or []
        exported = 0
        skipped = 0
        for trip in scheduled_trips:
            stop_times = sorted(
                trip.get("stopTimes") or [], key=lambda item: int(item.get("seq", 0))
            )
            if reversed_order and stop_times:
                # Разворот времени: вдоль нашего варианта время должно расти,
                # поэтому t' = Tmax + Tmin - t.
                arrivals = [int(item["arrivalS"]) for item in stop_times]
                time_min, time_max = min(arrivals), max(arrivals)
                stop_times = [
                    {
                        "seq": seq_remap[int(item.get("seq", 0))],
                        "arrivalS": time_max + time_min - int(item["arrivalS"]),
                        "departureS": time_max + time_min - int(item["departureS"]),
                    }
                    for item in stop_times
                ]
            mapped: list[dict] = []
            for stop_time in stop_times:
                schedule_seq = int(stop_time.get("seq", -1))
                variant_seq = mapping.get(schedule_seq)
                if variant_seq is None:
                    continue
                mapped.append({
                    "seq": variant_seq,
                    "arrivalS": int(stop_time["arrivalS"]),
                    "departureS": int(stop_time["departureS"]),
                })
            if len(mapped) < min(3, len(variant["stops"])):
                skipped += 1
                continue
            mapped.sort(key=lambda item: item["seq"])
            previous = None
            monotonic = True
            for item in mapped:
                if item["arrivalS"] > item["departureS"]:
                    monotonic = False
                    break
                if previous is not None and item["arrivalS"] < previous:
                    monotonic = False
                    break
                previous = item["departureS"]
            if not monotonic:
                skipped += 1
                continue
            # Достраиваем времена отсутствующих остановок варианта (интерполяция
            # по расстоянию): табло и OSM-отношение редко совпадают по составу.
            full, interpolated = fill_variant_stop_times(variant["stops"], mapped)
            if len(full) != len(variant["stops"]):
                skipped += 1
                continue
            mapped = full
            calendar_id = str(trip.get("calendarId") or "")
            if calendar_id and calendar_ids and calendar_id not in calendar_ids:
                warnings.append(
                    f"schedule: trip of {variant['id']} uses unknown calendar {calendar_id}"
                )
            source_trip_id = trip.get("sourceTripId")
            if source_trip_id:
                trip_id = f"t:{source_trip_id}"
            else:
                digest = sha256_bytes(canonical_json(mapped).encode("utf-8"))[:16]
                trip_id = f"t:h{digest}"
            trips_by_variant[variant["id"]].append({
                "id": trip_id,
                "variantId": variant["id"],
                "calendarId": calendar_id,
                "stopTimes": mapped,
                "complete": bool(trip.get("complete", True)),
                **({"sourceTripId": str(source_trip_id)} if source_trip_id else {}),
            })
            exported += 1
        if skipped:
            warnings.append(
                f"schedule: {skipped} trip(s) of {variant['id']} skipped "
                "(stops/seq/times do not cover the variant)"
            )
        coverage.append({
            "variantId": variant["id"],
            "scheduledStops": len(scheduled_stops),
            "matchedStops": len(mapping),
            "unmatchedStops": unmatched,
            "scheduledTrips": len(scheduled_trips),
            "exportedTrips": exported,
            "skippedTrips": skipped,
        })
    return dict(trips_by_variant), calendars, coverage, warnings


# ---------------------------------------------------------------------------
# Сборка payload
# ---------------------------------------------------------------------------


def build_payload(
    network: dict,
    edges: list[dict],
    variants: list[dict],
    stops: list[dict],
    signals: list[dict],
    schedule: dict | None,
    schedule_version: str,
    schedule_status: str = "absent",
    schedule_note: str = "",
    schedule_publishable: bool | None = None,
    synthetic_model: dict | None = None,
) -> tuple[dict, dict, dict[str, dict], dict[str, dict], list[str]]:
    # Callers that don't pass an explicit publication decision (tests, older
    # scripts) get the conservative default: only licensed ready/partial data is
    # published, never synthetic or unavailable snapshots.
    if schedule_publishable is None:
        if schedule is None:
            schedule_publishable = False
        else:
            # A document without `status` is the format documented in
            # docs/mobility/CONTRACT.md (used by fixtures/older importers): its
            # routes are published. A document WITH a status publishes only
            # licensed ready/partial data, never synthetic or unavailable ones.
            status = schedule.get("status")
            if status is None:
                schedule_publishable = bool(schedule.get("routes"))
            else:
                schedule_publishable = str(status) in {"ready", "partial"} and bool(
                    schedule.get("routes")
                )
    stop_names = {stop["id"]: stop.get("name", "") for stop in stops}
    trips_by_variant, calendars, coverage, schedule_warnings = match_schedule(
        variants,
        schedule if schedule_publishable else None,
        stop_names,
        "" if schedule_publishable else schedule_note,
    )
    warnings = list(schedule_warnings)

    by_id_stops = {stop["id"]: stop for stop in stops}

    # Якоря и раскладка по chunks: объект ровно в одном chunk по центру.
    chunks: dict[str, dict] = {}

    def chunk_for(key: str) -> dict:
        if key not in chunks:
            chunks[key] = {
                "version": MOBILITY_VERSION,
                "key": key,
                "bounds": chunk_bounds(key),
                "edges": [],
                "stops": [],
                "signals": [],
            }
        return chunks[key]

    for edge in edges:
        length = polyline_length(edge["centerline"])
        anchor_x, anchor_y, _, _ = sample_polyline(edge["centerline"], length / 2.0)
        chunk = chunk_for(chunk_key_for(anchor_x, anchor_y))
        chunk["edges"].append(edge)

    for stop in stops:
        chunk_for(chunk_key_for(stop["x"], stop["y"]))["stops"].append(stop)

    for node in signals:
        chunk_for(chunk_key_for(node["x"], node["y"]))["signals"].append(node)

    for chunk in chunks.values():
        chunk["edges"].sort(key=lambda item: item["id"])
        chunk["stops"].sort(key=lambda item: item["id"])
        chunk["signals"].sort(key=lambda item: item["id"])

    # Файлы маршрутов.
    route_files: dict[str, dict] = {}
    route_index: list[dict] = []
    calendars_used: set[str] = set()
    total_trips = 0
    for variant in variants:
        trips = trips_by_variant.get(variant["id"], [])
        trips.sort(key=lambda item: (
            item["stopTimes"][0]["departureS"] if item["stopTimes"] else 0,
            item["id"],
        ))
        total_trips += len(trips)
        trip_calendars = sorted({trip["calendarId"] for trip in trips if trip["calendarId"]})
        calendars_used.update(trip_calendars)
        file = route_file_name(variant["id"])
        route_files[file] = {
            "version": MOBILITY_VERSION,
            "variant": variant,
            "trips": trips,
        }
        route_index.append({
            "id": variant["id"],
            "mode": variant["mode"],
            "ref": variant["ref"],
            "headSign": variant["headSign"],
            "direction": variant["direction"],
            "file": file,
            "bounds": variant["bounds"],
            "lengthM": variant["lengthM"],
            "verified": variant["verified"],
            "stops": len(variant["stops"]),
            "trips": len(trips),
            "calendars": trip_calendars,
        })
    route_index.sort(key=lambda item: item["id"])

    # Индекс chunks: размер payload считаем по уже сериализованному тексту.
    chunk_index: list[dict] = []
    chunk_texts: dict[str, str] = {}
    for key in sorted(chunks):
        chunk = chunks[key]
        text = canonical_json(chunk) + "\n"
        chunk_texts[key] = text
        chunk_index.append({
            "key": key,
            "bounds": chunk["bounds"],
            "file": f"chunks/{key}.json",
            "edges": len(chunk["edges"]),
            "stops": len(chunk["stops"]),
            "signals": len(chunk["signals"]),
            "bytes": len(text.encode("utf-8")),
        })

    signal_index = [
        {"id": node["id"], "x": node["x"], "y": node["y"], "chunk": chunk_key_for(node["x"], node["y"])}
        for node in signals
    ]
    signal_index.sort(key=lambda item: item["id"])

    # Границы покрытия — по фактическим объектам (не по исходному bbox сети).
    bounds: list[float] | None = None
    for edge in edges:
        bounds = merge_bbox(bounds, bbox_of(polyline_xy(edge["centerline"])))
    for stop in stops:
        bounds = merge_bbox(bounds, [stop["x"], stop["y"], stop["x"], stop["y"]])
    for node in signals:
        bounds = merge_bbox(bounds, [node["x"], node["y"], node["x"], node["y"]])
    if bounds is None:
        bounds = [round_cm(value) for value in network.get("bounds", [0, 0, 0, 0])]

    # release
    network_sha = _NETWORK_SHA256 or "absent"
    bindings_projection = []
    for variant in variants:
        for call in variant["stops"]:
            bindings_projection.append([
                variant["id"],
                call["seq"],
                call["stopId"],
                call["edgeId"],
                call["laneIndex"],
                round_cm(call["s"]),
            ])
    bindings_sha = sha256_bytes(canonical_json(bindings_projection).encode("utf-8"))
    release = {
        "network": network_sha,
        "schedule": schedule_version,
        "bindings": bindings_sha,
    }

    provenance: list[dict] = [{
        "source": "OpenStreetMap extract",
        "url": str(network.get("source", {}).get("pbf") or "data/raw/Minsk.osm.pbf"),
        "retrievedAt": str(
            network.get("source", {}).get("replicationTimestamp")
            or network.get("generatedAt")
            or ""
        ),
        "licence": "(c) OpenStreetMap contributors, ODbL 1.0",
        "note": (
            "Two verified route corridors (bus 39, tram 9), both directions. "
            "Signal phases and vehicle dimensions are model parameters, not measured data."
        ),
    }]
    if schedule is not None:
        source = schedule.get("source") or {}
        note = str(source.get("note") or "")
        if not schedule_publishable:
            note = schedule_note or note
            note = (
                (note + " " if note else "")
                + "Снимок расписания не публикуется (status="
                + schedule_status
                + "): рейсы не экспортируются, времена не выдумываются."
            )
        elif not (schedule.get("routes") or []):
            note = (
                (note + " " if note else "")
                + "Снимок расписания пуст (status="
                + schedule_status
                + "): рейсы не экспортируются, времена не выдумываются."
            )
        provenance.append({
            "source": str(source.get("source") or "public schedule"),
            "url": str(source.get("url") or ""),
            "retrievedAt": str(source.get("retrievedAt") or ""),
            "licence": str(source.get("licence") or ""),
            "note": note,
        })
    else:
        provenance.append({
            "source": "public schedule (not imported)",
            "url": "absent",
            "retrievedAt": "",
            "licence": "",
            "note": (
                "data/processed/mobility/schedule.json is absent: route variants are "
                "exported without trips (trips: []). Timings are not invented."
            ),
        })
    if synthetic_model is not None:
        provenance.append({
            "source": "procedural demo timetable (whole-city mode)",
            "url": "scripts/mobility/export.py:--timetable=procedural",
            "retrievedAt": "",
            "licence": "model parameters, not a public timetable",
            "note": (
                "Рейсы не хранятся в payload: интервал, скорость движения и стоянки — "
                "модельные параметры (headwayS/cruiseMps/dwellS), симулятор строит рейсы "
                "по ним. Это не расписание перевозчика."
            ),
        })

    calendars_used_final = sorted(
        (calendar for calendar in calendars if calendar.get("id") in calendars_used),
        key=lambda item: str(item.get("id")),
    )
    if synthetic_model is not None:
        # Гибрид: у покрытых расписанием вариантов — реальные рейсы и их
        # календари; у остальных — процедурная модель.
        by_id = {str(calendar.get("id")): calendar for calendar in calendars_used_final}
        by_id[CITY_SYNTHETIC_CALENDAR["id"]] = CITY_SYNTHETIC_CALENDAR
        for entry in route_index:
            if int(entry.get("trips") or 0) == 0:
                entry["calendars"] = [CITY_SYNTHETIC_CALENDAR["id"]]
        calendars_used_final = sorted(by_id.values(), key=lambda item: str(item.get("id")))

    manifest = {
        "version": MOBILITY_VERSION,
        "generatedAt": str(network.get("generatedAt") or ""),
        "epsg": int(network.get("epsg") or 32635),
        "originUtm": [
            round_cm(network.get("originUtm", [0.0, 0.0])[0]),
            round_cm(network.get("originUtm", [0.0, 0.0])[1]),
        ],
        "chunkSize": CHUNK_SIZE_M,
        "bounds": bounds,
        "chunks": chunk_index,
        "routes": route_index,
        "signalNodes": signal_index,
        "calendars": calendars_used_final,
        "release": release,
        "provenance": provenance,
        "scheduleStatus": schedule_status,
        "scheduleNote": schedule_note,
        "counts": {
            "edges": len(edges),
            "stops": len(stops),
            "signalNodes": len(signals),
            "variants": len(variants),
            "trips": total_trips,
            "verifiedVariants": sum(1 for variant in variants if variant["verified"]),
        },
    }
    if synthetic_model is not None:
        manifest["timetableMode"] = "procedural"
        manifest["syntheticTimetable"] = synthetic_model
    report = {
        "generatedAt": manifest["generatedAt"],
        "release": release,
        "chunkSize": CHUNK_SIZE_M,
        "chunks": len(chunk_index),
        "routes": len(route_index),
        "trips": total_trips,
        "schedule": coverage,
        "scheduleStatus": schedule_status,
        "scheduleNote": schedule_note,
        "warnings": warnings,
        "stopsOutsideRoutes": sorted(set(by_id_stops) - {
            call["stopId"] for variant in variants for call in variant["stops"]
        }),
        "edgeCountByMode": dict(Counter(
            mode for edge in edges for mode in edge["modes"]
        )),
        "determinism": {
            "generatedAtSource": "network.json",
            "rounding": "0.01 m",
            "note": "same inputs -> same sha256 of manifest, chunks and routes",
        },
    }
    return manifest, report, route_files, chunk_texts, warnings


_NETWORK_SHA256: str | None = None


# ---------------------------------------------------------------------------
# Валидация и запись
# ---------------------------------------------------------------------------


def validate_payload(manifest: dict, chunks: list[dict], routes: dict[str, dict]) -> list[str]:
    """Проверить структуру payload по контракту перед записью."""
    errors: list[str] = []
    if manifest.get("version") != MOBILITY_VERSION:
        errors.append("manifest.version != MOBILITY_VERSION")
    if not isinstance(manifest.get("chunkSize"), float) or manifest["chunkSize"] <= 0:
        errors.append("manifest.chunkSize is invalid")
    release = manifest.get("release") or {}
    for key in ("network", "schedule", "bindings"):
        if not isinstance(release.get(key), str) or not release[key]:
            errors.append(f"manifest.release.{key} is missing")
    chunk_keys = set()
    edge_ids: set[str] = set()
    stop_ids: set[str] = set()
    signal_ids: set[str] = set()
    chunk_pointers = {item["key"]: item for item in manifest.get("chunks", [])}
    if len(chunk_pointers) != len(manifest.get("chunks", [])):
        errors.append("duplicate chunk keys in manifest")
    for chunk in chunks:
        key = chunk.get("key")
        if key in chunk_keys:
            errors.append(f"duplicate chunk file {key}")
        chunk_keys.add(key)
        pointer = chunk_pointers.get(key)
        if pointer is None:
            errors.append(f"chunk {key} is not indexed by the manifest")
            continue
        if pointer["file"] != f"chunks/{key}.json":
            errors.append(f"chunk {key} file name mismatch")
        for edge in chunk.get("edges", []):
            if edge["id"] in edge_ids:
                errors.append(f"edge {edge['id']} appears in more than one chunk")
            edge_ids.add(edge["id"])
            anchor_x, anchor_y, _, _ = sample_polyline(edge["centerline"], polyline_length(edge["centerline"]) / 2.0)
            if chunk_key_for(anchor_x, anchor_y) != key:
                errors.append(f"edge {edge['id']} is in a chunk that does not own its centre")
            if not (0 <= edge["layer"] <= 5):
                errors.append(f"edge {edge['id']} layer out of range")
            if len(edge["centerline"]["s"]) * 3 != len(edge["centerline"]["p"]):
                errors.append(f"edge {edge['id']} polyline p/s mismatch")
            previous = -1.0
            for value in edge["centerline"]["s"]:
                if value < previous - 1e-9:
                    errors.append(f"edge {edge['id']} s decreases")
                    break
                previous = value
        for stop in chunk.get("stops", []):
            if stop["id"] in stop_ids:
                errors.append(f"stop {stop['id']} appears in more than one chunk")
            stop_ids.add(stop["id"])
            if chunk_key_for(stop["x"], stop["y"]) != key:
                errors.append(f"stop {stop['id']} is in a chunk that does not own it")
        for node in chunk.get("signals", []):
            if node["id"] in signal_ids:
                errors.append(f"signal {node['id']} appears in more than one chunk")
            signal_ids.add(node["id"])
            if chunk_key_for(node["x"], node["y"]) != key:
                errors.append(f"signal {node['id']} is in a chunk that does not own it")
            for index, phase in enumerate(node["program"]["phases"]):
                for group_index in phase["green"]:
                    if not 0 <= group_index < len(node["groups"]):
                        errors.append(f"signal {node['id']} phase references unknown group")
            for first, second in node["conflicts"]:
                if not (0 <= first < len(node["movements"]) and 0 <= second < len(node["movements"])):
                    errors.append(f"signal {node['id']} conflict index out of range")
    for pointer in manifest.get("chunks", []):
        if pointer["key"] not in chunk_keys:
            errors.append(f"manifest indexes missing chunk {pointer['key']}")
    route_ids = set()
    for index, entry in enumerate(manifest.get("routes", [])):
        if entry["id"] in route_ids:
            errors.append(f"duplicate route id {entry['id']}")
        route_ids.add(entry["id"])
        file = entry["file"]
        if file not in routes:
            errors.append(f"route {entry['id']} file is not built")
            continue
        variant = routes[file]["variant"]
        if variant["id"] != entry["id"]:
            errors.append(f"route file {file} keeps a different variant id")
        if routes[file]["version"] != MOBILITY_VERSION:
            errors.append(f"route file {file} version mismatch")
        if len(variant["stops"]) != entry["stops"]:
            errors.append(f"route index stop count mismatch for {entry['id']}")
        if len(routes[file]["trips"]) != entry["trips"]:
            errors.append(f"route index trip count mismatch for {entry['id']}")
        variant_stop_seq = [call["seq"] for call in variant["stops"]]
        for trip in routes[file]["trips"]:
            if trip["variantId"] != variant["id"]:
                errors.append(f"trip {trip['id']} references another variant")
            if [item["seq"] for item in trip["stopTimes"]] != variant_stop_seq:
                errors.append(f"trip {trip['id']} stopTimes do not follow the variant")
            previous = None
            for item in trip["stopTimes"]:
                if item["arrivalS"] > item["departureS"]:
                    errors.append(f"trip {trip['id']} arrival after departure")
                if previous is not None and item["arrivalS"] < previous:
                    errors.append(f"trip {trip['id']} times decrease")
                previous = item["departureS"]
    return errors


def write_payload(
    out_dir: Path,
    manifest: dict,
    chunk_texts: dict[str, str],
    route_files: dict[str, dict],
    report: dict | None = None,
    report_path: Path | None = None,
) -> dict[str, str]:
    """Записать payload, удалить устаревшие chunk/route файлы, вернуть sha256."""
    chunks_dir = out_dir / "chunks"
    routes_dir = out_dir / "routes"
    chunks_dir.mkdir(parents=True, exist_ok=True)
    routes_dir.mkdir(parents=True, exist_ok=True)
    hashes: dict[str, str] = {}

    for existing in sorted(chunks_dir.glob("*.json")):
        if f"chunks/{existing.name}" not in {f"chunks/{key}.json" for key in chunk_texts}:
            existing.unlink()
    for existing in sorted(routes_dir.glob("*.json")):
        if f"routes/{existing.name}" not in route_files:
            existing.unlink()

    for key in sorted(chunk_texts):
        path = chunks_dir / f"{key}.json"
        data = chunk_texts[key].encode("utf-8")
        path.write_bytes(data)
        hashes[f"chunks/{key}.json"] = sha256_bytes(data)

    for file in sorted(route_files):
        path = out_dir / file
        data = (canonical_json(route_files[file]) + "\n").encode("utf-8")
        path.write_bytes(data)
        hashes[file] = sha256_bytes(data)

    manifest_text = canonical_json(manifest) + "\n"
    # write_bytes, а не write_text: на Windows текстовый режим заменил бы \n на
    # \r\n, и sha256 файла разошёлся бы с хешем, попадающим в digest.
    (out_dir / "manifest.json").write_bytes(manifest_text.encode("utf-8"))
    hashes["manifest.json"] = sha256_bytes(manifest_text.encode("utf-8"))

    if report is not None and report_path is not None:
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(
            json.dumps(report, ensure_ascii=False, sort_keys=True, indent=2) + "\n",
            encoding="utf-8",
        )
    return hashes


def main() -> int:
    global _NETWORK_SHA256
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--network", default=str(DEFAULT_NETWORK))
    parser.add_argument("--schedule", default=str(DEFAULT_SCHEDULE))
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    parser.add_argument(
        "--allow-unpublishable-schedule",
        action="store_true",
        help=(
            "личный режим: использовать снимок со status=unavailable (нет разрешения на "
            "переиспользование), только вместе с --timetable=procedural; статус станет partial"
        ),
    )
    parser.add_argument(
        "--timetable",
        choices=["stored", "procedural"],
        default="stored",
        help=(
            "stored — рейсы из schedule.json; procedural — городской демо-режим: "
            "рейсы синтезируются симулятором по модели (headway/cruise/dwell)"
        ),
    )
    parser.add_argument(
        "--allow-synthetic-timetable",
        action="store_true",
        help=(
            "публиковать синтетическое расписание (status=synthetic) для проверки движения; "
            "без флага такие рейсы не экспортируются и не выдаются за публичные"
        ),
    )
    args = parser.parse_args()

    network_path = Path(args.network)
    if not network_path.exists():
        print(f"ERROR: network not found: {network_path}; run build_network.py first", file=sys.stderr)
        return 1
    network_bytes = network_path.read_bytes()
    _NETWORK_SHA256 = sha256_bytes(network_bytes)
    network = json.loads(network_bytes.decode("utf-8"))

    if network.get("version") != MOBILITY_VERSION:
        print(
            f"ERROR: network version {network.get('version')} != MOBILITY_VERSION {MOBILITY_VERSION}",
            file=sys.stderr,
        )
        return 2
    unverified = [variant["id"] for variant in network["variants"] if not variant["verified"]]
    if unverified:
        print(
            f"ERROR: refusing to export unverified variants: {unverified}",
            file=sys.stderr,
        )
        return 2

    synthetic_model = CITY_SYNTHETIC_MODEL if args.timetable == "procedural" else None
    if synthetic_model is not None:
        # Гибридный городской режим: если есть пригодный снимок расписания, его
        # рейсы используются для покрытых маршрутов, а процедурная модель — для
        # остальных. Иначе весь город живёт на модели.
        schedule, schedule_version, schedule_warnings = load_schedule(Path(args.schedule))
        schedule_status, schedule_note, schedule_publishable = schedule_publication(schedule)
        if (
            not schedule_publishable
            and args.allow_unpublishable_schedule
            and schedule is not None
            and schedule.get("routes")
        ):
            # Личный гибрид: реальные времена из снимка табло, несмотря на статус
            # источника. Публикация таких данных требует разрешения перевозчика.
            schedule_publishable = True
            schedule_status = "partial"
            schedule_note = (
                "Личный гибрид: реальные времена из незалицензированного снимка табло "
                "(status=unavailable) + процедурная модель для непокрытых маршрутов"
            )
        if schedule_publishable:
            schedule_status = "partial"
            schedule_note = (
                (schedule_note + " " if schedule_note else "")
                + "Гибрид: рейсы покрытых маршрутов — из публичного расписания, "
                "остальные синтезируются по модели (процедурный fallback)"
            )
        else:
            schedule = None
            schedule_version = f"procedural:{synthetic_model['id']}"
            schedule_status = "synthetic"
            schedule_note = (
                "Городской демо-режим: рейсы синтезируются симулятором по модели "
                "(интервал/скорость/стоянка), а не берутся из публичного расписания"
            )
            schedule_publishable = False
            schedule_warnings = []
    else:
        schedule, schedule_version, schedule_warnings = load_schedule(Path(args.schedule))
        schedule_status, schedule_note, schedule_publishable = schedule_publication(schedule)
        if schedule_status == "synthetic" and args.allow_synthetic_timetable:
            schedule_publishable = bool(schedule and schedule.get("routes"))
    prepared = prepare_network(network)
    edges, variants, stops, signals = prepared[0], prepared[1], prepared[2], prepared[3]

    manifest, report, route_files, chunk_texts, schedule_warnings2 = build_payload(
        network,
        edges,
        variants,
        stops,
        signals,
        schedule,
        schedule_version,
        schedule_status,
        schedule_note,
        schedule_publishable,
        synthetic_model,
    )
    warnings = schedule_warnings + schedule_warnings2
    report["warnings"] = warnings

    chunks = [json.loads(text) for text in chunk_texts.values()]
    problems = validate_payload(manifest, chunks, route_files)
    if problems:
        for problem in problems:
            print(f"ERROR: {problem}", file=sys.stderr)
        return 2

    hashes = write_payload(Path(args.out), manifest, chunk_texts, route_files)
    # Сводка экспорта дописывается в существующий report.json (зона записи
    # network-агента): отдельный файл в public/data/mobility не нужен.
    report_path = ROOT / "data/processed/mobility/report.json"
    combined = {}
    if report_path.exists():
        try:
            combined = json.loads(report_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            combined = {}
    combined["export"] = {
        "generatedAt": manifest["generatedAt"],
        "release": manifest["release"],
        "chunkSize": CHUNK_SIZE_M,
        "chunks": len(chunk_texts),
        "files": len(hashes),
        "digest": sha256_bytes(canonical_json(hashes).encode("utf-8")),
        "schedule": report.get("schedule"),
        "scheduleStatus": report.get("scheduleStatus"),
        "warnings": warnings,
        "determinism": report.get("determinism"),
    }
    report_path.write_text(
        json.dumps(combined, ensure_ascii=False, sort_keys=True, indent=2) + "\n",
        encoding="utf-8",
    )
    print(
        f"Wrote {args.out}: {manifest['counts']['edges']} edges, "
        f"{manifest['counts']['stops']} stops, {manifest['counts']['signalNodes']} signal nodes, "
        f"{manifest['counts']['variants']} variants, {manifest['counts']['trips']} trips"
    )
    print(f"  release {manifest['release']}")
    print(f"  chunks {len(chunk_texts)}, files {len(hashes)}")
    for warning in warnings:
        print(f"  WARNING: {warning}")
    # sha256 всех файлов — для проверки детерминизма при повторном запуске.
    print("  digest " + sha256_bytes(canonical_json(hashes).encode("utf-8")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
