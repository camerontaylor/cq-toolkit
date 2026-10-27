"""Offline Q1 integration fixtures; no provider or live queue effects."""
import unittest
import review_receipt


class SubjectTest(unittest.TestCase):
    def test_default_is_promoted_main_and_enrollment_does_not_pin(self):
        q = {"items": [], "starts": []}
        result = review_receipt.enroll(q, repo="owner/repo", pr=1, merge_sha="a" * 40,
                                      request_id="missed", at="now")
        self.assertEqual(result["item"]["subject"]["target_selector"], "promoted-main")
        self.assertNotIn("capture", result["item"])
        self.assertEqual(q["starts"], [])
