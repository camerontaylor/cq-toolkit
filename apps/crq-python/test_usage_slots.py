"""Offline slot arithmetic, systemd dedupe, and real tick admission decisions."""
import datetime as dt
import json
import subprocess
import unittest
from types import SimpleNamespace
from unittest import mock

import usage_slots
import test_author_quota as fixtures

crq = fixtures.crq
AT = dt.datetime(2026, 10, 28, 1, 1, tzinfo=dt.timezone.utc)


class UsageTest(unittest.TestCase):
    def test_complete_partial_and_unavailable(self):
        for included in ({'state': 'available', 'limit': 10, 'remaining': 2, 'rollingWindowMs': 3600000,
                          'fullCapacityInMs': 50000, 'repository': 'owner/repo'},
                         {'remaining': 0}, {'remaining': 10, 'limit': 10}):
            with self.subTest(included=included):
                result = usage_slots.parse_usage('bad line\n' + json.dumps({'status': 'partial', 'includedReviews': included}))
                self.assertEqual(result['remaining'], included['remaining'])
        for included in ({}, {'remaining': True}, {'remaining': -1}, {'remaining': '2'},
                         {'limit': 1, 'remaining': 2}, {'remaining': None}, {'state': 'unavailable', 'remaining': 3}):
            self.assertIsNone(usage_slots.parse_usage(json.dumps({'includedReviews': included})))
        self.assertIsNone(usage_slots.parse_usage('null\n[]\n{}'))

    def test_probe_uses_clone_and_bounds_failures(self):
        with mock.patch.object(usage_slots.subprocess, 'run', return_value=SimpleNamespace(
                returncode=0, stdout='{"includedReviews":{"remaining":3}}')) as run:
            self.assertEqual(usage_slots.read_usage('/fixture/clone'), {'remaining': 3})
            self.assertEqual(run.call_args.kwargs['cwd'], '/fixture/clone')
            self.assertEqual(run.call_args.kwargs['timeout'], 20)
        for exc in (FileNotFoundError(), subprocess.TimeoutExpired('coderabbit', 20)):
            with mock.patch.object(usage_slots.subprocess, 'run', side_effect=exc):
                self.assertIsNone(usage_slots.read_usage('/fixture/clone'))
        with mock.patch.object(usage_slots.subprocess, 'run', return_value=SimpleNamespace(
                returncode=1, stdout='{"includedReviews":{"remaining":3}}')):
            self.assertIsNone(usage_slots.read_usage('/fixture/clone'))

    def test_next_slot_exact_boundary_and_vendor_full_is_not_next(self):
        old = AT - dt.timedelta(minutes=60)
        recent = AT - dt.timedelta(minutes=59, seconds=43)
        usage = {'remaining': 0, 'fullCapacityInMs': 300000, 'rollingWindowMs': 3600000}
        self.assertEqual(usage_slots.next_slot([old, recent], AT, usage), AT + dt.timedelta(seconds=17))
        self.assertEqual(usage_slots.next_slot([], AT, usage), AT + dt.timedelta(minutes=5))
        self.assertIsNone(usage_slots.next_slot([old], AT, None))

    def test_wake_dedupes_checks_liveness_and_retries_failed_creation(self):
        deadline = AT + dt.timedelta(seconds=17)
        target = crq.iso(deadline)
        run = mock.Mock(return_value=SimpleNamespace(returncode=0))
        self.assertEqual(usage_slots.schedule_wake(deadline, AT, target, run), target)
        self.assertEqual(run.call_count, 1)
        run.reset_mock()
        run.side_effect = [SimpleNamespace(returncode=3), SimpleNamespace(returncode=0),
                           SimpleNamespace(returncode=0)]
        self.assertEqual(usage_slots.schedule_wake(deadline, AT, target, run), target)
        argv = run.call_args.args[0]
        self.assertIn('--on-active=17s', argv)
        self.assertIn('--timer-property=AccuracySec=1s', argv)
        self.assertEqual(argv[-1], 'crq-tick.service')
        run.reset_mock(side_effect=True)
        run.return_value = SimpleNamespace(returncode=1)
        self.assertIsNone(usage_slots.schedule_wake(deadline, AT, None, run))
        run.reset_mock()
        self.assertIsNone(usage_slots.schedule_wake(AT + dt.timedelta(minutes=12), AT, None, run))
        run.assert_not_called()


