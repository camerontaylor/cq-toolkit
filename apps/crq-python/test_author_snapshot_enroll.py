"""Author-snapshot enrollment: real lock, policy, pin and replay semantics.

Split provenance: apps/crq-python/test_author_snapshot.py was split by subject
into test_author_snapshot_plan.py, test_author_snapshot_enroll.py,
test_author_snapshot_payload.py, test_author_snapshot_install.py and
test_author_snapshot_launch.py; shared fixtures live in
test_author_snapshot_fixtures.py.
"""
import copy
from pathlib import Path
import json
import subprocess
import sys
import unittest
from unittest import mock

import author_quota
import author_snapshot as snapshot
import author_transport as transport
import crq
from test_author_snapshot_fixtures import SnapshotTransportFixture, envelope


class SnapshotTransport(SnapshotTransportFixture, unittest.TestCase):
    def test_real_enroll_plan_pin_and_idempotent_replay(self):
        first = self.call()
        before = (self.state / "queue.json").read_bytes()
        second = self.call()
        self.assertEqual(first, second)
        self.assertEqual(before, (self.state / "queue.json").read_bytes())
        q = json.loads(before)
        self.assertEqual(len(q["items"]), 1)
        self.assertNotIn("snapshot", q["items"][0])
        head = self.request["binding"]["head"]
        pin = "refs/crq/author-snapshots/v1/" + head
        self.assertEqual(snapshot.git(self.destination, "rev-parse", pin).decode().strip(), head)
        snapshot.git(self.destination, "gc", "--prune=now")
        self.assertEqual(snapshot.git(self.destination, "cat-file", "-t", head).strip(), b"commit")

    def test_malformed_partial_extra_and_corrupt_payloads_never_enroll(self):
        bad = []
        for field, value in (("v", 3), ("sha256", "0" * 64), ("tree", self.base)):
            req = copy.deepcopy(self.request)
            req["snapshot"][field] = value
            bad.append(req)
        for modify in (lambda objects: objects.pop(), lambda objects: objects.append(objects[-1]),
                       lambda objects: objects[0].update(data="!!!!"),
                       lambda objects: objects[0].update(type="tag")):
            req = copy.deepcopy(self.request)
            modify(req["snapshot"]["objects"])
            bad.append(req)
        before = (self.state / "queue.json").read_bytes()
        for req in bad:
            with self.subTest(req=str(req)[:80]), self.assertRaises(author_quota.AuthorRefused):
                self.call(req)
            self.assertEqual(before, (self.state / "queue.json").read_bytes())
        self.assertEqual(snapshot.git(self.destination, "for-each-ref", "refs/crq/"), b"")

    def test_same_request_different_tree_cannot_install_or_rebind(self):
        self.call()
        before = (self.state / "queue.json").read_bytes()
        other = envelope(self.repo, self.base, self.tree(b"second tree\n"))
        with self.assertRaisesRegex(author_quota.AuthorRefused, "conflicting"):
            self.call(other)
        self.assertEqual(before, (self.state / "queue.json").read_bytes())
        with self.assertRaises(author_quota.AuthorRefused):
            snapshot.git(self.destination, "cat-file", "-t", other["binding"]["head"])

    def test_rejected_admission_does_not_install_or_change_queue(self):
        original = (self.state / "queue.json").read_bytes()
        for policy, queue in (
            ({"review": {"reviewerTimeoutMin": 0}}, self.q),
            ({"review": {"reviewerTimeoutMin": 25}},
             {**self.q, "items": [{"id": "author-snapshot-1"}]}),
        ):
            (self.state / "policy.json").write_text(json.dumps(policy))
            (self.state / "queue.json").write_text(json.dumps(queue))
            before = (self.state / "queue.json").read_bytes()
            with mock.patch.object(snapshot, "install") as install:
                with self.assertRaises(author_quota.AuthorRefused):
                    self.call()
                install.assert_not_called()
            self.assertEqual(before, (self.state / "queue.json").read_bytes())
        (self.state / "queue.json").write_bytes(original)
        self.assertEqual(snapshot.git(self.destination, "for-each-ref", "refs/crq/"), b"")
        with self.assertRaises(author_quota.AuthorRefused):
            snapshot.git(self.destination, "cat-file", "-t", self.request["binding"]["head"])

    def test_existing_admission_policy_and_binding_checked_before_install(self):
        self.call()
        before = (self.state / "queue.json").read_bytes()
        (self.state / "policy.json").write_text(json.dumps({"review": {"reviewerTimeoutMin": 30}}))
        with mock.patch.object(snapshot, "install") as install:
            with self.assertRaisesRegex(author_quota.AuthorRefused, "lease policy"):
                self.call()
            install.assert_not_called()
        (self.state / "policy.json").write_text(json.dumps({"review": {"reviewerTimeoutMin": 25}}))
        other = copy.deepcopy(self.request)
        other["binding"]["request_id"] = "another-request"
        with mock.patch.object(snapshot, "install") as install:
            with self.assertRaises(author_quota.AuthorRefused):
                self.call(other)
            install.assert_not_called()
        self.assertEqual(before, (self.state / "queue.json").read_bytes())

    def test_secret_scan_and_interrupted_quarantine_never_install(self):
        before = (self.state / "queue.json").read_bytes()
        with mock.patch.object(snapshot, "decode", side_effect=InterruptedError):
            with self.assertRaises(InterruptedError):
                self.call()
        # Use a real install under the same lock, with an explicit scanner refusal.
        with mock.patch.object(crq, "CLONE", self.destination), \
             mock.patch.object(crq, "secret_scan_diff", return_value=(False, {})), \
             mock.patch.object(crq, "denylist_rules", return_value=[{"id": "fixture", "regex": "(?!)"}]):
            with self.assertRaisesRegex(author_quota.AuthorRefused, "secret scan"):
                snapshot.install(self.request["snapshot"], self.request["binding"], crq)
        self.assertEqual(before, (self.state / "queue.json").read_bytes())
        self.assertEqual(snapshot.git(self.destination, "for-each-ref", "refs/crq/"), b"")
        with self.assertRaises(author_quota.AuthorRefused):
            snapshot.git(self.destination, "cat-file", "-t", self.request["binding"]["head"])

    def test_pin_before_failed_enrollment_is_recoverable(self):
        with mock.patch.object(crq, "enroll_author", side_effect=InterruptedError):
            with self.assertRaises(InterruptedError):
                self.call()
        self.assertEqual(json.loads((self.state / "queue.json").read_text())["items"], [])
        self.assertEqual(self.call()["issuer"], "waiting")

    def test_bounded_payload_and_snapshot_version(self):
        for limit in ("MAX_CONTENT", "MAX_OBJECTS"):
            with mock.patch.object(snapshot, limit, 0), self.assertRaises(author_quota.AuthorRefused):
                self.call()
        for raw in (b"x" * (transport.MAX_SNAPSHOT_BYTES + 1), json.dumps(self.request).encode()[:-5]):
            with self.assertRaises(author_quota.AuthorRefused):
                transport.decode(raw)
        req = copy.deepcopy(self.request)
        req["op"] = "fallback"
        with self.assertRaises(author_quota.AuthorRefused):
            self.call(req)

    def test_concurrent_processes_admit_at_most_one_item(self):
        cmd = [sys.executable, "-B", "-c", "from test_author_snapshot_fixtures import wire_fixture_main; wire_fixture_main()",
               str(self.destination), str(self.state)]
        raw = json.dumps(self.request).encode()
        processes = [subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                     cwd=Path(__file__).parent) for _ in range(2)]
        for process in processes:
            process.stdin.write(raw)
            process.stdin.close()
            process.stdin = None
        results = [process.communicate(timeout=30) for process in processes]
        self.assertTrue(any(process.returncode == 0 for process in processes), results)
        self.assertTrue(all(process.returncode in (0, 2) for process in processes), results)
        q = json.loads((self.state / "queue.json").read_text())
        self.assertEqual(len(q["items"]), 1)
        self.assertEqual(q["starts"], [])
