"""Сборка проверенной сети общественного транспорта из `network_raw.json`.

Задача этапа 3 плана: направленные `MobilityEdge` с полосами, высотами,
привязкой остановок к полосе и сигнальными узлами; выход строго по типам
`src/shared/mobility.ts` (поля в camelCase, как в контракте).

Что делает модуль:

* склеивает route-отношение по общим узлам (`extract_network.assemble_chain`);
  way-член, идущий против порядка узлов, разворачивается по топологии, а не по
  близости координат. Разрыв не «лечится»: он попадает в issues, вариант
  получает ``verified = false``;
* режет цепочку на рёбра в точках соединения ways и в узлах остановок — так
  `from`/`to` рёбер всегда исходные OSM-узлы, а кузов стоит ровно в узле
  `stop_position`;
* строит центры полос со смещением от осевой (mitre с ограничением на острых
  углах), ширину/число полос из тегов с дефолтами и пометкой источника;
* берёт высоты из того же профиля, что фактическое покрытие: треугольники
  `ground.decks` публичных тайлов (`public/data/city-tiles`), а при их
  отсутствии — модельный профиль из `scripts/normalize/bridge_decks.py`
  (`DECK_RISE_M`, `DECK_MAX_SLOPE`, `_smoothstep`). Мост и дорога под ним не
  соединяются: высоты назначаются только узлам мостовых ways, связи — по OSM
  node id, не по XY;
* привязывает остановки по направлению и стороне улицы, ставит центр КУЗОВА на
  полосу и отодвигает его от зебры, если кузов попадает на переход;
* строит сигнальные узлы выбранных пересечений: подходы/выезды, стоп-линии,
  движения (vehicle/tram/pedestrian), группы, матрицу конфликтов по swept path
  и модельную программу фаз (параметры модели, не измеренные данные);
* пишет `report.json` с длинами, разрывами, причинами и исходными ID и
  проверяет инварианты контракта; при нарушении падает с понятной ошибкой.

CLI:
    python scripts/mobility/build_network.py \
        --raw data/processed/mobility/network_raw.json \
        --out data/processed/mobility/network.json \
        --report data/processed/mobility/report.json
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from collections import Counter, defaultdict
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR.parents[1]))
sys.path.insert(0, str(SCRIPT_DIR.parent))          # scripts/
sys.path.insert(0, str(SCRIPT_DIR))                 # scripts/mobility/
sys.path.insert(0, str(SCRIPT_DIR.parent / "normalize"))

from shapely.geometry import LineString, Point, Polygon  # noqa: E402
from shapely.ops import unary_union  # noqa: E402
from shapely.strtree import STRtree  # noqa: E402

import bridge_decks  # noqa: E402
import extract_network as en  # noqa: E402

ROOT = SCRIPT_DIR.parents[1]
DEFAULT_RAW = ROOT / "data/processed/mobility/network_raw.json"
DEFAULT_OUT = ROOT / "data/processed/mobility/network.json"
DEFAULT_REPORT = ROOT / "data/processed/mobility/report.json"
SCHEDULE_PATH = ROOT / "data/processed/mobility/schedule.json"
CITY_TILES = ROOT / "public/data/city-tiles"
CITY_TILE_SIZE_M = 1024.0

# Версия схемы payload (совпадает с MOBILITY_VERSION в src/shared/mobility.ts).
MOBILITY_VERSION = 1

# --- параметры модели (не измеренные данные) --------------------------------
DEFAULT_LANE_WIDTH_M = 3.25
LANE_WIDTH_BY_CLASS_M = {
    "motorway": 3.75,
    "trunk": 3.75,
    "primary": 3.5,
    "secondary": 3.25,
    "tertiary": 3.0,
    "residential": 3.0,
    "unclassified": 3.0,
    "living_street": 3.0,
    "service": 2.75,
}
TRAM_LANE_WIDTH_M = 2.6          # габарит вагона + запас; не ширина колеи
TRAM_EDGE_WIDTH_M = 2.6
BODY_LENGTH_M = {"bus": 12.0, "trolleybus": 12.0, "tram": 15.0}
BODY_WIDTH_M = {"bus": 2.55, "trolleybus": 2.55, "tram": 2.5}
MODEL_DWELL_S = 20.0
MODEL_DWELL_BY_MODE_S = {"bus": 20.0, "trolleybus": 20.0, "tram": 12.0}
PED_SWEPT_WIDTH_M = 2.0
STOP_LINE_SETBACK_M = 1.0
SIGNAL_ON_LANE_M = 30.0
SIGNAL_CLUSTER_M = 45.0
# Без полигона перекрёстка стоп-линию отодвигаем от точки светофора на столько
# метров: сама точка OSM часто стоит уже на перекрёстке.
NO_FACE_SETBACK_M = 6.0
SIGNAL_FACE_SEARCH_M = 45.0
HEAD_KERB_OFFSET_M = {"vehicle": 1.4, "tram": 1.0}
HEAD_MIN_KERB_OFFSET_M = 0.9
SIGNAL_GEOMETRY_VIOLATIONS: list[str] = []
# Сколько головок пришлось убрать (некуда поставить) — статистика сборки.
SIGNAL_HEADS_DROPPED: Counter = Counter()
APPROACH_MAX_M = 40.0
CROSSING_SIGNAL_M = 22.0
SIGNAL_KERB_CLEARANCE_M = 0.8
SIGNAL_KERB_MAX_M = 14.0
MOVEMENT_EXIT_PROBE_M = 15.0
CONFLICT_AREA_M2 = 0.5
DENSIFY_STEP_M = 1.0             # шаг сгущения профиля на мосту, м
MAX_HEIGHT_STEP_M = 0.5          # ступенька между соседними вершинами профиля
MODEL_PROGRAM_ID = "city-v1"      # id набора модельных параметров фаз

ROUND_M = 3                       # точность промежуточных файлов
STOP_ROLES = ("stop", "stop_entry_only", "stop_exit_only")

ISSUE_FATAL_PREFIXES = (
    "geometry-gap",
    "missing-way",
    "stop-unbound",
    "stop-wrong-side",
    "stop-on-crossing",
    "turn-restriction",
    "layer-mix",
)


# ---------------------------------------------------------------------------
# Мелкие помощники
# ---------------------------------------------------------------------------


def as_float(value, default: float | None = None) -> float | None:
    try:
        result = float(str(value).replace(",", "."))
    except (TypeError, ValueError):
        return default
    if not math.isfinite(result):
        return default
    return result


def as_int(value, default: int | None = None) -> int | None:
    try:
        result = int(round(float(str(value))))
    except (TypeError, ValueError):
        return default
    return result


def effective_oneway(tags: dict) -> bool:
    if tags.get("junction") == "roundabout":
        return True
    value = str(tags.get("oneway", "")).lower()
    return value in ("yes", "true", "1", "-1")


def way_layer(tags: dict) -> int:
    layer = as_int(tags.get("layer"), 0)
    return 0 if layer is None else layer


def is_bridge(tags: dict) -> bool:
    return str(tags.get("bridge", "")).lower() in ("yes", "true", "1", "viaduct", "boardwalk")


def is_tunnel(tags: dict) -> bool:
    return str(tags.get("tunnel", "")).lower() in ("yes", "true", "1", "building_passage")


def make_polyline(points: list[list[float]]) -> dict:
    """Плоская полилиния [x,y,h,…] + накопленная длина; без дублей вершин."""
    cleaned: list[list[float]] = []
    for x, y, h in points:
        x, y = round(float(x), ROUND_M), round(float(y), ROUND_M)
        h = round(float(h), ROUND_M)
        if cleaned and abs(cleaned[-1][0] - x) < 1e-9 and abs(cleaned[-1][1] - y) < 1e-9:
            continue
        cleaned.append([x, y, h])
    p: list[float] = []
    s: list[float] = []
    total = 0.0
    for index, (x, y, h) in enumerate(cleaned):
        if index > 0:
            total += math.hypot(x - cleaned[index - 1][0], y - cleaned[index - 1][1])
        p.extend((x, y, h))
        s.append(round(total, ROUND_M))
    return {"p": p, "s": s}


def polyline_xy(polyline: dict) -> list[tuple[float, float]]:
    p = polyline["p"]
    return [(p[i], p[i + 1]) for i in range(0, len(p), 3)]


def polyline_length(polyline: dict) -> float:
    return polyline["s"][-1] if polyline["s"] else 0.0


def sample_polyline(polyline: dict, distance: float) -> tuple[float, float, float, float]:
    """Позиция, высота и путевой угол на расстоянии `distance` вдоль полилинии."""
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


def offset_polyline(
    coords: list[tuple[float, float]],
    offset: float,
    mitre_limit: float = 2.0,
) -> list[tuple[float, float]]:
    """Сместить полилинию влево (+) или вправо (−) на `offset` метров.

    Соединение — mitre: в вершине берётся биссектриса соседних нормалей, а
    масштаб ограничен `mitre_limit × |offset|`, поэтому на острых углах полоса
    не «выстреливает» на десятки метров. При вырожденной геометрии вершина
    смещается по одной из нормалей.
    """
    if abs(offset) < 1e-9 or len(coords) < 2:
        return [(float(x), float(y)) for x, y in coords]
    unit_normals: list[tuple[float, float]] = []
    for (ax, ay), (bx, by) in zip(coords, coords[1:]):
        dx, dy = bx - ax, by - ay
        length = math.hypot(dx, dy)
        if length <= 1e-9:
            unit_normals.append((0.0, 0.0))
        else:
            unit_normals.append((-dy / length, dx / length))
    result: list[tuple[float, float]] = []
    for index, (x, y) in enumerate(coords):
        if index == 0:
            nx, ny = unit_normals[0]
            result.append((x + nx * offset, y + ny * offset))
            continue
        if index == len(coords) - 1:
            nx, ny = unit_normals[-1]
            result.append((x + nx * offset, y + ny * offset))
            continue
        n1 = unit_normals[index - 1]
        n2 = unit_normals[index]
        mx, my = n1[0] + n2[0], n1[1] + n2[1]
        length = math.hypot(mx, my)
        if length <= 1e-9:
            mx, my, scale = n1[0], n1[1], offset
        else:
            mx, my = mx / length, my / length
            cosine = mx * n1[0] + my * n1[1]
            if cosine <= 1e-6:
                mx, my, scale = n1[0], n1[1], offset
            else:
                scale = offset / max(cosine, 1.0 / mitre_limit)
        result.append((x + mx * scale, y + my * scale))
    return result


def signed_lateral(polyline: dict, point: tuple[float, float]) -> tuple[float, float]:
    """(s, поперечное смещение) точки относительно линии; + = слева от движения.

    Касательная берётся по окну вокруг проекции, поэтому остановка в самом конце
    ребра (s == length) тоже получает корректную сторону, а не ноль.
    """
    line = LineString(polyline_xy(polyline))
    s = line.project(Point(point))
    projected = line.interpolate(s)
    before = max(0.0, s - 1.0)
    after = min(line.length, s + 1.0)
    if after - before <= 1e-9:
        before, after = max(0.0, line.length - 1.0), line.length
    tangent_start = line.interpolate(before)
    tangent_end = line.interpolate(after)
    dx, dy = tangent_end.x - tangent_start.x, tangent_end.y - tangent_start.y
    length = math.hypot(dx, dy)
    if length <= 1e-9:
        return s, 0.0
    cross = (dx * (point[1] - projected.y) - dy * (point[0] - projected.x)) / length
    return s, cross


# ---------------------------------------------------------------------------
# Высоты: треугольники фактических deck-плит
# ---------------------------------------------------------------------------


class DeckSampler:
    """Выборка высоты покрытия из треугольников `ground.decks` тайлов.

    Тот же профиль, которым уже нарисован мост в городе: интерполируем z внутри
    треугольника, берём максимум среди перекрывающихся плит (настил выше дороги
    под ним). Используется только для узлов мостовых ways — обычная дорога под
    мостом не должна «наследовать» высоту настила.
    """

    def __init__(self, triangles: list[list[float]], stats: dict) -> None:
        self.triangles = triangles
        self.stats = stats
        self.hits = 0
        self.misses = 0
        self.polygons = [
            Polygon([(t[0], t[1]), (t[3], t[4]), (t[6], t[7])]) for t in triangles
        ]
        self.tree = STRtree(self.polygons) if self.polygons else None

    def sample(self, x: float, y: float) -> float | None:
        if self.tree is None:
            self.misses += 1
            return None
        point = Point(x, y)
        best: float | None = None
        for index in self.tree.query(point):
            triangle = self.triangles[int(index)]
            z = _triangle_height(triangle, x, y)
            if z is None:
                continue
            if best is None or z > best:
                best = z
        if best is None:
            self.misses += 1
        else:
            self.hits += 1
        return best


def _triangle_height(triangle: list[float], x: float, y: float) -> float | None:
    """Барицентрическая высота в треугольнике (None, если точка вне)."""
    x1, y1, z1, x2, y2, z2, x3, y3, z3 = triangle
    denominator = (y2 - y3) * (x1 - x3) + (x3 - x2) * (y1 - y3)
    if abs(denominator) < 1e-12:
        return None
    a = ((y2 - y3) * (x - x3) + (x3 - x2) * (y - y3)) / denominator
    b = ((y3 - y1) * (x - x3) + (x1 - x3) * (y - y3)) / denominator
    c = 1.0 - a - b
    if a < -1e-9 or b < -1e-9 or c < -1e-9:
        return None
    return a * z1 + b * z2 + c * z3


def load_deck_triangles(tiles_dir: Path, bounds: tuple[float, float, float, float]) -> DeckSampler:
    """Прочитать deck-треугольники тайлов, пересекающих bbox коридора."""
    stats: Counter = Counter()
    triangles: list[list[float]] = []
    if not tiles_dir.exists():
        stats["tilesMissing"] += 1
        return DeckSampler(triangles, dict(stats))
    minx, miny, maxx, maxy = bounds
    min_tx = math.floor(minx / CITY_TILE_SIZE_M)
    max_tx = math.floor(maxx / CITY_TILE_SIZE_M)
    min_ty = math.floor(miny / CITY_TILE_SIZE_M)
    max_ty = math.floor(maxy / CITY_TILE_SIZE_M)
    for tx in range(min_tx, max_tx + 1):
        for ty in range(min_ty, max_ty + 1):
            path = tiles_dir / f"{tx}_{ty}.json"
            if not path.exists():
                stats["tilesMissing"] += 1
                continue
            stats["tilesRead"] += 1
            try:
                tile = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                stats["tilesUnreadable"] += 1
                continue
            for deck in tile.get("ground", {}).get("decks", []):
                flat = deck.get("t", [])
                stats["decks"] += 1
                for index in range(0, len(flat) - 8, 9):
                    triangle = [float(v) for v in flat[index:index + 9]]
                    triangles.append(triangle)
                    stats["triangles"] += 1
    return DeckSampler(triangles, dict(stats))


def load_road_surface(tiles_dir: Path, bounds: tuple[float, float, float, float]) -> dict:
    """Поверхность, которую игрок видит как асфальт (для проверки стоек).

    Собираем штрихи дорог (road/tram) с их шириной и заливки `ground.fills`
    (асфальт медиан/разделителей). Тайлы не содержат `roadSurfaces`, поэтому
    этот набор и есть фактическая проезжая часть на карте. Стойка, попавшая в
    него, выглядит как светофор посреди дороги — её надо сдвинуть или убрать.
    """
    lines: list[tuple[LineString, float]] = []
    fills: list[Polygon] = []
    if not tiles_dir.exists():
        return {"lines": lines, "fills": fills, "lineTree": None, "fillTree": None}
    minx, miny, maxx, maxy = bounds
    for tx in range(math.floor(minx / CITY_TILE_SIZE_M), math.floor(maxx / CITY_TILE_SIZE_M) + 1):
        for ty in range(math.floor(miny / CITY_TILE_SIZE_M), math.floor(maxy / CITY_TILE_SIZE_M) + 1):
            path = tiles_dir / f"{tx}_{ty}.json"
            if not path.exists():
                continue
            try:
                tile = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            ground = tile.get("ground") or {}
            for stroke in ground.get("strokes") or []:
                if stroke.get("k") not in ("road", "tram"):
                    continue
                flat = stroke.get("p") or []
                if len(flat) < 6:
                    continue
                try:
                    line = LineString(
                        [(flat[i], flat[i + 1]) for i in range(0, len(flat) - 1, 2)]
                    )
                except Exception:  # noqa: BLE001
                    continue
                if line.is_empty or line.length <= 0:
                    continue
                lines.append((line, max(1.0, float(stroke.get("w") or 3.0) / 2.0)))
            for fill in ground.get("fills") or []:
                if fill.get("m") not in ("asphalt", "tram"):
                    continue
                flat = fill.get("p") or []
                if len(flat) < 6:
                    continue
                try:
                    polygon = Polygon(
                        [(flat[i], flat[i + 1]) for i in range(0, len(flat) - 1, 2)]
                    )
                except Exception:  # noqa: BLE001
                    continue
                if polygon.is_valid and polygon.area > 1.0:
                    fills.append(polygon)
    line_tree = STRtree([line for line, _ in lines]) if lines else None
    fill_tree = STRtree(fills) if fills else None
    return {"lines": lines, "fills": fills, "lineTree": line_tree, "fillTree": fill_tree}


def road_hit(
    point: Point,
    road_surface: dict | None,
    face: dict | None,
) -> str | None:
    """Тип асфальта под точкой: junction / stroke / fill / None (суша)."""
    if face is not None and face["polygon"].buffer(0.3).contains(point):
        return "junction"
    if not road_surface:
        return None
    line_tree = road_surface.get("lineTree")
    lines = road_surface["lines"]
    if line_tree is not None:
        for index in line_tree.query(point.buffer(1.0)):
            line, half = lines[int(index)]
            if line.distance(point) <= half + 0.3:
                return "stroke"
    fill_tree = road_surface.get("fillTree")
    if fill_tree is not None:
        for index in fill_tree.query(point.buffer(1.0)):
            polygon = road_surface["fills"][int(index)]
            if polygon.buffer(0.1).contains(point):
                return "fill"
    return None


def nearest_road_centerline(point: Point, road_surface: dict) -> Point | None:
    """Ближайшая точка осевой дороги — направление отхода от асфальта."""
    line_tree = road_surface.get("lineTree")
    if line_tree is None:
        return None
    best: tuple[float, Point] | None = None
    for index in line_tree.query(point.buffer(12.0)):
        line, _ = road_surface["lines"][int(index)]
        projected = line.interpolate(line.project(point))
        distance = projected.distance(point)
        if best is None or distance < best[0]:
            best = (distance, projected)
    return None if best is None else best[1]


def relocate_head(
    head: dict,
    road_surface: dict | None,
    face: dict | None,
    max_steps: int = 24,
    step_m: float = 0.8,
) -> tuple[float, float] | None:
    """Сдвинуть стойку с асфальта на сушу; `None` — сдвинуть не удалось."""
    point = Point(head["x"], head["y"])
    for _ in range(max_steps):
        hit = road_hit(point, road_surface, face)
        if hit is None:
            return (point.x, point.y)
        if hit in {"stroke", "fill"} and road_surface:
            center = nearest_road_centerline(point, road_surface)
            if center is not None:
                dx = point.x - center.x
                dy = point.y - center.y
                length = math.hypot(dx, dy)
                if length < 0.05:
                    dx, dy, length = 1.0, 0.0, 1.0
                point = Point(point.x + dx / length * step_m, point.y + dy / length * step_m)
                continue
        if face is not None:
            centroid = face["polygon"].centroid
            dx = point.x - centroid.x
            dy = point.y - centroid.y
            length = math.hypot(dx, dy) or 1.0
            point = Point(point.x + dx / length * step_m, point.y + dy / length * step_m)
            continue
        return None
    return None


def load_junction_faces(tiles_dir: Path, bounds: tuple[float, float, float, float]) -> list[dict]:
    """Прочитать полигоны перекрёстков из тайлов, пересекающих bbox коридора.

    Тайловый payload содержит реальную геометрию перекрёстка (`junctions[].polygon`)
    и стоп-линии подходов (`approachEdges[].stopLine`). Это единственный корректный
    источник для размещения стоп-линий и светофорных головок: точка OSM
    `highway=traffic_signals` часто стоит на самом перекрёстке.
    """
    faces: list[dict] = []
    if not tiles_dir.exists():
        return faces
    minx, miny, maxx, maxy = bounds
    for tx in range(math.floor(minx / CITY_TILE_SIZE_M), math.floor(maxx / CITY_TILE_SIZE_M) + 1):
        for ty in range(math.floor(miny / CITY_TILE_SIZE_M), math.floor(maxy / CITY_TILE_SIZE_M) + 1):
            path = tiles_dir / f"{tx}_{ty}.json"
            if not path.exists():
                continue
            try:
                tile = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            for junction in tile.get("junctions") or []:
                ring = (junction.get("polygon") or [[]])[0]
                if not ring or len(ring) < 3:
                    continue
                # Тайловый контракт хранит кольцо как массив пар [x, y]; на случай
                # плоского кольца поддерживаем и его.
                if isinstance(ring[0], (list, tuple)):
                    points = [(float(point[0]), float(point[1])) for point in ring]
                else:
                    points = [
                        (float(ring[index]), float(ring[index + 1]))
                        for index in range(0, len(ring) - 1, 2)
                    ]
                if len(points) < 3:
                    continue
                try:
                    polygon = Polygon(points)
                except Exception:  # noqa: BLE001 - битый полигон тайла, пропускаем
                    continue
                if not polygon.is_valid or polygon.area < 1.0:
                    continue
                faces.append({
                    "id": junction.get("id"),
                    "x": float(junction.get("x", polygon.centroid.x)),
                    "y": float(junction.get("y", polygon.centroid.y)),
                    "polygon": polygon,
                    "areaM2": polygon.area,
                })
    return faces


def _recompute_arcs(polyline: dict) -> None:
    """Пересчитать накопленные длины после смещения вершин."""
    points = polyline["p"]
    count = len(points) // 3
    distances = [0.0] * count
    for index in range(1, count):
        distances[index] = distances[index - 1] + math.hypot(
            points[index * 3] - points[index * 3 - 3],
            points[index * 3 + 1] - points[index * 3 - 2],
        )
    polyline["s"] = [round(value, 3) for value in distances]


def _blend_tail(polyline: dict, joint: tuple[float, float], blend_m: float) -> None:
    """Плавно свести хвост полосы к общей точке стыка (`blend_m` метров)."""
    points, distances = polyline["p"], polyline["s"]
    count = len(distances)
    delta_x = joint[0] - points[(count - 1) * 3]
    delta_y = joint[1] - points[(count - 1) * 3 + 1]
    total = distances[-1] if distances[-1] > 0 else 0.0
    for index in range(count):
        behind = total - distances[index]
        if behind > blend_m:
            continue
        weight = 1.0 - behind / blend_m
        points[index * 3] += delta_x * weight
        points[index * 3 + 1] += delta_y * weight
    points[(count - 1) * 3] = joint[0]
    points[(count - 1) * 3 + 1] = joint[1]
    _recompute_arcs(polyline)


def _blend_head(polyline: dict, joint: tuple[float, float], blend_m: float) -> None:
    """Плавно свести начало полосы к общей точке стыка (`blend_m` метров)."""
    points, distances = polyline["p"], polyline["s"]
    count = len(distances)
    delta_x = joint[0] - points[0]
    delta_y = joint[1] - points[1]
    for index in range(count):
        ahead = distances[index]
        if ahead > blend_m:
            continue
        weight = 1.0 - ahead / blend_m
        points[index * 3] += delta_x * weight
        points[index * 3 + 1] += delta_y * weight
    points[0] = joint[0]
    points[1] = joint[1]
    _recompute_arcs(polyline)


def stitch_variant_lanes(
    edges: list[dict],
    mode: str,
    blend_m: float = 14.0,
) -> list[dict]:
    """Сшить правую полосу соседних рёбер варианта в непрерывную линию пути.

    Раньше каждая полоса смещалась от осевой независимо, поэтому в узле конец
    одной полосы и начало следующей расходились на 2–12 м: транспорт «прыгал»
    между полосами поперёк дороги. Здесь оба конца сводятся к общей точке, а
    боковой сдвиг распределяется на `blend_m` метров — машина перестраивается
    плавно, а не телепортируется.
    """
    adjustments: list[dict] = []
    for index in range(len(edges) - 1):
        first, second = edges[index], edges[index + 1]
        if first["to"] != second["from"]:
            continue
        lane_a = first["lanes"][len(first["lanes"]) - 1 if mode != "tram" else 0]
        lane_b = second["lanes"][len(second["lanes"]) - 1 if mode != "tram" else 0]
        arc_a, arc_b = lane_a["centerline"]["s"], lane_b["centerline"]["s"]
        point_a, point_b = lane_a["centerline"]["p"], lane_b["centerline"]["p"]
        if len(arc_a) < 2 or len(arc_b) < 2:
            continue
        end_a = (point_a[-3], point_a[-2])
        start_b = (point_b[0], point_b[1])
        gap = math.hypot(end_a[0] - start_b[0], end_a[1] - start_b[1])
        if gap < 0.05:
            continue
        joint = ((end_a[0] + start_b[0]) / 2.0, (end_a[1] + start_b[1]) / 2.0)
        _blend_tail(lane_a["centerline"], joint, blend_m)
        _blend_head(lane_b["centerline"], joint, blend_m)
        adjustments.append({
            "edgeId": first["id"],
            "next": second["id"],
            "gapBeforeM": round(gap, 2),
        })
    return adjustments


# ---------------------------------------------------------------------------
# Полосы
# ---------------------------------------------------------------------------


def lane_plan(tags: dict, mode: str, dir_flag: str) -> dict:
    """Ширина и число полос направления: из тегов, с дефолтами и источником."""
    highway_class = tags.get("highway") or ""
    oneway = effective_oneway(tags)
    lanes_total = as_int(tags.get("lanes"))
    if lanes_total is None or lanes_total < 1:
        lanes_total = 1 if oneway else 2
    if mode == "tram":
        return {
            "oneway": True,
            "lanes": 1,
            "laneWidthM": TRAM_LANE_WIDTH_M,
            "widthM": TRAM_EDGE_WIDTH_M,
            "sources": {
                "lanes": "model:tram",
                "width": "model:tram-envelope",
            },
        }
    class_lane_width = LANE_WIDTH_BY_CLASS_M.get(highway_class, DEFAULT_LANE_WIDTH_M)
    width_tag = as_float(tags.get("width"))
    lanes_forward = as_int(tags.get("lanes:forward"))
    lanes_backward = as_int(tags.get("lanes:backward"))
    if width_tag is not None and width_tag > 0.5:
        total_width = width_tag
        width_source = "tag:width"
    else:
        total_width = lanes_total * class_lane_width
        width_source = "model:lanes*class"
    if oneway:
        direction_lanes = lanes_total
        direction_width = total_width
        lanes_source = "tag:lanes" if tags.get("lanes") else "model:default-oneway"
    else:
        if lanes_forward is None or lanes_backward is None:
            lanes_forward = max(1, lanes_total // 2)
            lanes_backward = max(1, lanes_total - lanes_forward)
            lanes_source = "model:lanes-split"
        else:
            lanes_source = "tag:lanes:forward/backward"
        direction_lanes = lanes_forward if dir_flag == "f" else lanes_backward
        direction_width = total_width * direction_lanes / max(1, lanes_forward + lanes_backward)
    direction_lanes = max(1, direction_lanes)
    return {
        "oneway": oneway,
        "lanes": direction_lanes,
        "laneWidthM": round(direction_width / direction_lanes, 3),
        "widthM": round(direction_width, 3),
        "sources": {"lanes": lanes_source, "width": width_source},
    }


def build_lanes(
    edge_xy: list[tuple[float, float]],
    heights: list[float],
    plan: dict,
    mode: str,
) -> list[dict]:
    """Центры полос: смещение от осевой, mitre, ширина полосы."""
    count = plan["lanes"]
    lane_width = plan["laneWidthM"]
    offsets: list[float] = []
    if mode == "tram" or plan["oneway"]:
        half = count * lane_width / 2.0
        for index in range(count):
            offsets.append(round(half - (index + 0.5) * lane_width, 3))
    else:
        for index in range(count):
            offsets.append(round(-(index + 0.5) * lane_width, 3))
    lanes: list[dict] = []
    for index, offset in enumerate(offsets):
        shifted = offset_polyline(edge_xy, offset)
        points = [
            [x, y, heights[i] if i < len(heights) else 0.0]
            for i, (x, y) in enumerate(shifted)
        ]
        lane_polyline = make_polyline(points)
        if offset == 0.0:
            lane_polyline = make_polyline(
                [[x, y, heights[i] if i < len(heights) else 0.0] for i, (x, y) in enumerate(edge_xy)]
            )
        lanes.append({
            "index": index,
            "offset": float(offset),
            "widthM": float(lane_width),
            "centerline": lane_polyline,
        })
    return lanes


# ---------------------------------------------------------------------------
# Сборка варианта
# ---------------------------------------------------------------------------


def oriented_runs(chain: dict, ways: dict) -> list[list[dict]]:
    """Непрерывные участки цепочки: список сегментов без разрывов.

    ``assemble_chain`` уже пометил разрывы; здесь они превращаются в отдельные
    участки, чтобы ребро никогда не перепрыгивало разрыв.
    """
    runs: list[list[dict]] = []
    current: list[dict] = []
    previous_end: int | None = None
    for segment in chain["segments"]:
        way = ways.get(segment["wayId"])
        if way is None:
            continue
        nodes = list(way["nodes"])
        if segment["reversed"]:
            nodes = list(reversed(nodes))
        if previous_end is not None and nodes[0] != previous_end:
            if current:
                runs.append(current)
            current = []
        current.append({"wayId": segment["wayId"], "reversed": bool(segment["reversed"]), "nodes": nodes})
        previous_end = nodes[-1]
    if current:
        runs.append(current)
    return runs


def edge_id(way_id: int, dir_flag: str, sequence: int) -> str:
    """Стабильный id ребра; суффикс — только если way разрезан на части.

    Контракт задаёт `e:<osmWayId>:<dir>`; нарезка way в узле остановки даёт
    несколько рёбер одного way, поэтому части 2+ получают суффикс `:<k>`.
    Это осознанное расширение контракта, см. docs/mobility/ROUTES.md.
    """
    base = f"e:{way_id}:{dir_flag}"
    return base if sequence <= 1 else f"{base}:{sequence}"


def node_ref(node_id: int) -> str:
    return f"n:{node_id}"


def build_variant(
    corridor: dict,
    variant: dict,
    raw: dict,
    ways: dict[int, dict],
    nodes: dict[int, dict],
    heights_by_node: dict[int, tuple[float, str]],
    sampler: "DeckSampler",
) -> dict:
    """Собрать ребра, привязки остановок и issues одного варианта маршрута."""
    relation = variant
    mode = corridor["mode"]
    issues: list[str] = []
    member_ways = [m["ref"] for m in relation["members"] if m["type"] == "w"]
    chain = en.assemble_chain(member_ways, ways, nodes)
    for gap in chain["gaps"]:
        issues.append(
            "geometry-gap: "
            + json.dumps(gap, ensure_ascii=False, sort_keys=True)
        )
    runs = oriented_runs(chain, ways)
    if not runs:
        issues.append("missing-way: no usable member geometry")

    # Узлы, которые должны быть в chain: наблюдаемая проверка полноты.
    stop_members = [
        m for m in relation["members"] if m["type"] == "n" and m["role"] in STOP_ROLES
    ]

    edges: list[dict] = []
    edge_sequence: Counter = Counter()
    run_edges: list[list[int]] = []

    for run in runs:
        run_edge_indices: list[int] = []
        for segment in run:
            way = ways[segment["wayId"]]
            tags = way["tags"]
            dir_flag = "b" if segment["reversed"] else "f"
            plan = lane_plan(tags, mode, dir_flag)
            node_ids = segment["nodes"]
            # Точки разреза внутри way: узлы остановок этого варианта.
            cut_positions = {0, len(node_ids) - 1}
            for member in stop_members:
                if member["ref"] in node_ids:
                    cut_positions.add(node_ids.index(member["ref"]))
            ordered = sorted(cut_positions)
            for start, end in zip(ordered, ordered[1:]):
                piece = node_ids[start:end + 1]
                if len(piece) < 2:
                    continue
                edge_sequence[(way["id"], dir_flag)] += 1
                sequence = edge_sequence[(way["id"], dir_flag)]
                way_elevated = is_bridge(tags) or is_tunnel(tags) or way_layer(tags) != 0
                coords = []
                heights = []
                for first_node, second_node in zip(piece, piece[1:]):
                    start = nodes[first_node]
                    end = nodes[second_node]
                    start_h = heights_by_node.get(first_node, (0.0, "ground"))[0]
                    end_h = heights_by_node.get(second_node, (0.0, "ground"))[0]
                    if not coords:
                        coords.append((float(start["x"]), float(start["y"])))
                        heights.append(float(start_h))
                    if not way_elevated:
                        coords.append((float(end["x"]), float(end["y"])))
                        heights.append(float(end_h))
                        continue
                    # Мостовая вставка OSM часто состоит из одной прямой
                    # 2-узловой линии, а фактический настил имеет рампу. Чтобы
                    # профиль совпал с покрытием, линия сгущается прямо по
                    # треугольникам deck-плит; геометрия при этом не выдумана —
                    # это та же OSM-линия.
                    length = math.hypot(end["x"] - start["x"], end["y"] - start["y"])
                    steps = max(1, math.ceil(length / DENSIFY_STEP_M))
                    for step in range(1, steps + 1):
                        fraction = step / steps
                        x = start["x"] + (end["x"] - start["x"]) * fraction
                        y = start["y"] + (end["y"] - start["y"]) * fraction
                        if step == steps:
                            height = float(end_h)
                        else:
                            sample = sampler.sample(x, y)
                            height = float(sample) if sample is not None else (
                                start_h + (end_h - start_h) * fraction
                            )
                        coords.append((float(x), float(y)))
                        heights.append(height)
                centerline = make_polyline(
                    [[x, y, heights[i]] for i, (x, y) in enumerate(coords)]
                )
                lanes = build_lanes(coords, heights, plan, mode)
                edge = {
                    "id": edge_id(way["id"], dir_flag, sequence),
                    "wayId": int(way["id"]),
                    "from": node_ref(piece[0]),
                    "to": node_ref(piece[-1]),
                    "modes": [mode],
                    "oneway": bool(plan["oneway"]),
                    "layer": way_layer(tags),
                    "widthM": float(plan["widthM"]),
                    "centerline": centerline,
                    "lanes": lanes,
                    "next": [],
                    "source": {
                        "dir": dir_flag,
                        "laneSources": plan["sources"],
                        "bridge": is_bridge(tags),
                        "tunnel": is_tunnel(tags),
                    },
                }
                if is_bridge(tags):
                    edge["bridge"] = True
                if is_tunnel(tags):
                    edge["tunnel"] = True
                edges.append(edge)
                run_edge_indices.append(len(edges) - 1)
        if run_edge_indices:
            run_edges.append(run_edge_indices)
    for run_indices in run_edges:
        for first, second in zip(run_indices, run_indices[1:]):
            if edges[first]["to"] == edges[second]["from"]:
                edges[first]["next"] = [edges[second]["id"]]

    # Городской масштаб: один и тот же way входит в десятки маршрутов, и нарезка
    # даёт одинаковые `e:<way>:<dir>:<k>` у разных вариантов. Даём рёбрам
    # вариант-специфичный суффикс (id отношения): id остаётся стабильным, но
    # уникальным, и экспорт больше не теряет геометрию при совпадении.
    scope = str(relation["relationId"])
    for edge in edges:
        edge["id"] = f"{edge['id']}:{scope}"
        if edge.get("next"):
            edge["next"] = [
                next_id if next_id.endswith(f":{scope}") else f"{next_id}:{scope}"
                for next_id in edge["next"]
            ]

    # Непрерывность полосы движения: соседние рёбра сводятся в одну линию. Делать
    # это нужно ДО привязки остановок, иначе центр кузова сэмплируется по старой
    # (не сшитой) полосе. Три прохода: ребро может участвовать в двух стыках, и
    # после правки одного конца нужно снова свести второй.
    lane_stitches: list[dict] = []
    for _ in range(3):
        lane_stitches = stitch_variant_lanes(edges, mode)

    # --- привязка остановок -------------------------------------------------
    chain_positions: dict[int, int] = {}
    for index, node_id in enumerate(chain["chainNodes"]):
        chain_positions.setdefault(node_id, index)
    edge_by_to = {}
    edge_by_from = {}
    for index, edge in enumerate(edges):
        edge_by_to.setdefault(edge["to"], index)
        edge_by_from.setdefault(edge["from"], index)
    stop_ids: list[str] = []
    bound: list[dict] = []
    unbound: list[dict] = []
    wrong_side: list[dict] = []
    shifted: list[dict] = []
    body_length = BODY_LENGTH_M.get(mode, 12.0)
    platform_members = [
        m["ref"] for m in relation["members"]
        if m["type"] == "n" and m["role"].startswith("platform")
    ]
    edge_lines: dict[str, LineString] = {}
    side_details: list[dict] = []
    platform_by_stop: dict[int, int] = {}
    for member in stop_members:
        node_id = member["ref"]
        record = nodes.get(node_id)
        if record is None:
            unbound.append({"osmId": node_id, "role": member["role"], "reason": "no node"})
            continue
        position = chain_positions.get(node_id)
        if position is None:
            unbound.append({
                "osmId": node_id,
                "role": member["role"],
                "reason": "stop node is not on the variant way chain",
            })
            continue
        edge_index = edge_by_to.get(node_ref(node_id))
        at_start = False
        if edge_index is None:
            edge_index = edge_by_from.get(node_ref(node_id))
            at_start = True
        if edge_index is None:
            unbound.append({
                "osmId": node_id,
                "role": member["role"],
                "reason": "stop node is not an edge boundary",
            })
            continue
        edge = edges[edge_index]
        lane_index = len(edge["lanes"]) - 1 if mode != "tram" else 0
        lane = edge["lanes"][lane_index]
        lane_length = polyline_length(lane["centerline"])
        s = 0.0 if at_start else lane_length
        heading = sample_polyline(lane["centerline"], s)[3]
        # Сторона улицы: `stop_position` обычно стоит на осевой way, поэтому
        # сторона определяется по платформе из того же отношения (role=platform).
        # Плюс = слева от направления движения; справа ожидается отрицательное.
        if edge["id"] not in edge_lines:
            edge_lines[edge["id"]] = LineString(polyline_xy(edge["centerline"]))
        edge_line = edge_lines[edge["id"]]
        _, stop_lateral = signed_lateral(edge["centerline"], (record["x"], record["y"]))
        platform_id = None
        platform_lateral = None
        if platform_members:
            node_name = record.get("tags", {}).get("name")
            candidates = [
                candidate for candidate in platform_members
                if candidate in nodes and (
                    not node_name
                    or nodes[candidate].get("tags", {}).get("name") == node_name
                )
            ]
            if not candidates:
                candidates = [candidate for candidate in platform_members if candidate in nodes]
            if candidates:
                platform_id = min(
                    candidates,
                    key=lambda candidate: math.hypot(
                        nodes[candidate]["x"] - record["x"],
                        nodes[candidate]["y"] - record["y"],
                    ),
                )
                distance = math.hypot(
                    nodes[platform_id]["x"] - record["x"],
                    nodes[platform_id]["y"] - record["y"],
                )
                if distance <= 60.0:
                    _, platform_lateral = signed_lateral(
                        edge["centerline"],
                        (nodes[platform_id]["x"], nodes[platform_id]["y"]),
                    )
                    platform_by_stop[node_id] = platform_id
        side_lateral = stop_lateral
        if abs(side_lateral) <= 1.5 and platform_lateral is not None:
            side_lateral = platform_lateral
        if abs(side_lateral) <= 0.5:
            side = "unknown"
        else:
            side = "right" if side_lateral < 0 else "left"
        side_details.append({
            "osmId": node_id,
            "side": side,
            "stopLateralM": round(stop_lateral, 2),
            "platformLateralM": None if platform_lateral is None else round(platform_lateral, 2),
            "platformOsmId": platform_id,
        })
        binding = "source-id" if abs(stop_lateral) < 0.01 else "offset-node"
        if side == "left" and mode != "tram":
            issues.append(
                f"stop-wrong-side: stop {node_id} is {side_lateral:.2f} m left of travel on edge {edge['id']}"
            )
            wrong_side.append({"osmId": node_id, "lateralM": round(side_lateral, 2)})
        elif side == "left":
            wrong_side.append({"osmId": node_id, "lateralM": round(side_lateral, 2)})
        # Кузов не должен стоять на зебре: ищем переход рядом и сдвигаем центр.
        shift = resolve_crossing_conflict(
            raw, edge, lane, lane_index, s, body_length, mode
        )
        if shift is not None:
            s = shift["s"]
            shifted.append({
                "osmId": node_id,
                "edgeId": edge["id"],
                "shiftM": round(shift["delta"], 2),
                "reason": "body-on-crossing",
            })
            heading = sample_polyline(lane["centerline"], s)[3]
        x, y, h, _ = sample_polyline(lane["centerline"], s)
        stop_id = f"s:osm:{node_id}"
        stop_ids.append(stop_id)
        bound.append({
            "seq": len(bound),
            "stopId": stop_id,
            "edgeId": edge["id"],
            "laneIndex": lane_index,
            "s": round(s, ROUND_M),
            "heading": round(heading, 6),
            "x": round(x, ROUND_M),
            "y": round(y, ROUND_M),
            "h": round(h, ROUND_M),
            "dwellS": MODEL_DWELL_BY_MODE_S.get(mode, MODEL_DWELL_S),
            "timed": False,
            "binding": binding,
        })
    if unbound:
        for item in unbound:
            issues.append(
                f"stop-unbound: osm node {item['osmId']} ({item.get('reason')})"
            )
    # Длины: сумма длин полосы, по которой идёт вариант; у каждого ребра —
    # своя правая полоса (число полос в way может отличаться).
    length = 0.0
    for edge in edges:
        used_lane = len(edge["lanes"]) - 1 if mode != "tram" else 0
        length += polyline_length(edge["lanes"][used_lane]["centerline"])
    xs = [edge["centerline"]["p"][i] for edge in edges for i in range(0, len(edge["centerline"]["p"]), 3)]
    ys = [edge["centerline"]["p"][i + 1] for edge in edges for i in range(0, len(edge["centerline"]["p"]), 3)]
    bounds = [round(min(xs), 3), round(min(ys), 3), round(max(xs), 3), round(max(ys), 3)] if xs else [0, 0, 0, 0]
    verified = not any(_is_fatal(issue) for issue in issues)
    variant_id = f"r:{corridor['ref']}:{relation['direction']}:{relation['relationId']}"
    result = {
        "id": variant_id,
        "mode": mode,
        "ref": str(corridor["ref"]),
        "headSign": relation["headSign"],
        "direction": 0 if relation["direction"] == 0 else 1,
        "edges": [edge["id"] for edge in edges],
        "stops": bound,
        "lengthM": round(length, ROUND_M),
        "sourceRelationId": int(relation["relationId"]),
        "verified": bool(verified),
        "bounds": bounds,
        "issues": issues,
        "source": {
            "from": relation.get("from"),
            "to": relation.get("to"),
            "name": relation["tags"].get("name"),
        },
    }
    return {
        "variant": result,
        "edges": edges,
        "stopIds": stop_ids,
        "unbound": unbound,
        "wrongSide": wrong_side,
        "shifted": shifted,
        "sideDetails": side_details,
        "platformByStop": platform_by_stop,
    }


def resolve_crossing_conflict(
    raw: dict,
    edge: dict,
    lane: dict,
    lane_index: int,
    s: float,
    body_length: float,
    mode: str,
) -> dict | None:
    """Сдвинуть центр кузова вдоль полосы, если он накрывает зебру.

    Смещение ищется минимальным по модулю шагом 0.25 м в пределах ±(кузов/2+3) м
    и только внутри полосы. Если переход перекрывает всю окрестность, возвращаем
    None — тогда фиксируется issue и вариант не проходит аудит.
    """
    crossings = raw.get("crossings") or []
    if not crossings:
        return None
    lane_length = polyline_length(lane["centerline"])
    half = body_length / 2.0
    line = LineString(polyline_xy(lane["centerline"]))
    intervals: list[tuple[float, float]] = []
    for crossing in crossings:
        point = Point(crossing["x"], crossing["y"])
        if line.distance(point) > lane["widthM"]:
            continue
        s_cross = line.project(point)
        intervals.append((s_cross - half - 0.5, s_cross + half + 0.5))
    if not intervals:
        return None

    def clear(value: float) -> bool:
        return all(not (low <= value <= high) for low, high in intervals)

    if clear(s):
        return None
    limit = int(round((half + 3.0) / 0.25))
    for step in range(1, limit + 1):
        for candidate in (s + step * 0.25, s - step * 0.25):
            if 0.25 <= candidate <= lane_length - 0.25 and clear(candidate):
                return {"s": candidate, "delta": candidate - s}
    return None


def _is_fatal(issue: str) -> bool:
    return any(issue.startswith(prefix) for prefix in ISSUE_FATAL_PREFIXES)


# ---------------------------------------------------------------------------
# Сигнальные узлы
# ---------------------------------------------------------------------------


class UnionFind:
    def __init__(self) -> None:
        self.parent: dict[int, int] = {}

    def find(self, value: int) -> int:
        self.parent.setdefault(value, value)
        while self.parent[value] != value:
            self.parent[value] = self.parent[self.parent[value]]
            value = self.parent[value]
        return value

    def union(self, first: int, second: int) -> None:
        a, b = self.find(first), self.find(second)
        if a != b:
            self.parent[b] = a


def build_signal_nodes(
    raw: dict,
    variants: dict[str, dict],
    junction_faces: list[dict] | None = None,
    road_surface: dict | None = None,
) -> tuple[list[dict], dict]:
    """Собрать сигнальные узлы у выбранных коридоров.

    Кандидаты — узлы `highway=traffic_signals`/`railway=signal` в 30 м от полосы
    движения, сгруппированные в узлы с шагом 45 м. Подходы берутся только из
    рёбер выбранных вариантов: другие улицы пересечения в этой сети не описаны,
    поэтому модель содержит сквозные движения маршрута и пешеходные переходы,
    а повороты на неописанные улицы не изобретаются (см. report.json).
    """
    stats: Counter = Counter()
    lanes: list[tuple[str, dict, int, dict, LineString]] = []
    for variant_id, variant_data in variants.items():
        for edge in variant_data["edges"]:
            lane_index = len(edge["lanes"]) - 1 if edge["modes"][0] != "tram" else 0
            lane = edge["lanes"][lane_index]
            lanes.append((variant_id, edge, lane_index, lane, LineString(polyline_xy(lane["centerline"]))))
    if not lanes:
        return [], dict(stats)

    signals = [
        signal for signal in raw.get("signals", [])
        if signal.get("tags", {}).get("highway") == "traffic_signals"
        or signal.get("tags", {}).get("railway") == "signal"
    ]
    candidates: list[dict] = []
    for signal in signals:
        point = Point(signal["x"], signal["y"])
        best = min((lane[4].distance(point) for lane in lanes), default=math.inf)
        if best <= SIGNAL_ON_LANE_M:
            candidates.append({**signal, "distanceToLaneM": round(best, 2)})
    stats["candidates"] = len(candidates)
    if not candidates:
        return [], dict(stats)

    uf = UnionFind()
    for index, candidate in enumerate(candidates):
        uf.find(index)
    for first in range(len(candidates)):
        for second in range(first + 1, len(candidates)):
            distance = math.hypot(
                candidates[first]["x"] - candidates[second]["x"],
                candidates[first]["y"] - candidates[second]["y"],
            )
            if distance <= SIGNAL_CLUSTER_M:
                uf.union(first, second)
    clusters: dict[int, list[int]] = defaultdict(list)
    for index in range(len(candidates)):
        clusters[uf.find(index)].append(index)
    stats["clusters"] = len(clusters)

    # Пространственный отбор: без него каждый узел перебирал бы ВСЕ полосы города
    # (366 маршрутов) и все переходы, что на масштабе города неподъёмно.
    lane_lines = [lane[4] for lane in lanes]
    lane_tree = STRtree(lane_lines) if lane_lines else None

    # Пешеходные фазы и головки создаются только для РЕГУЛИРУЕМЫХ переходов:
    # иначе на нерегулируемых зебрах появляются светофоры, которых нет в городе.
    crossings = [
        crossing for crossing in (raw.get("crossings") or [])
        if is_signalised_crossing(crossing)
    ]
    stats["signalisedCrossings"] = len(crossings)
    crossing_points = [Point(crossing["x"], crossing["y"]) for crossing in crossings]
    crossing_tree = STRtree(crossing_points) if crossing_points else None
    result: list[dict] = []
    for root in sorted(clusters):
        members = sorted(clusters[root], key=lambda i: candidates[i]["osmId"])
        representative = candidates[members[0]]
        center_x = sum(candidates[i]["x"] for i in members) / len(members)
        center_y = sum(candidates[i]["y"] for i in members) / len(members)
        center_point = Point(center_x, center_y)
        # Только полосы и переходы в радиусе узла: иначе городской прогон
        # перебирает все полосы города на каждый светофор.
        near_lane_indices = lane_tree.query(center_point.buffer(APPROACH_MAX_M))
        node_lanes = [
            lanes[int(index)] for index in near_lane_indices
            if lanes[int(index)][4].distance(center_point) <= APPROACH_MAX_M
        ]
        if crossing_tree is not None:
            near_crossing_indices = crossing_tree.query(center_point.buffer(CROSSING_SIGNAL_M))
            node_crossings = [
                crossings[int(index)] for index in near_crossing_indices
                if crossing_points[int(index)].distance(center_point) <= CROSSING_SIGNAL_M
            ]
        else:
            node_crossings = []
        node = build_signal_node(
            center_x,
            center_y,
            representative,
            candidates,
            members,
            node_lanes,
            node_crossings,
            variants,
            junction_faces,
            road_surface,
        )
        if node is None:
            stats["clustersWithoutMovement"] += 1
            continue
        source = node.get("source") or {}
        # Узел без перекрёстка и без регулируемого перехода — это либо светофор
        # чужой улицы, попавший в радиус, либо одиночная точка: не рисуем его.
        if not source.get("junctionFace") and not int(source.get("crossings") or 0):
            stats["clustersWithoutContext"] += 1
            continue
        result.append(node)
        stats["nodes"] += 1
        stats["movements"] += len(node["movements"])
        stats["conflicts"] += len(node["conflicts"])
        stats["phases"] += len(node["program"]["phases"])
        stats["pedestrianMovements"] += sum(
            1 for movement in node["movements"] if movement["kind"] == "pedestrian"
        )
        stats["tramMovements"] += sum(
            1 for movement in node["movements"] if movement["kind"] == "tram"
        )
    result.sort(key=lambda item: item["id"])
    if SIGNAL_GEOMETRY_VIOLATIONS:
        sample = "\n  - ".join(SIGNAL_GEOMETRY_VIOLATIONS[:10])
        raise SystemExit(
            f"ERROR: {len(SIGNAL_GEOMETRY_VIOLATIONS)} signal geometry violation(s):\n  - {sample}"
        )
    stats["junctionFacesUsed"] = sum(
        1 for node in result if (node.get("source") or {}).get("junctionFace")
    )
    stats["stopLinesFromFace"] = sum(
        int(((node.get("source") or {}).get("setbackSources") or {}).get("junction-face", 0))
        for node in result
    )
    stats["stopLinesFallback"] = sum(
        int(((node.get("source") or {}).get("setbackSources") or {}).get("model-fallback", 0))
        for node in result
    )
    return result, dict(stats)


def is_signalised_crossing(crossing: dict) -> bool:
    """Переход регулируется светофором (иначе пешеходных фаз и головок нет)."""
    tags = crossing.get("tags") or {}
    kind = str(tags.get("crossing") or "").lower()
    if kind in {"traffic_signals", "signal"}:
        return True
    return str(tags.get("crossing:signals") or "").lower() == "yes"


def face_corner_for(
    polygon: Polygon,
    point: tuple[float, float],
    heading: float,
    half_lane_m: float,
) -> tuple[float, float] | None:
    """Кромка тротуара справа от подхода на полигоне перекрёстка.

    Из вершин полигона выбирается та, что лежит справа от полосы на разумном
    боковом удалении и рядом со стоп-линией (не через весь перекрёсток). Это
    угол тротуара, где в городе и стоит стойка, а не середина проезжей части.
    """
    right_x = math.sin(heading)
    right_y = -math.cos(heading)
    forward_x = math.cos(heading)
    forward_y = math.sin(heading)
    ring = list(polygon.exterior.coords)[:-1]
    if not ring:
        return None
    minimum_lateral = half_lane_m + 1.0
    best: tuple[float, float] | None = None
    best_score = math.inf
    for vertex_x, vertex_y in ring:
        dx = vertex_x - point[0]
        dy = vertex_y - point[1]
        lateral = dx * right_x + dy * right_y
        ahead = dx * forward_x + dy * forward_y
        if lateral < minimum_lateral:
            continue
        if ahead < -14.0 or ahead > 12.0:
            continue
        score = abs(lateral - (half_lane_m + HEAD_KERB_OFFSET_M["vehicle"])) + 0.04 * abs(ahead)
        if score < best_score:
            best_score = score
            best = (vertex_x, vertex_y)
    if best is None:
        return None
    center_x = polygon.centroid.x
    center_y = polygon.centroid.y
    dx = best[0] - center_x
    dy = best[1] - center_y
    length = math.hypot(dx, dy) or 1.0
    step_x = dx / length
    step_y = dy / length
    padded = polygon.buffer(0.3)
    offset = SIGNAL_KERB_CLEARANCE_M
    while offset <= 6.0:
        candidate_x = best[0] + step_x * offset
        candidate_y = best[1] + step_y * offset
        if not padded.contains(Point(candidate_x, candidate_y)):
            return candidate_x, candidate_y
        offset += 0.4
    return None


def signal_kerb_position(
    point: tuple[float, float],
    heading: float,
    polygon: Polygon | None,
    fallback_offset: float,
    min_offset: float,
) -> tuple[float, float]:
    """Точка установки стойки светофора: на тротуаре справа от полосы.

    Идём от точки стоп-линии вправо, пока не выйдем из асфальтового полигона
    перекрёстка (если он известен), плюс небольшой отступ. Минимальный сдвиг —
    `min_offset`: стойка не может стоять на самой полосе, даже если формально
    уже находится вне полигона.
    """
    right_x = math.sin(heading)
    right_y = -math.cos(heading)
    start = max(0.5, min_offset)
    limit = max(SIGNAL_KERB_MAX_M, start + 10.0)
    if polygon is not None:
        padded = polygon.buffer(0.3)
        offset = start
        while offset <= limit:
            x = point[0] + right_x * offset
            y = point[1] + right_y * offset
            if not padded.contains(Point(x, y)):
                return (
                    x + right_x * SIGNAL_KERB_CLEARANCE_M,
                    y + right_y * SIGNAL_KERB_CLEARANCE_M,
                )
            offset += 0.5
    offset = max(start, fallback_offset)
    return point[0] + right_x * offset, point[1] + right_y * offset


def find_junction_face(faces: list[dict], center_x: float, center_y: float) -> dict | None:
    """Ближайший/содержащий полигон перекрёстка для сигнальной группы."""
    if not faces:
        return None
    point = Point(center_x, center_y)
    containing = [face for face in faces if face["polygon"].contains(point)]
    if containing:
        return min(containing, key=lambda face: face["areaM2"])
    near = [
        (face["polygon"].distance(point), face)
        for face in faces
        if face["polygon"].distance(point) <= SIGNAL_FACE_SEARCH_M
    ]
    if not near:
        return None
    return min(near, key=lambda item: item[0])[1]


def junction_entry_s(
    lane_line: LineString,
    polygon: Polygon,
    center_x: float,
    center_y: float,
) -> float | None:
    """Расстояние вдоль полосы до входа в полигон перекрёстка со стороны подхода.

    Берётся начало участка полосы, лежащего ВНУТРИ полигона: именно там
    заканчивается свободный подход. Пересечение с `boundary` ненадёжно, когда
    точка светофора стоит вне полигона (на тротуаре): тогда «до узла» и «после
    узла» неразличимы.
    """
    cut = lane_line.intersection(polygon)
    if cut.is_empty:
        return None
    parts = (
        [cut]
        if cut.geom_type == "LineString"
        else [geometry for geometry in getattr(cut, "geoms", []) if geometry.geom_type == "LineString"]
    )
    entries: list[float] = []
    for part in parts:
        coordinates = list(part.coords)
        if len(coordinates) < 2:
            continue
        entries.append(lane_line.project(Point(coordinates[0])))
        entries.append(lane_line.project(Point(coordinates[-1])))
    if not entries:
        return None
    return min(entries)


def build_signal_node(
    center_x: float,
    center_y: float,
    representative: dict,
    candidates: list[dict],
    members: list[int],
    lanes: list[tuple[str, dict, int, dict, LineString]],
    crossings: list[dict],
    variants: dict[str, dict],
    junction_faces: list[dict] | None = None,
    road_surface: dict | None = None,
) -> dict | None:
    """Один сигнальный узел: подходы, движения, группы, конфликты, фазы, головки."""
    center = Point(center_x, center_y)
    faces = junction_faces or []
    face = find_junction_face(faces, center_x, center_y)
    movements: list[dict] = []
    stop_lines: list[dict] = []
    for variant_id, edge, lane_index, lane, lane_line in lanes:
        if lane_line.distance(center) > APPROACH_MAX_M:
            continue
        lane_length = polyline_length(lane["centerline"])
        # Стоп-линия — на границе перекрёстка (полигон из тайлов), а не у точки
        # OSM-светофора: иначе она оказывается внутри перекрёстка.
        entry_s = None
        if face is not None:
            entry_s = junction_entry_s(lane_line, face["polygon"], center_x, center_y)
        if entry_s is not None and STOP_LINE_SETBACK_M < entry_s < lane_length - 1.0:
            s_line = entry_s - STOP_LINE_SETBACK_M
            setback_source = "junction-face"
        else:
            s_line = lane_line.project(center) - NO_FACE_SETBACK_M
            setback_source = "model-fallback"
        if face is not None:
            # Стоп-линия обязана стоять ДО перекрёстка: если полигон всё ещё
            # накрывает точку, отодвигаем её вверх по подходу.
            padded = face["polygon"].buffer(0.3)
            guard = 0
            while s_line > 2.0 and guard < 60:
                probe = sample_polyline(lane["centerline"], s_line)
                if not padded.contains(Point(probe[0], probe[1])):
                    break
                s_line -= 2.0
                guard += 1
            if guard > 0:
                setback_source = setback_source + "+pushed-out"
            # На городском масштабе встречаются очень большие полигоны: если
            # стоп-линию так и не удалось вынести, подход не моделируем вовсе —
            # светофор посреди асфальта хуже, чем отсутствующий.
            final_probe = sample_polyline(lane["centerline"], s_line)
            if padded.contains(Point(final_probe[0], final_probe[1])):
                continue
        if s_line < 1.0 or s_line > lane_length - 1.0:
            continue
        next_ids = edge.get("next") or []
        if not next_ids:
            continue
        next_edge = None
        for variant_edge in variants[variant_id]["edges"]:
            if variant_edge["id"] == next_ids[0]:
                next_edge = variant_edge
                break
        if next_edge is None:
            continue
        exit_lane = next_edge["lanes"][lane_index if lane_index < len(next_edge["lanes"]) else 0]
        exit_length = polyline_length(exit_lane["centerline"])
        probe = min(MOVEMENT_EXIT_PROBE_M, exit_length)
        path_points: list[list[float]] = []
        # Подход: от стоп-линии до конца полосы.
        sample = sample_polyline(lane["centerline"], s_line)
        path_points.append([sample[0], sample[1], sample[2]])
        p = lane["centerline"]["p"]
        s = lane["centerline"]["s"]
        for index in range(len(s)):
            if s[index] > s_line + 0.05:
                path_points.append([p[index * 3], p[index * 3 + 1], p[index * 3 + 2]])
        # Выезд: первые метры следующей полосы.
        exit_sample = sample_polyline(exit_lane["centerline"], probe)
        path_points.append([exit_sample[0], exit_sample[1], exit_sample[2]])
        ex_p = exit_lane["centerline"]["p"]
        ex_s = exit_lane["centerline"]["s"]
        for index in range(len(ex_s)):
            if 0.05 < ex_s[index] < probe:
                path_points.append([ex_p[index * 3], ex_p[index * 3 + 1], ex_p[index * 3 + 2]])
        path_points.append([exit_sample[0], exit_sample[1], exit_sample[2]])
        movement_path = make_polyline(path_points)
        if len(movement_path["s"]) < 2:
            continue
        kind = "tram" if edge["modes"][0] == "tram" else "vehicle"
        movement = {
            "id": "",
            "kind": kind,
            "approach": {"edgeId": edge["id"], "laneIndex": lane_index},
            "exitEdgeId": next_edge["id"],
            "path": movement_path,
            "group": 0,
            "clearanceLengthM": BODY_LENGTH_M.get(edge["modes"][0], 12.0),
        }
        movements.append(movement)
        heading = sample_polyline(lane["centerline"], min(s_line, lane_length))[3]
        head = sample_polyline(lane["centerline"], min(s_line, lane_length))
        normal = (-math.sin(heading), math.cos(heading))
        half = lane["widthM"] / 2.0
        line_points = [
            head[0] + normal[0] * half, head[1] + normal[1] * half, head[2],
            head[0] - normal[0] * half, head[1] - normal[1] * half, head[2],
        ]
        # Головка — на тротуаре справа от полосы, а не на её осевой. Ось
        # `(sin h, -cos h)` — правая нормаль к направлению движения.
        # Стойка — на правом углу перекрёстка (кромка тротуара), а не у осевой
        # полосы. Без полигона перекрёстка головку не рисуем: точка на дороге
        # выглядит хуже, чем отсутствующая стойка.
        base_x = head[0] - math.cos(heading) * 1.5
        base_y = head[1] - math.sin(heading) * 1.5
        if face is not None:
            corner = face_corner_for(face["polygon"], (base_x, base_y), heading, half)
        else:
            corner = None
        head_position: tuple[float, float] | None = None
        if corner is not None:
            lateral = (corner[0] - base_x) * math.sin(heading) + (corner[1] - base_y) * (
                -math.cos(heading)
            )
            if lateral >= half + HEAD_MIN_KERB_OFFSET_M:
                head_position = corner
        if head_position is None and (face is not None or kind != "tram"):
            head_position = signal_kerb_position(
                (base_x, base_y),
                heading,
                face["polygon"] if face is not None else None,
                half + HEAD_KERB_OFFSET_M.get(kind, HEAD_KERB_OFFSET_M["vehicle"]),
                half + HEAD_MIN_KERB_OFFSET_M,
            )
        if head_position is None:
            head_x = None
            head_y = None
        else:
            head_x, head_y = head_position
        stop_lines.append({
            "movement": len(movements) - 1,
            "edgeId": edge["id"],
            "laneIndex": lane_index,
            "s": round(s_line, ROUND_M),
            "line": [round(value, ROUND_M) for value in line_points],
            "heading": round(heading, 6),
            "_at": (head[0], head[1], head[2]),
            "_head": None if head_x is None or head_y is None else {
                "x": head_x,
                "y": head_y,
                "facing": heading,
                "kind": kind,
                "heightM": 3.0 if kind != "tram" else 2.6,
                # Стойка стоит на поверхности подхода: на мостовой деке это
                # несколько метров над базовой плоскостью.
                "groundHeightM": float(head[2]),
            },
            "_laneLine": lane_line,
            "_laneWidth": lane["widthM"],
            "_setback": setback_source,
        })

    # Пешеходные движения: переходы в 30 м от центра узла.
    ped_count = 0
    for crossing in crossings:
        point = Point(crossing["x"], crossing["y"])
        if point.distance(center) > CROSSING_SIGNAL_M:
            continue
        best = None
        for variant_id, edge, lane_index, lane, lane_line in lanes:
            distance = lane_line.distance(point)
            if best is None or distance < best[0]:
                best = (distance, variant_id, edge, lane_index, lane, lane_line)
        if best is None or best[0] > 8.0:
            continue
        _, variant_id, edge, lane_index, lane, lane_line = best
        # Переход идёт ПОПЕРЁК всей проезжей части, а не поперёк одной полосы.
        # Ширина берётся у автомобильного ребра рядом с переходом (у трамвайного
        # ребра ширина — это габарит пути, поэтому по нему ширину брать нельзя).
        road_width: float | None = None
        for alt_id, alt_edge, alt_lane_index, alt_lane, alt_line in lanes:
            if str(alt_edge.get("modes", [""])[0]) == "tram":
                continue
            if alt_line.distance(point) > 14.0:
                continue
            width = float(alt_edge.get("widthM") or alt_lane["widthM"]) * (
                1.0 if alt_edge.get("oneway") else 2.0
            )
            road_width = width if road_width is None else max(road_width, width)
        if road_width is None:
            road_width = 14.0 if str(edge.get("modes", [""])[0]) == "tram" else float(
                edge.get("widthM") or lane["widthM"]
            ) * (1.0 if edge.get("oneway") else 2.0)
        road_angle = float(
            crossing.get("angle")
            or sample_polyline(lane["centerline"], lane_line.project(point))[3]
        )
        carriageway_width = min(max(road_width, 7.0), 34.0)
        ped_heading = road_angle + math.pi / 2.0
        half = carriageway_width / 2.0 + 1.5
        path = make_polyline([
            [
                point.x + math.cos(ped_heading) * half,
                point.y + math.sin(ped_heading) * half,
                float(sample_polyline(lane["centerline"], lane_line.project(point))[2]),
            ],
            [
                point.x - math.cos(ped_heading) * half,
                point.y - math.sin(ped_heading) * half,
                float(sample_polyline(lane["centerline"], lane_line.project(point))[2]),
            ],
        ])
        # Пешеходная головка — на каждом краю перехода (у тротуаров), лицом к
        # противоположному краю. В центре проезжей части головок быть не должно.
        ped_heading = math.atan2(
            path["p"][4] - path["p"][1], path["p"][3] - path["p"][0]
        )
        ped_head_pair = [
            {
                "x": path["p"][0],
                "y": path["p"][1],
                "facing": ped_heading,
                "heightM": 2.5,
                "groundHeightM": float(path["p"][2]),
            },
            {
                "x": path["p"][3],
                "y": path["p"][4],
                "facing": ped_heading + math.pi,
                "heightM": 2.5,
                "groundHeightM": float(path["p"][5]),
            },
        ]
        movements.append({
            "id": "",
            "kind": "pedestrian",
            "approach": {"edgeId": edge["id"], "laneIndex": lane_index},
            "exitEdgeId": "",
            "path": path,
            "group": 0,
            "clearanceLengthM": PED_SWEPT_WIDTH_M,
            "_pedHeads": ped_head_pair,
        })
        ped_count += 1
    if not movements:
        return None

    # Индексы движений и группы (один вид движения = одна группа).
    movements.sort(key=lambda item: (item["kind"], item["approach"]["edgeId"], item["approach"]["laneIndex"]))
    groups: list[dict] = []
    for index, movement in enumerate(movements):
        movement["id"] = f"m{index}"
        group_id = f"g{index}"
        groups.append({
            "id": group_id,
            "kind": movement["kind"],
            "aspects": ["yellow", "green"] if movement["kind"] != "pedestrian" else ["green"],
        })
        movement["group"] = index
    # stopLines ссылаются на индексы движений — пересобрать после сортировки.
    old_movements = stop_lines
    stop_lines = []
    for item in old_movements:
        approach_id = item["edgeId"]
        lane_index = item["laneIndex"]
        for index, movement in enumerate(movements):
            if movement["approach"]["edgeId"] == approach_id and movement["approach"]["laneIndex"] == lane_index and movement["kind"] != "pedestrian":
                stop_lines.append({**item, "movement": index})
                break
    stop_lines.sort(key=lambda item: (movements[item["movement"]]["kind"], movements[item["movement"]]["approach"]["edgeId"]))
    for index, item in enumerate(stop_lines):
        item.pop("_at", None)

    # Конфликты по swept path.
    conflicts: list[tuple[int, int]] = []
    swept: list[Polygon] = []
    for movement in movements:
        kind = movement["kind"]
        width = BODY_WIDTH_M.get(variants_mode(movement, variants), PED_SWEPT_WIDTH_M)
        half = PED_SWEPT_WIDTH_M / 2.0 if kind == "pedestrian" else width / 2.0
        line = LineString(polyline_xy(movement["path"]))
        swept.append(line.buffer(half, cap_style="flat", join_style="mitre"))
    for first in range(len(movements)):
        for second in range(first + 1, len(movements)):
            if swept[first].intersection(swept[second]).area > CONFLICT_AREA_M2:
                conflicts.append((first, second))

    # Фазы: раскраска групп так, чтобы конфликтующие не были зелёными вместе.
    conflict_neighbours: dict[int, set[int]] = defaultdict(set)
    for first, second in conflicts:
        conflict_neighbours[first].add(second)
        conflict_neighbours[second].add(first)
    order = sorted(
        range(len(groups)),
        key=lambda index: (-len(conflict_neighbours[index]), index),
    )
    color: dict[int, int] = {}
    for group_index in order:
        used = {color[other] for other in conflict_neighbours[group_index] if other in color}
        value = 0
        while value in used:
            value += 1
        color[group_index] = value
    phase_count = max(color.values()) + 1 if color else 1
    phases: list[dict] = []
    for phase_index in range(phase_count):
        green = [group_index for group_index in range(len(groups)) if color.get(group_index) == phase_index]
        if not green:
            continue
        kinds = {groups[index]["kind"] for index in green}
        if kinds == {"pedestrian"}:
            green_s, yellow_s, all_red_s = 15.0, 0.0, 3.0
        elif "pedestrian" in kinds:
            green_s, yellow_s, all_red_s = 20.0, 3.0, 3.0
        elif "tram" in kinds:
            green_s, yellow_s, all_red_s = 20.0, 3.0, 2.0
        else:
            green_s, yellow_s, all_red_s = 25.0, 3.0, 2.0
        phases.append({
            "green": green,
            "greenS": green_s,
            "yellowS": yellow_s,
            "allRedS": all_red_s,
        })
    # Проверка: ни одна конфликтующая пара не в одной фазе.
    phase_of = {group_index: color[group_index] for group_index in color}
    for first, second in conflicts:
        if phase_of.get(first) == phase_of.get(second):
            raise SystemExit(
                f"ERROR: contradicting movements {first},{second} share a green phase"
            )

    # Головки: по одной на КАЖДОЕ движение (у своей стоп-линии, на тротуаре
    # справа от полосы) и по две на каждый пешеходный переход (у обоих краёв).
    heads: list[dict] = []
    for line in stop_lines:
        head = line.get("_head")
        if not head:
            continue
        heads.append({
            "id": "",
            "group": movements[line["movement"]]["group"],
            "x": round(head["x"], ROUND_M),
            "y": round(head["y"], ROUND_M),
            "groundHeightM": round(float(head.get("groundHeightM") or 0.0), ROUND_M),
            "facing": round(head["facing"], 6),
            "kind": head["kind"],
            "heightM": head["heightM"],
            "_edgeId": str(line["edgeId"]),
        })
    for movement_index, movement in enumerate(movements):
        for head in movement.get("_pedHeads") or []:
            heads.append({
                "id": "",
                "group": movement_index,
                "x": round(head["x"], ROUND_M),
                "y": round(head["y"], ROUND_M),
                "groundHeightM": round(float(head.get("groundHeightM") or 0.0), ROUND_M),
                "facing": round(head["facing"], 6),
                "kind": "pedestrian",
                "heightM": head["heightM"],
            })
    heads.sort(key=lambda item: (item["kind"], item["group"], item["x"], item["y"]))
    # Головки (включая пешеходные) не должны стоять на асфальте перекрёстка:
    # выносим их наружу от центра полигона, а невыносимые — убираем.
    if face is not None:
        padded = face["polygon"].buffer(0.3)
        centre_x = face["polygon"].centroid.x
        centre_y = face["polygon"].centroid.y
        kept: list[dict] = []
        for head in heads:
            head_x, head_y = head["x"], head["y"]
            guard = 0
            while padded.contains(Point(head_x, head_y)) and guard < 30:
                dx = head_x - centre_x
                dy = head_y - centre_y
                length = math.hypot(dx, dy) or 1.0
                head_x += (dx / length) * 0.5
                head_y += (dy / length) * 0.5
                guard += 1
            if padded.contains(Point(head_x, head_y)):
                continue
            head["x"] = round(head_x, ROUND_M)
            head["y"] = round(head_y, ROUND_M)
            kept.append(head)
        heads = kept
    # Вода/тротуар/островки: любая головка, оказавшаяся на нарисованном асфальте,
    # выглядит как светофор посреди дороги. Сдвигаем на сушу, невыносимые — убираем.
    relocated: list[dict] = []
    for head in heads:
        position = relocate_head(head, road_surface, face)
        if position is None:
            continue
        head["x"] = round(position[0], ROUND_M)
        head["y"] = round(position[1], ROUND_M)
        relocated.append(head)
    heads = relocated
    # Совсем совпадающие стойки (разные группы на одном пятачке) схлопываем.
    unique: list[dict] = []
    for head in heads:
        duplicate = next(
            (
                kept
                for kept in unique
                if kept["kind"] == head["kind"]
                and math.hypot(kept["x"] - head["x"], kept["y"] - head["y"]) < 0.8
            ),
            None,
        )
        if duplicate is None:
            unique.append(head)
    heads = unique

    for index, head in enumerate(heads):
        head["id"] = f"h{index}"

    # --- проверка геометрии сигналов (без запуска браузера) ---------------
    face_padded = face["polygon"].buffer(0.2) if face is not None else None
    setback_sources: Counter = Counter()
    # На городском масштабе единичные стойки нельзя поставить корректно: их
    # убираем, а не валим сборку города из-за нескольких головок.
    dropped_edge_ids: set[str] = set()
    dropped_heads = 0
    for line in stop_lines:
        head = line.get("_head")
        lane_line = line.get("_laneLine")
        lane_width = line.get("_laneWidth") or 3.25
        setback_sources[str(line.get("_setback"))] += 1
        if head is None or lane_line is None:
            continue
        head_point = Point(head["x"], head["y"])
        lateral = lane_line.distance(head_point)
        if lateral < lane_width / 2.0 + HEAD_MIN_KERB_OFFSET_M:
            dropped_edge_ids.add(str(line["edgeId"]))
        if face_padded is not None and face_padded.contains(head_point):
            dropped_edge_ids.add(str(line["edgeId"]))
        line_mid = Point(
            (line["line"][0] + line["line"][3]) / 2.0,
            (line["line"][1] + line["line"][4]) / 2.0,
        )
        if face_padded is not None and face_padded.contains(line_mid):
            SIGNAL_GEOMETRY_VIOLATIONS.append(
                f"{representative['osmId']}: stop line for {line['edgeId']} is inside the junction polygon"
            )
    for line in stop_lines:
        line.pop("_head", None)
        line.pop("_laneLine", None)
        line.pop("_laneWidth", None)
    for movement in movements:
        movement.pop("_pedHeads", None)
    # Убираем головки, которые не удалось поставить корректно: лучше меньше
    # огней, чем стойка на полосе или на асфальте перекрёстка.
    kept: list[dict] = []
    face_padded_heads = face["polygon"].buffer(0.2) if face is not None else None
    for head in heads:
        edge_key = head.pop("_edgeId", None)
        if edge_key is not None and str(edge_key) in dropped_edge_ids:
            dropped_heads += 1
            continue
        if face_padded_heads is not None and face_padded_heads.contains(
            Point(head["x"], head["y"])
        ):
            dropped_heads += 1
            continue
        kept.append(head)
    heads = kept
    for index, head in enumerate(heads):
        head["id"] = f"h{index}"
    if dropped_heads > 0:
        # Намеренная деградация, не ошибка: счётчик уходит в отчёт узла.
        dropped_heads_total = int(SIGNAL_HEADS_DROPPED.get("count", 0)) + dropped_heads
        SIGNAL_HEADS_DROPPED["count"] = dropped_heads_total

    kind = "junction"
    if any(movement["kind"] == "tram" for movement in movements):
        kind = "tram"
    elif all(movement["kind"] == "pedestrian" for movement in movements):
        kind = "crossing"

    # Конфликтная зона — сам перекрёсток: части путей движений в радиусе 12 м от
    # центра узла. Полные пути (с 15-метровым выездом) дали бы зону, накрывающую
    # остановки, которые физически стоят до стоп-линии.
    zone_clip = Point(center_x, center_y).buffer(12.0)
    zone_parts = []
    for movement in movements:
        piece = LineString(polyline_xy(movement["path"])).intersection(zone_clip)
        if not piece.is_empty:
            zone_parts.append(piece)
    if zone_parts:
        zone = unary_union(zone_parts).convex_hull.buffer(1.5)
    else:
        zone = Point(center_x, center_y).buffer(3.0)
    zone_flat: list[float] = []
    if not zone.is_empty and zone.geom_type == "Polygon":
        zone_flat = [round(float(v), ROUND_M) for xy in list(zone.exterior.coords)[:-1] for v in xy]
    node = {
        "id": f"j:{representative['osmId']}",
        "kind": kind,
        "x": round(center_x, ROUND_M),
        "y": round(center_y, ROUND_M),
        "groups": groups,
        "movements": movements,
        "stopLines": stop_lines,
        "heads": heads,
        "program": {
            "id": MODEL_PROGRAM_ID,
            "phases": phases,
            "offsetS": 0,
        },
        "conflicts": conflicts,
        "zones": [zone_flat] if zone_flat else [],
        "source": {
            "signalNodes": [candidates[i]["osmId"] for i in members],
            "crossings": ped_count,
            "junctionFace": None if face is None else face["id"],
            "setbackSources": dict(setback_sources),
            "note": "model phases and body dimensions, not measured field data",
        },
    }
    return node


def variants_mode(movement: dict, variants: dict[str, dict]) -> str:
    for variant_data in variants.values():
        for edge in variant_data["edges"]:
            if edge["id"] == movement["approach"]["edgeId"]:
                return edge["modes"][0]
    return "bus"


# ---------------------------------------------------------------------------
# Отчёт, контроль расписания и валидация контракта
# ---------------------------------------------------------------------------


def schedule_coverage(raw: dict, variants: list[dict]) -> dict:
    """Покрытие публичного расписания, если `schedule.json` уже существует."""
    if not SCHEDULE_PATH.exists():
        return {
            "available": False,
            "status": "absent",
            "note": "data/processed/mobility/schedule.json is absent",
        }
    try:
        schedule = json.loads(SCHEDULE_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        return {"available": False, "status": "unreadable", "note": f"unreadable schedule: {error}"}
    status = schedule.get("status")
    imported_routes = schedule.get("routes") or []
    if not imported_routes:
        return {
            "available": False,
            "status": status or "unknown",
            "importedRoutes": 0,
            "note": (
                "schedule.json imported no routes (status="
                + str(status or "unknown")
                + "); trips are unavailable, routes are exported with trips: []"
            ),
        }
    rows: dict[tuple, dict] = {}
    for route in schedule.get("routes", []):
        key = (route.get("mode"), str(route.get("ref")), int(route.get("direction", 0)))
        rows[key] = route
    coverage: list[dict] = []
    for variant in variants:
        route = rows.get((variant["mode"], variant["ref"], variant["direction"]))
        if route is None:
            coverage.append({
                "variantId": variant["id"],
                "matched": 0,
                "scheduled": 0,
                "reason": "no schedule route for mode/ref/direction",
            })
            continue
        scheduled = route.get("stops", [])
        matched = 0
        for call in variant["stops"]:
            best = None
            for stop in scheduled:
                if int(stop.get("seq", -1)) != call["seq"]:
                    continue
                distance = math.hypot(float(stop.get("x", 1e9)) - call["x"], float(stop.get("y", 1e9)) - call["y"])
                if best is None or distance < best[0]:
                    best = (distance, stop)
            if best is not None and best[0] <= 40.0:
                matched += 1
        coverage.append({
            "variantId": variant["id"],
            "matched": matched,
            "scheduled": len(scheduled),
            "trips": len(route.get("trips", [])),
        })
    return {"available": True, "status": status, "importedRoutes": len(rows), "variants": coverage}


def validate_network(network: dict) -> list[str]:
    """Проверить инварианты `src/shared/mobility.ts`; вернуть список ошибок."""
    errors: list[str] = []
    version = network.get("version")
    if version != MOBILITY_VERSION:
        errors.append(f"version {version} != MOBILITY_VERSION {MOBILITY_VERSION}")
    edges = {edge["id"]: edge for edge in network.get("edges", [])}
    if len(edges) != len(network.get("edges", [])):
        errors.append("duplicate edge ids")
    for edge in network.get("edges", []):
        if not edge.get("id") or not edge.get("from") or not edge.get("to"):
            errors.append(f"edge without id/from/to: {edge.get('id')}")
        if not edge.get("lanes"):
            errors.append(f"edge {edge['id']} has no lanes")
        length = polyline_length(edge["centerline"])
        if length <= 0.0:
            errors.append(f"edge {edge['id']} has zero-length centerline")
        for lane in edge.get("lanes", []):
            if polyline_length(lane["centerline"]) <= 0.0 and lane["index"] != 0:
                errors.append(f"edge {edge['id']} lane {lane['index']} is empty")
    variants = {variant["id"]: variant for variant in network.get("variants", [])}
    for variant in network.get("variants", []):
        sequence = variant["edges"]
        for first_id, second_id in zip(sequence, sequence[1:]):
            first, second = edges.get(first_id), edges.get(second_id)
            if first is None or second is None:
                errors.append(f"variant {variant['id']} references unknown edge")
                continue
            if first["to"] != second["from"]:
                errors.append(
                    f"variant {variant['id']}: edge {first_id} to={first['to']} != {second_id} from={second['from']}"
                )
        for call in variant.get("stops", []):
            edge = edges.get(call["edgeId"])
            if edge is None:
                errors.append(f"variant {variant['id']} stop call on unknown edge {call['edgeId']}")
                continue
            lanes = edge.get("lanes", [])
            if not 0 <= call["laneIndex"] < len(lanes):
                errors.append(f"variant {variant['id']} stop call has bad lane index")
                continue
            lane_length = polyline_length(lanes[call["laneIndex"]]["centerline"])
            if not (-1e-6 <= call["s"] <= lane_length + 1e-6):
                errors.append(
                    f"variant {variant['id']} stop {call['stopId']} s={call['s']} outside lane [{lane_length}]"
                )
            point = sample_polyline(lanes[call["laneIndex"]]["centerline"], call["s"])
            if abs(point[0] - call["x"]) > 0.011 or abs(point[1] - call["y"]) > 0.011:
                errors.append(
                    f"variant {variant['id']} stop {call['stopId']} body centre is off its lane"
                )
        if not variant["verified"] and not variant.get("issues"):
            errors.append(f"variant {variant['id']} unverified without issues")
    # Соединение — только по исходному OSM-узлу. Один ref обязан иметь одну
    # координату во всех рёбрах: если «общий» узел на самом деле два разных
    # места, это близостная склейка. Мост и дорога под ним имеют разные ref
    # даже при совпадающих XY — они и не должны связываться.
    node_positions: dict[str, tuple[float, float]] = {}
    for edge in edges.values():
        for ref, point in (
            (edge["from"], sample_polyline(edge["centerline"], 0.0)),
            (edge["to"], sample_polyline(edge["centerline"], polyline_length(edge["centerline"]))),
        ):
            existing = node_positions.get(ref)
            if existing is None:
                node_positions[ref] = (point[0], point[1])
            elif abs(existing[0] - point[0]) > 0.001 or abs(existing[1] - point[1]) > 0.001:
                errors.append(
                    f"node {ref} used at different positions: "
                    f"{existing} vs {(round(point[0], 3), round(point[1], 3))}"
                )
    # Сигналы: конфликтующие движения не зелёные в одной фазе.
    for node in network.get("signals", []):
        phase_of: dict[int, int] = {}
        for index, phase in enumerate(node["program"]["phases"]):
            for group_index in phase["green"]:
                phase_of.setdefault(group_index, index)
        for first, second in node.get("conflicts", []):
            first_group = node["movements"][first]["group"]
            second_group = node["movements"][second]["group"]
            if phase_of.get(first_group) == phase_of.get(second_group):
                errors.append(
                    f"signal {node['id']}: conflicting movements {first},{second} share green"
                )
        if len(node["groups"]) != len(node["movements"]):
            errors.append(f"signal {node['id']}: group/movement count mismatch")
    return errors


# ---------------------------------------------------------------------------
# Точка входа
# ---------------------------------------------------------------------------


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--raw", default=str(DEFAULT_RAW))
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    parser.add_argument("--report", default=str(DEFAULT_REPORT))
    parser.add_argument(
        "--allow-unverified",
        action="store_true",
        help=(
            "исключить непроверенные варианты из payload вместо падения: нужно для "
            "городского демо-прогона, где часть OSM-отношений не проходит аудит"
        ),
    )
    args = parser.parse_args()

    raw_path = Path(args.raw)
    if not raw_path.exists():
        print(f"ERROR: raw network not found: {raw_path}; run extract_network.py first", file=sys.stderr)
        return 1
    raw = json.loads(raw_path.read_text(encoding="utf-8"))
    nodes = {int(key): value for key, value in raw["nodes"].items()}
    ways = {int(key): value for key, value in raw["ways"].items()}
    header = raw.get("header", {})
    warnings: list[str] = []

    # --- высоты: только мостовые ways, из фактических deck-треугольников -----
    bounds = tuple(header.get("targetBounds", [-11264.0, -9216.0, 12288.0, 10240.0]))
    all_x = [nodes[int(key)]["x"] for key in nodes]
    all_y = [nodes[int(key)]["y"] for key in nodes]
    if all_x and all_y:
        corridor_bounds = (min(all_x), min(all_y), max(all_x), max(all_y))
    else:
        corridor_bounds = bounds
    sampler = load_deck_triangles(CITY_TILES, corridor_bounds)
    heights_by_node: dict[int, tuple[float, str]] = {}
    for corridor in raw["corridors"]:
        for variant in corridor["variants"]:
            member_ways = [m["ref"] for m in variant["members"] if m["type"] == "w"]
            chain = en.assemble_chain(member_ways, ways, nodes)
            for segment in chain["segments"]:
                way = ways.get(segment["wayId"])
                if way is None:
                    continue
                tags = way["tags"]
                elevated = is_bridge(tags) or is_tunnel(tags) or way_layer(tags) != 0
                if not elevated:
                    continue
                segment_nodes = list(way["nodes"])
                if segment["reversed"]:
                    segment_nodes = list(reversed(segment_nodes))
                run_length = _segment_length(segment_nodes, nodes)
                layer = max(1, way_layer(tags))
                ramp = max(1.0, min(bridge_decks.DECK_RAMP_MAX_M, bridge_decks.DECK_RAMP_FRACTION * run_length / 2.0))
                rise = min(
                    bridge_decks.DECK_RISE_M * min(bridge_decks.DECK_MAX_LAYERS, layer),
                    bridge_decks.DECK_MAX_SLOPE * ramp,
                )
                for index, node_id in enumerate(segment_nodes):
                    record = nodes.get(node_id)
                    if record is None:
                        continue
                    sample = sampler.sample(record["x"], record["y"])
                    if sample is not None:
                        heights_by_node[node_id] = (round(sample, ROUND_M), "deck-tiles")
                        continue
                    distance_to_end = min(
                        _distance_along(segment_nodes, nodes, 0, index),
                        _distance_along(segment_nodes, nodes, len(segment_nodes) - 1, index),
                    )
                    height = rise * bridge_decks._smoothstep(distance_to_end / ramp)
                    heights_by_node[node_id] = (round(height, ROUND_M), "model:bridge_decks")

    # --- варианты -----------------------------------------------------------
    variants: dict[str, dict] = {}
    edges_by_id: dict[str, dict] = {}
    stops: dict[str, dict] = {}
    variant_records: list[dict] = []
    report_variants: list[dict] = []
    fatal = False
    for corridor in raw["corridors"]:
        for variant in corridor["variants"]:
            built = build_variant(
                corridor, variant, raw, ways, nodes, heights_by_node, sampler
            )
            record = built["variant"]
            variants[record["id"]] = {
                "variant": record,
                "edges": built["edges"],
                "stops": built["stopIds"],
            }
            for edge in built["edges"]:
                if edge["id"] in edges_by_id:
                    raise SystemExit(f"ERROR: duplicate edge id {edge['id']}")
                edges_by_id[edge["id"]] = edge
            member_ways = [m["ref"] for m in variant["members"] if m["type"] == "w"]
            chain = en.assemble_chain(member_ways, ways, nodes)
            for member in variant["members"]:
                if member["type"] != "n" or member["role"] not in STOP_ROLES:
                    continue
                node_id = member["ref"]
                node_record = nodes.get(node_id)
                if node_record is None:
                    continue
                stop_id = f"s:osm:{node_id}"
                platform_id = built["platformByStop"].get(node_id)
                osm_ids = [node_id] + ([platform_id] if platform_id else [])
                if stop_id not in stops:
                    stops[stop_id] = {
                        "id": stop_id,
                        "name": node_record.get("tags", {}).get("name", ""),
                        "modes": [corridor["mode"]],
                        "x": round(node_record["x"], ROUND_M),
                        "y": round(node_record["y"], ROUND_M),
                        "osmIds": osm_ids,
                    }
                else:
                    if corridor["mode"] not in stops[stop_id]["modes"]:
                        stops[stop_id]["modes"].append(corridor["mode"])
                    for extra in osm_ids:
                        if extra not in stops[stop_id]["osmIds"]:
                            stops[stop_id]["osmIds"].append(extra)
            variant_records.append(record)
            report_variants.append({
                "id": record["id"],
                "sourceRelationId": record["sourceRelationId"],
                "mode": record["mode"],
                "ref": record["ref"],
                "direction": record["direction"],
                "headSign": record["headSign"],
                "edges": len(built["edges"]),
                "lengthM": record["lengthM"],
                "stopsBound": len(built["variant"]["stops"]),
                "stopsUnbound": built["unbound"],
                "wrongSide": built["wrongSide"],
                "bodyShifts": built["shifted"],
                "stopSides": built["sideDetails"],
                "verified": record["verified"],
                "issues": record["issues"],
                "gaps": [gap for gap in chain["gaps"]],
                "wayMembers": len(member_ways),
                "missingWayMembers": [
                    way_id for way_id in member_ways if way_id not in ways
                ],
            })
            if not record["verified"]:
                fatal = True

    # --- сигнальные узлы ----------------------------------------------------
    # Геометрия размещения (стоп-линии, головки) берётся из полигонов перекрёстков
    # тайлового payload, а не из точки OSM-светофора.
    junction_faces = load_junction_faces(CITY_TILES, corridor_bounds)
    road_surface = load_road_surface(CITY_TILES, corridor_bounds)
    signals, signal_stats = build_signal_nodes(raw, variants, junction_faces, road_surface)
    signal_stats["junctionFacesLoaded"] = len(junction_faces)
    signal_stats["roadSurfaceLines"] = len(road_surface["lines"])
    signal_stats["roadSurfaceFills"] = len(road_surface["fills"])

    if args.allow_unverified and fatal:
        # Городской демо-прогон: невалидные варианты (обычно несовпадение стороны
        # остановки в OSM) исключаем из payload, но оставляем в отчёте. Экспорт
        # получает только проверенные варианты.
        kept = [record for record in variant_records if record.get("verified")]
        excluded = len(variant_records) - len(kept)
        if excluded:
            warnings.append(
                f"excluded {excluded} unverified variant(s) from the network payload "
                "(see report.json corridors[].issues)"
            )
        variant_records = kept
        fatal = False

    network = {
        "version": MOBILITY_VERSION,
        "generatedAt": _utc_now(),
        "epsg": header.get("epsg", 32635),
        "originUtm": header.get("originUtm"),
        "bounds": list(bounds),
        "stops": [stops[key] for key in sorted(stops)],
        "edges": [edges_by_id[key] for key in sorted(edges_by_id)],
        "variants": sorted(variant_records, key=lambda item: item["id"]),
        "signals": signals,
        "source": {
            "pbf": header.get("pbf"),
            "pbfSha256": header.get("pbfSha256"),
            "replicationTimestamp": header.get("replicationTimestamp"),
            "corridorsSha256": header.get("corridorsSha256"),
            "attribution": header.get("attribution"),
        },
    }

    # --- отчёт --------------------------------------------------------------
    turn_restrictions, restriction_issues = audit_turn_restrictions(raw, variants, ways, nodes)
    for issue in restriction_issues:
        warnings.append(issue)
    height_profile = audit_height_profile(network, heights_by_node)
    stop_zones = audit_stop_conflict_zones(variant_records, signals)
    if stop_zones["conflicts"]:
        warnings.append(
            f"{len(stop_zones['conflicts'])} stop body centre(s) fall inside modelled signal "
            "conflict zones (see report.stopConflictZones)"
        )
    schedule = schedule_coverage(raw, variant_records)
    if not schedule["available"]:
        warnings.append("schedule unavailable: routes exported without trips")
    report = {
        "generatedAt": network["generatedAt"],
        "pbf": header.get("pbf"),
        "pbfSha256": header.get("pbfSha256"),
        "replicationTimestamp": header.get("replicationTimestamp"),
        "area": header.get("area"),
        "bounds": list(bounds),
        "corridors": report_variants,
        "totals": {
            "variants": len(variant_records),
            "verifiedVariants": sum(1 for item in variant_records if item["verified"]),
            "edges": len(edges_by_id),
            "stops": len(stops),
            "signalNodes": len(signals),
            "movements": signal_stats.get("movements", 0),
            "conflicts": signal_stats.get("conflicts", 0),
            "phases": signal_stats.get("phases", 0),
            "lengthM": round(sum(item["lengthM"] for item in variant_records), 1),
        },
        "signals": signal_stats,
        "heights": height_profile,
        "stopConflictZones": stop_zones,
        "decks": {
            "sampler": sampler.stats,
            "bridgeWaysSamples": sum(1 for value in heights_by_node.values() if value[1] == "deck-tiles"),
            "modelFallbackSamples": sum(1 for value in heights_by_node.values() if value[1].startswith("model:")),
        },
        "turnRestrictions": turn_restrictions,
        "schedule": schedule,
        "warnings": warnings,
    }

    # --- валидация до записи ------------------------------------------------
    problems = validate_network(network)
    if problems:
        for problem in problems:
            print(f"ERROR: {problem}", file=sys.stderr)
        return 2
    if fatal:
        print(
            "ERROR: one or more variants failed the audit (see report.json); "
            "unverified variants must not be exported as verified",
            file=sys.stderr,
        )
        # Файл всё равно пишем: отчёт и геометрия нужны для диагностики, но
        # export.py обязан отказаться от невалидных вариантов.
        _write_json(Path(args.out), network)
        _write_json(Path(args.report), report)
        return 2

    _write_json(Path(args.out), network)
    _write_json(Path(args.report), report)
    print(
        f"Wrote {args.out} and {args.report}: {len(network['edges'])} edges, "
        f"{len(variant_records)} variants, {len(stops)} stops, {len(signals)} signal nodes"
    )
    print(
        f"  steps: deck samples {report['decks']['bridgeWaysSamples']}, "
        f"model fallback {report['decks']['modelFallbackSamples']}, "
        f"max height step {height_profile['maxStepM']} m"
    )
    return 0


def _segment_length(node_ids: list[int], nodes: dict[int, dict]) -> float:
    total = 0.0
    for first, second in zip(node_ids, node_ids[1:]):
        a, b = nodes.get(first), nodes.get(second)
        if a is None or b is None:
            continue
        total += math.hypot(a["x"] - b["x"], a["y"] - b["y"])
    return total


def _distance_along(node_ids: list[int], nodes: dict[int, dict], target_index: int, from_index: int) -> float:
    total = 0.0
    step = 1 if target_index >= from_index else -1
    index = from_index
    while index != target_index:
        a = nodes.get(node_ids[index])
        b = nodes.get(node_ids[index + step])
        if a is not None and b is not None:
            total += math.hypot(a["x"] - b["x"], a["y"] - b["y"])
        index += step
    return total


def audit_stop_conflict_zones(variants: list[dict], signals: list[dict]) -> dict:
    """Проверить, не попадает ли центр кузова остановки в конфликтную зону узла.

    Зона — выпуклая оболочка путей движений сигнального узла. Попадание не
    делает вариант невалидным (остановка может стоять близко к стоп-линии), но
    фиксируется в отчёте как риск наложения кузова на зону перекрёстка.
    """
    zones: list[tuple[str, Polygon]] = []
    for node in signals:
        for ring in node.get("zones", []):
            if len(ring) >= 6:
                points = [(ring[index], ring[index + 1]) for index in range(0, len(ring) - 1, 2)]
                try:
                    polygon = Polygon(points)
                except ValueError:
                    continue
                if polygon.is_valid and not polygon.is_empty:
                    zones.append((node["id"], polygon))
    conflicts: list[dict] = []
    checked = 0
    for variant in variants:
        for call in variant["stops"]:
            checked += 1
            point = Point(call["x"], call["y"])
            for node_id, polygon in zones:
                if polygon.contains(point):
                    conflicts.append({
                        "variantId": variant["id"],
                        "stopId": call["stopId"],
                        "signalNodeId": node_id,
                        "surfaceM2": round(polygon.area, 1),
                    })
                    break
    return {"checked": checked, "conflicts": conflicts}


def audit_height_profile(network: dict, heights_by_node: dict[int, tuple[float, str]]) -> dict:
    """Ступеньки профиля: внутри ребра и на стыке соседних рёбер/chunk.

    Ребро целиком принадлежит одному chunk, поэтому «граница chunk» проходит
    ровно через общий OSM-узел двух последовательных рёбер варианта. Высоты в
    этом узле берутся из одного источника, и проверка ниже подтверждает, что
    стык не даёт ступеньки.
    """
    step_max = 0.0
    step_at = None
    for edge in network["edges"]:
        p = edge["centerline"]["p"]
        for index in range(3, len(p), 3):
            delta = abs(p[index + 2] - p[index - 1])
            if delta > step_max:
                step_max = delta
                step_at = {"edgeId": edge["id"], "vertex": index // 3}
    edges = {edge["id"]: edge for edge in network["edges"]}
    seam_max = 0.0
    seam_at = None
    seam_checks = 0
    for variant in network["variants"]:
        for first_id, second_id in zip(variant["edges"], variant["edges"][1:]):
            first, second = edges.get(first_id), edges.get(second_id)
            if first is None or second is None or first["to"] != second["from"]:
                continue
            seam_checks += 1
            first_p = first["centerline"]["p"]
            second_p = second["centerline"]["p"]
            delta = abs(first_p[-1] - second_p[2])
            if delta > seam_max:
                seam_max = delta
                seam_at = {"edgeId": first_id, "nextEdgeId": second_id, "node": first["to"]}
    return {
        "maxStepM": round(step_max, 3),
        "maxStepAt": step_at,
        "chunkSeamChecks": seam_checks,
        "chunkSeamMaxStepM": round(seam_max, 3),
        "chunkSeamMaxAt": seam_at,
        "samplesBySource": dict(Counter(value[1] for value in heights_by_node.values())),
        "toleranceM": MAX_HEIGHT_STEP_M,
        "stepWithinTolerance": step_max <= MAX_HEIGHT_STEP_M,
    }


def _edge_heading_deg(edge: dict, at_end: bool) -> float:
    length = polyline_length(edge["centerline"])
    distance = length - 0.5 if at_end else 0.5
    heading = sample_polyline(edge["centerline"], max(0.0, min(length, distance)))[3]
    return math.degrees(heading)


def _turn_angle_deg(approach: dict, exit_edge: dict) -> float:
    difference = _edge_heading_deg(exit_edge, False) - _edge_heading_deg(approach, True)
    return (difference + 540.0) % 360.0 - 180.0


def _restriction_matches_kind(kind: str, turn_deg: float) -> bool:
    if kind == "no_left_turn":
        return turn_deg > 20.0
    if kind == "no_right_turn":
        return turn_deg < -20.0
    if kind == "no_u_turn":
        return abs(turn_deg) > 150.0
    if kind == "no_straight_on":
        return abs(turn_deg) <= 20.0
    if kind == "no_entry":
        return True
    return False


def audit_turn_restrictions(
    raw: dict,
    variants: dict[str, dict],
    ways: dict[int, dict],
    nodes: dict[int, dict],
) -> tuple[dict, list[str]]:
    """Проверить, проходит ли вариант через запрещённый манёвр.

    Ограничение учитывается, только когда совпадают: (1) пара последовательных
    way варианта `from -> to`, (2) направление проезда from/to относительно
    порядка узлов (via — последний узел from, первый узел to или наоборот),
    (3) геометрия манёвра (левый/правый/разворот/прямо). Иначе отношение к
    этому проезду не относится. Найденное нарушение — признак противоречия в
    исходных данных OSM (маршрут против restriction), а не разрыв геометрии:
    оно попадает в отчёт и warning, но не снимает `verified` варианта.
    """
    restrictions = raw.get("restrictions") or []
    triggered: list[dict] = []
    warnings: list[str] = []
    checked = 0
    candidate_movements = 0
    not_applicable = 0
    for restriction in restrictions:
        kind = restriction["tags"].get("restriction", "")
        if not kind.startswith("no_"):
            continue
        from_way = to_way = via_node = None
        for member in restriction["members"]:
            if member["type"] == "n" and member["role"] == "via":
                via_node = member["ref"]
            elif member["type"] == "w" and member["role"] == "from":
                from_way = member["ref"]
            elif member["type"] == "w" and member["role"] == "to":
                to_way = member["ref"]
        if from_way is None or to_way is None or via_node is None:
            continue
        from_nodes = (ways.get(from_way) or {}).get("nodes") or []
        to_nodes = (ways.get(to_way) or {}).get("nodes") or []
        if via_node not in from_nodes or via_node not in to_nodes:
            continue
        checked += 1
        expected_from = "f" if from_nodes[-1] == via_node else "b"
        expected_to = "f" if to_nodes[0] == via_node else "b"
        for variant_id, variant_data in variants.items():
            ordered = variant_data["edges"]
            for first, second in zip(ordered, ordered[1:]):
                if first["wayId"] != from_way or second["wayId"] != to_way:
                    continue
                if first["to"] != second["from"]:
                    continue
                candidate_movements += 1
                if first.get("source", {}).get("dir") != expected_from:
                    not_applicable += 1
                    continue
                if second.get("source", {}).get("dir") != expected_to:
                    not_applicable += 1
                    continue
                turn = _turn_angle_deg(first, second)
                if not _restriction_matches_kind(kind, turn):
                    not_applicable += 1
                    continue
                triggered.append({
                    "restrictionId": restriction["id"],
                    "kind": kind,
                    "variantId": variant_id,
                    "fromWayId": from_way,
                    "toWayId": to_way,
                    "viaNodeId": via_node,
                    "turnDeg": round(turn, 1),
                })
                warnings.append(
                    f"turn-restriction: variant {variant_id} follows forbidden {kind} "
                    f"relation {restriction['id']} ({from_way} -> {to_way}, turn {turn:.0f} deg); "
                    "OSM route/restriction contradiction, geometry is continuous"
                )
    return {
        "checked": checked,
        "candidateMovements": candidate_movements,
        "notApplicable": not_applicable,
        "triggered": triggered,
        "note": "направление и геометрия манёвра проверяются; ограничения на "
                "неописанные улицы не моделируются",
    }, warnings


def _utc_now() -> str:
    import time

    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _write_json(path: Path, document: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(document, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    path.write_text(text + "\n", encoding="utf-8")


if __name__ == "__main__":
    raise SystemExit(main())
