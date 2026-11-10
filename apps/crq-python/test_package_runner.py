"""Offline runner archive tests; no build, network, or host mutation."""
import importlib.util
import json
from pathlib import Path
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('package_runner', Path(__file__).parent / 'ops/package-runner.py')
package_runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(package_runner)


class PackageRunnerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.stage = self.base / 'stage'
        (self.stage / 'dist/queue-runner').mkdir(parents=True)
        (self.stage / 'dist/queue-runner/crq.js').write_text('runner')
        (self.stage / 'package.json').write_text('{}')
        native = self.stage / 'node_modules/fs-ext/build/Release'
        native.mkdir(parents=True)
        (self.stage / 'node_modules/fs-ext/package.json').write_text('{"version":"2.1.1"}')
        (native / 'fs_ext.node').write_bytes(b'\x7fELF\x02\x01' + bytes(12) + b'\x3e\x00')
        self.sha = 'a' * 40

    def test_package_contains_manifest_and_does_not_overwrite(self):
        output = self.base / 'runner.tar.gz'
        expected = package_runner.package(self.stage, output, self.sha)
        with tarfile.open(output) as archive:
            manifest = json.load(archive.extractfile('crq-' + self.sha + '/artifact-manifest.json'))
            self.assertEqual(expected, manifest)
            self.assertIn('dist/queue-runner/crq.js', [item['path'] for item in manifest['files']])
        with self.assertRaises(FileExistsError):
            package_runner.package(self.stage, output, self.sha)

    def test_rejects_external_symlink_and_preserves_output(self):
        (self.stage / 'link').symlink_to(self.base / 'outside')
        with self.assertRaisesRegex(ValueError, 'absolute symlink'):
            package_runner.package(self.stage, self.base / 'runner.tar.gz', self.sha)
        self.assertFalse((self.base / 'runner.tar.gz').exists())

    def test_accepts_internal_symlink_and_rejects_escaping_relative_link(self):
        (self.stage / 'link').symlink_to('package.json')
        self.assertEqual(next(e for e in package_runner.inventory(self.stage) if e['path'] == 'link')['target'], 'package.json')
        (self.stage / 'bad').symlink_to('../outside')
        with self.assertRaisesRegex(ValueError, 'escaping or broken'):
            package_runner.inventory(self.stage)

    def test_rejects_wrong_native_architecture(self):
        (self.stage / 'node_modules/fs-ext/build/Release/fs_ext.node').write_bytes(b'not elf')
        with self.assertRaisesRegex(ValueError, 'linux-x64 ELF'):
            package_runner.package(self.stage, self.base / 'runner.tar.gz', self.sha)
