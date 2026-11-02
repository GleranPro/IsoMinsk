"""Unit tests for the road network normalization (payload 0.2.0).

Run with:
    .venv\\Scripts\\python.exe scripts/normalize/tests/test_road_network.py -v
or via:
    pnpm run test:data

The tests build synthetic local-metre ways (no OSM data needed) and cover the
rules documented in docs/ROAD_NETWORK.md: one-way aware widths, street-level
width/material canonicalization, the non-overlapping material partition,
junction boxes, crossings and medians.
"""

from __future__ import annotations

import math
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from shapely.geometry import LineString, box  # noqa: E402

import road_network as rn  # noqa: E402

PILOT = box(-1000, -1000, 1000, 1000)


def way(osm_id: int, coords, **tags) -> dict:
    return {
        "osm_type": "way",
        "osm_id": osm_id,
        "tags": {"highway": "residential", **tags},
        "line": LineString(coords),
    }


def build(ways, crossings=None, water=None):
    return rn.build_road_network(ways, crossings or [], PILOT, water or [])


class WidthModelTests(unittest.TestCase):
    def test_explicit_width_tag_wins(self):
        tags = {"width": "7.5", "lanes": "4"}
        self.assertAlmostEqual(rn.carriageway_width(tags, "primary", False, False), 7.5)

    def test_lanes_define_one_way_carriageway(self):
        tags = {"lanes": "4"}
        # 4 lanes x 3.0 m + 0.6 m shoulders; the old model returned 18 m here
        # (class default), which made every dual-carriageway half overlap.
        self.assertAlmostEqual(rn.carriageway_width(tags, "primary", True, False), 12.6)

    def test_lanes_define_two_way_carriageway(self):
        self.assertAlmostEqual(rn.carriageway_width({"lanes": "2"}, "primary", False, False), 6.6)

    def test_one_way_default_is_not_the_full_street(self):
        self.assertAlmostEqual(rn.carriageway_width({}, "primary", True, False), 9.5)
        self.assertAlmostEqual(rn.carriageway_width({}, "primary", False, False), 18.0)

    def test_path_width_is_clamped(self):
        self.assertAlmostEqual(rn.carriageway_width({"width": "0.5"}, "footway", False, True), 1.0)
        self.assertAlmostEqual(rn.carriageway_width({"width": "30"}, "footway", False, True), 10.0)

    def test_oneway_parsing(self):
        self.assertTrue(rn.parse_oneway({"oneway": "yes"}))
        self.assertTrue(rn.parse_oneway({"oneway": "-1"}))
        self.assertTrue(rn.parse_oneway({"junction": "roundabout"}))
        self.assertFalse(rn.parse_oneway({"oneway": "no"}))
        self.assertFalse(rn.parse_oneway({}))

    def test_material_mapping(self):
        self.assertEqual(rn.parse_material({"surface": "sett"})[0], "stone")
        self.assertEqual(rn.parse_material({"surface": "cobblestone"})[0], "stone")
        self.assertEqual(rn.parse_material({"surface": "paving_stones"})[0], "stone")
        self.assertEqual(rn.parse_material({"surface": "concrete:plates"})[0], "concrete")
        self.assertEqual(rn.parse_material({"surface": "compacted"})[0], "unpaved")
        self.assertEqual(rn.parse_material({"surface": "weird-new-value"})[0], "asphalt")
        self.assertEqual(rn.parse_material({}), (None, None))


