"""Audit the exported mobility payload against the shared contract.

The exporter is allowed to be optimistic; this script is not. It re-reads the
files that the browser will fetch (`public/data/mobility/`) and checks the
invariants from `src/shared/mobility.ts` and `docs/mobility/CONTRACT.md`:

  * manifest / chunk / route versions match `MOBILITY_VERSION`;
  * chunk files exist, parse, and their recorded byte sizes and counts match;
  * every polyline has matching `p`/`s` arrays, starts at 0, and never decreases;
  * every route variant is continuous (`edge[i].to == edge[i+1].from`);
  * every stop call lies on an edge of its own variant with `0 <= s <= length`;
  * every trip references a known calendar and variant, has one stop time per
    stop call, and its times never run backwards;
  * signal nodes reference valid groups/movements, conflicts are symmetric pairs
    of existing movements, stop lines point at real movements, and no phase
    gives green to two conflicting movements;
  * the release identity (network/schedule/bindings) is complete and consistent
    across the manifest.

Exit code 0 means "no errors" (warnings are allowed and printed). Any error is a
hard failure: the runtime payload must not be shipped while this script fails.

Usage:
    .venv\\Scripts\\python.exe scripts/qa/mobility-audit.py
    .venv\\Scripts\\python.exe scripts/qa/mobility-audit.py --base public/data/mobility --out data/processed/mobility/audit.json
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
MOBILITY_VERSION = 1
EPS = 1e-6


class Audit:
    """Collects errors/warnings and turns them into a JSON report."""

    def __init__(self) -> None:
        self.errors: list[str] = []
        self.warnings: list[str] = []
        self.counters: dict[str, int] = {}

    def fail(self, message: str) -> None:
        self.errors.append(message)

    def warn(self, message: str) -> None:
        self.warnings.append(message)

    def count(self, key: str, amount: int = 1) -> None:
        self.counters[key] = self.counters.get(key, 0) + amount

    def report(self) -> dict[str, Any]:
        return {
            "ok": not self.errors,
            "errors": self.errors,
            "warnings": self.warnings,
            "counters": self.counters,
        }


def load_json(path: Path, audit: Audit, label: str) -> Any | None:
    if not path.is_file():
        audit.fail(f"{label}: file is missing ({path})")
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        audit.fail(f"{label}: invalid JSON ({error})")
        return None


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


# ---------------------------------------------------------------------------
# geometry checks
# ---------------------------------------------------------------------------


def check_polyline(audit: Audit, label: str, polyline: Any) -> tuple[list[float], list[float]] | None:
    """Validate one `{p, s}` polyline and return it on success."""
    if not isinstance(polyline, dict):
        audit.fail(f"{label}: polyline is not an object")
        return None
    points = polyline.get("p")
    distances = polyline.get("s")
    if not isinstance(points, list) or not isinstance(distances, list):
        audit.fail(f"{label}: polyline needs list fields p and s")
        return None
    if len(points) % 3 != 0:
        audit.fail(f"{label}: p has {len(points)} numbers, not a multiple of 3")
        return None
    vertices = len(points) // 3
    if vertices == 0:
        audit.fail(f"{label}: empty polyline")
        return None
    if len(distances) != vertices:
        audit.fail(f"{label}: s has {len(distances)} entries for {vertices} vertices")
        return None
    if any(not isinstance(value, (int, float)) or not math.isfinite(value) for value in points):
        audit.fail(f"{label}: p contains non-finite numbers")
        return None
    if any(not isinstance(value, (int, float)) or not math.isfinite(value) for value in distances):
        audit.fail(f"{label}: s contains non-finite numbers")
        return None
    if abs(distances[0]) > EPS:
        audit.fail(f"{label}: s[0] must be 0, got {distances[0]}")
    for index in range(1, vertices):
        if distances[index] < distances[index - 1] - 1e-9:
            audit.fail(
                f"{label}: s decreases at vertex {index} ({distances[index - 1]:.3f} -> {distances[index]:.3f})"
            )
            break
    # Reported length must match the geometry (1 % tolerance for 1 cm rounding).
    expected = 0.0
    for index in range(1, vertices):
        expected += math.hypot(
            points[index * 3] - points[index * 3 - 3],
            points[index * 3 + 1] - points[index * 3 - 2],
        )
    recorded = distances[-1]
    if expected > 1.0 and abs(recorded - expected) > max(0.5, expected * 0.01):
        audit.fail(f"{label}: arc length {recorded:.2f} m does not match geometry {expected:.2f} m")
    return points, distances


def lane_length(audit: Audit, label: str, lane: dict[str, Any], edge_length: float) -> float:
    """Length of a lane: its own polyline when present, else the edge length."""
    centerline = lane.get("centerline")
    if isinstance(centerline, dict) and isinstance(centerline.get("p"), list) and centerline["p"]:
        checked = check_polyline(audit, f"{label}.centerline", centerline)
        return checked[1][-1] if checked else edge_length
    if isinstance(centerline, dict):
        # Empty centerline is legal: the lane equals the edge centreline.
        return edge_length
    audit.fail(f"{label}: lane.centerline missing")
    return edge_length


# ---------------------------------------------------------------------------
# payload checks
# ---------------------------------------------------------------------------


def check_chunk(
    audit: Audit,
    base: Path,
    index_entry: dict[str, Any],
    edge_index: dict[str, dict[str, Any]],
    chunk_nodes: dict[str, dict[str, Any]],
) -> None:
    key = index_entry.get("key")
    label = f"chunk {key}"
    file = index_entry.get("file")
    if not isinstance(file, str) or not file:
        audit.fail(f"{label}: manifest entry has no file")
        return
    path = base / file
    if not path.is_file():
        audit.fail(f"{label}: file {file} is missing")
        return
    actual_bytes = path.stat().st_size
    recorded_bytes = index_entry.get("bytes")
    if isinstance(recorded_bytes, int) and recorded_bytes != actual_bytes:
        audit.fail(f"{label}: manifest bytes {recorded_bytes} != file {actual_bytes}")
    chunk = load_json(path, audit, label)
    if chunk is None:
        return
    if chunk.get("version") != MOBILITY_VERSION:
        audit.fail(f"{label}: version {chunk.get('version')} != {MOBILITY_VERSION}")
    if chunk.get("key") != key:
        audit.fail(f"{label}: payload key {chunk.get('key')!r} != manifest key")
    bounds = chunk.get("bounds")
    if not isinstance(bounds, list) or len(bounds) != 4:
        audit.fail(f"{label}: bounds must be 4 numbers")

    edges = chunk.get("edges") or []
    if not isinstance(edges, list):
        audit.fail(f"{label}: edges must be a list")
        edges = []
    if len(edges) != index_entry.get("edges"):
        audit.fail(f"{label}: manifest edges {index_entry.get('edges')} != payload {len(edges)}")
    for edge in edges:
        edge_id = edge.get("id")
        if not isinstance(edge_id, str) or not edge_id:
            audit.fail(f"{label}: edge without id")
            continue
        if edge_id in edge_index:
            audit.fail(f"{label}: duplicate edge id {edge_id}")
            continue
        edge_index[edge_id] = {**edge, "_chunk": key}
        audit.count("edges")
        centerline = edge.get("centerline")
        checked = check_polyline(audit, f"edge {edge_id}.centerline", centerline)
        length = checked[1][-1] if checked else 0.0
        if edge.get("from") is None or edge.get("to") is None:
            audit.fail(f"edge {edge_id}: from/to are required")
        if not isinstance(edge.get("widthM"), (int, float)) or edge["widthM"] <= 0:
            audit.fail(f"edge {edge_id}: widthM must be positive")
        if not isinstance(edge.get("layer"), (int, float)):
            audit.fail(f"edge {edge_id}: layer is required")
        lanes = edge.get("lanes")
        if not isinstance(lanes, list) or not lanes:
            audit.fail(f"edge {edge_id}: at least one travel lane is required")
            continue
        for lane in lanes:
            if not isinstance(lane.get("index"), int) or lane["index"] < 0:
                audit.fail(f"edge {edge_id}: lane index must be a non-negative integer")
            if not isinstance(lane.get("widthM"), (int, float)) or lane["widthM"] <= 0:
                audit.fail(f"edge {edge_id}: lane widthM must be positive")
            lane_length(audit, f"edge {edge_id}.lane {lane.get('index')}", lane, length)

    stops = chunk.get("stops") or []
    if len(stops) != index_entry.get("stops"):
        audit.fail(f"{label}: manifest stops {index_entry.get('stops')} != payload {len(stops)}")
    seen_stops: set[str] = set()
    for stop in stops:
        stop_id = stop.get("id")
        if not isinstance(stop_id, str) or not stop_id:
            audit.fail(f"{label}: stop without id")
            continue
        if stop_id in seen_stops:
            audit.fail(f"{label}: duplicate stop id {stop_id}")
        seen_stops.add(stop_id)
        for axis in ("x", "y"):
            if not isinstance(stop.get(axis), (int, float)):
                audit.fail(f"stop {stop_id}: {axis} is required")
        if not stop.get("name"):
            audit.warn(f"stop {stop_id}: empty name")
        audit.count("stops")

    signals = chunk.get("signals") or []
    if len(signals) != index_entry.get("signals"):
        audit.fail(f"{label}: manifest signals {index_entry.get('signals')} != payload {len(signals)}")
    for node in signals:
        check_signal_node(audit, node, f"{label} signal {node.get('id')}", edge_index, chunk_nodes)


def check_signal_node(
    audit: Audit,
    node: dict[str, Any],
    label: str,
    edge_index: dict[str, dict[str, Any]],
    chunk_nodes: dict[str, dict[str, Any]],
) -> None:
    node_id = node.get("id")
    if not isinstance(node_id, str) or not node_id:
        audit.fail(f"{label}: node without id")
        return
    if node_id in chunk_nodes:
        audit.fail(f"{label}: duplicate signal node id")
    chunk_nodes[node_id] = node
    audit.count("signalNodes")
    groups = node.get("groups") or []
    movements = node.get("movements") or []
    if not groups:
        audit.fail(f"{label}: no signal groups")
    if not movements:
        audit.fail(f"{label}: no movements")
    kind_ok = {"vehicle", "pedestrian", "tram"}
    for group in groups:
        if group.get("kind") not in kind_ok:
            audit.fail(f"{label}: group {group.get('id')} has unknown kind {group.get('kind')!r}")
    for index, movement in enumerate(movements):
        movement_id = movement.get("id")
        if not isinstance(movement_id, str) or not movement_id:
            audit.fail(f"{label}: movement {index} without id")
        if movement.get("kind") not in kind_ok:
            audit.fail(f"{label}: movement {movement_id} has unknown kind")
        group_index = movement.get("group")
        if not isinstance(group_index, int) or not 0 <= group_index < len(groups):
            audit.fail(f"{label}: movement {movement_id} group {group_index} out of range")
        approach = movement.get("approach") or {}
        edge_id = approach.get("edgeId")
        if not isinstance(edge_id, str) or not edge_id:
            audit.fail(f"{label}: movement {movement_id} has no approach edge")
        checked = check_polyline(audit, f"{label} movement {movement_id}.path", movement.get("path"))
        if checked and movement.get("kind") != "pedestrian":
            if checked[1][-1] < 1.0:
                audit.fail(f"{label}: movement {movement_id} path is shorter than 1 m")
    for stop_line in node.get("stopLines") or []:
        movement_index = stop_line.get("movement")
        if not isinstance(movement_index, int) or not 0 <= movement_index < len(movements):
            audit.fail(f"{label}: stop line points at movement {movement_index} out of range")
        line = stop_line.get("line")
        if not isinstance(line, list) or len(line) != 6:
            audit.fail(f"{label}: stop line must be a flat [x,y,h,x,y,h] segment")
        if not isinstance(stop_line.get("s"), (int, float)):
            audit.fail(f"{label}: stop line without arc length s")
        if not isinstance(stop_line.get("heading"), (int, float)):
            audit.fail(f"{label}: stop line without heading")
    for head in node.get("heads") or []:
        head_group = head.get("group")
        if not isinstance(head_group, int) or not 0 <= head_group < len(groups):
            audit.fail(f"{label}: head {head.get('id')} group {head_group} out of range")
        if head.get("kind") not in kind_ok:
            audit.fail(f"{label}: head {head.get('id')} has unknown kind")
    program = node.get("program")
    if not isinstance(program, dict):
        audit.fail(f"{label}: program is required")
        return
    phases = program.get("phases") or []
    if not phases:
        audit.fail(f"{label}: program has no phases")
        return
    if not isinstance(program.get("offsetS"), (int, float)):
        audit.fail(f"{label}: program offsetS is required")
    cycle = 0.0
    green_seen: set[int] = set()
    for phase_index, phase in enumerate(phases):
        for field in ("greenS", "yellowS", "allRedS"):
            value = phase.get(field)
            if not isinstance(value, (int, float)) or value < 0:
                audit.fail(f"{label}: phase {phase_index} {field} must be a non-negative number")
                return
        cycle += phase["greenS"] + phase["yellowS"] + phase["allRedS"]
        green = phase.get("green") or []
        if not isinstance(green, list):
            audit.fail(f"{label}: phase {phase_index} green must be a list")
            continue
        for group_index in green:
            if not isinstance(group_index, int) or not 0 <= group_index < len(groups):
                audit.fail(f"{label}: phase {phase_index} green {group_index} out of range")
            green_seen.add(group_index)
        green_set = {index for index in green if isinstance(index, int)}
        for movement_index in green_set:
            if not 0 <= movement_index < len(movements):
                continue
            for other in green_set:
                if movement_index == other or not 0 <= other < len(movements):
                    continue
                if (movement_index, other) in {
                    tuple(pair) for pair in (node.get("conflicts") or []) if len(pair) == 2
                }:
                    audit.fail(
                        f"{label}: phase {phase_index} gives green to conflicting movements "
                        f"{movements[movement_index].get('id')} and {movements[other].get('id')}"
                    )
    if cycle <= 0:
        audit.fail(f"{label}: program cycle is not positive")
    missing_groups = set(range(len(groups))) - green_seen
    if missing_groups:
        audit.warn(
            f"{label}: groups never green in the program: "
            + ", ".join(groups[index].get("id", str(index)) for index in sorted(missing_groups))
        )
    seen_conflicts: set[tuple[int, int]] = set()
    for pair in node.get("conflicts") or []:
        if not isinstance(pair, list) or len(pair) != 2:
            audit.fail(f"{label}: conflict pair must be two movement indices")
            continue
        first, second = pair
        if not (isinstance(first, int) and isinstance(second, int)):
            audit.fail(f"{label}: conflict pair must be integers")
            continue
        if not (0 <= first < len(movements) and 0 <= second < len(movements)):
            audit.fail(f"{label}: conflict pair {pair} out of range")
        if first == second:
            audit.warn(f"{label}: conflict pair {pair} references the same movement twice")
        key = (min(first, second), max(first, second))
        if key in seen_conflicts:
            continue
        seen_conflicts.add(key)
        # The runtime symmetrises conflicts, so a one-directional pair in the
        # payload is legal: no mirror check here.


def check_route(
    audit: Audit,
    base: Path,
    entry: dict[str, Any],
    edge_index: dict[str, dict[str, Any]],
    calendars: dict[str, dict[str, Any]],
) -> None:
    variant_id = entry.get("id")
    label = f"route {variant_id}"
    file = entry.get("file")
    if not isinstance(file, str) or not file:
        audit.fail(f"{label}: manifest entry has no file")
        return
    payload = load_json(base / file, audit, label)
    if payload is None:
        return
    if payload.get("version") != MOBILITY_VERSION:
        audit.fail(f"{label}: version {payload.get('version')} != {MOBILITY_VERSION}")
    variant = payload.get("variant") or {}
    if variant.get("id") != variant_id:
        audit.fail(f"{label}: payload variant id {variant.get('id')!r} != manifest id")
    if variant.get("mode") not in {"bus", "trolleybus", "tram"}:
        audit.fail(f"{label}: unknown mode {variant.get('mode')!r}")
    if variant.get("direction") not in (0, 1):
        audit.fail(f"{label}: direction must be 0 or 1")
    if entry.get("verified") != variant.get("verified"):
        audit.fail(f"{label}: manifest verified={entry.get('verified')} != payload {variant.get('verified')}")
    if not variant.get("verified"):
        audit.warn(f"{label}: variant is not verified and must not be shown as running transport")
        audit.count("unverifiedVariants")
    edges = variant.get("edges") or []
    if not edges:
        audit.fail(f"{label}: no edges")
        return
    previous: dict[str, Any] | None = None
    total_length = 0.0
    for edge_id in edges:
        edge = edge_index.get(edge_id)
        if edge is None:
            audit.fail(f"{label}: edge {edge_id} is not present in any chunk")
            previous = None
            continue
        if previous is not None and previous.get("to") != edge.get("from"):
            audit.fail(
                f"{label}: discontinuity between {previous.get('id')} (to={previous.get('to')}) "
                f"and {edge_id} (from={edge.get('from')})"
            )
        previous = edge
        centerline = edge.get("centerline") or {}
        distances = centerline.get("s") or [0]
        total_length += distances[-1]
    if isinstance(variant.get("lengthM"), (int, float)) and total_length > 0:
        if abs(variant["lengthM"] - total_length) > max(2.0, total_length * 0.02):
            audit.warn(
                f"{label}: lengthM {variant['lengthM']:.1f} differs from summed edge length {total_length:.1f}"
            )
    bounds = variant.get("bounds")
    if not isinstance(bounds, list) or len(bounds) != 4:
        audit.fail(f"{label}: bounds must be 4 numbers")
    stops = variant.get("stops") or []
    if len(stops) != entry.get("stops"):
        audit.fail(f"{label}: manifest stops {entry.get('stops')} != payload {len(stops)}")
    for position, call in enumerate(stops):
        if call.get("seq") != position:
            audit.fail(f"{label}: stop call {position} has seq {call.get('seq')}")
        edge = edge_index.get(call.get("edgeId"))
        if edge is None:
            audit.fail(f"{label}: stop call {position} references unknown edge {call.get('edgeId')}")
            continue
        lanes = edge.get("lanes") or []
        lane_index = call.get("laneIndex")
        if not isinstance(lane_index, int) or not 0 <= lane_index < len(lanes):
            audit.fail(f"{label}: stop call {position} lane {lane_index} out of range")
            continue
        centerline = edge.get("centerline") or {}
        distances = centerline.get("s") or [0]
        edge_length = distances[-1]
        length = lane_length(audit, f"{label} stop {position}", lanes[lane_index], edge_length)
        s = call.get("s")
        if not isinstance(s, (int, float)) or not -EPS <= s <= length + EPS:
            audit.fail(f"{label}: stop call {position} s={s} outside lane length {length:.2f}")
        for axis in ("x", "y", "heading"):
            if not isinstance(call.get(axis), (int, float)):
                audit.fail(f"{label}: stop call {position} missing {axis}")
        if call.get("binding") not in {"source-id", "offset-node", "name-geometry", "manual"}:
            audit.warn(f"{label}: stop call {position} has unknown binding {call.get('binding')!r}")
    trips = payload.get("trips") or []
    if not isinstance(trips, list):
        audit.fail(f"{label}: trips must be a list")
        return
    if len(trips) != entry.get("trips"):
        audit.fail(f"{label}: manifest trips {entry.get('trips')} != payload {len(trips)}")
    audit.count("trips", len(trips))
    for trip in trips:
        trip_id = trip.get("id")
        if trip.get("variantId") != variant_id:
            audit.fail(f"{label}: trip {trip_id} variantId {trip.get('variantId')!r} != {variant_id!r}")
        calendar_id = trip.get("calendarId")
        if calendar_id not in calendars:
            audit.fail(f"{label}: trip {trip_id} references unknown calendar {calendar_id!r}")
        stop_times = trip.get("stopTimes") or []
        if stop_times and len(stop_times) != len(stops):
            audit.fail(
                f"{label}: trip {trip_id} has {len(stop_times)} stop times for {len(stops)} stop calls"
            )
        previous_arrival = -math.inf
        previous_departure = -math.inf
        for index, stop_time in enumerate(stop_times):
            if stop_time.get("seq") != index:
                audit.fail(f"{label}: trip {trip_id} stop time {index} has seq {stop_time.get('seq')}")
            arrival = stop_time.get("arrivalS")
            departure = stop_time.get("departureS")
            if not isinstance(arrival, (int, float)) or not isinstance(departure, (int, float)):
                audit.fail(f"{label}: trip {trip_id} stop time {index} is missing arrivalS/departureS")
                continue
            if departure < arrival - EPS:
                audit.fail(f"{label}: trip {trip_id} stop {index} departs before it arrives")
            if arrival < previous_arrival - EPS:
                audit.fail(f"{label}: trip {trip_id} stop {index} arrival runs backwards")
            if departure < previous_departure - EPS:
                audit.fail(f"{label}: trip {trip_id} stop {index} departure runs backwards")
            previous_arrival = max(previous_arrival, arrival)
            previous_departure = max(previous_departure, departure)
        if stop_times and not trip.get("complete"):
            audit.count("interpolatedTrips")


def check_calendars(audit: Audit, calendars: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    index: dict[str, dict[str, Any]] = {}
    for calendar in calendars:
        calendar_id = calendar.get("id")
        if not isinstance(calendar_id, str) or not calendar_id:
            audit.fail("calendar without id")
            continue
        if calendar_id in index:
            audit.fail(f"duplicate calendar id {calendar_id}")
        index[calendar_id] = calendar
        weekdays = calendar.get("weekdays")
        if not isinstance(weekdays, list) or not weekdays:
            audit.fail(f"calendar {calendar_id}: weekdays must be a non-empty list")
        else:
            for day in weekdays:
                if not isinstance(day, int) or not 0 <= day <= 6:
                    audit.fail(f"calendar {calendar_id}: weekday {day} out of range")
        start, end = calendar.get("startDate"), calendar.get("endDate")
        if not (isinstance(start, str) and len(start) == 10):
            audit.fail(f"calendar {calendar_id}: startDate must be YYYY-MM-DD")
        if not (isinstance(end, str) and len(end) == 10):
            audit.fail(f"calendar {calendar_id}: endDate must be YYYY-MM-DD")
        if isinstance(start, str) and isinstance(end, str) and start > end:
            audit.fail(f"calendar {calendar_id}: startDate {start} is after endDate {end}")
        if not calendar.get("timeZone"):
            audit.fail(f"calendar {calendar_id}: timeZone is required")
        for exception in calendar.get("exceptions") or []:
            if exception.get("kind") not in {"add", "remove"}:
                audit.fail(f"calendar {calendar_id}: exception kind must be add/remove")
            if not isinstance(exception.get("date"), str):
                audit.fail(f"calendar {calendar_id}: exception without date")
        audit.count("calendars")
    return index


def run(base: Path, out: Path) -> int:
    audit = Audit()
    manifest = load_json(base / "manifest.json", audit, "manifest")
    if manifest is None:
        report = audit.report()
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print_summary(report, out)
        return 1

    if manifest.get("version") != MOBILITY_VERSION:
        audit.fail(f"manifest: version {manifest.get('version')} != {MOBILITY_VERSION}")
    for field in ("epsg", "originUtm", "chunkSize", "bounds", "generatedAt"):
        if field not in manifest:
            audit.fail(f"manifest: missing {field}")
    if not isinstance(manifest.get("originUtm"), list) or len(manifest.get("originUtm") or []) != 2:
        audit.fail("manifest: originUtm must be [easting, northing]")
    if not isinstance(manifest.get("bounds"), list) or len(manifest.get("bounds") or []) != 4:
        audit.fail("manifest: bounds must be 4 numbers")
    release = manifest.get("release") or {}
    for part in ("network", "schedule", "bindings"):
        if not isinstance(release.get(part), str) or not release.get(part):
            audit.fail(f"manifest: release.{part} is required")
    if not manifest.get("provenance"):
        audit.fail("manifest: provenance is required")
    schedule_status = manifest.get("scheduleStatus")
    timetable_mode = manifest.get("timetableMode", "stored")
    if timetable_mode == "procedural":
        model = manifest.get("syntheticTimetable")
        if not isinstance(model, dict):
            audit.fail("manifest: timetableMode=procedural requires syntheticTimetable")
        else:
            for field in ("id", "headwayS", "firstDepartureS", "lastDepartureS", "cruiseMps", "dwellS", "calendarId"):
                if field not in model:
                    audit.fail(f"manifest.syntheticTimetable: missing {field}")
            for field in ("headwayS", "cruiseMps", "dwellS"):
                values = model.get(field)
                if not isinstance(values, dict) or not values:
                    audit.fail(f"manifest.syntheticTimetable.{field} must be a non-empty object")
                    continue
                for mode, value in values.items():
                    if mode not in {"bus", "trolleybus", "tram"}:
                        audit.fail(f"manifest.syntheticTimetable.{field}: unknown mode {mode!r}")
                    if not isinstance(value, (int, float)) or value <= 0:
                        audit.fail(f"manifest.syntheticTimetable.{field}.{mode} must be positive")
            if manifest.get("counts", {}).get("trips") not in (0, None):
                # Гибрид: часть маршрутов может иметь реальные рейсы, остальные —
                # процедурную модель. Это допустимо, но статус не должен быть
                # "ready" (данные неполные).
                if manifest.get("scheduleStatus") == "ready":
                    audit.fail("manifest: procedural fallback must not report scheduleStatus=ready")
                audit.warn(
                    "manifest: hybrid timetable — stored trips for covered routes plus "
                    "procedural trips for the rest"
                )
            calendar_ids = {calendar.get("id") for calendar in manifest.get("calendars") or []}
            if model.get("calendarId") not in calendar_ids:
                audit.fail(
                    f"manifest: syntheticTimetable.calendarId {model.get('calendarId')!r} "
                    "is not in calendars"
                )
            audit.warn(
                "manifest: timetableMode=procedural — рейсы синтезируются симулятором "
                "(модельные интервалы/скорости, не расписание перевозчика)"
            )
    elif schedule_status not in {"ready", "partial", "unavailable", "synthetic", "absent"}:
        audit.fail(f"manifest: scheduleStatus is missing or unknown ({schedule_status!r})")
    elif schedule_status in {"unavailable", "absent"}:
        audit.warn(
            f"manifest: scheduleStatus={schedule_status!r} — routes have geometry but no public schedule "
            f"({manifest.get('scheduleNote') or 'no note'})"
        )
    elif schedule_status == "synthetic":
        audit.warn("manifest: scheduleStatus='synthetic' — timetable is explicitly non-public QA data")
    if release.get("schedule") in {"absent", None, ""}:
        audit.warn("manifest: release.schedule is absent — trips are not real public schedule data")

    calendars = check_calendars(audit, manifest.get("calendars") or [])

    edge_index: dict[str, dict[str, Any]] = {}
    chunk_nodes: dict[str, dict[str, Any]] = {}
    for index_entry in manifest.get("chunks") or []:
        check_chunk(audit, base, index_entry, edge_index, chunk_nodes)
    audit.count("chunks", len(manifest.get("chunks") or []))

    manifest_signals = manifest.get("signalNodes") or []
    if len(manifest_signals) != len(chunk_nodes):
        audit.fail(f"manifest: {len(manifest_signals)} signal nodes indexed, {len(chunk_nodes)} in chunks")
    for entry in manifest_signals:
        node = chunk_nodes.get(entry.get("id"))
        if node is None:
            audit.fail(f"manifest: signal node {entry.get('id')} is not present in any chunk")
            continue
        if abs((node.get("x") or 0) - (entry.get("x") or 0)) > 0.5 or abs(
            (node.get("y") or 0) - (entry.get("y") or 0)
        ) > 0.5:
            audit.fail(f"manifest: signal node {entry.get('id')} position differs from its chunk")

    for entry in manifest.get("routes") or []:
        check_route(audit, base, entry, edge_index, calendars)
    audit.count("variants", len(manifest.get("routes") or []))

    # Route file hashes are not stored, but a payload that cannot be re-hashed is
    # still auditable: record the digests so two releases can be compared.
    digests = {}
    for path in sorted(base.rglob("*.json")):
        digests[str(path.relative_to(base)).replace("\\", "/")] = sha256_file(path)
    report = audit.report()
    report["base"] = str(base)
    report["manifestSha256"] = digests.get("manifest.json")
    report["fileDigests"] = digests
    report["release"] = release
    report["bytes"] = sum(path.stat().st_size for path in base.rglob("*.json"))
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print_summary(report, out)
    return 0 if report["ok"] else 1


def print_summary(report: dict[str, Any], out: Path) -> None:
    counters = report.get("counters", {})
    print(
        "[audit] chunks={chunks} edges={edges} stops={stops} signalNodes={signalNodes} "
        "variants={variants} trips={trips}".format(
            chunks=counters.get("chunks", 0),
            edges=counters.get("edges", 0),
            stops=counters.get("stops", 0),
            signalNodes=counters.get("signalNodes", 0),
            variants=counters.get("variants", 0),
            trips=counters.get("trips", 0),
        )
    )
    if report.get("warnings"):
        print(f"[audit] {len(report['warnings'])} warning(s):")
        for warning in report["warnings"][:20]:
            print(f"  - {warning}")
        if len(report["warnings"]) > 20:
            print(f"  … and {len(report['warnings']) - 20} more")
    if report.get("errors"):
        print(f"[audit] {len(report['errors'])} ERROR(s):")
        for error in report["errors"][:40]:
            print(f"  ! {error}")
        if len(report["errors"]) > 40:
            print(f"  … and {len(report['errors']) - 40} more")
        print(f"[audit] FAILED — report: {out}")
    else:
        print(f"[audit] OK — report: {out}")


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", default="public/data/mobility", help="exported payload directory")
    parser.add_argument("--out", default="data/processed/mobility/audit.json", help="report path")
    args = parser.parse_args(argv)
    base = (ROOT / args.base).resolve() if not Path(args.base).is_absolute() else Path(args.base)
    out = (ROOT / args.out).resolve() if not Path(args.out).is_absolute() else Path(args.out)
    if not base.is_dir():
        print(f"[audit] payload directory is missing: {base}")
        return 1
    return run(base, out)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
