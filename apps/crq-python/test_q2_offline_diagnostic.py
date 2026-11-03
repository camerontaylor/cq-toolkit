"""One existing Q2 case; retain the split module setup and cleanup unchanged."""
import unittest
import test_crq_current_receipts


def load_tests(loader, standard_tests, pattern):
    # Return the original TestCase, without subclassing or wrapping its run.
    # unittest uses its class.__module__ (test_crq_current_receipts) for
    # setUpModule/cleanups.
    return unittest.TestSuite([
        test_crq_current_receipts.CurrentTest(
            "test_enqueue_and_request_conflict_are_verified_without_launch")
    ])
