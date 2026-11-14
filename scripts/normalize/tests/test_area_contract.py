"""Unit tests for the B-2 area contract: explicit rectangle, tile grid, window.

Run with:
    .venv\\Scripts\\python.exe -m unittest scripts.normalize.tests.test_area_contract -v
or via:
    pnpm run test:data

The contract is deliberately rectangular: the old square `CITY_SIZE_M` could
not express the MKAD ring (19.03 x 15.40 km) without wasting tiles, and a square
also hid the fact that the tile grid was 12 x 12 while the normalised area was
12.0 km wide (edge tiles carried an empty strip).
"""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SCRIPTS = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(SCRIPTS))
sys.path.insert(0, str(SCRIPTS / "normalize"))
sys.path.insert(0, str(SCRIPTS / "ingest"))

from pyproj import Transformer  # noqa: E402

import geo_config  # noqa: E402
import geo_window  # noqa: E402


class AreaBoundsTests(unittest.TestCase):
    def test_pilot_bounds_are_the_existing_square(self):
        self.assertEqual(
            geo_config.area_bounds_m("pilot"), (-800.0, -800.0, 800.0, 800.0)
        )

    def test_city_bounds_are_the_b2_rectangle(self):
        self.assertEqual(
            geo_config.area_bounds_m("city"), (-11264.0, -9216.0, 12288.0, 10240.0)
        )

    def test_city_tile_range_is_the_437_tile_grid(self):
        min_tx, min_ty, max_tx, max_ty = geo_config.tile_range(
            geo_config.area_bounds_m("city"), geo_config.CITY_TILE_SIZE_M
        )
        self.assertEqual((min_tx, min_ty, max_tx, max_ty), (-11, -9, 11, 9))
        self.assertEqual((max_tx - min_tx + 1) * (max_ty - min_ty + 1), 437)

    def test_tile_grid_contains_the_bounds(self):
        bounds = geo_config.area_bounds_m("city")
        tile = geo_config.CITY_TILE_SIZE_M
        min_tx, min_ty, max_tx, max_ty = geo_config.tile_range(bounds, tile)
        minx, miny, maxx, maxy = bounds
        self.assertLessEqual(min_tx * tile, minx)
        self.assertGreaterEqual((max_tx + 1) * tile, maxx)
        self.assertLessEqual(min_ty * tile, miny)
        self.assertGreaterEqual((max_ty + 1) * tile, maxy)

    def test_pilot_tile_grid_stays_16_tiles(self):
        min_tx, min_ty, max_tx, max_ty = geo_config.tile_range(
            geo_config.area_bounds_m("pilot"), geo_config.TILE_SIZE_M
        )
        self.assertEqual((min_tx, min_ty, max_tx, max_ty), (-2, -2, 1, 1))
        self.assertEqual((max_tx - min_tx + 1) * (max_ty - min_ty + 1), 16)

    def test_city_bbox_matches_the_rectangle(self):
        min_lat, min_lon, max_lat, max_lon = geo_config.area_bbox("city")
        self.assertLess(min_lat, geo_config.PILOT_CENTER_LAT)
        self.assertGreater(max_lat, geo_config.PILOT_CENTER_LAT)
        self.assertLess(min_lon, geo_config.PILOT_CENTER_LON)
        self.assertGreater(max_lon, geo_config.PILOT_CENTER_LON)
        # ~23 km N-S, ~23 km E-W for the 21.5 x 19.5 km rectangle at this latitude
        self.assertAlmostEqual((max_lat - min_lat) * 111_320 / 1000, 19.4, delta=1.0)
        self.assertAlmostEqual((max_lon - min_lon) * 111_320 * 0.5937 / 1000, 23.5, delta=1.0)


