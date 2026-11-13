"""Prepare: inert install, verified units and plist/fleet-reader rendering.

Split provenance: apps/crq-python/test_host_config.py was split into
test_host_config_overlay.py, test_host_config_policy.py, test_host_config_render.py,
test_host_config_switch.py, test_host_config_units.py, test_host_config_prepare.py
and test_host_config_legacy.py.
"""
import importlib.util
import json
from pathlib import Path
import unittest
from unittest import mock

from test_host_config_fixtures import HostConfigFixture, ROOT, host


class HostConfigTests(HostConfigFixture, unittest.TestCase):
    def test_notification_allowlist_overlay_renders_and_validates(self):
        hosts = ['triton:6767', 'uranus:6767', 'pluto:6767']
        self.overlay['config']['notify'] = {'hosts': hosts}
        host.validate(self.overlay)
        config = json.loads((ROOT / 'config.json').read_text())
        self.assertEqual(config['notify']['hosts'], [])
        self.assertEqual(host.apply(config, self.overlay)['notify']['hosts'], hosts)
        for bad in ('triton:6767', [None], ['--host:6767'], ['$(id):6767'],
                    ['triton'], ['triton:0'], ['triton:65536'], ['a' * 254 + ':6767'],
                    ['triton:6767'] * 33):
            self.overlay['config']['notify']['hosts'] = bad
            with self.subTest(bad=bad), self.assertRaisesRegex(ValueError, 'notify.hosts'):
                host.validate(self.overlay)

    def test_fleet_source_is_overlay_and_plists_render_without_host_literals(self):
        spec = importlib.util.spec_from_file_location('fleet', ROOT / 'ops/fleet-reader.py')
        fleet = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(fleet)
        self.assertEqual(fleet.source_settings(self.overlay_path), self.overlay['fleet_reader'])
        output = self.base / 'launchd'
        host.render_plists(self.root, output, self.overlay_path)
        import plistlib
        value = plistlib.loads((output / 'com.crq.fleet-reader.plist').read_bytes())
        self.assertEqual(value['ProgramArguments'], ['/usr/bin/python3',
                         str(self.runner / 'ops/fleet-reader.py'), '--overlay', str(self.overlay_path)])
        self.assertNotIn('@HOME@', (output / 'com.crq.watchdog.plist').read_text())

    def test_prepare_stays_inert_verifies_before_install_and_reloads_without_start(self):
        calls = []
        def stopped(argv):
            calls.append(argv)
            if argv[0] == 'systemd-analyze':
                self.assertTrue(all(Path(p).is_file() for p in argv[3:]))
                self.assertFalse((self.base / 'installed').exists())
                return ''
            if argv[:3] == ['systemctl', '--user', 'daemon-reload']:
                return ''
            return self.stopped(argv)
        self.command('tag', '-a', 'crq-runner/20261016-7', self.before, '-m', 'owner fixture approval')
        with mock.patch.object(host, 'run', side_effect=stopped):
            host.prepare(self.root, self.overlay, self.raw, self.base / 'installed',
                         'crq-runner/20261016-7')
        self.assertTrue((self.runner / 'state/runner-disabled').is_file())
        self.assertTrue((self.base / 'installed/crq-tick.service').is_file())
        self.assertIn(['systemctl', '--user', 'daemon-reload'], calls)
        self.assertFalse(any('start' in argv or 'enable' in argv for argv in calls))

    def test_prepare_installs_only_verified_commit_units_despite_worktree_drift(self):
        self.command('checkout', '-q', '--detach', self.target)
        directory = self.runner / 'ops/systemd'
        expected = {
            path.name: self.command('show', f'{self.target}:apps/crq-python/ops/systemd/{path.name}')
                .replace('@CRQ_ROOT@', str(self.runner)).encode()
            for path in directory.glob('crq-*')
        }
        # Retaining the placeholder used to let unapproved commands pass validation.
        unit = directory / 'crq-tick.service'
        unit.write_text(unit.read_text() + '\nExecStartPost=/unapproved-command\n')
        (directory / 'crq-slot.timer').unlink()
        (directory / 'crq-extra.service').write_text('[Service]\nExecStart=@CRQ_ROOT@/extra\n')
        verified = []

        def stopped(argv):
            if argv[0] == 'systemd-analyze':
                verified.append({Path(p).name: Path(p).read_bytes() for p in argv[3:]})
                self.assertFalse((self.base / 'installed').exists())
                return ''
            return self.stopped(argv)

        with mock.patch.object(host, 'run', side_effect=stopped):
            host.main(['--overlay', str(self.overlay_path), 'prepare',
                       '--units-output', str(self.base / 'installed'), '--tag', self.tag])
        self.assertEqual(verified, [expected])
        installed = {p.name: p.read_bytes() for p in (self.base / 'installed').iterdir()}
        self.assertEqual(installed, expected)
        receipt = json.loads(next((self.base / 'records').glob('*.json')).read_text())
        self.assertEqual(receipt['sha'], self.target)
        self.assertEqual(receipt['unit_sha256'], {name: host.digest(data) for name, data in expected.items()})


if __name__ == '__main__':
    unittest.main()
