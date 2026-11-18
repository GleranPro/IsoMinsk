"""Unit tests for the tree placement module (payload 0.4.3, steps W2-W6).

Run with:
    .venv\\Scripts\\python.exe -m unittest scripts.normalize.tests.test_trees -v
or via:
    pnpm run test:data

Everything is synthetic and in local metres: `to_local` is the identity, so a
`natural=tree` node is written as `{"lon": x, "lat": y}` and a tree row as
`{"coords": [[x, y], ...]}`. W4 tests cover the disjoint vegetation zones, W5
the aligned cemetery grid and W6 the budget scale / per-tile cap / triangle
budget.
"""

from __future__ import annotations

import math
import random
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from shapely.affinity import rotate  # noqa: E402
from shapely.geometry import Point, Polygon, box  # noqa: E402

import trees  # noqa: E402

BOUNDS = (-1000.0, -1000.0, 1000.0, 1000.0)
IDENTITY = lambda lon, lat: (float(lon), float(lat))  # noqa: E731
TREE_FIELDS = {"x", "y", "height", "radius", "variation", "mapped"}


def node(osm_id: int, x: float, y: float, **extra) -> dict:
    return {"osm_id": osm_id, "lon": x, "lat": y, **extra}


def row(osm_id: int, coords, **extra) -> dict:
    return {
        "osm_id": osm_id,
        "coords": [[float(x), float(y)] for x, y in coords],
        "leaf_type": None,
        "height": None,
        **extra,
    }


def build(**overrides):
    params = {
        "surfaces": [],
        "mapped_raw": [],
        "row_raw": [],
        "hard_masks": [],
        "soft_masks": [],
        "to_local": IDENTITY,
        "bounds": BOUNDS,
        "max_total_trees": 1000,
    }
    params.update(overrides)
    return trees.build_trees(**params)


def zones_of(*surfaces):
    """`build_vegetation_zones` with the open surfaces detected as in the pipeline."""
    open_masks = [
        polygon for kind, polygon in surfaces if kind in trees.OPEN_SURFACE_KINDS
    ]
    return trees.build_vegetation_zones(list(surfaces), open_masks)


def per_tile_counts(placed, tile_size):
    counts = {}
    for tree in placed:
        tile = trees.tile_of_point(tree["x"], tree["y"], tile_size)
        counts[tile] = counts.get(tile, 0) + 1
    return counts


class MappedNodeTests(unittest.TestCase):
    """W3: mapped nodes are removed only by hard surfaces, 0.5 m margin."""

    def test_inside_building_is_dropped(self):
        building = Polygon(box(0, 0, 10, 10))
        placed, stats = build(
            mapped_raw=[node(1, 5, 5)],
            hard_masks=[building],
            soft_masks=[building],
        )
        self.assertEqual(placed, [])
        self.assertEqual(stats["trees_mapped_points_raw"], 1)
        self.assertEqual(stats["trees_mapped_points_dropped"], 1)

    def test_building_margin_half_a_metre(self):
        building = Polygon(box(0, 0, 10, 10))
        placed, stats = build(
            mapped_raw=[node(1, 10.4, 5), node(2, 10.6, 5)],
            hard_masks=[building],
        )
        self.assertEqual(stats["trees_mapped_points_dropped"], 1)
        self.assertEqual([t["x"] for t in placed], [10.6])

    def test_pedestrian_path_never_drops_a_mapped_tree(self):
        # Pavements/paths are a soft mask only: heuristics avoid them, mapped
        # trees do not care.
        path = Polygon(box(-50, 1, 50, 3))
        placed, stats = build(
            mapped_raw=[node(1, 0, 2), node(2, 0, 0.2)],
            soft_masks=[path],
        )
        self.assertEqual(len(placed), 2)
        self.assertEqual(stats["trees_mapped_points_dropped"], 0)

    def test_carriageway_drops_mapped_tree(self):
        road = Polygon(box(-50, -5, 50, 5))
        placed, stats = build(
            mapped_raw=[node(1, 0, 4.8), node(2, 0, 6.0)],
            hard_masks=[road],
            soft_masks=[road],
        )
        self.assertEqual(stats["trees_mapped_points_dropped"], 1)
        self.assertEqual([t["y"] for t in placed], [6.0])

    def test_water_and_rail_drop_mapped_tree(self):
        water = Polygon(box(-10, -10, 10, 10))
        rail = Polygon(box(20, -2, 80, 2))
        placed, stats = build(
            mapped_raw=[node(1, 0, 0), node(2, 50, 0), node(3, 50, 20)],
            hard_masks=[water, rail],
            soft_masks=[water, rail],
        )
        self.assertEqual(stats["trees_mapped_points_dropped"], 2)
        self.assertEqual([t["y"] for t in placed], [20])

    def test_mapped_payload_fields_are_unchanged(self):
        placed, _ = build(mapped_raw=[node(7, 3, 4, height="12", crown="6")])
        self.assertEqual(len(placed), 1)
        instance = placed[0]
        self.assertEqual(set(instance), TREE_FIELDS)
        self.assertEqual(instance["height"], 12.0)
        self.assertEqual(instance["radius"], 3.0)
        self.assertIs(instance["mapped"], True)


