"""Тесты конвейера мобильности: без сети и без полного PBF.

Фикстуры маленькие и синтетические: узлы/ways/отношения собираются прямо в
тесте, поэтому проверяется логика, а не содержимое OSM. Запуск:

    .venv\\Scripts\\python.exe -m unittest discover -s scripts/mobility/tests -p "test_network*.py" -v
"""

from __future__ import annotations

import json
import math
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPT_DIR))
sys.path.insert(0, str(SCRIPT_DIR.parent))

import build_network as bn  # noqa: E402
import export as ex  # noqa: E402
import extract_network as en  # noqa: E402


# ---------------------------------------------------------------------------
# Синтетические фикстуры
# ---------------------------------------------------------------------------


def node(node_id: int, x: float, y: float, **tags) -> tuple[int, dict]:
    return node_id, {"x": x, "y": y, "lat": 0.0, "lon": 0.0, "tags": {k: str(v) for k, v in tags.items()}}


def way(way_id: int, node_ids: list[int], **tags) -> tuple[int, dict]:
    return way_id, {
        "id": way_id,
        "tags": {k: str(v) for k, v in tags.items()},
        "nodes": node_ids,
        "missingLocations": 0,
    }


def bus_relation(relation_id: int = 7001, stop_ids: tuple[int, ...] = ()) -> dict:
    members: list[dict] = [{"type": "w", "ref": 1001, "role": ""}]
    for stop_id in stop_ids:
        members.append({"type": "n", "ref": stop_id, "role": "stop"})
        members.append({"type": "n", "ref": stop_id + 5000, "role": "platform"})
    return {
        "relationId": relation_id,
        "direction": 0,
        "headSign": "B",
        "from": "A",
        "to": "B",
        "tags": {"route": "bus", "ref": "1", "name": "bus 1: A - B", "from": "A", "to": "B"},
        "members": members,
    }


def make_straight_fixture(
    stop_positions: tuple[float, ...] = (100.0, 200.0),
    bridge: bool = False,
    platform_offset: float = -8.0,
):
    """Прямой двухсторонний way длиной 300 м с остановками в узлах."""
    node_map: dict[int, dict] = dict([
        node(1, 0.0, 0.0),
        node(5000, 300.0, 0.0),
    ])
    way_nodes = [1]
    stop_ids: list[int] = []
    for index, position in enumerate(stop_positions):
        stop_id = 100 + index
        platform_id = stop_id + 5000
        node_map[stop_id] = node(stop_id, position, 0.0, public_transport="stop_position", name=f"stop{index}")[1]
        node_map[platform_id] = node(
            platform_id, position, platform_offset,
            public_transport="platform", name=f"stop{index}",
        )[1]
        way_nodes.append(stop_id)
        stop_ids.append(stop_id)
    way_nodes.append(5000)
    tags = {"highway": "secondary", "lanes": "2"}
    if bridge:
        tags.update({"bridge": "yes", "layer": "1"})
    way_map = dict([way(1001, way_nodes, **tags)])
    relation = bus_relation(stop_ids=tuple(stop_ids))
    corridor = {"mode": "bus", "ref": "1", "variants": [relation]}
    raw = {"corridors": [corridor], "signals": [], "crossings": [], "stops": []}
    heights = {100: (3.0, "deck-tiles")} if bridge else {}
    sampler = bn.DeckSampler([], {})
    built = bn.build_variant(corridor, relation, raw, way_map, node_map, heights, sampler)
    return {
        "raw": raw,
        "ways": way_map,
        "nodes": node_map,
        "corridor": corridor,
        "relation": relation,
        "built": built,
    }


