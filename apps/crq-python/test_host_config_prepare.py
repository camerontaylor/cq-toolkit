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
        verified = []
        rendered_paths = []
        real_render = host.render_units
        def capture_render(*args, **kwargs):
            paths = real_render(*args, **kwargs)
            rendered_paths.append([str(p) for p in paths])
            return paths
        def stopped(argv):
            calls.append(argv)
            if argv[0] == 'systemd-analyze':
                self.assertEqual(argv[:3], ['systemd-analyze', '--user', 'verify'])
                self.assertTrue(all(Path(p).is_file() for p in argv[3:]))
                self.assertFalse((self.base / 'installed').exists())
                verified.append(argv[3:])
                return ''
            if argv[:3] == ['systemctl', '--user', 'daemon-reload']:
                return ''
            return self.stopped(argv)
        self.command('tag', '-a', 'crq-runner/20261016-7', self.before, '-m', 'owner fixture approval')
        with mock.patch.object(host, 'run', side_effect=stopped), \
                mock.patch.object(host, 'render_units', side_effect=capture_render):
            host.prepare(self.root, self.overlay, self.raw, self.base / 'installed',
                         'crq-runner/20261016-7')
        # verification must receive exactly the paths render_units returned,
        # not the original template paths.
        self.assertEqual(len(rendered_paths), 1)
        self.assertEqual(verified, rendered_paths)
        expected = [path.name for path in host.unit_files(self.root)]
        # prepare must have verified the rendered units themselves: one
        # systemd-analyze run carrying every rendered unit path, checked
        # above while the units output did not yet exist.
        self.assertTrue(expected)
        self.assertEqual([sorted(Path(p).name for p in paths) for paths in verified],
                         [expected])
        self.assertTrue((self.runner / 'state/runner-disabled').is_file())
        self.assertTrue((self.base / 'installed/crq-tick.service').is_file())
        self.assertIn(['systemctl', '--user', 'daemon-reload'], calls)
        self.assertFalse(any('start' in argv or 'enable' in argv for argv in calls))

    def test_prepare_refuses_stale_units_outside_the_rendered_set_before_install(self):
        self.command('tag', '-a', 'crq-runner/20261016-8', self.before, '-m', 'owner fixture approval')
        output = self.base / 'installed'
        output.mkdir()
        # A unit the target no longer renders would stay installed, stay
        # enabled, and stay outside the recorded unit inventory.
        (output / 'crq-retired.timer').write_text('[Timer]\nOnCalendar=daily\n')
        def stopped(argv):
            if argv[0] == 'systemd-analyze':
                return ''
            return self.stopped(argv)
        with mock.patch.object(host, 'run', side_effect=stopped):
            with self.assertRaisesRegex(ValueError, 'outside the rendered set: crq-retired.timer'):
                host.prepare(self.root, self.overlay, self.raw, output, 'crq-runner/20261016-8')
        self.assertEqual(sorted(p.name for p in output.iterdir()), ['crq-retired.timer'])
        self.assertFalse((self.base / 'records').exists())
        self.assertFalse((self.runner / 'state/runner-disabled').exists())

    def test_preview_refuses_an_output_that_holds_the_overlay(self):
        # preview writes config.json under --output; an overlay inside that tree
        # would be replaced by the rendered runner config, so the next
        # invocation would reject it for lacking the overlay schema.
        with self.assertRaisesRegex(ValueError, 'must not hold the overlay'):
            host.main(['--overlay', str(self.overlay_path), 'preview', '--output', str(self.base)])
        self.assertEqual(self.overlay_path.read_bytes(), self.raw)
        self.assertFalse((self.base / 'config.json').exists())
        self.assertFalse((self.base / 'systemd').exists())
        self.assertFalse((self.base / 'records').exists())

    def test_preview_refuses_a_rendered_child_linked_into_a_checkout(self):
        # render_units and render_plists follow systemd/ and launchd/ under
        # --output; a child linked into the deployment checkout must be refused
        # before any preview byte is written, not followed by the renderer.
        for child in ('systemd', 'launchd'):
            with self.subTest(child=child):
                output = self.base / ('preview-' + child)
                output.mkdir()
                (output / child).symlink_to(self.root, target_is_directory=True)
                with self.assertRaisesRegex(ValueError, 'outside every Git checkout|outside checkout'):
                    host.main(['--overlay', str(self.overlay_path), 'preview', '--output', str(output)])
                self.assertEqual(sorted(p.name for p in output.iterdir()), [child])
                self.assertFalse((self.base / 'records').exists())

    def test_prepare_rejects_worktree_drift_before_installing_units(self):
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
        # The published units execute the working tree, so prepare must refuse
        # drift before publishing anything; render_units itself still reads
        # only the verified commit.
        paths = host.render_units(self.root, self.base / 'units', self.target)
        self.assertEqual({Path(p).name: Path(p).read_bytes() for p in paths}, expected)
        with mock.patch.object(host, 'run', side_effect=self.stopped):
            with self.assertRaisesRegex(ValueError, 'other than rendered config'):
                host.prepare(self.root, self.overlay, self.raw, self.base / 'installed',
                             self.tag)
        self.assertFalse((self.base / 'installed').exists())
        self.assertFalse((self.base / 'records').exists())


if __name__ == '__main__':
    unittest.main()