class TreeRowTests(unittest.TestCase):
    """W3: tree rows become mapped points every 7 m, duplicates are dropped."""

    def test_row_becomes_points_every_seven_metres(self):
        placed, stats = build(row_raw=[row(10, [(0, 0), (21, 0)])])
        self.assertEqual(stats["trees_mapped_rows"], 4)
        self.assertEqual([t["x"] for t in placed], [0.0, 7.0, 14.0, 21.0])
        self.assertEqual([t["y"] for t in placed], [0.0, 0.0, 0.0, 0.0])
        self.assertTrue(all(t["mapped"] for t in placed))
        distances = [
            placed[i + 1]["x"] - placed[i]["x"] for i in range(len(placed) - 1)
        ]
        self.assertEqual(distances, [7.0, 7.0, 7.0])

    def test_row_point_near_mapped_node_is_dropped(self):
        placed, stats = build(
            mapped_raw=[node(1, 1.5, 0)],
            row_raw=[row(10, [(0, 0), (21, 0)])],
        )
        self.assertEqual(stats["trees_mapped_rows_dropped_duplicate"], 1)
        self.assertEqual([t["x"] for t in placed], [1.5, 7.0, 14.0, 21.0])

    def test_row_point_inside_building_is_dropped(self):
        building = Polygon(box(5, -5, 9, 5))
        placed, stats = build(
            row_raw=[row(10, [(0, 0), (21, 0)])],
            hard_masks=[building],
            soft_masks=[building],
        )
        self.assertEqual(stats["trees_mapped_rows_dropped_mask"], 1)
        self.assertEqual([t["x"] for t in placed], [0.0, 14.0, 21.0])

    def test_row_is_clipped_to_the_area(self):
        placed, _ = build(row_raw=[row(10, [(-100, 0), (100, 0)])], bounds=(-10.0, -10.0, 10.0, 10.0))
        self.assertTrue(placed)
        for instance in placed:
            self.assertLessEqual(abs(instance["x"]), 10.0)
            self.assertLessEqual(abs(instance["y"]), 10.0)

    def test_row_is_deterministic(self):
        raw = [row(10, [(0, 0), (21, 3)], height="11.5")]
        first, _ = build(row_raw=raw)
        second, _ = build(row_raw=raw)
        self.assertEqual(first, second)
        self.assertTrue(all(t["height"] == 11.5 for t in first))

    def test_row_height_fallback(self):
        raw = [row(12345, [(0, 0), (14, 0)])]
        placed, _ = build(row_raw=raw)
        self.assertEqual(len(placed), 3)
        for instance in placed:
            self.assertGreaterEqual(instance["height"], 7.0)
            self.assertLessEqual(instance["height"], 15.0)
        again, _ = build(row_raw=raw)
        self.assertEqual(placed, again)

    def test_needleleaved_is_counted_without_new_payload_field(self):
        placed, stats = build(
            row_raw=[row(10, [(0, 0), (14, 0)], leaf_type="needleleaved")]
        )
        self.assertEqual(len(placed), 3)
        self.assertEqual(stats["trees_mapped_rows_needleleaved"], 3)
        for instance in placed:
            self.assertEqual(set(instance), TREE_FIELDS)

    def test_row_payload_fields_are_unchanged(self):
        placed, _ = build(row_raw=[row(10, [(0, 0), (7, 0)])])
        self.assertEqual(len(placed), 2)
        for instance in placed:
            self.assertEqual(set(instance), TREE_FIELDS)
            self.assertIs(instance["mapped"], True)