def synthetic_network(fixture: dict) -> dict:
    built = fixture["built"]
    variant = built["variant"]
    stops = []
    for stop_id in fixture["relation"]["members"]:
        if stop_id["type"] != "n" or not stop_id["role"].startswith("stop"):
            continue
        record = fixture["nodes"][stop_id["ref"]]
        stops.append({
            "id": f"s:osm:{stop_id['ref']}",
            "name": record["tags"].get("name", ""),
            "modes": ["bus"],
            "x": round(record["x"], 3),
            "y": round(record["y"], 3),
            "osmIds": [stop_id["ref"]],
        })
    return {
        "version": 1,
        "generatedAt": "2026-01-01T00:00:00Z",
        "epsg": 32635,
        "originUtm": [536859.254, 5972786.284],
        "bounds": [-10.0, -10.0, 310.0, 10.0],
        "stops": stops,
        "edges": built["edges"],
        "variants": [variant],
        "signals": [],
        "source": {
            "pbf": "synthetic",
            "pbfSha256": "0" * 64,
            "replicationTimestamp": "2026-01-01T00:00:00Z",
            "attribution": "synthetic fixture",
        },
    }


def synthetic_edge(
    edge_id: str,
    from_ref: str,
    to_ref: str,
    start: tuple[float, float],
    end: tuple[float, float],
    *,
    layer: int = 0,
    bridge: bool = False,
    mode: str = "bus",
    height: float = 0.0,
) -> dict:
    centerline = bn.make_polyline([[start[0], start[1], height], [end[0], end[1], height]])
    lane = {
        "index": 0,
        "offset": 0.0,
        "widthM": 3.25,
        "centerline": bn.make_polyline([[start[0], start[1], height], [end[0], end[1], height]]),
    }
    edge = {
        "id": edge_id,
        "wayId": abs(hash(edge_id)) % 10**6,
        "from": from_ref,
        "to": to_ref,
        "modes": [mode],
        "oneway": mode == "tram",
        "layer": layer,
        "widthM": 3.25,
        "centerline": centerline,
        "lanes": [lane],
        "next": [],
    }
    if bridge:
        edge["bridge"] = True
    return edge


def network_with_edges(edges: list[dict], variant_edges: list[str], stops: list[dict] | None = None) -> dict:
    edge_map = {edge["id"]: edge for edge in edges}
    calls = []
    for seq, stop in enumerate(stops or []):
        call_edge = edge_map[variant_edges[0]]
        point = bn.sample_polyline(call_edge["lanes"][0]["centerline"], 0.0)
        calls.append({
            "seq": seq,
            "stopId": stop["id"],
            "edgeId": call_edge["id"],
            "laneIndex": 0,
            "s": 0.0,
            "heading": 0.0,
            "x": round(point[0], 3),
            "y": round(point[1], 3),
            "h": round(point[2], 3),
            "dwellS": 20.0,
            "timed": False,
            "binding": "source-id",
        })
    variant = {
        "id": "r:1:0:1",
        "mode": "bus",
        "ref": "1",
        "headSign": "B",
        "direction": 0,
        "edges": list(variant_edges),
        "stops": calls,
        "lengthM": 1.0,
        "sourceRelationId": 1,
        "verified": True,
        "bounds": [0.0, 0.0, 1.0, 1.0],
        "issues": [],
    }
    return {
        "version": 1,
        "generatedAt": "2026-01-01T00:00:00Z",
        "epsg": 32635,
        "originUtm": [0.0, 0.0],
        "bounds": [0.0, 0.0, 100.0, 100.0],
        "stops": stops or [],
        "edges": edges,
        "variants": [variant],
        "signals": [],
        "source": {"pbf": "synthetic", "pbfSha256": "0" * 64},
    }


# ---------------------------------------------------------------------------
# 1. Склейка: непрерывность, реверс, разрыв
# ---------------------------------------------------------------------------


class ChainAssemblyTests(unittest.TestCase):
    def test_reverses_way_by_node_ids(self) -> None:
        nodes = dict([node(1, 0.0, 0.0), node(2, 50.0, 0.0), node(3, 50.0, 30.0)])
        ways = dict([
            way(10, [1, 2], highway="secondary"),
            way(11, [3, 2], highway="secondary"),
        ])
        chain = en.assemble_chain([10, 11], ways, nodes)
        self.assertEqual(chain["gaps"], [])
        self.assertEqual(chain["chainNodes"], [1, 2, 3])
        self.assertEqual(chain["segments"][0]["reversed"], False)
        self.assertEqual(chain["segments"][1]["reversed"], True)

    def test_gap_is_recorded_not_glued(self) -> None:
        nodes = dict([
            node(1, 0.0, 0.0),
            node(2, 50.0, 0.0),
            node(3, 500.0, 0.0),
            node(4, 550.0, 0.0),
        ])
        ways = dict([
            way(10, [1, 2], highway="secondary"),
            way(11, [3, 4], highway="secondary"),
        ])
        chain = en.assemble_chain([10, 11], ways, nodes)
        self.assertEqual(len(chain["gaps"]), 1)
        self.assertEqual(chain["gaps"][0]["wayId"], 11)
        self.assertGreater(chain["gaps"][0]["distanceM"], 400.0)
        # Разрыв не «склеен» выдуманной линией: вершины остались исходными.
        self.assertEqual(chain["chainNodes"], [1, 2, 3, 4])


