"""P2 deployment characterization: temporary detached clones, never a live host."""
import copy
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('host_prepare', ROOT / 'ops/prepare-host.py')
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)


class HostConfigTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='crq-p2-')
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.root = self.base / 'deploy'
        self.root.mkdir()
        self.runner = self.root / 'apps/crq-python'
        self.runner.mkdir(parents=True)
        shutil.copy(ROOT / 'config.json', self.runner / 'config.json')
        shutil.copytree(ROOT / 'ops/systemd', self.runner / 'ops/systemd')
        shutil.copy(ROOT / 'ops/prepare-host.py', self.runner / 'ops/prepare-host.py')
        for path in (ROOT / 'ops').glob('com.crq.*.plist'):
            shutil.copy(path, self.runner / 'ops' / path.name)
        (self.root / '.gitignore').write_text('apps/crq-python/state/\n')
        self.command('init', '-q')
        self.command('config', 'user.email', 'fixture@example.invalid')
        self.command('config', 'user.name', 'Fixture')
        self.command('add', '.')
        self.command('commit', '-qm', 'baseline')
        self.before = self.command('rev-parse', 'HEAD').strip()
        c = json.loads((self.runner / 'config.json').read_text())
        c['promotion']['hours_trigger'] = 9
        (self.runner / 'config.json').write_bytes(host.encode(c))
        self.command('commit', '-qam', 'next policy')
        self.target = self.command('rev-parse', 'HEAD').strip()
        self.command('update-ref', 'refs/remotes/origin/main', self.target)
        self.tag = 'crq-runner/20261016-1'
        self.command('tag', '-a', self.tag, '-m', 'owner fixture approval')
        self.command('checkout', '-q', '--detach', self.before)
        self.overlay = {
            'schema_version': 1, 'deploy_root': str(self.root),
            'record_dir': str(self.base / 'records'),
            'fleet_reader': {'ssh_host': 'queue.example.invalid', 'source': '/srv/state/crq/summary.json'},
            'config': {
                'clone': str(self.base / 'runtime'), 'worktree_root': str(self.base / 'worktrees'),
                'timeout_bin': '/usr/bin/timeout', 'paseo_hosts': ['worker.example.invalid:6767'],
                'promotion': {'record_url_template': 'http://queue.example.invalid:6778/promotion/{item}',
                              'alert_agent_host': 'worker.example.invalid:6767',
                              'signer': {'spool': {'ssh_alias': 'operator@127.0.0.1',
                                                   'ssh_key': '/srv/keys/crq-spool'}}},
                'repair': {'enabled': False, 'cq_bin': str(self.base / 'runtime/dist/cli.js'),
                           'paseo_host': '127.0.0.1:6767'},
            },
        }
        self.raw = host.encode(self.overlay)
        self.overlay_path = self.base / 'host.json'
        self.overlay_path.write_bytes(self.raw)
        self.overlay_path.chmod(0o600)
        self.floor = mock.patch.object(host, 'POLICY_FLOOR', self.before)
        self.floor.start()
        self.addCleanup(self.floor.stop)

    def command(self, *args):
        return subprocess.run(['git', '-C', str(self.root), *args], check=True,
                              capture_output=True, text=True).stdout

    def stopped(self, argv):
        if argv[0] == 'systemctl':
            return 'inactive\n'
        return subprocess.run(argv, check=True, capture_output=True, text=True).stdout

    def rendered(self):
        data = host.render(self.root, self.overlay)
        (self.runner / 'config.json').write_bytes(data)
        return data

    def test_detached_prefixed_committed_render_not_worktree(self):
        (self.runner / 'config.json').write_text('{"not": "committed"}')
        data = host.render(self.root, self.overlay)
        config = json.loads(data)
        self.assertEqual(config['promotion']['hours_trigger'], 8)
        self.assertEqual(config['promotion']['merges_trigger'], 1)
        self.assertEqual(config['promotion']['dispatch_after_min'], 0)
        self.assertEqual(config['clone'], self.overlay['config']['clone'])
        self.assertFalse(config['repair']['enabled'])
        self.assertEqual(data, host.encode(config))
        host.root_check(self.root, self.overlay)

    def test_all_policy_and_unknown_overlay_keys_refused(self):
        for path in [('max_starts_per_hour',), ('max_inflight',), ('error_backoff_min',),
                     ('promotion', 'checks'), ('promotion', 'merges_trigger'),
                     ('promotion', 'dispatch_after_min'), ('repair', 'spend_authorization'),
                     ('repair', 'roles'), ('typo',)]:
            with self.subTest(path=path):
                overlay = copy.deepcopy(self.overlay)
                dest = overlay['config']
                for key in path[:-1]:
                    dest = dest.setdefault(key, {})
                dest[path[-1]] = 1
                with self.assertRaises(ValueError):
                    host.validate(overlay)
        for enabled in [True, 0, None, 'false']:
            overlay = copy.deepcopy(self.overlay)
            overlay['config']['repair']['enabled'] = enabled
            with self.assertRaises(ValueError):
                host.validate(overlay)

    def test_schema_and_unit_injection_and_clone_sharing_refused(self):
        for key, value in [('schema_version', 2), ('schema_version', True),
                           ('deploy_root', '/srv/%h'), ('record_dir', str(self.root / 'records'))]:
            overlay = copy.deepcopy(self.overlay)
            overlay[key] = value
            with self.assertRaises(ValueError):
                host.validate(overlay)
        overlay = copy.deepcopy(self.overlay)
        overlay['config']['clone'] = str(self.root / 'runtime')
        with self.assertRaises(ValueError):
            host.validate(overlay)
        overlay = copy.deepcopy(self.overlay)
        overlay['fleet_reader']['ssh_host'] = '-oProxyCommand=bad'
        with self.assertRaises(ValueError):
            host.validate(overlay)

    def test_overlay_must_be_external_and_raw_hash_preserved(self):
        self.assertEqual(host.load_overlay(self.overlay_path), (self.overlay, self.raw))
        internal = self.root / 'private.json'
        internal.write_bytes(self.raw)
        with self.assertRaises(ValueError):
            host.load_overlay(internal)
        config = host.render(self.root, self.overlay)
        rec = host.record(self.root, self.overlay, self.raw, config, 'fixture')
        self.assertEqual(rec['overlay_sha256'], host.digest(self.raw))
        self.assertEqual(rec['config_sha256'], host.digest(config))
        path = next((self.base / 'records').glob('*.json'))
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(path.parent.stat().st_mode & 0o777, 0o700)

    def test_live_render_holds_existing_tick_lock_and_records(self):
        state = self.runner / 'state'
        state.mkdir()
        with (state / 'tick.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(BlockingIOError):
                host.live_render(self.root, self.overlay, self.raw)
        host.live_render(self.root, self.overlay, self.raw)
        self.assertEqual((self.runner / 'config.json').read_bytes(), host.render(self.root, self.overlay))
        self.assertFalse((state / 'runner-disabled').exists())
        self.assertEqual(len(list((self.base / 'records').glob('*.json'))), 1)

    def test_switch_and_rollback_keep_state_and_record_both_hashes(self):
        self.rendered()
        state = self.runner / 'state'
        state.mkdir()
        (state / 'queue.json').write_bytes(b'{"unchanged":true}\n')
        with mock.patch.object(host, 'run', side_effect=self.stopped):
            host.switch(self.root, self.overlay, self.raw, self.target, self.tag)
        self.assertEqual(self.command('rev-parse', 'HEAD').strip(), self.target)
        self.assertEqual(self.command('status', '--porcelain').rstrip(), ' M ' + host.CONFIG)
        self.assertEqual(json.loads((self.runner / 'config.json').read_text())['promotion']['hours_trigger'], 9)
        self.assertEqual((state / 'queue.json').read_bytes(), b'{"unchanged":true}\n')
        records = [json.loads(p.read_text()) for p in (self.base / 'records').glob('*.json')]
        self.assertEqual({r['operation'] for r in records}, {'switch-before', 'switch-render'})
        for rec in records:
            self.assertEqual(rec['overlay_sha256'], host.digest(self.raw))
        rollback_tag = 'crq-runner/20261016-2'
        self.command('tag', '-a', rollback_tag, self.before, '-m', 'rollback fixture approval')
        with mock.patch.object(host, 'run', side_effect=self.stopped):
            host.switch(self.root, self.overlay, self.raw, self.before, rollback_tag)
        self.assertEqual(self.command('rev-parse', 'HEAD').strip(), self.before)

    def test_drift_refuses_before_restoring_or_switching_no_private_values(self):
        self.rendered()
        config = json.loads((self.runner / 'config.json').read_text())
        config['promotion']['merges_trigger'] = 2
        (self.runner / 'config.json').write_bytes(host.encode(config))
        before = (self.runner / 'config.json').read_bytes()
        with mock.patch.object(host, 'run', side_effect=self.stopped):
            with self.assertRaisesRegex(ValueError, 'promotion.merges_trigger'):
                host.switch(self.root, self.overlay, self.raw, self.target, self.tag)
        self.assertEqual(self.command('rev-parse', 'HEAD').strip(), self.before)
        self.assertEqual((self.runner / 'config.json').read_bytes(), before)
        self.assertFalse((self.base / 'records').exists())

    def test_active_units_dirty_checkout_and_bad_tags_refuse(self):
        self.rendered()
        def active(argv):
            return 'active\n' if argv[0] == 'systemctl' else self.stopped(argv)
        with mock.patch.object(host, 'run', side_effect=active):
            with self.assertRaisesRegex(ValueError, 'active'):
                host.switch(self.root, self.overlay, self.raw, self.target, self.tag)
        (self.root / 'unexpected').write_text('dirty')
        with mock.patch.object(host, 'run', side_effect=self.stopped):
            with self.assertRaisesRegex(ValueError, 'other than'):
                host.switch(self.root, self.overlay, self.raw, self.target, self.tag)
        with self.assertRaises(ValueError):
            host.verify_target(self.root, self.target[:8], self.tag)
        self.command('tag', 'crq-runner/20261016-3')
        with self.assertRaises(ValueError):
            host.verify_target(self.root, self.before, 'crq-runner/20261016-3')
        with self.assertRaises(subprocess.CalledProcessError):
            host.verify_target(self.root, self.before, 'crq-runner/20261016-99')
        with mock.patch.object(host, 'POLICY_FLOOR', self.target):
            self.command('tag', '-a', 'crq-runner/20261016-4', self.before, '-m', 'old')
            with self.assertRaises(subprocess.CalledProcessError):
                host.verify_target(self.root, self.before, 'crq-runner/20261016-4')

    def test_rendered_units_use_monorepo_root(self):
        paths = host.render_units(self.root, self.base / 'units')
        self.assertEqual(len(paths), len(list((ROOT / 'ops/systemd').glob('crq-*'))))
        contents = '\n'.join(Path(p).read_text() for p in paths)
        self.assertNotIn('@CRQ_ROOT@', contents)
        self.assertNotIn('repos/coderabbit-queue', contents)
        self.assertIn(str(self.runner / 'crq.py') + ' tick', contents)
        self.assertIn(str(self.runner / 'state/repair/inbox'), contents)

    @unittest.skipUnless(shutil.which('systemd-analyze'), 'systemd-analyze runs in Linux CI')
    def test_systemd_analyze_verify_detached_render(self):
        paths = host.render_units(self.root, self.base / 'units')
        env = {**os.environ, 'SYSTEMD_UNIT_PATH': str(self.base / 'units') + ':'}
        result = subprocess.run(['systemd-analyze', '--user', 'verify', *paths],
                                capture_output=True, text=True, env=env)
        self.assertEqual(result.returncode, 0, result.stderr)


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
        with mock.patch.object(host, 'run', side_effect=stopped):
            host.prepare(self.root, self.overlay, self.raw, self.base / 'installed')
        self.assertTrue((self.runner / 'state/runner-disabled').is_file())
        self.assertTrue((self.base / 'installed/crq-tick.service').is_file())
        self.assertIn(['systemctl', '--user', 'daemon-reload'], calls)
        self.assertFalse(any('start' in argv or 'enable' in argv for argv in calls))

    def test_legacy_drift_is_read_only_and_allows_only_trigger_5_to_1(self):
        legacy = self.base / 'old'
        legacy.mkdir()
        committed = json.loads((ROOT / 'config.json').read_text())
        committed['promotion']['merges_trigger'] = 5
        committed['promotion']['dispatch_after_min'] = 20
        expected = host.apply(copy.deepcopy(committed), self.overlay)
        expected['promotion']['merges_trigger'] = 1
        (legacy / 'config.json').write_bytes(host.encode(expected))
        original = (legacy / 'config.json').read_bytes()
        with mock.patch.object(host, 'committed', return_value=committed), mock.patch.object(host, 'record') as audit:
            host.legacy_check(legacy, self.overlay, self.raw)
            audit.assert_called_once()
        self.assertEqual((legacy / 'config.json').read_bytes(), original)
        self.assertEqual(list(legacy.iterdir()), [legacy / 'config.json'])
        expected['promotion']['dispatch_after_min'] = 0
        (legacy / 'config.json').write_bytes(host.encode(expected))
        with mock.patch.object(host, 'committed', return_value=committed):
            with self.assertRaisesRegex(ValueError, 'dispatch_after_min'):
                host.legacy_check(legacy, self.overlay, self.raw)


if __name__ == '__main__':
    unittest.main()
