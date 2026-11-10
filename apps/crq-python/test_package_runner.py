"""Offline runner archive tests; no build, network, or host mutation."""
import importlib.util
import io
import json
from pathlib import Path
import shutil
import tarfile
import tempfile
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location(
    'package_runner', Path(__file__).parent / 'ops/package-runner.py')
package_runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(package_runner)

ELF = b'\x7fELF\x02\x01' + bytes(12) + b'\x3e\x00'


class PackageRunnerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.stage = self.base / 'stage'
        (self.stage / 'dist/queue-runner').mkdir(parents=True)
        (self.stage / 'dist/queue-runner/crq.js').write_text('runner')
        (self.stage / 'package.json').write_text('{"name":"runner","version":"0.0.0"}')
        native = self.stage / 'node_modules/fs-ext/build/Release'
        native.mkdir(parents=True)
        (self.stage / 'node_modules/fs-ext/package.json').write_text(
            '{"name":"fs-ext","version":"2.1.1"}')
        (native / 'fs_ext.node').write_bytes(ELF)
        self.sha = 'a' * 40
        self.lockfile = self.base / 'pnpm-lock.yaml'
        self.lockfile.write_text('lockfileVersion: 9.0\n')

    def provenance(self):
        facts = package_runner.staging_facts(self.stage)
        return {
            'schema_version': 1,
            'source_sha': self.sha,
            'lockfile_sha256': package_runner.sha256_file(self.lockfile),
            'runtime': {'node_version': 'v24.21.0', 'node_major': 24,
                        'node_abi': '137', 'platform': 'linux', 'arch': 'x64'},
            'toolchain': {'pnpm_version': '12.8.1',
                          'install_command': 'pnpm install --frozen-lockfile --offline',
                          'build_command': 'pnpm run build',
                          'deploy_command': 'pnpm deploy --prod --offline <staging>'},
            'dependencies': facts['dependencies'],
            'fs_ext': facts['fs_ext'],
        }

    def make_archive(self, output=None):
        output = output or self.base / 'runner.tar.gz'
        manifest = package_runner.package(self.stage, output, self.sha,
                                          self.provenance(), lockfile=self.lockfile)
        return manifest, output

    def write_fake_node(self, body):
        fake = self.base / 'node'
        fake.write_text('#!/bin/sh\n' + body)
        fake.chmod(0o755)
        return str(fake)

    def repack(self, source, target, mutate):
        with tempfile.TemporaryDirectory() as temp:
            with tarfile.open(source) as archive:
                archive.extractall(temp)
            root = Path(temp) / ('crq-' + self.sha)
            mutate(root)
            with tarfile.open(target, 'w:gz') as archive:
                archive.add(root, arcname='crq-' + self.sha)
        return target

    def test_package_contains_manifest_and_does_not_overwrite(self):
        manifest, output = self.make_archive()
        self.assertEqual(manifest['schema_version'], 2)
        self.assertEqual(manifest['source_sha'], self.sha)
        self.assertEqual(manifest['provenance']['lockfile_sha256'],
                         package_runner.sha256_file(self.lockfile))
        self.assertEqual(manifest['content_sha256'],
                         package_runner.content_digest(manifest['files']))
        paths = [item['path'] for item in manifest['files']]
        self.assertIn('dist/queue-runner/crq.js', paths)
        self.assertIn('dist/queue-runner', paths)
        self.assertIn('node_modules/fs-ext/build/Release/fs_ext.node', paths)
        sidecar = Path(str(output) + '.sha256')
        self.assertEqual(sidecar.read_text().split()[0],
                         package_runner.sha256_file(output))
        with tarfile.open(output) as archive:
            stored = json.load(archive.extractfile(
                'crq-' + self.sha + '/artifact-manifest.json'))
        self.assertEqual(stored, manifest)
        with self.assertRaises(FileExistsError):
            self.make_archive()

    def test_rejects_external_symlink_and_preserves_output(self):
        (self.stage / 'link').symlink_to(self.base / 'outside')
        output = self.base / 'runner.tar.gz'
        with self.assertRaisesRegex(ValueError, 'absolute symlink'):
            self.make_archive(output)
        self.assertFalse(output.exists())
        self.assertFalse(Path(str(output) + '.sha256').exists())

    def test_accepts_internal_symlink_and_rejects_escaping_relative_link(self):
        (self.stage / 'link').symlink_to('package.json')
        self.assertEqual(next(entry for entry in package_runner.inventory(self.stage)
                              if entry['path'] == 'link')['target'], 'package.json')
        (self.stage / 'bad').symlink_to('../outside')
        with self.assertRaisesRegex(ValueError, 'escaping or broken'):
            package_runner.inventory(self.stage)

    def test_rejects_wrong_native_architecture(self):
        (self.stage / 'node_modules/fs-ext/build/Release/fs_ext.node').write_bytes(b'not elf')
        with self.assertRaisesRegex(ValueError, 'linux-x64 ELF'):
            self.make_archive()

    def test_rejects_provenance_source_mismatch(self):
        provenance = self.provenance()
        provenance['source_sha'] = 'b' * 40
        with self.assertRaisesRegex(ValueError, 'source_sha'):
            package_runner.package(self.stage, self.base / 'runner.tar.gz', self.sha,
                                   provenance, lockfile=self.lockfile)

    def test_rejects_provenance_lockfile_mismatch(self):
        provenance = self.provenance()
        self.lockfile.write_text('lockfileVersion: 9.1\n')
        with self.assertRaisesRegex(ValueError, 'lockfile_sha256'):
            package_runner.package(self.stage, self.base / 'runner.tar.gz', self.sha,
                                   provenance, lockfile=self.lockfile)

    def test_rejects_provenance_dependency_mismatch(self):
        provenance = self.provenance()
        provenance['dependencies']['other'] = '1.0.0'
        with self.assertRaisesRegex(ValueError, 'dependencies do not match'):
            package_runner.package(self.stage, self.base / 'runner.tar.gz', self.sha,
                                   provenance, lockfile=self.lockfile)

    def test_rejects_provenance_fs_ext_mismatch(self):
        provenance = self.provenance()
        provenance['fs_ext']['native_sha256'] = 'c' * 64
        with self.assertRaisesRegex(ValueError, 'fs_ext does not match'):
            package_runner.package(self.stage, self.base / 'runner.tar.gz', self.sha,
                                   provenance, lockfile=self.lockfile)

    def test_package_accepts_pnpm_symlinked_fs_ext(self):
        pnpm = self.stage / 'node_modules/.pnpm/fs-ext@2.1.1/node_modules/fs-ext'
        pnpm.parent.mkdir(parents=True)
        (self.stage / 'node_modules/fs-ext').rename(pnpm)
        (self.stage / 'node_modules/fs-ext').symlink_to(
            '.pnpm/fs-ext@2.1.1/node_modules/fs-ext')
        manifest, output = self.make_archive()
        self.assertIn('node_modules/fs-ext',
                      [entry['path'] for entry in manifest['files']])
        report = package_runner.verify_archive(output, lockfile=self.lockfile,
                                               smoke=False)
        self.assertEqual(report['source_sha'], self.sha)

    def test_verify_archive_without_smoke(self):
        _, output = self.make_archive()
        report = package_runner.verify_archive(output, lockfile=self.lockfile, smoke=False)
        self.assertEqual(report['source_sha'], self.sha)
        self.assertEqual(report['archive_sha256'], package_runner.sha256_file(output))
        self.assertIsNone(report['observed'])
        self.assertGreater(report['file_count'], 0)

    def test_verify_detects_tampered_entry(self):
        _, output = self.make_archive()
        tampered = self.repack(
            output, self.base / 'tampered.tar.gz',
            lambda root: (root / 'dist/queue-runner/crq.js').write_bytes(b'tampered'))
        with self.assertRaisesRegex(ValueError, 'does not match its record'):
            package_runner.verify_archive(tampered, lockfile=self.lockfile, smoke=False)

    def test_verify_detects_unrecorded_path(self):
        _, output = self.make_archive()
        tampered = self.repack(
            output, self.base / 'extra.tar.gz',
            lambda root: (root / 'extra').write_text('extra'))
        with self.assertRaisesRegex(ValueError, 'unrecorded path'):
            package_runner.verify_archive(tampered, lockfile=self.lockfile, smoke=False)

    def test_verify_detects_sidecar_mismatch(self):
        _, output = self.make_archive()
        Path(str(output) + '.sha256').write_text('0' * 64 + '  runner.tar.gz\n')
        with self.assertRaises(ValueError):
            package_runner.verify_archive(output, lockfile=self.lockfile, smoke=False)

    def test_verify_preserves_empty_directory(self):
        (self.stage / 'empty').mkdir()
        _, output = self.make_archive()
        report = package_runner.verify_archive(output, lockfile=self.lockfile,
                                               smoke=False, keep=True)
        extracted = Path(report['root'])
        try:
            self.assertTrue((extracted / 'empty').is_dir())
        finally:
            shutil.rmtree(extracted.parent)

    def test_verify_rejects_duplicate_members(self):
        archive = self.base / 'duplicate.tar'
        with tarfile.open(archive, 'w') as tar:
            manifest = b'{}'
            info = tarfile.TarInfo('crq-' + self.sha + '/artifact-manifest.json')
            info.size = len(manifest)
            tar.addfile(info, io.BytesIO(manifest))
            for _ in range(2):
                info = tarfile.TarInfo('crq-' + self.sha + '/x')
                info.size = 1
                tar.addfile(info, io.BytesIO(b'x'))
        with self.assertRaisesRegex(ValueError, 'duplicate'):
            package_runner._safe_extract(archive, self.base)

    def test_verify_rejects_parent_traversal_member(self):
        archive = self.base / 'traversal.tar'
        with tarfile.open(archive, 'w') as tar:
            manifest = b'{}'
            info = tarfile.TarInfo('crq-' + self.sha + '/artifact-manifest.json')
            info.size = len(manifest)
            tar.addfile(info, io.BytesIO(manifest))
            info = tarfile.TarInfo('crq-' + self.sha + '/../x')
            info.size = 1
            tar.addfile(info, io.BytesIO(b'x'))
        with self.assertRaisesRegex(ValueError, 'not normalized'):
            package_runner._safe_extract(archive, self.base)

    def test_verify_rejects_hardlink_and_special_file(self):
        for kind, label in ((tarfile.LNKTYPE, 'hard link'), (tarfile.FIFOTYPE, 'special')):
            archive = self.base / ('special-' + label.replace(' ', '-') + '.tar')
            with tarfile.open(archive, 'w') as tar:
                manifest = b'{}'
                info = tarfile.TarInfo('crq-' + self.sha + '/artifact-manifest.json')
                info.size = len(manifest)
                tar.addfile(info, io.BytesIO(manifest))
                info = tarfile.TarInfo('crq-' + self.sha + '/x')
                info.type = kind
                info.linkname = 'crq-' + self.sha + '/y'
                tar.addfile(info)
            with self.assertRaisesRegex(ValueError, label):
                package_runner._safe_extract(archive, self.base)

    def test_verify_rejects_symlink_escape_and_entry_beneath_symlink(self):
        escape = self.base / 'escape.tar'
        with tarfile.open(escape, 'w') as tar:
            manifest = b'{}'
            info = tarfile.TarInfo('crq-' + self.sha + '/artifact-manifest.json')
            info.size = len(manifest)
            tar.addfile(info, io.BytesIO(manifest))
            info = tarfile.TarInfo('crq-' + self.sha + '/link')
            info.type = tarfile.SYMTYPE
            info.linkname = '../../etc/passwd'
            tar.addfile(info)
        with self.assertRaisesRegex(ValueError, 'escapes'):
            package_runner._safe_extract(escape, self.base)
        nested = self.base / 'nested.tar'
        with tarfile.open(nested, 'w') as tar:
            manifest = b'{}'
            info = tarfile.TarInfo('crq-' + self.sha + '/artifact-manifest.json')
            info.size = len(manifest)
            tar.addfile(info, io.BytesIO(manifest))
            info = tarfile.TarInfo('crq-' + self.sha + '/a')
            info.type = tarfile.SYMTYPE
            info.linkname = 'b'
            tar.addfile(info)
            info = tarfile.TarInfo('crq-' + self.sha + '/a/c')
            info.size = 1
            tar.addfile(info, io.BytesIO(b'x'))
        with self.assertRaisesRegex(ValueError, 'beneath a non-directory'):
            package_runner._safe_extract(nested, self.base)

    def test_package_does_not_delete_a_concurrent_output(self):
        output = self.base / 'runner.tar.gz'
        real_inventory = package_runner.inventory

        def inventory_with_winner(root, exclude=()):
            output.write_bytes(b'winner')
            return real_inventory(root, exclude=exclude)

        with mock.patch.object(package_runner, 'inventory',
                               side_effect=inventory_with_winner):
            with self.assertRaises(FileExistsError):
                package_runner.package(self.stage, output, self.sha,
                                       self.provenance(), lockfile=self.lockfile)
        self.assertEqual(output.read_bytes(), b'winner')
        self.assertFalse(Path(str(output) + '.sha256').exists())

    def test_smoke_runner_accepts_expected_refusal(self):
        node = self.write_fake_node(
            'printf \'%s\\n\' \'{"status":"indeterminate","detail":"incomplete"}\'\n'
            'exit 1\n')
        observed = package_runner.smoke_runner(self.stage, node=node)
        self.assertEqual(observed['exit_code'], 1)
        self.assertEqual(observed['status'], 'indeterminate')
        self.assertEqual(observed['detail'], 'incomplete')

    def test_smoke_runner_rejects_exit_zero(self):
        node = self.write_fake_node(
            'printf \'%s\\n\' \'{"status":"success","detail":"ok"}\'\n'
            'exit 0\n')
        with self.assertRaisesRegex(ValueError, 'exit 1'):
            package_runner.smoke_runner(self.stage, node=node)

    def test_smoke_runner_rejects_wrong_status(self):
        node = self.write_fake_node(
            'printf \'%s\\n\' \'{"status":"failed","detail":"boom"}\'\n'
            'exit 1\n')
        with self.assertRaisesRegex(ValueError, 'indeterminate'):
            package_runner.smoke_runner(self.stage, node=node)

    def test_smoke_runner_rejects_missing_detail(self):
        node = self.write_fake_node(
            'printf \'%s\\n\' \'{"status":"indeterminate"}\'\n'
            'exit 1\n')
        with self.assertRaisesRegex(ValueError, 'detail'):
            package_runner.smoke_runner(self.stage, node=node)

    def test_smoke_plumbing(self):
        fake = self.base / 'node'
        fake.write_text(
            '#!/bin/sh\n'
            'case "$*" in\n'
            '  *crq.js*) printf \'%s\\n\' \'{"status":"indeterminate",'
            '"detail":"incomplete"}\'; exit 1;;\n'
            '  *) printf \'%s\\n\' \'{"node":"v24.21.0","platform":"linux",'
            '"arch":"x64","modules":"137","fsExt":"2.1.1",'
            '"flock":"blocked-second-descriptor"}\';;\n'
            'esac\n')
        fake.chmod(0o755)
        observed = package_runner.smoke_fs_ext(self.stage, node=str(fake))
        self.assertEqual(observed['modules'], '137')
        _, output = self.make_archive()
        report = package_runner.verify_archive(output, lockfile=self.lockfile,
                                               smoke=True, node=str(fake))
        self.assertEqual(report['observed']['fsExt'], '2.1.1')
        self.assertEqual(report['runner']['status'], 'indeterminate')

    def test_smoke_rejects_wrong_abi(self):
        fake = self.base / 'node'
        fake.write_text(
            '#!/bin/sh\n'
            'printf \'%s\\n\' \'{"node":"v24.21.0","platform":"linux",'
            '"arch":"x64","modules":"999","fsExt":"2.1.1",'
            '"flock":"blocked-second-descriptor"}\'\n')
        fake.chmod(0o755)
        _, output = self.make_archive()
        with self.assertRaisesRegex(ValueError, 'Node ABI'):
            package_runner.verify_archive(output, lockfile=self.lockfile,
                                          smoke=True, node=str(fake))

    def test_real_fs_ext_smoke_when_built(self):
        source = Path(__file__).parents[2] / 'node_modules/fs-ext'
        if not (source / 'build/Release/fs_ext.node').is_file():
            self.skipTest('fs-ext is not built in this checkout')
        if shutil.which('node') is None:
            self.skipTest('node is not available')
        root = self.base / 'real'
        (root / 'node_modules').mkdir(parents=True)
        shutil.copytree(source, root / 'node_modules/fs-ext')
        observed = package_runner.smoke_fs_ext(root)
        self.assertEqual(observed['fsExt'], '2.1.1')
        self.assertEqual(observed['flock'], 'blocked-second-descriptor')


if __name__ == '__main__':
    unittest.main()
