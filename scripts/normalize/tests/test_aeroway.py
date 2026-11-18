"""Unit tests for the B-2 aerodrome surface conversion."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from shapely.geometry import LineString, Polygon  # noqa: E402

import aeroway  # noqa: E402


class AerowayTests(unittest.TestCase):
    def test_runway_becomes_wide_concrete_stroke(self):
        feature = {
            "osm_id": 1,
            "type": "line",
            "tags": {"aeroway": "runway", "width": "40", "surface": "concrete"},
            "line": LineString([(0, 0), (1000, 0)]),
        }
        strokes, fills, stats = aeroway.build_aeroway([feature])
        self.assertEqual(len(strokes), 1)
        self.assertEqual(fills, [])
        self.assertEqual(strokes[0]["k"], "aeroway")
        self.assertEqual(strokes[0]["w"], 40.0)
        self.assertEqual(strokes[0]["mat"], "concrete")
        self.assertEqual(stats["stroke_runway"], 1)

    def test_taxiway_default_width_is_used(self):
        feature = {
            "osm_id": 2,
            "type": "line",
            "tags": {"aeroway": "taxiway"},
            "line": LineString([(0, 0), (100, 0)]),
        }
        strokes, _fills, _stats = aeroway.build_aeroway([feature])
        self.assertEqual(strokes[0]["w"], 18.0)

    def test_asphalt_surface_is_preserved(self):
        feature = {
            "osm_id": 3,
            "type": "polygon",
            "tags": {"aeroway": "apron", "surface": "asphalt"},
            "polygon": Polygon([(0, 0), (200, 0), (200, 100), (0, 100)]),
        }
        strokes, fills, stats = aeroway.build_aeroway([feature])
        self.assertEqual(strokes, [])
        self.assertEqual(fills[0]["m"], "asphalt")
        self.assertEqual(stats["fill_apron"], 1)

    def test_helipad_and_apron_become_fills(self):
        feature = {
            "osm_id": 4,
            "type": "polygon",
            "tags": {"aeroway": "helipad"},
            "polygon": Polygon([(0, 0), (30, 0), (30, 30), (0, 30)]),
        }
        _strokes, fills, stats = aeroway.build_aeroway([feature])
        self.assertEqual(fills[0]["m"], "concrete")
        self.assertEqual(stats["fill_helipad"], 1)

    def test_tiny_features_are_ignored(self):
        feature = {
            "osm_id": 5,
            "type": "polygon",
            "tags": {"aeroway": "apron"},
            "polygon": Polygon([(0, 0), (2, 0), (2, 2), (0, 2)]),
        }
        _strokes, fills, _stats = aeroway.build_aeroway([feature])
        self.assertEqual(fills, [])


if __name__ == "__main__":
    unittest.main()
