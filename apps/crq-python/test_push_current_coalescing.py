"""Push discovery coalescing: widened ranges and split-part pins.

Split provenance: moved verbatim from apps/crq-python/test_push_current.py.
Fixtures live in test_push_current_fixtures.py.
"""
import unittest

from test_push_current_fixtures import FOREIGN, PushTestBase, push_current


class PushTest(PushTestBase, unittest.TestCase):
    def test_coalescing_skips_pending_and_widens_range(self):
        self.repos[0] = self.cfg(floor=self.iso_of(self.ago(36)))
        c2 = self.commit(self.foreign_origin, "mid work", when=self.ago(2), files={"b.txt": "b\n"})
        self.discover()  # floor init at self.base
        self.discover()
        old = self.the_item()
        self.assertEqual((old["subject"]["base"], old["subject"]["head"]), (self.base, c2))
        c3 = self.commit(self.foreign_origin, "more work", when=self.ago(1), files={"d.txt": "d\n"})
        self.discover()
        self.assertEqual(old["state"], "skipped")
        self.assertIn("coalesced into", "\n".join(old["notes"]))
        new = next(i for i in self.q["items"] if i["id"] != old["id"])
        self.assertEqual((new["subject"]["base"], new["subject"]["head"]), (self.base, c3))
        self.assertEqual([i["state"] for i in self.q["items"]].count("pending"), 1)
        # A captured (pending, awaiting dispatch) item pins the lane untouched.
        new["capture"] = {"target": c3}
        c4 = self.commit(self.foreign_origin, "later work", when=self.ago(0, 45), files={"e.txt": "e\n"})
        log = self.discover()
        self.assertEqual(new["state"], "pending")
        self.assertEqual(new["subject"]["head"], c3)
        self.assertEqual([i["id"] for i in self.q["items"]], [old["id"], new["id"]])
        self.assertTrue(any("pins the lane" in line for line in log), log)
        # A reviewing item pins the lane too.
        new["state"] = "reviewing"
        self.discover()
        self.assertEqual(new["state"], "reviewing")
        self.assertEqual(len(self.q["items"]), 2)

    def test_coalescing_never_skips_a_split_part_item(self):
        # Parent range overflows the 2 MiB scope: part 1 keeps 8 files and
        # prepare enrolls p2 (paths_filter = the 9th, depends_on = parent).
        big = {f"f{n}.py": "x" * 256000 + "\n" for n in range(9)}
        c1 = self.commit(self.foreign_origin, "big range", when=self.ago(2), files=big)
        item = self.enroll_push(floor=self.iso_of(self.ago(36)))
        self.prepare(item)
        followup = next(i for i in self.q["items"] if i["id"] != item["id"])
        self.assertEqual(followup["depends_on"], item["id"])
        # Parent harvests counted: reviewed_tip advances past the parent range.
        self.launch(item)
        self.harvest(item)
        self.assertEqual(item["state"], "done")
        target = item["capture"]["target"]
        self.assertEqual(self.q["push_discovery"][FOREIGN]["reviewed_tip"], target)
        # A new push touching OTHER paths enrolls the new range — and must NOT
        # coalesce p2 away, or its overflow scope would never be reviewed.
        c2 = self.commit(self.foreign_origin, "unrelated push", when=self.ago(1),
                         files={"other.py": "o\n"})
        log = self.discover()
        new_range = next(i for i in self.q["items"]
                         if i["id"] not in (item["id"], followup["id"]))
        self.assertEqual(new_range["state"], "pending")
        self.assertEqual((new_range["subject"]["base"], new_range["subject"]["head"]), (target, c2))
        self.assertTrue(any("enrolled" in line for line in log), log)
        self.assertEqual(followup["state"], "pending")
        self.assertTrue(all("coalesced" not in note for note in followup["notes"]))
        # p2 still prepares and captures exactly its filtered overflow path,
        # re-resolved at the current target.
        fplan = self.prepare(followup)
        self.assertIsNotNone(fplan)
        self.assertEqual([r["path"] for r in followup["capture"]["paths"]],
                         followup["subject"]["paths_filter"])
        self.assertEqual(fplan["base"], followup["capture"]["base"])
        self.assertEqual(followup["subject"]["pin"], target)
        self.assertEqual(fplan["target"], target)

    def test_split_part_harvest_does_not_advance_the_reviewed_tip(self):
        # A follow-up part (-p2) reviews a path SUBSET of its range. Harvesting
        # it counted must not claim the whole tip, or a later push could
        # coalesce away the unreviewed remainder of that range.
        big = {f"f{n}.py": "x" * 256000 + "\n" for n in range(9)}
        self.commit(self.foreign_origin, "big range", when=self.ago(2), files=big)
        item = self.enroll_push(floor=self.iso_of(self.ago(36)), quiet_minutes=1)
        self.prepare(item)
        followup = next(i for i in self.q["items"] if i["id"] != item["id"])
        self.launch(item)
        self.harvest(item)
        target = item["capture"]["target"]
        self.assertEqual(self.q["push_discovery"][FOREIGN]["reviewed_tip"], target)
        # The branch moves while p2 is still pending; discovery enrolls the
        # whole T1..T2 range.
        self.commit(self.foreign_origin, "later push", when=self.ago(minutes=10), files={"other.py": "o\n"})
        self.discover()
        whole = next(i for i in self.q["items"] if i["id"] not in (item["id"], followup["id"]))
        self.assertEqual(whole["state"], "pending")
        # p2 captures at the current tip but covers only its filtered paths:
        # its counted harvest must leave the reviewed tip where it was.
        self.launch(followup)
        self.assertEqual([r["path"] for r in followup["capture"]["paths"]],
                         followup["subject"]["paths_filter"])
        # The part is pinned to the parent capture, not the newer tip: deferred
        # content cannot move before this part reviews it.
        self.assertEqual(followup["subject"]["pin"], target)
        self.assertEqual(followup["capture"]["target"], target)
        self.harvest(followup)
        self.assertEqual(followup["state"], "done")
        self.assertEqual(self.q["push_discovery"][FOREIGN]["reviewed_tip"], target)
        # The next range therefore starts at the reviewed tip, covering the
        # whole remainder (including the paths p2 never reviewed).
        c3 = self.commit(self.foreign_origin, "third push", when=self.ago(minutes=5), files={"third.py": "t\n"})
        self.discover()
        newest = next(i for i in self.q["items"]
                      if i["id"] not in (item["id"], followup["id"], whole["id"]))
        self.assertEqual((newest["subject"]["base"], newest["subject"]["head"]), (target, c3))


if __name__ == "__main__":
    unittest.main()