# ---------------------------------------------------------------------------
# 2. Полосы: mitre, ограничение на острых углах, ширина
# ---------------------------------------------------------------------------


class LaneGeometryTests(unittest.TestCase):
    def test_mitre_is_clamped_on_sharp_corner(self) -> None:
        coords = [(0.0, 0.0), (100.0, 0.0), (100.0, 100.0)]
        offset = -4.0
        shifted = bn.offset_polyline(coords, offset, mitre_limit=2.0)
        self.assertEqual(len(shifted), 3)
        corner = shifted[1]
        # Внутренний угол: смещение не должно превышать mitre_limit * |offset|.
        distance = math.hypot(corner[0] - 100.0, corner[1] - 0.0)
        self.assertLessEqual(distance, 2.0 * abs(offset) + 1e-6)
        self.assertGreater(distance, abs(offset) - 1e-6)
        # Концы смещены строго по нормали на |offset|.
        self.assertAlmostEqual(shifted[0][1], offset, places=6)
        self.assertAlmostEqual(shifted[-1][0], 100.0 - offset, places=6)

    def test_u_turn_does_not_explode(self) -> None:
        coords = [(0.0, 0.0), (50.0, 0.0), (0.0, 0.5)]
        shifted = bn.offset_polyline(coords, 3.0, mitre_limit=1.5)
        for x, y in shifted:
            self.assertTrue(math.isfinite(x) and math.isfinite(y))
        distance = math.hypot(shifted[1][0] - 50.0, shifted[1][1] - 0.0)
        self.assertLessEqual(distance, 1.5 * 3.0 + 1e-6)

    def test_two_way_lanes_lie_on_the_right_of_travel(self) -> None:
        plan = bn.lane_plan({"highway": "secondary", "lanes": "4"}, "bus", "f")
        self.assertEqual(plan["lanes"], 2)
        edge_xy = [(0.0, 0.0), (100.0, 0.0)]
        heights = [0.0, 0.0]
        lanes = bn.build_lanes(edge_xy, heights, plan, "bus")
        self.assertEqual([lane["index"] for lane in lanes], [0, 1])
        self.assertTrue(all(lane["offset"] < 0 for lane in lanes))
        self.assertGreater(lanes[0]["offset"], lanes[1]["offset"])
        for lane in lanes:
            self.assertAlmostEqual(lane["widthM"], plan["laneWidthM"], places=6)
            length = bn.polyline_length(lane["centerline"])
            self.assertAlmostEqual(length, 100.0, delta=0.5)

    def test_tram_lane_is_the_track(self) -> None:
        plan = bn.lane_plan({"railway": "tram", "oneway": "yes"}, "tram", "f")
        lanes = bn.build_lanes([(0.0, 0.0), (100.0, 0.0)], [0.0, 0.0], plan, "tram")
        self.assertEqual(len(lanes), 1)
        self.assertEqual(lanes[0]["offset"], 0.0)


# ---------------------------------------------------------------------------
# 3. Привязка остановки к стороне и полосе
# ---------------------------------------------------------------------------