class HeuristicTests(unittest.TestCase):
    """W2: the pre-0.4.3 heuristic fill still behaves deterministically."""

    def test_heuristic_fill_is_deterministic(self):
        park = Polygon(box(0, 0, 100, 100))
        surfaces = [("park", park)]
        first, first_stats = build(surfaces=surfaces)
        second, second_stats = build(surfaces=surfaces)
        self.assertEqual(first, second)
        self.assertEqual(first_stats["trees_heuristic"], second_stats["trees_heuristic"])
        self.assertGreater(first_stats["trees_heuristic"], 0)
        self.assertTrue(all(t["mapped"] is False for t in first))
        self.assertTrue(all(set(t) == TREE_FIELDS for t in first))

    def test_heuristic_trees_respect_soft_masks(self):
        park = Polygon(box(0, 0, 100, 100))
        clearing = Polygon(box(40, 40, 60, 60))
        placed, _ = build(
            surfaces=[("park", park)],
            soft_masks=[clearing],
        )
        forbidden = clearing.buffer(2.9)
        self.assertTrue(placed)
        self.assertFalse(any(forbidden.contains(Point(t["x"], t["y"])) for t in placed))

    def test_global_cap_applies_to_heuristic_fill(self):
        park = Polygon(box(0, 0, 400, 400))
        placed, stats = build(
            surfaces=[("park", park)],
            max_total_trees=10,
        )
        self.assertLessEqual(len(placed), 10)
        self.assertEqual(stats["trees_limit_reached"], 1)


