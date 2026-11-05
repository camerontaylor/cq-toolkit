"""The real tick: enrolls and launches a foreign open review with the repo
clone's scan and the plan's meta.

Split provenance: moved verbatim from apps/crq-python/test_pr_enroll.py.
Fixtures live in test_pr_enroll_fixtures.py.
"""
import json
import unittest
from pathlib import Path

from test_pr_enroll_fixtures import FOREIGN, PrTestBase, crq


class PrTest(PrTestBase, unittest.TestCase):
    def test_tick_enrolls_and_launches_a_foreign_open_review(self):
        h1 = self.foreign_commit("pr work", {"a.txt": "a\n"})
        with self.fake_gh(opened=[self.pr_row(5, h1)], view=self.pr_view(5, h1)):
            spawns, scan, _ = self.tick()
        self.assertEqual(spawns, 1)
        self.q = crq.load_queue()
        item = next(i for i in self.q["items"] if i["id"] == "infra-pr5")
        self.assertEqual(item["state"], "reviewing")
        self.assertEqual(item["repo"], FOREIGN)
        meta = json.loads((crq.RUNS / item["run"]["run_id"] / "meta.json").read_text())
        self.assertEqual(meta["repo"], FOREIGN)
        self.assertEqual(meta["base"], self.base)
        self.assertEqual(meta["head"], h1)
        self.assertIn("--committed", meta["cmd"])
        self.assertEqual(meta["range_policy"], "full-range-once-v1")
        # The launch scan ran with the universal class set in the repo's clone
        # (quiet_reason's head read ran there too, or the launch would not exist).
        scan.assert_called_once()
        self.assertEqual(scan.call_args.kwargs["clone"], Path(self.foreign))
        self.assertEqual(scan.call_args.kwargs["classes"], crq.UNIVERSAL_SCAN_CLASSES)


if __name__ == "__main__":
    unittest.main()