class ConcurrencyTest(unittest.TestCase):
    def setUp(self):
        fixtures.TickTest.setUp(self)
        crq.CONFIG.update(max_inflight=10, max_starts_per_tick=10)
        self.plan = dict(base=fixtures.BASE, head=fixtures.HEAD, target='origin/merge-queue',
                         label='fixture', notes=[])
        self.started = []
        def launch(q, item, plan):
            self.started.append(item['id'])
            item['state'] = 'reviewing'
            q['starts'].append(crq.iso())
            return item['id']
        for name, value in [('launch', launch), ('plan_promotion', lambda item: self.plan),
                            ('plan_open', lambda *args: self.plan),
                            ('pr_info', lambda pr: {'state': 'OPEN'}),
                            ('quiet_reason', lambda *args, **kwargs: None),
                            ('post_promotion_status', lambda *args: None)]:
            patch = mock.patch.object(crq, name, value)
            patch.start()
            self.addCleanup(patch.stop)
        self.usage = mock.patch.object(crq.usage_slots, 'read_usage', return_value={'remaining': 3})
        self.probe = self.usage.start()
        self.addCleanup(self.usage.stop)

    def items(self):
        self.q['items'] = [dict(id=i, kind='promotion' if i == 'promotion' else 'open',
                                state='pending', pr=n, order=n, operator_priority=i == 'prioritized',
                                base_sha=fixtures.BASE, batch_sha=fixtures.HEAD)
                           for n, i in enumerate(['normal', 'prioritized', 'promotion', 'later'])]

    def test_multi_start_preserves_priority_and_vendor_slots_override_old_cap(self):
        self.items()
        self.q['starts'] = [crq.iso()] * 5
        crq.tick()
        self.assertEqual(self.started, ['promotion', 'prioritized', 'normal'])
        self.assertEqual(len(crq.inflight(self.q)), 3)

    def test_ceiling_inflight_and_zero_vendor_slots(self):
        for remaining, ceiling, inflight, expected in [(10, 2, 10, 2), (10, 10, 1, 1), (0, 10, 10, 0)]:
            with self.subTest(remaining=remaining, ceiling=ceiling, inflight=inflight):
                self.items()
                self.q['starts'] = []
                self.started.clear()
                crq.CONFIG.update(max_starts_per_tick=ceiling, max_inflight=inflight)
                self.probe.return_value = {'remaining': remaining}
                crq.tick()
                self.assertEqual(len(self.started), expected)

    def test_harvests_each_run_before_refilling_capacity(self):
        self.items()
        for item in self.q['items'][:2]:
            item['state'] = 'reviewing'
        crq.CONFIG['max_inflight'] = 2
        def harvest(q, item, dry):
            item['state'] = 'done'
        with mock.patch.object(crq, 'harvest_review', side_effect=harvest) as harvest:
            crq.tick()
        self.assertEqual(harvest.call_count, 2)
        self.assertEqual(self.started, ['promotion', 'later'])

    def test_second_precision_cooldown_uses_exit_time_and_never_shortens(self):
        rdir = self.root / 'run'
        rdir.mkdir()
        stream = rdir / 'review.ndjson'
        for wait, expected in [('17 seconds', 17), ('0 seconds', 0), ('2 minutes', 120),
                               ('1 hour', 3600), ('unknown', None)]:
            stream.write_text(json.dumps({'type': 'error', 'errorType': 'rate_limit',
                                          'recoverable': True, 'metadata': {'waitTime': wait}}))
            self.assertEqual(crq.classify(stream, 1)['wait_seconds'], expected)
        (rdir / 'exit.json').write_text(json.dumps({'ended_at': crq.iso(AT)}))
        with mock.patch.object(crq, 'now', return_value=AT + dt.timedelta(minutes=2)):
            crq.set_rate_cooldown(self.q, {'wait_seconds': 17}, rdir)
        self.assertEqual(self.q['cooldown_until'], crq.iso(AT + dt.timedelta(seconds=17)))
        crq.set_rate_cooldown(self.q, {'wait_seconds': 5}, rdir)
        self.assertEqual(self.q['cooldown_until'], crq.iso(AT + dt.timedelta(seconds=17)))


if __name__ == '__main__':
    unittest.main()
