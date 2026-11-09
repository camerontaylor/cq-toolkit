"""Overlay validation: schema, keys, endpoints, repos and spool refusals.

Split provenance: apps/crq-python/test_host_config.py was split into
test_host_config_overlay.py, test_host_config_policy.py, test_host_config_render.py,
test_host_config_switch.py, test_host_config_units.py, test_host_config_prepare.py
and test_host_config_legacy.py.
"""
import copy
import unittest

from test_host_config_fixtures import HostConfigFixture, host


class HostConfigTests(HostConfigFixture, unittest.TestCase):
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
        for enabled in [0, 1, None, 'false', 'true']:
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

    def test_overlay_requires_distinct_paseo_endpoints(self):
        overlay = copy.deepcopy(self.overlay)
        endpoint = overlay['config']['paseo_hosts'][0]
        for endpoints in ([endpoint, endpoint], [endpoint] * 3):
            with self.subTest(endpoints=endpoints):
                overlay['config']['paseo_hosts'] = endpoints
                with self.assertRaisesRegex(ValueError, 'two distinct'):
                    host.validate(overlay)
        overlay['config']['paseo_hosts'] = [endpoint, endpoint, 'other.example.invalid:6767']
        self.assertEqual(host.validate(overlay), overlay)

    def test_overlay_carries_per_repo_review_config(self):
        host.validate(self.overlay)  # absent: the committed empty list stays
        self.assertEqual(host.apply(host.committed(self.root), self.overlay)['repos'], [])
        overlay = copy.deepcopy(self.overlay)
        overlay['config']['repos'] = [
            {'repo': 'camerontaylor/infra', 'clone': str(self.base / 'infra'),
             'discovery': {'push': True, 'pr': False}, 'rank_tier': 3},
        ]
        self.assertEqual(host.validate(overlay), overlay)
        self.assertEqual(host.apply(host.committed(self.root), overlay)['repos'],
                         overlay['config']['repos'])
        for repos in ['camerontaylor/infra', {'repo': 'camerontaylor/infra'}, [1],
                      [{'clone': str(self.base / 'infra')}],
                      [{'repo': 'infra'}],
                      [{'repo': 'camerontaylor/infra', 'clone': 'relative/infra'}],
                      [{'repo': 'camerontaylor/infra', 'clone': '/srv/../infra'}],
                      [{'repo': 'camerontaylor/infra'},
                       {'repo': 'camerontaylor/infra'}]]:
            with self.subTest(repos=repos):
                bad = copy.deepcopy(self.overlay)
                bad['config']['repos'] = repos
                with self.assertRaises(ValueError):
                    host.validate(bad)

    def test_per_repo_clone_must_be_separate_from_deployment(self):
        for clone in (str(self.root), str(self.root / 'runtime'), str(self.base)):
            with self.subTest(clone=clone):
                overlay = copy.deepcopy(self.overlay)
                overlay['config']['repos'] = [{'repo': 'camerontaylor/infra', 'clone': clone}]
                with self.assertRaisesRegex(ValueError, 'repos clone must be separate'):
                    host.validate(overlay)

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
                spool = overlay['config'].setdefault('promotion', {}).setdefault(
                    'signer', {}).setdefault('spool', {})
                spool['ssh_alias'] = alias
                spool['ssh_key'] = '/fixture/key'
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
                spool = overlay['config'].setdefault('promotion', {}).setdefault(
                    'signer', {}).setdefault('spool', {})
                spool['ssh_alias'] = alias
                with self.assertRaisesRegex(ValueError, 'literal user@host'):
                    host.validate(overlay)

if __name__ == '__main__':
    unittest.main()
