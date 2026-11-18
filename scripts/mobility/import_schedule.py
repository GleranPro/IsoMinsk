"""Импорт и нормализация публичного расписания наземного транспорта Минска.

Задача модуля (этап 1 плана `docs/superpowers/plans/2026-11-16-public-transport-signals.md`):
получить снимок официального источника, сохранить оригинал с provenance и
привести расписание к промежуточному формату `data/processed/mobility/schedule.json`
(см. `docs/mobility/CONTRACT.md` и `src/shared/mobility.ts`).

Источник и его ограничения
--------------------------
Официальный сайт ГП «Минсктранс» не публикует GTFS и не имеет мобильного
приложения. Раздел «Расписание городских и пригородных маршрутов»
(«Виртуальное табло», `/lookout_yard`) технически отдаёт JSON через внутренние
XHR-эндпоинты `/lookout_yard/Data/{RouteList,Route,Schedule,TripDepartures}`.
Условия использования сервиса (ред. 01.10.2021,
`/lookout_yard/Account/TermsOfUse`) прямо запрещают автоматизированное
извлечение информации, копирование и использование данных в работе иных
программ и приложений, а также коммерческое использование. Поэтому такой снимок
не является публичным лицензированным источником: импортёр сохраняет его только
локально (каталог `data/raw/` исключён из Git) и помечает результат
`status="unavailable"`; в `public/data/mobility/*` такие данные публиковать
нельзя. Подробный разбор — `docs/mobility/SOURCES.md`.

Проверка источника выполняется только явными флагами `--fetch-board
--accept-source-terms`; по умолчанию сеть не используется. Обычный запуск без
входа пишет пустой `schedule.json` со статусом `unavailable` и отчёт с причиной.

Формат снимка (`--from-raw`)
---------------------------
Один JSON-файл `minsktrans-board-capture@1`::

    {
      "format": "minsktrans-board-capture@1",
      "synthetic": false,
      "provenance": {
        "source": "…", "url": "…", "retrievedAt": "…", "licence": "…",
        "licenceUrl": "…", "reuseAllowed": false, "note": "…"
      },
      "timeZone": "Europe/Minsk",
      "routes": [
        {
          "mode": "bus", "ref": "39",
          "route":     { ... ответ /Data/Route ... },
          "schedules": [ { "stopId": 65317, "direction": 0, "response": { ... } } ],
          "trips":     [ { "stopId": 65317, "direction": 0, "dt": 432,
                           "wd": 31, "response": { ... } } ]
        }
      ]
    }

`response` — дословный JSON соответствующего эндпоинта. Снимок создаётся
командой `--fetch-board` (после явного согласия) либо вручную; нормализация
(`--from-raw`) работает офлайн и не обращается к сети.

Семантика источника, которую фиксирует этот модуль
---------------------------------------------------
* `Route.Trips.StopsA/StopsB` — остановки двух направлений; у остановки есть
  `Id`, `Latitude`, `Longitude` (WGS84), `Bearing`, `StopState`. Имена — в
  `StopNamesA/StopNamesB`. Координаты проецируются в локальные метры UTM 35N
  тем же origin, что у тайлов, через `scripts/geo_window.py`.
* `Schedule.DaysOfWeek[].DaysOfWeek` — битовая маска дней: 1=Пн, 2=Вт, 4=Ср,
  8=Чт, 16=Пт, 32=Сб, 64=Вс (подтверждено Angular-бандлом сайта). 31 — будни,
  96 — выходные, 127 — ежедневно. `HourLines[].Minutes` — отправления с этой
  остановки в минутах от начала дня обслуживания.
* `TripDepartures.model[]` — полный список остановок конкретного рейса с
  `idScheduleTrip`, `idStop`, `departure` (минуты от начала дня обслуживания).
  Значения больше 1440 относятся к продолжению дня обслуживания после
  полуночи; в контракт они пишутся как секунды > 86400. Если на запрошенные
  минуты рейса нет, сайт отвечает 200 и пустым телом; UI повторяет запрос с
  `dt + 1440` — модуль делает то же самое.
* Время в источнике одно на остановку (`departure`): отдельного `arrival` нет,
  поэтому прибытие и отправление в контракте равны, а стоянка моделируется
  экспортёром. Это записывается в warnings и отчёт.
* Период действия расписания сайт не публикует. `--valid-from/--valid-to`
  обязательны и должны опираться на официальное подтверждение перевозчика;
  выдумывать даты нельзя. `InfoExclusion` даёт только часть исключений
  («ДД.ММ.ГГГГ не работает»), `WorkingDay`/`BadTimes` контрактом не выражаются —
  они попадают в warnings и раздел «пробелы контракта» отчёта.

CLI::

    # Обычный запуск: честный статус unavailable, пустые календари/маршруты.
    python scripts/mobility/import_schedule.py

    # Исследовательский снимок с официального сайта (сеть, только при согласии).
    python scripts/mobility/import_schedule.py --fetch-board --accept-source-terms \
        --route bus:39 --route tram:9 --valid-from 2026-11-16 --valid-to 2027-03-31

    # Повторяемый офлайн-прогон по сохранённому снимку.
    python scripts/mobility/import_schedule.py --from-raw \
        data/raw/mobility/schedule/board-2026-11-16/capture.json \
        --valid-from 2026-11-16 --valid-to 2027-03-31

Синтетические фикстуры тестов помечены `"synthetic": true`; их результат имеет
`status="synthetic"` и без `--emit-unpublishable` не попадает даже в
`data/processed/mobility/schedule.json`.
"""

from __future__ import annotations

import argparse
import hashlib
import http.cookiejar
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from geo_config import area_bounds_m  # noqa: E402
from geo_window import wgs84_to_local  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT = ROOT / "data/processed/mobility/schedule.json"
DEFAULT_REPORT = ROOT / "data/processed/mobility/schedule.report.json"
DEFAULT_RAW_ROOT = ROOT / "data/raw/mobility/schedule"

TIME_ZONE = "Europe/Minsk"
CAPTURE_FORMAT = "minsktrans-board-capture@1"

BOARD_SOURCE = "ГП «Минсктранс» — «Виртуальное табло» (внутренний XHR-интерфейс)"
BOARD_INDEX_URL = "https://minsktrans.by/lookout_yard/Home/Index/minsk"
BOARD_DATA_URL = "https://minsktrans.by/lookout_yard/Data/"
BOARD_TERMS_URL = "https://minsktrans.by/lookout_yard/Account/TermsOfUse"
BOARD_TERMS = (
    "Условия использования «Виртуального табло» (01.10.2021): информация "
    "предназначена исключительно для личного некоммерческого использования; "
    "копирование и размещение на иных сайтах, использование в работе иных "
    "программ и приложений, автоматизированное извлечение информации запрещены."
)
BOARD_REUSE_ALLOWED = False

VALID_MODES = ("bus", "trolleybus", "tram")
MODE_TITLES = {"bus": "автобус", "trolleybus": "троллейбус", "tram": "трамвай"}

