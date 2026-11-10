"""Unit rendering: placeholders, obsolete units and systemd-analyze verification.

Split provenance: apps/crq-python/test_host_config.py was split into
test_host_config_overlay.py, test_host_config_policy.py, test_host_config_render.py,
test_host_config_switch.py, test_host_config_units.py, test_host_config_prepare.py
and test_host_config_legacy.py.
"""
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
                                    host.prepare(self.root, self.overlay, self.raw, self.base / 'installed')
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