class StopBindingTests(unittest.TestCase):
    def test_stop_binds_to_right_lane_and_right_side(self) -> None:
        fixture = make_straight_fixture(platform_offset=-8.0)
        built = fixture["built"]
        variant = built["variant"]
        self.assertTrue(variant["verified"], variant["issues"])
        self.assertEqual(len(variant["stops"]), 2)
        first = variant["stops"][0]
        edge = {edge["id"]: edge for edge in built["edges"]}[first["edgeId"]]
        self.assertEqual(first["laneIndex"], len(edge["lanes"]) - 1)
        # Кузов стоит на полосе справа от осевой (offset полосы < 0).
        lane = edge["lanes"][first["laneIndex"]]
        self.assertLess(lane["offset"], 0.0)
        sampled = bn.sample_polyline(lane["centerline"], first["s"])
        self.assertAlmostEqual(first["x"], sampled[0], places=3)
        self.assertAlmostEqual(first["y"], sampled[1], places=3)
        side = built["sideDetails"][0]
        self.assertEqual(side["side"], "right")

    def test_stop_with_platform_on_left_is_flagged(self) -> None:
        fixture = make_straight_fixture(platform_offset=+8.0)
        variant = fixture["built"]["variant"]
        self.assertFalse(variant["verified"])
        self.assertTrue(any(issue.startswith("stop-wrong-side") for issue in variant["issues"]))


# ---------------------------------------------------------------------------
# 4. Уровни: мост и дорога под ним не соединяются по близости
# ---------------------------------------------------------------------------


class LevelSeparationTests(unittest.TestCase):
    def test_proximity_join_is_reported(self) -> None:
        bridge = synthetic_edge("e:bridge:f", "n:1", "n:2", (0.0, 0.0), (100.0, 0.0), layer=1, bridge=True)
        ground = synthetic_edge("e:under:f", "n:3", "n:4", (100.0, 0.0), (100.0, 100.0), layer=0)
        network = network_with_edges([bridge, ground], ["e:bridge:f", "e:under:f"])
        problems = bn.validate_network(network)
        self.assertTrue(any("!=" in problem for problem in problems), problems)

    def test_same_node_ramp_keeps_levels(self) -> None:
        bridge = synthetic_edge("e:bridge:f", "n:1", "n:2", (0.0, 0.0), (100.0, 0.0), layer=1, bridge=True, height=3.0)
        ground = synthetic_edge("e:ground:f", "n:2", "n:3", (100.0, 0.0), (200.0, 0.0), layer=0)
        network = network_with_edges([bridge, ground], ["e:bridge:f", "e:ground:f"])
        self.assertEqual(bn.validate_network(network), [])
        exported_bridge = next(edge for edge in network["edges"] if edge["id"] == "e:bridge:f")
        self.assertEqual(exported_bridge["layer"], 1)
        self.assertTrue(exported_bridge["bridge"])


# ---------------------------------------------------------------------------
# 5. Сигналы: конфликтующие движения не получают зелёный одновременно
# ---------------------------------------------------------------------------


def make_signal_fixture() -> dict:
    """Перекрёсток: два сквозных движения под 90° + пешеходный переход."""
    def lane_from(start, end):
        return bn.make_polyline([[start[0], start[1], 0.0], [end[0], end[1], 0.0]])

    def edge(edge_id, from_ref, to_ref, start, end, next_ids=()):
        polyline = lane_from(start, end)
        return {
            "id": edge_id,
            "wayId": abs(hash(edge_id)) % 10**6,
            "from": from_ref,
            "to": to_ref,
            "modes": ["bus"],
            "oneway": False,
            "layer": 0,
            "widthM": 3.5,
            "centerline": polyline,
            "lanes": [{"index": 0, "offset": 0.0, "widthM": 3.5, "centerline": polyline}],
            "next": list(next_ids),
        }

    approach_a = edge("e:a:f", "n:a0", "n:j", (0.0, 100.0), (0.0, 0.0), ("e:a2:f",))
    exit_a = edge("e:a2:f", "n:j", "n:a1", (0.0, 0.0), (0.0, -100.0))
    approach_b = edge("e:b:f", "n:b0", "n:j", (100.0, 0.0), (0.0, 0.0), ("e:b2:f",))
    exit_b = edge("e:b2:f", "n:j", "n:b1", (0.0, 0.0), (-100.0, 0.0))
    variants = {"v": {"edges": [approach_a, exit_a, approach_b, exit_b]}}
    lanes = []
    for edge_record in (approach_a, approach_b):
        lane = edge_record["lanes"][0]
        from shapely.geometry import LineString

        lanes.append((
            "v",
            edge_record,
            0,
            lane,
            LineString([(lane["centerline"]["p"][0], lane["centerline"]["p"][1]),
                        (lane["centerline"]["p"][3], lane["centerline"]["p"][4])]),
        ))
    representative = {"osmId": 900, "x": 0.0, "y": 0.0}
    crossings = [{"x": 0.0, "y": 0.0, "osmId": 901}]
    node = bn.build_signal_node(
        0.0, 0.0, representative, [{"osmId": 900, "x": 0.0, "y": 0.0}], [0], lanes,
        crossings, variants,
    )
    return {"node": node, "variants": variants}


