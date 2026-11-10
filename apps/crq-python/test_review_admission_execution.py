"""Offline launch, reconciliation and durable local completion."""
import copy
import contextlib
import datetime as dt
import hashlib
import json
import subprocess
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest import mock

import backfill_runtime
import crq
import local_review_runtime as runtime
import review_admission as admission
import review_transport as transport
import review_receipt
import review_ledger
from test_author_snapshot_fixtures import SnapshotGitFixture


class ExecutionTests(SnapshotGitFixture, unittest.TestCase):
    def setUp(self):
        super().setUp()
        self.state = self.repo / "state"
        self.runs = self.state / "runs"
        self.rdir = self.runs / "run-1"
        self.rdir.mkdir(parents=True)
        self.raw = '{"type":"finding","title":"check this","path":"file.txt"}\n{"type":"complete"}\n'
        (self.rdir / "review.ndjson").write_text(self.raw)
        self.cls = dict(counted=True, outcome="completed", findings=1, severity_counts={}, message=None)
        self.c = SimpleNamespace(REPO=crq.REPO, CLONE=self.repo, STATE=self.state, RUNS=self.runs,
            CONFIG={}, git=self.git, NotReady=crq.NotReady, NothingToReview=crq.NothingToReview,
            iso=lambda: "2026-11-08T00:00:00Z", save_queue=lambda q: None,
            classify=lambda *a: copy.deepcopy(self.cls))
        self.profile = transport.profile({}, self.base)
        self.facts = runtime.facts(self.c, self.base, self.head, self.profile)
        self.inputs = {k: self.facts[k] for k in ("repo", "base_commit", "base_tree", "head_commit", "head_tree", "projection")}
        self.inputs["target"] = "main"
        self.admit("one")
        self.item = self.q["items"][0]

    def admit(self, key, repeat=False, **kw):
        return admission.admit(self.q, request_id=key, inputs=self.inputs, resolved=self.facts,
            profile=self.profile, at="2026-11-08T00:00:00Z", repeat=repeat, **kw)

    def finish(self, item=None):
        with mock.patch.object(backfill_runtime, "settings", return_value=None):
            return runtime.complete(self.c, self.q, item or self.item, self.rdir, "run-1", self.cls,
                                    "2026-11-08T00:01:00Z", 0)

    def pr(self):
        item = dict(id="pr1", kind="open", pr=1, repo=crq.REPO, state="pending", cycles=[])
        self.q["items"].append(item)
        return item

    def plan(self):
        return dict(base=self.base, head=self.head)

    def test_pending_pr_yields_then_gets_receipt_cycle_despite_disabled_publication(self):
        pr = self.pr()
        with self.assertRaisesRegex(crq.NotReady, "equivalent-local-review"):
            runtime.reconcile_pr(self.c, self.q, pr, self.plan(), False)
        self.item.update(wait_reason="backoff until old time", not_before=self.c.iso(), reconcile_failures=2)
        self.finish()
        self.assertIsNone(self.item["wait_reason"])
        self.assertNotIn("not_before", self.item)
        self.assertNotIn("reconcile_failures", self.item)
        self.assertTrue(self.item["publication_pending"])
        self.assertEqual(self.item["publication_reason"], "publication-disabled")
        self.assertIsNotNone(runtime.retained(self.c, self.item))
        with self.assertRaises(crq.NothingToReview):
            runtime.reconcile_pr(self.c, self.q, pr, self.plan(), False)
        self.assertEqual(pr["cycles"][0]["run_id"], "run-1")
        self.assertEqual(pr["cycles"][0]["profile"], self.profile)
        self.assertNotIn("coverage", self.q)

    def test_primary_case_variant_publication_spools_and_acknowledges_on_retry(self):
        self.item["identity_inputs"]["repo"] = self.c.REPO.upper()
        self.finish()
        store = review_ledger.ArtifactStore(self.state / "artifacts")
        outbox = review_ledger.Outbox(self.state / "outbox", store)
        with mock.patch.object(backfill_runtime, "settings", return_value={"enabled": True}), \
             mock.patch.object(backfill_runtime, "services", return_value=(None, store, outbox, None)), \
             mock.patch.object(backfill_runtime, "publish") as publish:
            runtime.republish(self.c, self.q, self.item)
            self.assertTrue(self.item["publication_pending"])
            self.assertEqual(self.item["publication_reason"], "publication-spooled")
            events = outbox.pending()
            self.assertEqual(len(events), 1)
            value = events[0]
            self.assertEqual(value["payload"]["repo"], self.c.REPO)
            self.assertEqual(value["payload"]["source"]["repo"], self.c.REPO)
            self.assertEqual(value["source_key"], self.c.REPO + ":author-queue:run-1")
            runtime.republish(self.c, self.q, self.item)
            self.assertEqual(outbox.pending(), [value])
            outbox.acknowledge(value, [value["id"]])
            runtime.republish(self.c, self.q, self.item)
            self.assertFalse(self.item["publication_pending"])
            self.assertIsNone(self.item["publication_reason"])
            self.assertEqual(publish.call_count, 2)
            self.assertEqual(self.item["identity_inputs"]["repo"], self.c.REPO.upper())

    def full_tick(self, opened, *, remaining=0, clone=None):
        """Real tick, enrollment and repair backfill; replace external I/O."""
        config = copy.deepcopy(crq.CONFIG)
        config["merged_discovery"] = None
        with contextlib.ExitStack() as stack:
            stack.enter_context(mock.patch.multiple(crq, CLONE=clone or self.repo, STATE=self.state,
                RUNS=self.runs, REPOS=[], CONFIG=config))
            for name in ("fetch", "save_queue", "event", "notify_owner", "write_status", "refresh_slot_deadline"):
                stack.enter_context(mock.patch.object(crq, name))
            stack.enter_context(mock.patch.object(crq, "load_queue", return_value=self.q))
            stack.enter_context(mock.patch.object(crq, "gh_json", return_value=opened))
            stack.enter_context(mock.patch.object(crq, "ensure_commit", return_value=True))
            stack.enter_context(mock.patch.object(crq, "read_slot_usage", return_value=({"remaining": remaining}, [])))
            stack.enter_context(mock.patch.object(crq, "coverage_fallback", return_value=(None, False)))
            for module, name, result in ((backfill_runtime, "settings", None),
                (crq.push_current, "discover", []), (crq.pr_enroll, "enroll", []),
                (crq.deferred_refresh, "refresh_deferred", []), (crq.client_health, "record", []),
                (crq.repair_tick, "archive_legacy", None), (crq.repair_tick, "reconcile_fix_prs", None)):
                stack.enter_context(mock.patch.object(module, name, return_value=result))
            enrolled = stack.enter_context(mock.patch.object(crq, "enroll", wraps=crq.enroll))
            stack.enter_context(mock.patch.object(crq.local_review_pr, "publish"))
            heartbeat = stack.enter_context(mock.patch.object(crq, "write_heartbeat"))
            request = stack.enter_context(mock.patch.object(crq, "_request_pr_review"))
            launched = stack.enter_context(mock.patch.object(crq, "launch"))
            crq.tick()
            enrolled.assert_called_once()
            heartbeat.assert_called_once()
            launched.assert_not_called()
            request.assert_not_called()

    def test_reconciled_cycle_survives_full_tick_enrollment_without_repair_or_delivery(self):
        self.finish()
        pr = self.pr()
        self.git("update-ref", "refs/remotes/origin/main", self.base)
        with self.assertRaises(crq.NothingToReview):
            runtime.reconcile_pr(self.c, self.q, pr, self.plan(), False)
        pr["state"] = "skipped"
        record = pr["cycles"][0]
        self.assertEqual(record["completed_at"], self.item["completed_at"])
        self.assertEqual(record["pr_head"], self.head)
        self.assertEqual(record["findings"], 1)
        self.assertEqual(record["source"], "local-review")
        (self.rdir / "meta.json").write_text(json.dumps(dict(kind="local-review", run_id="run-1")))
        self.full_tick([dict(number=1, isDraft=False, baseRefName="main", headRefName="feature", headRefOid=self.head)])
        self.assertEqual(crq.last_reviewed(self.q, 1), record)
        self.assertEqual(crq.reviewed_head(record), self.head)
        self.assertEqual(len(self.q["items"]), 2)
        self.assertNotIn("repair_runs", pr)
        self.assertNotIn("pr_review_pending", pr)
        self.assertIsNotNone(self.q.get("last_tick"))

    def test_repair_debt_paths_skip_marked_cycles_and_original_local_meta(self):
        self.finish()
        pr = self.pr()
        with self.assertRaises(crq.NothingToReview):
            runtime.reconcile_pr(self.c, self.q, pr, self.plan(), False)
        meta = dict(kind="local-review", run_id="run-1")
        (self.rdir / "meta.json").write_text(json.dumps(meta))
        with mock.patch.multiple(crq, STATE=self.state, RUNS=self.runs), \
             mock.patch.object(crq.repair_tick, "findings", side_effect=AssertionError("local evidence reached repair")):
            crq.repair_tick.backfill(crq, self.q)
            self.assertFalse(crq.repair_tick.enqueue(crq, self.q, pr, meta, self.rdir))
            self.assertFalse(crq.repair_tick.enqueue(crq, self.q, pr, dict(meta, kind="open"), self.rdir))
            self.q.pop("legacy_repair_backfilled", None)
            pr["cycles"][0].pop("source")  # older reconciled cycle still protected by run metadata
            crq.repair_tick.backfill(crq, self.q)
        self.assertNotIn("repair_runs", pr)
        self.assertEqual(self.q["legacy_repair_missing"], [])

    def test_broken_earlier_receipt_does_not_block_valid_repeat_or_normal_plan(self):
        self.finish()
        old = self.item
        receipt = self.state / "receipts" / (old["receipt_id"] + ".json")
        receipt.unlink()
        pr = self.pr()
        self.assertEqual(runtime.reconcile_pr(self.c, self.q, pr, self.plan(), False)["head"], self.head)
        self.admit("repeat", repeat=True)
        self.item = self.q["items"][-1]
        self.finish()
        old["receipt_id"] = "f" * 64
        with self.assertRaises(crq.NothingToReview):
            runtime.reconcile_pr(self.c, self.q, pr, self.plan(), False)
        self.assertEqual(pr["cycles"][0]["receipt_id"], self.item["receipt_id"])

    def test_completed_pr_reconciles_on_full_tick_while_paused_and_without_slots(self):
        pr = self.pr()
        pr.update(state="done", cycles=[dict(base=self.base, head=self.head,
            profile=self.profile, range_policy="full-range-once-v1", run_id="run-1",
            completed_at="2026-11-08T00:01:00Z", ndjson=str(self.rdir / "review.ndjson"))])
        self.q["paused"] = True
        with mock.patch.object(crq, "classify", return_value=self.cls):
            self.full_tick([])
        self.assertEqual(self.item["state"], "done")
        self.assertIsNotNone(self.item.get("receipt_id"))

    def test_missing_pinned_objects_do_not_abort_completion_reconciliation(self):
        partial = self.partial_clone()
        with mock.patch.object(crq, "CLONE", partial), mock.patch.object(self.c, "git", crq.git):
            with self.assertRaises(RuntimeError):
                crq.git("rev-parse", self.head + "^{tree}")
            runtime.reconcile_completed(self.c, self.q)
        self.assertEqual(self.item["state"], "pending")
        self.assertIn("RuntimeError", self.item["wait_reason"])
        self.assertEqual(self.item["reconcile_failures"], 1)
        self.assertEqual(self.q["starts"], [])

    def partial_clone(self):
        partial = self.repo / "partial"
        partial.mkdir()
        transport.author_snapshot.git(partial, "init", "-q")
        transport.author_snapshot.git(partial, "fetch", "--no-tags", str(self.repo), self.base)
        return partial

    def test_real_git_errors_do_not_stop_tick_or_slot_and_recover_after_backoff(self):
        partial = self.partial_clone()
        initial = copy.deepcopy(self.q)
        real_run = subprocess.run
        for failure in ("missing", "timeout"):
            with self.subTest(failure):
                self.q = copy.deepcopy(initial)
                self.item = self.q["items"][0]
                pr = self.pr()
                pr.update(state="done", cycles=[dict(base=self.base, head=self.head,
                    profile=self.profile, range_policy="full-range-once-v1", run_id="run-1",
                    completed_at="2026-11-08T00:01:00Z", ndjson=str(self.rdir / "review.ndjson"),
                    source="local-review")])
                def git_process(cmd, *args, **kw):
                    if failure == "timeout" and cmd[:2] == ["git", "rev-parse"]:
                        raise subprocess.TimeoutExpired(cmd, kw.get("timeout", 600))
                    return real_run(cmd, *args, **kw)
                with mock.patch.object(subprocess, "run", side_effect=git_process):
                    self.full_tick([dict(number=2, isDraft=False, baseRefName="main",
                        headRefName="unrelated", headRefOid=self.head)], clone=partial, remaining=1)
                self.assertTrue(any(i["id"] == "pr2" for i in self.q["items"]))
                self.assertEqual(self.item["state"], "pending")
                self.assertIn("RuntimeError" if failure == "missing" else "TimeoutExpired", self.item["wait_reason"])
                status = admission.status(self.q, "one")
                self.assertTrue(status["reason"].startswith("completed-evidence-unavailable:"))
                with mock.patch.object(crq, "CLONE", partial), mock.patch.object(crq, "git", wraps=crq.git) as git:
                    runtime.reconcile_completed(crq, self.q)
                    git.assert_not_called()  # repeated ticks honor the existing not_before gate
                # The minute lane still admits unrelated work while this item backs off.
                def launch(q, item, plan):
                    item["state"] = "reviewing"
                    item["run"] = dict(run_id="unrelated-run")
                    q["starts"].append(crq.iso())
                    return "unrelated-run"
                self.item.pop("not_before")  # exercise the same real error inside slot itself
                with mock.patch.multiple(crq, CLONE=partial, STATE=self.state, RUNS=self.runs), \
                     mock.patch.object(crq, "load_queue", return_value=self.q), \
                     mock.patch.object(crq, "read_slot_usage", return_value=({"remaining": 1}, [])), \
                     mock.patch.object(crq, "refresh_slot_deadline", side_effect=lambda *a, **kw: crq.now()), \
                     mock.patch.object(crq, "save_queue"), \
                     mock.patch.object(crq, "pr_info", return_value=dict(state="OPEN")), \
                     mock.patch.object(crq, "quiet_reason", return_value=None), \
                     mock.patch.object(crq, "plan_open", return_value=dict(notes=[], label="unrelated")), \
                     mock.patch.object(crq, "launch", side_effect=launch) as launched, \
                     mock.patch.object(subprocess, "run", side_effect=git_process):
                    crq.slot()
                self.assertEqual(launched.call_count, 1)
                self.assertEqual(self.item["reconcile_failures"], 2)
                # Import the same pinned object; do not change the submitted identity.
                transport.author_snapshot.git(partial, "fetch", "--no-tags", str(self.repo), self.head)
                until = crq.parse_iso(self.item["not_before"])
                with mock.patch.object(crq, "now", return_value=until + dt.timedelta(seconds=1)), \
                     mock.patch.object(crq, "classify", return_value=self.cls), \
                     mock.patch.object(crq, "run_liveness", return_value="alive"):
                    self.full_tick([], clone=partial)
                self.assertEqual(self.item["state"], "done")
                self.assertNotIn("reason", admission.status(self.q, "one"))
                self.assertNotIn("not_before", self.item)
                self.assertNotIn("reconcile_failures", self.item)
                if failure == "missing":
                    # For timeout case the object exists: only the real process
                    # timeout wrapper fails, rather than a missing-object mock.
                    self.assertEqual(self.item["identity_inputs"], self.facts)

    def test_invalid_utf8_output_finishes_failed_and_completed_runs_with_raw_digest(self):
        initial = copy.deepcopy(self.q)
        for completed in (False, True):
            with self.subTest(completed=completed):
                self.q = copy.deepcopy(initial)
                self.item = self.q["items"][0]
                self.item.update(state="reviewing", run=dict(run_id="run-1"))
                raw = b'{"type":"finding","severity":"info","comment":"bad \xff byte"}\n'
                raw += (b'{"type":"complete","status":"review_completed"}\n' if completed else
                        b'{"type":"error","errorType":"unknown","message":"bad \xff"}\n')
                if not completed:
                    raw += b"\xff\xe2\x82"  # malformed/truncated trailing event from a terminated process
                (self.rdir / "review.ndjson").write_bytes(raw)
                exit_code = 0 if completed else 1
                (self.rdir / "exit.json").write_text(json.dumps(dict(exit=exit_code, ended_at=self.c.iso())))
                (self.rdir / "meta.json").write_text(json.dumps(dict(worktree=str(self.repo),
                    wt_branch="fixture", item_id=self.item["id"], label="fixture", run_id="run-1",
                    base=self.base, head=self.head)))
                with mock.patch.multiple(crq, STATE=self.state, RUNS=self.runs), \
                     mock.patch.object(crq, "run_liveness", return_value="harvest"), \
                     mock.patch.object(crq, "event"), mock.patch.object(crq, "remove_worktree"), \
                     mock.patch.object(crq, "save_queue"), mock.patch.object(backfill_runtime, "settings", return_value=None):
                    crq.harvest_review(self.q, self.item, False)
                self.assertEqual(self.item["state"], "done" if completed else "failed")
                review_receipt.read_receipt(self.state / "receipts", self.item["receipt_id"])  # verifies receipt bytes
                document = json.loads((self.state / "receipts" / (self.item["receipt_id"] + ".json")).read_text())
                self.assertEqual(document["observed"]["artifacts"]["review.ndjson"], hashlib.sha256(raw).hexdigest())
                self.assertIn("\ufffd", document["findings"][0]["comment"])
                self.assertEqual((self.rdir / "review.ndjson").read_bytes(), raw)
                self.assertEqual(len(self.q["review_events"]), 1)

    def test_local_harvest_retains_global_auth_and_rate_gates(self):
        for outcome in ("auth", "action_required", "rate_limited"):
            with self.subTest(outcome):
                self.item.update(state="reviewing", run=dict(run_id="run-1"))
                self.q.pop("paused", None)
                self.q.pop("cooldown_until", None)
                (self.rdir / "exit.json").write_text(json.dumps(dict(exit=1, ended_at="2026-11-08T00:01:00Z")))
                (self.rdir / "meta.json").write_text(json.dumps(dict(worktree=str(self.repo), wt_branch="fixture")))
                cls = dict(self.cls, outcome=outcome, counted=False)
                with mock.patch.multiple(crq, STATE=self.state, RUNS=self.runs), \
                     mock.patch.object(crq, "run_liveness", return_value="harvest"), \
                     mock.patch.object(crq, "classify", return_value=cls), \
                     mock.patch.object(crq, "findings_md", return_value=outcome), \
                     mock.patch.object(crq, "event"), mock.patch.object(crq, "remove_worktree"), \
                     mock.patch.object(crq, "save_queue"), mock.patch.object(backfill_runtime, "settings", return_value=None):
                    crq.harvest_review(self.q, self.item, False)
                self.assertEqual(self.item["state"], "failed")
                self.assertTrue(self.q.get("cooldown_until") if outcome == "rate_limited" else self.q.get("paused"))

    def test_running_pr_wait_then_reuse_complete_with_event_and_outbox(self):
        pr = self.pr()
        pr["run"] = {"run_id": "run-1"}
        meta = dict(base=self.base, head=self.head, profile=self.profile, range_policy="full-range-once-v1")
        (self.rdir / "meta.json").write_text(json.dumps(meta))
        with self.assertRaisesRegex(crq.NotReady, "equivalent-pr-review"):
            runtime.prepare(self.c, self.q, self.item, False)
        destination = dict(paseo_agent_id="08e32e05-647c-4bbf-be31-2a6aeaec0654", paseo_host="triton")
        self.q["review_requests"]["one"]["notify"] = destination
        pr.update(run=None, cycles=[dict(meta, run_id="run-1", ndjson=str(self.rdir / "review.ndjson"),
            completed_at="2026-11-08T00:01:00Z")])
        with mock.patch.object(backfill_runtime, "settings", return_value=None):
            self.assertIsNone(runtime.prepare(self.c, self.q, self.item, False))
        self.assertEqual(self.item["state"], "done")
        self.assertEqual(len(self.q["review_events"]), 1)
        self.assertEqual(len(self.q["review_notify_outbox"]), 1)
        self.assertEqual(admission.status(self.q, "one")["state"], "completed")

    def test_nonmatching_unavailable_pr_ranges_never_resolve_objects(self):
        pr = self.pr()
        missing = dict(base="a" * 40, head="b" * 40, profile=self.profile,
                       range_policy="full-range-once-v1")
        pr["cycles"] = [dict(missing, run_id="gone")]
        pr["run"] = dict(run_id="run-1")
        (self.rdir / "meta.json").write_text(json.dumps(missing))
        with mock.patch.object(runtime, "cycle_facts", side_effect=AssertionError("resolved unrelated range")):
            self.assertIsNotNone(runtime.prepare(self.c, self.q, self.item, False))
        self.assertEqual(self.item["state"], "pending")

    def test_same_shas_across_repos_keep_admission_and_reconciliation_separate(self):
        self.finish()
        foreign = "example/secondary"
        inputs = dict(self.inputs, repo=foreign)
        facts = dict(self.facts, repo=foreign)
        result = admission.admit(self.q, request_id="foreign", inputs=inputs, resolved=facts,
            profile=self.profile, at=self.c.iso(), verify_receipt=lambda i: runtime.retained(self.c, i))
        item = self.q["items"][-1]
        self.assertEqual(result["action"], "created")
        self.assertNotEqual(item["identity"], self.item["identity"])
        self.assertNotEqual(item["id"], self.item["id"])
        pr = self.pr()
        pr["cycles"] = [dict(base=self.base, head=self.head, profile=self.profile,
            range_policy="full-range-once-v1", run_id="run-1", ndjson=str(self.rdir / "review.ndjson"))]
        self.c.REPOS = [dict(repo=foreign, clone=str(self.repo))]
        self.c.object_present = lambda *a, **kw: True
        self.c.git = lambda *a, **kw: self.git(*a)
        with mock.patch.object(runtime, "cycle_facts", side_effect=AssertionError("cross-repo reuse")):
            self.assertIsNotNone(runtime.prepare(self.c, self.q, item, False))
        self.assertEqual(item["state"], "pending")
        with mock.patch.object(backfill_runtime, "services", side_effect=AssertionError("foreign artifact publication")):
            runtime.complete(self.c, self.q, item, self.rdir, "run-1", self.cls, self.c.iso(), 0)
            runtime.republish(self.c, self.q, item)
        self.assertFalse(item["publication_pending"])
        self.assertNotIn("publication_event_id", item)
        self.assertIsNotNone(runtime.retained(self.c, item))

    def test_old_unknown_profile_cycle_and_moved_head_never_reuse(self):
        pr = self.pr()
        pr["cycles"] = [dict(base=self.base, head=self.head, range_policy="full-range-once-v1",
                             run_id="run-1", ndjson=str(self.rdir / "review.ndjson"))]
        self.assertIsNotNone(runtime.prepare(self.c, self.q, self.item, False))
        self.finish()
        other_tree = self.tree(b"new head\n")
        other = self.commit(other_tree, self.head)
        self.assertEqual(runtime.reconcile_pr(self.c, self.q, pr, dict(base=self.base, head=other), False)["head"], other)

    def test_actual_open_and_delta_plans_both_arrival_orders_and_moving_head(self):
        self.git("update-ref", "refs/remotes/origin/main", self.base)
        pr = self.pr()
        info = dict(state="OPEN", isDraft=False, headRefOid=self.head,
                    baseRefName="main", headRefName="feature")
        for pr_first in (False, True):
            self.q["items"] = [pr, self.item] if pr_first else [self.item, pr]
            with mock.patch.multiple(crq, REPOS=[], CLONE=self.repo, STATE=self.state, RUNS=self.runs), \
                 mock.patch.object(crq, "ensure_commit", return_value=True):
                for planner in (crq.plan_open, crq.plan_delta):
                    with self.assertRaisesRegex(crq.NotReady, "equivalent-local-review"):
                        planner(pr, info, False, self.q)
        self.finish()
        with mock.patch.multiple(crq, REPOS=[], CLONE=self.repo, STATE=self.state, RUNS=self.runs), \
             mock.patch.object(crq, "ensure_commit", return_value=True):
            with self.assertRaises(crq.NothingToReview):
                crq.plan_open(pr, info, False, self.q)
            self.assertEqual(len(pr["cycles"]), 1)
            new_tree = self.tree(b"moved after enrollment\n")
            info["headRefOid"] = self.commit(new_tree, self.head)
            self.assertEqual(crq.plan_delta(pr, info, False, self.q)["head"], info["headRefOid"])

    def test_failed_publication_replays_without_launch_or_local_evidence_loss(self):
        self.finish()
        receipt = self.item["receipt_id"]
        with mock.patch.object(backfill_runtime, "settings", side_effect=OSError("offline")):
            runtime.republish(self.c, self.q, self.item)
        self.assertEqual(self.item["receipt_id"], receipt)
        self.assertEqual(len(self.q["review_events"]), 1)
        self.assertEqual(self.item["publication_reason"], "offline")
        self.assertIsNotNone(runtime.retained(self.c, self.item))

    def test_ledger_has_unverified_line_scope_but_receipt_reuse_is_adequate(self):
        store = review_ledger.ArtifactStore(self.state / "artifacts")
        outbox = review_ledger.Outbox(self.state / "publication", store)
        with mock.patch.object(backfill_runtime, "settings", return_value={"enabled": True}), \
             mock.patch.object(backfill_runtime, "services", return_value=(None, store, outbox, None)), \
             mock.patch.object(backfill_runtime, "publish"):
            runtime.complete(self.c, self.q, self.item, self.rdir, "run-1", self.cls, "2026-11-08T00:01:00Z", 0)
            runtime.republish(self.c, self.q, self.item)
        events = outbox.pending()
        self.assertEqual(len(events), 1)
        payload = events[0]["payload"]
        self.assertEqual(payload["source"]["producer"], "author-queue")
        self.assertEqual(payload["outcome"], "unverified")
        self.assertFalse(payload["completion"]["scope_verified"])
        self.assertFalse(review_ledger.creditable(events[0]))
        self.assertEqual(payload["artifacts"][0]["kind"], "local-review-full-diff")
        self.assertEqual(payload["artifacts"][0]["sha256"], self.item["receipt_id"])
        self.assertIsNotNone(runtime.retained(self.c, self.item))
        self.assertTrue(self.item["publication_pending"])
        outbox.acknowledge(events[0], {events[0]["id"]})
        with mock.patch.object(backfill_runtime, "settings", return_value={"enabled": True}), \
             mock.patch.object(backfill_runtime, "services", return_value=(None, store, outbox, None)), \
             mock.patch.object(backfill_runtime, "publish") as publish:
            runtime.republish(self.c, self.q, self.item)
        self.assertFalse(self.item["publication_pending"])
        publish.assert_not_called()

    def test_faults_at_receipt_queue_and_publication_persist_points_replay(self):
        baseline = copy.deepcopy(self.q)
        real_write = review_receipt.write_receipt
        def after_write(*a):
            real_write(*a)
            raise OSError("receipt crash")
        for point in ("receipt", "terminal-queue", "outbox", "publication-queue"):
            with self.subTest(point):
                self.q = copy.deepcopy(baseline)
                self.item = self.q["items"][0]
                store = review_ledger.ArtifactStore(self.state / "artifacts")
                outbox = review_ledger.Outbox(self.state / "publication", store)
                calls = []
                def save(q):
                    calls.append(copy.deepcopy(q))
                    if (point == "terminal-queue" and len(calls) == 1
                            or point == "publication-queue" and len(calls) == 2):
                        raise OSError("queue crash")
                self.c.save_queue = save
                with mock.patch.object(backfill_runtime, "settings", return_value={"enabled": True}), \
                     mock.patch.object(backfill_runtime, "services", return_value=(None, store, outbox, None)), \
                     mock.patch.object(backfill_runtime, "publish"), \
                     mock.patch.object(outbox, "spool", side_effect=OSError("outbox crash") if point == "outbox" else outbox.spool), \
                     mock.patch.object(review_receipt, "write_receipt", side_effect=after_write if point == "receipt" else real_write):
                    try:
                        runtime.complete(self.c, self.q, self.item, self.rdir, "run-1", self.cls, "2026-11-08T00:01:00Z", 0)
                    except OSError:
                        pass
                # Recover from the pre-terminal persisted snapshot, then replay
                # retained completion bytes. This path never invokes launch.
                self.q = copy.deepcopy(baseline)
                self.item = self.q["items"][0]
                self.c.save_queue = lambda q: None
                self.finish()
                self.assertEqual(self.item["state"], "done")
                self.assertEqual(len(self.q["review_events"]), 1)
                self.assertEqual(len(self.item["attempts"]), 1)

    def test_explicit_repeat_launches_despite_completed_pr_or_local_evidence(self):
        initial = copy.deepcopy(self.q)
        for source in ("pr", "local"):
            with self.subTest(source):
                self.q = copy.deepcopy(initial)
                self.item = self.q["items"][0]
                if source == "local":
                    self.finish()
                    self.assertEqual(self.admit("normal")["action"], "reused")
                else:
                    pr = self.pr()
                    pr.update(state="done", cycles=[dict(base=self.base, head=self.head,
                        profile=self.profile, range_policy="full-range-once-v1", run_id="run-1",
                        completed_at="2026-11-08T00:01:00Z", ndjson=str(self.rdir / "review.ndjson"))])
                    self.assertIsNone(runtime.prepare(self.c, self.q, self.item, False))
                    self.assertEqual(self.item["state"], "done")  # a non-repeat reuses the PR
                    self.q["items"].remove(self.item)
                    self.q["review_requests"] = {}
                self.assertEqual(self.admit("fresh", repeat=True)["action"], "created")
                item = self.q["items"][-1]
                self.assertTrue(item["repeat_requested"])
                self.assertEqual(item["generation"], 1 if source == "pr" else 2)
                self.admit("fresh", repeat=True)  # retry joins this exact generation
                self.assertEqual(self.q["items"][-1]["id"], item["id"])
                plan = runtime.prepare(self.c, self.q, item, False)
                self.assertIsNotNone(plan)
                worktree = self.repo / ("repeat-wt-" + source)
                worktree.mkdir()
                with mock.patch.multiple(crq, CLONE=self.repo, STATE=self.state, RUNS=self.runs), \
                     mock.patch.object(crq, "secret_scan", return_value=(True, {})), \
                     mock.patch.object(crq, "make_worktree", return_value=(worktree, "fixture-branch")), \
                     mock.patch.object(crq, "save_queue"), mock.patch.object(crq, "append_work_record"), \
                     mock.patch.object(crq, "event"), \
                     mock.patch.object(crq, "subprocess", SimpleNamespace(DEVNULL=-3,
                         Popen=mock.Mock(return_value=SimpleNamespace(pid=12345)))) as processes:
                    crq.launch(self.q, item, plan)
                processes.Popen.assert_called_once()
                self.assertEqual(item["state"], "reviewing")

    def test_third_generation_really_launches_stored_flags(self):
        saved = []
        legacy = crq.author_quota.enroll(self.q, request_id="legacy-author", base=self.base,
            head=self.head, target="main", cycle=1, at=self.c.iso())["item"]
        self.q["items"].remove(legacy)
        self.q["items"].insert(0, legacy)
        legacy_binding = copy.deepcopy(self.q["author_requests"])
        worktree = self.repo / "wt"
        worktree.mkdir()
        self.c.CONFIG = {"local_review_profile": {"revision": "changed-while-queued", "flags": ["--new"]}}
        patches = dict(CLONE=self.repo, STATE=self.state, RUNS=self.runs, REPO=crq.REPO, CONFIG=self.c.CONFIG)
        with mock.patch.multiple(crq, **patches), \
             mock.patch.object(crq, "secret_scan", return_value=(True, {})), \
             mock.patch.object(crq, "make_worktree", return_value=(worktree, "fixture-branch")), \
             mock.patch.object(crq, "save_queue", side_effect=lambda q: saved.append(copy.deepcopy(q))), \
             mock.patch.object(crq, "append_work_record"), mock.patch.object(crq, "event"), \
             mock.patch.object(crq, "subprocess", SimpleNamespace(DEVNULL=-3, Popen=mock.Mock(return_value=SimpleNamespace(pid=12345)))) as processes:
            for generation in (1, 2, 3):
                if generation > 1:
                    self.admit("repeat-" + str(generation), repeat=True)
                item = self.q["items"][-1]
                plan = runtime.prepare(self.c, self.q, item, False)
                run_id = crq.launch(self.q, item, plan)
                meta = json.loads((self.runs / run_id / "meta.json").read_text())
                self.assertEqual(item["run"]["band"], "interactive")
                self.assertEqual(meta["band"], "interactive")
                self.assertEqual(meta["cmd"], ["coderabbit", "review", *item["profile"]["flags"]])
                self.assertIn("--committed", meta["cmd"])
                self.assertEqual(meta["cmd"][-2:], ["--base-commit", self.base])
                self.assertTrue(any(q["items"][-1].get("run", {}).get("launch_pending") for q in saved if q["items"][-1].get("run")))
                reserved_band = item["run"]["band"]
                (self.runs / run_id / "review.ndjson").write_text(self.raw)
                with mock.patch.object(backfill_runtime, "settings", return_value=None):
                    runtime.complete(self.c, self.q, item, self.runs / run_id, run_id,
                        self.cls, "2026-11-08T00:01:00Z", 0)
                self.assertIsNone(item["run"])
                self.assertEqual(item["attempts"][-1]["band"], reserved_band)
            self.assertEqual(processes.Popen.call_count, 3)
            self.assertEqual(self.q["items"][-1]["generation"], 3)
            pr = self.pr()
            open_plan = dict(plan, profile=self.profile)
            open_id = crq.launch(self.q, pr, open_plan)
            open_meta = json.loads((self.runs / open_id / "meta.json").read_text())
            self.assertEqual(open_meta["cmd"], meta["cmd"])
            legacy_id = crq.launch(self.q, legacy, crq.author_quota.plan(legacy))
            legacy_meta = json.loads((self.runs / legacy_id / "meta.json").read_text())
            self.assertEqual(legacy_meta["cmd"], meta["cmd"])
            self.assertEqual(legacy_meta["kind"], "author")
            self.assertNotIn("profile", legacy_meta)
            self.assertEqual(self.q["author_requests"], legacy_binding)

    def test_reservation_and_pid_persist_crashes_never_blindly_launch_twice(self):
        baseline = copy.deepcopy(self.q)
        plan = runtime.prepare(self.c, self.q, self.item, False)
        worktree = self.repo / "wt"
        worktree.mkdir()
        for fail_at in (1, 2):
            with self.subTest(persist=fail_at):
                self.q = copy.deepcopy(baseline)
                persisted = [copy.deepcopy(baseline)]
                writes = []
                def save(q):
                    writes.append(None)
                    if len(writes) == fail_at:
                        raise OSError("persist crash")
                    persisted[0] = copy.deepcopy(q)
                processes = SimpleNamespace(DEVNULL=-3, Popen=mock.Mock(return_value=SimpleNamespace(pid=12345)))
                with mock.patch.multiple(crq, CLONE=self.repo, STATE=self.state, RUNS=self.runs / str(fail_at)), \
                     mock.patch.object(crq, "secret_scan", return_value=(True, {})), \
                     mock.patch.object(crq, "make_worktree", return_value=(worktree, "fixture")), \
                     mock.patch.object(crq, "save_queue", side_effect=save), \
                     mock.patch.object(crq, "append_work_record"), mock.patch.object(crq, "event"), \
                     mock.patch.object(crq, "subprocess", processes), \
                     mock.patch.object(crq, "coverage_fallback", return_value=(None, False)):
                    with self.assertRaisesRegex(OSError, "persist crash"):
                        crq.launch(self.q, self.q["items"][0], plan)
                    self.assertEqual(processes.Popen.call_count, fail_at - 1)
                    if fail_at == 2:
                        restored = persisted[0]
                        self.assertTrue(restored["items"][0]["run"]["launch_pending"])
                        crq.start_one(restored, [], False, None, False)
                        self.assertEqual(processes.Popen.call_count, 1)


