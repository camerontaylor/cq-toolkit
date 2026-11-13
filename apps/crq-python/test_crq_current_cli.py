"""Merged-current operator surfaces: status projection, CLI and tick gating.

Split provenance: moved verbatim from test_crq.py;
test_crq_fixtures.py holds the shared offline fixtures.
"""
import contextlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock
from test_crq_fixtures import (
    CurrentFixture,
    crq,
    setUpModule,
)

class CurrentTest(CurrentFixture, unittest.TestCase):
    def test_local_pending_status_respects_projection_gate_and_null_sections(self):
        item = self.enroll()
        item['remediation'] = {'fixture': 'retained internal evidence'}
        crq.save_queue(self.q)
        for queue, enabled in ((None, False), ({}, False), ({'project_fixed': False}, False),
                               ({'project_fixed': True}, True)):
            with self.subTest(queue=queue), \
                 mock.patch.object(crq, 'CONFIG', {**crq.CONFIG, 'queue': queue}), \
                 mock.patch.object(crq, 'pr_info', return_value=self.info):
                enrolled = crq.enqueue_merged(42, self.merge, 'missed')
                pending = crq.current_report('missed')
                for result in (enrolled, pending):
                    self.assertEqual('remediation' in result, enabled)
                    if enabled:
                        self.assertEqual(result['remediation'], item['remediation'])
                self.assertEqual(crq.load_queue()['items'][0]['remediation'], item['remediation'])
        for repair in (None, {}, {'merged_current': None}, {'merged_current': {}},
                       {'merged_current': {'enabled': False}}, {'merged_current': {'enabled': True}}):
            with self.subTest(repair=repair), mock.patch.object(crq, 'CONFIG', {'repair': repair}):
                self.assertEqual(crq.repair_tick.merged_current_enabled(crq),
                                 repair == {'merged_current': {'enabled': True}})

    def test_cli_help_and_json_enrollment_report(self):
        for command in ("enqueue-merged", "report"):
            with mock.patch.object(sys, "argv", ["crq", command, "--help"]), contextlib.redirect_stdout(io.StringIO()) as output:
                with self.assertRaises(SystemExit) as end:
                    crq.main()
                self.assertEqual(end.exception.code, 0)
                self.assertIn("--request-id", output.getvalue())
        with mock.patch.object(sys, "argv", ["crq", "enqueue-merged", "--pr", "42", "--merge-sha", self.merge,
                                             "--request-id", "cli"]), \
             mock.patch.object(crq, "pr_info", return_value=self.info), contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(crq.main(), 0)
            self.assertEqual(json.loads(output.getvalue())["state"], "pending")
        with mock.patch.object(sys, "argv", ["crq", "report", "--request-id", "cli"]), contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(crq.main(), 0)
            self.assertIsNone(json.loads(output.getvalue())["receipt_id"])

    def test_cli_requeue_of_merged_current_refuses_needs_human_without_mutation(self):
        item = self.enroll()
        before = crq.QUEUE.read_bytes()
        with mock.patch.object(sys, "argv", ["crq", "requeue", item["id"], "retry"]), \
             mock.patch.object(crq, "write_status"), \
             contextlib.redirect_stdout(io.StringIO()) as out, contextlib.redirect_stderr(io.StringIO()) as err:
            self.assertEqual(crq.main(), 3)
        self.assertEqual(out.getvalue(), "")
        self.assertIn("requeue refused: merged-current retries require explicit lineage", err.getvalue())
        self.assertIn("needs-human", err.getvalue())
        self.assertEqual(crq.QUEUE.read_bytes(), before)

    def test_fixed_revalidation_cli_reports_refusal_without_traceback(self):
        with tempfile.TemporaryDirectory() as td:
            evidence = Path(td) / 'evidence.json'
            evidence.write_text('{}')
            with mock.patch.object(sys, 'argv', ['crq', 'repair-revalidate-fixed', 'crq-run-F1',
                                                 '--revalidation', str(evidence)]), \
                 mock.patch.object(crq.repair_tick, 'record_fixed_publication_evidence',
                                   side_effect=ValueError('binding changed')), \
                 contextlib.redirect_stderr(io.StringIO()) as err:
                self.assertEqual(crq.main(), 3)
            self.assertIn('repair-revalidate-fixed refused: binding changed', err.getvalue())
            self.assertNotIn('Traceback', err.getvalue())

    def test_lock_busy_mutating_commands_exit_needs_human(self):
        for argv in (["crq", "init"], ["crq", "measure"], ["crq", "pause"],
                     ["crq", "author-observe", "manifest.json"]):
            with self.subTest(argv=argv), mock.patch.object(sys, "argv", argv), \
                 mock.patch.object(crq, "with_lock", return_value=None), \
                 contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(crq.main(), 3)

    def test_selfcheck_fails_on_a_banned_third_party_reviewer_identity(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            (root / "config.json").write_text("{}")
            with mock.patch.object(crq, "ROOT", root), contextlib.redirect_stdout(io.StringIO()) as ok:
                self.assertEqual(crq.cmd_selfcheck(), 0)
            self.assertIn("no banned third-party reviewer identity", ok.getvalue())
            (root / "config.json").write_text('{"reviewer": "' + sorted(crq.BANNED_BOT_LOGINS)[0] + '"}')
            with mock.patch.object(crq, "ROOT", root), contextlib.redirect_stdout(io.StringIO()) as out:
                self.assertEqual(crq.cmd_selfcheck(), 1)
            self.assertIn("FAIL: config.json contains banned third-party identity", out.getvalue())

    def test_cli_admin_malformed_queue_and_unrelated_value_errors_still_fail(self):
        item = self.enroll()
        with mock.patch.object(sys, "argv", ["crq", "prioritize", item["id"]]), \
             mock.patch.object(crq, "write_status"), contextlib.redirect_stdout(io.StringIO()):
            item["state"] = "done"
            crq.save_queue(self.q)
            with self.assertRaisesRegex(ValueError, "operator priority requires a pending item"):
                crq.main()
        crq.QUEUE.write_text("{not json")
        with mock.patch.object(sys, "argv", ["crq", "requeue", item["id"]]), \
             mock.patch.object(crq, "write_status"), contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(json.JSONDecodeError):
                crq.main()
        self.assertEqual(crq.QUEUE.read_text(), "{not json")

    def test_reconcile_gets_its_own_forge_budget_when_the_shard_budget_is_spent(self):
        """Reconciliation must not inherit an exhausted tick budget and fail silently.

        Regression for 2026-11-13: reconcile_fix_prs ran last inside the tick's shared
        24-request, 30-second window and swallowed RefreshExhausted per run, so a
        starving tick projected nothing for six hours while eleven merged repairs sat
        stuck at the delivered canonical row, with no log line to say so.
        """
        seen = {}
        shard = crq.ForgeBudget(requests=0)
        own = crq.ForgeBudget(requests=80, seconds=60)
        made = []

        def factory(*args, **kwargs):
            budget = shard if not made else own
            made.append(budget)
            return budget

        def capture(*args, **kwargs):
            seen['budget'] = crq._FORGE_BUDGET

        with mock.patch.object(crq, 'ForgeBudget', side_effect=factory), \
             mock.patch.object(crq, 'fetch'), mock.patch.object(crq, 'write_status'), \
             mock.patch.object(crq, 'write_heartbeat'), mock.patch.object(crq, 'notify_owner'), \
             mock.patch.object(crq, 'enroll', return_value=[]), \
             mock.patch.object(crq, 'discover_merged', return_value=[]), \
             mock.patch.object(crq.repair_tick, 'reconcile_fix_prs', side_effect=capture):
            crq.tick()
        self.assertIs(seen['budget'], own)
        self.assertTrue(seen['budget'].available())

    def test_reconcile_reports_starved_runs_instead_of_silence(self):
        """A pass that read nothing must not look like a pass that found nothing.

        The six-hour silence of 2026-11-13 was a starved reconcile that reported
        nothing because RefreshExhausted was swallowed with the rest. The counts
        are the difference between 'nothing to do' and 'nothing attempted'.
        """
        record = {'fix_pr': {'number': 7}, 'jobs': [], 'verdicts': []}
        item = {'id': 'item-starved', 'kind': 'repair-run', 'repair_runs': {'run-1': record}}

        class Starved:
            def pr_info(self, number):
                raise crq.deferred_refresh.RefreshExhausted('aggregate forge budget exhausted')

        stats = crq.repair_tick.reconcile_fix_prs(Starved(), {'items': [item]})
        self.assertEqual(1, stats['examined'])
        self.assertEqual(0, stats['projected'])
        self.assertEqual(1, stats['starved'])
        self.assertEqual(0, stats['deferred'])
        self.assertEqual(1, len(stats['errors']))
        self.assertIn('RefreshExhausted', stats['errors'][0]['error'])
        self.assertNotIn('fix_merged', record)

    def test_reconcile_counts_a_projected_run(self):
        record = {'fix_pr': {'number': 7, 'url': 'u'}, 'jobs': [], 'verdicts': [],
                  'publication': {'head': 'published'}}
        item = {'id': 'item-projected', 'kind': 'repair-run', 'repair_runs': {'run-1': record}}

        class Merged:
            def pr_info(self, number):
                return {'state': 'MERGED', 'mergeCommit': {'oid': 'merge'}, 'headRefOid': 'actual'}

            def is_ancestor(self, ancestor, descendant):
                return True

            def git(self, *args):
                return 'tip'

            def iso(self):
                return 'now'

        with mock.patch.object(crq.repair_tick, 'canonical_fixed_events', return_value={'check': 1}), \
             mock.patch.object(crq.repair_tick, 'publish_source_resolution', return_value=None):
            stats = crq.repair_tick.reconcile_fix_prs(Merged(), {'items': [item]})
        self.assertEqual(1, stats['examined'])
        self.assertEqual(1, stats['projected'])
        self.assertEqual(0, stats['starved'])
        self.assertEqual('now', record['fix_merged'])

    def test_tick_reports_a_starved_reconcile_pass(self):
        """The digest line is what makes a starved pass visible without a probe."""
        stats = {'examined': 3, 'projected': 0, 'starved': 3, 'deferred': 0, 'errors': []}
        with mock.patch.object(crq, 'fetch'), mock.patch.object(crq, 'write_status'), \
             mock.patch.object(crq, 'write_heartbeat'), mock.patch.object(crq, 'notify_owner'), \
             mock.patch.object(crq, 'event') as recorded, \
             mock.patch.object(crq, 'enroll', return_value=[]), \
             mock.patch.object(crq, 'discover_merged', return_value=[]), \
             mock.patch.object(crq.repair_tick, 'reconcile_fix_prs', return_value=stats):
            log = crq.tick()
        self.assertTrue(any('reconcile: 3 examined, 0 projected, 3 starved' in line for line in log))
        self.assertTrue(any(call.args and call.args[0] == 'reconcile_incomplete'
                            for call in recorded.call_args_list))

    def test_selective_start_refuses_and_caps_prevent_capture(self):
        item = self.enroll()
        with mock.patch.object(crq, "fetch"), mock.patch.object(crq, "enroll", return_value=[]), \
             mock.patch.object(crq, "discover_merged", return_value=[]), \
             mock.patch.object(crq, "write_status"), mock.patch.object(crq, "write_heartbeat"), \
             mock.patch.object(crq.repair_tick, "reconcile_fix_prs", return_value={}), \
             mock.patch.object(crq, "prepare_current") as planner:
            log = crq.with_lock(crq.tick, False, item["id"])
            self.assertTrue(any("selective start refused" in line for line in log))
            planner.assert_not_called()
            q = crq.load_queue()
            q["starts"] = [crq.iso()] * crq.CONFIG["max_starts_per_hour"]
            crq.save_queue(q)
            log = crq.with_lock(crq.tick)
            self.assertTrue(any("hourly cap" in line for line in log))
            planner.assert_not_called()