class VegetationZoneTests(unittest.TestCase):
    """W4: overlapping polygons become disjoint zones; the smaller one wins."""

    def test_smaller_polygon_wins_in_overlap(self):
        park = Polygon(box(80, 80, 120, 120))  # 40 x 40 = 1 600 m2
        forest = Polygon(box(0, 0, 200, 200))  # 40 000 m2
        zones = zones_of(("forest", forest), ("park", park))
        park_zones = [zone for zone in zones if zone["kind"] == "park"]
        forest_zones = [zone for zone in zones if zone["kind"] == "forest"]
        self.assertEqual(len(park_zones), 1)
        self.assertEqual(len(forest_zones), 1)
        self.assertAlmostEqual(park_zones[0]["area"], 1600.0, delta=1.0)
        self.assertAlmostEqual(forest_zones[0]["area"], 40000.0 - 1600.0, delta=1.0)
        self.assertTrue(park_zones[0]["polygon"].contains(Point(100, 100)))
        self.assertFalse(forest_zones[0]["polygon"].contains(Point(100, 100)))

    def test_grass_inside_park_stays_grass(self):
        park = Polygon(box(0, 0, 200, 200))
        grass = Polygon(box(60, 60, 100, 100))
        zones = zones_of(("park", park), ("grass", grass))
        by_kind = {zone["kind"]: zone["area"] for zone in zones}
        self.assertAlmostEqual(by_kind["grass"], 1600.0, delta=1.0)
        self.assertAlmostEqual(by_kind["park"], 40000.0 - 1600.0, delta=1.0)

    def test_forest_inside_cemetery_stays_forest(self):
        cemetery = Polygon(box(0, 0, 200, 200))
        forest = Polygon(box(50, 50, 100, 100))
        zones = zones_of(("cemetery", cemetery), ("forest", forest))
        by_kind = {zone["kind"]: zone["area"] for zone in zones}
        self.assertAlmostEqual(by_kind["forest"], 2500.0, delta=1.0)
        self.assertAlmostEqual(by_kind["cemetery"], 40000.0 - 2500.0, delta=1.0)

    def test_open_surface_is_excluded_from_zones(self):
        park = Polygon(box(0, 0, 200, 200))
        pitch = Polygon(box(10, 10, 60, 60))
        zones = zones_of(("park", park), ("pitch", pitch))
        self.assertEqual(len(zones), 1)
        self.assertAlmostEqual(zones[0]["area"], 40000.0 - 2500.0, delta=1.0)
        self.assertFalse(zones[0]["polygon"].contains(Point(35, 35)))

    def test_duplicate_polygons_are_merged_into_one_zone(self):
        park = Polygon(box(0, 0, 200, 200))
        zones = zones_of(("park", park), ("park", park))
        self.assertEqual(len(zones), 1)
        self.assertAlmostEqual(zones[0]["area"], 40000.0, delta=1.0)

    def test_zones_do_not_overlap(self):
        zones = zones_of(
            ("forest", Polygon(box(0, 0, 200, 200))),
            ("park", Polygon(box(80, 80, 160, 160))),
            ("grass", Polygon(box(100, 100, 140, 140))),
            ("scrub", Polygon(box(20, 20, 60, 60))),
        )
        total = sum(zone["area"] for zone in zones)
        self.assertAlmostEqual(total, 40000.0, delta=1.0)
        # Pairwise intersections are empty (zones are disjoint).
        for i, first in enumerate(zones):
            for second in zones[i + 1:]:
                self.assertLess(first["polygon"].intersection(second["polygon"]).area, 1e-6)

    def test_zone_result_is_independent_of_input_order(self):
        surfaces = [
            ("forest", Polygon(box(0, 0, 200, 200))),
            ("park", Polygon(box(80, 80, 160, 160))),
            ("grass", Polygon(box(100, 100, 140, 140))),
            ("pitch", Polygon(box(20, 20, 40, 40))),
        ]
        expected = zones_of(*surfaces)
        shuffled = list(surfaces)
        random.Random(7).shuffle(shuffled)
        actual = zones_of(*shuffled)
        self.assertEqual(
            [(zone["kind"], round(zone["area"], 3), zone["polygon"].wkb) for zone in expected],
            [(zone["kind"], round(zone["area"], 3), zone["polygon"].wkb) for zone in actual],
        )

    def test_zones_smaller_than_the_class_minimum_are_dropped(self):
        park = Polygon(box(0, 0, 200, 200))
        tiny_grass = Polygon(box(10, 10, 20, 20))  # 100 m2 < MIN_POLY_AREA grass
        zones = zones_of(("park", park), ("grass", tiny_grass))
        # The tiny grass still wins its own ground (park is carved around it),
        # but it is too small to be planted.
        self.assertEqual([zone["kind"] for zone in zones], ["park"])
        self.assertAlmostEqual(zones[0]["area"], 40000.0 - 100.0, delta=1.0)


