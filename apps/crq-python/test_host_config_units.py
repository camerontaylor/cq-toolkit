"""Unit rendering: placeholders, obsolete units and systemd-analyze verification.

Split provenance: apps/crq-python/test_host_config.py was split into
test_host_config_overlay.py, test_host_config_policy.py, test_host_config_render.py,
test_host_config_switch.py, test_host_config_units.py, test_host_config_prepare.py
and test_host_config_legacy.py.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import unittest
from unittest import mock

from test_host_config_fixtures import HostConfigFixture, ROOT, host


class HostConfigTests(HostConfigFixture, unittest.TestCase):
    def test_legacy_unit_target_refused_before_switching_or_rendering(self):
        unit = self.runner / 'ops/systemd/crq-tick.service'
        unit.write_text(unit.read_text().replace('@CRQ_ROOT@', '%h/repos/coderabbit-queue'))
        self.command('commit', '-qam', 'legacy unit paths with helper still present')
        target = self.command('rev-parse', 'HEAD').strip()
        self.command('update-ref', 'refs/remotes/origin/main', target)
        tag = 'crq-runner/20261016-6'
        self.command('tag', '-a', tag, '-m', 'legacy fixture')
        output = self.base / 'legacy-units'
        with self.assertRaisesRegex(ValueError, 'root placeholder'):
            host.render_units(self.root, output)
        self.assertFalse(output.exists())
        self.command('checkout', '-q', '--detach', self.before)
        current = self.rendered()
        with mock.patch.object(host, 'inactive') as inactive:
            with self.assertRaisesRegex(ValueError, 'root placeholder'):
                host.switch(self.root, self.overlay, self.raw, target, tag)
            inactive.assert_not_called()
        self.assertEqual(self.command('rev-parse', 'HEAD').strip(), self.before)
        self.assertEqual((self.root / host.CONFIG).read_bytes(), current)
        self.assertFalse((self.base / 'records').exists())

    def test_obsolete_installed_and_loaded_units_block_mutation(self):
        self.rendered()
        self.command('tag', '-a', 'crq-runner/20261016-8', self.before, '-m', 'prepare fixture')
        for listing in ('list-unit-files', 'list-units'):
            for state in ('active', 'activating', 'reloading', 'deactivating', 'unknown'):
                for operation in ('prepare', 'switch'):
                    with self.subTest(listing=listing, state=state, operation=operation):
                        calls = []
                        def systemctl(argv):
                            calls.append(argv)
                            if argv[:3] == ['systemctl', '--user', listing]:
                                return ('crq-obsolete.service enabled enabled\n' if listing == 'list-unit-files'
                                        else 'crq-obsolete.service loaded active running Obsolete CRQ\n')
                            if argv[0] == 'systemctl' and argv[-1] == 'crq-obsolete.service':
                                return state + '\n'
                            return self.stopped(argv)
                        before = (self.root / host.CONFIG).read_bytes()
                        with mock.patch.object(host, 'run', side_effect=systemctl):
                            with self.assertRaisesRegex(ValueError, 'crq-obsolete.service'):
                                if operation == 'prepare':
                                    host.prepare(self.root, self.overlay, self.raw,
                                                 self.base / 'installed', 'crq-runner/20261016-8')
                                else:
                                    host.switch(self.root, self.overlay, self.raw, self.target, self.tag)
                        self.assertTrue(any(argv[2] == listing for argv in calls if argv[0] == 'systemctl'))
                        self.assertEqual(self.command('rev-parse', 'HEAD').strip(), self.before)
                        self.assertEqual((self.root / host.CONFIG).read_bytes(), before)
                        self.assertFalse((self.base / 'installed').exists())
                        self.assertFalse((self.base / 'records').exists())

    def test_stopped_obsolete_units_are_allowed_and_listing_errors_fail_closed(self):
        def stopped_obsolete(argv):
            if argv[:3] == ['systemctl', '--user', 'list-unit-files']:
                return 'crq-obsolete.service disabled enabled\n'
            return self.stopped(argv)
        with mock.patch.object(host, 'run', side_effect=stopped_obsolete) as run:
            host.inactive(self.root)
            self.assertTrue(any(call.args[0][-1] == 'crq-obsolete.service' for call in run.call_args_list))
        for listing in ('list-unit-files', 'list-units'):
            def unavailable(argv):
                if argv[:3] == ['systemctl', '--user', listing]:
                    raise subprocess.CalledProcessError(1, argv, '', 'Failed to connect to user scope bus')
                return self.stopped(argv)
            with self.subTest(listing=listing), mock.patch.object(host, 'run', side_effect=unavailable):
                with self.assertRaises(subprocess.CalledProcessError):
                    host.inactive(self.root)

    def test_no_matching_unit_files_is_an_empty_listing(self):
        def no_matches(argv):
            if argv[:3] == ['systemctl', '--user', 'list-unit-files']:
                raise subprocess.CalledProcessError(1, argv, '', '')
            return self.stopped(argv)
        with mock.patch.object(host, 'run', side_effect=no_matches):
            host.inactive(self.root)  # a host with no CRQ units is not an error

    def test_rendered_units_use_monorepo_root(self):
        paths = host.render_units(self.root, self.base / 'units')
        self.assertEqual(len(paths), len(list((ROOT / 'ops/systemd').glob('crq-*'))))
        contents = '\n'.join(Path(p).read_text() for p in paths)
        self.assertNotIn('@CRQ_ROOT@', contents)
        self.assertNotIn('repos/coderabbit-queue', contents)
        self.assertIn(str(self.runner / 'crq.py') + ' tick', contents)
        self.assertIn(str(self.runner / 'crq_slot.py'), contents)
        slot_timer = (self.base / 'units/crq-slot.timer').read_text()
        self.assertIn('OnCalendar=*-*-* *:*:00', slot_timer)
        self.assertIn('AccuracySec=1s', slot_timer)
        self.assertIn(str(self.runner / 'state/repair/inbox'), contents)

    def test_runtime_selection_is_per_unit_and_rejects_invalid_pointers(self):
        sha = 'a' * 40
        output = self.base / 'node-units'
        host.render_units(self.root, output, runtimes={'crq-tick.service': 'node:' + sha})
        tick = (output / 'crq-tick.service').read_text()
        self.assertIn(str(Path.home() / ('.local/opt/crq-' + sha) /
                          'dist/queue-runner/crq.js') + ' tick', tick)
        self.assertIn(str(self.runner / 'crq_slot.py'), (output / 'crq-slot.service').read_text())
        for mapping in ({'crq-tick.service': 'node:../bad'}, {'crq-other.service': 'python'}):
            with self.subTest(mapping=mapping), self.assertRaises(ValueError):
                host.render_units(self.root, self.base / 'invalid', runtimes=mapping)
            self.assertFalse((self.base / 'invalid').exists())

    @staticmethod
    def _elf_header():
        header = bytearray(20)
        header[:5] = b'\x7fELF\x02'
        header[5] = 1
        header[18:20] = b'\x3e\x00'
        return bytes(header)

    def _node_artifact(self, sha):
        """Build a minimally packageable whole-artifact tree.

        This is an extracted artifact, so it contains the manifest as well as
        every package.REQUIRED_ENTRIES path. The provenance is derived from
        package.staging_facts and validated with staging=root, matching the
        package-runner accept rules without executing the runner.
        """
        package = host._package_runner()
        root = self.base / '.local/opt' / ('crq-' + sha)
        (root / 'dist/queue-runner').mkdir(parents=True)
        (root / 'dist/queue-runner/crq.js').write_bytes(b'runner')
        (root / 'package.json').write_text(
            json.dumps({'name': 'crq-runner', 'version': '0.0.0'}))
        fs_ext = root / 'node_modules/fs-ext'
        (fs_ext / 'build/Release').mkdir(parents=True)
        (fs_ext / 'package.json').write_text(
            json.dumps({'name': 'fs-ext', 'version': package.FS_EXT_VERSION}))
        (fs_ext / 'build/Release/fs_ext.node').write_bytes(self._elf_header())
        files = package.inventory(root)
        facts = package.staging_facts(root)
        provenance = {
            'schema_version': package.PROVENANCE_VERSION,
            'source_sha': sha,
            'lockfile_sha256': '1' * 64,
            'runtime': {
                'node_version': 'v24.0.0',
                'node_major': package.NODE_MAJOR,
                'node_abi': '137',
                'platform': package.PLATFORM,
                'arch': package.ARCH,
            },
            'toolchain': {
                'pnpm_version': '9.0.0',
                'install_command': 'pnpm install',
                'build_command': 'pnpm build',
                'deploy_command': 'pnpm deploy',
            },
            'dependencies': facts['dependencies'],
            'fs_ext': facts['fs_ext'],
        }
        manifest = {
            'schema_version': package.SCHEMA_VERSION,
            'source_sha': sha,
            'content_sha256': package.content_digest(files),
            'provenance': provenance,
            'files': files,
        }
        package.validate_manifest(manifest)
        package.validate_provenance(provenance, sha=sha, staging=root)
        for required in package.REQUIRED_ENTRIES:
            self.assertTrue((root / required).is_file(), required)
        (root / package.MANIFEST_NAME).write_text(json.dumps(manifest))
        return root

    def test_node_artifact_fixture_matches_package_contract(self):
        sha = 'f' * 40
        artifact = self._node_artifact(sha)
        package = host._package_runner()
        manifest = json.loads((artifact / package.MANIFEST_NAME).read_text())
        for required in package.REQUIRED_ENTRIES:
            self.assertTrue((artifact / required).is_file(), required)
        package.validate_provenance(manifest['provenance'], sha=sha,
                                    staging=artifact)

    def test_artifact_identity_requires_package_required_entries(self):
        """A self-consistent manifest cannot waive a required package entry."""
        sha = 'd' * 40
        artifact = self._node_artifact(sha)
        package = host._package_runner()
        (artifact / 'package.json').unlink()
        files = package.inventory(artifact, exclude=(package.MANIFEST_NAME,))
        manifest_path = artifact / package.MANIFEST_NAME
        manifest = json.loads(manifest_path.read_text())
        manifest['files'] = files
        manifest['content_sha256'] = package.content_digest(files)
        package.validate_manifest(manifest)
        manifest_path.write_text(json.dumps(manifest))
        with self.assertRaisesRegex(ValueError, 'required package entry'):
            host.artifact_identity(artifact, 'node:' + sha)

    def test_artifact_identity_rejects_provenance_that_disagrees_with_tree(self):
        sha = 'e' * 40
        artifact = self._node_artifact(sha)
        package = host._package_runner()
        manifest_path = artifact / package.MANIFEST_NAME
        manifest = json.loads(manifest_path.read_text())
        manifest['provenance']['fs_ext']['native_sha256'] = '0' * 64
        package.validate_manifest(manifest)
        manifest_path.write_text(json.dumps(manifest))
        with self.assertRaisesRegex(ValueError, 'provenance does not match'):
            host.artifact_identity(artifact, 'node:' + sha)

    def test_single_unit_render_matches_render_units_for_all_services(self):
        sha = 'a' * 40
        artifact = self._node_artifact(sha)
        python_out = self.base / 'python-units'
        node_out = self.base / 'node-units'
        with mock.patch.object(host.Path, 'home', return_value=self.base):
            host.render_units(self.root, python_out)
            host.render_units(
                self.root, node_out,
                runtimes={unit: 'node:' + sha for unit in host.UNIT_COMMANDS})
            for unit in sorted(host.UNIT_COMMANDS):
                with self.subTest(unit=unit, runtime='python'):
                    rendered = host.render_service(self.root, unit, 'python', sha=self.before)
                    self.assertEqual(rendered['bytes'], (python_out / unit).read_bytes())
                    self.assertEqual(rendered['source_sha'], self.before)
                    self.assertEqual(rendered['template_path'],
                                     'apps/crq-python/ops/systemd/' + unit)
                    self.assertEqual(
                        rendered['template_sha256'],
                        host.digest((self.runner / 'ops/systemd' / unit).read_bytes()))
                    self.assertIn(str(self.runner), rendered['exec_start'])
                    self.assertNotIn('@CRQ_ROOT@', rendered['exec_start'])
                    self.assertIsNone(rendered['artifact'])
                with self.subTest(unit=unit, runtime='node'):
                    rendered = host.render_service(
                        self.root, unit, 'node:' + sha, sha=self.before)
                    self.assertEqual(rendered['bytes'], (node_out / unit).read_bytes())
                    self.assertIn('dist/queue-runner/crq.js', rendered['exec_start'])
                    self.assertIn(host.UNIT_COMMANDS[unit], rendered['exec_start'])
                    identity = rendered['artifact']
                    self.assertEqual(identity['source_sha'], sha)
                    self.assertEqual(identity['verification'],
                                     'whole-artifact-inventory-matched')
                    self.assertEqual(identity['authenticity'], 'not-established')
                    self.assertEqual(identity['crq_js_sha256'], host.digest(b'runner'))
        self.assertTrue(artifact.is_dir())

    def test_render_service_source_binding_refuses_unknown_or_tampered_template(self):
        with self.assertRaisesRegex(ValueError, 'unknown runtime unit'):
            host.render_service(self.root, 'crq-other.service', 'python')
        original_git = host.git

        def missing_template(root, *args):
            if args[:3] == ('ls-tree', '-r', '--name-only'):
                return ''
            return original_git(root, *args)

        with mock.patch.object(host, 'git', side_effect=missing_template):
            with self.assertRaisesRegex(ValueError, 'absent'):
                host.render_service(self.root, 'crq-tick.service', 'python')
        with mock.patch.object(host, 'run_bytes', return_value=b'tampered'):
            with self.assertRaisesRegex(ValueError, 'Git blob'):
                host.render_service(self.root, 'crq-tick.service', 'python')
        with self.assertRaises(subprocess.CalledProcessError):
            host.render_service(self.root, 'crq-tick.service', 'python', sha='0' * 40)

    def test_render_service_rejects_malformed_committed_templates(self):
        unit = self.runner / 'ops/systemd/crq-tick.service'
        original = unit.read_text()
        cases = {
            'root placeholder': original.replace('@CRQ_ROOT@', '/tmp/not-a-runner'),
            'exactly one ExecStart': original.replace('ExecStart=', '# ExecStart='),
            'exactly one ExecStart ': original.replace(
                'ExecStart=', 'ExecStart=/bin/true\nExecStart='),
        }
        for label, text in cases.items():
            with self.subTest(label=label):
                unit.write_text(text)
                self.command('commit', '-qam', 'malformed ' + label)
                bad = self.command('rev-parse', 'HEAD').strip()
                with self.assertRaisesRegex(ValueError, label.strip()):
                    host.render_service(self.root, 'crq-tick.service', 'python', sha=bad)
                self.command('checkout', '-q', '--detach', self.before)
        self.assertEqual(unit.read_text(), original)

    def test_artifact_identity_reuses_package_runner_and_refuses_mismatch(self):
        sha = 'a' * 40
        artifact = self._node_artifact(sha)
        runtime = 'node:' + sha
        package = host._package_runner()
        identity = host.artifact_identity(artifact, runtime)
        self.assertEqual(identity['source_sha'], sha)
        self.assertEqual(identity['observed_content_sha256'],
                         identity['declared_content_sha256'])
        self.assertEqual(identity['verification'], 'whole-artifact-inventory-matched')
        self.assertEqual(identity['authenticity'], 'not-established')
        self.assertEqual(
            identity['crq_js_sha256'],
            package.sha256_file(artifact / 'dist/queue-runner/crq.js'))
        before = {path: (path.is_file() and path.read_bytes())
                  for path in artifact.rglob('*')}
        host.artifact_identity(artifact, runtime)
        self.assertEqual(before, {path: (path.is_file() and path.read_bytes())
                                  for path in artifact.rglob('*')})
        with self.assertRaisesRegex(ValueError, 'source SHA'):
            host.artifact_identity(artifact, 'node:' + 'b' * 40)
        with self.assertRaisesRegex(ValueError, 'manifest is unavailable'):
            host.artifact_identity(self.base, runtime)
        entry = artifact / 'dist/queue-runner/crq.js'
        entry.write_bytes(b'tampered')
        with self.assertRaisesRegex(ValueError, 'inventory'):
            host.artifact_identity(artifact, runtime)
        entry.write_bytes(b'runner')
        (artifact / 'extra').write_bytes(b'x')
        with self.assertRaisesRegex(ValueError, 'inventory'):
            host.artifact_identity(artifact, runtime)
        (artifact / 'extra').unlink()
        original_mode = entry.stat().st_mode & 0o777
        entry.chmod(0o600 if original_mode != 0o600 else 0o644)
        with self.assertRaisesRegex(ValueError, 'inventory'):
            host.artifact_identity(artifact, runtime)
        entry.chmod(original_mode)
        manifest_path = artifact / package.MANIFEST_NAME
        manifest = json.loads(manifest_path.read_text())
        manifest['content_sha256'] = '0' * 64
        manifest_path.write_text(json.dumps(manifest))
        with self.assertRaisesRegex(ValueError, 'manifest is invalid'):
            host.artifact_identity(artifact, runtime)
        manifest_path.write_text('{')
        with self.assertRaisesRegex(ValueError, 'manifest is invalid'):
            host.artifact_identity(artifact, runtime)
        other = self._node_artifact('c' * 40)
        other_manifest = other / package.MANIFEST_NAME
        manifest = json.loads(other_manifest.read_text())
        manifest['provenance']['runtime']['node_abi'] = 'not-numeric'
        other_manifest.write_text(json.dumps(manifest))
        with self.assertRaisesRegex(ValueError, 'manifest is invalid'):
            host.artifact_identity(other, 'node:' + 'c' * 40)

    def test_node_artifact_source_binds_to_pointer_not_template_commit(self):
        sha = 'a' * 40
        artifact = self._node_artifact(sha)
        rendered = host.render_service(
            self.root, 'crq-tick.service', 'node:' + sha,
            sha=self.before, artifact_root=artifact)
        self.assertEqual(rendered['source_sha'], self.before)
        self.assertEqual(rendered['artifact']['source_sha'], sha)
        self.assertNotEqual(rendered['source_sha'], sha)
        with self.assertRaisesRegex(ValueError, 'source SHA'):
            host.render_service(
                self.root, 'crq-tick.service', 'node:' + 'b' * 40,
                sha=self.before, artifact_root=artifact)

    def test_render_service_and_artifact_identity_are_read_only(self):
        sha = 'a' * 40
        artifact = self._node_artifact(sha)
        before = self.command('status', '--porcelain')
        tree_before = {path: (path.is_file() and path.read_bytes())
                       for path in artifact.rglob('*')}
        host.render_service(self.root, 'crq-tick.service', 'python', sha=self.before)
        host.render_service(
            self.root, 'crq-tick.service', 'node:' + sha,
            sha=self.before, artifact_root=artifact)
        host.artifact_identity(artifact, 'node:' + sha)
        self.assertEqual(self.command('status', '--porcelain'), before)
        self.assertEqual(tree_before, {path: (path.is_file() and path.read_bytes())
                                       for path in artifact.rglob('*')})

    def test_render_service_rejects_invalid_runtime_before_git(self):
        with mock.patch.object(host, 'git', side_effect=AssertionError('git called')):
            for runtime in ('node:../bad', 'node:' + 'a' * 39, 'python3'):
                with self.subTest(runtime=runtime):
                    with self.assertRaisesRegex(ValueError, 'runtime must be'):
                        host.render_service(self.root, 'crq-tick.service', runtime)

    @unittest.skipUnless(shutil.which('systemd-analyze'), 'systemd-analyze runs in Linux CI')
    def test_systemd_analyze_verify_detached_render(self):
        paths = host.render_units(self.root, self.base / 'units')
        runtime = self.base / 'runtime-dir'
        runtime.mkdir(mode=0o700)
        env = {**os.environ, 'SYSTEMD_UNIT_PATH': str(self.base / 'units') + ':',
               'XDG_RUNTIME_DIR': str(runtime)}
        result = subprocess.run(['systemd-analyze', '--user', 'verify', *paths],
                                capture_output=True, text=True, env=env)
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == '__main__':
    unittest.main()
