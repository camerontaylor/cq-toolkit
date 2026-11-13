"""S3b: external review records, idempotent imports and quarantine.

Covers spec §16 A-20 (imported manual/agent PASS visible with reviewer/scope,
no CodeRabbit slot), A-21 (same external report imported twice yields one
evidence record), A-22 (historical partial receipt normalized, original digest
preserved, full-branch coverage remains false), and the §12 unified-summary
fixture parity (shared with TypeScript via review-operation vectors).
"""
import copy
import hashlib
import json
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest

import review_ledger as ledger
import review_operation as operation
import review_record
import review_transport as transport

AT = "2026-11-13T00:00:00Z"
REPORT = b"Independent agent review passed on H2; reviewer identity recorded."


def submission(**overrides):
    value = dict(producer="agent", id="local:agent-pass-1", report_bytes=REPORT,
                 reviewer="helper-agent", authenticated_submitter="queue-client",
                 head="a" * 40, base="b" * 40, target="main", verdict="APPROVED",
                 forge_evidence="off-forge-import",
                 independence="agent lane: separate session, unverified")
    value.update(overrides)
    return value


class RecordTransportBase:
    """Queue runner seam: state under a tempdir, fixed clock, no Git needed."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.state = Path(self.tmp.name)
        # record_import ignores the loaded queue (it persists through the
        # outbox seam), so handle()-level tests only need a trivial loader;
        # the refusal path must never reach it (fail fast on authorization).
        self.runner = SimpleNamespace(STATE=self.state, REPO="camerontaylor/cq-toolkit",
                                      iso=lambda: AT, load_queue=lambda: {})


def spool_all(runner_ns, values, reports=()):
    """Spool through the transport's retention path, as production does."""
    store = ledger.ArtifactStore(runner_ns / "record-artifacts")
    box = ledger.Outbox(runner_ns / "record-outbox", store)
    by_digest = {hashlib.sha256(data).hexdigest(): data for data in reports}
    for value in values:
        value = copy.deepcopy(value)
        for reference in value["payload"].get("artifacts", []):
            if reference.get("kind") == "report" and reference["sha256"] in by_digest:
                retained = store.put(by_digest[reference["sha256"]])
                value["payload"]["artifacts"] = [dict(retained, kind="report")]
                value["id"] = ledger.digest({k: v for k, v in value.items() if k != "id"})
            elif reference.get("kind") == "report":
                # Already-retained events carry their durable artifact as-is;
                # put() is a no-op when the store already holds the bytes.
                existing = store.root / "sha256" / reference["sha256"]
                if not existing.is_file():
                    raise ledger.IntegrityError("report bytes not retained")
        box.spool(ledger.validate(value))
    return box