class CanonicalizationTests(unittest.TestCase):
    def test_one_width_per_named_street(self):
        ways = [
            way(1, [(0, 0), (100, 0)], name="Test Street", lanes="2", surface="asphalt"),
            way(2, [(100, 0), (200, 0)], name="Test Street", surface="asphalt"),
        ]
        prepared, _ = rn.prepare_ways(ways, PILOT)
        rn.canonicalize(prepared)
        widths = {round(item.width, 2) for item in prepared}
        # Length-weighted median; with equal lengths the tagged (6.6 m) way wins.
        self.assertEqual(widths, {6.6})

    def test_explicit_material_runs_are_preserved(self):
        # Karl Marx Street shape: stone section + long asphalt continuation.
        ways = [
            way(1, [(0, 0), (150, 0)], name="Test Street", surface="sett"),
            way(2, [(150, 0), (1200, 0)], name="Test Street", surface="asphalt"),
        ]
        prepared, _ = rn.prepare_ways(ways, PILOT)
        rn.canonicalize(prepared)
        materials = {(item.osm_id, item.material) for item in prepared}
        self.assertEqual(materials, {(1, "stone"), (2, "asphalt")})

    def test_one_way_and_two_way_widths_are_grouped_separately(self):
        # Mixing both directions in one median made a 1-lane one-way section as
        # wide as a 4-lane two-way one (reported on Engels Street).
        ways = [
            way(1, [(0, 0), (100, 0)], name="Mixed Street", lanes="4", surface="asphalt"),
            way(2, [(0, 10), (100, 10)], name="Mixed Street", lanes="1", oneway="yes"),
            way(3, [(0, 20), (100, 20)], name="Mixed Street", lanes="1", oneway="yes"),
        ]
        prepared, _ = rn.prepare_ways(ways, PILOT)
        rn.canonicalize(prepared)
        widths = {item.osm_id: item.width for item in prepared}
        self.assertAlmostEqual(widths[1], 12.6)
        self.assertAlmostEqual(widths[2], 4.0)  # 1 lane clamped to the 4 m minimum
        self.assertAlmostEqual(widths[3], 4.0)

    def test_untagged_way_inherits_street_material(self):
        ways = [
            way(1, [(0, 0), (200, 0)], name="Test Street", surface="sett"),
            way(2, [(200, 0), (400, 0)], name="Test Street"),
            way(3, [(400, 0), (600, 0)], name="Test Street", surface="asphalt"),
        ]
        prepared, _ = rn.prepare_ways(ways, PILOT)
        rn.canonicalize(prepared)
        untagged = next(item for item in prepared if item.osm_id == 2)
        self.assertEqual(untagged.material, "asphalt")

    def test_near_duplicate_ways_are_dropped(self):
        ways = [
            way(1, [(0, 0), (100, 0)], name="Duplicate Street", lanes="2"),
            way(2, [(0, 0.2), (100, 0.2)], name="Duplicate Street", lanes="2"),
        ]
        prepared, _ = rn.prepare_ways(ways, PILOT)
        stats = rn.canonicalize(prepared)
        self.assertEqual(len(prepared), 1)
        self.assertEqual(stats["duplicates_dropped"], 1)

    def test_unnamed_ways_are_not_merged_into_one_street(self):
        ways = [
            way(1, [(0, 0), (50, 0)], service="yes"),
            way(2, [(300, 0), (350, 0)], service="yes"),
        ]
        prepared, _ = rn.prepare_ways(ways, PILOT)
        keys = {item.group for item in prepared}
        self.assertEqual(len(keys), 2)


class PartitionTests(unittest.TestCase):
    def test_material_zones_never_overlap_and_cover_the_surface(self):
        result = build(
            [
                way(1, [(0, -400), (0, 400)], highway="primary", surface="asphalt", lanes="4"),
                way(2, [(-400, 0), (400, 0)], highway="residential", surface="sett"),
            ]
        )
        zones = [item for item in result["surfaces"] if item["kind"] == "drivable"]
        self.assertTrue(zones)
        total = sum(item["geom"].area for item in zones)
        union = rn._union([item["geom"] for item in zones])
        self.assertAlmostEqual(total, union.area, places=3)
        materials = {item["material"] for item in zones}
        self.assertEqual(materials, {"asphalt", "stone"})
        # the big asphalt street owns the junction box
        junction_zone = max(
            (item for item in zones if item["geom"].contains(rn.Point(0, 0))),
            key=lambda item: item["geom"].area,
        )
        self.assertEqual(junction_zone["material"], "asphalt")

    def test_stone_street_meets_asphalt_at_a_shared_edge(self):
        result = build(
            [
                way(1, [(0, 0), (300, 0)], highway="primary", surface="asphalt", name="Ave"),
                way(2, [(300, 0), (600, 0)], highway="residential", surface="sett", name="Lane"),
            ]
        )
        zones = [item for item in result["surfaces"] if item["kind"] == "drivable"]
        asph = [item["geom"] for item in zones if item["material"] == "asphalt"]
        stone = [item["geom"] for item in zones if item["material"] == "stone"]
        self.assertTrue(asph and stone)
        overlap = rn._union(asph).intersection(rn._union(stone)).area
        self.assertLess(overlap, 0.5)


