"""Live render, switch, rollback and drift refusals on a detached clone.

Split provenance: apps/crq-python/test_host_config.py was split into
test_host_config_overlay.py, test_host_config_policy.py, test_host_config_render.py,
test_host_config_switch.py, test_host_config_units.py, test_host_config_prepare.py
and test_host_config_legacy.py.
"""
import fcntl
import json
import subprocess
import unittest
from unittest import mock

from test_host_config_fixtures import HostConfigFixture, host


class HostConfigTests(HostConfigFixture, unittest.TestCase):
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
        self.assertEqual(json.loads((self.runner / 'config.json').read_text())['quiet_minutes'], 31)
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
        config['quiet_minutes'] = 32
        (self.runner / 'config.json').write_bytes(host.encode(config))
        before = (self.runner / 'config.json').read_bytes()
        with mock.patch.object(host, 'run', side_effect=self.stopped):
            with self.assertRaisesRegex(ValueError, 'quiet_minutes'):
                host.switch(self.root, self.overlay, self.raw, self.target, self.tag)
        self.assertEqual(self.command('rev-parse', 'HEAD').strip(), self.before)
        self.assertEqual((self.runner / 'config.json').read_bytes(), before)
        self.assertFalse((self.base / 'records').exists())

    def test_switch_upgrades_a_legacy_source_with_the_transition_overlay(self):
        # The deployed source predates the alerts rename. switch() renders that
        # source under the new overlay before checkout, so its host values must
        # still be reproducible byte-for-byte or the drift fence blocks upgrade.
        new_config = json.loads((self.runner / 'config.json').read_text())
        new_config['quiet_minutes'] = 31
        new_bytes = host.encode(new_config)
        legacy = {key: value for key, value in new_config.items() if key != 'alerts'}
        legacy['quiet_minutes'] = 30
        legacy['promotion'] = {
            'record_url_template': None, 'alert_agent_id': None, 'alert_agent_host': None,
            'signer': {'spool': {'ssh_alias': '@HOST_SPOOL_SSH_ALIAS@', 'ssh_key': None}},
        }
        (self.runner / 'config.json').write_bytes(host.encode(legacy))
        self.command('commit', '-qam', 'legacy source')
        source = self.command('rev-parse', 'HEAD').strip()
        (self.runner / 'config.json').write_bytes(new_bytes)
        self.command('commit', '-qam', 'phase 0.1 target')
        target = self.command('rev-parse', 'HEAD').strip()
        self.command('update-ref', 'refs/remotes/origin/main', target)
        tag = 'crq-runner/20261109-1'
        self.command('tag', '-a', tag, target, '-m', 'upgrade fixture approval')
        self.command('checkout', '-q', '--detach', source)

        overlay = {
            'schema_version': 1, 'deploy_root': str(self.root),
            'record_dir': str(self.base / 'records'),
            'fleet_reader': {'ssh_host': 'queue.example.invalid',
                             'source': '/srv/state/crq/summary.json'},
            'config': {
                'clone': str(self.base / 'runtime'),
                'worktree_root': str(self.base / 'worktrees'),
                'timeout_bin': '/usr/bin/timeout',
                'paseo_hosts': ['worker.example.invalid:6767', '127.0.0.1:6767'],
                'promotion': {
                    'record_url_template': 'http://queue.example.invalid:6778/promotion/{item}',
                    'alert_agent_host': 'worker.example.invalid:6767',
                    'alert_agent_id': '5626afa6-1349-4051-ae3a-e39d42cf8daa',
                    'signer': {'spool': {'ssh_alias': 'operator@127.0.0.1',
                                         'ssh_key': '~/.ssh/crq-spool-ed25519'}},
                },
                'repair': {'enabled': False, 'cq_bin': str(self.base / 'runtime/dist/cli.js'),
                           'paseo_host': '127.0.0.1:6767'},
            },
        }
        raw = host.encode(overlay)
        (self.runner / 'config.json').write_bytes(host.encode(host.apply(legacy, overlay)))
        with mock.patch.object(host, 'run', side_effect=self.stopped):
            host.switch(self.root, overlay, raw, target, tag)
        final = json.loads((self.runner / 'config.json').read_text())
        self.assertNotIn('promotion', final)
        self.assertEqual(final['alerts']['alert_agent_id'],
                         '5626afa6-1349-4051-ae3a-e39d42cf8daa')
        self.assertEqual(final['alerts']['alert_agent_host'], 'worker.example.invalid:6767')
        self.assertEqual(final['quiet_minutes'], 31)

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

    def test_a_merged_main_sha_switches_without_a_tag(self):
        # A merged main SHA is deployable on its own: verify_target's
        # origin/main ancestry check is the proof, and switch records no tag.
        self.rendered()
        with mock.patch.object(host, 'run', side_effect=self.stopped):
            host.switch(self.root, self.overlay, self.raw, self.target)
        self.assertEqual(self.command('rev-parse', 'HEAD').strip(), self.target)
        self.assertEqual(self.command('status', '--porcelain').rstrip(),
                         ' M ' + host.CONFIG)
        records = [json.loads(p.read_text())
                   for p in (self.base / 'records').glob('*.json')]
        self.assertEqual({r['operation'] for r in records},
                         {'switch-before', 'switch-render'})
        self.assertTrue(all(r['tag'] is None for r in records))

    def test_an_unmerged_sha_is_refused_without_a_tag(self):
        self.command('commit', '--allow-empty', '-qm', 'not on main')
        unmerged = self.command('rev-parse', 'HEAD').strip()
        with self.assertRaises(subprocess.CalledProcessError):
            host.verify_target(self.root, unmerged, None)


if __name__ == '__main__':
    unittest.main()
