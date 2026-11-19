"""Backfill fix-PR backlog: hard cap at PR creation, soft budget in the drain."""
import copy
import datetime as dt
import importlib.util
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import repair_tick

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('repair_backlog_under_test', ROOT / 'crq_repair.py')
service = importlib.util.module_from_spec(spec)
spec.loader.exec_module(service)


def stamp(at):
    return at.strftime('%Y-%m-%dT%H:%M:%SZ')


class PublishCapTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.state = Path(self.tmp.name)
        (self.state / 'repair').mkdir()
        self.created = []
        self.listed = {}

        def run(argv):
            if argv[:3] == ['gh', 'pr', 'create']:
                branch = argv[argv.index('--head') + 1]
                self.created.append(branch)
                self.listed[branch] = [{'number': 100 + len(self.created), 'url': 'u', 'state': 'OPEN'}]

        def gh_json(argv):
            return self.listed.get(argv[argv.index('--head') + 1], []) if '--head' in argv else []

        self.c = SimpleNamespace(
            STATE=self.state, REPO='o/r', run=run, gh_json=gh_json, save_queue=lambda q: None,
            iso=lambda: 'now', new_item=lambda *a, **k: None, CONFIG={'repair': {}})
        patcher = mock.patch.object(repair_tick, 'repair_provenance', return_value=[])
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(repair_tick.TICK_BACKLOG.update, open=None, limit=None)

    def publication(self, item_id, name):
        run = 'run-' + name
        (self.state / 'repair' / ('job-' + name)).mkdir()
        item = {'id': item_id, 'pr': 0, 'kind': 'merged', 'state': 'repairing'}
        record = {'jobs': ['job-' + name], 'state': 'ready',
                  'verdicts': [{'job': 'job-' + name, 'verdict': 'FIXED', 'reason': 'ok'}]}
        publication = {'head': 'h' + name, 'target': 't', 'branch': 'crq/fix-' + run,
                       'commits': [], 'open_pr': False}
        return item, run, record, publication

    def finalize(self, parts):
        item, run, record, publication = parts
        repair_tick.finalize_publication(self.c, {'items': []}, item, run, record, publication)
        return record, publication

    def test_one_slot_creates_one_backfill_pr_and_holds_the_other_untouched(self):
        repair_tick.TICK_BACKLOG.update(open=9, limit=10)
        first = self.publication('backfill-finding-a', 'a')
        second = self.publication('backfill-finding-b', 'b')
        self.finalize(first)
        before = copy.deepcopy(list(second[2:]))
        record, publication = self.finalize(second)
        self.assertEqual(self.created, ['crq/fix-run-a'])
        self.assertEqual(repair_tick.TICK_BACKLOG['open'], 10)
        self.assertEqual(record['state'], 'ready')
        self.assertNotIn('pr_create_attempts', publication)
        self.assertNotIn('pr_create_pending', publication)
        self.assertNotIn('fix_pr', record)
        self.assertEqual(before, [second[2], second[3]])

    def test_unreadable_backlog_holds_backfill_creation(self):
        repair_tick.TICK_BACKLOG.update(open=None, limit=None)
        parts = self.publication('backfill-finding-a', 'a')
        record, publication = self.finalize(parts)
        self.assertEqual(self.created, [])
        self.assertNotIn('pr_create_attempts', publication)

    def test_slot_is_reserved_before_create_and_kept_when_create_times_out(self):
        # The create may have landed: the slot stays taken for the rest of the
        # tick, so the next backfill publication is held, not created.
        repair_tick.TICK_BACKLOG.update(open=8, limit=10)
        seen = []
        def timeout(argv):
            seen.append(repair_tick.TICK_BACKLOG['open'])
            raise subprocess.TimeoutExpired(argv, 600)
        self.c.run = timeout
        with self.assertRaises(subprocess.TimeoutExpired):
            self.finalize(self.publication('backfill-finding-a', 'a'))
        self.assertEqual(seen, [9])
        self.assertEqual(repair_tick.TICK_BACKLOG['open'], 9)

    def test_slot_is_released_when_gh_reports_create_failed(self):
        repair_tick.TICK_BACKLOG.update(open=9, limit=10)
        def failed(argv):
            raise RuntimeError('gh pr create exit 1')
        self.c.run = failed
        with self.assertRaises(RuntimeError):
            self.finalize(self.publication('backfill-finding-a', 'a'))
        self.assertEqual(repair_tick.TICK_BACKLOG['open'], 9)

    def test_pr_review_publication_is_created_regardless(self):
        repair_tick.TICK_BACKLOG.update(open=50, limit=10)
        record, publication = self.finalize(self.publication('pr77', 'p'))
        self.assertEqual(self.created, ['crq/fix-run-p'])
        self.assertEqual(publication['pr_create_attempts'], 1)
        self.assertEqual(repair_tick.TICK_BACKLOG['open'], 50)


class BacklogFileTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.state = Path(self.tmp.name)
        (self.state / 'repair').mkdir()
        self.now = dt.datetime.now(dt.timezone.utc)
        rows = [{'at': stamp(self.now - dt.timedelta(hours=h)), 'event': 'review_started'}
                for h in [1] * 18 + [10] * 18 + [71, 73, 100]]
        rows.append({'at': stamp(self.now), 'event': 'other'})
        events = self.state / 'events.jsonl'
        events.write_text(''.join(json.dumps(r) + '\n' for r in rows))
        self.prs = [{'headRefName': 'crq/fix-backfill-' + str(i)} for i in range(3)]
        self.prs.append({'headRefName': 'crq/fix-run-9'})
        self.c = SimpleNamespace(STATE=self.state, EVENTS=events, REPO='o/r',
                                 gh_json=lambda argv: self.prs)
        self.addCleanup(repair_tick.TICK_BACKLOG.update, open=None, limit=None)

    def test_limit_is_trailing_72h_starts_times_four_over_72(self):
        # 37 starts inside 72 h: 37 * 4 // 72 == 2
        self.assertEqual(repair_tick.review_start_limit(self.c, self.now), 2)

    def test_refresh_writes_open_backfill_prs_and_limit(self):
        repair_tick.refresh_fix_pr_backlog(self.c)
        data = json.loads((self.state / 'repair/fix-pr-backlog.json').read_text())
        self.assertEqual((data['open'], data['limit']), (3, 2))
        self.assertEqual(repair_tick.TICK_BACKLOG, {'open': 3, 'limit': 2})

    def test_failed_gh_call_keeps_previous_file_and_holds_this_tick(self):
        repair_tick.refresh_fix_pr_backlog(self.c)
        before = (self.state / 'repair/fix-pr-backlog.json').read_text()
        def boom(argv):
            raise RuntimeError('gh down')
        self.c.gh_json = boom
        self.assertIsNone(repair_tick.refresh_fix_pr_backlog(self.c))
        self.assertEqual((self.state / 'repair/fix-pr-backlog.json').read_text(), before)
        self.assertFalse(repair_tick.backfill_slot_free({'id': 'backfill-finding-x'}))
        self.assertTrue(repair_tick.backfill_slot_free({'id': 'pr5'}))


