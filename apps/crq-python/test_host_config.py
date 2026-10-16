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
                'timeout_bin': '/usr/bin/timeout',
                'paseo_hosts': ['worker.example.invalid:6767', '127.0.0.1:6767'],
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
            if argv[2] in {'list-unit-files', 'list-units'}:
                return ''
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
        for name in ('clone', 'worktree_root'):
            overlay = copy.deepcopy(self.overlay)
            overlay['config'][name] = str(self.root / 'runtime')
            with self.assertRaises(ValueError):
                host.validate(overlay)
        overlay = copy.deepcopy(self.overlay)
        overlay['fleet_reader']['ssh_host'] = '-oProxyCommand=bad'
        with self.assertRaises(ValueError):
            host.validate(overlay)

    def test_overlay_requires_both_paseo_endpoints(self):
        for endpoints in [None, 'worker:6767', [], ['worker:6767'],
                          ['worker:6767', ''], ['worker:6767', None]]:
            with self.subTest(endpoints=endpoints):
                overlay = copy.deepcopy(self.overlay)
                overlay['config']['paseo_hosts'] = endpoints
                with self.assertRaisesRegex(ValueError, 'at least two'):
                    host.validate(overlay)
        self.assertEqual(host.validate(self.overlay), self.overlay)

    def test_spool_alias_matches_runtime_client_format(self):
        import crq

        valid = ['operator@127.0.0.1', '_operator@queue-host',
                 'operator@queue.example.invalid', 'operator@2001:db8::1']
        invalid = ['queue-host', '-operator@host', 'operator@-host',
                   'operator@[::1]', 'operator@host alias', 'operator@host\n',
                   'operator@host;true', 'operator@@host', 'operator@host/path']
        for alias in valid + invalid:
            with self.subTest(alias=alias):
                overlay = copy.deepcopy(self.overlay)
                spool = overlay['config']['promotion']['signer']['spool']
                spool['ssh_alias'] = alias
                if alias in valid:
                    host.validate(overlay)
                    self.assertIsNone(crq.Spool(spool).refused)
                else:
                    with self.assertRaisesRegex(ValueError, 'literal user@host'):
                        host.validate(overlay)
                    self.assertIsNotNone(crq.Spool(spool).refused)
        for alias in ['', None, 123, []]:
            with self.subTest(alias=alias):
                overlay = copy.deepcopy(self.overlay)
                overlay['config']['promotion']['signer']['spool']['ssh_alias'] = alias
                with self.assertRaisesRegex(ValueError, 'literal user@host'):
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
            return 'active\n' if argv[:3] == ['systemctl', '--user', 'show'] else self.stopped(argv)
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

    def test_target_tracking_runtime_state_is_refused(self):
        state = self.runner / 'state'
        state.mkdir()
        (state / 'queue.json').write_text('{"must_not_overwrite":true}')
        self.command('add', '-f', 'apps/crq-python/state/queue.json')
        self.command('commit', '-qm', 'invalid tracked runtime state')
        target = self.command('rev-parse', 'HEAD').strip()
        self.command('update-ref', 'refs/remotes/origin/main', target)
        self.command('tag', '-a', 'crq-runner/20261016-5', '-m', 'invalid fixture')
        with self.assertRaisesRegex(ValueError, 'track runner state'):
            host.verify_target(self.root, target, 'crq-runner/20261016-5')

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
                    raise subprocess.CalledProcessError(1, argv)
                return self.stopped(argv)
            with self.subTest(listing=listing), mock.patch.object(host, 'run', side_effect=unavailable):
                with self.assertRaises(subprocess.CalledProcessError):
                    host.inactive(self.root)

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
        runtime = self.base / 'runtime-dir'
        runtime.mkdir(mode=0o700)
        env = {**os.environ, 'SYSTEMD_UNIT_PATH': str(self.base / 'units') + ':',
               'XDG_RUNTIME_DIR': str(runtime)}
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
        self.overlay['config']['promotion']['signer']['spool']['ssh_key'] = '~/.ssh/crq-spool-key'
        host.validate(self.overlay)
        self.raw = host.encode(self.overlay)
        expected = host.apply(copy.deepcopy(committed), self.overlay)
        self.assertEqual(expected['promotion']['signer']['spool']['ssh_key'], '~/.ssh/crq-spool-key')
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
