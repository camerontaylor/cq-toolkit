"""Manual observation charging: append-only evidence and artifact verification.

Split provenance: apps/crq-python/test_author_quota.py was split into
test_author_quota_admission.py, test_author_quota_launch.py,
test_author_quota_runner.py, test_author_quota_crash_recovery.py,
test_author_quota_harvest.py, test_author_quota_tick.py,
test_author_quota_observation.py and test_author_quota_open_cycle.py.
"""
import copy
import datetime as dt
import unittest

from test_author_quota_fixtures import BASE, HEAD, author_quota, crq, empty_queue


class ObservationTest(unittest.TestCase):
    def _manifest(self, **over):
        now = crq.now()
        d = {"request_id": "manual-cycle-1", "base": BASE, "head": HEAD,
             "target": "origin/merge-queue", "cycle": 1,
             "started_at": crq.iso(now - dt.timedelta(minutes=5)),
             "artifacts": [{"path": "/tmp/cycle1.ndjson", "sha256": "e" * 64}]}
        d.update(over)
        return d, now

    def test_charge_is_append_only_never_fabricates_a_cycle(self):
        q = empty_queue()
        items_before = copy.deepcopy(q["items"])
        manifest, now = self._manifest()
        obs = author_quota.normalize_observation(manifest, now=now)
        self.assertFalse(obs["reserved"])
        res = author_quota.charge_observation(q, obs, at=crq.iso(now))
        self.assertTrue(res["charged"])
        self.assertEqual(q["starts"], [obs["started_at"]])  # charged to the rolling hour
        self.assertEqual(q["items"], items_before)          # no item/cycle fabricated
        self.assertEqual(crq.starts_last_hour(q), 1)
        self.assertFalse(q["author_observations"][0]["reserved"])
        again = author_quota.charge_observation(q, obs, at=crq.iso(now))
        self.assertFalse(again["charged"])                  # identical is idempotent
        self.assertEqual(len(q["starts"]), 1)

    def test_same_key_different_binding_or_artifacts_refuses(self):
        q = empty_queue()
        manifest, now = self._manifest()
        obs = author_quota.normalize_observation(manifest, now=now)
        author_quota.charge_observation(q, obs, at=crq.iso(now))
        before = copy.deepcopy(q)
        for clash in ({**obs, "head": "c" * 40},
                      {**obs, "artifacts": [{"path": "/tmp/other.ndjson", "sha256": "d" * 64}]}):
            with self.subTest(clash=clash.get("head")), self.assertRaises(author_quota.AuthorRefused):
                author_quota.charge_observation(q, clash, at=crq.iso(now))
        self.assertEqual(q, before)

    def test_reserved_true_future_and_stale_refuse(self):
        for over in ({"reserved": True},
                     {"started_at": crq.iso(crq.now() + dt.timedelta(minutes=5))},
                     {"started_at": crq.iso(crq.now() - dt.timedelta(hours=2))}):
            manifest, now = self._manifest(**over)
            with self.subTest(over=over), self.assertRaises(author_quota.AuthorRefused):
                author_quota.normalize_observation(manifest, now=now)

    def test_timestamp_grammar_is_strict_no_truncation(self):
        good = crq.iso(crq.now() - dt.timedelta(minutes=1))
        stem = good[:-1]
        manifest, now = self._manifest(started_at=good)
        author_quota.normalize_observation(manifest, now=now)  # positive control
        for bad in (stem + ".123Z", stem + "+00:00", stem, good + "junk",
                    good.replace("T", " ")):
            manifest, now = self._manifest(started_at=bad)
            with self.subTest(bad=bad), self.assertRaises(author_quota.AuthorRefused):
                author_quota.normalize_observation(manifest, now=now)

    def test_artifacts_require_regular_files_with_matching_digests(self):
        manifest, now = self._manifest()
        obs = author_quota.normalize_observation(manifest, now=now)
        with self.assertRaises(author_quota.AuthorRefused):
            author_quota.verify_artifacts(obs, is_regular=lambda p: False, digest_of=lambda p: "e" * 64)
        with self.assertRaisesRegex(author_quota.AuthorRefused, "digest mismatch"):
            author_quota.verify_artifacts(obs, is_regular=lambda p: True, digest_of=lambda p: "0" * 64)
        author_quota.verify_artifacts(obs, is_regular=lambda p: True, digest_of=lambda p: "e" * 64)

    def test_missing_or_duplicate_artifacts_refuse(self):
        for over in ({"artifacts": []},
                     {"artifacts": [{"path": "/x", "sha256": "bad"}]},
                     {"artifacts": [{"path": "/x", "sha256": "e" * 64},
                                    {"path": "/y", "sha256": "e" * 64}]}):
            manifest, now = self._manifest(**over)
            with self.subTest(over=over), self.assertRaises(author_quota.AuthorRefused):
                author_quota.normalize_observation(manifest, now=now)


if __name__ == "__main__":
    unittest.main()
