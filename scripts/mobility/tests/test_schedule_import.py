"""Тесты импорта и нормализации расписания (синтетическая фикстура).

ФИКСТУРА ЯВНО СИНТЕТИЧЕСКАЯ: номера маршрутов, остановки, времена и имена
вымышлены для проверки нормализатора. Они не являются расписанием Минска и не
должны попадать в `public/data/mobility/*`. Официальные данные не используются:
реальный источник закрыт Условиями использования (см. `docs/mobility/SOURCES.md`).

Запуск:
    .venv\\Scripts\\python.exe -m unittest discover -s scripts/mobility/tests \\
        -p "test_schedule*.py" -v
"""

from __future__ import annotations

import copy
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[2]
MOBILITY = SCRIPTS / "mobility"
sys.path.insert(0, str(SCRIPTS))
sys.path.insert(0, str(MOBILITY))

import import_schedule as imp  # noqa: E402
from geo_window import wgs84_to_local  # noqa: E402

PERIOD = ("2026-11-01", "2027-03-31")
STOPS_A = [
    {"Id": 9001, "Latitude": 53.9001, "Longitude": 27.5601, "Bearing": -1, "StopState": 0},
    {"Id": 9002, "Latitude": 53.9050, "Longitude": 27.5650, "Bearing": 45, "StopState": 0},
    {"Id": 9003, "Latitude": 53.9100, "Longitude": 27.5700, "Bearing": -1, "StopState": 0},
]
STOPS_B = list(reversed(STOPS_A))


def _hour_lines(lines: list[tuple[str, str]]) -> list[dict[str, str]]:
    return [
        {"Hour": hour, "Minutes": minutes, "ApparelByMinutes": "", "FutureMinutes": ""}
        for hour, minutes in lines
    ]


def _schedule(mask: int, lines: list[tuple[str, str]], exclusion: str = "") -> dict:
    body = {"DaysOfWeek": mask, "StopType": 1, "HourLines": _hour_lines(lines)}
    return {
        "Schedule": body,
        "DaysOfWeek": [body],
        "InfoExclusion": exclusion,
        "WorkingDay": 0,
        "OperInfo": {"IsSuccess": False, "Infos": []},
        "BadTimes": None,
        "IsLastStop": False,
        "IsNotWorkDaysExist": False,
    }


def _trip(trip_id: int, pairs: list[tuple[int, int]]) -> dict:
    return {
        "model": [
            {
                "idScheduleTrip": trip_id,
                "idStop": stop_id,
                "stopName": f"СИНТ-{stop_id}",
                "departure": departure,
                "attr": 0,
                "vehicleStates": 125,
                "stopState": 0,
            }
            for stop_id, departure in pairs
        ],
        "vehicleStates": 125,
    }


def build_capture() -> dict:
    """Синтетический снимок: 2 направления, будни/выходные, рейс после полуночи."""
    route = {
        "OperInfo": {"IsSuccess": False, "Infos": []},
        "Trips": {
            "NameA": "СИНТЕТИКА: A -> B",
            "EndStopA": "Синтетическая конечная B",
            "StopsA": STOPS_A,
            "StopNamesA": ["Синт-1", "Синт-2", "Синт-3"],
            "NameB": "СИНТЕТИКА: B -> A",
            "EndStopB": "Синтетическая конечная A",
            "StopsB": STOPS_B,
            "StopNamesB": ["Синт-3", "Синт-2", "Синт-1"],
            "Info": "СИНТЕТИЧЕСКАЯ ФИКСТУРА",
            "OtherDirections": [],
        },
    }
    return {
        "format": imp.CAPTURE_FORMAT,
        "synthetic": True,
        "provenance": {
            "source": "СИНТЕТИЧЕСКАЯ ФИКСТУРА (не официальные данные)",
            "url": "synthetic://schedule-fixture",
            "retrievedAt": "2026-11-16T00:00:00+00:00",
            "licence": "синтетическая фикстура только для тестов",
            "reuseAllowed": False,
            "note": "все времена и названия вымышлены",
        },
        "timeZone": "Europe/Minsk",
        "routes": [
            {
                "mode": "bus",
                "ref": "T39",
                "route": route,
                "schedules": [
                    {
                        "stopId": 9001,
                        "direction": 0,
                        "response": _schedule(
                            31, [("05", "10 25"), ("00", "05")], "25.12.2026 не работает"
                        ),
                    },
                    {"stopId": 9001, "direction": 0, "response": _schedule(96, [("06", "00")])},
                    {"stopId": 9003, "direction": 1, "response": _schedule(31, [("07", "00")])},
                ],
                "trips": [
                    {
                        "stopId": 9001,
                        "direction": 0,
                        "dt": 310,
                        "wd": 31,
                        "response": _trip(1, [(9001, 310), (9002, 313), (9003, 315)]),
                    },
                    {
                        "stopId": 9001,
                        "direction": 0,
                        "dt": 325,
                        "wd": 31,
                        "response": _trip(2, [(9001, 325), (9002, 328), (9003, 330)]),
                    },
                    {
                        "stopId": 9001,
                        "direction": 0,
                        "dt": 1445,
                        "wd": 31,
                        "response": _trip(3, [(9001, 1445), (9002, 1448), (9003, 1450)]),
                    },
                    {
                        "stopId": 9001,
                        "direction": 0,
                        "dt": 360,
                        "wd": 96,
                        "response": _trip(4, [(9001, 360), (9002, 363), (9003, 365)]),
                    },
                    {
                        "stopId": 9003,
                        "direction": 1,
                        "dt": 420,
                        "wd": 31,
                        "response": _trip(5, [(9003, 420), (9002, 423), (9001, 425)]),
                    },
                ],
            }
        ],
    }


