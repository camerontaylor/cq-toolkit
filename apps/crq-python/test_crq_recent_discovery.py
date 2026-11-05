"""Rolling recent discovery: keyset paging and wrapper retention.

Split provenance: moved verbatim from test_crq.py;
test_crq_fixtures.py holds the shared offline fixtures.
"""
import copy
import json
import re
import tempfile
from pathlib import Path
import unittest
from unittest import mock
import review_receipt
from test_crq_fixtures import (
    crq,
    setUpModule,
)

class RecentKeysetDiscoveryTest(unittest.TestCase):
    """Offline closed-PR list that changes between page reads and ticks."""

    AFTER = "2026-10-01T00:00:00Z"
    BEFORE = "2026-10-03T00:00:00Z"
    LATER = "2026-10-03T00:00:00Z"

    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="recent-keyset-")
        self.addCleanup(temp.cleanup)
        root = Path(temp.name)
        for name, value in (("STATE", root), ("QUEUE", root / "queue.json")):
            patcher = mock.patch.object(crq, name, new=value)
            patcher.start()
            self.addCleanup(patcher.stop)
        patcher = mock.patch.object(crq, "now", return_value=crq.parse_iso("2026-10-03T00:00:01Z"))
        patcher.start()
        self.addCleanup(patcher.stop)
        self.calls = []
        self.hooks = {}
        self.q = {"created_at": self.AFTER, "items": [], "starts": [], "merged_watermark": self.AFTER}
        crq.save_queue(self.q)

    def closed(self, count, unmerged=()):
        base = crq.parse_iso("2026-10-02T00:00:00Z")
        self.rows = {n: {"number": n, "base": {"ref": "main"},
                         "updated_at": crq.iso(base + crq.dt.timedelta(seconds=n)),
                         "merged_at": None if n in unmerged else crq.iso(base + crq.dt.timedelta(seconds=n)),
                         "merge_commit_sha": f"{n:040x}", "head": {"sha": f"{n:040x}"}}
                     for n in range(1, count + 1)}
        self.merged = {n for n in self.rows if n not in unmerged}

    def forge(self, args):
        size = int(re.search(r"[?&]per_page=(\d+)", args[1]).group(1))
        page = int(re.search(r"[?&]page=(\d+)", args[1]).group(1))
        self.hooks.pop(len(self.calls), lambda: None)()
        self.calls.append((size, page))
        # GitHub sorts by its own key (_sort when set), not the returned field.
        # Equal keys break by _tie when set, so a test can reorder them.
        ordered = sorted(self.rows.values(), key=lambda r: (r.get("_sort", r["updated_at"]),
                                                            r.get("_tie", r["number"])), reverse=True)
        return [{k: v for k, v in copy.deepcopy(r).items() if k not in ("_sort", "_tie")}
                for r in ordered[(page - 1) * size:page * size]]

    def move(self, number):
        """A PR update (label, edit, merge) moves a closed PR to the top."""
        return lambda: self.rows[number].update(updated_at=self.LATER, _sort=self.LATER)

    def bump(self, number, at=None):
        """A comment advances updated_at only; the PR keeps its sort position
        (live #750: sorted at its 09:34 merge, updated_at 10:50)."""
        def apply():
            row = self.rows[number]
            row.setdefault("_sort", row["updated_at"])
            row["updated_at"] = at or self.LATER
        return apply

    def reopen(self, number):
        """A reopened PR leaves the closed list; later rows shift up."""
        return lambda: self.rows.pop(number)

    def tick(self):
        with mock.patch.object(crq, "gh_json", side_effect=self.forge):
            log = crq.discover_merged(self.q, crq.ForgeBudget(),
                                      interval={"after": self.AFTER, "before": self.BEFORE}, recent=True)
        self.assertEqual(crq.load_queue(), self.q)
        return log

    def enrolled(self):
        return {item["pr"] for item in self.q["items"]}

    def real_page(self):
        path = Path(__file__).resolve().parent / "fixtures" / "closed-page-20261103.json"
        rows = json.loads(path.read_text())
        merged = {750: "2026-11-01T09:34:43Z"}
        return [{**row, "base": {"ref": "main"}, "merged_at": merged.get(row["number"], row["updated_at"]),
                 "merge_commit_sha": f"{row['number']:040x}", "head": {"sha": f"{row['number']:040x}"}}
                for row in rows]

    def test_real_closed_page_with_github_inversion_is_read_not_refused(self):
        # Deploy 20261103-1 refused this live first page: #753 (09:43:46Z) is
        # followed by #750 (10:50:03Z), 3977 s newer, at index 61/62.
        rows = self.real_page()
        self.assertEqual([r["number"] for r in rows[61:63]], [753, 750])
        self.assertGreater(rows[62]["updated_at"], rows[61]["updated_at"])
        for after in ("2026-11-02T00:00:00Z", "2026-11-01T10:00:00Z"):
            with self.subTest(after=after), mock.patch.object(crq, "gh_json", return_value=rows) as forge:
                page = crq.recent_merged_page(None, after)
            forge.assert_called_once()
            self.assertIsNone(page["next_cursor"])
            expected = {r["number"] for r in rows if r["updated_at"] > after}
            self.assertEqual({r["number"] for r in page["records"]}, expected)
        # #750 sits below the floor crossing (#754 at 09:56) but is still read.
        self.assertIn(750, expected)

    def test_stale_sort_position_inside_a_page(self):
        # #230 (page one) and #120 (page two) keep their merge-time positions
        # while comments push updated_at above every row read before them.
        self.closed(250)
        self.bump(230)()
        self.bump(120)()
        self.until_complete()
        self.assertEqual(self.enrolled(), self.merged)

    def test_stale_sort_position_across_a_page_boundary(self):
        # #150 opens page two with an updated_at newer than all of page one;
        # a comment on #151, the last row read, lands mid-scan.
        self.closed(250)
        self.bump(150)()
        self.hooks[1] = self.bump(151, "2026-10-03T00:00:05Z")
        self.until_complete()
        self.assertEqual(self.enrolled(), self.merged)

    def test_stale_row_at_the_anchor(self):
        # The last rows passed on page one are stale-position rows; one is
        # commented again before the continuation and one is reopened.
        self.closed(250, unmerged={152})
        for n in (151, 152, 153):
            self.bump(n, "2026-10-02T23:00:00Z")()
        self.hooks[1] = lambda: (self.bump(151)(), self.reopen(152)())
        self.until_complete()
        self.assertEqual(self.enrolled(), self.merged)

    def test_stale_row_inside_a_same_second_group(self):
        # A 150-row same-second group spans pages; one member is commented
        # (position kept, newer updated_at) and another moves to the top.
        self.closed(400)
        self.tie(range(100, 250), 900)
        self.bump(180)()
        self.hooks[1] = lambda: (self.bump(120)(), self.move(200)())
        self.until_complete()
        self.assertEqual(self.enrolled(), self.merged)

    def test_same_second_merges_swapping_across_a_request_boundary(self):
        # Independent review (#829): merge-queue merges #151 and #150 share a
        # second and straddle the page boundary (offsets 99 and 100). On the
        # next request GitHub returns #150 above #151, the last row read.
        self.closed(250)
        self.tie((150, 151), 150)
        self.hooks[1] = lambda: self.rows[150].update(_tie=10 ** 6)
        self.until_complete()
        self.assertIn(150, self.enrolled())
        self.assertEqual(self.enrolled(), self.merged)

    def test_single_page_scan_stays_one_request(self):
        self.closed(40)
        self.assertIn("complete=True", self.tick()[0])
        self.assertEqual(self.calls, [(100, 1)])
        self.assertEqual(self.enrolled(), self.merged)

    def test_merge_moving_between_pages_is_not_missed(self):
        # Page one is numbers 250..151. Before the second read, reopening
        # read #200 shifts merged #150 from offset 100 into offset 99; before
        # the third read, unread merged #10 is updated to the top. Fixed
        # page=2/page=3 offsets (the previous adapter) miss both #150 and #10.
        self.closed(250, unmerged={200})
        self.hooks[1] = self.reopen(200)
        self.hooks[2] = self.move(10)
        self.until_complete()
        self.assertEqual(self.enrolled(), self.merged)
        self.assertEqual(self.q["merged_watermark"], self.BEFORE)
        self.assertNotIn((100, 2), self.calls)

    def test_moves_and_reopens_between_ticks_never_lose_a_merge(self):
        self.closed(450, unmerged={420, 300})
        # Tick one spends its four pages; changes land before tick two resumes.
        self.hooks[4] = lambda: (self.move(5)(), self.move(380)(), self.reopen(420)(),
                                 self.reopen(300)())
        self.assertIn("complete=False", self.tick()[0])
        self.assertEqual(len(self.calls), 4)
        self.assertEqual(self.q["merged_watermark"], self.AFTER)
        self.assertEqual(self.enrolled(), set())
        self.assertFalse(self.q["merged_discovery"]["complete"])
        for _ in range(3):
            if self.q["merged_discovery"]["complete"]:
                break
            self.tick()
        self.assertTrue(self.q["merged_discovery"]["complete"])
        self.assertEqual(self.enrolled(), self.merged)
        self.assertEqual(self.q["merged_watermark"], self.BEFORE)

    def test_large_reopen_burst_backs_off_to_a_verified_window(self):
        self.closed(250, unmerged=set(range(171, 201)))
        # Thirty reopens of already-read rows exceed the 20-row overlap: the
        # window at offset 79 would begin at #141, past unread #150..#142 and
        # with no remembered row in it, so it backs off.
        self.hooks[1] = lambda: [self.reopen(n)() for n in range(171, 201)]
        self.assertIn("complete=False", self.tick()[0])
        self.assertEqual(self.calls[:3], [(100, 1), (79, 2), (100, 1)])
        self.assertEqual(self.enrolled(), set())
        self.until_complete()
        self.assertEqual(self.enrolled(), self.merged)
        self.assertEqual(self.q["merged_watermark"], self.BEFORE)

    def tie(self, numbers, second):
        for n in numbers:
            self.rows[n]["updated_at"] = f"2026-10-02T00:{second // 60:02d}:{second % 60:02d}Z"

    def until_complete(self, ticks=8):
        for _ in range(ticks):
            log = self.tick()
            self.assertNotIn("incomplete", log[0])
            if self.q["merged_discovery"]["complete"]:
                return
        self.fail("scan did not complete")

    def test_oversized_same_second_group_recovers_without_refusal(self):
        # 400 closed PRs share one update second mid-list (more than the
        # cursor remembers); a reopen and a move land during the traversal.
        self.closed(600, unmerged={550})
        self.tie(range(100, 500), 300)
        self.hooks[2] = lambda: (self.reopen(550)(), self.move(250)())
        self.until_complete()
        self.assertEqual(self.enrolled(), self.merged)
        self.assertEqual(self.q["merged_watermark"], self.BEFORE)
        for size, page in self.calls:
            self.assertLessEqual(size, 100)

    def test_merge_updated_into_head_second_among_read_rows_is_kept(self):
        # Independent review reproduction (#822): the newest second holds a
        # group of 100, 101 or 150 closed PRs. After the first read, unread
        # merged #501 is updated into that second and sorts among group rows
        # already read. The head pass must still record it.
        for size in (100, 101, 150):
            with self.subTest(group=size):
                self.setUp()
                self.closed(600)
                self.tie(range(600, 600 - 2 * size, -2), 3000)
                head = self.rows[600]["updated_at"]
                self.hooks[1] = lambda: self.rows[501].update(updated_at=head)
                self.until_complete()
                self.assertIn(501, self.enrolled())
                self.assertEqual(self.enrolled(), self.merged)

    def test_oversized_group_at_the_head_completes(self):
        self.closed(300)
        self.tie(range(1, 301), 600)
        self.until_complete()
        self.assertEqual(self.enrolled(), self.merged)
        self.assertLessEqual(len(self.calls), 12)

    def test_cursor_stays_within_capacity_for_large_numbers(self):
        self.closed(0)
        base = 10 ** 30  # 100 anchors plus 100 head numbers exceed 4 KB
        self.rows = {n: {"number": n, "base": {"ref": "main"}, "updated_at": "2026-10-02T00:10:00Z",
                         "merged_at": "2026-10-02T00:10:00Z", "merge_commit_sha": f"{n % 10 ** 9:040x}",
                         "head": {"sha": f"{n % 10 ** 9:040x}"}} for n in range(base, base + 250)}
        self.merged = set(self.rows)
        dumps = crq.json.dumps
        sizes = []
        with mock.patch.object(crq.json, "dumps", side_effect=lambda *a, **k: (
                lambda out: sizes.append(len(out)) or out)(dumps(*a, **k))):
            self.until_complete()
        self.assertEqual(self.enrolled(), self.merged)
        self.assertTrue(any(size > crq.merged_reconcile.MAX_CURSOR_BYTES for size in sizes))


