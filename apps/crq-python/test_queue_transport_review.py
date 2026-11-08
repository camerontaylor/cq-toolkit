"""Offline queue-identity admission and original snapshot transport."""
import base64
import copy
import hashlib
import json
import io
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest import mock

import author_snapshot
import capability_dispatcher
import crq
import review_receipt
import review_transport as transport
from test_author_snapshot_fixtures import SnapshotTransportFixture


class ReviewTransportTests(SnapshotTransportFixture, unittest.TestCase):
    def setUp(self):
        super().setUp()
        self.policy = dict(repo="camerontaylor/cq-toolkit", enabled=True,
                           write=["queue-client"], branches=["main"])
        self.saved = copy.deepcopy(self.q)
        self.runner = SimpleNamespace(CLONE=self.destination, STATE=self.state,
            WT_ROOT=self.state / "worktrees", REPO=self.policy["repo"], CONFIG={},
            ALLOWLIST_PATHS=[], denylist_rules=lambda: [{"regex": "(?!)"}],
            secret_scan_diff=lambda *a, **kw: (True, {}),
            load_queue=lambda: copy.deepcopy(self.saved),
            save_queue=self.save, iso=lambda: "2026-11-08T00:00:00Z")
        ids = sorted(self.git("rev-list", "--objects", "--no-object-names", self.head, "^" + self.base).split())
        objects, digest = [], hashlib.sha256()
        for oid in ids:
            kind = self.git("cat-file", "-t", oid)
            data = base64.b64encode(author_snapshot.git(self.repo, "cat-file", kind, oid)).decode()
            objects.append(dict(oid=oid, type=kind, data=data))
            digest.update((oid + "\0" + kind + "\0" + data + "\n").encode())
        self.review = dict(v=1, op="submit", request_id="local-1",
            inputs=dict(repo=self.policy["repo"], target="main", base_commit=self.base,
                        base_tree=self.base_tree, head_commit=self.head,
                        head_tree=self.changed_tree, projection="full-diff"),
            snapshot=dict(v=1, tree=self.changed_tree, objects=objects, sha256=digest.hexdigest()))

    def save(self, q):
        self.saved = copy.deepcopy(q)

    def call_review(self, req):
        return json.loads(transport.handle(json.dumps(req).encode(), self.runner,
                                          principal="queue-client", policy=self.policy))

    def test_original_commit_install_retry_before_new_profile_and_result(self):
        result = self.call_review(self.review)
        self.assertEqual(result["action"], "created")
        self.assertEqual(self.saved["items"][0]["identity_inputs"]["head_commit"], self.head)
        self.assertEqual(author_snapshot.git(self.destination, "cat-file", "commit", self.head),
                         author_snapshot.git(self.repo, "cat-file", "commit", self.head))
        self.runner.CONFIG = {"local_review_profile": {"revision": "new-profile"}}
        self.review.pop("snapshot")
        again = self.call_review(self.review)
        self.assertEqual(again["identity"], result["identity"])
        self.assertEqual(len(self.saved["items"]), 1)
        item = self.saved["items"][0]
        item.update(state="done", scope_adequate=True,
                    receipt_id=review_receipt.write_receipt(self.state / "receipts", {"report": "a" * 7000}))
        parts = []
        index = 0
        while index is not None:
            chunk = self.call_review(dict(v=1, op="result", request_id="local-1", index=index))
            parts.append(base64.b64decode(chunk["data"]))
            index = chunk["next_index"]
        self.assertEqual(hashlib.sha256(b"".join(parts)).hexdigest(), item["receipt_id"])

    def test_queue_policy_and_primary_repo_only(self):
        self.policy["write"] = []
        with self.assertRaisesRegex(ValueError, "principal"):
            self.call_review(self.review)
        self.policy["write"] = ["queue-client"]
        self.review["inputs"]["repo"] = "other/repo"
        self.assertEqual(self.call_review(self.review)["reason"], "unsupported-repo")
        self.assertEqual(self.saved["items"], [])

    def test_six_mib_reader_and_additive_dispatch(self):
        raw = b'{"v":1,"op":"capabilities"}'
        self.assertEqual(transport.decode(raw + b" " * (transport.MAX_BYTES - len(raw)))["op"], "capabilities")
        with self.assertRaisesRegex(ValueError, "6 MiB"):
            transport.decode(raw + b" " * transport.MAX_BYTES)
        self.assertEqual(capability_dispatcher.dispatch("review-v1", None, None, lambda: "review"), "review")
        self.assertEqual(capability_dispatcher.dispatch("author-v1", lambda: "legacy", None), "legacy")

    def test_conflicting_retry_and_tamper_refuse_without_queue_mutation(self):
        self.call_review(self.review)
        before = copy.deepcopy(self.saved)
        self.review["inputs"]["head_tree"] = "f" * 40
        with self.assertRaisesRegex(ValueError, "different inputs"):
            self.call_review(self.review)
        self.assertEqual(before, self.saved)

    def test_notify_is_persisted_before_response(self):
        destination = dict(paseo_agent_id="08e32e05-647c-4bbf-be31-2a6aeaec0654", paseo_host="triton")
        self.review["notify"] = destination
        self.call_review(self.review)
        self.assertEqual(self.saved["review_requests"]["local-1"]["notify"], destination)

    def test_fresh_claimed_tree_mismatches_refuse_without_mutation(self):
        self.call_review(self.review)  # install objects first
        before = copy.deepcopy(self.saved)
        self.review.pop("snapshot")
        for end in ("base", "head"):
            req = copy.deepcopy(self.review)
            req["request_id"] = "wrong-" + end
            req["inputs"][end + "_tree"] = "f" * 40
            with self.assertRaisesRegex(ValueError, "claimed commit/tree mismatch"):
                self.call_review(req)
            self.assertEqual(self.saved, before)

    def test_missing_corrupt_or_wrong_identity_receipts_offer_resubmit(self):
        self.call_review(self.review)
        vectors = json.loads((Path(__file__).parent / "fixtures/review-operation/vectors.json").read_text())
        doc = copy.deepcopy(next(r["value"] for r in vectors if r["name"] == "full-diff-receipt"))
        item = self.saved["items"][0]
        doc.update(identity=item["identity"], identity_inputs=item["identity_inputs"], profile=item["profile"])
        item.update(state="done", scope_adequate=True)
        for case in ("valid", "missing", "corrupt", "wrong-identity"):
            item = self.saved["items"][0]
            value = copy.deepcopy(doc)
            if case == "wrong-identity": value["identity"] = "f" * 64
            item["receipt_id"] = review_receipt.write_receipt(self.state / "receipts", value)
            path = self.state / "receipts" / (item["receipt_id"] + ".json")
            if case == "missing": path.unlink()
            if case == "corrupt": path.write_text("{}")
            req = copy.deepcopy(self.review)
            req.update(request_id="reuse-" + case)
            req.pop("snapshot")
            result = self.call_review(req)
            if case == "valid": self.assertEqual(result["action"], "reused")
            else:
                self.assertEqual(result["action"], "observed")
                self.assertEqual(result["next_action"], "resubmit")
            # Restore bytes for the next independently exercised corruption.
            if path.exists(): path.unlink()

    def invoke_main(self, req, supervision):
        raw = req if isinstance(req, bytes) else json.dumps(req).encode()
        out = io.BytesIO()
        policy = self.state / "queue-policy.json"
        policy.write_text(json.dumps(self.policy))
        with mock.patch.dict("os.environ", CRQ_QUEUE_POLICY=str(policy), CRQ_QUEUE_PRINCIPAL="queue-client"), \
             mock.patch.dict("sys.modules", crq=self.runner), \
             mock.patch.object(transport.sys, "stdin", SimpleNamespace(buffer=io.BytesIO(raw))), \
             mock.patch.object(transport.sys, "stdout", SimpleNamespace(buffer=out)), \
             mock.patch("author_transport.supervised", side_effect=supervision):
            self.assertEqual(transport.main(), 0)
        return json.loads(out.getvalue())

    def test_main_returns_typed_errors_and_reads_without_lock(self):
        def no_lock(*a): raise AssertionError("read acquired tick.lock")
        cap = self.invoke_main(dict(v=1, op="capabilities"), no_lock)
        self.assertLess(cap["limits"]["max_snapshot_bytes"], cap["limits"]["max_request_bytes"])
        busy = self.invoke_main(self.review, lambda *a: None)
        self.assertEqual(busy["error"]["code"], "busy")
        self.assertTrue(busy["error"]["retryable"])
        oversized = self.invoke_main(b" " * (transport.MAX_BYTES + 1), no_lock)
        self.assertIn("6 MiB", oversized["error"]["message"])
        invalid = copy.deepcopy(self.review)
        invalid["snapshot"]["sha256"] = "f" * 64
        refused = self.invoke_main(invalid, lambda work, runner: work(runner))
        self.assertEqual(refused["error"]["code"], "snapshot-refused")
        self.call_review(self.review)
        self.invoke_main(dict(v=1, op="status", request_id="local-1"), no_lock)
        item = self.saved["items"][0]
        item["receipt_id"] = review_receipt.write_receipt(self.state / "receipts", {"report": "clean"})
        self.assertIn("data", self.invoke_main(dict(v=1, op="result", request_id="local-1"), no_lock))

    def test_snapshot_cap_is_enforced_inside_request_bound(self):
        req = copy.deepcopy(self.review)
        req["snapshot"]["objects"][0]["data"] = "A" * transport.MAX_SNAPSHOT_BYTES
        raw = json.dumps(req).encode()
        self.assertLess(len(raw), transport.MAX_BYTES)
        with self.assertRaisesRegex(ValueError, "5 MiB"):
            transport.decode(raw)

    def test_empty_original_commit_reaches_no_changes(self):
        head = self.commit(self.base_tree, self.base)
        data = base64.b64encode(author_snapshot.git(self.repo, "cat-file", "commit", head)).decode()
        obj = dict(oid=head, type="commit", data=data)
        checksum = hashlib.sha256((head + "\0commit\0" + data + "\n").encode()).hexdigest()
        self.review["inputs"].update(head_commit=head, head_tree=self.base_tree)
        self.review["snapshot"] = dict(v=1, tree=self.base_tree, objects=[obj], sha256=checksum)
        self.assertEqual(self.call_review(self.review)["action"], "no-changes")

    def test_historical_secret_deleted_before_head_is_scanned_before_install(self):
        blob = self.git("hash-object", "-w", "--stdin", data=b"historical-secret-marker\n")
        tree = self.git("mktree", data=f"100644 blob {blob}\tsecret.env\n".encode())
        intermediate = self.commit(tree, self.base)
        head = self.commit(self.changed_tree, intermediate)
        ids = sorted(self.git("rev-list", "--objects", "--no-object-names", head, "^" + self.base).split())
        objects, digest = [], hashlib.sha256()
        for oid in ids:
            kind = self.git("cat-file", "-t", oid)
            data = base64.b64encode(author_snapshot.git(self.repo, "cat-file", kind, oid)).decode()
            objects.append(dict(oid=oid, type=kind, data=data))
            digest.update((oid + "\0" + kind + "\0" + data + "\n").encode())
        self.review["inputs"]["head_commit"] = head
        self.review["snapshot"] = dict(v=1, tree=self.changed_tree, objects=objects, sha256=digest.hexdigest())
        self.runner.denylist_rules = lambda: [{"regex": "historical-secret-marker", "path": "^secret\\.env$"}]
        with self.assertRaisesRegex(author_snapshot.AuthorRefused, "snapshot secret scan refused"):
            self.call_review(self.review)
        self.assertEqual(self.saved["items"], [])
        self.assertEqual(author_snapshot.git(self.destination, "for-each-ref", "refs/crq/"), b"")
    def test_lost_response_after_admission_persist_retries_without_reinstall(self):
        real_save = self.runner.save_queue
        def crash(q):
            real_save(q)
            raise OSError("response lost after persist")
        self.runner.save_queue = crash
        with self.assertRaisesRegex(OSError, "response lost"):
            self.call_review(self.review)
        self.runner.save_queue = real_save
        self.runner.CONFIG = {"local_review_profile": {"revision": "changed"}}
        # The replay must return before any new object validation or profile.
        self.review["snapshot"]["sha256"] = "f" * 64
        result = self.call_review(self.review)
        self.assertEqual(result["item"], self.saved["items"][0]["id"])
        self.assertEqual(len(self.saved["items"]), 1)

    def test_real_original_snapshot_through_six_mib_request(self):
        tree = self.tree(b"large fixture line\n" * 100000)
        head = self.commit(tree, self.base)
        ids = sorted(self.git("rev-list", "--objects", "--no-object-names", head, "^" + self.base).split())
        objects, digest = [], hashlib.sha256()
        for oid in ids:
            kind = self.git("cat-file", "-t", oid)
            data = base64.b64encode(author_snapshot.git(self.repo, "cat-file", kind, oid)).decode()
            objects.append(dict(oid=oid, type=kind, data=data))
            digest.update((oid + "\0" + kind + "\0" + data + "\n").encode())
        self.review["inputs"].update(head_commit=head, head_tree=tree)
        self.review["snapshot"] = dict(v=1, tree=tree, objects=objects, sha256=digest.hexdigest())
        raw = json.dumps(self.review).encode()
        self.assertLess(len(raw), transport.MAX_BYTES)
        raw += b" " * (transport.MAX_BYTES - len(raw))
        result = json.loads(transport.handle(raw, self.runner, principal="queue-client", policy=self.policy))
        self.assertEqual(result["action"], "created")
        self.assertEqual(self.saved["items"][0]["identity_inputs"]["head_commit"], head)

    def original_range(self, head, tree, request_id="range"):
        req = copy.deepcopy(self.review)
        objects, digest = [], hashlib.sha256()
        for oid in sorted(self.git("rev-list", "--objects", "--no-object-names", head, "^" + self.base).split()):
            kind = self.git("cat-file", "-t", oid)
            data = base64.b64encode(author_snapshot.git(self.repo, "cat-file", kind, oid)).decode()
            objects.append(dict(oid=oid, type=kind, data=data))
            digest.update((oid + "\0" + kind + "\0" + data + "\n").encode())
        req.update(request_id=request_id, snapshot=dict(v=1, tree=tree, objects=objects, sha256=digest.hexdigest()))
        req["inputs"].update(head_commit=head, head_tree=tree)
        return req

    def test_historical_submodule_and_long_path_do_not_block_clean_head(self):
        blob = self.git("rev-parse", self.base + ":file.txt")
        for name, entry in (("submodule", f"160000 commit {self.base}\tsubmodule\n"),
                            ("long-path", f"100644 blob {blob}\t{'a' * 300}\n")):
            tree = self.git("mktree", data=entry.encode())
            intermediate = self.commit(tree, self.base)
            head = self.commit(self.changed_tree, intermediate)
            self.assertEqual(self.call_review(self.original_range(head, self.changed_tree, name))["action"], "created")
            # The same materialization constraint still applies at HEAD.
            with self.assertRaises(author_snapshot.AuthorRefused):
                self.call_review(self.original_range(intermediate, tree, name + "-head"))

    def test_commit_messages_and_identity_metadata_are_secret_scanned(self):
        self.runner.denylist_rules = lambda: [{"regex": "commit-secret-marker"}]
        for field in ("message", "author", "committer"):
            body = author_snapshot.git(self.repo, "cat-file", "commit", self.head)
            if field == "message":
                body += b"commit-secret-marker\n"
            else:
                body = body.replace((field + " ").encode(), (field + " commit-secret-marker ").encode(), 1)
            head = self.git("hash-object", "-w", "-t", "commit", "--stdin", data=body)
            with self.assertRaisesRegex(author_snapshot.AuthorRefused, "commit metadata secret scan"):
                self.call_review(self.original_range(head, self.changed_tree, field))
        self.assertEqual(self.saved["items"], [])

    def test_plain_original_submit_installs_with_live_policy_and_scans_commit_text(self):
        ref = self.seed_live_denylist()
        self.runner.denylist_rules = crq.denylist_rules
        with mock.patch.multiple(crq, CLONE=self.destination, DEFAULT_REF=ref), \
             mock.patch.object(self.runner, "secret_scan_diff", return_value=(True, {})) as scan:
            rules = crq.denylist_rules()
            self.assertTrue(any(rule.get("path") and rule["regex"] == ".+" for rule in rules))
            self.assertEqual(self.call_review(self.review)["action"], "created")
        commit_text = author_snapshot.git(self.repo, "cat-file", "commit", self.head).decode()
        self.assertIn(commit_text, scan.call_args.args[0])

    def test_live_pathless_secret_rule_refuses_original_commit_message(self):
        ref = self.seed_live_denylist()
        self.runner.denylist_rules = crq.denylist_rules
        marker = "pk-" + "snapshot_fixture_value"
        body = author_snapshot.git(self.repo, "cat-file", "commit", self.head) + marker.encode() + b"\n"
        head = self.git("hash-object", "-w", "-t", "commit", "--stdin", data=body)
        with mock.patch.multiple(crq, CLONE=self.destination, DEFAULT_REF=ref):
            rule = next(r for r in crq.denylist_rules() if r["id"] == "class:route-key-material")
            self.assertNotIn("path", rule)
            self.assertRegex(marker, rule["regex"])
            with self.assertRaisesRegex(author_snapshot.AuthorRefused, "commit metadata secret scan"):
                self.call_review(self.original_range(head, self.changed_tree))
        self.assertEqual(self.saved["items"], [])
        self.assertEqual(author_snapshot.git(self.destination, "for-each-ref", "refs/crq/"), b"")

    def test_path_scoped_catchall_does_not_refuse_original_commit_text(self):
        ref = self.seed_live_denylist()
        with mock.patch.multiple(crq, CLONE=self.destination, DEFAULT_REF=ref):
            rules = crq.denylist_rules()
        self.runner.denylist_rules = lambda: rules + [{"regex": ".+", "path": "^metadata-only$"}]
        self.assertEqual(self.call_review(self.review)["action"], "created")

    def test_original_decoded_content_limit_is_reachable_and_enforced(self):
        limit = transport.capabilities()["limits"]["max_content_bytes"]
        self.assertEqual(limit, 3 * 1024 * 1024)
        self.assertEqual(author_snapshot.MAX_CONTENT, 4 * 1024 * 1024)
        prefix = (f"tree {self.base_tree}\nparent {self.base}\n"
                  "author Fixture <fixture@example.test> 0 +0000\n"
                  "committer Fixture <fixture@example.test> 0 +0000\n\n").encode()
        for size in (limit, limit + 1):
            head = self.git("hash-object", "-w", "-t", "commit", "--stdin", data=prefix + b"x" * (size - len(prefix)))
            req = self.original_range(head, self.base_tree, "limit-" + str(size))
            self.assertLess(len(review_receipt.canonical(req["snapshot"])), transport.MAX_SNAPSHOT_BYTES)
            self.assertLess(len(json.dumps(req).encode()), transport.MAX_BYTES)
            if size == limit:
                self.assertEqual(self.call_review(req)["action"], "no-changes")
            else:
                with self.assertRaisesRegex(author_snapshot.AuthorRefused, "3145728 decoded bytes"):
                    self.call_review(req)