def write_capture(directory: Path, capture: dict) -> Path:
    path = directory / "capture.json"
    path.write_text(json.dumps(capture, ensure_ascii=False), encoding="utf-8")
    return path


def run_import(
    directory: Path,
    capture: dict | None,
    *,
    emit: bool = True,
    period: bool = PERIOD,
) -> tuple[int, Path, Path, Path | None]:
    schedule_path = directory / "schedule.json"
    report_path = directory / "report.json"
    argv: list[str] = ["--out", str(schedule_path), "--report", str(report_path)]
    capture_path = write_capture(directory, capture) if capture is not None else None
    if capture_path is not None:
        argv += ["--from-raw", str(capture_path)]
    if period:
        argv += ["--valid-from", period[0], "--valid-to", period[1]]
    if emit:
        argv.append("--emit-unpublishable")
    sink = io.StringIO()
    with redirect_stdout(sink), redirect_stderr(sink):
        code = imp.main(argv)
    return code, schedule_path, report_path, capture_path


def load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


class MaskAndCalendarTests(unittest.TestCase):
    def test_source_mask_maps_to_contract_weekdays(self):
        self.assertEqual(imp.mask_to_weekdays(31), [1, 2, 3, 4, 5])  # Пн–Пт
        self.assertEqual(imp.mask_to_weekdays(96), [0, 6])  # Сб+Вс
        self.assertEqual(imp.mask_to_weekdays(127), [0, 1, 2, 3, 4, 5, 6])

    def test_contract_weekday_is_not_machine_locale_dependent(self):
        from datetime import date

        # 2026-11-16 — понедельник; контракт: 0=Вс … 6=Сб.
        self.assertEqual(imp._contract_weekday(date(2026, 11, 16)), 1)
        self.assertEqual(imp._contract_weekday(date(2026, 11, 22)), 0)


class BoardNormalizationTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()

    def test_directions_stops_trips_and_coordinates(self):
        code, schedule_path, report_path, _ = run_import(self.dir, build_capture())
        self.assertEqual(code, 0)
        schedule = load(schedule_path)
        report = load(report_path)

        self.assertEqual(schedule["status"], "synthetic")
        self.assertFalse(report["publishable"])
        self.assertEqual(len(schedule["routes"]), 2)
        route_a, route_b = schedule["routes"]
        self.assertEqual((route_a["mode"], route_a["ref"], route_a["direction"]), ("bus", "T39", 0))
        self.assertEqual(route_a["headSign"], "Синтетическая конечная B")
        self.assertEqual(route_b["headSign"], "Синтетическая конечная A")
        self.assertEqual([stop["seq"] for stop in route_a["stops"]], [0, 1, 2])
        self.assertEqual([stop["sourceId"] for stop in route_a["stops"]], ["9001", "9002", "9003"])

        expected_x, expected_y = wgs84_to_local(27.5601, 53.9001)
        self.assertAlmostEqual(route_a["stops"][0]["x"], round(expected_x, 3), places=6)
        self.assertAlmostEqual(route_a["stops"][0]["y"], round(expected_y, 3), places=6)
        self.assertTrue(all(stop["timed"] for stop in route_a["stops"]))

        # Три будних рейса + один выходной; порядок — по первому отправлению.
        self.assertEqual([trip["sourceTripId"] for trip in route_a["trips"]], ["1", "2", "4", "3"])
        self.assertEqual(len(route_a["trips"][0]["stopTimes"]), 3)
        self.assertEqual(route_a["trips"][0]["stopTimes"][0], {"seq": 0, "arrivalS": 18600, "departureS": 18600})
        self.assertEqual(route_b["trips"][0]["stopTimes"][0]["arrivalS"], 25200)

    def test_after_midnight_trip_exceeds_86400(self):
        code, schedule_path, _, _ = run_import(self.dir, build_capture())
        self.assertEqual(code, 0)
        schedule = load(schedule_path)
        route_a = schedule["routes"][0]
        after_midnight = next(trip for trip in route_a["trips"] if trip["sourceTripId"] == "3")
        times = [stop_time["arrivalS"] for stop_time in after_midnight["stopTimes"]]
        self.assertEqual(times, [1445 * 60, 1448 * 60, 1450 * 60])
        self.assertGreater(times[0], 86400)
        self.assertEqual(times, sorted(times))
        self.assertEqual(after_midnight["stopTimes"][0]["departureS"], after_midnight["stopTimes"][0]["arrivalS"])

    def test_calendar_exception_is_applied_to_matching_weekday(self):
        _, schedule_path, report_path, _ = run_import(self.dir, build_capture())
        schedule = load(schedule_path)
        calendars = {calendar["id"]: calendar for calendar in schedule["calendars"]}
        weekday = calendars["cal:board:bus:T39:0:31"]
        weekend = calendars["cal:board:bus:T39:0:96"]
        self.assertEqual(weekday["weekdays"], [1, 2, 3, 4, 5])
        self.assertEqual(weekday["exceptions"], [{"date": "2026-12-25", "kind": "remove"}])
        self.assertEqual(weekend["exceptions"], [])
        report = load(report_path)
        self.assertIn("exception_parsed", [check["code"] for check in report["checks"]])

    def test_non_monotonic_trip_is_dropped_not_interpolated(self):
        capture = build_capture()
        model = capture["routes"][0]["trips"][0]["response"]["model"]
        model[1]["departure"] = 300
        _, schedule_path, report_path, _ = run_import(self.dir, capture)
        schedule = load(schedule_path)
        route_a = schedule["routes"][0]
        self.assertNotIn("1", [trip["sourceTripId"] for trip in route_a["trips"]])
        self.assertEqual(len(route_a["trips"]), 3)
        report = load(report_path)
        codes = [check["code"] for check in report["checks"]]
        self.assertIn("trip_time_not_monotonic", codes)
        self.assertEqual(report["coverage"]["trips"], 4)

    def test_unknown_stop_in_trip_is_reported(self):
        capture = build_capture()
        capture["routes"][0]["trips"][0]["response"]["model"][1]["idStop"] = 9999
        _, schedule_path, report_path, _ = run_import(self.dir, capture)
        schedule = load(schedule_path)
        self.assertNotIn("1", [trip["sourceTripId"] for trip in schedule["routes"][0]["trips"]])
        report = load(report_path)
        codes = [check["code"] for check in report["checks"]]
        self.assertIn("trip_stop_unknown", codes)

    def test_duplicate_trip_response_recorded_once(self):
        capture = build_capture()
        duplicate = copy.deepcopy(capture["routes"][0]["trips"][0])
        capture["routes"][0]["trips"].append(duplicate)
        _, schedule_path, report_path, _ = run_import(self.dir, capture)
        schedule = load(schedule_path)
        self.assertEqual(
            [trip["sourceTripId"] for trip in schedule["routes"][0]["trips"]].count("1"), 1
        )
        report = load(report_path)
        self.assertIn("trip_response_duplicate", [check["code"] for check in report["checks"]])

    def test_direction_without_schedule_warns_instead_of_crashing(self):
        capture = build_capture()
        capture["routes"][0]["schedules"] = [
            item for item in capture["routes"][0]["schedules"] if item["direction"] == 0
        ]
        code, schedule_path, report_path, _ = run_import(self.dir, capture)
        self.assertEqual(code, 0)
        schedule = load(schedule_path)
        self.assertEqual(len(schedule["routes"]), 2)
        self.assertEqual(schedule["routes"][1]["trips"], [])
        report = load(report_path)
        self.assertIn(
            "direction_without_schedule", [check["code"] for check in report["checks"]]
        )

    def test_missing_direction_is_skipped_with_warning(self):
        capture = build_capture()
        capture["routes"][0]["route"]["Trips"]["StopsB"] = []
        capture["routes"][0]["route"]["Trips"]["StopNamesB"] = []
        code, schedule_path, report_path, _ = run_import(self.dir, capture)
        self.assertEqual(code, 0)
        schedule = load(schedule_path)
        self.assertEqual(len(schedule["routes"]), 1)
        report = load(report_path)
        self.assertIn("direction_skipped", [check["code"] for check in report["checks"]])

    def test_missing_period_is_rejected(self):
        code, schedule_path, _, _ = run_import(self.dir, build_capture(), period=None)
        self.assertEqual(code, 2)
        self.assertFalse(schedule_path.exists())

    def test_synthetic_is_not_written_without_explicit_flag(self):
        code, schedule_path, report_path, _ = run_import(self.dir, build_capture(), emit=False)
        self.assertEqual(code, 0)
        schedule = load(schedule_path)
        report = load(report_path)
        self.assertEqual(schedule["routes"], [])
        self.assertEqual(schedule["calendars"], [])
        self.assertEqual(schedule["status"], "synthetic")
        self.assertEqual(report["coverage"]["trips"], 5)
        self.assertTrue(any("не записаны" in warning for warning in schedule["warnings"]))

    def test_repeatable_offline_run_is_byte_identical(self):
        capture_path = write_capture(self.dir, build_capture())
        outputs = []
        for index in range(2):
            schedule_path = self.dir / f"schedule-{index}.json"
            report_path = self.dir / f"report-{index}.json"
            argv = [
                "--from-raw", str(capture_path),
                "--valid-from", PERIOD[0], "--valid-to", PERIOD[1],
                "--out", str(schedule_path), "--report", str(report_path),
                "--emit-unpublishable",
            ]
            sink = io.StringIO()
            with redirect_stdout(sink), redirect_stderr(sink):
                self.assertEqual(imp.main(argv), 0)
            outputs.append((schedule_path.read_bytes(), report_path.read_bytes()))
        self.assertEqual(outputs[0], outputs[1])

    def test_machine_time_zone_does_not_change_result(self):
        capture_path = write_capture(self.dir, build_capture())
        script = MOBILITY / "import_schedule.py"
        outputs = []
        for zone in ("UTC", "Pacific/Kiritimati"):
            schedule_path = self.dir / f"tz-{zone.replace('/', '_')}.json"
            report_path = self.dir / f"tz-{zone.replace('/', '_')}.report.json"
            env = os.environ.copy()
            env["TZ"] = zone
            env["PYTHONHASHSEED"] = "0"
            result = subprocess.run(
                [
                    sys.executable, str(script),
                    "--from-raw", str(capture_path),
                    "--valid-from", PERIOD[0], "--valid-to", PERIOD[1],
                    "--out", str(schedule_path), "--report", str(report_path),
                    "--emit-unpublishable",
                ],
                cwd=str(imp.ROOT),
                env=env,
                capture_output=True,
                text=True,
                encoding="utf-8",
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            outputs.append(schedule_path.read_bytes())
        self.assertEqual(outputs[0], outputs[1])


class UnavailableSourceTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()

    def test_default_run_reports_unavailable_and_publishes_nothing(self):
        code, schedule_path, report_path, _ = run_import(self.dir, None)
        self.assertEqual(code, 0)
        schedule = load(schedule_path)
        report = load(report_path)
        self.assertEqual(schedule["status"], "unavailable")
        self.assertEqual(schedule["routes"], [])
        self.assertEqual(schedule["calendars"], [])
        self.assertFalse(report["publishable"])
        self.assertEqual(report["status"], "unavailable")
        self.assertIn("запрещ", report["source"]["licence"])
        self.assertTrue(report["contractGaps"])


if __name__ == "__main__":
    unittest.main()