class RecordNormalizationTests(unittest.TestCase):
    def test_record_visible_with_reviewer_and_scope_never_vendor_completion(self):
        """A-20: imported agent PASS shows reviewer/scope, no CodeRabbit slot."""
        value, digest = review_record.normalize_record(
            submission(claimed_scope=[{"path": "src/x.py", "blob": "c" * 64,
                                       "intervals": [[1, 2]]}]), AT)
        ledger.validate(value)
        self.assertFalse(ledger.creditable(value))
        self.assertEqual(value["payload"]["source"]["type"], "agent")
        self.assertEqual(value["payload"]["source"]["producer"], "agent")
        self.assertFalse(value["payload"]["source"]["authenticated"])
        self.assertTrue(value["payload"]["source"]["id"].startswith("local:agent-pass-1:"))
        provenance = value["payload"]["provenance"]
        self.assertEqual(provenance["authenticated_submitter"], "queue-client")
        self.assertEqual(provenance["claimed_reviewer"], "helper-agent")
        self.assertEqual(provenance["scope_confidence"], "claimed")
        self.assertEqual(provenance["independence"],
                         "agent lane: separate session, unverified")
        # A claimed PASS stays an unverified completion: visible history, no
        # vendor credit, no full-coverage claim.
        self.assertEqual(value["payload"]["outcome"], "unverified")
        self.assertFalse(value["payload"]["completion"]["scope_verified"])
        self.assertFalse(value["payload"]["completion"]["terminal"])
        self.assertIsNotNone(provenance["completion_evidence"])
        self.assertIn("APPROVED", provenance["completion_evidence"])
        self.assertEqual(value["payload"]["reviewed_scope"], [])
        self.assertEqual(value["payload"]["requested_scope"],
                         [{"path": "src/x.py", "blob": "c" * 64, "intervals": [[1, 2]]}])
        self.assertEqual(value["payload"]["findings"], [])
        artifact = value["payload"]["artifacts"][0]
        self.assertEqual(artifact["kind"], "report")
        self.assertEqual(artifact["sha256"], digest)

    def test_incomplete_scope_stays_unknown_and_unverified(self):
        # No claimed_scope rows: the report carries no scope metadata, so the
        # coverage stays unknown (spec §12), not claimed.
        value, _ = review_record.normalize_record(submission(head=None, verdict=None), AT)
        ledger.validate(value)
        self.assertEqual(value["payload"]["outcome"], "unverified")
        self.assertFalse(value["payload"]["completion"]["terminal"])
        self.assertEqual(value["payload"]["provenance"]["scope_confidence"], "unknown")

    def test_claimed_scope_rows_report_claimed_confidence(self):
        value, _ = review_record.normalize_record(
            submission(claimed_scope=[{"path": "src/x.py", "blob": "c" * 64,
                                       "intervals": [[1, 2]]}]), AT)
        self.assertEqual(value["payload"]["provenance"]["scope_confidence"], "claimed")
        self.assertFalse(value["payload"]["completion"]["scope_verified"])

    def test_completed_claim_requires_completion_evidence(self):
        # A claimed verdict is completion evidence in provenance; the outcome
        # itself stays unverified until scope is verified (no vendor credit).
        value, _ = review_record.normalize_record(submission(verdict="APPROVED"), AT)
        self.assertFalse(value["payload"]["completion"]["terminal"])
        self.assertIsNotNone(value["payload"]["provenance"]["completion_evidence"])

    def test_oversize_or_absent_report_is_refused(self):
        with self.assertRaisesRegex(review_record.RecordRefused, "256 KiB"):
            review_record.normalize_record(
                submission(report_bytes=b"x" * (review_record.MAX_REPORT_BYTES + 1)), AT)
        with self.assertRaisesRegex(review_record.RecordRefused, "bytes"):
            review_record.normalize_record(submission(report_bytes=b""), AT)

    def test_commit_identity_must_be_full_hash(self):
        with self.assertRaisesRegex(review_record.RecordRefused, "commit"):
            review_record.normalize_record(submission(head="abc123"), AT)


class GitHubCollectionTests(unittest.TestCase):
    def test_github_review_normalizes_through_existing_fetch_shape(self):
        """Collector input is the fetchReviewState review vocabulary; no poller."""
        fetched = {"id": "PRR_node_1", "authorLogin": "alice", "authorType": None,
                   "state": "APPROVED", "body": "Looks right to me.",
                   "commitOid": "c" * 40, "submittedAt": "2026-11-12T10:00:00Z"}
        submitted = review_record.normalize_github_review(
            fetched, owner_repo="camerontaylor/cq-toolkit", pr=1601, at=AT)
        self.assertEqual(submitted["forge_evidence"], "github-review-comment")
        self.assertEqual(submitted["producer"], "manual")
        self.assertIn("github:camerontaylor/cq-toolkit#1601:PRR_node_1", submitted["id"])
        value, _ = review_record.normalize_record(submitted, AT)
        ledger.validate(value)
        provenance = value["payload"]["provenance"]
        self.assertEqual(provenance["forge_evidence"], "github-review-comment")
        # A signed-in GitHub statement is a statement, not a proven vendor run.
        self.assertEqual(value["payload"]["outcome"], "unverified")
        self.assertFalse(ledger.creditable(value))
        self.assertIn("does not identify the agent", provenance["independence"])

    def test_bot_authored_github_review_is_agent_producer(self):
        fetched = {"id": "PRR_node_2", "authorLogin": "some-bot", "authorType": "Bot",
                   "state": "COMMENTED", "body": "Bot notes.", "commitOid": None,
                   "submittedAt": None}
        submitted = review_record.normalize_github_review(
            fetched, owner_repo="o/r", pr=2, at=AT)
        self.assertEqual(submitted["producer"], "agent")


class ImportIdempotencyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.state = Path(self.tmp.name)

    def spool(self, values, reports=(REPORT,)):
        return spool_all(self.state, values, reports)

    def retained(self):
        records = []
        for name in ("pending", "ack"):
            directory = self.state / "record-outbox" / name
            if not directory.is_dir():
                continue
            for path in sorted(directory.glob("*.json")):
                value = ledger.loads(path.read_bytes())
                if value.get("event_type") == "review":
                    records.append(value)
        return records

    def test_a21_same_report_imported_twice_yields_one_evidence_record(self):
        first, action = review_record.import_record(submission(), AT, [])
        self.assertEqual(len(first), 1)
        self.assertTrue(action.startswith("record:"))
        self.spool(first)
        retained = self.retained()
        self.assertEqual(len(retained), 1)
        second, action = review_record.import_record(submission(), AT, retained)
        self.assertEqual(second, [])
        self.assertTrue(action.startswith("duplicate:"))
        self.assertEqual(action.split(":", 1)[1], retained[0]["id"])
        self.assertEqual(len(self.retained()), 1)

    def test_correction_supersedes_and_retains_original(self):
        original, _ = review_record.import_record(submission(), AT, [])
        self.spool(original)
        # The superseded target is the retained record id (the artifact-backed
        # id published to the outbox), not the pre-retention placeholder id.
        retained_before = self.retained()
        corrected = submission(report_bytes=b"corrected report body",
                               supersedes=retained_before[0]["id"])
        events, action = review_record.import_record(corrected, AT, retained_before)
        self.assertTrue(action.startswith("record:"))
        self.assertEqual(events[0]["payload"]["supersedes"], retained_before[0]["id"])
        self.spool(events, reports=(REPORT, b"corrected report body"))
        retained = self.retained()
        self.assertEqual(len(retained), 2)
        self.assertIn(retained_before[0]["id"], {r["id"] for r in retained})

    def test_correction_and_original_coexist_in_ledger_sequence(self):
        # The digest-discriminated source identity lets a correction and its
        # original coexist: validate_sequence (the publication gate) accepts
        # both, so the correction flow cannot poison the shared ledger.
        original, _ = review_record.import_record(submission(), AT, [])
        self.spool(original)
        retained_before = self.retained()
        corrected = submission(report_bytes=b"corrected report body",
                               supersedes=retained_before[0]["id"])
        events, action = review_record.import_record(corrected, AT, retained_before)
        self.assertTrue(action.startswith("record:"))
        sequence = [retained_before[0], events[0]]
        ledger.validate_sequence(sequence)
        self.assertNotEqual(retained_before[0]["source_key"], events[0]["source_key"])

    def test_repeated_quarantine_is_one_sequence_event(self):
        # The same malformed import twice yields one quarantine event per
        # (digest, reason): the sequence stays valid, the ledger is not
        # flooded by retries of a bad import.
        first_events, first_action = review_record.import_record(
            submission(producer="coderabbit-cli"), AT, [])
        second_events, second_action = review_record.import_record(
            submission(producer="coderabbit-cli"), AT, [])
        self.assertTrue(first_action.startswith("quarantined:"))
        self.assertTrue(second_action.startswith("quarantined:"))
        ledger.validate_sequence(first_events + second_events)
        self.assertEqual(first_events[0]["id"], second_events[0]["id"])

    def test_superseding_unknown_record_is_refused_without_event(self):
        original, _ = review_record.import_record(submission(), AT, [])
        events, action = review_record.import_record(
            submission(report_bytes=b"other", supersedes="f" * 64), AT, original)
        self.assertEqual(events, [])
        self.assertTrue(action.startswith("refused:"))

    def test_quarantine_has_readable_reason_and_artifact_reference(self):
        events, action = review_record.import_record(
            submission(producer="coderabbit-cli"), AT, [])
        self.assertEqual(len(events), 1)
        self.assertTrue(action.startswith("quarantined:"))
        quarantine = events[0]
        ledger.validate(quarantine)
        self.assertEqual(quarantine["event_type"], "import-result")
        self.assertEqual(quarantine["payload"]["result"], "unverified")
        self.assertIn("producer must be manual or agent", quarantine["payload"]["reason"])
        self.assertTrue(quarantine["payload"]["artifacts"][0]["sha256"])
        self.assertIsNone(quarantine["payload"]["review_id"])

    def test_quarantine_does_not_block_following_records(self):
        bad, _ = review_record.import_record(submission(report_bytes=b""), AT, [])
        good, action = review_record.import_record(submission(), AT, [])
        self.assertTrue(good or bad)
        self.assertTrue(action.startswith("record:"))

    def test_self_supersede_is_refused_by_ledger_validation(self):
        # A record whose supersedes pointer survives normalization but names
        # its own id is malformed; the ledger refuses it on validation.
        value, _ = review_record.normalize_record(
            submission(supersedes="a" * 64), AT)
        value["payload"]["supersedes"] = value["id"]
        with self.assertRaises(ledger.IntegrityError):
            ledger.validate_provenance(value)

    def test_semantically_malformed_scope_quarantines_instead_of_raising(self):
        # Wire-valid reports with semantically malformed scope content
        # (reversed intervals, duplicate rows, traversal paths) fail inside
        # ledger validation; they quarantine individually with a readable
        # reason rather than surfacing as invalid-input errors.
        reversed_rows = submission(claimed_scope=[
            {"path": "a.ts", "blob": "c" * 64, "intervals": [[2, 1]]}])
        events, action = review_record.import_record(reversed_rows, AT, [])
        self.assertTrue(action.startswith("quarantined:"))
        self.assertIn("interval", action)
        ledger.validate_sequence(events)
        duplicates = submission(claimed_scope=[
            {"path": "a.ts", "blob": "c" * 64, "intervals": [[1, 2]]},
            {"path": "a.ts", "blob": "c" * 64, "intervals": [[1, 2]]}])
        events, action = review_record.import_record(duplicates, AT, [])
        self.assertTrue(action.startswith("quarantined:"))
        ledger.validate_sequence(events)
        traversal = submission(claimed_scope=[
            {"path": "../file.ts", "blob": "c" * 64, "intervals": [[1, 2]]}])
        events, action = review_record.import_record(traversal, AT, [])
        self.assertTrue(action.startswith("quarantined:"))
        ledger.validate_sequence(events)
        # A following good record is unaffected.
        _, action = review_record.import_record(submission(), AT, [])
        self.assertTrue(action.startswith("record:"))

    def test_aggregate_scope_budget_is_enforced_before_materialization(self):
        # 256 rows of a million declared lines each fit every per-row bound but
        # would expand to 256M set members inside ledger validation; the
        # aggregate budget refuses the import cheaply, before any
        # materialization.
        rows = [{"path": f"p{i}.ts", "blob": "c" * 64,
                 "intervals": [[1, 1_000_000]]} for i in range(256)]
        events, action = review_record.import_record(
            submission(claimed_scope=rows), AT, [])
        self.assertTrue(action.startswith("quarantined:"))
        self.assertIn("expanded-line budget", action)

    def test_malformed_interval_shapes_quarantine_instead_of_raising(self):
        # The reviewer's exact repro: a non-list intervals value must
        # quarantine with a readable reason, not escape as TypeError past
        # import_record's refused-with-reason contract.
        events, action = review_record.import_record(
            submission(claimed_scope=[{"path": "a", "intervals": 5}]), AT, [])
        self.assertTrue(action.startswith("quarantined:"))
        self.assertIn("list of start/end pairs", action)
        ledger.validate_sequence(events)
        for shape in ("not-a-list", [["1", 2]], [[1], [2, 3, 4]], "x"):
            events, action = review_record.import_record(
                submission(claimed_scope=[{"path": "a", "intervals": shape}]),
                AT, [])
            self.assertTrue(action.startswith("quarantined:"), shape)
            ledger.validate_sequence(events)

    def test_empty_interval_list_is_a_valid_claimed_scope_row(self):
        # An empty interval list is a valid scope row (wire schemas and
        # ledger.scope() both allow it); the falsy-default collapse must not
        # refuse it as a non-list container.
        events, action = review_record.import_record(
            submission(claimed_scope=[{"path": "a", "blob": "b" * 64,
                                       "intervals": []}]), AT, [])
        self.assertTrue(action.startswith("record:"))
        ledger.validate_sequence(events)
        record = next(v for v in events if v["event_type"] == "review")
        self.assertEqual(record["payload"]["provenance"]["scope_confidence"], "claimed")


