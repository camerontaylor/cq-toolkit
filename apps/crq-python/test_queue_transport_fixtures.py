"""Q3 fixtures use fake forge/runner effects only; no vendor or credentials.

Split provenance: apps/crq-python/test_queue_transport.py was split by subject
into test_queue_transport_<subject>.py modules. This file holds the shared
fixture surface (no TestCase subclasses) those modules import.
"""
import copy
import json
import sys
import tempfile
from unittest import mock
from pathlib import Path

# This entire fixture module needs no child processes, including local Git.
# Audit events cover absolute executables, shell/executable kwargs and aliases
# captured before a mock could replace subprocess.Popen or os process helpers.
_process_boundary_active = False


def _deny_processes(event, args):
    if _process_boundary_active and event in {
            "subprocess.Popen", "os.system", "os.exec", "os.posix_spawn",
            "os.spawn", "os.fork", "os.forkpty", "pty.spawn"}:
        raise AssertionError("offline queue fixture forbids child processes")


sys.addaudithook(_deny_processes)


def setUpModule():
    global _process_boundary_active
    _process_boundary_active = True


def tearDownModule():
    global _process_boundary_active
    _process_boundary_active = False


import crq
import merged_reconcile as reconcile
import queue_transport as transport
import review_receipt as receipts


class QueueTransportFixtureMixin:
    """Shared state, request helper and fixtures for the split test modules."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.q = {"items": []}
        self.b = {"kind": "deferred-author", "repo": "owner/repo", "producer": "cycle-1",
                  "head": "a" * 40, "target": "merge-queue", "targetSelector": "promoted-main"}
        self.policy = {"enabled": True, "repo": "owner/repo", "targets": ["promoted-main"],
                       "branches": ["merge-queue"], "read": ["developer"], "write": ["developer"]}
        self.forge = {"repo": "owner/repo", "pr": 12, "producer": "cycle-1", "head": "a" * 40,
                      "target": "merge-queue", "state": "MERGED", "mergeSha": "b" * 40}
        class Runner:
            def load_queue(inner): return copy.deepcopy(self.q)
            def save_queue(inner, q): self.q = copy.deepcopy(q)
            def iso(inner): return "2026-10-28T00:00:00Z"
            def with_lock(inner, fn): return fn()
        self.runner = Runner()

    def call(self, op, **extra):
        req = {"v": 1, "op": op, "requestId": getattr(self, "request_id", "request-1"), "binding": self.b, **extra}
        raw = transport.handle(receipts.canonical(req), self.runner, principal="developer",
                               policy=self.policy, verify_source=lambda repo, pr: self.forge,
                               receipt_root=self.tmp.name)
        self.assertLessEqual(len(raw), 8192)
        return json.loads(raw)["result"]

    def merged(self):
        self.call("enqueue")
        self.call("bind", pr=12, mergeSha="b" * 40)
        return self.q["items"][0]

    def receipt(self):
        item = self.merged()
        doc = {"version": 1, "source": item["subject"], "capture": {"target_sha": "c" * 40,
               "target_tree": "d" * 40, "paths": [{"path": "src/a.ts", "disposition": "included"}]},
               "classification": {"counted": True, "outcome": "completed"}, "counted": True, "outcome": "terminal-with-findings",
               "findings": [{"text": "large finding " * 3000}], "artifacts": {},
               "remediation": {"enabled": False}}
        rid = receipts.write_receipt(self.tmp.name, doc)
        item.update(state="done", receipt_id=rid)
        return rid, doc

    def reconciled_fixture(self):
        # Synthetic PR #506 in the Oct27-Oct30 inventory; no live queue data.
        self.b = {"kind": "merged-current", "repo": "owner/repo", "pr": 506,
                  "mergeSha": "b" * 40, "targetSelector": "promoted-main"}
        self.forge["pr"] = 506
        inventory = reconcile.reconcile(None, lambda cursor: {
            "records": [{"number": 506, "mergedAt": "2026-10-28T00:00:00Z",
                         "mergeCommit": {"oid": "b" * 40}, "headRefOid": "a" * 40}],
            "has_next_page": False, "next_cursor": None}, repo="owner/repo",
            after="2026-10-27T00:00:00Z", before="2026-10-30T00:00:00Z", page_budget=1)
        self.request_id = reconcile.enrollment_plan(inventory, repo="owner/repo")["entries"][0]["request_id"]
        item = receipts.enroll(self.q, repo="owner/repo", pr=506, merge_sha="b" * 40,
                               request_id=self.request_id, at="2026-10-28T00:00:00Z")["item"]
        self.policy["reconciled_reads"] = [
            {"principal": "developer", "requestId": self.request_id, "binding": copy.deepcopy(self.b)}]
        return item

    def inventory_fixture(self):
        self.reconciled_fixture()
        self.runner.STATE = Path(self.tmp.name)
        interval = {"after": "2026-10-27T00:00:00Z", "before": "2026-10-31T00:00:00Z"}
        self.inventory_scope = {"repo": "owner/repo", "targetSelector": "promoted-main", **interval}
        self.policy["inventory_reads"] = [{"principal": "developer", "binding": self.inventory_scope}]
        cp = reconcile.reconcile(None, lambda cursor: {
            "records": [{"number": pr, "mergedAt": "2026-10-28T00:00:00Z",
                         "mergeCommit": {"oid": "b" * 40}, "headRefOid": "a" * 40}
                        for pr in (506, 504, 512)],
            "has_next_page": False, "next_cursor": None},
            repo="owner/repo", base=transport.DISCOVERY_SELECTOR, **interval, page_budget=1)
        key = receipts.digest({"repo": "owner/repo", "base": transport.DISCOVERY_SELECTOR, **interval})
        path = self.runner.STATE / "reconcile" / (key + ".json")
        path.parent.mkdir()
        source = {"version": 1, "method": "all-number-slots-v1", "repo": "owner/repo",
                  "base": transport.DISCOVERY_SELECTOR, "repository_id": "synthetic-repository",
                  "ceiling": 512, "window": reconcile.NUMBER_WINDOW}
        wrapper = {"source": source, "checkpoint": cp}
        wrapper["digest"] = receipts.digest(wrapper)
        path.write_text(json.dumps(wrapper))
        def read(path, interval, budget):
            with mock.patch.object(crq, "REPO", "owner/repo"):
                return crq._read_reconcile_wrapper(path, interval, budget)
        self.runner._read_reconcile_wrapper = read
        return path

    def inventory_call(self, **extra):
        req = {"v": 1, "op": "inventory", "requestId": "inventory-1",
               "binding": self.inventory_scope, "cursor": None, "limit": 1, "states": None, **extra}
        return json.loads(transport.handle(receipts.canonical(req), self.runner, principal="developer",
            policy=self.policy, verify_source=None, receipt_root=self.tmp.name))["result"]

    def malformed_policies(self):
        for enabled in ("false", "true", 1, -1, 0, 1.0, None, {}, {"enabled": True}, [], [True]):
            yield {**self.policy, "enabled": enabled}
        for key in ("read", "write", "targets", "branches"):
            for value in ("developer", {"developer": True}, True, 1, None, [None], [1], [[]], [""]):
                yield {**self.policy, key: value}
        for value in (None, [], "policy", True, 1):
            yield value
        for patch in ({"repo": ["owner/repo"]}, {"targets": ["HEAD"]},
                      {"max_requests": True}, {"max_requests": "10000"}):
            yield {**self.policy, **patch}

    def retry_fixture(self):
        self.b = {"kind": "merged-current", "repo": "owner/repo", "pr": 12,
                  "mergeSha": "b" * 40, "targetSelector": "promoted-main"}
        self.call("enqueue")
        item = self.q["items"][0]
        doc = {"source": item["subject"], "outcome": "rate_limited", "counted": False, "classification": {
            "outcome": "rate_limited", "counted": False, "exit": 1, "bad_lines": 0,
            "failure_provenance": {"version": 1, "complete": True, "causes": [
                {"source": "vendor", "category": "vendor-rate-limited", "code": "rate_limit"}]}}}
        receipt = receipts.write_receipt(self.tmp.name, doc)
        item.update(state="blocked", receipt_id=receipt, run=None,
                    attempts=[{"run_id": "run-1", "receipt_id": receipt, "counted": False}])
        self.runner.read_pidfile = lambda path: {"pid": 123}
        self.runner.RUNS = Path(self.tmp.name)
        (self.runner.RUNS / "run-1").mkdir(exist_ok=True)
        (self.runner.RUNS / "run-1" / "exit.json").write_text('{"exit":1}')
        self.runner.run_liveness = lambda *args: "harvest"
        self.policy["transient_retries"] = [{"principal": "developer", "requestId": "request-1", "binding": self.b}]
        return receipt

    def failed_attempt(self, events, exit_code):
        self.q = {"items": []}
        self.retry_fixture()
        stream = Path(self.tmp.name) / "fixture.ndjson"
        stream.write_text(events)
        cls = crq.classify(stream, exit_code)
        item = self.q["items"][0]
        doc = {"source": item["subject"], "outcome": cls["outcome"], "counted": cls["counted"], "classification": cls}
        receipt = receipts.write_receipt(self.tmp.name, doc)
        item["receipt_id"] = receipt
        item["attempts"][-1]["receipt_id"] = receipt
        return receipt, doc

    def assert_retry_document_refused(self, doc):
        item = self.q["items"][0]
        receipt = receipts.write_receipt(self.tmp.name, doc)
        item["receipt_id"] = receipt
        item["attempts"][-1]["receipt_id"] = receipt
        before = copy.deepcopy(self.q)
        self.assertEqual(self.call("retry", expectedReceiptId=receipt)["action"], "needs-human")
        self.assertEqual(self.q, before)

    def alias_fixture(self):
        # The original is enrolled directly by Q1, without a queue-client principal.
        item = receipts.enroll(self.q, repo="owner/repo", pr=12, merge_sha="b" * 40,
                               request_id="original-1", at=self.runner.iso())["item"]
        paths = [{"source_path": "a.ts", "path": "a.ts", "resolution": "same-path-current",
                  "disposition": "included", "blob": "a" * 40, "mode": "100644", "bytes": 20}]
        capture = {"target": "c" * 40, "tree": "d" * 40, "paths": paths,
                   "scope_digest": receipts.digest(paths), "policy": receipts.POLICY,
                   "projection": "current-affected-files/full-file-addition-projection",
                   "reviewer": "coderabbit-review-agent-committed-v1", "reviewer_version": "fixture"}
        capture["equivalence"] = receipts.current_equivalence(capture)
        doc = {"version": 1, "item_id": item["id"], "request_id": "original-1",
               "source": copy.deepcopy(item["subject"]), "capture": copy.deepcopy(capture),
               "outcome": "terminal-with-findings", "counted": True,
               "classification": {"counted": True, "outcome": "completed"},
               "findings": [{"severity": "major", "text": "retained " * 1500}]}
        item.update(state="done", capture=capture, receipt_id=receipts.write_receipt(self.tmp.name, doc))
        self.call("enqueue")
        self.call("bind", pr=12, mergeSha="b" * 40)
        return doc


def bridge(root, raw):
    """Cross-language offline SDK fixture; each request restarts the server process.

    fixture-tick is a test-only natural-runner stand-in; never a wire operation.
    It publishes Q1 receipt bytes without a provider or remote host.
    """
    root = Path(root)
    queue_path = root / "queue.json"
    q = json.loads(queue_path.read_text()) if queue_path.exists() else {"items": []}
    if raw == b"fixture-tick":
        import crq
        fixture = json.loads((root / "fixture-document.json").read_text())
        item = q["items"][0]
        item["capture"] = fixture["capture"]
        rdir = root / "fixture-run"
        rdir.mkdir(exist_ok=True)
        (rdir / "review.ndjson").write_text("\n".join(
            json.dumps({"type": "finding", **finding}) for finding in fixture["findings"]))
        document = crq.current_document(item, fixture["outcome"],
            meta={"run_id": fixture["run_id"], "started_at": fixture["started_at"]},
            cls=fixture["classification"], rdir=rdir)
        receipt_id = receipts.write_receipt(root / "receipts", document)
        q["items"][0].update(state="done", receipt_id=receipt_id)
        queue_path.write_bytes(receipts.canonical(q))
        return b"{}"
    class Runner:
        def load_queue(self): return q
        def save_queue(self, value): queue_path.write_bytes(receipts.canonical(value))
        def iso(self): return "2026-10-28T00:00:00Z"
        def with_lock(self, fn):
            import fcntl
            with (root / "tick.lock").open("a") as lock:
                fcntl.flock(lock, fcntl.LOCK_EX)
                return fn()
    policy = {"enabled": True, "repo": "owner/repo", "targets": ["promoted-main"],
              "branches": ["merge-queue"], "read": ["developer"], "write": ["developer"]}
    return transport.handle(raw, Runner(), principal="developer", policy=policy,
        verify_source=lambda repo, pr: {"repo": repo, "pr": pr, "target": "merge-queue", "state": "MERGED", "mergeSha": "b" * 40},
        receipt_root=root / "receipts")
