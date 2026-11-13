"""Offline PR association and replayable sanitized summaries on real git inputs."""
import json
from types import SimpleNamespace
from unittest import mock
import unittest

import crq
import local_review_pr as pr
import local_review_runtime as runtime
import review_admission as admission
import review_transport as transport
from test_author_snapshot_fixtures import SnapshotGitFixture
from test_pr_review_findings import FakeGh, HEAD, BASE, META, ANCHORED, write_ndjson
import pr_review_findings as findings


class AssociationTests(SnapshotGitFixture, unittest.TestCase):
    def setUp(self):
        super().setUp()
        self.c = SimpleNamespace(REPO=crq.REPO, CLONE=self.repo, CONFIG={}, STATE=self.repo / "state",
            RUNS=self.repo / "runs", git=self.git, save_queue=lambda q: None, iso=lambda: "now")
        stored = transport.profile({}, self.base)
        self.facts = runtime.facts(self.c, self.base, self.head, stored)
        inputs = {k: self.facts[k] for k in ("repo", "base_commit", "base_tree", "head_commit", "head_tree", "projection")}
        inputs["target"] = "main"
        admission.admit(self.q, request_id="first", inputs=inputs, resolved=self.facts, profile=stored, at="2026-11-08T00:00:00Z")
        self.item = self.q["items"][0]

    def test_inflight_and_stale_history_no_blanket_credit(self):
        self.assertTrue(pr.associate(self.c, self.q, crq.REPO, 7, self.base, self.head, False))
        self.assertEqual(len(self.q["items"]), 1)
        pr.observe(self.q)
        row = self.q["review_pr_outbox"][crq.REPO + "#7"]
        self.assertEqual(row["state"], "in progress")
        row["pending"] = False
        pr.observe(self.q)
        self.assertFalse(row["pending"])
        self.assertFalse(pr.associate(self.c, self.q, crq.REPO, 7, self.base, self.base, False))
        pr.observe(self.q)
        self.assertIn("prior coverage", self.q["review_pr_outbox"][crq.REPO + "#7"]["state"])

    def test_completed_link_is_not_labelled_findings_before_publication(self):
        # A clean completed run with its own receipt was labelled "findings" in the
        # link/outbox record (live: toolkit-research#25). publish() derives the real
        # clean/findings outcome from the retained receipt; until then it is "completed".
        pr.associate(self.c, self.q, crq.REPO, 7, self.base, self.head, False)
        self.item.update(state="done", scope_adequate=True, receipt_id="r" * 64,
                         local_run_id="lr-run-20261108T000000Z")
        pr.observe(self.q)
        key = crq.REPO + "#7"
        self.assertEqual(self.q["review_pr_outbox"][key]["state"], "completed")
        self.assertEqual(self.q["review_pr_links"][key]["state"], "completed")
        self.assertEqual(self.q["review_pr_links"][key]["version"][3], "completed")

    def test_cancel_and_supersede_events(self):
        pr.associate(self.c, self.q, crq.REPO, 7, self.base, self.head, False)
        pr.observe(self.q)
        admission.cancel(self.q, "first")
        pr.observe(self.q)
        self.assertEqual(self.q["review_pr_outbox"][crq.REPO + "#7"]["state"], "cancelled")
        self.q["review_requests"]["replacement"] = dict(supersedes="first")
        pr.observe(self.q)
        self.assertEqual(self.q["review_pr_outbox"][crq.REPO + "#7"]["state"], "superseded")

    def test_superseded_shared_observer_still_delivers_completed_findings(self):
        first = self.q["review_requests"]["first"]
        self.q["review_requests"]["second"] = dict(first)
        self.q["review_requests"]["third"] = dict(first, supersedes="first")
        self.item["observers"] += ["second", "third"]
        pr.associate(self.c, self.q, crq.REPO, 7, self.base, self.head, False)
        pr.observe(self.q)
        self.assertEqual(self.q["review_pr_outbox"][crq.REPO + "#7"]["state"], "in progress")
        rdir = self.c.RUNS / "shared-run"
        rdir.mkdir(parents=True)
        write_ndjson(rdir, [ANCHORED])
        with mock.patch("backfill_runtime.settings", return_value=None):
            runtime.complete(self.c, self.q, self.item, rdir, "shared-run",
                dict(counted=True, outcome="completed", findings=1), "2026-11-08T00:01:00Z", 0)
        gh = FakeGh()
        with mock.patch.object(findings, "pr_state", return_value=dict(state="open", head=self.head, base=self.base)), \
             mock.patch.object(pr, "write_summary") as write:
            pr.publish(self.c, self.q, gh)
        self.assertIn("State: findings", write.call_args.args[1])
        self.assertEqual(len(gh.posts()), 1)

    def test_successful_pin_enrollment_associates_without_open_item(self):
        opened = [dict(number=7, isDraft=False, baseRefName="main", headRefName="feature", headRefOid=self.head)]
        self.git("update-ref", "refs/remotes/origin/main", self.base)
        with mock.patch.multiple(crq, CLONE=self.repo, CONFIG={}), \
             mock.patch.object(crq, "gh_json", return_value=opened), \
             mock.patch.object(crq, "ensure_commit", return_value=True), \
             mock.patch.object(crq, "event"):
            crq.enroll(self.q, False)
        self.assertEqual([i["kind"] for i in self.q["items"]], ["local-review"])
        self.assertEqual(self.q["review_pr_links"][crq.REPO + "#7"]["item"], self.item["id"])
        pr.observe(self.q)
        self.assertEqual(self.q["review_pr_outbox"][crq.REPO + "#7"]["state"], "in progress")

    def test_summary_marker_recovers_create_then_edits_and_sanitizes(self):
        row = dict(repo=crq.REPO, pr=7, head=self.head, base=self.base, state="clean")
        body = pr.summary(row, dict(review_url="http://private-mesh/home/secret"))
        self.assertNotIn("private", body)
        self.assertIn("not an independent PASS", body)
        gh = FakeGh()
        # Comments endpoint is a separate producer from App reviews.
        def fake(argv, *, input_text=None):
            if "--paginate" in argv:
                return SimpleNamespace(returncode=0, stdout=json.dumps(dict(id=42, body="old")), stderr="")
            return gh(argv, input_text=input_text)
        pr.write_summary(row, body, fake)
        self.assertEqual(len(gh.posts()), 1)
        self.assertIn("PATCH", gh.calls[-1][0])
        self.assertIn("issues/comments/42", " ".join(gh.calls[-1][0]))

    def test_clean_and_moved_head_deliver_no_inline(self):
        path = write_ndjson(self.repo, [])
        gh = FakeGh()
        with mock.patch.object(findings, "pr_state", return_value=dict(state="open", head=HEAD, base=BASE)):
            self.assertEqual(findings.deliver(crq.REPO, 7, dict(META, local_review=True), path, gh)["state"], "skipped-empty")
        with mock.patch.object(findings, "pr_state", return_value=dict(state="open", head="c" * 40, base=BASE)):
            self.assertEqual(findings.deliver(crq.REPO, 7, dict(META, local_review=True), path, gh)["state"], "skipped-head")
        self.assertFalse(gh.posts())

    def test_fingerprint_is_head_bound_set_and_app_is_separate(self):
        path = write_ndjson(self.repo, [ANCHORED, ANCHORED])
        gh = FakeGh()
        with mock.patch.object(findings, "pr_state", return_value=dict(state="open", head=HEAD, base=BASE)):
            result = findings.deliver(crq.REPO, 7, dict(META, local_review=True), path, gh)
        self.assertEqual(result["state"], "created")
        self.assertIn("crq-local-findings head=" + HEAD, gh.posts()[0]["body"])
        queries = " ".join(" ".join(argv) for argv, _ in gh.calls)
        self.assertIn('.user.login == "crq-host"', queries)

    def test_completed_receipt_reused_and_clean_summary_only_once(self):
        rdir = self.c.RUNS / "local-run"
        rdir.mkdir(parents=True)
        (rdir / "review.ndjson").write_text('{"type":"complete"}\n')
        with mock.patch("backfill_runtime.settings", return_value=None):
            runtime.complete(self.c, self.q, self.item, rdir, "local-run",
                dict(counted=True, outcome="completed", findings=0), "2026-11-08T00:01:00Z", 0)
        self.assertTrue(pr.associate(self.c, self.q, crq.REPO, 7, self.base, self.head, False))
        gh = FakeGh()
        with mock.patch.object(findings, "pr_state", return_value=dict(state="open", head=self.head, base=self.base)), \
             mock.patch.object(pr, "write_summary") as write:
            pr.publish(self.c, self.q, gh)
            pr.publish(self.c, self.q, gh)
        write.assert_called_once()
        self.assertIn("State: clean", write.call_args.args[1])
        self.assertFalse(gh.posts())
        self.assertEqual(len(self.q["items"]), 1)

    def test_pin_failure_enrolls_open_and_plan_time_still_waits(self):
        opened = [dict(number=7, isDraft=False, baseRefName="main", headRefName="feature", headRefOid=self.head)]
        with mock.patch.object(crq, "gh_json", return_value=opened), \
             mock.patch.object(crq, "ensure_commit", return_value=False):
            crq.enroll(self.q, False)
        item = self.q["items"][-1]
        self.assertEqual(item["kind"], "open")
        self.c.NotReady, self.c.NothingToReview = crq.NotReady, crq.NothingToReview
        with self.assertRaisesRegex(crq.NotReady, "equivalent-local-review"):
            runtime.reconcile_pr(self.c, self.q, item, dict(base=self.base, head=self.head), False)

    def test_pr_open_with_review_v1_request_associates_without_second_start(self):
        # S2b-i: an admitted review-v1 request for the PR pins enrolls by
        # ASSOCIATION - no second review starts. associate() matches
        # equivalent items (pending or completed) without needing a retained
        # receipt, so the enrollment path (crq.enroll -> associate ->
        # continue) enrolls no open/delta item and records the PR link.
        # The item stays in its admitted (pending) state throughout:
        # enrollment starts nothing.
        prior_state = self.item["state"]
        opened = [dict(number=7, isDraft=False, baseRefName="main",
                        headRefName="feature", headRefOid=self.head)]
        self.git("update-ref", "refs/remotes/origin/main", self.base)
        with mock.patch.multiple(crq, CLONE=self.repo, CONFIG={}), \
             mock.patch.object(crq, "gh_json", return_value=opened), \
             mock.patch.object(crq, "ensure_commit", return_value=True), \
             mock.patch.object(crq, "event"):
            crq.enroll(self.q, False)
        # No open/delta item started: the only queue item is the admitted
        # review-v1 item, still pending, and the PR link points at it.
        self.assertEqual([i["kind"] for i in self.q["items"]], ["local-review"])
        self.assertEqual(self.item["state"], prior_state)
        self.assertEqual(self.q["review_pr_links"][crq.REPO + "#7"]["item"], self.item["id"])
        self.assertEqual(self.q["review_pr_links"][crq.REPO + "#7"]["head"], self.head)

    def test_base_difference_preserves_history_without_reuse(self):
        pr.associate(self.c, self.q, crq.REPO, 7, self.base, self.head, False)
        self.assertFalse(pr.associate(self.c, self.q, crq.REPO, 7, self.head, self.head, False))
        pr.observe(self.q)
        self.assertIn("prior coverage", self.q["review_pr_outbox"][crq.REPO + "#7"]["state"])

    def test_repeat_set_dedup_different_titles_deliver(self):
        class StoredGh(FakeGh):
            def __init__(self):
                super().__init__()
                self.bodies = []
            def __call__(self, argv, *, input_text=None):
                if "--paginate" in argv:
                    query = argv[-1]
                    # Interpret only this adapter's two marker predicates.
                    import re
                    marker = re.search(r'(?:contains|startswith)\(("(?:[^"\\]|\\.)*")\)', query)
                    wanted = json.loads(marker[1]) if marker else "absent"
                    found = any(wanted in body for body in self.bodies)
                    return SimpleNamespace(returncode=0, stdout=json.dumps(dict(id=77, url="https://github.com/x/y/pull/7/77")) if found else "", stderr="")
                if "--method" in argv:
                    self.bodies.append(json.loads(input_text)["body"])
                    self.post = [(0, json.dumps(dict(id=77)), "")]
                return super().__call__(argv, input_text=input_text)
        gh = StoredGh()
        path = write_ndjson(self.repo, [ANCHORED])
        meta = dict(META)  # first delivery is an ordinary open/delta run
        with mock.patch.object(findings, "pr_state", return_value=dict(state="open", head=HEAD, base=BASE)):
            self.assertEqual(findings.deliver(crq.REPO, 7, meta, path, gh)["state"], "created")
            repeat = dict(meta, run_id="repeat-run", local_review=True)
            self.assertEqual(findings.deliver(crq.REPO, 7, repeat, path, gh)["state"], "existing")
            write_ndjson(self.repo, [dict(ANCHORED, title="Different finding")])
            self.assertEqual(findings.deliver(crq.REPO, 7, repeat, path, gh)["state"], "created")
            for field, value in (("startLine", 41), ("comment", "A different explanation"), ("severity", "critical")):
                write_ndjson(self.repo, [dict(ANCHORED, **{field: value})])
                repeat["run_id"] = "repeat-" + field
                self.assertEqual(findings.deliver(crq.REPO, 7, repeat, path, gh)["state"], "created")
            write_ndjson(self.repo, [ANCHORED, dict(ANCHORED, startLine=41)])
            repeat["run_id"] = "repeat-two-locations"
            self.assertEqual(findings.deliver(crq.REPO, 7, repeat, path, gh)["state"], "created")
            write_ndjson(self.repo, [ANCHORED, dict(ANCHORED, fileName=None)])
            repeat["run_id"] = "repeat-fileless"
            self.assertEqual(findings.deliver(crq.REPO, 7, repeat, path, gh)["state"], "created")
        self.assertEqual(len(gh.bodies), 7)