class TileOwnershipTests(unittest.TestCase):
    """Points on the far edge must belong to the last tile, not vanish."""

    def setUp(self):
        self.bounds = geo_config.area_bounds_m("city")
        self.tile = geo_config.CITY_TILE_SIZE_M

    def test_upper_and_right_edges_are_owned_by_the_last_tile(self):
        self.assertEqual(
            geo_config.tile_index_for_point(12288.0, 0.0, self.bounds, self.tile), (11, 0)
        )
        self.assertEqual(
            geo_config.tile_index_for_point(0.0, 10240.0, self.bounds, self.tile), (0, 9)
        )
        self.assertEqual(
            geo_config.tile_index_for_point(12288.0, 10240.0, self.bounds, self.tile), (11, 9)
        )
        self.assertEqual(
            geo_config.tile_index_for_point(-11264.0, -9216.0, self.bounds, self.tile), (-11, -9)
        )

    def test_point_beyond_the_area_is_not_clamped(self):
        self.assertEqual(
            geo_config.tile_index_for_point(12288.5, 0.0, self.bounds, self.tile), (12, 0)
        )

    def test_every_expected_address_is_reachable(self):
        min_tx, min_ty, max_tx, max_ty = geo_config.tile_range(self.bounds, self.tile)
        for ty in range(min_ty, max_ty + 1):
            for tx in range(min_tx, max_tx + 1):
                centre_x = (tx + 0.5) * self.tile
                centre_y = (ty + 0.5) * self.tile
                self.assertEqual(
                    geo_config.tile_index_for_point(centre_x, centre_y, self.bounds, self.tile),
                    (tx, ty),
                )


class PreflightTests(unittest.TestCase):
    """The raw/trees pair must be rejected before any heavy processing."""

    def setUp(self):
        import normalize

        self.normalize = normalize
        self.window = list(geo_window.area_window_wgs84("city"))
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        (self.root / "data" / "raw").mkdir(parents=True, exist_ok=True)
        self.pbf = self.root / "data" / "raw" / "test.pbf"
        self.pbf.write_bytes(b"fake-pbf")
        self.sha = "a" * 64
        self.valid = {
            "area": "city",
            "epsg": geo_config.EPSG_UTM35N,
            "center": [geo_config.PILOT_CENTER_LAT, geo_config.PILOT_CENTER_LON],
            "window": self.window,
            "pbf": "test.pbf",
            "pbf_size": self.pbf.stat().st_size,
            "pbf_sha256": self.sha,
        }

    def tearDown(self):
        self._tmp.cleanup()

    def check(self, meta: dict, sha_result: str | None = None) -> str | None:
        with mock.patch.object(self.normalize, "ROOT", self.root), mock.patch.object(
            self.normalize,
            "_sha256_file",
            return_value=self.sha if sha_result is None else sha_result,
        ):
            return self.normalize._validate_input_meta(
                meta, "city", required=True, label="raw data"
            )

    def validate(self, sha_result: str | None = None, **overrides) -> str | None:
        meta = dict(self.valid)
        meta.update(overrides)
        return self.check(meta, sha_result)

    def test_valid_pair_passes(self):
        self.assertIsNone(self.validate())

    def test_approximate_window_is_rejected(self):
        # area_bbox() is the metres-per-degree approximation and is smaller
        # than the exact UTM window at the corners of the 21.5 km rectangle.
        self.assertIn("does not cover", self.validate(window=list(geo_config.area_bbox("city"))))

    def test_missing_field_is_rejected(self):
        meta = dict(self.valid)
        del meta["epsg"]
        self.assertIn("missing", self.check(meta))

    def test_missing_sha_is_rejected(self):
        meta = dict(self.valid)
        del meta["pbf_sha256"]
        self.assertIn("pbf_sha256", self.check(meta))

    def test_malformed_sha_is_rejected(self):
        self.assertIn("valid pbf_sha256", self.validate(pbf_sha256="xyz"))

    def test_sha_mismatch_is_rejected(self):
        self.assertIn("different SHA-256", self.validate(sha_result="b" * 64))

    def test_zero_pbf_size_is_rejected(self):
        self.assertIn("positive pbf_size", self.validate(pbf_size=0))

    def test_missing_pbf_file_is_rejected(self):
        self.assertIn("missing PBF", self.validate(pbf="does-not-exist.pbf"))

    def test_missing_center_is_rejected(self):
        meta = dict(self.valid)
        del meta["center"]
        self.assertIn("center", self.check(meta))

    def test_wrong_origin_is_rejected(self):
        self.assertIn("origin", self.validate(center=[53.9, 27.5]))

    def test_wrong_area_is_rejected(self):
        self.assertIn("area", self.validate(area="pilot"))

    def test_wrong_epsg_is_rejected(self):
        self.assertIn("EPSG", self.validate(epsg=4326))

    def test_pilot_legacy_mode_is_tolerant(self):
        self.assertIsNone(
            self.normalize._validate_input_meta(
                {}, "pilot", required=False, label="raw data"
            )
        )