# Маска дней сайта -> день недели контракта (0=воскресенье … 6=суббота).
_SOURCE_WEEKDAY_BITS = tuple(range(7))  # 0=Пн … 6=Вс
_EXCLUSION_RE = re.compile(r"(\d{2})\.(\d{2})\.(\d{4})\s+не\s+работает", re.IGNORECASE)

CONTRACT_GAPS = [
    "MobilityServiceCalendar требует начало и конец периода действия, а сайт "
    "Минсктранса период не публикует: даты задаются оператором по официальному "
    "подтверждению, иначе импорт завершается ошибкой.",
    "Информация «WorkingDay» (день работает по расписанию другого дня) и "
    "«BadTimes» (отменённые отправления на конкретную дату) не выражаются "
    "MobilityServiceCalendar (там только add/remove целого дня) и теряются.",
    "Источник публикует одно время на остановку (departure). Отдельных arrival "
    "и dwell нет; в stopTimes arrivalS = departureS, стоянка — модель экспортёра.",
    "У источника бывают укороченные рейсы (заезд из парка/в парк) с другой "
    "последовательностью остановок. schedule.json описывает один вариант на "
    "пару (маршрут, направление); такие рейсы отбрасываются с предупреждением, "
    "пока не появится вариант маршрута.",
    "Направление в контракте — только 0|1. Внутренний интерфейс использует "
    "«tripType» остановки (0..3) для вариантов; перенос на контракт требует "
    "явного сопоставления вариантов.",
]


class ScheduleImportError(RuntimeError):
    """Ошибка входных данных или источника, при которой импорт не продолжается."""


# ---------------------------------------------------------------------------
# Общие помощники
# ---------------------------------------------------------------------------


def _utc_now() -> str:
    """Текущее время в UTC в ISO 8601 (для provenance и отчётов)."""
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def _sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def _write_json(path: Path, payload: Any) -> None:
    """Детерминированная запись JSON: UTF-8, LF, отступ 2, конечный перевод строки."""
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
    with path.open("w", encoding="utf-8", newline="\n") as stream:
        stream.write(text)


