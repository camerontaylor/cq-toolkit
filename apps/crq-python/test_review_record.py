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
        self.runner = SimpleNamespace(STATE=self.state, iso=lambda: AT)


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
        value, digest = review_record.normalize_record(submission(), AT)
        ledger.validate(value)
        self.assertFalse(ledger.creditable(value))
        self.assertEqual(value["payload"]["source"]["type"], "agent")
        self.assertEqual(value["payload"]["source"]["producer"], "helper-agent")
        self.assertFalse(value["payload"]["source"]["authenticated"])
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
        self.assertEqual(value["payload"]["findings"], [])
        artifact = value["payload"]["artifacts"][0]
        self.assertEqual(artifact["kind"], "report")
        self.assertEqual(artifact["sha256"], digest)

    def test_incomplete_scope_stays_unknown_and_unverified(self):
        value, _ = review_record.normalize_record(submission(head=None, verdict=None), AT)
        ledger.validate(value)
        self.assertEqual(value["payload"]["outcome"], "unverified")
        self.assertFalse(value["payload"]["completion"]["terminal"])
        self.assertEqual(value["payload"]["provenance"]["scope_confidence"], "claimed")

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
        view = review_record.historical_receipt(record)
        self.assertEqual(view["digest"], record["id"])
        self.assertEqual(view["producer"], "crq-runner-app")
        self.assertFalse(view["full_branch_coverage"])
        self.assertFalse(view["scope_verified"])
        self.assertFalse(ledger.creditable(record))

    def test_adapter_refuses_report_records(self):
        value, _ = review_record.normalize_record(submission(), AT)
        with self.assertRaises(review_record.RecordRefused):
            review_record.historical_receipt(value)


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
    def call(self, req):
        return transport.record_import({}, req, self.runner)

    def test_record_duplicate_and_quarantine_dispositions(self):
        req = dict(v=1, op="record", producer="agent", source_id="agent-1",
                   authenticated_submitter="queue-client",
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
                   report=dict(encoding="utf8", data="missing submitter"))
        quarantined = self.call(bad)
        operation.validate("response", quarantined)
        self.assertEqual(quarantined["action"], "quarantined")
        self.assertIn("authenticated submitter", quarantined["reason"])

    def test_one_bad_import_does_not_stop_scheduling(self):
        self.call(dict(v=1, op="record", producer="agent", source_id="broken",
                       report=dict(encoding="utf8", data="x")))
        result = self.call(dict(v=1, op="record", producer="manual",
                                source_id="after-bad", authenticated_submitter="op",
                                report=dict(encoding="utf8", data="a clean report")))
        operation.validate("response", result)
        self.assertEqual(result["action"], "recorded")

    def test_retained_report_bytes_are_verified_before_spool(self):
        req = dict(v=1, op="record", producer="manual", source_id="retained-1",
                   authenticated_submitter="op",
                   report=dict(encoding="utf8", data="retained body"))
        result = self.call(req)
        reference = json.loads(
            (self.state / "record-outbox" / "pending" /
             (result["record_digest"] + ".json")).read_text())
        store = ledger.ArtifactStore(self.state / "record-artifacts")
        store.verify(reference["payload"]["artifacts"][0])
        self.assertEqual(reference["payload"]["artifacts"][0]["kind"], "report")


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