class HistoricalAdapterTests(unittest.TestCase):
    def a22_receipt(self):
        """A-22 source: a historical partial author-cli receipt, never credited."""
        rows = [{"path": "src/a.ts", "blob": "a" * 40, "intervals": [[1, 2]]}]
        return ledger.event("review", ledger.REPO + ":crq-runner-app:legacy", AT, {
            "repo": ledger.REPO, "subject_id": "s", "job_id": "s:0",
            "attempt_id": "s:0:1",
            "source": {"repo": ledger.REPO, "producer": "crq-runner-app",
                       "type": "author-cli", "id": "legacy", "authenticated": True},
            **{key: "a" * 40 for key in ("base", "head", "head_tree", "target", "target_tree")},
            "policy_digest": "b" * 64, "scope_digest": ledger.digest(rows),
            "paths": [{"path": "src/a.ts", "blob": "a" * 40, "mode": "100644",
                       "disposition": "included", "reason": "verified", "baseline": {}}],
            "requested_scope": rows, "input_scope": rows, "reviewed_scope": rows,
            "completion": {"terminal": True, "skipped": False, "scope_verified": False,
                           "exit_code": 1,
                           "errors": ["author cli cycles never earn coverage"]},
            "outcome": "unverified",
            "artifacts": [{"sha256": "c" * 64, "location": "x", "kind": "git-bundle"}],
            "findings": []})

    def test_a22_partial_receipt_keeps_digest_and_disclaims_coverage(self):
        record = self.a22_receipt()
        ledger.validate(record)
        view = review_record.historical_view(record)
        self.assertEqual(view["digest"], record["id"])
        self.assertEqual(view["producer"], "crq-runner-app")
        self.assertFalse(view["full_branch_coverage"])
        self.assertFalse(view["scope_verified"])
        self.assertFalse(ledger.creditable(record))

    def test_adapter_refuses_report_records(self):
        value, _ = review_record.normalize_record(submission(), AT)
        with self.assertRaises(review_record.RecordRefused):
            review_record.historical_view(value)