class SignalProgramTests(unittest.TestCase):
    def test_conflicts_never_share_green(self) -> None:
        fixture = make_signal_fixture()
        node = fixture["node"]
        self.assertIsNotNone(node)
        self.assertGreaterEqual(len(node["movements"]), 2)
        self.assertTrue(node["conflicts"], "perpendicular movements must conflict")
        phase_of = {}
        for index, phase in enumerate(node["program"]["phases"]):
            self.assertTrue(phase["green"], "empty green phase")
            for group_index in phase["green"]:
                self.assertNotIn(group_index, phase_of)
                phase_of[group_index] = index
        self.assertEqual(set(phase_of), set(range(len(node["groups"]))))
        for first, second in node["conflicts"]:
            first_group = node["movements"][first]["group"]
            second_group = node["movements"][second]["group"]
            self.assertNotEqual(phase_of[first_group], phase_of[second_group])
        for line in node["stopLines"]:
            approach = node["movements"][line["movement"]]["approach"]
            self.assertGreaterEqual(line["s"], 0.0)
            self.assertEqual(line["edgeId"], approach["edgeId"])


# ---------------------------------------------------------------------------
# 6. Валидация контракта
# ---------------------------------------------------------------------------


class ContractValidationTests(unittest.TestCase):
    def valid_network(self) -> dict:
        first = synthetic_edge("e:1:f", "n:1", "n:2", (0.0, 0.0), (50.0, 0.0))
        second = synthetic_edge("e:2:f", "n:2", "n:3", (50.0, 0.0), (100.0, 0.0))
        stop = {"id": "s:osm:2", "name": "stop", "modes": ["bus"], "x": 50.0, "y": 0.0, "osmIds": [2]}
        return network_with_edges([first, second], ["e:1:f", "e:2:f"], [stop])

    def test_valid_network_passes(self) -> None:
        self.assertEqual(bn.validate_network(self.valid_network()), [])

    def test_broken_stop_sequence_fails(self) -> None:
        network = self.valid_network()
        network["variants"][0]["edges"] = ["e:2:f", "e:1:f"]
        problems = bn.validate_network(network)
        self.assertTrue(any("!=" in problem for problem in problems), problems)

    def test_stop_outside_lane_fails(self) -> None:
        network = self.valid_network()
        network["variants"][0]["stops"][0]["s"] = 999.0
        problems = bn.validate_network(network)
        self.assertTrue(any("outside lane" in problem for problem in problems), problems)

    def test_stop_off_lane_fails(self) -> None:
        network = self.valid_network()
        network["variants"][0]["stops"][0]["y"] = 12.0
        problems = bn.validate_network(network)
        self.assertTrue(any("off its lane" in problem for problem in problems), problems)

    def test_wrong_version_fails(self) -> None:
        network = self.valid_network()
        network["version"] = 99
        problems = bn.validate_network(network)
        self.assertTrue(any("MOBILITY_VERSION" in problem for problem in problems), problems)


# ---------------------------------------------------------------------------
# 7. Экспорт: детерминизм, chunk-разметка, слияние расписания
# ---------------------------------------------------------------------------