class CemeteryTests(unittest.TestCase):
    """W5: aligned grid, density 1 / 90 m2, heights 8-16 m."""

    def test_cemetery_gets_trees_at_the_expected_density(self):
        cemetery = Polygon(box(0, 0, 180, 90))
        placed, stats = build(surfaces=[("cemetery", cemetery)], max_total_trees=1000)
        expected = 180 * 90 / trees.TREE_DENSITY["cemetery"]
        self.assertEqual(stats["trees_zones"], 1)
        self.assertGreater(len(placed), 0)
        self.assertAlmostEqual(len(placed), expected, delta=expected * 0.25)
        self.assertGreater(stats["trees_heuristic_by_class"]["cemetery"], 0)
        for tree in placed:
            self.assertFalse(tree["mapped"])
            self.assertGreaterEqual(tree["height"], 8.0)
            self.assertLessEqual(tree["height"], 16.0)

    def test_grid_is_aligned_with_the_long_axis_of_the_rectangle(self):
        cemetery = Polygon(box(0, 0, 180, 90))
        placed, _stats = build(surfaces=[("cemetery", cemetery)])
        xs = sorted({round(tree["x"], 2) for tree in placed})
        ys = sorted({round(tree["y"], 2) for tree in placed})
        self.assertGreater(len(xs), 10)
        self.assertGreater(len(ys), 5)
        for column in range(len(xs) - 1):
            step = xs[column + 1] - xs[column]
            self.assertAlmostEqual(step / trees.CEMETERY_IN_ROW_STEP_M,
                                   round(step / trees.CEMETERY_IN_ROW_STEP_M), places=3)
        for line in range(len(ys) - 1):
            step = ys[line + 1] - ys[line]
            self.assertAlmostEqual(step / trees.CEMETERY_ROW_STEP_M,
                                   round(step / trees.CEMETERY_ROW_STEP_M), places=3)

    def test_grid_offset_stays_under_one_metre(self):
        cemetery = Polygon(box(0, 0, 180, 90))
        placed, _stats = build(surfaces=[("cemetery", cemetery)])
        for tree in placed:
            self.assertLessEqual(abs(tree["x"] % trees.CEMETERY_IN_ROW_STEP_M), 1.0 + 1e-6)
            self.assertLessEqual(abs(tree["y"] % trees.CEMETERY_ROW_STEP_M), 1.0 + 1e-6)

    def test_grid_follows_a_rotated_long_axis(self):
        cemetery = rotate(Polygon(box(0, 0, 180, 90)), 30, origin=(0, 0))
        zones = trees.build_vegetation_zones([("cemetery", cemetery)])
        self.assertEqual(len(zones), 1)
        zone_poly = zones[0]["polygon"]
        placed, _stats = build(surfaces=[("cemetery", cemetery)])
        corners = list(zone_poly.minimum_rotated_rectangle.exterior.coords)[:4]
        sides = [math.dist(corners[i], corners[(i + 1) % 4]) for i in range(4)]
        longest = max(range(4), key=lambda i: sides[i])
        start, end = corners[longest], corners[(longest + 1) % 4]
        length = math.hypot(end[0] - start[0], end[1] - start[1])
        ux, uy = (end[0] - start[0]) / length, (end[1] - start[1]) / length

        def is_multiple(value, step):
            ratio = value / step
            return abs(ratio - round(ratio)) < 0.02

        us = sorted({round(tree["x"] * ux + tree["y"] * uy, 3) for tree in placed})
        vs = sorted({
            round(tree["x"] * -uy + tree["y"] * ux, 3) for tree in placed
        })
        for values, step in ((us, trees.CEMETERY_IN_ROW_STEP_M),
                             (vs, trees.CEMETERY_ROW_STEP_M)):
            for index in range(len(values) - 1):
                self.assertTrue(is_multiple(values[index + 1] - values[index], step))

    def test_cemetery_respects_building_and_path_masks(self):
        cemetery = Polygon(box(0, 0, 180, 90))
        chapel = Polygon(box(85, 40, 95, 50))
        path = Polygon(box(0, 44, 180, 46))
        placed, _stats = build(
            surfaces=[("cemetery", cemetery)],
            hard_masks=[chapel],
            soft_masks=[chapel, path],
        )
        self.assertTrue(placed)
        forbidden = chapel.buffer(2.9).union(path.buffer(2.9))
        self.assertFalse(any(forbidden.contains(Point(t["x"], t["y"])) for t in placed))

    def test_cemetery_grid_is_deterministic(self):
        cemetery = Polygon(box(0, 0, 180, 90))
        first, _ = build(surfaces=[("cemetery", cemetery)])
        second, _ = build(surfaces=[("cemetery", cemetery)])
        self.assertEqual(first, second)


