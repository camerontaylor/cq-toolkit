"""The inventory fact index is disposable: misses never block, hits are verified."""
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

import backfill_cache
import review_ledger as ledger


class CacheTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(); self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.store = ledger.ArtifactStore(self.root / "artifacts")
        self.cache = backfill_cache.Cache(self.root / "index", self.store)

    def test_round_trip_and_identity_binding(self):
        self.assertIsNone(self.cache.get("blame", {"target": "a" * 40}))
        self.cache.put("blame", {"target": "a" * 40}, [[1, 2]])
        self.assertEqual(self.cache.get("blame", {"target": "a" * 40}), [[1, 2]])
        self.assertIsNone(self.cache.get("blame", {"target": "b" * 40}))
        self.assertIsNone(self.cache.get("carry", {"target": "a" * 40}))

    def test_version_bump_invalidates(self):
        self.cache.put("lineage", {"old": "x"}, {"path": "a"})
        with mock.patch.object(backfill_cache, "VERSION", backfill_cache.VERSION + 1):
            self.assertIsNone(self.cache.get("lineage", {"old": "x"}))

    def test_corrupt_index_or_tampered_artifact_is_a_miss(self):
        self.cache.put("lineage", {"old": "x"}, {"path": "a"})
        index = next((self.root / "index/facts/lineage").glob("*.json"))
        reference = ledger.loads(index.read_bytes())
        artifact = Path(reference["location"])
        os.chmod(artifact, 0o644)
        artifact.write_bytes(ledger.canonical({"key": "forged", "value": {"path": "b"}}))
        self.assertIsNone(self.cache.get("lineage", {"old": "x"}))
        index.write_bytes(b"not json")
        self.assertIsNone(self.cache.get("lineage", {"old": "x"}))

    def test_index_write_failure_is_tolerated(self):
        real = ledger.atomic
        def atomic(filename, data):
            if Path(filename).is_relative_to(self.root / "index"):
                raise OSError("read-only index")
            return real(filename, data)
        with mock.patch.object(ledger, "atomic", side_effect=atomic):
            self.cache.put("lineage", {"old": "x"}, {"path": "a"})
        self.assertTrue(list((self.root / "artifacts/sha256").iterdir()))
        self.assertIsNone(self.cache.get("lineage", {"old": "x"}))

    def test_namespace_must_be_an_identifier(self):
        with self.assertRaises(ValueError):
            self.cache.put("../escape", {}, 1)


if __name__ == "__main__":
    unittest.main()
