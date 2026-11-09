"""Render precedence and record integrity: committed tree wins, hashes preserved.

Split provenance: apps/crq-python/test_host_config.py was split into
test_host_config_overlay.py, test_host_config_policy.py, test_host_config_render.py,
test_host_config_switch.py, test_host_config_units.py, test_host_config_prepare.py
and test_host_config_legacy.py.
"""
import json
import unittest

from test_host_config_fixtures import HostConfigFixture, host


class HostConfigTests(HostConfigFixture, unittest.TestCase):
    def test_detached_prefixed_committed_render_not_worktree(self):
        (self.runner / 'config.json').write_text('{"not": "committed"}')
        data = host.render(self.root, self.overlay)
        config = json.loads(data)
        self.assertEqual(config['quiet_minutes'], 30)
        self.assertEqual(config['alerts']['alert_agent_host'],
                         self.overlay['config']['alerts']['alert_agent_host'])
        self.assertEqual(config['clone'], self.overlay['config']['clone'])
        self.assertFalse(config['repair']['enabled'])
        self.assertEqual(data, host.encode(config))
        host.root_check(self.root, self.overlay)

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


if __name__ == '__main__':
    unittest.main()
