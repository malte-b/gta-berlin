import json
import tempfile
import unittest
from unittest.mock import patch

from shapely import Polygon, Point

import shorelines
import bridges


class ShorelineTests(unittest.TestCase):
    def test_diagonal_shore_is_clipped_not_stair_stepped(self):
        # A diagonal river edge through a 24 m synthetic survey tile.
        wet = Polygon([(-10, -10), (34, -10), (-10, 34)])
        size = 24
        heights = [31.4 if wet.contains(Point(c + 0.5, r + 0.5)) else 35.0
                   for r in range(size) for c in range(size)]
        with tempfile.TemporaryDirectory() as out, patch.object(shorelines, 'water_polygons', return_value=wet):
            meta = shorelines.build({}, heights, (0, 0, size, size), [32.0], 1, (0, 0, size, size), out)
            self.assertIsNotNone(meta)
            with open(out + '/shorelines.json') as fh:
                data = json.load(fh)
        top = data['top']
        for i in range(0, len(top['i']), 3):
            tri = Polygon([top['v'][j][:2] for j in top['i'][i:i + 3]])
            self.assertLess(tri.intersection(wet).area, 1e-5, 'land must never protrude into the mapped water')
        for x, z, _y in data['walls']['v']:
            self.assertLess(wet.boundary.distance(Point(x, z)), 0.002, 'quay vertices follow the vector shoreline')
        field = bridges.SurfaceIndex([{'mesh': top}])
        # Both points fall in the replacement band, on opposite sides of the shore.
        self.assertIsNotNone(field.height(13, 13))
        self.assertIsNone(field.height(10, 10))
        self.assertGreater(meta['triangles'], 0)

    def test_ground_behind_a_quay_does_not_dip_below_its_top(self):
        # River west of x = 10; the two columns behind the wall sunk under
        # the water as the raster's wet cells, as along the Spreekanal.
        wet = Polygon([(-10, -10), (10, -10), (10, 34), (-10, 34)])
        size = 24
        heights = [31.4 if c + 0.5 < 10 or c in (10, 11) else 35.0 for r in range(size) for c in range(size)]
        with tempfile.TemporaryDirectory() as out, patch.object(shorelines, 'water_polygons', return_value=wet):
            shorelines.build({}, heights, (0, 0, size, size), [32.0], 1, (0, 0, size, size), out)
        for r in range(4, 20):
            for c in (10, 11, 12):
                self.assertGreater(heights[r * size + c], 33.0, 'no pit along the top of the quay wall')


class RetainingWallTests(unittest.TestCase):
    def test_a_diagonal_wall_is_one_straight_line_not_a_staircase(self):
        import retaining
        from shapely import LineString
        size = 40
        # 2 m up where x + z > 40: the raster draws the wall as stairs
        heights = [36.0 if c + r > size else 34.0 for r in range(size) for c in range(size)]
        _up, segs = retaining.find(heights, (0, 0, size, size))
        self.assertTrue(segs)
        diagonal = LineString([(0, size + 1), (size + 1, 0)])
        for a, b, hia, loa, hib, lob in segs:
            self.assertLess(diagonal.distance(LineString([a, b])), retaining.SIMPLIFY + 0.3, 'the wall follows the diagonal')
            self.assertAlmostEqual(hia, 36.0)
            self.assertAlmostEqual(loa, 34.0)
        with tempfile.TemporaryDirectory() as out:
            meta = retaining.build(heights, (0, 0, size, size), (0, 0, size, size), out)
            with open(out + '/shorelines.json') as fh:
                data = json.load(fh)
        self.assertGreater(meta['retaining']['faces'], 0)
        self.assertTrue(data['walls']['i'] and data['top']['i'])


class WaterLevelTests(unittest.TestCase):
    def test_a_reach_is_one_level_across_blocks(self):
        import hydrography
        import water
        from geo import ORIGIN_H
        from shapely import box
        nx, nz = 96, 48
        # two 48 m blocks measured 1.7 m apart, one reach over both
        base = [30.0, 31.7]
        reach = box(0, 0, nx, nz)
        lev = hydrography.Levels(base, [(reach, 30.75)], {k: 30.75 for k in range(nx * nz)}, reach, [])
        self.assertEqual(water.level_at(lev, 2, nx, nz, 90, 10), 30.75)
        with tempfile.TemporaryDirectory() as out:
            water.write(bytearray([1]) * (nx * nz), lev, 2, nx, nz, 0, 0, 0, 0, nx, nz, out, reach)
            with open(out + '/water.json') as fh:
                data = json.load(fh)
        self.assertEqual({round(v[2] + ORIGIN_H, 2) for v in data['mesh']['v']}, {30.75})
        self.assertEqual({run[2] for _row, runs in data['rows'] for run in runs}, {round((30.75 - ORIGIN_H) * 100)})

    def test_measured_level_is_the_dominant_band_not_the_bank(self):
        import hydrography
        # 0.05 m bins: a flat surface at 32.35 m and a scatter of quay returns
        hist = {round(32.35 / 0.05): 400, round(32.40 / 0.05): 120, round(33.5 / 0.05): 90, round(31.0 / 0.05): 30}
        self.assertAlmostEqual(hydrography.measured_level(hist), 32.35, places=2)


if __name__ == '__main__':
    unittest.main()