class JunctionTests(unittest.TestCase):
    def test_crossing_streets_create_one_junction_box(self):
        result = build(
            [
                way(1, [(0, -300), (0, 300)], highway="primary", name="North"),
                way(2, [(-300, 0), (300, 0)], highway="secondary", name="East"),
            ]
        )
        self.assertEqual(len(result["junctions"]), 1)
        junction = result["junctions"][0]
        self.assertGreaterEqual(junction["approaches"], 2)
        self.assertGreaterEqual(junction["radius"], 3.0)

    def test_parallel_same_name_ways_are_not_a_junction(self):
        result = build(
            [
                way(1, [(0, 0), (300, 0)], highway="primary", name="Ave", oneway="yes"),
                way(2, [(0, 12), (300, 12)], highway="primary", name="Ave", oneway="yes"),
            ]
        )
        self.assertEqual(result["junctions"], [])

    def test_bridge_way_does_not_create_a_ground_junction(self):
        result = build(
            [
                way(1, [(0, -300), (0, 300)], highway="primary", name="North"),
                way(2, [(-300, 0), (300, 0)], highway="secondary", name="East", bridge="yes"),
            ]
        )
        self.assertEqual(result["junctions"], [])


class CrossingTests(unittest.TestCase):
    def two_way_street(self):
        return {"road": way(1, [(0, -400), (0, 400)], highway="primary", name="Street", lanes="4")}

    def test_zebra_record_is_projected_onto_the_road(self):
        ways = [self.two_way_street()["road"]]
        result = build(ways, [{"osm_id": 11, "tags": {"highway": "crossing", "crossing": "zebra"}, "x": 3, "y": 10}])
        self.assertEqual(len(result["crossings"]), 1)
        crossing = result["crossings"][0]
        self.assertEqual(crossing["kind"], "zebra")
        self.assertAlmostEqual(crossing["x"], 0.0, places=1)
        self.assertGreater(crossing["width"], 0)

    def test_two_signal_nodes_on_one_crossing_are_merged(self):
        ways = [self.two_way_street()["road"]]
        result = build(
            ways,
            [
                {"osm_id": 11, "tags": {"highway": "traffic_signals"}, "x": -5, "y": 10},
                {"osm_id": 12, "tags": {"highway": "traffic_signals"}, "x": 5, "y": 12},
            ],
        )
        self.assertEqual(len(result["crossings"]), 1)
        self.assertEqual(result["crossings"][0]["kind"], "signals")

    def test_far_nodes_are_not_matched(self):
        ways = [self.two_way_street()["road"]]
        result = build(ways, [{"osm_id": 11, "tags": {"highway": "crossing"}, "x": 500, "y": 500}])
        self.assertEqual(result["crossings"], [])
        self.assertEqual(result["stats"]["crossing_unmatched"], 1)

    def test_unmarked_crossing_kind(self):
        ways = [self.two_way_street()["road"]]
        result = build(
            ways,
            [{"osm_id": 11, "tags": {"highway": "crossing", "crossing": "unmarked"}, "x": 0, "y": 0}],
        )
        self.assertEqual(result["crossings"][0]["kind"], "unmarked")

    def test_crossing_prefers_the_widest_carriageway_that_contains_it(self):
        # A crossing of a 9.6 m street must not snap to a 4 m service road that
        # happens to be classed higher and mapped next to it.
        ways = [
            way(1, [(0, -400), (0, 400)], highway="secondary", name="Wide", lanes="2"),
            way(2, [(12, -400), (12, 400)], highway="primary", name="Narrow", lanes="1", oneway="yes"),
        ]
        result = build(
            ways,
            [{"osm_id": 11, "tags": {"highway": "crossing", "crossing": "zebra"}, "x": 0.5, "y": 20}],
        )
        self.assertEqual(len(result["crossings"]), 1)
        crossing = result["crossings"][0]
        self.assertAlmostEqual(crossing["width"], 6.6, places=1)
        self.assertEqual(crossing["roadClass"], "secondary")