def _parse_iso_date(value: str) -> str:
    try:
        parsed = date.fromisoformat(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError(f"ожидается дата YYYY-MM-DD, получено {value!r}") from exc
    return parsed.isoformat()


def _contract_weekday(day: date) -> int:
    """День недели контракта (0=воскресенье … 6=суббота) для даты."""
    return day.isoweekday() % 7


def mask_to_weekdays(mask: int) -> list[int]:
    """Битовая маска сайта (1=Пн … 64=Вс) -> дни недели контракта (0=Вс … 6=Сб)."""
    if mask < 0 or mask > 127:
        raise ScheduleImportError(f"маска дней вне диапазона 0..127: {mask}")
    result: list[int] = []
    for bit in _SOURCE_WEEKDAY_BITS:
        if mask & (1 << bit):
            result.append((bit + 1) % 7)
    return sorted(result)


def _parse_schedule_departures(response: dict[str, Any]) -> dict[int, list[int]]:
    """`Schedule` -> {маска дней: [минуты от начала дня обслуживания]}.

    Строки `HourLines` могут содержать «послеполуночные» часы 00..04: это
    продолжение дня обслуживания. Здесь они остаются как есть (0..1439), а
    признак «+1440» разрешается при поиске рейса в `TripDepartures`.
    """
    groups = response.get("DaysOfWeek")
    if not groups:
        return {}
    result: dict[int, list[int]] = {}
    for group in groups:
        mask = group.get("DaysOfWeek")
        if not isinstance(mask, int):
            raise ScheduleImportError(f"Schedule.DaysOfWeek без маски: {group!r}")
        minutes: list[int] = []
        for line in group.get("HourLines") or []:
            hour_text = str(line.get("Hour", "")).strip()
            if not hour_text.isdigit():
                raise ScheduleImportError(f"некорректный HourLines.Hour: {line!r}")
            hour = int(hour_text)
            for minute_text in str(line.get("Minutes", "")).split():
                if not minute_text.isdigit():
                    raise ScheduleImportError(f"некорректные минуты в HourLines: {line!r}")
                minute = int(minute_text)
                if minute > 59:
                    raise ScheduleImportError(f"минуты вне 0..59: {line!r}")
                minutes.append(hour * 60 + minute)
        result[mask] = sorted(minutes)
    return result


def _parse_exclusions(text: Any, checks: "CheckLog") -> list[tuple[str, str]]:
    """Разбирает `InfoExclusion`; возвращает [(ISO-дата, исходный фрагмент)].

    Понимается только документированная UI форма «ДД.ММ.ГГГГ не работает».
    Любой другой текст сохраняется в предупреждениях, а не угадывается.
    """
    if not text:
        return []
    result: list[tuple[str, str]] = []
    for raw_part in str(text).split(","):
        part = raw_part.strip()
        if not part:
            continue
        match = _EXCLUSION_RE.search(part)
        if not match:
            checks.warn(
                "exception_text_unparsed",
                f"InfoExclusion: не удалось разобрать фрагмент {part!r}; "
                "в календарь он не переносится",
            )
            continue
        day, month, year = match.groups()
        try:
            parsed = date(int(year), int(month), int(day))
        except ValueError:
            checks.warn(
                "exception_date_invalid",
                f"InfoExclusion: некорректная дата в {part!r}",
            )
            continue
        result.append((parsed.isoformat(), part))
    return result


class CheckLog:
    """Накопитель предупреждений и структурированных проверок.

    Ошибки не «исправляются» подстановкой интервалов: проблемный рейс
    отбрасывается, а факт и причина попадают в warnings и отчёт покрытия.
    """

    def __init__(self) -> None:
        self.counts: Counter[str] = Counter()
        self.messages: dict[str, str] = {}
        self.severity: dict[str, str] = {}

    def add(self, code: str, message: str, severity: str = "warning", count: int = 1) -> None:
        if code not in self.messages:
            self.messages[code] = message
            self.severity[code] = severity
        self.counts[code] += count

    def warn(self, code: str, message: str, count: int = 1) -> None:
        self.add(code, message, "warning", count)

    def info(self, code: str, message: str, count: int = 1) -> None:
        self.add(code, message, "info", count)

    def warnings(self) -> list[str]:
        lines = []
        for code in sorted(self.counts):
            suffix = f" (×{self.counts[code]})" if self.counts[code] > 1 else ""
            lines.append(f"{code}: {self.messages[code]}{suffix}")
        return lines

    def checks(self) -> list[dict[str, Any]]:
        return [
            {
                "code": code,
                "severity": self.severity[code],
                "message": self.messages[code],
                "count": self.counts[code],
            }
            for code in sorted(self.counts)
        ]


# ---------------------------------------------------------------------------
# Нормализация снимка «Виртуального табло»
# ---------------------------------------------------------------------------


def _board_direction_stops(
    route_payload: dict[str, Any], direction: int
) -> tuple[list[dict[str, Any]], list[str], str]:
    """Возвращает (остановки, имена, headSign) выбранного направления."""
    trips = route_payload.get("Trips") or {}
    suffix = "A" if direction == 0 else "B"
    raw_stops = trips.get(f"Stops{suffix}")
    names = trips.get(f"StopNames{suffix}")
    head_sign = trips.get(f"EndStop{suffix}")
    if not isinstance(raw_stops, list) or not isinstance(names, list):
        raise ScheduleImportError(
            f"ответ Route не содержит Stops{suffix}/StopNames{suffix}"
        )
    if len(raw_stops) != len(names):
        raise ScheduleImportError(
            f"Route: остановок {len(raw_stops)}, имён {len(names)} в направлении {direction}"
        )
    if not raw_stops:
        raise ScheduleImportError(f"Route: пустой список остановок направления {direction}")
    return raw_stops, [str(name) for name in names], str(head_sign or "")


def _normalize_board_stops(
    raw_stops: list[dict[str, Any]],
    names: list[str],
    checks: CheckLog,
) -> list[dict[str, Any]]:
    """Строит stops[] контракта: локальные метры, исходные ID, порядок seq."""
    stops: list[dict[str, Any]] = []
    city = area_bounds_m("city")
    for seq, (raw, name) in enumerate(zip(raw_stops, names)):
        try:
            stop_id = int(raw["Id"])
            lat = float(raw["Latitude"])
            lon = float(raw["Longitude"])
        except (KeyError, TypeError, ValueError) as exc:
            raise ScheduleImportError(
                f"остановка #{seq}: нет Id/Latitude/Longitude в {raw!r}"
            ) from exc
        if not (-90.0 <= lat <= 90.0 and -180.0 <= lon <= 180.0):
            raise ScheduleImportError(f"остановка {stop_id}: координаты вне WGS84 ({lat}, {lon})")
        x, y = wgs84_to_local(lon, lat)
        if not (city[0] <= x <= city[2] and city[1] <= y <= city[3]):
            checks.warn(
                "stop_outside_city_area",
                f"остановка {stop_id} «{name}» вне прямоугольника B-2 "
                f"(x={x:.0f}, y={y:.0f}); для привязки к геометрии это важно",
            )
        stops.append(
            {
                "seq": seq,
                "name": name,
                "x": round(x, 3),
                "y": round(y, 3),
                "sourceId": str(stop_id),
                "timed": True,
            }
        )
    return stops


def _index_trips(
    route_entry: dict[str, Any], checks: CheckLog
) -> dict[tuple[int, int, int, int], dict[str, Any]]:
    """Индексирует ответы TripDepartures по (stopId, направление, маска, dt)."""
    index: dict[tuple[int, int, int, int], dict[str, Any]] = {}
    for item in route_entry.get("trips") or []:
        try:
            key = (
                int(item["stopId"]),
                int(item["direction"]),
                int(item["wd"]),
                int(item["dt"]),
            )
        except (KeyError, TypeError, ValueError) as exc:
            raise ScheduleImportError(f"снимок: некорректная запись trips: {item!r}") from exc
        response = item.get("response")
        if not isinstance(response, dict):
            checks.warn("trip_response_invalid", f"TripDepartures {key}: нет объекта response")
            continue
        if key in index:
            checks.warn(
                "trip_response_duplicate",
                f"TripDepartures {key}: повторный ответ в снимке; используется первый",
            )
            continue
        index[key] = response
    return index


def _trip_model_times(
    response: dict[str, Any],
    stop_ids: list[str],
    checks: CheckLog,
    source_trip_id: int,
) -> list[int] | None:
    """Проверяет модель рейса: полный маршрут, порядок и неубывание времён.

    Возвращает минуты от начала дня обслуживания для каждой остановки варианта
    или None, если рейс нельзя положить в контракт без искажений.
    """
    model = response.get("model")
    if not isinstance(model, list) or not model:
        checks.warn(
            "trip_model_empty",
            f"рейс {source_trip_id}: пустой model в TripDepartures",
        )
        return None
    if len(model) != len(stop_ids):
        checks.warn(
            "trip_variant_unsupported",
            f"рейс {source_trip_id}: {len(model)} остановок вместо {len(stop_ids)} "
            "(укороченный/парковый рейс не описывается одним вариантом)",
        )
        return None
    times: list[int] = []
    known_stops = set(stop_ids)
    for seq, row in enumerate(model):
        try:
            stop_id = str(int(row["idStop"]))
            minutes = int(row["departure"])
        except (KeyError, TypeError, ValueError) as exc:
            raise ScheduleImportError(f"рейс {source_trip_id}: некорректная строка model: {row!r}") from exc
        if stop_id not in known_stops:
            checks.warn(
                "trip_stop_unknown",
                f"рейс {source_trip_id}: остановка {stop_id} отсутствует в варианте "
                "направления; рейс отброшен",
            )
            return None
        if stop_id != stop_ids[seq]:
            checks.warn(
                "trip_stop_order_mismatch",
                f"рейс {source_trip_id}: на позиции {seq} остановка {stop_id}, "
                f"ожидалась {stop_ids[seq]}; рейс отброшен",
            )
            return None
        times.append(minutes)
    if any(later < earlier for earlier, later in zip(times, times[1:])):
        checks.warn(
            "trip_time_not_monotonic",
            f"рейс {source_trip_id}: времена остановок убывают {times}; рейс отброшен",
        )
        return None
    if times[-1] > 48 * 60:
        checks.warn(
            "trip_time_beyond_48h",
            f"рейс {source_trip_id}: время {times[-1]} мин выглядит подозрительно",
        )
    return times


def _find_trip_response(
    index: dict[tuple[int, int, int, int], dict[str, Any]],
    stop_id: int,
    direction: int,
    wd: int,
    minutes: int,
) -> tuple[dict[str, Any] | None, int | None]:
    """Ищет ответ TripDepartures; при пустом ответе повторяет с dt + 1440.

    Так же поступает Angular-клиент сайта: «00:xx» в расписании остановки
    относится к продолжению дня обслуживания, а не к началу суток.
    """
    for candidate in (minutes, minutes + 1440):
        response = index.get((stop_id, direction, wd, candidate))
        if response is not None:
            return response, candidate
    return None, None


def _normalize_board_direction(
    route_entry: dict[str, Any],
    direction: int,
    valid_from: str,
    valid_to: str,
    time_zone: str,
    checks: CheckLog,
) -> tuple[dict[str, Any], list[dict[str, Any]], dict[str, Any]]:
    """Нормализует одно направление одного маршрута.

    Возвращает (route, calendars, coverage). `calendars` — только используемые
    этим направлением календари; вызывающий код объединяет их по id.
    """
    mode = str(route_entry["mode"])
    ref = str(route_entry["ref"])
    if mode not in VALID_MODES:
        raise ScheduleImportError(f"неизвестный вид транспорта {mode!r} у маршрута {ref}")
    if not ref:
        raise ScheduleImportError("пустой номер маршрута в снимке")

    raw_stops, names, head_sign = _board_direction_stops(route_entry["route"], direction)
    stops = _normalize_board_stops(raw_stops, names, checks)
    stop_ids = [stop["sourceId"] for stop in stops]
    stop_id_set = set(stop_ids)

    schedules = [
        item
        for item in route_entry.get("schedules") or []
        if int(item.get("direction", -1)) == direction
    ]
    if not schedules:
        checks.warn(
            "direction_without_schedule",
            f"{mode} {ref} направление {direction}: в снимке нет ответов Schedule",
        )
    trips_index = _index_trips(route_entry, checks)
    calendar_id_base = f"cal:board:{mode}:{ref}:{direction}"
    calendars_by_mask: dict[int, dict[str, Any]] = {}
    exceptions_by_mask: dict[int, list[dict[str, str]]] = {}
    departures_seen: Counter[int] = Counter()
    trips: list[dict[str, Any]] = []
    trip_ids_seen: set[str] = set()
    schedule_timeouts = 0
    unmatched = 0

    # Исключения по датам берутся из всех расписаний направления: они
    # относятся к маршруту, а не к конкретной остановке.
    for item in schedules:
        response = item.get("response")
        if not isinstance(response, dict):
            checks.warn("schedule_response_invalid", f"{mode} {ref}: нет response в schedules")
            continue
        for iso_date, raw_text in _parse_exclusions(response.get("InfoExclusion"), checks):
            parsed = date.fromisoformat(iso_date)
            weekday = _contract_weekday(parsed)
            for mask in (response.get("DaysOfWeek") or []):
                mask_value = mask.get("DaysOfWeek")
                if not isinstance(mask_value, int):
                    continue
                if weekday in mask_to_weekdays(mask_value):
                    exceptions_by_mask.setdefault(mask_value, []).append(
                        {"date": iso_date, "kind": "remove"}
                    )
            checks.info(
                "exception_parsed",
                f"{mode} {ref} направление {direction}: {raw_text!r} -> удаление "
                f"{iso_date} из календарей, где этот день недели обслуживается",
            )
        working_day = response.get("WorkingDay") or 0
        if working_day:
            checks.warn(
                "working_day_override_unsupported",
                f"{mode} {ref}: WorkingDay={working_day} (день работает по чужому "
                "расписанию) не выражается MobilityServiceCalendar",
            )
        bad_times = response.get("BadTimes")
        if isinstance(bad_times, dict) and bad_times.get("Data"):
            checks.warn(
                "cancelled_times_unsupported",
                f"{mode} {ref}: BadTimes содержит {len(bad_times['Data'])} отменённых "
                "отправлений; дата в ответе не указана и контрактом не выражается",
            )
        if response.get("IsNotWorkDaysExist") and not response.get("InfoExclusion"):
            checks.warn(
                "exception_text_missing",
                f"{mode} {ref}: IsNotWorkDaysExist=true без InfoExclusion",
            )

    for item in schedules:
        response = item.get("response")
        if not isinstance(response, dict):
            continue
        stop_id = int(item["stopId"])
        if str(stop_id) not in stop_id_set:
            checks.warn(
                "schedule_stop_unknown",
                f"{mode} {ref} направление {direction}: Schedule для остановки "
                f"{stop_id}, которой нет в Route; ответ пропущен",
            )
            continue
        departures = _parse_schedule_departures(response)
        for mask, minutes_list in departures.items():
            for minutes in minutes_list:
                departures_seen[mask] += 1
                response_trip, used_dt = _find_trip_response(
                    trips_index, stop_id, direction, mask, minutes
                )
                if response_trip is None:
                    unmatched += 1
                    schedule_timeouts += 1
                    checks.warn(
                        "trip_response_missing",
                        f"{mode} {ref} направление {direction}: нет TripDepartures "
                        f"для остановки {stop_id}, маска {mask}, dt={minutes}/{minutes + 1440}",
                    )
                    continue
                model = response_trip.get("model")
                source_trip_id = None
                if isinstance(model, list) and model:
                    source_trip_id = model[0].get("idScheduleTrip")
                if source_trip_id is None:
                    checks.warn(
                        "trip_source_id_missing",
                        f"{mode} {ref}: в ответе TripDepartures нет idScheduleTrip",
                    )
                    continue
                source_trip_id = int(source_trip_id)
                times = _trip_model_times(response_trip, stop_ids, checks, source_trip_id)
                if times is None:
                    continue
                trip_key = f"{mask}:{source_trip_id}"
                if trip_key in trip_ids_seen:
                    continue
                trip_ids_seen.add(trip_key)
                if mask not in calendars_by_mask:
                    calendars_by_mask[mask] = {
                        "id": f"{calendar_id_base}:{mask}",
                        "startDate": valid_from,
                        "endDate": valid_to,
                        "weekdays": mask_to_weekdays(mask),
                        "exceptions": [],
                        "timeZone": time_zone,
                    }
                trips.append(
                    {
                        "sourceTripId": str(source_trip_id),
                        "calendarId": calendars_by_mask[mask]["id"],
                        "complete": True,
                        "stopTimes": [
                            {
                                "seq": seq,
                                "arrivalS": minutes * 60,
                                "departureS": minutes * 60,
                            }
                            for seq, minutes in enumerate(times)
                        ],
                    }
                )
                if used_dt is not None and used_dt != minutes:
                    checks.info(
                        "trip_after_midnight",
                        f"{mode} {ref}: отправление {minutes} мин найдено как "
                        f"{used_dt} мин (продолжение дня обслуживания после полуночи)",
                    )

    if not trips:
        checks.warn(
            "direction_without_trips",
            f"{mode} {ref} направление {direction}: не удалось собрать ни одного рейса",
        )
    # Порядок рейсов — по первому отправлению: детерминированный вывод и удобная
    # сверка с расписанием остановки. Послеполуночные рейсы идут последними.
    trips.sort(key=lambda trip: (trip["stopTimes"][0]["arrivalS"], trip["sourceTripId"]))
    if schedule_timeouts:
        checks.warn(
            "coverage_unmatched_trips",
            f"{mode} {ref} направление {direction}: {schedule_timeouts} отправлений "
            "без ответа TripDepartures (неполное покрытие)",
            count=schedule_timeouts,
        )

    for mask, calendar in calendars_by_mask.items():
        seen_dates: set[str] = set()
        for exception in exceptions_by_mask.get(mask, []):
            key = exception["date"]
            if key in seen_dates:
                continue
            parsed = date.fromisoformat(key)
            if not (valid_from <= key <= valid_to):
                checks.warn(
                    "exception_outside_period",
                    f"{mode} {ref}: исключение {key} вне периода {valid_from}..{valid_to}",
                )
                continue
            if _contract_weekday(parsed) not in calendar["weekdays"]:
                continue
            calendar["exceptions"].append(exception)
            seen_dates.add(key)
        calendar["exceptions"].sort(key=lambda item: item["date"])

    # `timed`: источник публикует время на каждой остановке этого варианта.
    for stop in stops:
        stop["timed"] = True

    route = {
        "mode": mode,
        "ref": ref,
        "direction": direction,
        "headSign": head_sign,
        "stops": stops,
        "trips": trips,
    }
    coverage = {
        "mode": mode,
        "ref": ref,
        "direction": direction,
        "stops": len(stops),
        "trips": len(trips),
        "stopTimes": sum(len(trip["stopTimes"]) for trip in trips),
        "calendars": [calendar["id"] for calendar in calendars_by_mask.values()],
        "departuresSeen": sum(departures_seen.values()),
        "unmatchedDepartures": unmatched,
    }
    return route, [calendars_by_mask[mask] for mask in sorted(calendars_by_mask)], coverage


def _validate_schedule(
    calendars: list[dict[str, Any]],
    routes: list[dict[str, Any]],
    checks: CheckLog,
) -> None:
    """Независимые проверки готового payload (инварианты CONTRACT.md)."""
    calendar_ids = set()
    for calendar in calendars:
        cid = calendar["id"]
        if cid in calendar_ids:
            raise ScheduleImportError(f"дубликат календаря {cid}")
        calendar_ids.add(cid)
        if calendar["startDate"] > calendar["endDate"]:
            raise ScheduleImportError(f"календарь {cid}: startDate > endDate")
        if not calendar["weekdays"]:
            raise ScheduleImportError(f"календарь {cid}: пустой список дней недели")
        for weekday in calendar["weekdays"]:
            if weekday not in range(7):
                raise ScheduleImportError(f"календарь {cid}: день недели {weekday}")
        seen_dates = set()
        for exception in calendar.get("exceptions") or []:
            if exception["date"] in seen_dates:
                checks.warn("calendar_exception_duplicate", f"{cid}: дубль исключения {exception['date']}")
            seen_dates.add(exception["date"])
            if not (calendar["startDate"] <= exception["date"] <= calendar["endDate"]):
                checks.warn(
                    "calendar_exception_outside_period",
                    f"{cid}: исключение {exception['date']} вне периода",
                )
            if exception["kind"] not in ("add", "remove"):
                raise ScheduleImportError(f"{cid}: неизвестное исключение {exception['kind']}")
    route_keys = set()
    trip_ids: set[str] = set()
    for route in routes:
        key = (route["mode"], route["ref"], route["direction"])
        if key in route_keys:
            raise ScheduleImportError(f"дубликат варианта маршрута {key}")
        route_keys.add(key)
        stop_ids = [stop["sourceId"] for stop in route["stops"]]
        if len(stop_ids) != len(set(stop_ids)):
            checks.warn(
                "duplicate_stop_in_route",
                f"{route['mode']} {route['ref']} {route['direction']}: повтор остановки в списке",
            )
        for seq, stop in enumerate(route["stops"]):
            if stop["seq"] != seq:
                raise ScheduleImportError(f"{key}: seq остановки {stop['seq']} != {seq}")
        for trip in route["trips"]:
            trip_id = f"{key}:{trip['sourceTripId']}"
            if trip_id in trip_ids:
                checks.warn("trip_source_id_duplicate", f"{key}: рейс {trip['sourceTripId']} повторён")
            trip_ids.add(trip_id)
            if trip["calendarId"] not in calendar_ids:
                raise ScheduleImportError(
                    f"{key}: рейс {trip['sourceTripId']} ссылается на неизвестный "
                    f"календарь {trip['calendarId']}"
                )
            times = trip["stopTimes"]
            if not times:
                raise ScheduleImportError(f"{key}: рейс {trip['sourceTripId']} без stopTimes")
            for index, stop_time in enumerate(times):
                if stop_time["seq"] != index:
                    raise ScheduleImportError(
                        f"{key}: рейс {trip['sourceTripId']} seq {stop_time['seq']} != {index}"
                    )
                if index >= len(route["stops"]):
                    raise ScheduleImportError(
                        f"{key}: рейс {trip['sourceTripId']} ссылается на отсутствующую остановку"
                    )
                if stop_time["arrivalS"] < 0 or stop_time["departureS"] < 0:
                    raise ScheduleImportError(f"{key}: отрицательное время")
                if stop_time["departureS"] < stop_time["arrivalS"]:
                    raise ScheduleImportError(f"{key}: departureS < arrivalS")
                if index:
                    previous = times[index - 1]
                    if stop_time["arrivalS"] < previous["departureS"]:
                        raise ScheduleImportError(
                            f"{key}: рейс {trip['sourceTripId']} время убывает на остановке {index}"
                        )


def normalize_capture(
    capture: dict[str, Any],
    valid_from: str,
    valid_to: str,
    time_zone: str,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Снимок «Виртуального табло» -> (schedule.json, отчёт покрытия)."""
    if capture.get("format") != CAPTURE_FORMAT:
        raise ScheduleImportError(
            f"неизвестный формат снимка {capture.get('format')!r}; ожидается {CAPTURE_FORMAT}"
        )
    provenance = capture.get("provenance")
    if not isinstance(provenance, dict):
        raise ScheduleImportError("снимок без provenance")
    for key in ("source", "url", "retrievedAt", "licence"):
        if not provenance.get(key):
            raise ScheduleImportError(f"provenance без обязательного поля {key!r}")
    routes_in = capture.get("routes")
    if not isinstance(routes_in, list):
        raise ScheduleImportError("снимок без списка routes")
    if valid_from > valid_to:
        raise ScheduleImportError(f"period: {valid_from} > {valid_to}")

    checks = CheckLog()
    routes: list[dict[str, Any]] = []
    calendars_by_id: dict[str, dict[str, Any]] = {}
    coverage_rows: list[dict[str, Any]] = []
    seen_routes: set[tuple[str, str, int]] = set()

    for route_entry in routes_in:
        if not isinstance(route_entry, dict):
            raise ScheduleImportError(f"некорректная запись routes: {route_entry!r}")
        mode = str(route_entry.get("mode", ""))
        ref = str(route_entry.get("ref", ""))
        if (mode, ref) in {(m, r) for m, r, _ in seen_routes}:
            checks.warn("route_duplicate", f"{mode} {ref}: повтор маршрута в снимке")
        route_payload = route_entry.get("route")
        if not isinstance(route_payload, dict):
            raise ScheduleImportError(f"{mode} {ref}: нет ответа Route")
        for direction in (0, 1):
            key = (mode, ref, direction)
            if key in seen_routes:
                checks.warn("route_direction_duplicate", f"{mode} {ref}: повтор направления {direction}")
                continue
            seen_routes.add(key)
            try:
                route, calendars, coverage = _normalize_board_direction(
                    route_entry, direction, valid_from, valid_to, time_zone, checks
                )
            except ScheduleImportError as exc:
                checks.warn(
                    "direction_skipped",
                    f"{mode} {ref} направление {direction}: {exc}",
                )
                continue
            for calendar in calendars:
                calendars_by_id.setdefault(calendar["id"], calendar)
            routes.append(route)
            coverage_rows.append(coverage)

    calendars = [calendars_by_id[cid] for cid in sorted(calendars_by_id)]
    _validate_schedule(calendars, routes, checks)

    synthetic = bool(capture.get("synthetic"))
    reuse_allowed = bool(provenance.get("reuseAllowed"))
    if synthetic:
        status = "synthetic"
    elif not reuse_allowed:
        status = "unavailable"
    elif any(checks.severity[code] == "warning" for code in checks.counts):
        status = "partial"
    else:
        status = "ready"

    warnings = checks.warnings()
    if routes:
        warnings.append(
            "Одно время на остановку: источник публикует departure без arrival/dwell; "
            "arrivalS = departureS."
        )
    if status == "unavailable":
        if capture.get("routes"):
            warnings.insert(
                0,
                "Данные получены из внутреннего интерфейса сайта Минсктранса и не "
                "лицензированы для переиспользования (см. docs/mobility/SOURCES.md); "
                "публиковать их в public/data/mobility/* нельзя.",
            )
        else:
            warnings.insert(
                0,
                "Данные не импортированы: официального машинного интерфейса с "
                "разрешением на переиспользование нет; см. docs/mobility/SOURCES.md.",
            )
    if synthetic:
        warnings.insert(
            0,
            "СИНТЕТИЧЕСКАЯ ФИКСТУРА: значения расписания вымышлены для проверки "
            "нормализатора. В public/data/mobility/* попадать не должны.",
        )
    if any(row["unmatchedDepartures"] for row in coverage_rows):
        warnings.append(
            "Часть отправлений без TripDepartures: покрытие рейсов неполное, "
            "пропуски перечислены в checks отчёта."
        )

    generated_at = str(provenance.get("retrievedAt"))
    schedule = {
        "status": status,
        "source": {
            "source": str(provenance["source"]),
            "url": str(provenance["url"]),
            "retrievedAt": str(provenance["retrievedAt"]),
            "licence": str(provenance["licence"]),
            "note": str(provenance.get("note") or ""),
        },
        "generatedAt": generated_at,
        "timeZone": time_zone,
        "calendars": calendars,
        "routes": routes,
        "warnings": warnings,
    }
    report = {
        "status": status,
        "publishable": status in ("ready", "partial"),
        "generatedAt": generated_at,
        "source": schedule["source"],
        "timeZone": time_zone,
        "period": {
            "startDate": valid_from or None,
            "endDate": valid_to or None,
            "source": (
                "оператор (источник период не публикует)"
                if valid_from and valid_to
                else "не задан (источник период не публикует)"
            ),
        },
        "coverage": {
            "routes": len(routes),
            "directions": len({(row["mode"], row["ref"], row["direction"]) for row in coverage_rows}),
            "trips": sum(row["trips"] for row in coverage_rows),
            "stopTimes": sum(row["stopTimes"] for row in coverage_rows),
            "stops": sum(row["stops"] for row in coverage_rows),
            "calendars": len(calendars),
            "departuresSeen": sum(row["departuresSeen"] for row in coverage_rows),
            "unmatchedDepartures": sum(row["unmatchedDepartures"] for row in coverage_rows),
            "stopsWithoutTimes": sum(row["stops"] for row in coverage_rows if not row["trips"]),
            "unknownTripStops": checks.counts.get("trip_stop_unknown", 0),
        },
        "routes": coverage_rows,
        "checks": checks.checks(),
        "contractGaps": CONTRACT_GAPS,
        "notes": [
            "Оба направления берутся из Route.StopsA/StopsB; время рейса — из "
            "TripDepartures.model[].departure.",
            "Рейсы, не совпадающие по составу остановок с вариантом направления "
            "(парковые/укороченные), отбрасываются и считаются в checks.",
            "Период действия источник не публикует: при наличии рейсов даты "
            "обязательны и передаются оператором (--valid-from/--valid-to).",
        ],
    }
    return schedule, report


# ---------------------------------------------------------------------------
# Снимок с официального сайта (сеть только по явному согласию)
# ---------------------------------------------------------------------------


class BoardClient:
    """Минимальный клиент внутреннего XHR-интерфейса «Виртуального табло».

    Сессия ASP.NET, antiforgery-токен и браузерные заголовки обязательны:
    GET эндпоинта возвращает 404, POST без токена/заголовков — 500. Это ещё
    одно подтверждение, что интерфейс не является публичным API.
    """

    def __init__(
        self,
        raw_dir: Path,
        timeout: float,
        delay: float,
        max_requests: int,
        user_agent: str,
    ) -> None:
        self.raw_dir = raw_dir
        self.timeout = timeout
        self.delay = delay
        self.max_requests = max_requests
        self.user_agent = user_agent
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self.jar)
        )
        self.token: str | None = None
        self.requests_log: list[dict[str, Any]] = []
        self.request_count = 0
        self.cached_responses = 0

    def _headers(self, referer: str = BOARD_INDEX_URL) -> dict[str, str]:
        return {
            "User-Agent": self.user_agent,
            "Accept": "application/json, text/javascript, */*; q=0.01",
            "Accept-Language": "ru",
            "Origin": "https://minsktrans.by",
            "Referer": referer,
        }

    def _request(self, request: urllib.request.Request, action: str, params: dict[str, Any]) -> bytes:
        if self.request_count >= self.max_requests:
            raise ScheduleImportError(
                f"превышен лимит запросов ({self.max_requests}); снимок неполный"
            )
        # Публичный сайт иногда отвечает таймаутом на отдельный запрос: без
        # повторов один сбой убивал многочасовой снимок.
        attempts = 4
        last_error: Exception | None = None
        for attempt in range(attempts):
            if self.request_count >= self.max_requests:
                raise ScheduleImportError(
                    f"превышен лимит запросов ({self.max_requests}); снимок неполный"
                )
            self.request_count += 1
            started = _utc_now()
            try:
                with self.opener.open(request, timeout=self.timeout) as response:
                    status = response.status
                    content_type = response.headers.get("Content-Type", "")
                    body = response.read()
            except urllib.error.HTTPError as exc:
                body = exc.read()
                status = exc.code
                content_type = exc.headers.get("Content-Type", "") if exc.headers else ""
                self._record(action, params, status, content_type, body, started)
                raise ScheduleImportError(
                    f"HTTP {status} для {action}: сайт отклонил запрос "
                    "(нужны сессия, antiforgery-токен и браузерные заголовки)"
                ) from exc
            except (urllib.error.URLError, TimeoutError, OSError) as exc:
                reason = getattr(exc, "reason", exc)
                self._record(action, params, 0, "", b"", started)
                last_error = exc
                if attempt + 1 < attempts:
                    time.sleep(1.2 * (attempt + 1))
                    continue
                raise ScheduleImportError(f"сеть недоступна для {action}: {reason}") from exc
            time.sleep(max(0.0, self.delay))
            self._record(action, params, status, content_type, body, started)
            return body
        raise ScheduleImportError(f"сеть недоступна для {action}: {last_error}")

    def _record(
        self,
        action: str,
        params: dict[str, Any],
        status: int,
        content_type: str,
        body: bytes,
        started: str,
    ) -> None:
        safe_params = {k: v for k, v in params.items() if k != "__RequestVerificationToken"}
        self.requests_log.append(
            {
                "action": action,
                "method": "POST",
                "url": BOARD_DATA_URL + action,
                "params": safe_params,
                "retrievedAt": started,
                "status": status,
                "contentType": content_type,
                "bytes": len(body),
                "sha256": _sha256_bytes(body),
            }
        )

    def get_index(self) -> None:
        """Открывает страницу табло, получает cookie-сессию и antiforgery-токен."""
        request = urllib.request.Request(BOARD_INDEX_URL, headers=self._headers())
        body = self._request(request, "Home/Index/minsk", {"action": "index"})
        match = re.search(
            rb'name="__RequestVerificationToken" type="hidden" value="([^"]+)"', body
        )
        if not match:
            raise ScheduleImportError("на странице табло не найден antiforgery-токен")
        self.token = match.group(1).decode("ascii")
        index_sha = _sha256_bytes(body)
        responses = self.raw_dir / "responses"
        responses.mkdir(parents=True, exist_ok=True)
        (responses / "index.html").write_bytes(body)
        self.requests_log[-1]["bytes"] = len(body)
        self.requests_log[-1]["sha256"] = index_sha
        self.requests_log[-1]["file"] = "responses/index.html"
        self.requests_log[-1]["url"] = BOARD_INDEX_URL
        self.requests_log[-1]["method"] = "GET"

    def post(self, action: str, params: dict[str, Any], label: str) -> bytes:
        """POST формы в `/lookout_yard/Data/<action>`; возвращает тело ответа.

        Если ответ с этим label уже скачан раньше, он переиспользуется: снимок
        можно перезапускать после обрыва, не повторяя тысячи запросов.
        """
        responses = self.raw_dir / "responses"
        responses.mkdir(parents=True, exist_ok=True)
        file_name = "responses/" + label
        cached_path = self.raw_dir / file_name
        if cached_path.is_file() and cached_path.stat().st_size > 0:
            self.cached_responses += 1
            return cached_path.read_bytes()
        if self.token is None:
            raise ScheduleImportError("сессия не инициализирована: вызовите get_index()")
        form = dict(params)
        form["__RequestVerificationToken"] = self.token
        data = urllib.parse.urlencode(form).encode("utf-8")
        headers = self._headers()
        headers["Content-Type"] = "application/x-www-form-urlencoded; charset=UTF-8"
        request = urllib.request.Request(
            BOARD_DATA_URL + action, data=data, headers=headers, method="POST"
        )
        body = self._request(request, action, params)
        responses = self.raw_dir / "responses"
        responses.mkdir(parents=True, exist_ok=True)
        file_name = "responses/" + label
        (self.raw_dir / file_name).write_bytes(body)
        self.requests_log[-1]["file"] = file_name
        return body


def _json_or_none(body: bytes, action: str) -> dict[str, Any] | None:
    if not body:
        return None
    try:
        payload = json.loads(body.decode("utf-8-sig"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ScheduleImportError(f"{action}: ответ не является JSON") from exc
    if not isinstance(payload, dict):
        raise ScheduleImportError(f"{action}: ожидался JSON-объект")
    return payload


def _route_specs(values: list[str]) -> list[dict[str, str]]:
    specs: list[dict[str, str]] = []
    for value in values:
        if ":" not in value:
            raise ScheduleImportError(f"ожидается MODE:REF, получено {value!r}")
        mode, ref = value.split(":", 1)
        if mode not in VALID_MODES:
            raise ScheduleImportError(
                f"вид транспорта {mode!r} не из {VALID_MODES} (в {value!r})"
            )
        if not ref:
            raise ScheduleImportError(f"пустой номер маршрута в {value!r}")
        specs.append({"mode": mode, "ref": ref})
    if not specs:
        raise ScheduleImportError("нужен хотя бы один --route MODE:REF")
    return specs


def fetch_board_capture(args: argparse.Namespace) -> dict[str, Any]:
    """Скачивает Route/Schedule/TripDepartures и собирает снимок с provenance.

    Сеть используется только здесь и только при `--fetch-board
    --accept-source-terms`. Оригиналы ответов сохраняются рядом со снимком,
    в `responses/`, с URL, временем, content-type, размером и sha256.
    """
    if not args.accept_source_terms:
        raise ScheduleImportError(
            "автоматическое извлечение данных сайта Минсктранса запрещено его "
            "Условиями использования. Для исследовательского снимка нужен явный "
            "флаг --accept-source-terms; для публикации данных требуется "
            "письменное разрешение перевозчика (см. docs/mobility/SOURCES.md)."
        )
    retrieved_at = _utc_now()
    raw_dir = args.raw_dir or (DEFAULT_RAW_ROOT / f"board-{date.today().isoformat()}")
    if raw_dir.exists() and any(raw_dir.iterdir()) and not args.force:
        raise ScheduleImportError(
            f"каталог снимка {raw_dir} уже существует; укажите --force для перезаписи"
        )
    raw_dir.mkdir(parents=True, exist_ok=True)
    client = BoardClient(
        raw_dir=raw_dir,
        timeout=args.timeout,
        delay=args.delay,
        max_requests=args.max_requests,
        user_agent=args.user_agent,
    )
    client.get_index()
    routes: list[dict[str, Any]] = []
    for spec in _route_specs(args.route):
        mode, ref = spec["mode"], spec["ref"]
        route_body = client.post(
            "Route", {"p": "minsk", "tt": mode, "r": ref}, f"route_{mode}_{ref}.json"
        )
        route_payload = _json_or_none(route_body, "Route")
        if route_payload is None:
            raise ScheduleImportError(f"Route {mode}:{ref}: пустой ответ")
        entry: dict[str, Any] = {
            "mode": mode,
            "ref": ref,
            "route": route_payload,
            "schedules": [],
            "trips": [],
        }
        for direction in (0, 1):
            try:
                raw_stops, _, _ = _board_direction_stops(route_payload, direction)
            except ScheduleImportError:
                continue
            probe_ids: list[int] = []
            # Достаточно КОНЕЧНОЙ остановки направления: её расписание перечисляет
            # все рейсы, а TripDepartures отдаёт полный набор времён по всем
            # остановкам. Опрос ещё и первой остановки удваивал каждый запрос.
            for stop in (raw_stops[-1],):
                stop_id = int(stop["Id"])
                if stop_id not in probe_ids:
                    probe_ids.append(stop_id)
            for stop_id in probe_ids:
                schedule_body = client.post(
                    "Schedule",
                    {
                        "p": "minsk",
                        "tt": mode,
                        "r": ref,
                        "s": str(stop_id),
                        "d": str(direction),
                    },
                    f"schedule_{mode}_{ref}_{direction}_{stop_id}.json",
                )
                schedule_payload = _json_or_none(schedule_body, "Schedule")
                if schedule_payload is None:
                    continue
                entry["schedules"].append(
                    {
                        "stopId": stop_id,
                        "direction": direction,
                        "response": schedule_payload,
                    }
                )
                for mask, minutes_list in _parse_schedule_departures(schedule_payload).items():
                    for minutes in minutes_list:
                        label = f"trip_{mode}_{ref}_{direction}_{stop_id}_{mask}_{minutes}.json"
                        trip_body = client.post(
                            "TripDepartures",
                            {
                                "p": "minsk",
                                "tt": mode,
                                "r": ref,
                                "s": str(stop_id),
                                "d": str(direction),
                                "dt": str(minutes),
                                "wd": str(mask),
                            },
                            label,
                        )
                        used_dt = minutes
                        if not trip_body:
                            used_dt = minutes + 1440
                            label = (
                                f"trip_{mode}_{ref}_{direction}_{stop_id}_{mask}_{used_dt}.json"
                            )
                            trip_body = client.post(
                                "TripDepartures",
                                {
                                    "p": "minsk",
                                    "tt": mode,
                                    "r": ref,
                                    "s": str(stop_id),
                                    "d": str(direction),
                                    "dt": str(used_dt),
                                    "wd": str(mask),
                                },
                                label,
                            )
                        trip_payload = _json_or_none(trip_body, "TripDepartures")
                        if trip_payload is None:
                            continue
                        entry["trips"].append(
                            {
                                "stopId": stop_id,
                                "direction": direction,
                                "dt": used_dt,
                                "wd": mask,
                                "response": trip_payload,
                            }
                        )
        routes.append(entry)

    bundle = {
        "format": CAPTURE_FORMAT,
        "synthetic": False,
        "provenance": {
            "source": BOARD_SOURCE,
            "url": BOARD_INDEX_URL,
            "retrievedAt": retrieved_at,
            "licence": BOARD_TERMS,
            "licenceUrl": BOARD_TERMS_URL,
            "reuseAllowed": BOARD_REUSE_ALLOWED,
            "note": (
                "Снимок получен по явному решению оператора для внутреннего "
                "исследования; переиспользование и публикация запрещены "
                "Условиями использования сервиса."
            ),
        },
        "timeZone": args.time_zone,
        "routes": routes,
        "fetchWarnings": [],
    }
    _write_json(raw_dir / "capture.json", bundle)
    provenance = {
        "format": "minsktrans-board-provenance@1",
        "source": BOARD_SOURCE,
        "url": BOARD_INDEX_URL,
        "termsUrl": BOARD_TERMS_URL,
        "retrievedAt": retrieved_at,
        "timeZone": args.time_zone,
        "licence": BOARD_TERMS,
        "reuseAllowed": BOARD_REUSE_ALLOWED,
        "contentType": "application/json; charset=utf-8",
        "requests": client.requests_log,
    }
    _write_json(raw_dir / "PROVENANCE.json", provenance)
    return bundle


# ---------------------------------------------------------------------------
# Запуск без источника: честный статус unavailable
# ---------------------------------------------------------------------------


def unavailable_bundle(reason: str) -> dict[str, Any]:
    """Снимок-заглушка без данных: фиксирует причину, а не выдумывает рейсы."""
    return {
        "format": CAPTURE_FORMAT,
        "synthetic": False,
        "provenance": {
            "source": "нет доступного лицензированного машинного источника",
            "url": BOARD_INDEX_URL,
            "retrievedAt": _utc_now(),
            "licence": BOARD_TERMS,
            "licenceUrl": BOARD_TERMS_URL,
            "reuseAllowed": False,
            "note": reason,
        },
        "timeZone": TIME_ZONE,
        "routes": [],
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Импорт публичного расписания Минска: снимок источника, нормализация "
            "в data/processed/mobility/schedule.json и отчёт покрытия."
        )
    )
    source = parser.add_mutually_exclusive_group()
    source.add_argument(
        "--from-raw",
        type=Path,
        help="офлайн-снимок minsktrans-board-capture@1 (без сети)",
    )
    source.add_argument(
        "--fetch-board",
        action="store_true",
        help="скачать снимок с сайта Минсктранса (требует --accept-source-terms)",
    )
    parser.add_argument(
        "--accept-source-terms",
        action="store_true",
        help="явное подтверждение, что оператор принял Условия использования сервиса",
    )
    parser.add_argument(
        "--route",
        action="append",
        default=[],
        metavar="MODE:REF",
        help="маршрут для --fetch-board, например bus:39; можно несколько раз",
    )
    parser.add_argument("--valid-from", type=_parse_iso_date, help="начало периода действия")
    parser.add_argument("--valid-to", type=_parse_iso_date, help="конец периода действия")
    parser.add_argument("--time-zone", default=TIME_ZONE, help=f"IANA зона (по умолчанию {TIME_ZONE})")
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT, help="куда писать schedule.json")
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT, help="куда писать отчёт")
    parser.add_argument(
        "--raw-dir",
        type=Path,
        help="каталог снимка для --fetch-board (по умолчанию data/raw/mobility/schedule/board-<дата>)",
    )
    parser.add_argument(
        "--emit-unpublishable",
        action="store_true",
        help="записать в schedule.json синтетические/нелицензированные данные (только QA)",
    )
    parser.add_argument("--delay", type=float, default=0.5, help="пауза между запросами, с")
    parser.add_argument("--timeout", type=float, default=30.0, help="таймаут запроса, с")
    parser.add_argument("--max-requests", type=int, default=600, help="предохранитель числа запросов")
    parser.add_argument(
        "--user-agent",
        default="VoxelMinsk-schedule-importer/0.1 (offline project research)",
        help="User-Agent для исследовательского снимка",
    )
    parser.add_argument("--force", action="store_true", help="перезаписать каталог снимка")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.fetch_board and not args.route:
        parser.error("--fetch-board требует хотя бы один --route MODE:REF")
    if args.fetch_board and (not args.valid_from or not args.valid_to):
        parser.error(
            "--fetch-board требует --valid-from и --valid-to: источник период "
            "действия не публикует"
        )
    try:
        if args.from_raw:
            capture = json.loads(args.from_raw.read_text(encoding="utf-8"))
            if not isinstance(capture, dict):
                raise ScheduleImportError("снимок должен быть JSON-объектом")
        elif args.fetch_board:
            capture = fetch_board_capture(args)
        else:
            capture = unavailable_bundle(
                "Автоматическое извлечение запрещено Условиями использования "
                "«Виртуального табло»; GTFS не опубликован. Нужны письменное "
                "разрешение Минсктранса или лицензированный фид."
            )
        has_routes = bool(capture.get("routes"))
        if has_routes and (not args.valid_from or not args.valid_to):
            raise ScheduleImportError(
                "источник не публикует период действия: укажите --valid-from и "
                "--valid-to по официальному подтверждению перевозчика"
            )
        valid_from = args.valid_from or ""
        valid_to = args.valid_to or ""
        schedule, report = normalize_capture(
            capture, valid_from, valid_to, args.time_zone
        )
    except (ScheduleImportError, OSError, json.JSONDecodeError) as exc:
        print(f"ошибка импорта: {exc}", file=sys.stderr)
        return 2

    status = report["status"]
    had_routes = bool(schedule["routes"])
    if status not in ("ready", "partial") and not args.emit_unpublishable:
        schedule["routes"] = []
        schedule["calendars"] = []
        schedule["warnings"].append(
            "Маршруты и календари не записаны: статус "
            f"{status!r}. Для QA используйте --emit-unpublishable."
        )
        if had_routes:
            report["notes"].append(
                "schedule.json очищен: запрещённые к публикации/синтетические данные "
                "остались только в отчёте покрытия."
            )
    try:
        _write_json(args.out, schedule)
        _write_json(args.report, report)
    except OSError as exc:
        print(f"не удалось записать результат: {exc}", file=sys.stderr)
        return 2

    coverage = report["coverage"]
    print(
        f"status={status} publishable={report['publishable']} "
        f"routes={len(schedule['routes'])} trips={coverage['trips']} "
        f"stopTimes={coverage['stopTimes']} calendars={len(schedule['calendars'])}"
    )
    print(f"schedule: {args.out}")
    print(f"report:   {args.report}")
    if report["checks"]:
        print(f"проверки: {len(report['checks'])} видов (см. report.checks)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
