"""Generate an explicitly synthetic QA timetable for the verified corridors.

WHY THIS FILE EXISTS
--------------------
The public Minsk schedule is not licensed for reuse (see docs/mobility/SOURCES.md):
the operator's terms forbid automated extraction and reuse in other applications,
and no GTFS feed is published. The plan therefore requires that the first working
version must NOT pretend to run on a public schedule. But stages 5–7 (trip
motion, rendering, streaming, acceptance captures) still need something to move
so they can be built and verified.

This script writes `data/processed/mobility/schedule.json` with
`status: "synthetic"` and `synthetic: true`, derived from *modelled* headways.
`export.py` refuses to publish it unless `--allow-synthetic-timetable` is passed
explicitly, and even then the release is marked `scheduleStatus: "synthetic"`
and the UI must say so. It is NOT a public timetable and must be replaced by a
licensed feed before the feature can be called "public transport by schedule".

Usage:
    .venv\\Scripts\\python.exe scripts/mobility/demo_timetable.py
    .venv\\Scripts\\python.exe scripts/mobility/export.py --allow-synthetic-timetable

Determinism: no randomness, no wall-clock input — the same network.json produces
byte-identical output.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_NETWORK = ROOT / "data/processed/mobility/network.json"
DEFAULT_OUT = ROOT / "data/processed/mobility/schedule.json"
DEFAULT_REPORT = ROOT / "data/processed/mobility/demo_timetable.report.json"

# --- model parameters (documented, deliberately not disguised as data) -----

MODEL_PARAMS: dict[str, dict[str, Any]] = {
    "bus": {
        # Реальная скорость движения по перегону (не средняя по маршруту):
        # по снятым рейсам Минсктранса свободные перегоны дают 20–27 км/ч.
        "cruiseMps": 7.0,      # 25 км/ч в движении
        "headwayWeekdayS": 720,  # 12 мин
        "headwayWeekendS": 1200,  # 20 мин
        "firstDepartureS": 5 * 3600 + 30 * 60,   # 05:30
        "lastDepartureS": 23 * 3600 + 20 * 60,   # 23:20
    },
    "trolleybus": {
        "cruiseMps": 7.0,
        "headwayWeekdayS": 720,
        "headwayWeekendS": 1200,
        "firstDepartureS": 5 * 3600 + 30 * 60,
        "lastDepartureS": 23 * 3600 + 20 * 60,
    },
    "tram": {
        # Трамвай 9 в снятом рейсе: 17,1 км/ч средняя, свободные перегоны 20–24.
        "cruiseMps": 6.5,      # 23,4 км/ч в движении
        "headwayWeekdayS": 480,   # 8 мин
        "headwayWeekendS": 900,   # 15 мин
        "firstDepartureS": 5 * 3600,        # 05:00
        "lastDepartureS": 23 * 3600 + 30 * 60,
    },
}

TIME_ZONE = "Europe/Minsk"
VALID_FROM = "2026-01-01"
VALID_TO = "2027-12-31"

CALENDARS = [
    {
        "id": "cal:demo-weekday",
        "startDate": VALID_FROM,
        "endDate": VALID_TO,
        "weekdays": [1, 2, 3, 4, 5],
        "timeZone": TIME_ZONE,
    },
    {
        "id": "cal:demo-weekend",
        "startDate": VALID_FROM,
        "endDate": VALID_TO,
        "weekdays": [0, 6],
        "timeZone": TIME_ZONE,
    },
]


def lane_length(edge: dict, lane_index: int) -> float:
    """Distance along the lane the vehicle uses, metres."""
    lanes = edge.get("lanes") or []
    if 0 <= lane_index < len(lanes):
        centerline = lanes[lane_index].get("centerline") or {}
        distances = centerline.get("s") or []
        if distances:
            return float(distances[-1])
    distances = (edge.get("centerline") or {}).get("s") or [0.0]
    return float(distances[-1])


def stop_distances(variant: dict, edges: dict[str, dict]) -> list[float]:
    """Cumulative distance from the variant start to every stop call, metres.

    Walks the variant's edge chain once. Each edge contributes its *lane* length
    (the lane a stop on that edge uses, else lane 0), then every stop call adds
    its own `s` along that lane.
    """
    edge_positions: dict[str, tuple[float, int]] = {}
    cumulative = 0.0
    for edge_id in variant["edges"]:
        lane_index = 0
        for call in variant["stops"]:
            if call["edgeId"] == edge_id:
                lane_index = int(call.get("laneIndex") or 0)
                break
        edge_positions[edge_id] = (cumulative, lane_index)
        cumulative += lane_length(edges.get(edge_id, {}), lane_index)

    result: list[float] = []
    for call in variant["stops"]:
        base, _ = edge_positions.get(call["edgeId"], (0.0, 0))
        result.append(base + float(call.get("s") or 0.0))
    return result


def build_trips(variant: dict, edges: dict[str, dict], stops_by_id: dict[str, dict]) -> list[dict]:
    """Deterministic synthetic trips for one variant, both service calendars."""
    mode = variant["mode"]
    params = MODEL_PARAMS.get(mode, MODEL_PARAMS["bus"])
    distances = stop_distances(variant, edges)
    if len(distances) != len(variant["stops"]):
        raise ValueError(f"{variant['id']}: stop distances do not match stops")
    calls = variant["stops"]
    trips: list[dict] = []
    variant_index = 0
    for calendar in CALENDARS:
        weekday = calendar["weekdays"][0] <= 4
        headway = params["headwayWeekdayS"] if weekday else params["headwayWeekendS"]
        # Phase the two directions by half a headway so they do not leave
        # simultaneously; still deterministic (no random term).
        offset = int(variant["direction"]) * headway // 2
        departure = int(params["firstDepartureS"]) + offset
        trip_index = 0
        while departure <= int(params["lastDepartureS"]):
            stop_times: list[dict] = []
            clock = float(departure)
            previous_distance = 0.0
            for position, call in enumerate(calls):
                distance = distances[position]
                segment = max(0.0, distance - previous_distance)
                travel = segment / float(params["cruiseMps"])
                arrival = int(round(clock + travel))
                stop_times.append(
                    {
                        "seq": position,
                        "arrivalS": arrival,
                        "departureS": arrival,
                    }
                )
                dwell = float(call.get("dwellS") or 0.0) if position < len(calls) - 1 else 0.0
                # The modelled departure is the arrival plus the stop dwell time.
                stop_times[-1]["departureS"] = int(round(arrival + dwell))
                clock = float(stop_times[-1]["departureS"])
                previous_distance = distance
            trips.append(
                {
                    "sourceTripId": f"demo:{variant['ref']}:{variant['direction']}:{calendar['id']}:{trip_index:03d}",
                    "calendarId": calendar["id"],
                    "complete": False,
                    "stopTimes": stop_times,
                }
            )
            departure += headway
            trip_index += 1
            variant_index += 1
        _ = variant_index
    return trips


def build_schedule(network: dict) -> tuple[dict, dict]:
    edges = {edge["id"]: edge for edge in network.get("edges") or []}
    stops_by_id = {stop["id"]: stop for stop in network.get("stops") or []}
    routes: list[dict] = []
    warnings: list[str] = []
    total_trips = 0
    for variant in network.get("variants") or []:
        if not variant.get("verified"):
            warnings.append(f"{variant['id']}: unverified variant skipped")
            continue
        mode = variant["mode"]
        if mode not in MODEL_PARAMS:
            warnings.append(f"{variant['id']}: unsupported mode {mode!r} skipped")
            continue
        trips = build_trips(variant, edges, stops_by_id)
        total_trips += len(trips)
        stops = [
            {
                "seq": call["seq"],
                "name": (stops_by_id.get(call["stopId"]) or {}).get("name", ""),
                "x": round(float(call["x"]), 2),
                "y": round(float(call["y"]), 2),
                "sourceId": call["stopId"],
                "timed": True,
            }
            for call in variant["stops"]
        ]
        routes.append(
            {
                "mode": mode,
                "ref": variant["ref"],
                "direction": variant["direction"],
                "headSign": variant.get("headSign") or "",
                "stops": stops,
                "trips": trips,
            }
        )
    schedule = {
        "status": "synthetic",
        "synthetic": True,
        "generatedAt": _deterministic_timestamp(network),
        "timeZone": TIME_ZONE,
        "period": {"startDate": VALID_FROM, "endDate": VALID_TO, "source": "model (demo)"},
        "source": {
            "source": "синтетическое демонстрационное расписание (не публичные данные)",
            "url": "scripts/mobility/demo_timetable.py",
            "retrievedAt": _deterministic_timestamp(network),
            "licence": "synthetic demo data — not a public timetable, not for publication as Minsktrans data",
            "note": (
                "Интервалы, скорости и стоянки — модельные параметры, не времена Минсктранса. "
                "Нужно для проверки движения/рендера, пока не получен лицензированный фид "
                "(см. docs/mobility/SOURCES.md)."
            ),
        },
        "calendars": CALENDARS,
        "routes": routes,
        "warnings": warnings,
    }
    report = {
        "status": "synthetic",
        "publishable": False,
        "model": MODEL_PARAMS,
        "calendars": [calendar["id"] for calendar in CALENDARS],
        "routes": len(routes),
        "trips": total_trips,
        "note": "Только для QA: export.py публикует эти рейсы лишь с --allow-synthetic-timetable.",
        "warnings": warnings,
    }
    return schedule, report


def _deterministic_timestamp(network: dict) -> str:
    """Timestamp derived from the network snapshot, so output is reproducible."""
    generated = str(network.get("generatedAt") or "2026-11-16T00:00:00Z")
    return generated


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--network", default=str(DEFAULT_NETWORK))
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    parser.add_argument("--report", default=str(DEFAULT_REPORT))
    args = parser.parse_args(argv)

    network_path = Path(args.network)
    if not network_path.is_file():
        print(f"ERROR: network not found: {network_path}; run build_network.py first")
        return 1
    network = json.loads(network_path.read_text(encoding="utf-8"))
    schedule, report = build_schedule(network)
    report["networkSha256"] = hashlib.sha256(network_path.read_bytes()).hexdigest()

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(schedule, ensure_ascii=False, sort_keys=True, indent=2) + "\n"
    out.write_text(text, encoding="utf-8")
    report["scheduleSha256"] = hashlib.sha256(text.encode("utf-8")).hexdigest()
    Path(args.report).write_text(
        json.dumps(report, ensure_ascii=False, sort_keys=True, indent=2) + "\n", encoding="utf-8"
    )
    print(
        f"Wrote {out}: status=synthetic routes={report['routes']} trips={report['trips']} "
        f"calendars={len(report['calendars'])}"
    )
    print(f"report: {args.report}")
    print(
        "NOTE: это демонстрационное расписание. Публикация — только "
        "export.py --allow-synthetic-timetable; манифест пометит scheduleStatus=synthetic."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