class MedianTests(unittest.TestCase):
    def test_near_coincident_opposite_one_way_pair_is_merged(self):
        # When the two directions practically touch, the network layer emits one
        # two-way corridor piece so the renderer paints a double solid centre
        # line (Independence Avenue, Pobediteley, Bogdanovicha) instead of two
        # one-way dash columns.
        result = build(
            [
                way(1, [(0, 0), (400, 0)], highway="primary", name="Ave", oneway="yes", lanes="2", surface="asphalt"),
                way(2, [(400, 6), (0, 6)], highway="primary", name="Ave", oneway="yes", lanes="2", surface="asphalt"),
            ]
        )
        roads = [piece for piece in result["network"] if piece["kind"] == "road"]
        self.assertEqual(len(roads), 1)
        merged = roads[0]
        self.assertFalse(merged.get("oneway"))
        self.assertTrue(merged.get("merged"))
        self.assertEqual(merged["lanes"], 4)
        self.assertGreater(merged["width"], 10.0)
        self.assertEqual(result["stats"].get("merged_pairs"), 1)
        self.assertEqual(result["stats"].get("merged_network_pieces"), 1)

    def test_paired_one_way_carriageways_get_a_median(self):
        # 20 m apart with 6.6 m carriageways leaves ~7.4 m between the inner
        # edges once the 3 m synthetic sidewalks are taken out.
        result = build(
            [
                way(1, [(0, 0), (400, 0)], highway="primary", name="Ave", oneway="yes", lanes="2", surface="asphalt"),
                # opposite direction of travel, like the two halves of a real
                # dual carriageway mapped as separate ways
                way(2, [(400, 20), (0, 20)], highway="primary", name="Ave", oneway="yes", lanes="2", surface="asphalt"),
            ]
        )
        median_pieces = [item for item in result["surfaces"] if item["kind"] == "median"]
        self.assertGreaterEqual(len(median_pieces), 1)
        self.assertGreater(sum(item["geom"].area for item in median_pieces), 100.0)

    def test_overlapping_same_street_pair_gets_no_median(self):
        result = build(
            [
                way(1, [(0, 0), (400, 0)], highway="primary", name="Ave", oneway="yes", lanes="2"),
                way(2, [(0, 4), (400, 4)], highway="primary", name="Ave", oneway="yes", lanes="2"),
            ]
        )
        median_pieces = [item for item in result["surfaces"] if item["kind"] == "median"]
        self.assertEqual(median_pieces, [])


class DeterminismTests(unittest.TestCase):
    def test_build_is_deterministic(self):
        ways = [
            way(1, [(0, -300), (0, 300)], highway="primary", name="North", lanes="4"),
            way(2, [(-300, 0), (300, 0)], highway="secondary", name="East", lanes="2", surface="sett"),
            way(3, [(-200, 100), (200, 100)], highway="residential", name="South"),
        ]
        nodes = [{"osm_id": 5, "tags": {"highway": "crossing"}, "x": 0, "y": 50}]
        first = build(ways, nodes)
        second = build(ways, nodes)
        for key in ("crossings", "junctions"):
            self.assertEqual(first[key], second[key])
        self.assertEqual(
            [(item["kind"], item.get("material"), round(item["geom"].area, 2)) for item in first["surfaces"]],
            [(item["kind"], item.get("material"), round(item["geom"].area, 2)) for item in second["surfaces"]],
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
