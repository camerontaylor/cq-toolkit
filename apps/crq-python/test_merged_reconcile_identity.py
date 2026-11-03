"""Record identity: the Q1 subject shape and unsupported-reason reporting.

Split provenance: moved verbatim from test_merged_reconcile.py;
test_merged_reconcile_fixtures.py holds the shared offline fixtures.
"""
import unittest

from test_merged_reconcile_fixtures import A, mr, pr, sha


class RecordIdentityTests(unittest.TestCase):
    def test_well_formed_record_proposes_the_q1_subject_shape(self):
        identity = mr.record_identity(pr(5, "2026-10-03T04:05:06Z"))
        self.assertEqual(identity["disposition"], "intent")
        self.assertEqual(identity["subject"],
                         {"repo": None, "pr": 5, "merge_sha": sha(5),
                          "target_selector": "promoted-main",
                          "policy": "affected-current-additions-v1"})

    def test_unsupported_records_name_their_reason(self):
        cases = [("not an object", "junk"),
                 ("malformed number", {"number": "seven", "mergedAt": A,
                                       "mergeCommit": {"oid": sha(1)}, "headRefOid": sha(2)}),
                 ("bad mergedAt", {**pr(1, A), "mergedAt": "yesterday"}),
                 ("missing merge identity", {**pr(1, A), "mergeCommit": None}),
                 ("source head gone", {**pr(1, A), "headRefOid": None}),
                 ("malformed head", {**pr(1, A), "headRefOid": "deadbeef"})]
        for name, record in cases:
            with self.subTest(record=name):
                identity = mr.record_identity(record)
                self.assertEqual(identity["disposition"], "unsupported")
                self.assertTrue(identity["reason"])
