import json
import tempfile
import unittest
from pathlib import Path

import stitch_water


class WaterSeamTests(unittest.TestCase):
    def build(self, root, right=1.05):
        tiles = {}
        for key, x0, y, cuts in (("0_0", 0, 1.0, [-1000, 0]), ("1_0", 1000, right, [-1000, -600, 0])):
            folder = root / 'tiles' / key
            folder.mkdir(parents=True)
            vertices, indices = [], []
            for z0, z1 in zip(cuts, cuts[1:]):
                start = len(vertices)
                vertices += [[x0, z0, y], [x0 + 1000, z0, y], [x0 + 1000, z1, y], [x0, z1, y]]
                indices += [start, start + 2, start + 1, start, start + 3, start + 2]
            (folder / 'water.json').write_text(json.dumps({'mesh': {'v': vertices, 'i': indices, 'r': []}}))
            (folder / 'tile.json').write_text(json.dumps({'world': [x0, 0, -1000, x0 + 1000, 10, 0], 'water': {'file': 'water.json'}}))
            tiles[key] = {'dir': 'tiles/' + key, 'v': 'old'}
        (root / 'world.json').write_text(json.dumps({'tiles': tiles}))

    def test_seam_with_different_edge_subdivisions_is_continuous_and_repeatable(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            self.build(root)
            self.assertEqual(stitch_water.stitch(folder), 2)
            for key, original in (('0_0', 1.0), ('1_0', 1.05)):
                mesh = json.loads((root / 'tiles' / key / 'water.json').read_text())['mesh']
                for x, _z, y in mesh['v']:
                    self.assertAlmostEqual(y, 1.025 if x == 1000 else original)
                self.assertTrue(all(y == original for y in mesh['rawY']))
            before = (root / 'world.json').read_bytes()
            self.assertEqual(stitch_water.stitch(folder), 0)
            self.assertEqual(before, (root / 'world.json').read_bytes())

    def test_lock_step_is_preserved(self):
        with tempfile.TemporaryDirectory() as folder:
            self.build(Path(folder), right=2.0)
            self.assertEqual(stitch_water.stitch(folder), 0)


if __name__ == '__main__':
    unittest.main()
