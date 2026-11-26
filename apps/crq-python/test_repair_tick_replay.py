"""Terminal-failure replay must be O(new) per tick, not runs x outbox size.

Synthetic fixtures only: a large publication outbox and many terminal-failed
repair runs, with no network and no live state."""
import copy
import hashlib
import json
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import finding_delivery
import repair_tick
import review_ledger as ledger

AT = '2026-11-26T00:00:00Z'
CHAIN = 34  # events per finding: 300 findings x 34 is about 10k outbox files


def seed_event(source_key, payload):
    """Same shape as a retained finding event. The id is a plain digest of the
    seed (`recover` and the replay never re-hash it), which keeps building a
    10k-event outbox fast; strict `ledger.loads` still checks every file's
    canonical form when the outbox is first read."""
    value = {"schema": "cq.review-ledger/v1", "event_type": "finding-event",
             "source_key": source_key, "occurred_at": AT, "payload": payload}
    value["id"] = hashlib.sha256(source_key.encode()).hexdigest()
    return value


class Fixture:
    def __init__(self, root, findings, chain=CHAIN, jobs_per_run=1, unsettled=None):
        self.root = Path(root)
        self.outbox = ledger.Outbox(self.root / 'state/backfill/publication', None)
        self.inbox = finding_delivery.Inbox(self.root / 'state/backfill/findings', self.outbox)
        self.items = []
        for n in range(findings):
            fid = format(n + 1, '064x')
            previous = None
            for step in range(chain):
                last = step == chain - 1
                job = 'crq-job-%d-0' % n
                evidence = {'acknowledgement': 'ack', 'repair_task': job} if last else {'reason': 'step %d' % step}
                event = seed_event('seed:%s:%d' % (fid, step), {
                    'finding_id': fid, 'review_id': 'e' * 64, 'previous_event_id': previous,
                    'action': 'delivered' if last else 'needs-retriage', 'evidence': evidence, 'actor': 'judge'})
                self.write_event(event)
                previous = event['id']
            row = {'review_id': 'e' * 64, 'finding': {'id': fid}, 'canonical_id': fid, 'status': 'delivered',
                   'previous_event_id': previous, 'receipt': {'acknowledgement': 'ack', 'repair_task': 'crq-job-%d-0' % n}}
            ledger.atomic(self.root / 'state/backfill/findings/triage' / (fid + '.json'), ledger.canonical(row))
            jobs = ['crq-job-%d-%d' % (n, k) for k in range(jobs_per_run)]
            for k, job in enumerate(jobs):
                self.write_job(n, k, job, fid)
            self.items.append({'id': 'item-%d' % n, 'kind': 'merged', 'state': 'repair_failed', 'repair_runs': {
                'run-%d' % n: {'state': 'failed', 'jobs': jobs, 'base': 'b' * 40,
                               'verdicts': [{'job': jobs[0], 'item': 'item-%d' % n, 'verdict': 'FAILED',
                                             'reason': 'invalid repair result: synthetic'}]}}})
        # Runs a previous tick already settled carry the persisted flag.
        for item in self.items[unsettled:] if unsettled is not None else ():
            for record in item['repair_runs'].values():
                record['siblings_recorded'] = list(record['jobs'])
        self.queue = {'items': self.items}
        self.c = SimpleNamespace(STATE=self.root / 'state', CONFIG={'repair': {}}, iso=lambda: AT, save_queue=mock.Mock())

    def write_event(self, event):
        path = self.outbox.root / 'pending' / (event['id'] + '.json')
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(json.dumps(event, sort_keys=True, separators=(',', ':')).encode())

    def write_job(self, n, k, job, fid):
        inbox = self.root / 'state/repair/inbox'
        inbox.mkdir(parents=True, exist_ok=True)
        (inbox / (job + '.json')).write_text(json.dumps({
            'job': job, 'item': 'item-%d' % n, 'canonical_finding_id': fid, 'finding': {'body': 'x'}}))

    def write_result(self, job, verdict):
        out = self.root / 'state/repair' / job
        out.mkdir(parents=True, exist_ok=True)
        item = json.loads((self.root / 'state/repair/inbox' / (job + '.json')).read_text())['item']
        (out / 'result.json').write_text(json.dumps({'job': job, 'item': item, 'verdict': verdict, 'reason': 'r'}))

    def tick(self, **limits):
        repair_tick.begin_tick(self.c, **limits)
        for item in self.items:
            repair_tick.harvest(self.c, self.queue, item)

    def outbox_ids(self):
        return sorted(p.name for p in (self.root / 'state/backfill/publication/pending').glob('*.json'))

    def rows(self):
        return {p.name: p.read_bytes() for p in (self.root / 'state/backfill/findings/triage').glob('*.json')}


