"""Spec-derived offline ledger integrity, source conflicts and crash recovery."""
import copy
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock

import review_ledger as ledger

AT = "2026-10-30T00:00:00Z"
SHA = "a" * 40


def review(artifacts, source="run-1", findings=None):
    rows = [{"path": "src/a.ts", "blob": SHA, "intervals": [[1, 2]]}]
    return ledger.event("review", ledger.REPO + ":crq-runner-app:" + source, AT, {
        "repo": ledger.REPO, "subject_id": "subject", "job_id": "subject:0", "attempt_id": "subject:0:1",
        "source": {"repo": ledger.REPO, "producer": "crq-runner-app", "type": "crq-run", "id": source, "authenticated": True},
        **{key: SHA for key in ("base", "head", "head_tree", "target", "target_tree")},
        "policy_digest": "b" * 64, "scope_digest": ledger.digest(rows),
        "paths": [{"path": "src/a.ts", "blob": SHA, "mode": "100644", "disposition": "included", "reason": "verified", "baseline": {}}],
        "requested_scope": rows, "input_scope": rows, "reviewed_scope": rows,
        "completion": {"terminal": True, "skipped": False, "scope_verified": True, "exit_code": 0, "errors": []},
        "outcome": "completed", "artifacts": artifacts, "findings": findings or []})


def rehash(value):
    value["id"] = ledger.digest({k: v for k, v in value.items() if k != "id"})
    return value


class LedgerTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.store = ledger.ArtifactStore(self.root / "durable")
        self.ref = self.store.put(b"retained terminal bytes")

    def test_untrusted_intervals_and_schema_ids_are_bounded(self):
        with self.assertRaises(ledger.IntegrityError):
            ledger.intervals([[1, 2**53 - 1]])
        with self.assertRaises(ledger.IntegrityError):
            ledger._schema("a" * 40 + "\n", {"type": "string", "pattern": "^[0-9a-f]{40,64}$"})

    def test_canonical_unicode_order_and_strict_json(self):
        self.assertEqual(ledger.canonical({"b": 2, "a": 1}), b'{"a":1,"b":2}')
        self.assertEqual(list(json.loads(ledger.canonical({"\ue000": 1, "\U00010000": 2}))), ["\U00010000", "\ue000"])
        for raw in ('{"a":1,"a":2}', '1.0', 'NaN'):
            with self.subTest(raw=raw), self.assertRaises(ledger.IntegrityError):
                ledger.loads(raw)
        for value in (1.1, 2**54, "\ud800"):
            with self.subTest(value=repr(value)), self.assertRaises(ledger.IntegrityError):
                ledger.canonical(value)

    def test_schema_hash_completion_and_scope_fail_closed(self):
        value = review([self.ref])
        self.assertTrue(ledger.creditable(ledger.validate(value)))
        cases = []
        for key, changed in (("terminal", False), ("skipped", True), ("scope_verified", False), ("exit_code", 1), ("errors", ["error"])):
            bad = copy.deepcopy(value); bad["payload"]["completion"][key] = changed; cases.append(bad)
        bad = copy.deepcopy(value); bad["schema"] = "cq.review-ledger/v2"; cases.append(bad)
        bad = copy.deepcopy(value); bad["payload"]["source"]["type"] = "author-cli"; cases.append(bad)
        bad = copy.deepcopy(value); bad["payload"]["reviewed_scope"][0]["blob"] = "c" * 40; cases.append(bad)
        for bad in cases:
            with self.subTest(bad=bad["id"]), self.assertRaises(ledger.IntegrityError):
                ledger.validate(rehash(bad))
        value["occurred_at"] = "2026-10-31T00:00:00Z"
        with self.assertRaises(ledger.IntegrityError):
            ledger.validate(value)

    def test_schema_cache_is_bound_to_current_schema_bytes(self):
        value = review([self.ref])
        schema = self.root / "schema.json"
        schema.write_bytes(ledger.SCHEMA.read_bytes())
        with mock.patch.object(ledger, "SCHEMA", schema):
            ledger.validate(value)
            schema.write_text('{"const": null}')
            with self.assertRaises(ledger.IntegrityError):
                ledger.validate(value)

    def test_source_conflict_and_replay(self):
        first = review([self.ref])
        same = ledger.loads(ledger.canonical(first))
        self.assertEqual(len(ledger.validate_sequence([first, same])), 1)
        changed = copy.deepcopy(first); changed["occurred_at"] = "2026-10-31T00:00:00Z"
        with self.assertRaisesRegex(ledger.IntegrityError, "source evidence conflict"):
            ledger.validate_sequence([first, rehash(changed)])

    def test_spool_replay_fsync_artifact_loss_and_ack(self):
        out = ledger.Outbox(self.root / "outbox", self.store)
        value = review([self.ref])
        with mock.patch.object(ledger.os, "fsync", wraps=ledger.os.fsync) as sync:
            out.spool(value)
            self.assertGreaterEqual(sync.call_count, 2)
        recovered = ledger.Outbox(self.root / "outbox", self.store)
        self.assertEqual(recovered.pending(), [value])
        recovered.spool(value)
        with self.assertRaises(ledger.IntegrityError):
            recovered.acknowledge(value, {})
        recovered.acknowledge(value, {value["id"]: value})
        self.assertEqual(recovered.pending(), [])
        Path(self.ref["location"]).write_bytes(b"corrupt")
        with self.assertRaises(ledger.IntegrityError):
            out.spool(review([self.ref], "run-2"))

    def test_finding_predecessors_and_fixed_evidence(self):
        finding = {"id": "e" * 64, "severity": "major", "source_id": None, "path": "src/a.ts", "blob": SHA,
                   "intervals": [[1, 1]], "title": "Issue", "body": "Details", "status": "untriaged", "anchor_status": "verified"}
        original = review([self.ref], findings=[finding])
        p = {"finding_id": finding["id"], "review_id": original["id"], "previous_event_id": None,
             "action": "needs-human", "evidence": {"reason": "ambiguous anchor"}, "actor": "operator"}
        first = ledger.event("finding-event", "triage:1", AT, p)
        self.assertEqual(len(ledger.validate_sequence([original, first])), 2)
        fork = ledger.event("finding-event", "triage:2", AT, p)
        with self.assertRaisesRegex(ledger.IntegrityError, "predecessor"):
            ledger.validate_sequence([original, first, fork])
        with self.assertRaisesRegex(ledger.IntegrityError, "fixing"):
            ledger.event("finding-event", "fix:1", AT, {**p, "action": "fixed", "evidence": {"acknowledgement": "delivered"}})

    def test_real_git_publication_recovery_and_forward_tamper(self):
        repo = self.root / "repo"; repo.mkdir()
        def git(*args, **kwargs):
            return subprocess.run(["git", *args], cwd=repo, capture_output=True, check=True, **kwargs).stdout.decode().strip()
        git("init", "-q"); git("config", "user.name", "fixture"); git("config", "user.email", "fixture@localhost")
        remote = self.root / "remote.git"
        subprocess.run(["git", "init", "--bare", "-q", str(remote)], check=True, capture_output=True)
        git("remote", "add", "origin", str(remote))
        tree = git("mktree", input=b"")
        genesis = git("commit-tree", tree, "-m", "Empty owner-created ledger")
        git("push", "origin", genesis + ":refs/heads/cq/review-ledger")
        publisher = ledger.GitLedger(repo)
        out = ledger.Outbox(self.root / "outbox", self.store)
        from test_backfill_accounting import Fixture
        # A publisher verifies actual Git scope as well as event schema.
        fixture = Fixture(self.root / "source")
        target = fixture.commit({"src/a.ts": b"one\ntwo\n"})
        value = fixture.full_review(target, "src/a.ts", [[1, 2]])
        for ref in value["payload"]["artifacts"]:
            self.store.put(Path(ref["location"]).read_bytes())
        value["payload"]["artifacts"] = [self.ref]
        rehash(value)
        git("fetch", str(fixture.root), value["payload"]["head"])
        out.spool(value)
        # Successful remote push followed by local acknowledgement loss: recovery
        # observes the same source, performs no extra append or vendor execution.
        with mock.patch.object(out, "acknowledge", side_effect=OSError("crash before ack")):
            with self.assertRaises(OSError):
                publisher.publish(out)
        recovered_head, records = publisher.fetch()
        self.assertEqual(records, [value])
        self.assertEqual(publisher.publish(out), recovered_head)
        self.assertFalse(out.pending())
        # Another publisher wins a normal push race. Refetch/rebuild must retain
        # both append-only records; there is no force push or lost update.
        import backfill_history as history
        contender = self.root / "contender"
        subprocess.run(["git", "clone", "-q", str(remote), str(contender)], check=True, capture_output=True)
        other = ledger.GitLedger(contender)
        other_out = ledger.Outbox(self.root / "other-outbox", self.store)
        first = history.import_source(fixture.repo, self.store, "crq-counted-cycle", "race-first", b"one", {}, AT, [])[0][0]
        second = history.import_source(fixture.repo, self.store, "crq-counted-cycle", "race-second", b"two", {}, AT, [])[0][0]
        out.spool(first); other_out.spool(second)
        actual_git = publisher.git
        raced = []
        def concurrent_git(*args, **kwargs):
            if args[0] == "push" and not raced:
                raced.append(True)
                other.publish(other_out)
            return actual_git(*args, **kwargs)
        with mock.patch.object(publisher, "git", side_effect=concurrent_git):
            publisher.publish(out)
        recovered_head, records = publisher.fetch()
        self.assertEqual({v["id"] for v in records}, {value["id"], first["id"], second["id"]})
        self.assertEqual(len(raced), 1)
        with mock.patch.object(ledger, "validate_sequence", wraps=ledger.validate_sequence) as sequence:
            self.assertEqual(publisher.read(recovered_head), records)
            self.assertEqual(sequence.call_count, 1)
        # A normal forward commit deleting the old record must halt readers.
        git("read-tree", recovered_head)
        git("update-index", "--force-remove", "--", ledger.record_path(value))
        tampered_tree = git("write-tree")
        tampered = git("commit-tree", tampered_tree, "-p", recovered_head, "-m", "Invalid delete")
        with self.assertRaisesRegex(ledger.IntegrityError, "modifies/deletes"):
            publisher.read(tampered)


if __name__ == "__main__":
    unittest.main()
