"""Unit tests for the ground strokes of the raster compositor (payload 0.4.0).

Run with:
    .venv\\Scripts\\python.exe scripts/normalize/tests/test_ground_strokes.py -v
or via:
    pnpm run test:data
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from shapely.geometry import LineString, box  # noqa: E402

import ground_strokes as gs  # noqa: E402
import road_network as rn  # noqa: E402

PILOT = box(-1000, -1000, 1000, 1000)


def way(osm_id: int, coords, **tags) -> dict:
    return {
        "osm_type": "way",
        "osm_id": osm_id,
        "tags": {"highway": "residential", **tags},
        "line": LineString(coords),
    }


def strokes_of(ways):
    return rn.build_road_network(ways, [], PILOT, [])["ground_strokes"]


def by_id(strokes, osm_id):
    return [s for s in strokes if s.get("id") == osm_id]


class StrokeEmissionTests(unittest.TestCase):
    def test_every_surface_way_is_one_stroke_including_links_and_service(self):
        strokes = strokes_of([
            way(1, [(0, -200), (0, 200)], highway="primary", name="Main", lanes="4"),
            way(2, [(0, 0), (150, 0)], highway="service"),
            way(3, [(0, 50), (60, 120)], highway="primary_link", oneway="yes"),
            way(4, [(-100, -100), (-100, 100)], highway="footway"),
            way(5, [(-50, -100), (-50, 100)], highway="cycleway"),
        ])
        for osm_id in (1, 2, 3, 4, 5):
            self.assertEqual(len(by_id(strokes, osm_id)), 1, osm_id)
        kinds = {s["id"]: s["k"] for s in strokes}
        self.assertEqual(kinds[1], "road")
        self.assertEqual(kinds[2], "road")
        self.assertEqual(kinds[4], "path")
        self.assertEqual(kinds[5], "cycle")
        self.assertEqual(by_id(strokes, 3)[0].get("ln"), 1)

    def test_width_follows_the_lane_model(self):
        stroke = by_id(strokes_of([
            way(1, [(0, -200), (0, 200)], highway="primary", name="Main", lanes="4"),
        ]), 1)[0]
        self.assertAlmostEqual(stroke["w"], rn.carriageway_width({"lanes": "4"}, "primary", False, False))
        self.assertEqual(stroke["lf"] + stroke["lb"], 4)

    def test_underground_ways_are_not_painted(self):
        strokes = strokes_of([
            way(1, [(0, -200), (0, 200)], highway="primary", name="Main"),
            way(2, [(50, -200), (50, 200)], highway="footway", layer="-1"),
            way(3, [(80, -200), (80, 200)], highway="footway", covered="yes"),
        ])
        self.assertEqual(by_id(strokes, 2), [])
        self.assertEqual(by_id(strokes, 3), [])

    def test_major_class_ranks_above_minor_class(self):
        strokes = strokes_of([
            way(1, [(0, -200), (0, 200)], highway="primary", name="Main"),
            way(2, [(-200, 0), (200, 0)], highway="residential", name="Side"),
        ])
        self.assertGreater(by_id(strokes, 1)[0]["r"], by_id(strokes, 2)[0]["r"])


class SidewalkTests(unittest.TestCase):
    def test_default_sidewalk_on_both_sides(self):
        stroke = by_id(strokes_of([
            way(1, [(0, -200), (0, 200)], highway="secondary", name="Main"),
        ]), 1)[0]
        self.assertEqual(stroke["sw"], [3.0, 3.0])

    def test_sidewalk_separate_and_no_suppress_the_band(self):
        strokes = strokes_of([
            way(1, [(0, -200), (0, 200)], highway="secondary", name="A", sidewalk="separate"),
            way(2, [(100, -200), (100, 200)], highway="secondary", name="B", sidewalk="right"),
        ])
        self.assertNotIn("sw", by_id(strokes, 1)[0])
        self.assertEqual(by_id(strokes, 2)[0]["sw"], [0.0, 3.0])

    def test_mapped_footway_sidewalk_suppresses_that_side_only(self):
        # Road runs north; +x is its right-hand side.
        strokes = strokes_of([
            way(1, [(0, -200), (0, 200)], highway="secondary", name="Main", lanes="2"),
            way(2, [(8, -200), (8, 200)], highway="footway", footway="sidewalk"),
        ])
        self.assertEqual(by_id(strokes, 1)[0]["sw"], [3.0, 0.0])

    def test_inner_side_of_a_dual_carriageway_gets_no_sidewalk(self):
        # Right-hand traffic: northbound on the east, southbound on the west.
        strokes = strokes_of([
            way(1, [(8, -300), (8, 300)], highway="primary", name="Ave", oneway="yes", lanes="2"),
            way(2, [(-8, 300), (-8, -300)], highway="primary", name="Ave", oneway="yes", lanes="2"),
        ])
        for osm_id in (1, 2):
            sw = by_id(strokes, osm_id)[0]["sw"]
            self.assertEqual(sw[0], 0.0, f"way {osm_id} inner (left) side")
            self.assertGreater(sw[1], 0.0, f"way {osm_id} outer (right) side")


class JunctionTrimTests(unittest.TestCase):
    def test_t_junction_trims_lane_paint_on_every_approach(self):
        strokes = strokes_of([
            way(1, [(0, -200), (0, 0), (0, 200)], highway="primary", name="Main", lanes="4"),
            way(2, [(0, 0), (200, 0)], highway="secondary", name="Side", lanes="2"),
        ])
        main = by_id(strokes, 1)[0]
        side = by_id(strokes, 2)[0]
        # Main: one interval around s=200 that clears the 6.6 m side street.
        self.assertEqual(len(main["nj"]), 2)
        a, b = main["nj"]
        self.assertLess(a, 200.0)
        self.assertGreater(b, 200.0)
        self.assertGreaterEqual(200.0 - a, 6.6 / 2)
        # Side: starts at the junction, trimmed by at least half the main width.
        self.assertEqual(side["nj"][0], 0.0)
        self.assertGreaterEqual(side["nj"][1], 12.6 / 2)

    def test_plain_continuation_is_not_a_junction(self):
        strokes = strokes_of([
            way(1, [(0, -200), (0, 0)], highway="primary", name="Main"),
            way(2, [(0, 0), (0, 200)], highway="primary", name="Main"),
        ])
        self.assertNotIn("nj", by_id(strokes, 1)[0])
        self.assertNotIn("nj", by_id(strokes, 2)[0])


class TileAssignmentTests(unittest.TestCase):
    def test_strokes_are_clipped_with_margin_and_keep_arc_phase(self):
        stroke = {"k": "road", "c": "primary", "w": 10.0, "p": [-300.0, 10.0, 900.0, 10.0], "s0": 0.0, "r": 20}
        tiles = gs.assign_strokes_to_tiles([stroke], 512.0, [(0, 0), (1, 0), (-1, 0)], 64.0)
        mid = tiles[(0, 0)][0]
        # Clipped to [-64, 576] in x; the clip start sits 236 m along the way.
        self.assertAlmostEqual(mid["p"][0], -64.0, places=2)
        self.assertAlmostEqual(mid["p"][2], 576.0, places=2)
        self.assertAlmostEqual(mid["s0"], 236.0, places=2)
        east = tiles[(1, 0)][0]
        self.assertAlmostEqual(east["s0"], 512.0 - 64.0 + 300.0, places=2)
        # A stroke fully inside the grown rect is passed through untouched.
        self.assertIs(tiles[(-1, 0)][0]["p"][0] == -300.0, True)

    def test_far_strokes_are_not_assigned(self):
        stroke = {"k": "path", "c": "footway", "w": 2.0, "p": [2000.0, 0.0, 2100.0, 0.0], "s0": 0.0, "r": 0}
        tiles = gs.assign_strokes_to_tiles([stroke], 512.0, [(0, 0)], 64.0)
        self.assertEqual(tiles[(0, 0)], [])


if __name__ == "__main__":
    unittest.main(verbosity=2)


def road_record(osm_id, coords, width, **extra):
    flat = [v for xy in coords for v in xy]
    return {"id": osm_id, "k": "road", "c": "primary", "w": width, "p": flat, "s0": 0.0,
            "r": 20, "ow": 1, **extra}


class MedianFillTests(unittest.TestCase):
    """Payload 0.4.1: the gap between two halves of a dual carriageway."""

    def test_bare_gap_becomes_asphalt_with_divider(self):
        # Eastbound at y=0 and westbound at y=12, 9.6 m wide each: gap 2.4 m.
        east = road_record(1, [(0, 0), (100, 0)], 9.6)
        west = road_record(2, [(100, 12), (0, 12)], 9.6)
        fills, dividers, stats = gs.median_fills([east, west], [])
        self.assertEqual([f["m"] for f in fills], ["asphalt"])
        ys = fills[0]["p"][1::2]
        self.assertAlmostEqual(min(ys), 4.8 - 0.3, places=1)
        self.assertAlmostEqual(max(ys), 7.2 + 0.3, places=1)
        self.assertEqual(len(dividers), 1)
        for y in dividers[0][1::2]:
            self.assertAlmostEqual(y, 6.0, places=1)

    def test_wide_bare_gap_stays_ground(self):
        east = road_record(1, [(0, 0), (100, 0)], 6.6)
        west = road_record(2, [(100, 20), (0, 20)], 6.6)
        fills, dividers, _ = gs.median_fills([east, west], [])
        self.assertEqual(fills, [])
        self.assertEqual(dividers, [])

    def test_tram_in_gap_becomes_track_bed_without_divider(self):
        east = road_record(1, [(0, 0), (100, 0)], 9.6)
        west = road_record(2, [(100, 18), (0, 18)], 9.6)
        tram = LineString([(0, 9), (100, 9)])
        fills, dividers, _ = gs.median_fills([east, west], [tram])
        self.assertEqual([f["m"] for f in fills], ["tram"])
        self.assertEqual(dividers, [])

    def test_same_direction_and_links_are_not_paired(self):
        east = road_record(1, [(0, 0), (100, 0)], 9.6)
        also_east = road_record(2, [(0, 12), (100, 12)], 9.6)
        ramp = road_record(3, [(100, 12), (0, 12)], 6.6, _lk=1)
        fills, dividers, _ = gs.median_fills([east, also_east, ramp], [])
        self.assertEqual(fills, [])
        self.assertEqual(dividers, [])

    def test_divider_is_cut_by_junction_trims(self):
        east = road_record(1, [(0, 0), (100, 0)], 9.6, nj=[40.0, 60.0])
        west = road_record(2, [(100, 12), (0, 12)], 9.6)
        _, dividers, _ = gs.median_fills([east, west], [])
        self.assertEqual(len(dividers), 2)
        for divider in dividers:
            xs = divider[0::2]
            self.assertTrue(max(xs) < 40.0 or min(xs) > 60.0)

    def test_inner_side_of_differently_named_halves_has_no_sidewalk(self):
        # A named half beside an unnamed half (Lenina × channelization).
        strokes = strokes_of([
            way(1, [(0, 0), (200, 0)], highway="secondary", oneway="yes", lanes="3", name="A"),
            way(2, [(200, 11), (0, 11)], highway="secondary", oneway="yes", lanes="2"),
        ])
        named = by_id(strokes, 1)[0]
        self.assertEqual(named.get("sw", [0.0, 0.0])[0], 0.0)


class TramPlatformTests(unittest.TestCase):
    def test_platform_goes_on_the_outer_side_of_a_median_line(self):
        north_track = LineString([(0, 2), (200, 2)])
        south_track = LineString([(200, -2), (0, -2)])
        platforms, stats = gs.tram_platforms([(100, 2)], [], [north_track, south_track])
        self.assertEqual(len(platforms), 1)
        ys = platforms[0]["p"][1::2]
        self.assertGreater(min(ys), 2.0)  # away from the parallel track
        self.assertAlmostEqual(max(ys) - min(ys), gs.TRAM_PLATFORM_WIDTH_M, places=1)

    def test_mapped_platform_node_decides_the_side(self):
        track = LineString([(0, 0), (200, 0)])
        platforms, _ = gs.tram_platforms([(100, 0)], [(100, -5)], [track])
        self.assertLess(max(platforms[0]["p"][1::2]), 0.0)

    def test_duplicate_stop_nodes_give_one_platform(self):
        track = LineString([(0, 0), (200, 0)])
        platforms, stats = gs.tram_platforms([(100, 0), (101, 0)], [], [track])
        self.assertEqual(len(platforms), 1)
        self.assertEqual(stats["tram_platforms_duplicate"], 1)


class CarriagewayClosingTests(unittest.TestCase):
    """Payload 0.4.1: gores, junction islands and slivers become asphalt."""

    def _fills(self, strokes, protected=()):
        out, stats = gs.carriageway_closing(strokes, [], list(protected), 512.0, [(0, 0)], 64.0)
        return out[(0, 0)], stats

    def test_gore_between_diverging_carriageways_is_filled(self):
        # Two 6.6 m ribbons that split at (100, 100) and are 4 m apart edge to
        # edge at x = 200: the narrow gore must become asphalt.
        main = road_record(1, [(100, 100), (200, 100)], 6.6)
        slip = road_record(2, [(100, 100), (200, 110.6)], 6.6, _lk=1)
        fills, _ = self._fills([main, slip])
        self.assertTrue(fills)
        self.assertTrue(all(f["m"] == "asphalt" and f.get("kb") == 1 for f in fills))
        from shapely.geometry import Point, Polygon
        polys = [Polygon(list(zip(f["p"][0::2], f["p"][1::2]))) for f in fills]
        # x = 195: centres 9.5 m apart, ribbon edges at y 103.3 and 106.2.
        self.assertTrue(any(p.buffer(0.01).contains(Point(195, 104.8)) for p in polys))

    def test_small_enclosed_island_is_filled_unless_protected(self):
        # A 20 x 12 m triangle-free box island enclosed by four ribbons.
        ring = [(100, 100), (130, 100), (130, 120), (100, 120), (100, 100)]
        strokes = [road_record(i, [ring[i], ring[i + 1]], 6.6) for i in range(4)]
        fills, stats = self._fills(strokes)
        self.assertEqual(stats["close_holes_filled"], 1)
        from shapely.geometry import Point, box as sbox
        fills, stats = self._fills(strokes, [sbox(112, 108, 118, 112)])
        self.assertEqual(stats["close_holes_filled"], 0)
        self.assertEqual(stats["close_holes_protected"], 1)

    def test_city_block_stays_ground(self):
        ring = [(100, 100), (200, 100), (200, 180), (100, 180), (100, 100)]
        strokes = [road_record(i, [ring[i], ring[i + 1]], 6.6) for i in range(4)]
        _, stats = self._fills(strokes)
        self.assertEqual(stats["close_holes_filled"], 0)
        self.assertEqual(stats["close_holes_large"], 1)

    def test_wide_parallel_gap_stays_open(self):
        a = road_record(1, [(100, 100), (300, 100)], 6.6)
        b = road_record(2, [(300, 115), (100, 115)], 6.6)
        fills, _ = self._fills([a, b])
        from shapely.geometry import Point, Polygon
        polys = [Polygon(list(zip(f["p"][0::2], f["p"][1::2]))) for f in fills]
        self.assertFalse(any(p.contains(Point(200, 107.5)) for p in polys))


class StreetParkingTests(unittest.TestCase):
    """Payload 0.4.1: on-street parking widens the kerb-to-kerb band."""

    def test_parking_tags_both_schemes(self):
        widths, codes = gs.street_parking({"parking:both": "lane", "parking:both:orientation": "diagonal"})
        self.assertEqual(widths, [gs.PARKING_WIDTH_M["diagonal"]] * 2)
        self.assertEqual(codes, [2, 2])
        widths, codes = gs.street_parking({"parking:lane:right": "perpendicular"})
        self.assertEqual(widths, [0.0, gs.PARKING_WIDTH_M["perpendicular"]])
        widths, _ = gs.street_parking({"parking:both": "on_kerb"})
        self.assertEqual(widths, [0.0, 0.0])
        widths, codes = gs.street_parking({"parking:left": "lane"})
        self.assertEqual((widths[0], codes[0]), (gs.PARKING_WIDTH_M["parallel"], 1))

    def test_parking_is_limited_by_mapped_pavement(self):
        road = LineString([(0, 0), (200, 0)])
        # Left pavement 7 m away everywhere; right pavement 3 m away for x < 100.
        walks = [LineString([(0, 7), (200, 7)]), LineString([(0, -3), (100, -3)]), LineString([(100, -7), (200, -7)])]
        from shapely.strtree import STRtree
        runs = gs.fit_parking(road, 4.0, [4.6, 4.6], [2, 2], STRtree(walks), walks)
        first = next(r for r in runs if r[0] <= 50 <= r[1])
        last = next(r for r in runs if r[0] <= 150 <= r[1])
        self.assertEqual(first[3], 0.0)            # no room on the right
        self.assertEqual(first[4], 2)              # left stays diagonal
        self.assertAlmostEqual(first[2], 4.0)      # narrowed to the 4 m of room
        self.assertGreater(last[3], 3.5)           # right side has room again

    def test_split_keeps_arc_frame(self):
        record = road_record(5, [(0, 0), (200, 0)], 4.0, nj=[0.0, 10.0])
        pieces = gs.split_by_parking(record, LineString([(0, 0), (200, 0)]),
                                     [(0, 100, 4.0, 0.0, 2, 0), (100, 200, 4.0, 4.0, 2, 2)])
        self.assertEqual([p["s0"] for p in pieces], [0.0, 100.0])
        self.assertEqual(pieces[1]["pk"], [4.0, 4.0])
        self.assertEqual(pieces[0]["nj"], [0.0, 10.0])
