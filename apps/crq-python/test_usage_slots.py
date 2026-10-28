"""Offline slot arithmetic, timestamp-first entry, and real admission decisions."""
import datetime as dt
import json
import tempfile
from pathlib import Path
import subprocess
import unittest
from types import SimpleNamespace
from unittest import mock

import usage_slots
import test_author_quota as fixtures

crq = fixtures.crq
REFRESH = crq.refresh_slot_deadline
BACKOFF = crq.apply_signer_backoff
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
        self.assertEqual(usage_slots.next_slot([], AT, usage), AT + dt.timedelta(seconds=60))
        self.assertEqual(usage_slots.next_slot([old], AT, None), AT + dt.timedelta(seconds=60))

    def test_vendor_reservation_lag_retries_within_one_minute(self):
        starts = [AT - dt.timedelta(hours=1)] + [AT - dt.timedelta(minutes=30)] * 9
        self.assertEqual(usage_slots.next_slot(starts, AT, {'limit': 10, 'remaining': 0,
                                                          'fullCapacityInMs': 1800000}),
                         AT + dt.timedelta(seconds=60))


class ConcurrencyTest(unittest.TestCase):
    def setUp(self):
        fixtures.TickTest.setUp(self)
        crq.CONFIG.update(max_inflight=10, max_starts_per_tick=10)
        self.runs = self.root / 'runs'
        self.runs.mkdir()
        runs = mock.patch.object(crq, 'RUNS', self.runs)
        runs.start()
        self.addCleanup(runs.stop)
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

    def test_unknown_signer_delivery_consumes_one_admission(self):
        for remaining, limit, expected_launches in [(1, 10, 0), (10, 1, 0), (2, 2, 1)]:
            with self.subTest(remaining=remaining, max_inflight=limit):
                self.items()
                self.started.clear()
                self.q['starts'] = []
                promotion = next(i for i in self.q['items'] if i['kind'] == 'promotion')
                promotion['id'] = 'promo-' + fixtures.HEAD[:10]
                crq.CONFIG['max_inflight'] = limit
                with mock.patch.object(crq, 'promotion_mode', return_value='signer'), \
                     mock.patch.object(crq, 'main_sha', return_value=fixtures.BASE), \
                     mock.patch.object(crq.SPOOL, 'write_request', side_effect=crq.SpoolUnreachable('unknown')) as write, \
                     mock.patch.object(crq, 'spool_unreachable', return_value='unknown delivery'):
                    _, _, remaining_after = crq.admit_available(self.q, {'remaining': remaining}, [])
                write.assert_called_once()
                self.assertEqual(promotion['state'], 'requested')
                self.assertTrue(promotion['request']['dispatch_pending'])
                self.assertEqual(len(self.started), expected_launches)
                self.assertEqual(len(self.q['starts']), 1 + expected_launches)
                self.assertLessEqual(len(crq.inflight(self.q)), limit)
                self.assertEqual(remaining_after, remaining - 1 - expected_launches)

    def test_minute_leaves_first_current_capture_to_fetching_tick(self):
        for minute, captured, expected in [(True, False, 0), (True, True, 1), (False, False, 1)]:
            with self.subTest(minute=minute, captured=captured):
                self.started.clear()
                self.q['starts'] = []
                item = dict(id='current', kind=crq.review_receipt.KIND, state='pending', order=1)
                if captured:
                    item['capture'] = {'target': fixtures.HEAD}
                self.q['items'] = [item]
                with mock.patch.object(crq, 'prepare_current', return_value=self.plan) as prepare, \
                     mock.patch.object(crq, 'refresh_slot_deadline', REFRESH), \
                     mock.patch.object(crq, 'fetch') as fetch:
                    (crq.slot if minute else crq.tick)()
                self.assertEqual(prepare.call_count, expected)
                self.assertEqual(len(self.started), expected)
                if minute:
                    fetch.assert_not_called()
                else:
                    fetch.assert_called_once()

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

    def test_slot_multi_start_and_idle_backoff_without_full_tick_work(self):
        self.items()
        with mock.patch.object(crq, 'refresh_slot_deadline', REFRESH), \
             mock.patch.object(crq, 'now', return_value=AT), \
             mock.patch.object(crq, 'fetch') as fetch:
            crq.slot()
            self.assertEqual(self.started, ['promotion', 'prioritized', 'normal'])
            fetch.assert_not_called()
            self.q['items'] = []
            crq.slot()
        self.assertEqual((self.root / 'next-review-at').read_text().strip(),
                         crq.iso(AT + dt.timedelta(minutes=12)))

    def test_slot_waits_subminute_and_rechecks_vendor_before_start(self):
        self.items()
        self.q['starts'] = [crq.iso(AT - dt.timedelta(minutes=59, seconds=43))] * 10
        clock = [AT]
        self.probe.side_effect = [{'limit': 10, 'remaining': 0}, {'limit': 10, 'remaining': 2}]
        def sleep(seconds):
            clock[0] += dt.timedelta(seconds=seconds)
        with mock.patch.object(crq, 'refresh_slot_deadline', REFRESH), \
             mock.patch.object(crq, 'now', side_effect=lambda: clock[0]), \
             mock.patch.object(crq.time, 'sleep', side_effect=sleep) as wait:
            crq.slot()
        wait.assert_called_once_with(17)
        self.assertEqual(self.probe.call_count, 2)
        self.assertEqual(self.started, ['promotion', 'prioritized'])

    def test_repeated_usage_does_not_spend_outstanding_reservations(self):
        self.items()
        crq.tick()
        self.assertEqual(len(self.started), 3)
        with mock.patch.object(crq, 'refresh_slot_deadline', REFRESH):
            crq.slot()  # unchanged usage still includes the detached reservations
        self.assertEqual(len(self.started), 3)

    def test_signer_reservations_survive_claims_and_the_local_hour(self):
        for state in ('requested', 'signer_running', 'blocked'):
            with self.subTest(state=state):
                signer = dict(id='signer', kind='promotion', state=state,
                              request={'requested_at': crq.iso(AT - dt.timedelta(hours=2)),
                                       'reconciliation_required': state == 'blocked'})
                self.q['items'] = [signer, dict(id='next', kind='open', state='pending', pr=1)]
                self.probe.return_value = {'remaining': 1}
                with mock.patch.object(crq, 'now', return_value=AT):
                    usage, held = crq.read_slot_usage(self.q)
                    crq.admit_available(self.q, usage, [], reserved=held)
                self.assertEqual(self.started, [])
                self.assertEqual(len(held), 1)

    def test_blocked_signer_reservation_occupies_inflight_capacity(self):
        signer = dict(id='signer', kind='promotion', state='blocked',
                      request={'requested_at': crq.iso(AT), 'reconciliation_required': True})
        self.q['items'] = [signer, dict(id='next', kind='open', state='pending', pr=1)]
        crq.CONFIG['max_inflight'] = 1
        self.probe.return_value = {'remaining': 2}
        usage, held = crq.read_slot_usage(self.q)
        _, gate, remaining = crq.admit_available(self.q, usage, [], reserved=held)
        self.assertEqual(held, [signer['request']['requested_at']])
        self.assertEqual(crq.inflight(self.q), [signer])
        self.assertEqual(gate, 'inflight')
        self.assertEqual(remaining, 1)
        self.assertEqual(self.started, [])
        self.assertEqual(self.q['starts'], [])

    def test_vendor_progress_precedes_usage_and_requires_a_valid_probe(self):
        run = dict(run_id='delayed', started_at=crq.iso(AT))
        self.q['items'] = [dict(id='delayed', kind='open', state='reviewing', run=run)]
        rdir = self.runs / 'delayed'
        rdir.mkdir()
        stream = rdir / 'review.ndjson'
        stream.write_text('{"type":"review_context"}\n')
        def late_progress(clone):
            stream.write_text('{"type":"heartbeat","status":"reviewing"}\n')
            return {'remaining': 9}
        self.probe.side_effect = late_progress
        _, held = crq.read_slot_usage(self.q)
        self.assertEqual(len(held), 1)
        self.assertNotIn('vendor_observed', run)
        self.probe.side_effect = None
        self.probe.return_value = None
        crq.read_slot_usage(self.q)
        self.assertNotIn('vendor_observed', run)
        self.probe.return_value = {'remaining': 9}
        _, held = crq.read_slot_usage(self.q)
        self.assertEqual(held, [])
        self.assertTrue(run['vendor_observed'])
        stream.unlink()
        _, held = crq.read_slot_usage(self.q)
        self.assertEqual(held, [])

    def test_old_progress_stays_reserved_when_usage_is_unavailable(self):
        self.items()
        run = dict(run_id='old-progress', started_at=crq.iso(AT - dt.timedelta(hours=2)))
        self.q['items'].append(dict(id='old-progress', kind='open', state='reviewing', run=run))
        rdir = self.runs / run['run_id']
        rdir.mkdir()
        (rdir / 'review.ndjson').write_text('{"type":"status","status":"reviewing"}\n')
        self.probe.return_value = None
        self.q['starts'] = [crq.iso(AT)] * 4
        with mock.patch.object(crq, 'now', return_value=AT):
            usage, held = crq.read_slot_usage(self.q)
            crq.admit_available(self.q, usage, [], reserved=held)
        self.assertEqual(held, [run['started_at']])
        self.assertNotIn('vendor_observed', run)
        self.assertEqual(self.started, [])

    def test_fallback_counts_recent_holds_once_and_keeps_older_holds(self):
        self.items()
        self.q['starts'] = [crq.iso(AT)] * 4
        with mock.patch.object(crq, 'now', return_value=AT):
            crq.admit_available(self.q, None, [], reserved=[crq.iso(AT)])
        self.assertEqual(len(self.started), 1)
        self.started.clear()
        self.items()
        self.q['starts'] = [crq.iso(AT)] * 4
        with mock.patch.object(crq, 'now', return_value=AT):
            crq.admit_available(self.q, None, [], reserved=[crq.iso(AT - dt.timedelta(hours=2))])
        self.assertEqual(self.started, [])

    def test_minute_admission_applies_actual_signer_backoff(self):
        until = AT + dt.timedelta(minutes=5)
        for reason, expected in [('rate_limit', 0), ('budget', 3)]:
            with self.subTest(reason=reason):
                self.items()
                self.q['cooldown_until'] = None
                self.started.clear()
                with mock.patch.object(crq, 'PROMO', {'enabled': True}), \
                     mock.patch.object(crq, 'promotion_mode', return_value='signer'), \
                     mock.patch.object(crq, 'apply_signer_backoff', BACKOFF), \
                     mock.patch.object(crq.SPOOL, 'read', return_value=json.dumps(
                         dict(v=1, until=crq.iso(until), reason=reason))), \
                     mock.patch.object(crq, 'now', return_value=AT), \
                     mock.patch.object(crq, 'refresh_slot_deadline', REFRESH):
                    crq.slot()
                self.assertEqual(len(self.started), expected)
                if reason == 'rate_limit':
                    self.assertEqual(self.q['cooldown_until'], crq.iso(until))

    def test_undated_retry_does_not_sleep_under_lock(self):
        self.items()
        self.probe.return_value = {'remaining': 0}
        self.q['items'].append(dict(id='active', kind='open', state='reviewing'))
        with mock.patch.object(crq, 'refresh_slot_deadline', REFRESH), \
             mock.patch.object(crq.time, 'sleep') as sleep:
            crq.slot()  # real clock advances between deadline calculation and check
        sleep.assert_not_called()
        self.assertEqual(self.probe.call_count, 1)

    def test_only_dead_verifiable_exits_reach_harvest(self):
        self.q['items'] = []
        for rid in ('dead', 'alive', 'ambiguous', 'no-exit'):
            self.q['items'].append(dict(id=rid, kind='open', state='reviewing', run={'run_id': rid}))
            rdir = self.runs / rid
            rdir.mkdir()
            if rid != 'no-exit':
                (rdir / 'exit.json').write_text('{}')
        def liveness(rdir, item, run, has_exit):
            return {'dead': 'harvest', 'alive': 'alive', 'ambiguous': 'ambiguous'}[item['id']]
        with mock.patch.object(crq, 'run_liveness', side_effect=liveness) as probe, \
             mock.patch.object(crq, 'harvest_review', return_value='collected') as harvest:
            log = []
            crq.collect_finished(self.q, log)
        self.assertEqual(probe.call_count, 3)
        harvest.assert_called_once_with(self.q, self.q['items'][0], False)
        self.assertEqual(log, ['collected'])

    def test_minute_collection_records_result_before_refilling_and_honors_auth(self):
        for outcome in ('completed', 'auth'):
            with self.subTest(outcome=outcome):
                self.items()
                self.q['paused'] = False
                self.q['author_requests'] = {}
                self.started.clear()
                crq.CONFIG['max_inflight'] = 1
                rdir = fixtures.HarvestTest._run_dir(self, outcome, exit_code=0 if outcome == 'completed' else 1)
                item = fixtures.HarvestTest._item(self, self.q, outcome)
                event = ({'type': 'complete', 'status': 'review_completed'} if outcome == 'completed' else
                         {'type': 'error', 'errorType': 'auth'})
                (rdir / 'review.ndjson').write_text(json.dumps(event) + '\n')
                with mock.patch.object(crq, 'pid_alive', return_value=False), \
                     mock.patch.object(crq, 'group_alive', return_value=False), \
                     mock.patch.object(crq, 'remove_worktree'), \
                     mock.patch.object(crq, 'findings_md', return_value=''), \
                     mock.patch.object(crq, 'refresh_slot_deadline', REFRESH), \
                     mock.patch.object(crq, 'fetch') as fetch, \
                     mock.patch.object(crq, 'enroll') as enroll, \
                     mock.patch.object(crq, 'promotion_audit') as audit:
                    crq.slot()
                fetch.assert_not_called()
                enroll.assert_not_called()
                audit.assert_not_called()
                if outcome == 'completed':
                    self.assertEqual(item['state'], 'done')
                    self.assertEqual(len(item['author_cycles']), 1)
                    self.assertEqual(self.started, ['promotion'])
                else:
                    self.assertTrue(self.q['paused'])
                    self.assertEqual(item['state'], crq.author_quota.AUTHOR_FAILED)
                    self.assertEqual(self.started, [])

    def test_active_runs_keep_collection_hint_at_next_minute_during_cooldown(self):
        self.items()
        self.q['items'][0]['state'] = 'reviewing'
        at = AT + dt.timedelta(seconds=17)
        self.q['cooldown_until'] = crq.iso(at + dt.timedelta(hours=1))
        with mock.patch.object(crq, 'now', return_value=at):
            actual = REFRESH(self.q, {'remaining': 0}, 0, 'cooldown')
        self.assertEqual(actual, at + dt.timedelta(hours=1))
        self.assertEqual((self.root / 'next-review-at').read_text().strip(),
                         crq.iso(AT + dt.timedelta(minutes=1)))

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
