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

    def test_selective_start_refuses_and_caps_prevent_capture(self):
        item = self.enroll()
        with mock.patch.object(crq, "fetch"), mock.patch.object(crq, "enroll", return_value=[]), \
             mock.patch.object(crq, "discover_merged", return_value=[]), \
             mock.patch.object(crq, "write_status"), mock.patch.object(crq, "write_heartbeat"), \
             mock.patch.object(crq.repair_tick, "reconcile_fix_prs"), \
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
