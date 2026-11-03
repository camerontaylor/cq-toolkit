"""Author-snapshot install: write batching, scan scoping and byte fidelity.

Split provenance: apps/crq-python/test_author_snapshot.py was split by subject
into test_author_snapshot_plan.py, test_author_snapshot_enroll.py,
test_author_snapshot_payload.py, test_author_snapshot_install.py and
test_author_snapshot_launch.py; shared fixtures live in
test_author_snapshot_fixtures.py.
"""
import unittest
from unittest import mock

import author_quota
import author_snapshot as snapshot
import crq
from test_author_snapshot_fixtures import SnapshotTransportFixture, envelope


class SnapshotTransport(SnapshotTransportFixture, unittest.TestCase):
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

    def test_unchanged_baseline_paths_are_not_rescanned(self):
        added = self.git("hash-object", "-w", "--stdin", data=b"new\n")
        unchanged = self.git("rev-parse", f"{self.base}:file.txt")
        tree = self.git("mktree", data=(f"100644 blob {added}\tadded.txt\n"
                                       f"100644 blob {unchanged}\tfile.txt\n").encode())
        req = envelope(self.repo, self.base, tree)
        # A rule matching only the unchanged base path must not refuse a snapshot that leaves it alone.
        with mock.patch.object(crq, "CLONE", self.destination), \
             mock.patch.object(crq, "denylist_rules", return_value=[{"id": "fixture", "regex": r"^file\.txt$"}]), \
             mock.patch.object(crq, "secret_scan_diff", return_value=(True, {})):
            snapshot.install(req["snapshot"], req["binding"], crq)

    def test_scan_bound_counts_part_separators(self):
        blobs = [self.git("hash-object", "-w", "--stdin", data=(b"line %d\n" % i) * 100) for i in range(3)]
        tree = self.git("mktree", data="".join(f"100644 blob {oid}\tf{i}.txt\n" for i, oid in enumerate(blobs)).encode())
        req = envelope(self.repo, self.base, tree)
        scanned = []
        def capture(text, *args, **kwargs):
            scanned.append(text)
            return True, {}
        def run(limit):
            with mock.patch.object(crq, "CLONE", self.destination), mock.patch.object(snapshot, "MAX_WIRE", limit), \
                 mock.patch.object(crq, "denylist_rules", return_value=[{"id": "fixture", "regex": "(?!)"}]), \
                 mock.patch.object(crq, "secret_scan_diff", capture):
                snapshot.install(req["snapshot"], req["binding"], crq)
        run(snapshot.MAX_WIRE)
        exact = len(scanned[0].encode())
        run(exact)  # the real joined input fits exactly at its own length
        with self.assertRaisesRegex(author_quota.AuthorRefused, "scan exceeds"):
            run(exact - 1)
