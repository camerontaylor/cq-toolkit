"""Policy overlay keys: repair switches and alert agent.

Split provenance: apps/crq-python/test_host_config.py was split into
test_host_config_overlay.py, test_host_config_policy.py, test_host_config_render.py,
test_host_config_switch.py, test_host_config_units.py, test_host_config_prepare.py
and test_host_config_legacy.py.
"""
import copy
import json
import unittest

from test_host_config_fixtures import HostConfigFixture, host


class HostConfigTests(HostConfigFixture, unittest.TestCase):
    def test_overlay_repair_switch_is_boolean_and_needs_committed_authorization(self):
        overlay = copy.deepcopy(self.overlay)
        overlay['config']['repair']['enabled'] = True
        host.validate(overlay)
        committed = host.committed(self.root)
        self.assertTrue(committed['repair']['enabled'])
        self.assertTrue(host.apply(committed, overlay)['repair']['enabled'])
        self.assertFalse(host.apply(committed, self.overlay)['repair']['enabled'])
        committed['repair']['spend_authorization'] = None
        with self.assertRaisesRegex(ValueError, 'spend authorization'):
            host.apply(committed, overlay)

    def test_overlay_blackout_switch_is_optional_boolean(self):
        committed = host.committed(self.root)
        self.assertIs(committed['repair']['blackout']['enabled'], False)
        host.validate(self.overlay)  # optional: absent keeps the committed value
        self.assertIs(host.apply(committed, self.overlay)['repair']['blackout']['enabled'], False)
        overlay = copy.deepcopy(self.overlay)
        overlay['config']['repair']['blackout'] = {'enabled': True}
        host.validate(overlay)
        rendered = host.apply(committed, overlay)['repair']['blackout']
        self.assertIs(rendered['enabled'], True)
        self.assertEqual(rendered['start'], committed['repair']['blackout']['start'])
        for value in [0, 1, None, 'true']:
            overlay['config']['repair']['blackout'] = {'enabled': value}
            with self.subTest(value=value), self.assertRaises(ValueError):
                host.validate(overlay)
        overlay['config']['repair']['blackout'] = {'start': '00:00'}
        with self.assertRaises(ValueError):
            host.validate(overlay)

    def test_missing_overlay_parent_is_a_refusal_not_a_created_block(self):
        # The accepted legacy baseline carries no repair.blackout object.
        committed = host.committed(self.root)
        del committed['repair']['blackout']
        overlay = copy.deepcopy(self.overlay)
        overlay['config']['repair']['blackout'] = {'enabled': True}
        host.validate(overlay)
        with self.assertRaisesRegex(ValueError, r'repair\.blackout'):
            host.apply(committed, overlay)

    def test_transition_legacy_record_template_is_checked_before_render(self):
        for template in ['http://queue.example.invalid/{item',
                         'http://queue.example.invalid/{unknown}', '{0}',
                         '{item.missing}', '{item:d}', '{item[999]}']:
            with self.subTest(template=template):
                overlay = copy.deepcopy(self.overlay)
                overlay['config']['promotion'] = {'record_url_template': template}
                with self.assertRaisesRegex(ValueError, 'record URL template'):
                    host.validate(overlay)
        for template in ['http://queue.example.invalid/{item}',
                         'http://queue.example.invalid/{{literal}}/{item!s}',
                         'http://queue.example.invalid/records']:
            with self.subTest(template=template):
                overlay = copy.deepcopy(self.overlay)
                overlay['config']['promotion'] = {'record_url_template': template}
                host.validate(overlay)

    def test_alert_agent_id_is_optional_and_rendered(self):
        host.validate(self.overlay)  # absent: the committed recipient stays
        overlay = copy.deepcopy(self.overlay)
        agent = '5626afa6-1349-4051-ae3a-e39d42cf8daa'
        overlay['config']['alerts']['alert_agent_id'] = agent
        host.validate(overlay)
        config = json.loads(host.render(self.root, overlay))
        self.assertEqual(config['alerts']['alert_agent_id'], agent)
        for bad in ['', '5626afa6', agent.upper(), agent + '\n', 5, None]:
            with self.subTest(bad=bad):
                overlay['config']['alerts']['alert_agent_id'] = bad
                with self.assertRaisesRegex(ValueError, 'alert_agent_id'):
                    host.validate(overlay)

    def test_transition_legacy_alert_recipient_renders_the_current_shape(self):
        overlay = copy.deepcopy(self.overlay)
        del overlay['config']['alerts']
        agent = '5626afa6-1349-4051-ae3a-e39d42cf8daa'
        overlay['config']['promotion'] = {'alert_agent_id': agent,
                                          'alert_agent_host': 'worker.example.invalid:6767'}
        host.validate(overlay)
        config = json.loads(host.render(self.root, overlay))
        self.assertNotIn('promotion', config)
        self.assertEqual(config['alerts']['alert_agent_id'], agent)
        self.assertEqual(config['alerts']['alert_agent_host'], 'worker.example.invalid:6767')


if __name__ == '__main__':
    unittest.main()