class TickScopeTest(unittest.TestCase):
    def test_backlog_read_only_with_backfill_repair_work(self):
        self.assertFalse(repair_tick.backfill_repair_present({'items': [
            {'id': 'pr5', 'repair_runs': {'r': {}}}, {'id': 'backfill-finding-a'}]}))
        self.assertTrue(repair_tick.backfill_repair_present({'items': [
            {'id': 'backfill-finding-a', 'repair_runs': {'r': {}}}]}))

    def test_tick_clears_the_count_before_and_after_its_harvest_pass(self):
        import crq
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        repair_tick.TICK_BACKLOG.update(open=1, limit=36)
        self.addCleanup(repair_tick.TICK_BACKLOG.update, open=None, limit=None)
        seen = []
        q = {'items': [{'id': 'backfill-finding-a', 'state': 'repairing', 'kind': 'merged',
                        'repair_runs': {'r': {}}}]}
        def refresh(c):
            seen.append(('refresh', dict(repair_tick.TICK_BACKLOG), crq._FORGE_BUDGET.remaining))
            repair_tick.TICK_BACKLOG.update(open=2, limit=36)
        def harvest(c, queue, item):
            seen.append(('harvest', dict(repair_tick.TICK_BACKLOG)))
            raise KeyboardInterrupt  # leaves the pass early: the finally still clears
        with mock.patch.object(crq, 'load_queue', return_value=q), \
             mock.patch.object(crq, 'fetch'), mock.patch.object(crq, 'STATE', Path(tmp.name)), \
             mock.patch.object(crq.backfill_runtime, 'publish'), \
             mock.patch.object(crq.backfill_runtime, 'settings', return_value=None), \
             mock.patch.object(crq.deferred_refresh, 'refresh_deferred', return_value=[]), \
             mock.patch.object(crq.push_current, 'discover', return_value=[]), \
             mock.patch.object(crq, 'CONFIG', {}), \
             mock.patch.object(repair_tick, 'refresh_fix_pr_backlog', side_effect=refresh), \
             mock.patch.object(repair_tick, 'harvest', side_effect=harvest):
            with self.assertRaises(KeyboardInterrupt):
                crq.tick(only='x')
        self.assertEqual(seen, [('refresh', {'open': None, 'limit': None}, 1),
                                ('harvest', {'open': 2, 'limit': 36})])
        self.assertEqual(repair_tick.TICK_BACKLOG, {'open': None, 'limit': None})


class DrainBudgetTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        (self.root / 'state/repair').mkdir(parents=True)
        patcher = mock.patch.object(service, 'ROOT', self.root)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.groups = {'pr-review': ['j0'], 'backfill-finding-a': ['j1'],
                       'backfill-finding-b': ['j2'], 'backfill-finding-c': ['j3']}

    def backlog(self, open_count, limit, age=0):
        at = dt.datetime.now(dt.timezone.utc) - dt.timedelta(seconds=age)
        (self.root / 'state/repair/fix-pr-backlog.json').write_text(
            json.dumps({'at': stamp(at), 'open': open_count, 'limit': limit}))

    def held(self):
        with mock.patch.object(service, 'narrate') as narrate:
            kept = service.hold_backfill_groups(dict(self.groups))
        return list(kept), [c.args[0] for c in narrate.call_args_list]

    def test_at_limit_every_backfill_group_is_held_and_other_repair_runs(self):
        self.backlog(36, 36)
        kept, notes = self.held()
        self.assertEqual(kept, ['pr-review'])
        self.assertEqual(notes, ['backfill repair held: 36 open fix PRs, limit 36'])

    def test_one_below_limit_admits_exactly_one_group_in_drain_order(self):
        self.backlog(35, 36)
        kept, _ = self.held()
        self.assertEqual(kept, ['pr-review', 'backfill-finding-a'])

    def test_missing_stale_or_unreadable_file_holds(self):
        self.assertEqual(self.held()[0], ['pr-review'])
        self.backlog(0, 36, age=3601)
        self.assertEqual(self.held()[0], ['pr-review'])
        (self.root / 'state/repair/fix-pr-backlog.json').write_text('{')
        self.assertEqual(self.held()[0], ['pr-review'])

    def test_future_dated_file_holds(self):
        self.backlog(0, 36, age=-60)
        self.assertEqual(self.held()[0], ['pr-review'])

    def test_non_dispatchable_groups_take_no_slot(self):
        # a is retained but cannot run: b gets the one free slot, c is held,
        # and a passes through to drain_item untouched as before.
        self.backlog(35, 36)
        with mock.patch.object(service, 'narrate'):
            kept = service.hold_backfill_groups(dict(self.groups),
                                                lambda item: item != 'backfill-finding-a')
        self.assertEqual(list(kept), ['pr-review', 'backfill-finding-a', 'backfill-finding-b'])

    def test_at_limit_non_dispatchable_groups_are_held_too(self):
        self.backlog(36, 36)
        with mock.patch.object(service, 'narrate'):
            kept = service.hold_backfill_groups(dict(self.groups), lambda item: False)
        self.assertEqual(list(kept), ['pr-review'])

    def test_fresh_file_with_room_admits_all(self):
        self.backlog(0, 36, age=3599)
        kept, notes = self.held()
        self.assertEqual(len(kept), 4)
        self.assertEqual(notes, [])


if __name__ == '__main__':
    unittest.main()