class ExtractionWindowTests(unittest.TestCase):
    def setUp(self):
        import extract

        self.extract = extract
        self.extract.configure_window("city")
        self._to_wgs = Transformer.from_crs(
            geo_config.EPSG_UTM35N, geo_config.EPSG_WGS84, always_xy=True
        )
        self._to_utm = Transformer.from_crs(
            geo_config.EPSG_WGS84, geo_config.EPSG_UTM35N, always_xy=True
        )
        self.origin = self._to_utm.transform(
            geo_config.PILOT_CENTER_LON, geo_config.PILOT_CENTER_LAT
        )

    def tearDown(self):
        self.extract.configure_window("pilot")

    def _local_to_wgs(self, x: float, y: float) -> tuple[float, float]:
        lon, lat = self._to_wgs.transform(self.origin[0] + x, self.origin[1] + y)
        return lat, lon

    def test_city_window_contains_the_target_rectangle(self):
        minx, miny, maxx, maxy = geo_config.CITY_BOUNDS_M
        for x, y in ((minx, miny), (maxx, maxy), (minx, maxy), (maxx, miny)):
            lat, lon = self._local_to_wgs(x, y)
            self.assertTrue(
                self.extract.inside_window(lat, lon), f"corner {(x, y)} outside window"
            )

    def test_city_window_is_the_target_plus_the_halo(self):
        # 1 km halo on top of the rectangle: ~23.5 x 21.5 km, not a 12/22 km square
        min_lat, min_lon, max_lat, max_lon = (
            self.extract.MIN_LAT,
            self.extract.MIN_LON,
            self.extract.MAX_LAT,
            self.extract.MAX_LON,
        )
        height_km = (max_lat - min_lat) * 111_320 / 1000
        width_km = (max_lon - min_lon) * 111_320 * 0.5937 / 1000
        self.assertAlmostEqual(height_km, 21.456, delta=1.0)
        self.assertAlmostEqual(width_km, 25.504, delta=1.0)

    def test_pilot_window_keeps_the_historical_padding(self):
        self.extract.configure_window("pilot")
        min_lat, min_lon, max_lat, max_lon = geo_config.area_bbox("pilot")
        self.assertAlmostEqual(self.extract.MIN_LAT, min_lat - self.extract.PAD_LAT)
        self.assertAlmostEqual(self.extract.MAX_LON, max_lon + self.extract.PAD_LON)

    def test_enclosing_polygon_without_inside_vertices_is_kept(self):
        min_lat = self.extract.MIN_LAT - 1.0
        max_lat = self.extract.MAX_LAT + 1.0
        min_lon = self.extract.MIN_LON - 1.0
        max_lon = self.extract.MAX_LON + 1.0
        feature = {
            "geometry": {
                "type": "Polygon",
                "coordinates": [[
                    [min_lon, min_lat],
                    [max_lon, min_lat],
                    [max_lon, max_lat],
                    [min_lon, max_lat],
                    [min_lon, min_lat],
                ]],
            }
        }
        self.assertTrue(self.extract.feature_in_window(feature))

    def test_crossing_line_with_outside_vertices_is_kept(self):
        feature = {
            "geometry": {
                "type": "LineString",
                "coordinates": [
                    [self.extract.MIN_LON - 1.0, self.extract.MIN_LAT - 1.0],
                    [self.extract.MAX_LON + 1.0, self.extract.MAX_LAT + 1.0],
                ],
            }
        }
        self.assertTrue(self.extract.feature_in_window(feature))

    def test_far_feature_is_dropped(self):
        feature = {
            "geometry": {
                "type": "Point",
                "coordinates": [self.extract.MAX_LON + 5.0, self.extract.MAX_LAT + 5.0],
            }
        }
        self.assertFalse(self.extract.feature_in_window(feature))

    def test_empty_geometry_is_dropped(self):
        self.assertFalse(self.extract.feature_in_window({"geometry": {"type": "Point", "coordinates": []}}))


if __name__ == "__main__":
    unittest.main()