class BudgetTests(unittest.TestCase):
    """W6: budget scale, per-tile cap, mapped-trunk clearance, triangle budget."""

    def test_global_cap_scales_targets_instead_of_cutting_by_order(self):
        park = Polygon(box(0, 0, 200, 200))  # 320 trees at 125 m2 / tree
        placed, stats = build(surfaces=[("park", park)], max_total_trees=100)
        self.assertEqual(len(placed), 100)
        self.assertLess(stats["trees_budget_scale"], 1.0)
        self.assertGreater(stats["trees_budget_scale"], 0.0)
        self.assertEqual(stats["trees_budget_target_total"], 320)

    def test_mapped_trees_are_included_in_the_budget(self):
        park = Polygon(box(0, 0, 200, 200))
        mapped = [node(index, 20 + index, 20) for index in range(10)]
        placed, stats = build(
            surfaces=[("park", park)], mapped_raw=mapped, max_total_trees=50
        )
        self.assertEqual(sum(1 for tree in placed if tree["mapped"]), 10)
        self.assertLessEqual(len(placed), 50)
        self.assertEqual(stats["trees_mapped_in_zones"], 10)

    def test_budget_scale_is_shared_by_all_zones(self):
        first = Polygon(box(0, 0, 200, 200))
        second = Polygon(box(300, 0, 400, 100))
        placed, stats = build(
            surfaces=[("park", first), ("park", second)], max_total_trees=100
        )
        self.assertEqual(len(placed), 100)
        # 320 + 80 trees worth of targets scaled by 100 / 400 = 0.25.
        self.assertAlmostEqual(stats["trees_budget_scale"], 0.25, places=6)

    def test_per_tile_cap_thins_heuristic_trees_only(self):
        first = Polygon(box(0, 0, 90, 90))
        second = Polygon(box(200, 0, 290, 90))
        placed, stats = build(
            surfaces=[("park", first), ("park", second)],
            max_total_trees=1000,
            tile_size=100.0,
            max_trees_per_tile=30,
        )
        counts = per_tile_counts(placed, 100.0)
        self.assertLessEqual(max(counts.values()), 30)
        self.assertEqual(stats["trees_max_per_tile"], 30)
        self.assertGreater(stats["trees_tile_thinned"], 0)
        self.assertLessEqual(stats["trees_max_triangles_per_tile"], 48000)

    def test_mapped_trees_are_never_thinned(self):
        park = Polygon(box(0, 0, 200, 200))
        mapped = [node(index, 20 + index * 5, 20) for index in range(10)]
        placed, stats = build(
            surfaces=[("park", park)],
            mapped_raw=mapped,
            max_total_trees=1000,
            max_trees_per_tile=5,
        )
        self.assertEqual(sum(1 for tree in placed if tree["mapped"]), 10)
        self.assertEqual(stats["trees_heuristic"], 0)
        self.assertEqual(stats["trees_max_per_tile"], 10)

    def test_heuristics_keep_radius_plus_two_metres_from_mapped_trunks(self):
        park = Polygon(box(0, 0, 300, 300))
        mapped = [node(1, 150, 150, crown="10")]  # radius 5 -> keep-out 7 m
        placed, stats = build(
            surfaces=[("park", park)], mapped_raw=mapped, max_total_trees=1000
        )
        heuristics = [tree for tree in placed if not tree["mapped"]]
        self.assertGreater(len(heuristics), 100)
        self.assertGreater(stats["trees_heuristic"], 0)
        for tree in heuristics:
            distance = math.dist((tree["x"], tree["y"]), (150, 150))
            self.assertGreaterEqual(distance, 7.0 - 0.02)

    def test_surface_order_does_not_change_the_result(self):
        surfaces = [
            ("forest", Polygon(box(0, 0, 300, 300))),
            ("park", Polygon(box(50, 50, 200, 200))),
            ("grass", Polygon(box(20, 20, 60, 60))),
        ]
        expected, expected_stats = build(surfaces=surfaces, max_total_trees=2000)
        shuffled = list(surfaces)
        random.Random(11).shuffle(shuffled)
        actual, actual_stats = build(surfaces=shuffled, max_total_trees=2000)
        self.assertEqual(expected, actual)
        self.assertEqual(
            expected_stats["trees_heuristic_by_class"],
            actual_stats["trees_heuristic_by_class"],
        )

    def test_two_runs_are_identical(self):
        surfaces = [("forest", Polygon(box(0, 0, 300, 300)))]
        mapped = [node(1, 100, 100)]
        first, first_stats = build(surfaces=surfaces, mapped_raw=mapped,
                                   max_total_trees=5000)
        second, second_stats = build(surfaces=surfaces, mapped_raw=mapped,
                                     max_total_trees=5000)
        self.assertEqual(first, second)
        self.assertEqual(
            {key: value for key, value in first_stats.items()},
            {key: value for key, value in second_stats.items()},
        )

    def test_triangle_budget_thins_deterministically(self):
        park = Polygon(box(0, 0, 100, 100))  # 80 tree target, one tile
        placed, stats = build(
            surfaces=[("park", park)],
            max_total_trees=1000,
            triangle_budget=200,
        )
        self.assertGreater(stats["trees_triangle_thinned"], 0)
        self.assertLess(stats["trees_triangle_scale"], 1.0)
        self.assertLessEqual(stats["trees_triangles"], 200)
        self.assertEqual(stats["trees_triangles"], trees.tile_triangles(len(placed)))
        again, _ = build(
            surfaces=[("park", park)],
            max_total_trees=1000,
            triangle_budget=200,
        )
        self.assertEqual(placed, again)

    def test_triangle_counts_match_the_client_tier_formula(self):
        park = Polygon(box(0, 0, 2000, 2000))
        placed, stats = build(
            surfaces=[("park", park)],
            max_total_trees=100000,
            tile_size=1024.0,
            max_trees_per_tile=4000,
        )
        counts = per_tile_counts(placed, 1024.0)
        self.assertEqual(stats["trees_max_per_tile"], 4000)
        self.assertEqual(stats["trees_max_triangles_per_tile"], 48000)
        self.assertLessEqual(stats["trees_max_triangles_per_tile"], 48000)
        expected_triangles = sum(trees.tile_triangles(count) for count in counts.values())
        self.assertEqual(stats["trees_triangles"], expected_triangles)
        self.assertIsNone(stats["trees_triangle_budget"])
        self.assertTrue(all(count <= 4000 for count in counts.values()))

    def test_full_density_by_default(self):
        """No triangle budget and a 16 000 tile cap unless the caller asks (B-1)."""
        self.assertEqual(trees.MAX_TREES_PER_TILE, 16000)
        park = Polygon(box(0, 0, 400, 400))  # 1 280 park trees, one tile
        placed, stats = build(surfaces=[("park", park)], max_total_trees=100000)
        self.assertEqual(stats["trees_triangle_thinned"], 0)
        self.assertEqual(stats["trees_triangle_scale"], 1.0)
        self.assertEqual(stats["trees_tile_thinned"], 0)
        self.assertEqual(len(placed), stats["trees_heuristic"])
        self.assertGreater(len(placed), 1000)


if __name__ == "__main__":
    unittest.main()
