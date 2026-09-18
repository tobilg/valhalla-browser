"""Validate dataset packaging against archives produced by the pinned native builder."""
import argparse
import importlib.util
import io
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('build_dataset', ROOT / 'scripts/build-dataset.py')
dataset = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dataset)


class DatasetTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.manifests = [json.loads((ROOT / 'fixtures' / prefix / 'manifest.json').read_text())
                         for prefix in ('', 'region')]
        cls.archives = [ROOT / 'public/datasets' / m['release'] / 'graph.tar' for m in cls.manifests]
        for archive in cls.archives:
            if not archive.is_file():
                raise RuntimeError('Build the native fixture archives first: pnpm run data && pnpm run data:region')

    def test_reads_real_native_indexes_and_payload_hashes(self):
        for manifest, archive in zip(self.manifests, self.archives):
            with self.subTest(release=manifest['release']):
                index, tiles = dataset.inspect_archive(archive)
                self.assertEqual(tiles, manifest['tiles'])
                self.assertEqual(str(len(index)), manifest['archive']['indexSize'])
                self.assertEqual(dataset.sha(index), manifest['archive']['indexSha256'])
                self.assertEqual('"' + dataset.digest(archive) + '"', manifest['archive']['etag'])

    def test_rejects_inconsistent_native_index_and_tile_header(self):
        original = self.archives[0].read_bytes()
        tile_offset = struct.unpack_from('<Q', original, 512)[0]
        for name, location, replacement in [
            ('index-offset', 512, struct.pack('<Q', tile_offset + 1)),
            ('index-size', 524, struct.pack('<I', 1)),
            ('tile-graph-id', tile_offset, b'\xff' * 8),
        ]:
            with self.subTest(fault=name), tempfile.TemporaryDirectory() as directory:
                payload = bytearray(original)
                payload[location:location + len(replacement)] = replacement
                archive = Path(directory) / 'invalid.tar'
                archive.write_bytes(payload)
                with self.assertRaises(ValueError):
                    dataset.inspect_archive(archive)

    def test_upstream_extract_builder_reproduces_the_real_regional_archive(self):
        source = ROOT / 'build/sources/valhalla'
        pins = json.loads((ROOT / 'versions.json').read_text())
        revision = subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip()
        self.assertEqual(revision, pins['valhalla'])
        manifest = self.manifests[1]
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory)
            archive = work / 'graph.tar'
            config = work / 'config.json'
            config.write_text(json.dumps({'mjolnir': {
                'tile_dir': str(self.archives[1].parent / 'tiles'), 'tile_extract': str(archive),
            }}))
            subprocess.run([sys.executable, str(source / 'scripts/valhalla_build_extract'), '-c', str(config)],
                           check=True, capture_output=True,
                           env={**os.environ, 'SOURCE_DATE_EPOCH': '1789603200'})
            _, tiles = dataset.inspect_archive(archive)
            self.assertEqual(tiles, manifest['tiles'])
            self.assertEqual(dataset.digest(archive), dataset.digest(self.archives[1]))

    def test_rejects_ordinary_and_compressed_tar(self):
        with tempfile.TemporaryDirectory() as directory:
            for mode in ('w:', 'w:gz'):
                archive = Path(directory) / 'not-native.tar'
                with tarfile.open(archive, mode) as output:
                    entry = tarfile.TarInfo('2/000/001.gph')
                    entry.size = 272
                    output.addfile(entry, io.BytesIO(bytes(272)))
                with self.assertRaises((ValueError, tarfile.ReadError)):
                    dataset.inspect_archive(archive)

    def test_immutable_publish_is_complete_repeatable_and_never_overwrites(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'source.json'
            source.write_bytes(b'{"value":1}\n')
            release = root / 'releases/example'
            files = {'manifest.json': source, 'nested/config.json': source}
            dataset.publish_files(release, files)
            dataset.publish_files(release, files)
            source.write_bytes(b'{"value":2}\n')
            with self.assertRaisesRegex(ValueError, 'immutable'):
                dataset.publish_files(release, files)
            self.assertEqual((release / 'manifest.json').read_bytes(), b'{"value":1}\n')
            self.assertEqual(list(release.parent.glob('.dataset-*')), [])

    def test_failed_copy_leaves_no_partial_release(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaises(FileNotFoundError):
                dataset.publish_files(root / 'release', {'config.json': root / 'missing'})
            self.assertFalse((root / 'release').exists())
            self.assertEqual(list(root.glob('.dataset-*')), [])

    def test_coverage_requires_finite_ordered_coordinates(self):
        self.assertEqual(dataset.bbox('-122.6,37.6,-122.2,37.9'), [-122.6, 37.6, -122.2, 37.9])
        for value in ('nan,0,1,1', '0,0,inf,1', '170,-1,-170,1', '0,0,0,1', '-181,0,1,1', '0,0,1'):
            with self.subTest(value=value), self.assertRaises(argparse.ArgumentTypeError):
                dataset.bbox(value)


if __name__ == '__main__':
    unittest.main()
