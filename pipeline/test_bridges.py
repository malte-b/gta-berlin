"""Regressions for surveyed bridge levels and geometry; standard-library unittest."""
import copy
import math
import json
import struct
import tempfile
import unittest
from pathlib import Path

import bridgefit
import bridges
import bridge_surfaces
from shapely import Polygon


class BridgeTests(unittest.TestCase):
    def deck(self, level=1, offset=0, outline="one", z=0, kind="road"):
        return {"k": kind, "layer": level, "outline": outline,
                "p": [[x, z, 34 + x * 0.01 + offset, 4, 4] for x in range(41)]}

    def test_parallel_pavement_uses_carriageway_profile(self):
        road, path = self.deck(), self.deck(offset=0.8, z=5, kind="path")
        bridgefit.fit_decks([road, path])
        for a, b in zip(road["p"], path["p"]):
            self.assertAlmostEqual(a[2], b[2], places=3)

    def test_stacked_levels_and_separate_bridges_are_not_merged(self):
        decks = [self.deck(), self.deck(level=2, offset=1), self.deck(outline="another", offset=0.7, z=5)]
        self.assertEqual(sorted(map(len, bridgefit._clusters(decks))), [1, 1, 1])
        before = copy.deepcopy(decks)
        bridgefit.fit_decks(decks)
        for a, b in zip(before, decks):
            self.assertAlmostEqual(a["p"][20][2], b["p"][20][2], places=2)

    def test_slope_limit_preserves_endpoints_and_bounds_every_segment(self):
        heights = [34, 35, 32, 36, 34.2]
        ds = [1, 1, 1, 0.5]
        fitted = bridges._limit_slope(heights, 0.12, ds)
        self.assertIsNotNone(fitted)
        self.assertEqual((fitted[0], fitted[-1]), (heights[0], heights[-1]))
        for a, b, distance in zip(fitted, fitted[1:], ds):
            self.assertLessEqual(abs(a - b), 0.12 * distance + 1e-8)

    def test_cadastre_outline_constrains_guessed_width(self):
        road = {"kind": "road", "layer": 1, "abut": (True, True), "st": [(x, 0, 34, 8, 8) for x in range(11)]}
        outline = {"rings": [[(-1, -3), (11, -3), (11, 3), (-1, 3)]]}
        fitted = bridges._fill_outlines([road], [outline])
        self.assertEqual(fitted[0]["st"][5][3:], (3, 3))

    def test_sharp_bend_geometry_is_finite_and_height_is_on_triangles(self):
        pts = [(0, 0, 3, 2, 4), (8, 0, 3.4, 3, 4), (14, 6, 3.8, 3, 2), (14, 15, 4, 2, 2)]
        es = bridges.edges(pts)
        self.assertTrue(all(math.isfinite(v) for s in es for p in s for v in p))
        index = bridges.SurfaceIndex([{"st": pts}])
        a, b, c = es[0][0], es[1][0], es[1][1]
        centre = [sum(p[i] for p in (a, b, c)) / 3 for i in range(3)]
        self.assertAlmostEqual(index.height(*centre[:2]), centre[2], places=5)
        self.assertIsNone(index.height(8, -8))

    def test_covered_bridge_arcade_is_still_walkable(self):
        self.assertEqual(bridges.kind_of({"bridge": "yes", "highway": "footway", "tunnel": "building_passage"}), "path")
        self.assertIsNone(bridges.kind_of({"bridge": "yes", "highway": "footway", "tunnel": "yes"}))

    def test_surveyed_polygon_is_one_continuous_surface(self):
        roads = [{"kind": "road", "layer": 1, "outline": "one", "abut": (True, True),
                  "st": [(x, z, 34 + x * 0.01, 2, 2) for x in range(41)]} for z in (-3, 3)]
        outline = {"id": "one", "rings": [[(0, -8), (40, -8), (40, 8), (0, 8)]]}
        assembled = bridge_surfaces.assemble(roads, [outline])
        self.assertEqual(len(assembled), 1)
        mesh = bridge_surfaces.mesh_for(assembled[0])
        index = bridges.SurfaceIndex([{"mesh": mesh}])
        for x in (2, 10, 20, 38):
            for z in (-7, 0, 7):
                self.assertAlmostEqual(index.height(x, z), 34 + x * 0.01, places=3)
        for a, b, c in zip(mesh["i"][::3], mesh["i"][1::3], mesh["i"][2::3]):
            p, q, r = [mesh["v"][i] for i in (a, b, c)]
            self.assertLess((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]), 0)

    def test_clipping_preserves_island_holes_and_tile_seams(self):
        road = {"kind": "road", "layer": 1, "st": [(x, 0, 34 + x * 0.01, 8, 8) for x in range(41)]}
        shape = Polygon([(0, -8), (40, -8), (40, 8), (0, 8)], [[(12, -2), (16, -2), (16, 2), (12, 2)]])
        deck = {"_shape": shape, "_profile": bridge_surfaces.Profile([road])}
        west = bridges.SurfaceIndex([{"mesh": bridge_surfaces.mesh_for(deck, (-1, -10, 20, 10))}])
        east = bridges.SurfaceIndex([{"mesh": bridge_surfaces.mesh_for(deck, (20, -10, 41, 10))}])
        self.assertIsNone(west.height(14, 0))
        for z in (-7, -3, 0, 5, 7):
            self.assertAlmostEqual(west.height(20, z), east.height(20, z), places=4)

    def test_railway_over_road_keeps_its_own_footprint(self):
        road = {"kind": "road", "layer": 1, "outline": "one", "abut": (True, True),
                "st": [(x, 0, 34, 2, 2) for x in range(41)]}
        rail = {"kind": "rail", "layer": 1, "outline": "one", "abut": (False, False),
                "st": [(20, z, 40, 2, 2) for z in range(-20, 21)]}
        outline = {"id": "one", "rings": [[(0, -8), (40, -8), (40, 8), (0, 8)]]}
        out = bridge_surfaces.assemble([road, rail], [outline])
        self.assertEqual(len(out), 2)
        self.assertTrue(out[0]["assembled"])
        self.assertIs(out[1], rail)

    def test_upper_track_uses_upper_scan_returns_not_the_road(self):
        road = {"kind": "road", "layer": 1, "outline": "one", "st": [(x, 5, 34, 3, 3) for x in range(2, 38)]}
        rail = {"kind": "rail", "layer": 3, "outline": "one", "st": [(x, 5, 34, 2, 2) for x in range(2, 38)]}
        bridges.fit_upper_levels([road, rail], [34.0] * 400, [42.0] * 400, (0, 0, 40, 10))
        self.assertTrue(all(abs(p[2] - 42) < 0.01 for p in rail["st"]))
        self.assertTrue(all(p[2] == 34 for p in road["st"]))

    def test_carriageways_meeting_end_to_end_are_not_one_folded_deck(self):
        meta = lambda i: {"osm": [i]}
        north = ("road", 1, [(0, 0, 3), (0, -30, 3)], False, meta(1))
        back = ("road", 1, [(0, -30, 3), (8, 0, 3)], False, meta(2))      # a hairpin
        on = ("road", 1, [(0, -30, 3), (2, -60, 3)], False, meta(3))      # straight on
        self.assertEqual(sorted(len(c[1]) for c in bridges._chains([north, back])), [2, 2])
        self.assertEqual([len(c[1]) for c in bridges._chains([north, on])], [3])
        # at a fork the way straight on joins, the one turning back does not
        self.assertEqual(sorted(c[5]["osm"] for c in bridges._chains([north, back, on])), [[1, 3], [2]])

    def test_low_hall_below_a_viaduct_does_not_hide_its_deck(self):
        from geo import ORIGIN_E, ORIGIN_N, utm33_inv
        corners = [(2, 2), (8, 2), (8, 8), (2, 8)]
        nodes = {i: utm33_inv(x + ORIGIN_E, ORIGIN_N - z) for i, (x, z) in enumerate(corners)}
        k = 5 * 10 + 5

        def mask(tags):
            return bridges.hall_mask({1: ([0, 1, 2, 3, 0], tags)}, nodes, (0, 0, 10, 10))

        # U1 along Skalitzer Strasse: the viaduct drawn as a roof under its tracks
        viaduct = mask({"building": "roof", "layer": "1", "min_height": "6"})
        self.assertFalse(bridges.under_hall(viaduct, k, 2))
        self.assertTrue(bridges.under_hall(viaduct, k, 1))
        # a 6 m building without a layer carrying the tracks on its roof
        self.assertFalse(bridges.under_hall(mask({"building": "train_station", "height": "6"}), k, 1))
        # Zoo: a tall hall spans its tracks whatever the layers say
        zoo = mask({"building": "train_station", "layer": "1", "height": "20", "min_height": "8"})
        self.assertTrue(bridges.under_hall(zoo, k, 2))
        # no height mapped: a hall, as before
        self.assertTrue(bridges.under_hall(mask({"building": "train_station"}), k, 3))
        self.assertFalse(bridges.under_hall(mask({"building": "train_station"}), 0, 1))

    def test_lighting_register_floodlights_are_not_streetlamp_masts(self):
        import street_furniture
        self.assertFalse(street_furniture.is_street_lamp({"leuchtentyp": "Anstrahlung frei, Boden"}))
        self.assertFalse(street_furniture.is_street_lamp({"leuchtentyp": "Schaltkasten"}))
        self.assertTrue(street_furniture.is_street_lamp({"leuchtentyp": "Aufsatzleuchte"}))

    def test_roundabout_keeps_its_measured_curved_profile(self):
        st = [(0, 0, 34, 2, 2), (10, 0, 34.2, 2, 2), (10, 10, 34.4, 2, 2), (0, 10, 34.2, 2, 2), (0, 0, 34, 2, 2)]
        road = {"kind": "road", "outline": "loop", "layer": 1, "st": st, "abut": (False, False)}
        outline = {"id": "loop", "rings": [[(-2, -2), (12, -2), (12, 12), (-2, 12)]]}
        result = bridge_surfaces.assemble([road], [outline])
        self.assertEqual(result[0]["st"], st)
        data = {"k": "road", "p": [list(p) for p in st]}
        bridgefit.fit_decks([data])
        self.assertEqual([p[2] for p in data["p"]], [p[2] for p in st])

    def test_furniture_alignment_keeps_binary_columns_and_is_idempotent(self):
        import build_world
        import landings
        import navgrid
        with tempfile.TemporaryDirectory() as out:
            root = Path(out)
            terrain, *_ = build_world.Terrain([-0.6] * 441, 21, 21, 0, 0).to_bytes()
            (root / "terrain.bin").write_bytes(terrain)
            nav, _ = navgrid.to_bytes(0, 0, 1, 20, 20, [-0.6] * 400, bytearray(400))
            (root / "nav.bin").write_bytes(nav)
            (root / "water.json").write_text(json.dumps({"cell": 1, "minX": 0, "minZ": 0,
                "rows": [[r, [[0, 20, 0]]] for r in range(20)]}))
            (root / "bridges.json").write_text(json.dumps({"decks": [{"k": "road", "t": 1,
                "p": [[10, 10, 3, 5, 5], [19, 10, 3, 5, 5]]}]}))
            raw = b"BPR1" + struct.pack("<I", 2)
            for column in ([9.6, 2], [10, 10], [-0.6, -0.6], [1.2, 2.4]):
                raw += struct.pack("<2f", *column)
            (root / "props.bin").write_bytes(raw + struct.pack("<2H", 0, 0))
            manifest = {"terrain": {"file": "terrain.bin"}, "nav": {"file": "nav.bin", "nx": 20, "cell": 1},
                        "water": {"file": "water.json"}, "bridges": {"file": "bridges.json"},
                        "props": {"file": "props.bin", "count": 2, "kinds": ["street_lamp"]}}
            landings.rebase_props(out, manifest)
            result = (root / "props.bin").read_bytes()
            self.assertEqual(struct.unpack_from("<I", result, 4)[0], 1)
            self.assertEqual(len(result), 26)
            x, z, y, yaw = struct.unpack_from("<4f", result, 8)
            self.assertGreater(x, 10)
            self.assertLess(x - 9.6, 2)
            self.assertAlmostEqual(y, 3)
            self.assertAlmostEqual(yaw, 1.2, places=5)
            self.assertEqual(manifest["props"]["count"], 1)
            self.assertEqual(landings.rebase_props(out, manifest), 0)
            self.assertEqual((root / "props.bin").read_bytes(), result)


if __name__ == "__main__":
    unittest.main()