class SchedulingTests(unittest.TestCase):
    def test_generation_aging_fifo_and_foreign_open(self):
        clock = dt.datetime(2026, 11, 8, 1, tzinfo=dt.timezone.utc)
        repeat = dict(kind="local-review", generation=2, created_at="2026-11-08T00:00:00Z", order=1)
        first = dict(kind="local-review", generation=1, order=2)
        with mock.patch.object(crq, "now", return_value=clock):
            self.assertEqual(crq.rank(repeat), 0)
            self.assertLess(crq.sort_key(repeat), crq.sort_key(first))
            repeat["created_at"] = "2026-11-08T00:00:01Z"
            self.assertEqual(crq.rank(repeat), 1)
            self.assertEqual(crq.rank(dict(first, repeat_requested=True)), 1)
            self.assertEqual(crq.rank(dict(kind="open", repo="other/repo")), 0)

    def test_foreign_local_reviews_bypass_repository_rank_and_invalid_age(self):
        clock = dt.datetime(2026, 11, 8, 1, tzinfo=dt.timezone.utc)
        repos = [dict(repo="other/repo", rank_tier=3)]
        with mock.patch.object(crq, "REPOS", repos), mock.patch.object(crq, "now", return_value=clock):
            for generation, explicit, created, expected in (
                    (1, False, None, 0), (2, False, "2026-11-08T00:00:01Z", 1),
                    (1, True, "2026-11-08T00:00:01Z", 1), (2, False, "2026-11-08T00:00:00Z", 0),
                    (2, False, "invalid", 1)):
                with self.subTest(generation=generation, explicit=explicit, created=created):
                    item = dict(kind="local-review", repo="other/repo", generation=generation,
                        repeat_requested=explicit, created_at=created)
                    self.assertEqual(crq.repo_registry.rank_for(item, crq.REPO, repos), 3)
                    self.assertEqual(crq.rank(item), expected)

    def test_running_restart_reverse_harvest_and_legacy(self):
        a = dict(run_id="a-20261108T000000Z", band="interactive", started_at="2026-11-08T00:00:00Z")
        b = dict(run_id="b-20261108T000001Z", band="interactive", started_at="2026-11-08T00:00:01Z")
        q = dict(items=[dict(run=a), dict(run=b)])
        self.assertTrue(crq.background_turn(json.loads(json.dumps(q))))
        q = dict(items=[dict(attempts=[b, a])])
        self.assertTrue(crq.background_turn(q))
        q["items"][0]["attempts"].append(dict(run_id="old-20261108T000002Z"))
        self.assertFalse(crq.background_turn(q))

    def test_turn_fallback_is_scoped(self):
        q = dict(items=[], backfill_ordinary_exhausted=False)
        with mock.patch.object(crq, "_coverage_fallback", side_effect=lambda *args: (crq.ordinary_review_eligible(q), True)):
            self.assertEqual(crq.coverage_fallback(q, [], False, None, ordinary_eligible=False), (False, True))
        self.assertFalse(q["backfill_ordinary_exhausted"])

    def test_band_turn_background_eligibility_and_operator_priority(self):
        for priority, blocked in ((False, False), (True, False), (False, True)):
            with self.subTest(priority=priority, blocked=blocked):
                interactive = dict(id="i", kind="local-review", generation=1, state="pending", order=1,
                    operator_priority=priority)
                background = dict(id="b", kind="merged", state="pending", pr=1, order=2,
                    not_before="2099-01-01T00:00:00Z" if blocked else None)
                q = dict(items=[interactive, background])
                plan = dict(notes=[], base="a", head="b", target="c", label="test")
                def launch(q, item, plan):
                    item["state"] = "reviewing"
                    return item["id"]
                with mock.patch.object(crq, "background_turn", return_value=True), \
                     mock.patch.object(crq, "plan_merged", return_value=plan), \
                     mock.patch.object(runtime, "prepare", return_value=plan), \
                     mock.patch.object(crq, "launch", side_effect=launch), \
                     mock.patch.object(crq, "coverage_fallback", return_value=(None, False)):
                    result = crq.start_one(q, [], False, None, False)[0]
                self.assertEqual(result, "i" if priority or blocked else "b")