class ReplayBase(unittest.TestCase):
    def build(self, findings, **kw):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.f = Fixture(tmp.name, findings, **kw)
        patcher = mock.patch.object(repair_tick, 'finding_inbox', lambda c: self.f.inbox)
        patcher.start()
        self.addCleanup(patcher.stop)
        return self.f


class LargeOutboxReplayTest(ReplayBase):
    def test_second_tick_does_no_replay_work(self):
        f = self.build(300, unsettled=25)
        self.assertGreaterEqual(len(f.outbox_ids()), 10000)
        retained = mock.Mock(wraps=f.outbox.retained)
        with mock.patch.object(f.outbox, 'retained', retained):
            started = time.monotonic()
            f.tick(count=1000, seconds=3600)
            first = time.monotonic() - started
            first_reads = retained.call_count
            retained.reset_mock()
            outcomes = mock.Mock(wraps=f.inbox.repair_outcome)
            with mock.patch.object(f.inbox, 'repair_outcome', outcomes):
                started = time.monotonic()
                f.tick(count=1000, seconds=3600)
                second = time.monotonic() - started
        # Tick one replays the 25 unsettled runs; each outcome reads the outbox a bounded number of times.
        self.assertGreaterEqual(first_reads, 25)
        self.assertLessEqual(first_reads, 2 * 25)
        # Tick two: every run is settled, so nothing touches the outbox or the ledger.
        self.assertEqual(retained.call_count, 0)
        self.assertEqual(outcomes.call_count, 0)
        self.assertLess(second, 5.0, 'settled tick took %.2fs (first %.2fs)' % (second, first))
        for item in f.items:
            record = next(iter(item['repair_runs'].values()))
            self.assertTrue(repair_tick.replay_settled(record))

    def test_recover_reads_each_row_once_for_a_long_chain(self):
        f = self.build(3, chain=200, unsettled=0)
        events = f.outbox.retained()
        reads = mock.Mock(wraps=ledger.loads)
        with mock.patch.object(finding_delivery.ledger, 'loads', reads):
            f.inbox.recover(events)
        self.assertLessEqual(reads.call_count, 3)

    def test_replay_budget_rotates_catch_up_across_ticks(self):
        f = self.build(40, chain=3)
        f.tick(count=15, seconds=3600)
        settled = [repair_tick.replay_settled(next(iter(i['repair_runs'].values()))) for i in f.items]
        self.assertEqual(sum(settled), 15)
        f.tick(count=15, seconds=3600)
        f.tick(count=15, seconds=3600)
        settled = [repair_tick.replay_settled(next(iter(i['repair_runs'].values()))) for i in f.items]
        self.assertTrue(all(settled))

    def test_wall_clock_budget_stops_replay_but_tick_continues(self):
        f = self.build(5, chain=3)
        clock = iter([0.0, 0.0, 0.0, 999.0] + [999.0] * 50)
        repair_tick.begin_tick(f.c, count=100, seconds=10, clock=lambda: next(clock))
        for item in f.items:
            repair_tick.harvest(f.c, f.queue, item)  # must not raise
        settled = [repair_tick.replay_settled(next(iter(i['repair_runs'].values()))) for i in f.items]
        self.assertEqual(sum(settled), 2)


