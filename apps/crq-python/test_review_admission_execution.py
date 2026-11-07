"""Offline launch, reconciliation and durable local completion."""
import copy
import json
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
        self.finish()
        self.assertTrue(self.item["publication_pending"])
        self.assertEqual(self.item["publication_reason"], "publication-disabled")
        self.assertIsNotNone(runtime.retained(self.c, self.item))
        with self.assertRaises(crq.NothingToReview):
            runtime.reconcile_pr(self.c, self.q, pr, self.plan(), False)
        self.assertEqual(pr["cycles"][0]["run_id"], "run-1")
        self.assertEqual(pr["cycles"][0]["profile"], self.profile)
        self.assertNotIn("coverage", self.q)

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
                self.assertEqual(meta["cmd"], ["coderabbit", "review", *item["profile"]["flags"]])
                self.assertIn("--committed", meta["cmd"])
                self.assertEqual(meta["cmd"][-2:], ["--base-commit", self.base])
                self.assertTrue(any(q["items"][-1].get("run", {}).get("launch_pending") for q in saved if q["items"][-1].get("run")))
                item.update(state="done", run=None, scope_adequate=True, receipt_id="f" * 64)
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