class ExportTests(unittest.TestCase):
    def setUp(self) -> None:
        fixture = make_straight_fixture()
        self.network = synthetic_network(fixture)
        self.original_sha = ex._NETWORK_SHA256
        ex._NETWORK_SHA256 = "a" * 64
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.addCleanup(setattr, ex, "_NETWORK_SHA256", self.original_sha)

    def export_once(self, out_dir: Path, schedule=None, schedule_version="absent"):
        edges, variants, stops, signals = ex.prepare_network(self.network)
        manifest, report, route_files, chunk_texts, warnings = ex.build_payload(
            self.network, edges, variants, stops, signals, schedule, schedule_version
        )
        chunks = [json.loads(text) for text in chunk_texts.values()]
        problems = ex.validate_payload(manifest, chunks, route_files)
        hashes = ex.write_payload(out_dir, manifest, chunk_texts, route_files)
        return manifest, hashes, problems, warnings

    def test_export_is_deterministic(self) -> None:
        first_dir = Path(self.tmp.name) / "one"
        second_dir = Path(self.tmp.name) / "two"
        first_manifest, first_hashes, problems, _ = self.export_once(first_dir)
        second_manifest, second_hashes, problems2, _ = self.export_once(second_dir)
        self.assertEqual(problems, [])
        self.assertEqual(problems2, [])
        self.assertEqual(first_hashes, second_hashes)
        for file in ("manifest.json",):
            self.assertEqual(
                (first_dir / file).read_bytes(),
                (second_dir / file).read_bytes(),
            )
        self.assertEqual(first_manifest["release"]["schedule"], "absent")
        self.assertEqual(first_manifest["counts"]["trips"], 0)

    def test_chunks_own_objects_and_round_to_cm(self) -> None:
        out_dir = Path(self.tmp.name) / "chunks"
        manifest, _, problems, _ = self.export_once(out_dir)
        self.assertEqual(problems, [])
        seen_edges: set[str] = set()
        for entry in manifest["chunks"]:
            chunk = json.loads((out_dir / entry["file"]).read_text(encoding="utf-8"))
            self.assertEqual(chunk["key"], entry["key"])
            self.assertEqual(chunk["bounds"], entry["bounds"])
            for edge in chunk["edges"]:
                self.assertNotIn(edge["id"], seen_edges)
                seen_edges.add(edge["id"])
                length = ex.polyline_length(edge["centerline"])
                anchor_x, anchor_y, _, _ = ex.sample_polyline(edge["centerline"], length / 2.0)
                self.assertEqual(ex.chunk_key_for(anchor_x, anchor_y), entry["key"])
                for value in edge["centerline"]["p"]:
                    self.assertAlmostEqual(value * 100.0, round(value * 100.0), places=6)
        self.assertEqual(len(seen_edges), manifest["counts"]["edges"])

    def test_schedule_trips_are_merged(self) -> None:
        variant = self.network["variants"][0]
        schedule = {
            "timeZone": "Europe/Minsk",
            "calendars": [{
                "id": "cal:weekday",
                "startDate": "2026-01-01",
                "endDate": "2026-12-31",
                "weekdays": [1, 2, 3, 4, 5],
                "timeZone": "Europe/Minsk",
            }],
            "routes": [{
                "mode": "bus",
                "ref": "1",
                "direction": 0,
                "headSign": "B",
                "stops": [
                    {"seq": call["seq"], "name": "", "x": call["x"], "y": call["y"], "timed": True}
                    for call in variant["stops"]
                ],
                "trips": [{
                    "sourceTripId": "42",
                    "calendarId": "cal:weekday",
                    "complete": True,
                    "stopTimes": [
                        {"seq": call["seq"], "arrivalS": 20000 + call["seq"] * 120,
                         "departureS": 20030 + call["seq"] * 120}
                        for call in variant["stops"]
                    ],
                }],
            }],
        }
        out_dir = Path(self.tmp.name) / "schedule"
        manifest, _, problems, _ = self.export_once(out_dir, schedule, "s" * 64)
        self.assertEqual(problems, [])
        self.assertEqual(manifest["release"]["schedule"], "s" * 64)
        self.assertEqual(manifest["counts"]["trips"], 1)
        route_file = out_dir / manifest["routes"][0]["file"]
        route = json.loads(route_file.read_text(encoding="utf-8"))
        self.assertEqual(len(route["trips"]), 1)
        self.assertEqual(route["trips"][0]["id"], "t:42")
        self.assertEqual(route["trips"][0]["calendarId"], "cal:weekday")
        self.assertEqual([item["seq"] for item in route["trips"][0]["stopTimes"]],
                         [call["seq"] for call in variant["stops"]])


if __name__ == "__main__":
    unittest.main()