class CrashRecoveryTest(ReplayBase):
    def two_job_fixture(self):
        f = self.build(1, chain=3, jobs_per_run=2)
        # The second sibling holds a verified fix that never published.
        f.write_result('crq-job-0-1', 'FIXED')
        sibling = json.loads((f.root / 'state/repair/inbox/crq-job-0-1.json').read_text())
        sibling_fid = format(2, '064x')
        sibling['canonical_finding_id'] = sibling_fid
        (f.root / 'state/repair/inbox/crq-job-0-1.json').write_text(json.dumps(sibling))
        row = json.loads((f.root / 'state/backfill/findings/triage' / (format(1, '064x') + '.json')).read_text())
        row['finding'] = {'id': sibling_fid}
        row['canonical_id'] = sibling_fid
        row['receipt'] = {'acknowledgement': 'ack', 'repair_task': 'crq-job-0-1'}
        previous = None
        for step in range(3):
            last = step == 2
            event = seed_event('seed2:%d' % step, {
                'finding_id': sibling_fid, 'review_id': 'e' * 64, 'previous_event_id': previous,
                'action': 'delivered' if last else 'needs-retriage',
                'evidence': {'acknowledgement': 'ack', 'repair_task': 'crq-job-0-1'} if last else {'reason': 's'},
                'actor': 'judge'})
            f.write_event(event)
            previous = event['id']
        row['previous_event_id'] = previous
        ledger.atomic(f.root / 'state/backfill/findings/triage' / (sibling_fid + '.json'), ledger.canonical(row))
        return f

    def test_crash_after_ledger_write_before_flag_saved_replays_idempotently(self):
        f = self.two_job_fixture()
        saved = copy.deepcopy(f.queue)  # the queue as last durably saved: flags unset
        f.tick()
        record = next(iter(f.items[0]['repair_runs'].values()))
        self.assertTrue(repair_tick.replay_settled(record))
        ids, rows = f.outbox_ids(), f.rows()
        # Crash: the process dies before the queue save, so the flags are lost.
        f.items[:] = saved['items']
        f.queue = saved
        self.assertFalse(repair_tick.replay_settled(next(iter(f.items[0]['repair_runs'].values()))))
        f.tick()
        self.assertEqual(f.outbox_ids(), ids)  # no duplicate or conflicting events
        self.assertEqual(f.rows(), rows)
        self.assertTrue(repair_tick.replay_settled(next(iter(f.items[0]['repair_runs'].values()))))

    def test_crash_before_sibling_write_loses_nothing(self):
        f = self.two_job_fixture()
        real = f.inbox.repair_outcome
        calls = []

        def crash_on_sibling(fid, job, *args, **kwargs):
            calls.append(job)
            if job == 'crq-job-0-1':
                raise RuntimeError('simulated crash during sibling write')
            return real(fid, job, *args, **kwargs)

        with mock.patch.object(f.inbox, 'repair_outcome', crash_on_sibling):
            with self.assertRaises(RuntimeError):
                f.tick()
        record = next(iter(f.items[0]['repair_runs'].values()))
        self.assertEqual(record['siblings_recorded'], ['crq-job-0-0'])  # only the durable write is flagged
        self.assertFalse(repair_tick.replay_settled(record))
        f.tick()  # the next tick records the sibling
        self.assertTrue(repair_tick.replay_settled(record))
        sibling_row = json.loads(f.rows()[format(2, '064x') + '.json'])
        self.assertEqual(sibling_row['status'], 'needs-human')

    def test_sibling_without_result_stays_unsettled_until_it_arrives(self):
        f = self.two_job_fixture()
        (f.root / 'state/repair/crq-job-0-1/result.json').unlink()
        f.tick()
        record = next(iter(f.items[0]['repair_runs'].values()))
        self.assertFalse(repair_tick.replay_settled(record))
        f.write_result('crq-job-0-1', 'FIXED')
        f.tick()
        self.assertTrue(repair_tick.replay_settled(record))


if __name__ == '__main__':
    unittest.main()
