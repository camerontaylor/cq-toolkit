"""Push discovery: floor initialization, ranges, quiet window, divergence.

Split provenance: moved verbatim from apps/crq-python/test_push_current.py.
Fixtures live in test_push_current_fixtures.py.
"""
import json
import unittest
from unittest import mock

from test_push_current_fixtures import (FOREIGN, PRIMARY, PushTestBase, crq,
                                        push_current, review_receipt)


class PushTest(PushTestBase, unittest.TestCase):
    def test_floor_initialization_enrolls_nothing(self):
        c1 = self.commit(self.foreign_origin, "old work", when=self.ago(48), files={"a.txt": "a\n"})
        self.commit(self.foreign_origin, "mid work", when=self.ago(30), files={"b.txt": "b\n"})
        c3 = self.commit(self.foreign_origin, "new work", when=self.ago(2), files={"c.txt": "c\n"})
        for floor, expected, why in ((self.iso_of(self.ago(36)), c1, "last commit at-or-before floor"),
                                     (self.iso_of(self.ago(72)), c3, "branch younger than floor starts at tip"),
                                     (None, c3, "unset floor starts at tip")):
            with self.subTest(floor=floor, why=why):
                self.q = {"created_at": crq.iso(), "items": [], "starts": [], "paused": False}
                self.repos[0] = self.cfg(floor=floor)
                log = self.discover()
                self.assertEqual(self.q["push_discovery"][FOREIGN]["reviewed_tip"], expected)
                self.assertEqual(self.q["items"], [])
                self.assertTrue(any("initialized" in line for line in log), log)

    def test_multi_commit_range_enrolls_one_item_with_repo_field(self):
        self.repos[0] = self.cfg(floor=self.iso_of(self.ago(36)))
        c1 = self.commit(self.foreign_origin, "old work", when=self.ago(48), files={"a.txt": "a\n"})
        self.commit(self.foreign_origin, "mid work", when=self.ago(30), files={"b.txt": "b\n"})
        c3 = self.commit(self.foreign_origin, "new work", when=self.ago(2), files={"c.txt": "c\n"})
        self.assertEqual(self.tick(), 0)  # first tick: floor initialization only
        self.q = crq.load_queue()
        self.assertEqual(self.q["push_discovery"][FOREIGN]["reviewed_tip"], c1)
        self.assertEqual([i for i in self.q["items"] if i.get("kind") == push_current.KIND], [])
        self.assertEqual(self.tick(), 1)  # second tick: enrollment AND dispatch
        self.q = crq.load_queue()
        item = self.the_item()
        self.assertEqual(item["id"], push_current.part_id(self.repos[0], c1, c3))
        self.assertEqual(item["repo"], FOREIGN)
        self.assertEqual(item["pr"], 0)
        self.assertEqual(item["state"], "reviewing")
        self.assertEqual(item["subject"], {"type": "push-range", "repo": FOREIGN, "base": c1,
                                           "head": c3, "policy": review_receipt.POLICY})
        self.assertTrue(item["order"] >= 1)
        self.assertIn("auto-enrolled", item["notes"][0])
        meta = json.loads((crq.RUNS / item["run"]["run_id"] / "meta.json").read_text())
        self.assertEqual(meta["repo"], FOREIGN)
        self.assertIn("--committed", meta["cmd"])
        self.assertEqual(meta["push"], {"base": c1, "head": c3, "target": c3})
        # Legacy items without repo keep ranking as primary (regression guard);
        # the foreign item schedules at its configured tier.
        legacy = {"id": "current-x", "kind": review_receipt.KIND, "pr": 7, "state": "pending"}
        self.assertEqual(crq.item_repo(legacy), PRIMARY)
        self.assertEqual(crq.rank(legacy), 2)
        self.assertEqual(crq.rank(item), 3)
        self.assertEqual(crq.sort_key(legacy)[:2], (1, 2))
        self.assertEqual(crq.sort_key(item)[:2], (1, 3))

    def test_repeated_discovery_keeps_the_pending_range(self):
        # A pending, uncaptured item waiting for a start slot is the range
        # discovery would enroll again: it must not coalesce itself away.
        self.commit(self.foreign_origin, "new work", when=self.ago(2), files={"a.py": "a\n"})
        item = self.enroll_push(floor=self.iso_of(self.ago(36)), quiet_minutes=1)
        self.assertEqual(item["state"], "pending")
        self.assertFalse(item.get("capture"))
        log = self.discover()
        self.assertEqual(item["state"], "pending")
        self.assertFalse(any("coalesced" in note for note in item.get("notes", [])), item["notes"])
        self.assertTrue(any("already pending" in line for line in log), log)

    def test_floor_initialization_follows_first_parent_history(self):
        # A side-branch commit dated before the floor but merged after it must
        # not become the boundary, or its additions would leave the range.
        self.commit(self.foreign_origin, "init", when=self.ago(48), files={"base.txt": "b\n"})
        mainline = self.commit(self.foreign_origin, "mainline one", when=self.ago(44),
                               files={"m1.txt": "1\n"})
        self.git(self.foreign_origin, "checkout", "-q", "-b", "side")
        self.commit(self.foreign_origin, "side work", when=self.ago(40), files={"side.txt": "s\n"})
        self.git(self.foreign_origin, "checkout", "-q", "main")
        self.commit(self.foreign_origin, "mainline two", when=self.ago(10), files={"m2.txt": "2\n"})
        stamp = f"@{int(self.ago(20).timestamp())} +0000"
        self.git(self.foreign_origin, "merge", "--no-ff", "-q", "-m", "merge side", "side",
                 env={"GIT_AUTHOR_DATE": stamp, "GIT_COMMITTER_DATE": stamp})
        self.repos[0] = self.cfg(floor=self.iso_of(self.ago(36)))
        self.discover()
        self.assertEqual(self.q["push_discovery"][FOREIGN]["reviewed_tip"], mainline)

    def test_quiet_window_waits(self):
        self.repos[0] = self.cfg(floor=self.iso_of(self.ago(36)))
        self.commit(self.foreign_origin, "fresh work",
                    when=self.ago(minutes=2), files={"n.txt": "n\n"})
        self.discover()  # floor init at self.base
        log = self.discover()
        self.assertEqual(self.q["items"], [])
        self.assertEqual(self.q["push_discovery"][FOREIGN]["reviewed_tip"], self.base)
        self.assertTrue(any("quiet window" in line for line in log), log)
        # Once the tip ages past the window the range enrolls.
        c2 = self.commit(self.foreign_origin, "aged work", when=self.ago(2), files={"o.txt": "o\n"})
        self.discover()
        item = self.the_item()
        self.assertEqual(item["subject"]["head"], c2)

    def test_divergence_resets_without_review(self):
        self.repos[0] = self.cfg(floor=self.iso_of(self.ago(1)))
        c2 = self.commit(self.foreign_origin, "mid work", when=self.ago(2), files={"b.txt": "b\n"})
        self.discover()  # floor init: c2 is the last commit at-or-before the floor
        self.assertEqual(self.q["push_discovery"][FOREIGN]["reviewed_tip"], c2)
        self.git(self.foreign_origin, "reset", "--hard", self.base)
        rewritten = self.commit(self.foreign_origin, "rewritten history",
                                when=self.ago(0, 90), files={"z.txt": "z\n"})
        log = self.discover()
        self.assertEqual(self.q["push_discovery"][FOREIGN]["reviewed_tip"], rewritten)
        self.assertEqual(self.q["items"], [])
        self.assertTrue(any("history rewritten" in line for line in log), log)
        divergence = [e for e in self.events() if e["event"] == "push_divergence"]
        self.assertEqual(len(divergence), 1)
        self.assertEqual(divergence[0]["repo"], FOREIGN)
        self.assertEqual(divergence[0]["reviewed_tip"], c2)
        self.assertEqual(divergence[0]["tip"], rewritten)

    def test_fetch_failure_skips_repo_without_raising(self):
        self.commit(self.foreign_origin, "mid work", when=self.ago(2), files={"b.txt": "b\n"})
        with mock.patch.object(crq, "fetch", side_effect=RuntimeError("boom")):
            log = self.discover()  # must not raise
        self.assertEqual(len(log), 1)
        self.assertIn("fetch failed", log[0])
        self.assertIn("boom", log[0])
        self.assertNotIn("push_discovery", self.q)
        self.assertEqual(self.q["items"], [])


if __name__ == "__main__":
    unittest.main()