class TimestampTests(unittest.TestCase):
    def test_shared_utc_parser_rank_deadline_and_preview(self):
        clock = dt.datetime(2026, 11, 8, 1, 0, 0, 500000, tzinfo=dt.timezone.utc)
        for value, valid in (("2026-11-08T00:00:00.500Z", True),
                ("2026-11-08T10:00:00.500+10:00", True),
                ("2026-11-08T00:00:00.500", True), (123, False), ("garbage", False), (None, False), ([], False), ({}, False)):
            with self.subTest(value=value):
                item = dict(kind="local-review", title="repeat", generation=1, repeat_requested=True,
                    created_at=value, state="pending", order=1)
                config = dict(repo=crq.REPO, max_starts_per_hour=8)
                for delta in (-0.001, 0):
                    at = clock + dt.timedelta(seconds=delta)
                    with mock.patch.object(crq, "now", return_value=at):
                        self.assertEqual(crq.rank(item), 0 if valid and delta == 0 else 1)
                    summary = crq.status_summary.summarize(dict(generated_at=at.isoformat()),
                        dict(items=[item, dict(kind="local-review", generation=1, state="pending", order=2)],
                            starts=[value]), {}, config, [], at.timestamp())
                    row = next(i for i in summary["pending_items"] if i["title"] == "repeat")
                    self.assertEqual(row["approximate_position"], 1 if valid and delta == 0 else 2)
                    self.assertEqual(row["aging_deadline"], clock.timestamp() if valid else None)
                    self.assertEqual(summary["starts_60m"], int(valid))
                    self.assertEqual(crq.status_summary.timestamp(value),
                        clock.timestamp() - 3600 if valid else None)
                    if valid:
                        self.assertEqual(crq.parse_utc(value).tzinfo, dt.timezone.utc)

    def test_launch_order_uses_utc_and_fractional_seconds(self):
        # Character ordering would place the background offset after both interactive runs.
        records = [dict(run_id="background", band="background", started_at="2026-11-08T10:00:00+10:00"),
            dict(run_id="first", band="interactive", started_at="2026-11-08T00:00:00.100Z"),
            dict(run_id="second", band="interactive", started_at="2026-11-08T00:00:00.200")]
        for ordered in (records, list(reversed(records))):
            self.assertTrue(crq.background_turn(dict(items=[dict(attempts=ordered)])))
        records.append(dict(run_id="latest", band="background", started_at="2026-11-07T19:00:01-05:00"))
        self.assertFalse(crq.background_turn(dict(items=[dict(attempts=records)])))

    def test_invalid_launch_metadata_is_background_and_suffix_fallback(self):
        first = dict(run_id="a-20261108T000000Z", band="interactive", started_at="2026-11-08T00:00:00Z")
        for value in (123, "garbage", [], {}):
            with self.subTest(value=value):
                second = dict(run_id="b-20261108T000001Z", band="interactive", started_at=value)
                self.assertFalse(crq.background_turn(dict(items=[dict(attempts=[first, second])])))
                second["run_id"] = "no-chronology"
                self.assertFalse(crq.background_turn(dict(items=[dict(attempts=[first, second])])))
        second = dict(run_id="b-20261108T000001Z", band="interactive")
        self.assertTrue(crq.background_turn(dict(items=[dict(attempts=[first, second])])))
        # A receipt-only reuse of the first run must retain its reservation metadata.
        reused = dict(run_id=first["run_id"], band="background", started_at=None)
        self.assertTrue(crq.background_turn(dict(items=[dict(attempts=[first, second]), dict(attempts=[reused])])))
