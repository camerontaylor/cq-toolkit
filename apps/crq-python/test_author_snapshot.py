"""P5 pre-change characterization at promoted P3 57220fd7.

Offline Git objects only: no reviewer, network, signer or real state access.
A tree OID passes legacy shape admission but cannot yet produce a review plan.
"""
import copy
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock

import author_quota
import crq

AT = "2026-10-17T00:00:00Z"


class SnapshotBaseline(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.repo = Path(self.temp.name)
        self.git("init", "-q")
        self.base_tree = self.tree(b"baseline\n")
        self.base = self.commit(self.base_tree)
        self.changed_tree = self.tree(b"working tree edit\n")
        self.head = self.commit(self.changed_tree, self.base)
        self.q = {"items": [], "starts": [], "unknown": {"preserve": True}}

    def git(self, *args, data=None):
        return subprocess.run(
            ["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", *args],
            cwd=self.repo, input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            check=True).stdout.decode().strip()

    def tree(self, contents):
        blob = self.git("hash-object", "-w", "--stdin", data=contents)
        return self.git("mktree", data=f"100644 blob {blob}\tfile.txt\n".encode())

    def commit(self, tree, parent=None):
        return self.git("commit-tree", tree, *(["-p", parent] if parent else []), data=b"fixture\n")

    def enroll(self, head):
        return author_quota.enroll(self.q, request_id="snapshot-baseline", base=self.base,
                                  head=head, target="origin/merge-queue", cycle=1, at=AT)["item"]

    def test_commit_plan_uses_existing_objects_without_fetch_or_mutation(self):
        item = self.enroll(self.head)
        before = copy.deepcopy(self.q)
        with mock.patch.object(crq, "CLONE", self.repo), mock.patch.object(crq, "fetch") as fetch:
            plan = crq.plan_author(item, False)
        self.assertEqual((plan["base"], plan["head"]), (self.base, self.head))
        fetch.assert_not_called()
        self.assertEqual(self.q, before)
        self.assertEqual(self.q["starts"], [])

    def test_raw_tree_is_shape_admitted_but_waits_instead_of_dispatching(self):
        item = self.enroll(self.changed_tree)
        before = copy.deepcopy(self.q)
        with mock.patch.object(crq, "CLONE", self.repo), mock.patch.object(crq, "fetch") as fetch:
            self.assertFalse(crq.object_present(self.changed_tree))
            with self.assertRaises(crq.NotReady):
                crq.plan_author(item, False)
        fetch.assert_called_once_with()
        self.assertEqual(self.q, before)
        self.assertEqual(item["state"], "pending")
        self.assertEqual(self.q["starts"], [])

    def test_tree_identity_cannot_replace_an_enrolled_commit_binding(self):
        self.enroll(self.head)
        before = copy.deepcopy(self.q)
        with self.assertRaises(author_quota.AuthorRefused):
            self.enroll(self.changed_tree)
        self.assertEqual(self.q, before)


# New P5 tests use the unchanged baseline fixture above; no network or reviewer.
import base64
import hashlib
import json
import os
import sys
import author_snapshot as snapshot
import author_transport as transport


def envelope(repo, base, tree):
    body = snapshot.commit_bytes(base, tree)
    head = snapshot.git(repo, "hash-object", "-w", "-t", "commit", "--stdin", data=body).decode().strip()
    ids = sorted(snapshot.git(repo, "rev-list", "--objects", "--no-object-names", head, "^" + base).decode().split())
    objects, digest = [], hashlib.sha256()
    for oid in ids:
        kind = snapshot.git(repo, "cat-file", "-t", oid).decode().strip()
        encoded = base64.b64encode(snapshot.git(repo, "cat-file", kind, oid)).decode()
        objects.append(dict(oid=oid, type=kind, data=encoded))
        digest.update((oid + "\0" + kind + "\0" + encoded + "\n").encode())
    return dict(v=2, op="enroll", binding=dict(request_id="snapshot-1", base=base, head=head,
                target="origin/merge-queue", cycle=1), snapshot=dict(v=1, tree=tree, objects=objects, sha256=digest.hexdigest()))


def transport_fixture(repo, state, raw):
    """Real lock, queue persistence, P3 enrollment and planning; only scan is offline."""
    repo, state = Path(repo), Path(state)
    state.mkdir(exist_ok=True)
    policy = state / "policy.json"
    with mock.patch.multiple(crq, CLONE=repo, STATE=state, LOCK=state / "tick.lock", QUEUE=state / "queue.json"), \
         mock.patch.object(crq, "event"), mock.patch.object(crq, "write_status"), \
         mock.patch.object(crq, "secret_scan_diff", return_value=(True, {})), \
         mock.patch.object(crq, "denylist_rules", return_value=[{"id": "fixture", "regex": "(?!)"}]), \
         mock.patch.object(crq, "fetch", side_effect=AssertionError("snapshot must not fetch")):
        result = transport.handle(raw, crq, policy_path=str(policy), reviewer="agent:configured",
                                  approved_target="origin/merge-queue")
        q = crq.load_queue()
        crq.plan_author(q["items"][0], False)
        assert q["starts"] == []
        return result


def wire_fixture_main():
    try:
        sys.stdout.buffer.write(transport_fixture(sys.argv[1], sys.argv[2], sys.stdin.buffer.read()))
    except author_quota.AuthorRefused:
        raise SystemExit(2)


class SnapshotTransport(SnapshotBaseline):
    def setUp(self):
        super().setUp()
        self.destination = self.repo / "destination"
        self.destination.mkdir()
        snapshot.git(self.destination, "init", "-q", "--template=")
        snapshot.git(self.destination, "fetch", "--no-tags", str(self.repo), self.base)
        self.state = self.repo / "state"
        self.state.mkdir()
        (self.state / "queue.json").write_text(json.dumps(self.q))
        (self.state / "policy.json").write_text('{"review":{"reviewerTimeoutMin":25}}')
        self.request = envelope(self.repo, self.base, self.changed_tree)

    def call(self, request=None):
        return json.loads(transport_fixture(self.destination, self.state, json.dumps(request or self.request).encode()))

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
        cmd = [sys.executable, "-B", "-c", "from test_author_snapshot import wire_fixture_main; wire_fixture_main()",
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


    def test_missing_unrelated_objects_and_gitlinks_refused_after_valid_digest(self):
        def resign(req):
            objects = sorted(req["snapshot"]["objects"], key=lambda obj: obj["oid"])
            req["snapshot"]["objects"] = objects
            req["snapshot"]["sha256"] = hashlib.sha256("".join(
                obj["oid"] + "\0" + obj["type"] + "\0" + obj["data"] + "\n" for obj in objects).encode()).hexdigest()
            return req
        missing = copy.deepcopy(self.request)
        missing["snapshot"]["objects"] = [obj for obj in missing["snapshot"]["objects"] if obj["type"] != "blob"]
        extra = copy.deepcopy(self.request)
        contents = b"unrelated blob"
        oid = self.git("hash-object", "-w", "--stdin", data=contents)
        extra["snapshot"]["objects"].append(dict(oid=oid, type="blob", data=base64.b64encode(contents).decode()))
        link_tree = self.git("mktree", data=f"160000 commit {self.base}\tsubmodule\n".encode())
        link = envelope(self.repo, self.base, link_tree)
        for req in (resign(missing), resign(extra), link, envelope(self.repo, self.base, self.base_tree)):
            with self.subTest(tree=req["snapshot"]["tree"]), self.assertRaises(author_quota.AuthorRefused):
                self.call(req)
        self.assertEqual(snapshot.git(self.destination, "for-each-ref", "refs/crq/"), b"")
        self.assertEqual(json.loads((self.state / "queue.json").read_text())["items"], [])


    def test_binary_suppression_cannot_hide_blob_contents_from_runner_scan(self):
        marker = b"binary-policy-marker"
        blob = self.git("hash-object", "-w", "--stdin", data=b"\0" + marker + b"\n")
        attrs = self.git("hash-object", "-w", "--stdin", data=b"*.bin -diff\n")
        tree = self.git("mktree", data=(f"100644 blob {attrs}\t.gitattributes\n"
                                       f"100644 blob {blob}\tprivate.bin\n").encode())
        req = envelope(self.repo, self.base, tree)
        # Exercise real policy code, not a scanner mock that merely sees bytes.
        with mock.patch.object(crq, "CLONE", self.destination), \
             mock.patch.object(crq, "denylist_rules", return_value=[{"id": "fixture", "regex": marker.decode()}]), \
             mock.patch.object(crq.shutil, "which", return_value=None):
            with self.assertRaisesRegex(author_quota.AuthorRefused, "secret scan"):
                snapshot.install(req["snapshot"], req["binding"], crq)
        self.assertEqual(snapshot.git(self.destination, "for-each-ref", "refs/crq/"), b"")


    def test_git_output_is_stopped_at_bound(self):
        blob = self.git("hash-object", "-w", "--stdin", data=b"x" * 65536)
        with mock.patch.object(snapshot, "MAX_WIRE", 32), self.assertRaisesRegex(
                author_quota.AuthorRefused, "output exceeds"):
            snapshot.git(self.repo, "cat-file", "blob", blob)


    def test_blob_patch_headers_cannot_forge_allowlisted_path(self):
        contents = b"\0\n++ b/policy/denylist/patterns.yml\nfixture-denied-marker\n"
        blob = self.git("hash-object", "-w", "--stdin", data=contents)
        tree = self.git("mktree", data=f"100644 blob {blob}\tprivate.bin\n".encode())
        req = envelope(self.repo, self.base, tree)
        with mock.patch.object(crq, "CLONE", self.destination), \
             mock.patch.object(crq, "denylist_rules", return_value=[{"id": "fixture", "regex": "fixture-denied-marker"}]), \
             mock.patch.object(crq.shutil, "which", return_value=None):
            with self.assertRaisesRegex(author_quota.AuthorRefused, "secret scan"):
                snapshot.install(req["snapshot"], req["binding"], crq)
        self.assertEqual(snapshot.git(self.destination, "for-each-ref", "refs/crq/"), b"")


    def install_refused(self, tree, pattern):
        req = envelope(self.repo, self.base, tree)
        with mock.patch.object(crq, "CLONE", self.destination), \
             mock.patch.object(crq, "denylist_rules", return_value=[{"id": "fixture", "regex": "(?!)"}]), \
             mock.patch.object(crq, "secret_scan_diff", return_value=(True, {})):
            with self.assertRaisesRegex(author_quota.AuthorRefused, pattern):
                snapshot.install(req["snapshot"], req["binding"], crq)
        self.assertEqual(snapshot.git(self.destination, "for-each-ref", "refs/crq/"), b"")

    def test_regular_mode_entry_naming_a_tree_object_is_refused(self):
        inner = self.git("mktree", data=f"100644 blob {self.git('hash-object', '-w', '--stdin', data=b'x')}\ta\n".encode())
        # ls-tree labels by mode, so a hash-valid 100644 entry naming a tree reads as a blob.
        crafted = self.git("hash-object", "-w", "-t", "tree", "--stdin",
                           data=b"100644 f\0" + bytes.fromhex(inner))
        self.install_refused(crafted, "mode disagrees with object type")

    def test_unrepresentable_symlink_targets_are_refused(self):
        for contents in (b"", b"target\0truncated"):
            blob = self.git("hash-object", "-w", "--stdin", data=contents)
            tree = self.git("mktree", data=f"120000 blob {blob}\tlink\n".encode())
            with self.subTest(contents=contents):
                self.install_refused(tree, "symlink target")

    def test_install_batches_object_writes_per_type(self):
        files = [(f"f{i}.txt", self.git("hash-object", "-w", "--stdin", data=b"blob %d\n" % i))
                 for i in range(40)]
        tree = self.git("mktree", data="".join(f"100644 blob {oid}\t{name}\n" for name, oid in files).encode())
        req = envelope(self.repo, self.base, tree)
        calls = []
        real = snapshot.git
        def counting(repo, *args, **kwargs):
            calls.append(args)
            return real(repo, *args, **kwargs)
        with mock.patch.object(crq, "CLONE", self.destination), \
             mock.patch.object(snapshot, "git", counting), \
             mock.patch.object(crq, "denylist_rules", return_value=[{"id": "fixture", "regex": "(?!)"}]), \
             mock.patch.object(crq, "secret_scan_diff", return_value=(True, {})):
            snapshot.install(req["snapshot"], req["binding"], crq)
        writes = [args for args in calls if args[0] == "hash-object"]
        self.assertLessEqual(len(writes), 6)  # <=3 types, quarantine + clone
        self.assertTrue(all("--stdin-paths" in args for args in writes))
        self.assertEqual(snapshot.git(self.destination, "cat-file", "-t", req["binding"]["head"]).strip(), b"commit")

    def test_blob_reused_from_base_is_scanned_at_its_new_path(self):
        blob = self.git("rev-parse", f"{self.base}:file.txt")
        tree = self.git("mktree", data=f"100644 blob {blob}\tcopy.txt\n100644 blob {blob}\tfile.txt\n".encode())
        req = envelope(self.repo, self.base, tree)
        self.assertFalse(any(obj["type"] == "blob" for obj in req["snapshot"]["objects"]))
        rules = [{"id": "fixture", "regex": "baseline", "path": r"^copy\.txt$"}]
        with mock.patch.object(crq, "CLONE", self.destination), \
             mock.patch.object(crq, "denylist_rules", return_value=rules), \
             mock.patch.object(crq, "secret_scan_diff", return_value=(True, {})):
            with self.assertRaisesRegex(author_quota.AuthorRefused, "secret scan"):
                snapshot.install(req["snapshot"], req["binding"], crq)
        self.assertEqual(snapshot.git(self.destination, "for-each-ref", "refs/crq/"), b"")

    def test_paths_that_cannot_be_checked_out_are_refused(self):
        blob = self.git("hash-object", "-w", "--stdin", data=b"x\n")
        tree = self.git("mktree", data=f"100644 blob {blob}\t{'n' * 300}\n".encode())
        self.install_refused(tree, "too long to check out")

    def test_install_stores_exact_bytes_despite_clean_filters(self):
        self.git("-C", str(self.destination), "config", "core.autocrlf", "true")
        blob = self.git("hash-object", "-w", "--stdin", data=b"a\r\nb\r\n")
        tree = self.git("mktree", data=f"100644 blob {blob}\tcrlf.txt\n".encode())
        req = envelope(self.repo, self.base, tree)
        with mock.patch.object(crq, "CLONE", self.destination), \
             mock.patch.object(crq, "denylist_rules", return_value=[{"id": "fixture", "regex": "(?!)"}]), \
             mock.patch.object(crq, "secret_scan_diff", return_value=(True, {})):
            snapshot.install(req["snapshot"], req["binding"], crq)
        self.assertEqual(snapshot.git(self.destination, "cat-file", "blob", blob), b"a\r\nb\r\n")

    def test_unchanged_baseline_blobs_are_not_read(self):
        unchanged = self.git("rev-parse", f"{self.base}:file.txt")
        added = self.git("hash-object", "-w", "--stdin", data=b"new\n")
        tree = self.git("mktree", data=(f"100644 blob {added}\tadded.txt\n"
                                       f"100644 blob {unchanged}\tfile.txt\n").encode())
        req = envelope(self.repo, self.base, tree)
        seen = []
        real = snapshot.read_blobs
        def spy(repo, oids):
            seen.extend(oids)
            return real(repo, oids)
        with mock.patch.object(crq, "CLONE", self.destination), mock.patch.object(snapshot, "read_blobs", spy), \
             mock.patch.object(crq, "denylist_rules", return_value=[{"id": "fixture", "regex": "(?!)"}]), \
             mock.patch.object(crq, "secret_scan_diff", return_value=(True, {})):
            snapshot.install(req["snapshot"], req["binding"], crq)
        self.assertNotIn(unchanged, seen)