class RecentWrapperRetentionTest(unittest.TestCase):
    """Rolling discovery leaves one wrapper per tick; growth stays bounded."""

    FLOOR = "2026-10-01T00:00:00Z"

    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="recent-retention-")
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.clock = crq.parse_iso("2026-10-01T01:00:00Z")
        for name, kwargs in (("STATE", {"new": self.root}), ("QUEUE", {"new": self.root / "queue.json"}),
                             ("now", {"side_effect": lambda: self.clock}),
                             ("gh_json", {"return_value": []})):
            patcher = mock.patch.object(crq, name, **kwargs)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.q = {"created_at": self.FLOOR, "items": [], "starts": []}
        crq.save_queue(self.q)

    def key(self, after, before, method="closed-updated-v1"):
        return review_receipt.digest({"repo": crq.REPO, "base": "main-or-merge-queue", "after": after,
                                      "before": before, **({"method": method} if method else {})})

    def put(self, name, *, method="closed-updated-v1", complete=True, after=None, before=None, raw=None):
        path = self.root / "reconcile" / (name + ".json")
        path.parent.mkdir(exist_ok=True)
        if raw is None:
            value = {"source": {"method": method},
                     "checkpoint": {"after": after, "before": before, "complete": complete, "dry_run": False}}
            value["digest"] = review_receipt.digest(value)
            raw = json.dumps(value)
        path.write_text(raw)
        return path

    def tick(self):
        interval = crq.rolling_discovery_interval(self.q, {"enabled": True, "after": self.FLOOR})
        return crq.discover_merged(self.q, crq.ForgeBudget(), interval=interval, recent=True)

    def test_completed_rolling_wrappers_are_pruned_after_retention(self):
        old = ("2026-09-01T00:00:00Z", "2026-09-01T00:12:00Z")
        partial = ("2026-09-02T00:00:00Z", "2026-09-02T00:12:00Z")
        retained = [
            # Manual/inventory evidence, a partial scan, a wrapper whose name
            # does not bind its interval, and unreadable bytes all stay.
            self.put(self.key(*old, method=None), method="all-number-slots-v1", after=old[0], before=old[1]),
            self.put(self.key(*partial), complete=False, after=partial[0], before=partial[1]),
            self.put("f" * 64, after=old[0], before=old[1]),
            self.put(self.key(*old), raw="{"),
        ]
        sizes = []
        for _ in range(9 * 12):  # nine days of two-hour ticks
            self.clock += crq.dt.timedelta(hours=2)
            self.assertIn("complete=True", self.tick()[0])
            sizes.append(len(list((self.root / "reconcile").glob("*.json"))))
        # Seven days of rolling wrappers (84 two-hour ticks) plus the retained set.
        self.assertEqual(max(sizes), 84 + len(retained))
        self.assertEqual(sizes[-12:], [84 + len(retained)] * 12)
        self.assertTrue(all(path.exists() for path in retained))
        reference = self.root / "reconcile" / (self.q["merged_reconcile"]["checkpoint_key"] + ".json")
        self.assertTrue(reference.exists())
        befores = [json.loads(p.read_text())["checkpoint"]["before"]
                   for p in (self.root / "reconcile").glob("*.json") if p not in retained]
        self.assertGreaterEqual(min(befores), crq.iso(self.clock - crq.RECENT_WRAPPER_RETENTION))

    def test_prune_runs_at_most_hourly(self):
        old = ("2026-09-01T00:00:00Z", "2026-09-01T00:12:00Z")
        with mock.patch.object(crq, "prune_recent_wrappers", wraps=crq.prune_recent_wrappers) as prune:
            for minutes in (12, 24, 36, 48, 60, 72):
                self.clock += crq.dt.timedelta(minutes=12)
                self.tick()
                if minutes == 24:
                    stale = self.put(self.key(*old), after=old[0], before=old[1])
            self.assertEqual(prune.call_count, 2)
        self.assertFalse(stale.exists())
        self.assertEqual(crq.load_queue()["merged_wrappers_pruned_at"], crq.iso(self.clock))
        # A future record (clock skew, restored state) is stale, not a pause.
        self.q["merged_wrappers_pruned_at"] = "2099-01-01T00:00:00Z"
        self.clock += crq.dt.timedelta(minutes=12)
        with mock.patch.object(crq, "prune_recent_wrappers", return_value=0) as prune:
            self.tick()
        prune.assert_called_once()
        self.assertEqual(self.q["merged_wrappers_pruned_at"], crq.iso(self.clock))

    def test_unenrolled_or_referenced_complete_wrappers_are_retained(self):
        self.clock = crq.parse_iso("2026-10-20T00:00:00Z")
        old = ("2026-10-01T00:00:00Z", "2026-10-01T00:12:00Z")
        above = self.put(self.key(*old), after=old[0], before=old[1])
        # Watermark below the interval: enrollment may still replay from it.
        self.q.update(merged_watermark=old[0])
        self.assertEqual(crq.prune_recent_wrappers(self.q), 0)
        self.q.update(merged_watermark=old[1], merged_discovery={"after": old[0], "before": old[1], "complete": True})
        self.assertEqual(crq.prune_recent_wrappers(self.q), 0)
        self.q.update(merged_discovery={}, merged_reconcile={"checkpoint_key": self.key(*old)})
        self.assertEqual(crq.prune_recent_wrappers(self.q), 0)
        self.assertTrue(above.exists())
        self.q.pop("merged_reconcile")
        self.assertEqual(crq.prune_recent_wrappers(self.q), 1)
        self.assertFalse(above.exists())
