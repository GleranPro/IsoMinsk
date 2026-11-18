"""Unit tests for the B-2 pipeline guards.

Two rules protect the 437-tile build from silent quality regressions:

* `building:part` parenting moved from an O(parts x buildings) scan to an
  STRtree candidate query; the "smallest containing polygon wins" rule and the
  synthetic orphan-parent behaviour must stay identical.
* a global tree-budget scale below 1 thins every vegetation zone, including the
  already accepted centre; for the city it must be an explicit decision.

Run:
    .venv\\Scripts\\python.exe -m unittest scripts.normalize.tests.test_pipeline_guards -v
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from shapely import STRtree  # noqa: E402
from shapely.geometry import Point, Polygon, box  # noqa: E402

import normalize  # noqa: E402


class PartParentTests(unittest.TestCase):
    def setUp(self):
        # A large footprint with a smaller nested volume inside it.
        self.polygons = [box(0, 0, 100, 100), box(10, 10, 20, 20)]
        self.tree = STRtree(self.polygons)

    def test_smallest_containing_polygon_wins(self):
        index = normalize.smallest_containing_building(
            Point(15, 15), self.polygons, self.tree
        )
        self.assertEqual(index, 1)

    def test_large_polygon_is_used_outside_the_small_one(self):
        index = normalize.smallest_containing_building(
            Point(5, 5), self.polygons, self.tree
        )
        self.assertEqual(index, 0)

    def test_point_outside_every_polygon_is_none(self):
        index = normalize.smallest_containing_building(
            Point(200, 200), self.polygons, self.tree
        )
        self.assertIsNone(index)

    def test_synthetic_orphan_parent_is_considered(self):
        extra = [(2, Polygon([(30, 30), (40, 30), (40, 40), (30, 40)]))]
        index = normalize.smallest_containing_building(
            Point(35, 35), self.polygons, self.tree, extra
        )
        self.assertEqual(index, 2)

    def test_linear_fallback_without_tree(self):
        index = normalize.smallest_containing_building(
            Point(15, 15), self.polygons, None
        )
        self.assertEqual(index, 1)


class TreeBudgetTests(unittest.TestCase):
    def test_city_thinning_is_an_error(self):
        error = normalize.tree_budget_policy_error(
            0.62, is_city=True, allow_thinning=False
        )
        self.assertIn("global tree budget scale", error)

    def test_city_thinning_allowed_explicitly(self):
        self.assertIsNone(
            normalize.tree_budget_policy_error(
                0.62, is_city=True, allow_thinning=True
            )
        )

    def test_full_scale_passes(self):
        self.assertIsNone(
            normalize.tree_budget_policy_error(
                1.0, is_city=True, allow_thinning=False
            )
        )

    def test_pilot_stays_tolerant(self):
        self.assertIsNone(
            normalize.tree_budget_policy_error(
                0.5, is_city=False, allow_thinning=False
            )
        )


if __name__ == "__main__":
    unittest.main()
