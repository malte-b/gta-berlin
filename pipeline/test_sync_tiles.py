import hashlib
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import sync_tiles


class Client:
    def __init__(self, fail=False):
        self.calls = []
        self.fail = fail

    def list_objects(self, *_args, **_kwargs):
        return []

    def fput_object(self, bucket, key, path, **kwargs):
        self.calls.append((key, kwargs))
        if self.fail and key.endswith('terrain.bin'):
            raise OSError('simulated transfer failure')


class SyncTests(unittest.TestCase):
    def files(self, root):
        (root / 'tiles' / 'a').mkdir(parents=True)
        (root / 'tiles' / 'a' / 'terrain.bin').write_bytes(b'terrain')
        (root / 'tiles' / 'a' / 'tile.json').write_text('{}')
        (root / 'world.json').write_text('{"tiles":{}}')

    def args(self, dry=False):
        return SimpleNamespace(endpoint='https://storage.example', profile='tiles', dry_run=dry, delete=False)

    def test_world_index_is_published_after_assets_and_tile_manifests(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(sync_tiles, 'OUT', folder):
            self.files(Path(folder))
            client = Client()
            sync_tiles.sync_endpoint(self.args(), 's3://tiles', client)
            self.assertEqual([key for key, _ in client.calls], ['tiles/a/terrain.bin', 'tiles/a/tile.json', 'world.json'])
            self.assertEqual(client.calls[-1][1]['metadata']['Cache-Control'], 'no-cache')
            self.assertEqual(client.calls[0][1]['content_type'], 'application/octet-stream')

    def test_failed_asset_does_not_publish_manifests(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(sync_tiles, 'OUT', folder):
            self.files(Path(folder))
            client = Client(fail=True)
            with self.assertRaises(RuntimeError):
                sync_tiles.sync_endpoint(self.args(), 's3://tiles', client)
            self.assertEqual([key for key, _ in client.calls], ['tiles/a/terrain.bin'])

    def test_dry_run_changes_neither_storage_nor_index(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(sync_tiles, 'OUT', folder):
            root = Path(folder)
            self.files(root)
            before = (root / 'world.json').read_bytes()
            client = Client()
            sync_tiles.sync_endpoint(self.args(True), 's3://tiles', client)
            self.assertEqual(client.calls, [])
            self.assertEqual((root / 'world.json').read_bytes(), before)

    def test_content_check_ignores_clone_timestamp_changes(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'asset.bin'
            path.write_bytes(b'unchanged')
            remote = SimpleNamespace(size=9, etag=hashlib.md5(b'unchanged').hexdigest(), last_modified=datetime(2000, 1, 1, tzinfo=timezone.utc))
            self.assertTrue(sync_tiles.same_content(path, remote))
            path.write_bytes(b'different')
            self.assertFalse(sync_tiles.same_content(path, remote))


if __name__ == '__main__':
    unittest.main()
