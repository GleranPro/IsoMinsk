"""Unit tests for bridge decks (payload 0.4.2).

Run with:
    .venv\\Scripts\\python.exe scripts/normalize/tests/test_bridge_decks.py -v
or via:
    pnpm run test:data
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from shapely.geometry import Point, Polygon  # noqa: E402

import bridge_decks as bd  # noqa: E402
import ground_strokes as gs  # noqa: E402
import road_network as rn  # noqa: E402

TILE = 512.0
KEYS = [(0, 0), (-1, 0), (0, -1), (-1, -1)]


def road(osm_id, flat, w=8.0, **extra):
    record = {"id": osm_id, "k": "road", "c": "primary", "w": w, "p": list(flat), "s0": 0.0, "r": 20,
              "kb": 1, "lf": 2, "lb": 0, "ow": 1}
    record.update(extra)
    return record


def bridge_scene():
    """A 60 m east-west bridge (x 0..60) with approach roads at both ends and a
    road passing underneath at x = 30 (not connected)."""
    return [
        road(1, [-40.0, 10.0, 0.0, 10.0]),
        road(2, [0.0, 10.0, 60.0, 10.0], b=1, _ly=1, sw=[2.0, 2.0]),
        road(3, [60.0, 10.0, 100.0, 10.0]),
        road(4, [30.0, -40.0, 30.0, 60.0], w=7.0),
    ]


def deck_vertices(deck):
    t = deck["t"]
    return [(t[i], t[i + 1], t[i + 2]) for i in range(0, len(t), 3)]


class BridgeDeckTest(unittest.TestCase):
    def test_one_deck_with_ramps_and_span_height(self):
        decks, shadows, kept, stats = bd.bridge_decks(bridge_scene(), TILE, KEYS)
        chunks = decks[(0, 0)]
        self.assertEqual(stats["decks"], 1)
        self.assertEqual(len(chunks), 1)
        deck = chunks[0]
        verts = deck_vertices(deck)
        # Height 0 at both ends, full span height in the middle.
        self.assertAlmostEqual(max(z for _, _, z in verts), bd.DECK_RISE_M, places=2)
        for x, _, z in verts:
            if x <= 0.01 or x >= 59.99:
                # Pavement corners wider than the approach sit a little off
                # the end line and rise a few centimetres.
                self.assertLess(z, 0.3)
            if 20.0 <= x <= 40.0:
                self.assertAlmostEqual(z, bd.DECK_RISE_M, places=2)
        self.assertTrue(shadows)

    def test_passing_road_is_not_an_end(self):
        decks, _, _, _ = bd.bridge_decks(bridge_scene(), TILE, KEYS)
        ring = decks[(0, 0)][0]["r"][0]
        pts = ring["p"]
        for i, kind in enumerate(ring["e"]):
            j = (i + 1) % len(ring["e"])
            mx = (pts[2 * i] + pts[2 * j]) / 2.0
            if kind == 0:
                # Ends only at the two approach nodes, never where road 4 crosses under.
                self.assertTrue(mx < 2.0 or mx > 58.0, mx)
        self.assertIn(0, ring["e"])
        self.assertIn(1, ring["e"])

    def test_deck_carries_its_strokes_and_ground_drops_them(self):
        decks, _, kept, _ = bd.bridge_decks(bridge_scene(), TILE, KEYS)
        deck = decks[(0, 0)][0]
        self.assertEqual([s["id"] for s in deck["s"]], [2])
        self.assertNotIn("b", deck["s"][0])
        self.assertNotIn("_ly", deck["s"][0])
        self.assertEqual(sorted(s["id"] for s in kept), [1, 3, 4])

    def test_footprint_includes_pavements(self):
        decks, _, _, _ = bd.bridge_decks(bridge_scene(), TILE, KEYS)
        bb = decks[(0, 0)][0]["bb"]
        half = 8.0 / 2 + bd.KERB_M + 2.0
        self.assertAlmostEqual(bb[3] - bb[1], 2 * half, delta=0.1)

    def test_short_bridge_rises_less(self):
        scene = [
            road(1, [-40.0, 10.0, 0.0, 10.0]),
            road(2, [0.0, 10.0, 16.0, 10.0], b=1, _ly=1),
            road(3, [16.0, 10.0, 60.0, 10.0]),
        ]
        decks, _, _, _ = bd.bridge_decks(scene, TILE, KEYS)
        deck = decks[(0, 0)][0]
        self.assertLess(deck["hz"], bd.DECK_RISE_M)
        self.assertLessEqual(deck["hz"], bd.DECK_MAX_SLOPE * bd.DECK_RAMP_MAX_M + 1e-6)

    def test_long_deck_is_chunked_on_the_grid(self):
        scene = [
            road(1, [-300.0, 10.0, -200.0, 10.0]),
            road(2, [-200.0, 10.0, 100.0, 10.0], b=1, _ly=1),
            road(3, [100.0, 10.0, 200.0, 10.0]),
        ]
        decks, _, _, stats = bd.bridge_decks(scene, TILE, KEYS)
        self.assertGreaterEqual(stats["deck_chunks"], 3)
        for chunks in decks.values():
            for deck in chunks:
                self.assertLessEqual(deck["bb"][2] - deck["bb"][0], bd.DECK_CHUNK_M + 1e-6)
                # Chunk borders are cuts: no fascia across the deck.
                self.assertTrue(all(kind in (0, 1, 2) for r in deck["r"] for kind in r["e"]))

    def test_tiny_bridge_is_flattened(self):
        scene = [road(1, [0.0, 0.0, 30.0, 0.0]), road(2, [30.0, 0.0, 31.0, 0.0], b=1, w=2.0, _ly=1)]
        decks, _, kept, stats = bd.bridge_decks(scene, TILE, KEYS)
        self.assertEqual(sum(len(v) for v in decks.values()), 0)
        flat = [s for s in kept if s["id"] == 2]
        self.assertEqual(len(flat), 1)
        self.assertNotIn("b", flat[0])


def side_edge_midpoints(chunks):
    out = []
    for deck in chunks:
        for ring in deck["r"]:
            pts, edges = ring["p"], ring["e"]
            n = len(edges)
            for i, kind in enumerate(edges):
                j = (i + 1) % n
                if kind == 1:
                    out.append(((pts[2 * i] + pts[2 * j]) / 2.0, (pts[2 * i + 1] + pts[2 * j + 1]) / 2.0))
    return out


class BridgeDeckRegressionTest(unittest.TestCase):
    def test_pedestrian_bridge_becomes_a_deck(self):
        # Kanatny lane: highway=pedestrian bridge (kind 'ped') used to vanish.
        scene = [
            {"id": 1, "k": "ped", "c": "pedestrian", "w": 8.0, "p": [-40.0, 0.0, 0.0, 0.0], "s0": 0.0, "r": 2},
            {"id": 2, "k": "ped", "c": "pedestrian", "w": 8.0, "p": [0.0, 0.0, 24.0, 0.0], "s0": 0.0, "r": 2,
             "b": 1, "_ly": 1},
            {"id": 3, "k": "ped", "c": "pedestrian", "w": 8.0, "p": [24.0, 0.0, 60.0, 0.0], "s0": 0.0, "r": 2},
        ]
        decks, _, kept, stats = bd.bridge_decks(scene, TILE, KEYS)
        self.assertEqual(stats["decks"], 1)
        self.assertEqual(sorted(s["id"] for s in kept), [1, 3])

    def test_no_bridge_stroke_is_left_in_the_ground(self):
        scene = bridge_scene() + [
            {"id": 9, "k": "other", "c": "x", "w": 2.0, "p": [0.0, 80.0, 30.0, 80.0], "s0": 0.0, "r": 1, "b": 1},
        ]
        _, _, kept, _ = bd.bridge_decks(scene, TILE, KEYS)
        self.assertFalse([s for s in kept if s.get("b")])
        self.assertIn(9, [s["id"] for s in kept])

    def test_separate_footway_gap_under_6m_is_deck(self):
        # Kastrychnitskaya: footway 3.4–4.2 m from its carriageway left a walled notch.
        y_foot = 10.0 + 2.0 + bd.KERB_M + 4.6 + 1.25
        scene = [
            road(1, [-40.0, 10.0, 0.0, 10.0], w=4.0, lf=1, lb=1, ow=None),
            road(2, [0.0, 10.0, 50.0, 10.0], w=4.0, lf=1, lb=1, ow=None, b=1, _ly=1),
            road(3, [50.0, 10.0, 90.0, 10.0], w=4.0, lf=1, lb=1, ow=None),
            {"id": 4, "k": "path", "c": "footway", "w": 2.5, "p": [0.0, y_foot, 50.0, y_foot], "s0": 0.0, "r": 3,
             "b": 1, "_ly": 1},
        ]
        decks, _, _, stats = bd.bridge_decks(scene, TILE, KEYS)
        self.assertEqual(stats["decks"], 1)
        between = [(x, y) for x, y in side_edge_midpoints(decks[(0, 0)])
                   if 10.0 + 2.6 + 0.2 < y < y_foot - 1.25 - 0.2 and 2.0 < x < 48.0]
        self.assertEqual(between, [])

    def test_staggered_dual_carriageway_is_one_deck(self):
        # Kastrychnitskaya 5A: the two halves leave the bridge 20 m apart.
        scene = [
            road(10, [-40.0, 0.0, 0.0, 0.0]),
            road(11, [0.0, 0.0, 60.0, 0.0], b=1, _ly=1),
            road(12, [60.0, 0.0, 100.0, 0.0]),
            road(20, [100.0, 10.8, 40.0, 10.8]),
            road(21, [40.0, 10.8, 0.0, 10.8], b=1, _ly=1),
            road(22, [0.0, 10.8, -40.0, 10.8]),
        ]
        decks, _, _, stats = bd.bridge_decks(scene, TILE, KEYS)
        self.assertEqual(stats["decks"], 1)
        chunks = decks[(0, 0)]
        # 1.6 m between the kerbs (y 4.6 .. 6.2), measured 0.3–1.5 m at 5A:
        # no wall along the step (x 40..60) nor across the gap at the ends.
        median = [(x, y) for x, y in side_edge_midpoints(chunks) if 4.0 < y < 6.8]
        self.assertEqual(median, [], "no wall between the halves where one leaves the bridge")
        self.assertTrue(any(d.get("f") for d in chunks), "median gap is asphalt on the deck")
        self.assertTrue(any(d.get("dv") for d in chunks), "divider line on the deck")
        # Where half 11 is on the deck and half 20 still on the ground (x 40..60),
        # the ground gap between them is asphalt (it showed as a hole), while
        # the stretch with both halves on the bridge (x 0..40) is left to the deck.
        fills, _, _ = gs.median_fills(scene, [])
        polys = [Polygon(list(zip(f["p"][0::2], f["p"][1::2]))) for f in fills]
        self.assertTrue(any(p.contains(Point(50.0, 5.4)) for p in polys), "step-zone gap filled on the ground")
        self.assertFalse(any(p.contains(Point(20.0, 5.4)) for p in polys), "no ground fill under the deck")


class ConstructionClassTest(unittest.TestCase):
    def test_construction_sidewalk_is_a_footway(self):
        self.assertEqual(rn.construction_class({"highway": "construction", "footway": "sidewalk"}), "footway")

    def test_construction_target_class(self):
        self.assertEqual(rn.construction_class({"highway": "construction", "construction": "secondary"}), "secondary")

    def test_unknown_construction(self):
        self.assertEqual(rn.construction_class({"highway": "construction"}), "unknown")


if __name__ == "__main__":
    unittest.main()
