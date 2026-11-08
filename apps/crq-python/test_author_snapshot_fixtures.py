"""Shared fixtures for the split author-snapshot characterization suite.

P5 pre-change characterization at promoted P3 57220fd7. Offline Git objects
only: no reviewer, network, signer or real state access. A tree OID passes
legacy shape admission but cannot yet produce a review plan.

Split provenance: apps/crq-python/test_author_snapshot.py was split by subject
into test_author_snapshot_plan.py, test_author_snapshot_enroll.py,
test_author_snapshot_payload.py, test_author_snapshot_install.py and
test_author_snapshot_launch.py. This module holds their shared fixture mixins
and wire helpers; it defines no tests.
"""
import base64
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from unittest import mock

import author_quota
import author_snapshot as snapshot
import author_transport as transport
import crq

AT = "2026-10-17T00:00:00Z"


class SnapshotGitFixture:
    """Offline object graph: a temporary repo, never a caller's Git environment."""

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
            cwd=self.repo, input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True,
            # Never follow a caller's GIT_DIR, GIT_WORK_TREE or GIT_INDEX_FILE.
            env={k: v for k, v in os.environ.items() if not k.startswith("GIT_")}).stdout.decode().strip()

    def tree(self, contents):
        blob = self.git("hash-object", "-w", "--stdin", data=contents)
        return self.git("mktree", data=f"100644 blob {blob}\tfile.txt\n".encode())

    def commit(self, tree, parent=None):
        return self.git("commit-tree", tree, *(["-p", parent] if parent else []), data=b"fixture\n")

    def enroll(self, head):
        return author_quota.enroll(self.q, request_id="snapshot-baseline", base=self.base,
                                  head=head, target="origin/merge-queue", cycle=1, at=AT)["item"]


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


class SnapshotTransportFixture(SnapshotGitFixture):
    """Admitted-snapshot transport: real queue writes on the offline object graph."""

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

    def seed_live_denylist(self):
        """Put the repository's real policy behind an offline ref for crq.denylist_rules()."""
        policy = Path(__file__).resolve().parents[2] / "policy/denylist/patterns.yml"
        blob = self.git("-C", str(self.destination), "hash-object", "-w", "--stdin", data=policy.read_bytes())
        tree = self.git("-C", str(self.destination), "mktree", data=f"100644 blob {blob}\tpatterns.yml\n".encode())
        for directory in ("denylist", "policy"):
            tree = self.git("-C", str(self.destination), "mktree", data=f"040000 tree {tree}\t{directory}\n".encode())
        commit = self.git("-C", str(self.destination), "commit-tree", tree, data=b"live policy fixture\n")
        ref = "refs/heads/denylist-policy"
        self.git("-C", str(self.destination), "update-ref", ref, commit)
        return ref

    def call(self, request=None):
        return json.loads(transport_fixture(self.destination, self.state, json.dumps(request or self.request).encode()))

    def install_refused(self, tree, pattern):
        req = envelope(self.repo, self.base, tree)
        with mock.patch.object(crq, "CLONE", self.destination), \
             mock.patch.object(crq, "denylist_rules", return_value=[{"id": "fixture", "regex": "(?!)"}]), \
             mock.patch.object(crq, "secret_scan_diff", return_value=(True, {})):
            with self.assertRaisesRegex(author_quota.AuthorRefused, pattern):
                snapshot.install(req["snapshot"], req["binding"], crq)
        self.assertEqual(snapshot.git(self.destination, "for-each-ref", "refs/crq/"), b"")