class CollectorSeamTests(unittest.TestCase):
    """The GitHub collector seam (backfill_history.import_source) feeds S3b."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.store = ledger.ArtifactStore(Path(self.tmp.name) / "artifacts")

    def test_github_agent_review_imports_as_uncredited_record(self):
        import backfill_history
        review = {"id": "PRR_kw_1", "user": {"login": "helper-agent", "type": "User"},
                  "body": "Looks good from the agent lane.", "state": "APPROVED",
                  "commit_id": "a" * 40, "submitted_at": "2026-11-01T00:00:00Z"}
        envelope = {"review": {"id": "PRR_kw_1", "authorLogin": "helper-agent",
                               "authorType": "User", "body": review["body"],
                               "state": "APPROVED", "commitOid": "a" * 40,
                               "submittedAt": review["submitted_at"]},
                    "owner_repo": ledger.REPO, "pr": 7}
        raw = json.dumps(review, sort_keys=True).encode()
        events, disposition = backfill_history.import_source(
            None, self.store, "github-agent-review", "PRR_kw_1", raw, envelope, AT, [])
        self.assertEqual(disposition["payload"]["result"], "unverified")
        record = next(v for v in events if v["event_type"] == "review")
        ledger.validate(record)
        # The collector's durable store reference replaces the placeholder:
        # exactly one report artifact, verifiable against the store (spool
        # verifies every artifact, so a placeholder here would abort imports).
        self.assertEqual(len(record["payload"]["artifacts"]), 1)
        self.assertEqual(record["payload"]["artifacts"][0]["kind"], "report")
        self.store.verify(record["payload"]["artifacts"][0])
        self.assertFalse(ledger.creditable(record))
        self.assertEqual(record["payload"]["source"]["type"], "manual")
        self.assertEqual(record["payload"]["provenance"]["claimed_reviewer"], "helper-agent")
        self.assertEqual(record["payload"]["provenance"]["forge_evidence"],
                         review_record.PROVENANCE_FORGE_EVIDENCE)
        self.assertEqual(record["payload"]["provenance"]["scope_confidence"], "unknown")
        # Re-importing the same source is one idempotent disposition.
        again_events, again = backfill_history.import_source(
            None, self.store, "github-agent-review", "PRR_kw_1", raw, envelope, AT, events)
        self.assertEqual(again_events, [])
        self.assertEqual(again["source_key"], disposition["source_key"])

    def test_collector_routes_human_reviews_to_github_agent_review(self):
        import backfill_history
        reviews = [
            {"id": 1, "node_id": "PRR_b", "user": {"login": "coderabbitai[bot]", "type": "Bot"},
             "body": "vendor", "state": "COMMENTED", "commit_id": None, "submitted_at": None},
            {"id": 2, "node_id": "PRR_c", "user": {"login": "helper-agent", "type": "User"},
             "body": "agent pass", "state": "APPROVED", "commit_id": "a" * 40,
             "submitted_at": "2026-11-01T00:00:00Z"},
        ]
        sources = backfill_history.collect_sources(
            {}, Path(self.tmp.name), self.store,
            github=lambda: iter([{"raw": json.dumps(r, sort_keys=True).encode(),
                                  "class": "github-agent-review",
                                  "metadata": {"review": {"id": r["node_id"],
                                               "authorLogin": r["user"]["login"],
                                               "authorType": r["user"]["type"],
                                               "body": r["body"], "state": r["state"],
                                               "commitOid": r["commit_id"],
                                               "submittedAt": r["submitted_at"]},
                                               "owner_repo": ledger.REPO, "pr": 1}}
                                 for r in reviews if r["user"]["login"] != "coderabbitai[bot]"]))
        classes = {s["class"] for s in sources["sources"]}
        self.assertIn("github-agent-review", classes)
        self.assertIn("github-agent-review", sources["acquisition"]["source_classes"])


class UnifiedSummaryFixtureTests(unittest.TestCase):
    """Spec §12 example as shared vectors, consumed by TypeScript parity."""

    def vectors(self):
        return json.loads(
            (Path(__file__).parent / "fixtures/review-operation/vectors.json").read_text())

    def test_unified_summary_rows_exist_and_validate(self):
        rows = {r["name"]: r for r in self.vectors()}
        for name in ("record-wire", "record-wire-minimal", "record-recorded-response",
                     "record-quarantined-response", "record-duplicate-response",
                     "capabilities-with-record"):
            self.assertIn(name, rows, name)
        operation.validate("wire", rows["record-wire"]["value"])
        operation.validate("wire", rows["record-wire-minimal"]["value"])
        operation.validate("response", rows["record-recorded-response"]["value"])
        operation.validate("response", rows["record-quarantined-response"]["value"])
        operation.validate("response", rows["record-duplicate-response"]["value"])
        operation.validate("response", rows["capabilities-with-record"]["value"])

    def test_agent_pass_line_normalizes_from_the_shared_wire_vector(self):
        rows = {r["name"]: r for r in self.vectors()}
        wire = rows["record-wire"]["value"]
        submitted = {
            "producer": wire["producer"], "id": wire["source_id"],
            "report_bytes": wire["report"]["data"].encode("utf-8"),
            "repo": wire["repo"], "head": wire["head_commit"],
            "base": wire["base_commit"], "target": wire["target"],
            "reviewer": wire["reviewer"],
            "authenticated_submitter": wire["authenticated_submitter"],
            "verdict": wire["verdict"], "claimed_scope": wire["claimed_scope"],
            "independence": wire["independence"],
            "forge_evidence": wire["forge_evidence"],
        }
        value, digest = review_record.normalize_record(submitted, AT)
        ledger.validate(value)
        # The unified summary line: agent PASS recorded; no vendor inference.
        self.assertFalse(ledger.creditable(value))
        self.assertEqual(value["payload"]["provenance"]["claimed_reviewer"],
                         "helper-agent")
        artifact = value["payload"]["artifacts"][0]
        self.assertEqual(artifact["sha256"], digest)
        self.assertEqual(artifact["kind"], "report")


class TransportRecordTests(RecordTransportBase, unittest.TestCase):
    PRINCIPAL = "queue-client"

    def call(self, req):
        return transport.record_import({}, req, self.PRINCIPAL, self.runner)

    def test_record_duplicate_and_quarantine_dispositions(self):
        req = dict(v=1, op="record", producer="agent", source_id="agent-1",
                   forge_evidence="off-forge-import",
                   report=dict(encoding="utf8", data=REPORT.decode()))
        result = self.call(req)
        operation.validate("response", result)
        self.assertEqual(result["action"], "recorded")
        self.assertTrue(result["record_digest"])
        self.assertFalse(result["supersedes"])
        again = self.call(req)
        operation.validate("response", again)
        self.assertEqual(again["action"], "duplicate")
        self.assertEqual(again["duplicate_of"], result["record_digest"])
        bad = dict(v=1, op="record", producer="agent", source_id="bad-1",
                   report=dict(encoding="utf8", data="x" * (257 * 1024)))
        quarantined = self.call(bad)
        operation.validate("response", quarantined)
        self.assertEqual(quarantined["action"], "quarantined")
        self.assertIn("256 KiB", quarantined["reason"])

    def test_authenticated_submitter_is_the_trusted_principal(self):
        # The client cannot choose the authenticated submitter; provenance
        # records the server-authenticated principal and the claimed reviewer
        # stays client metadata that earns no credit.
        req = dict(v=1, op="record", producer="agent", source_id="principal-1",
                   authenticated_submitter="spoofed-identity",
                   reviewer="helper-agent",
                   forge_evidence="off-forge-import",
                   report=dict(encoding="utf8", data=REPORT.decode()))
        result = self.call(req)
        self.assertEqual(result["action"], "recorded")
        record = json.loads(
            (self.state / "record-outbox" / "pending" /
             (result["record_digest"] + ".json")).read_text())
        provenance = record["payload"]["provenance"]
        self.assertEqual(provenance["authenticated_submitter"], self.PRINCIPAL)
        self.assertEqual(provenance["claimed_reviewer"], "helper-agent")

    def test_unknown_repo_is_refused_without_an_event(self):
        req = dict(v=1, op="record", producer="agent", source_id="elsewhere-1",
                   repo="other-org/other-repo",
                   report=dict(encoding="utf8", data=REPORT.decode()))
        result = self.call(req)
        operation.validate("response", result)
        self.assertEqual(result["action"], "refused")
        self.assertEqual(result["reason"], "unsupported-repo")

    def test_omitted_repo_resolves_to_the_runner_and_is_still_allowlisted(self):
        # An omitted repo defaults to the runner's own repository in
        # normalization; authorization resolves the same effective repo, so a
        # policy allowlisting only another repo cannot be bypassed by omitting
        # the field. The allowlist check runs before load_queue, so the seam
        # needs no queue.
        runner = SimpleNamespace(STATE=self.state, REPO="camerontaylor/cq-toolkit",
                                 iso=lambda: AT)
        result = transport.handle(json.dumps(dict(v=1, op="record", producer="manual",
                                                  source_id="omit-1",
                                                  report=dict(encoding="utf8", data="x"))).encode(),
                                  runner, principal=self.PRINCIPAL,
                                  policy={"enabled": True, "repo": "other-org/other-repo",
                                          "write": [self.PRINCIPAL]})
        body = json.loads(result)
        self.assertEqual(body["action"], "refused")
        self.assertEqual(body["reason"], "unsupported-repo")
        # An alternate casing spelling of the allowed repo is accepted
        # (identity comparison), avoiding a misleading quarantine reason; this
        # path proceeds to import, so it runs through the full seam with the
        # state-backed runner.
        ok = transport.handle(json.dumps(dict(v=1, op="record", producer="manual",
                                              source_id="omit-2",
                                              report=dict(encoding="utf8", data="y"))).encode(),
                              self.runner, principal=self.PRINCIPAL,
                              policy={"enabled": True, "repo": "CAMERONTAYLOR/cq-toolkit",
                                      "write": [self.PRINCIPAL]})
        self.assertEqual(json.loads(ok)["action"], "recorded")
        # The accepted path went through record_import directly, so the event
        # actually spooled under the state-backed runner.
        pending = self.state / "record-outbox" / "pending"
        self.assertTrue(any(p.suffix == ".json" for p in pending.iterdir()))

    def test_one_bad_import_does_not_stop_scheduling(self):
        self.call(dict(v=1, op="record", producer="agent", source_id="broken",
                       report=dict(encoding="utf8", data="x")))
        result = self.call(dict(v=1, op="record", producer="manual",
                                source_id="after-bad",
                                report=dict(encoding="utf8", data="a clean report")))
        operation.validate("response", result)
        self.assertEqual(result["action"], "recorded")

    def test_retained_report_bytes_are_verified_before_spool(self):
        req = dict(v=1, op="record", producer="manual", source_id="retained-1",
                   report=dict(encoding="utf8", data="retained body"))
        result = self.call(req)
        reference = json.loads(
            (self.state / "record-outbox" / "pending" /
             (result["record_digest"] + ".json")).read_text())
        store = ledger.ArtifactStore(self.state / "record-artifacts")
        store.verify(reference["payload"]["artifacts"][0])
        self.assertEqual(reference["payload"]["artifacts"][0]["kind"], "report")


class PublicationWireTests(RecordTransportBase, unittest.TestCase):
    """With a durable rollout configured, imports reach the publication outbox.

    The rollout record satisfies backfill_runtime.settings() prerequisites;
    publication itself is only requested (backfill_runtime.publish), never
    executed: no Git push, no network.
    """

    def setUp(self):
        super().setUp()
        (self.state / "backfill-rollout.json").write_text(json.dumps({
            "operational_ruling": "ruling-on-file",
            "no_live_run_verification": "verified",
            "owner_branch_ruleset_evidence": "ruleset-evidence",
            "durable_artifact_root": str(self.state / "record-artifacts"),
            "runner_identity": "crq-runner-app",
            "publisher_spool": {"ssh_alias": "publisher@spool.invalid",
                                "key": "spool-key"},
        }))

    def call(self, req):
        return transport.record_import({}, req, "queue-client", self.runner)

    def test_record_reaches_publication_outbox_and_requests_publication(self):
        req = dict(v=1, op="record", producer="manual", source_id="pub-1",
                   report=dict(encoding="utf8", data="durable import"))
        result = self.call(req)
        operation.validate("response", result)
        self.assertEqual(result["action"], "recorded")
        self.assertEqual(result["publication"], "spooled")
        # The record event sits in the publication worker's outbox pending
        # side, the same spool backfill_publisher drains.
        pending = self.state / "backfill" / "publication" / "pending"
        spooled = json.loads((pending / (result["record_digest"] + ".json")).read_text())
        self.assertEqual(spooled["event_type"], "review")
        # The artifact reference points into the configured durable store.
        store = ledger.ArtifactStore(self.state / "record-artifacts")
        store.verify(spooled["payload"]["artifacts"][0])
        # The durable publication request marker was queued for the worker.
        self.assertTrue((self.state / "backfill" / "publish-request.json").is_file())
        # A repeat import is a duplicate against the publication-outbox copy.
        again = self.call(req)
        self.assertEqual(again["action"], "duplicate")
        self.assertEqual(again["duplicate_of"], result["record_digest"])

    def test_quarantine_reaches_publication_outbox_without_request_when_disabled(self):
        # Without a rollout, the disposition answers honestly: events stay in
        # the legacy local spool and the response says publication disabled.
        (self.state / "backfill-rollout.json").unlink()
        req = dict(v=1, op="record", producer="agent", source_id="local-1",
                   report=dict(encoding="utf8", data="x"))
        result = self.call(req)
        self.assertEqual(result["publication"], "disabled")
        self.assertFalse((self.state / "backfill" / "publish-request.json").exists())

    def test_repeated_quarantine_reuses_the_retained_disposition(self):
        # The same malformed import twice, at different times, must not mint a
        # second event with the same source key and a different id: that pair
        # would be rejected by validate_sequence (source evidence conflict) and
        # block publication of every later queued event.
        bad = dict(v=1, op="record", producer="agent", source_id="repeat-bad",
                   report=dict(encoding="utf8", data="x" * (257 * 1024)))
        first = self.call(bad)
        self.runner.iso = lambda: "2026-11-13T01:00:00Z"  # a later import
        second = self.call(bad)
        operation.validate("response", second)
        self.assertEqual(second["action"], "quarantined")
        pending = self.state / "backfill" / "publication" / "pending"
        quarantines = [json.loads(p.read_text()) for p in sorted(pending.glob("*.json"))
                       if json.loads(p.read_text())["event_type"] == "import-result"]
        self.assertEqual(len(quarantines), 1)
        ledger.validate_sequence(quarantines)
        self.assertEqual(first["reason"], second["reason"])

    def test_repeated_oversize_import_reuses_the_retained_disposition(self):
        # A second identical oversize import must reuse the retained quarantine
        # disposition: minting a second event with the same source key and a
        # different id would make validate_sequence reject the sequence with a
        # source evidence conflict and block all publication.
        huge_interval_row = {"path": "a.ts", "blob": "c" * 64,
                             "intervals": [[i, i] for i in range(1, 40000)]}
        req = dict(v=1, op="record", producer="manual", source_id="huge-scope-2",
                   claimed_scope=[huge_interval_row],
                   report=dict(encoding="utf8", data="scope dump"))
        first = self.call(req)
        self.assertEqual(first["action"], "quarantined")
        self.assertEqual(first["publication"], "spooled")
        self.runner.iso = lambda: "2026-11-13T02:00:00Z"  # a later import
        second = self.call(req)
        operation.validate("response", second)
        self.assertEqual(second["action"], "quarantined")
        self.assertEqual(second["reason"], first["reason"])
        # Publication state stays honest: no new event spooled, so the second
        # answer must not claim the disposition was freshly spooled.
        self.assertNotEqual(second.get("publication"), "spooled")
        pending = self.state / "backfill" / "publication" / "pending"
        events = [json.loads(p.read_text()) for p in sorted(pending.glob("*.json"))]
        quarantines = [v for v in events if v["event_type"] == "import-result"]
        self.assertEqual(len(quarantines), 1)
        ledger.validate_sequence(events)

    def test_oversized_event_quarantines_instead_of_poisoning_the_outbox(self):
        # A report inside the transport bounds whose claimed scope row pushes
        # the serialized event past the publisher's 1 MiB validation bound is
        # quarantined at the door; the shared outbox stays publishable.
        huge_interval_row = {"path": "a.ts", "blob": "c" * 64,
                             "intervals": [[i, i] for i in range(1, 40000)]}
        req = dict(v=1, op="record", producer="manual", source_id="huge-scope-1",
                   claimed_scope=[huge_interval_row],
                   report=dict(encoding="utf8", data="scope dump"))
        result = self.call(req)
        operation.validate("response", result)
        self.assertEqual(result["action"], "quarantined")
        self.assertIn("1 MiB", result["reason"])
        pending = self.state / "backfill" / "publication" / "pending"
        for path in sorted(pending.glob("*.json")):
            value = json.loads(path.read_text())
            self.assertLessEqual(len(json.dumps(value)), review_record.MAX_EVENT_BYTES)
            ledger.validate(value)
        # A following good import still publishes cleanly.
        follow = self.call(dict(v=1, op="record", producer="manual", source_id="after-huge",
                                report=dict(encoding="utf8", data="a clean report")))
        self.assertEqual(follow["action"], "recorded")


class CapabilityTests(unittest.TestCase):
    def test_capabilities_advertise_record_operation_and_feature(self):
        caps = transport.capabilities()
        operation.validate("response", caps)
        self.assertIn("record", caps["operations"])
        self.assertIn("review-record-v1", caps["features"])

    def test_record_wire_roundtrip_through_operation_contract(self):
        req = dict(v=1, op="record", producer="manual", source_id="rt-1",
                   authenticated_submitter="queue-client",
                   report=dict(encoding="utf8", data="round trip"))
        operation.validate("wire", req)


if __name__ == "__main__":
    unittest.main()
