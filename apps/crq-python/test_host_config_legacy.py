"""Legacy deployment checks: read-only drift and the accepted-HEAD fence.

Split provenance: apps/crq-python/test_host_config.py was split into
test_host_config_overlay.py, test_host_config_policy.py, test_host_config_render.py,
test_host_config_switch.py, test_host_config_units.py, test_host_config_prepare.py
and test_host_config_legacy.py.
"""
import copy
import json
import subprocess
import unittest
from unittest import mock

from test_host_config_fixtures import HostConfigFixture, ROOT, host


class HostConfigTests(HostConfigFixture, unittest.TestCase):
    def test_legacy_drift_is_read_only_and_allows_only_trigger_5_to_1(self):
        legacy = self.base / 'old'
        legacy.mkdir()
        committed = json.loads((ROOT / 'config.json').read_text())
        alerts = committed.pop('alerts')
        # The accepted legacy baseline predates the alerts rename.
        committed['promotion'] = {'merges_trigger': 5, 'dispatch_after_min': 20,
                                  'alert_agent_id': alerts['alert_agent_id'],
                                  'alert_agent_host': None}
        host.validate(self.overlay)
        self.raw = host.encode(self.overlay)
        expected = host.apply(copy.deepcopy(committed), self.overlay)
        self.assertEqual(expected['promotion']['alert_agent_host'],
                         self.overlay['config']['alerts']['alert_agent_host'])
        expected['promotion']['merges_trigger'] = 1
        (legacy / 'config.json').write_bytes(host.encode(expected))
        original = (legacy / 'config.json').read_bytes()
        def accepted_git(*args):
            return ' M config.json' if 'status' in args else host.LEGACY_SHA
        with mock.patch.object(host, 'git', side_effect=accepted_git), \
                mock.patch.object(host, 'committed', return_value=committed), \
                mock.patch.object(host, 'record') as audit:
            host.legacy_check(legacy, self.overlay, self.raw)
            audit.assert_called_once()
        self.assertEqual((legacy / 'config.json').read_bytes(), original)
        self.assertEqual(list(legacy.iterdir()), [legacy / 'config.json'])
        expected['promotion']['dispatch_after_min'] = 0
        (legacy / 'config.json').write_bytes(host.encode(expected))
        with mock.patch.object(host, 'git', side_effect=accepted_git), \
                mock.patch.object(host, 'committed', return_value=committed):
            with self.assertRaisesRegex(ValueError, 'dispatch_after_min'):
                host.legacy_check(legacy, self.overlay, self.raw)

    def test_legacy_fence_rejects_moved_head_even_with_matching_config(self):
        legacy = self.base / 'old'
        legacy.mkdir()
        original = b'{"same_config":true}\n'
        (legacy / 'config.json').write_bytes(original)
        subprocess.run(['git', '-C', str(legacy), 'init', '-q'], check=True)
        for args in [('config', 'user.name', 'Fixture'),
                     ('config', 'user.email', 'fixture@example.invalid'),
                     ('add', 'config.json'), ('commit', '-qm', 'accepted fixture')]:
            subprocess.run(['git', '-C', str(legacy), *args], check=True)
        accepted = host.git(legacy, 'rev-parse', 'HEAD')
        with mock.patch.object(host, 'LEGACY_SHA', accepted), \
                mock.patch.object(host, 'committed') as committed, \
                mock.patch.object(host, 'drift_check') as drift, \
                mock.patch.object(host, 'record') as audit:
            subprocess.run(['git', '-C', str(legacy), 'commit', '--allow-empty', '-qm', 'code-only move'], check=True)
            with self.assertRaisesRegex(ValueError, 'HEAD must match'):
                host.legacy_check(legacy, self.overlay, self.raw)
            committed.assert_not_called()
            drift.assert_not_called()
            audit.assert_not_called()
        self.assertEqual((legacy / 'config.json').read_bytes(), original)
        self.assertFalse((self.base / 'records').exists())

    def test_legacy_fence_rejects_tracked_edits_other_than_config(self):
        legacy = self.base / 'old'
        legacy.mkdir()
        (legacy / 'config.json').write_bytes(b'{"same_config":true}\n')
        (legacy / 'crq.py').write_text('accepted\n')
        subprocess.run(['git', '-C', str(legacy), 'init', '-q'], check=True)
        for args in [('config', 'user.name', 'Fixture'),
                     ('config', 'user.email', 'fixture@example.invalid'),
                     ('add', 'config.json', 'crq.py'), ('commit', '-qm', 'accepted fixture')]:
            subprocess.run(['git', '-C', str(legacy), *args], check=True)
        accepted = host.git(legacy, 'rev-parse', 'HEAD')
        (legacy / 'crq.py').write_text('locally edited\n')
        with mock.patch.object(host, 'LEGACY_SHA', accepted), \
                mock.patch.object(host, 'committed') as committed, \
                mock.patch.object(host, 'drift_check') as drift, \
                mock.patch.object(host, 'record') as audit:
            with self.assertRaisesRegex(ValueError, 'tracked changes other than config.json'):
                host.legacy_check(legacy, self.overlay, self.raw)
            committed.assert_not_called()
            drift.assert_not_called()
            audit.assert_not_called()


if __name__ == '__main__':
    unittest.main()
