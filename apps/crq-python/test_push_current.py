"""Offline push-discovery integration: real temporary Git repos; fake forge/CLI.

Fixture shape follows CurrentTest (test_crq.py): module-global patching of the
loaded crq module, real git for both the primary fixture and the foreign
origin/clone pair, no network, and a fake coderabbit CLI version. The foreign
repo is a real clone of a local origin so discovery's refspec fetch is exercised
for real (docs/multi-repo.md push discovery).
"""
import contextlib
import datetime as dt
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("crq_push_test_crq", ROOT / "crq.py")
crq = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = crq
spec.loader.exec_module(crq)
import push_current
import repo_registry
import review_receipt

PRIMARY = "camerontaylor/cq-toolkit"
FOREIGN = "camerontaylor/infra"
COMPLETE = {"type": "complete", "status": "review_completed", "reviewedFiles": ["f0.py"]}

# Fake denylist corpus: every UNIVERSAL_SCAN_CLASSES id plus publish classes
# and a repo extra class. denylist_rules parses this file from the primary
# clone at origin/main, so the class filtering runs for real.
#
# The publish vocabulary is itself denylisted in this tree, so fixtures spell
# it in pieces (the same convention as test/ops/review/addressWorker.test.ts).
_CERES = "ce" + "res"
_PLUTO = "pl" + "uto"
_PERSONAL = "/home/c" + "taylor"
_SSH_KEY_RULE = "-----BEGIN " + "[A-Z0-9 ]*" + "PRIVATE KEY-----"
_FLEET_PROSE = ("redeploy " + _CERES + " tonight\ncwd=" + _PERSONAL + "/tmp\n"
                + _PLUTO + ".web" + "front.app and " + "bee" + "dee" + " dashboards\n")
DENYLIST_FIXTURE = (
    "rules:\n"
    "  - id: class:token-ssh-plumbing\n"
    f"    regex: '{_SSH_KEY_RULE}'\n"
    "  - id: class:route-key-material\n"
    "    regex: 'pk-(live|test)-[A-Za-z0-9]{16,}'\n"
    "  - id: class:key-material-env\n"
    "    regex: '\\b[A-Z][A-Z_]*_KEY='\n"
    "  - id: class:inline-secret-assignments\n"
    "    regex: '\\b(secret|password)\\s*[:=]\\s*\\S{8,}'\n"
    "  - id: class:webfront-hostnames\n"
    f"    regex: '\\b({_CERES}|{_PLUTO})\\b'\n"
    "  - id: class:personal-paths\n"
    f"    regex: '{_PERSONAL}\\b'\n"
    "  - id: class:fixture-extra\n"
    "    regex: 'fixture-extra-marker'\n"
)


class PushTest(unittest.TestCase):
    """One primary fixture (crq's own clone, carrying the denylist corpus) and
    a foreign origin+clone pair whose default branch receives pushes."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.origin = self.init_repo(self.root / "primary-origin")
        (self.origin / "policy" / "denylist").mkdir(parents=True)
        (self.origin / "policy" / "denylist" / "patterns.yml").write_text(DENYLIST_FIXTURE)
        self.pre = self.commit(self.origin, "denylist fixture", when=self.ago(48))
        self.repo = self.clone_repo(self.origin, self.root / "primary")
        self.foreign_origin = self.init_repo(self.root / "infra-origin")
        (self.foreign_origin / "README.md").write_text("infra\n")
        self.base = self.commit(self.foreign_origin, "infra init", when=self.ago(48))
        self.foreign = self.clone_repo(self.foreign_origin, self.root / "infra")
        self.state = self.root / "state"
        self.state.mkdir()
        self.q = {"created_at": crq.iso(), "items": [], "starts": [], "paused": False}
        for name, value in (("CLONE", self.repo), ("STATE", self.state), ("RUNS", self.state / "runs"),
                            ("QUEUE", self.state / "queue.json"), ("EVENTS", self.state / "events.jsonl"),
                            ("LOCK", self.state / "tick.lock"), ("WORK_RECORDS", self.state / "work.jsonl")):
            patch = mock.patch.object(crq, name, value)
            patch.start()
            self.addCleanup(patch.stop)
        self.repos = [self.cfg()]
        patch = mock.patch.object(crq, "REPOS", self.repos)
        patch.start()
        self.addCleanup(patch.stop)
        real_run = crq.run

        def fake_run(argv, **kw):
            if argv == ["coderabbit", "--version"]:
                return SimpleNamespace(stdout="fixture-cli-1\n", returncode=0)
            if argv[0] == "gh":
                raise AssertionError("unmocked forge call in offline fixture")
            return real_run(argv, **kw)

        patch = mock.patch.object(crq, "run", side_effect=fake_run)
        patch.start()
        self.addCleanup(patch.stop)
        usage = mock.patch.object(crq.usage_slots, "read_usage", return_value=None)
        usage.start()
        self.addCleanup(usage.stop)
        wake = mock.patch.object(crq, "refresh_slot_deadline")
        wake.start()
        self.addCleanup(wake.stop)
        crq.save_queue(self.q)

    # ------------------------------------------------------------ fixtures

    def init_repo(self, path):
        path.mkdir()
        subprocess.run(["git", "init", "-q", "-b", "main"], cwd=path, check=True, capture_output=True)
        subprocess.run(["git", "config", "user.email", "fixture@localhost"], cwd=path, check=True,
                       capture_output=True)
        subprocess.run(["git", "config", "user.name", "fixture"], cwd=path, check=True, capture_output=True)
        return path

    def clone_repo(self, source, path):
        subprocess.run(["git", "clone", "-q", str(source), str(path)], cwd=self.root, check=True,
                       capture_output=True)
        subprocess.run(["git", "config", "user.email", "fixture@localhost"], cwd=path, check=True,
                       capture_output=True)
        subprocess.run(["git", "config", "user.name", "fixture"], cwd=path, check=True, capture_output=True)
        return path

    def git(self, repo, *args, env=None, check=True):
        merged = dict(os.environ)
        merged.update(env or {})
        p = subprocess.run(["git", *args], cwd=str(repo), capture_output=True, text=True, env=merged)
        if check and p.returncode != 0:
            raise AssertionError(f"git {' '.join(args)} failed: {p.stderr.strip()}")
        return p.stdout.strip()

    def ago(self, hours=0, minutes=0):
        return dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=hours, minutes=minutes)

    def iso_of(self, when):
        return when.strftime("%Y-%m-%dT%H:%M:%SZ")

    def commit(self, repo, message, *, when=None, files=None):
        for name, text in (files or {}).items():
            target = Path(repo) / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(text)
        env = {}
        if when:
            stamp = f"@{int(when.timestamp())} +0000"
            env.update({"GIT_AUTHOR_DATE": stamp, "GIT_COMMITTER_DATE": stamp})
        self.git(repo, "add", "-A")
        self.git(repo, "commit", "-qm", message, env=env)
        return self.git(repo, "rev-parse", "HEAD")

    def cfg(self, **over):
        entry = {"repo": FOREIGN, "clone": str(self.foreign), "default_branch": "main",
                 "discovery": {"push": True, "pr": False}, "floor": None, "quiet_minutes": None,
                 "rank_tier": 3, "findings": "issue"}
        entry.update(over)
        return repo_registry.parse_entry(entry)

    def discover(self, dry=False):
        return push_current.discover(crq, self.q, dry)

    def the_item(self):
        items = [i for i in self.q["items"] if i.get("kind") == push_current.KIND]
        self.assertEqual(len(items), 1, [i["id"] for i in self.q["items"]])
        return items[0]

    def enroll_push(self, **over):
        """Floor-init then enroll through real discovery; returns the item."""
        over.setdefault("floor", self.iso_of(self.ago(36)))
        self.repos[0] = self.cfg(**over)
        self.discover()
        self.discover()
        return self.the_item()

    def prepare(self, item):
        return push_current.prepare(crq, self.q, item, False)

    def fake_spawn(self):
        """Popen mock that only fakes the detached _review child; real Popen
        otherwise, because subprocess.run shares the same module object."""
        real_popen = subprocess.Popen

        def fake_child(argv, *args, **kw):
            if argv[0] == sys.executable and "_review" in argv:
                return SimpleNamespace(pid=919191)
            return real_popen(argv, *args, **kw)

        return mock.patch.object(crq.subprocess, "Popen", side_effect=fake_child)

    @staticmethod
    def spawns(child):
        """The faked detached-review launches among all delegated Popen calls."""
        return [c for c in child.call_args_list
                if c.args and c.args[0] and c.args[0][0] == sys.executable and "_review" in c.args[0]]

    def launch(self, item, scan_ok=True):
        """Prepare and launch with the vendor boundary faked."""
        plan = self.prepare(item)
        with mock.patch.object(crq, "secret_scan_diff", return_value=(scan_ok, {"denylist_hits": [],
                                                                                "gitleaks_hits": []})), \
             mock.patch.object(crq, "make_worktree", return_value=(self.root / "wt", "fixture")) as wt, \
             self.fake_spawn() as child:
            run_id = crq.launch(self.q, item, plan)
        return plan, wt, child, run_id

    def terminal_artifacts(self, item, events=None):
        run_id = item["run"]["run_id"]
        rdir = crq.RUNS / run_id
        (rdir / "review.ndjson").write_text("\n".join(json.dumps(e) for e in (events or [COMPLETE])))
        (rdir / "exit.json").write_text(json.dumps({"exit": 0, "ended_at": "immutable-end"}))
        (rdir / "secret-scan.json").write_text("{}")
        (rdir / "review.pid").write_text(json.dumps({"run_id": run_id, "pid": 919191, "pgid": 919191,
            "sid": 919191, "group_owner": crq.author_quota.GROUP_OWNER_MARKER, "cli_pid": 919192}))
        return rdir

    def harvest(self, item, events=None):
        """Direct harvest; asserts no repair/coverage path ever runs for a push item."""
        self.terminal_artifacts(item, events)
        with mock.patch.object(crq, "pid_alive", return_value=False), \
             mock.patch.object(crq, "group_alive", return_value=False), \
             mock.patch.object(crq, "remove_worktree") as remove, \
             mock.patch.object(crq.repair_tick, "enqueue") as repair, \
             mock.patch.object(crq.coverage, "record_review") as record:
            result = crq.harvest_review(self.q, item, False)
        repair.assert_not_called()
        record.assert_not_called()
        return result, remove

    def tick(self):
        """A real tick with only the vendor/process boundary faked."""
        real_popen = subprocess.Popen

        def fake_child(argv, **kw):
            if argv[0] == sys.executable and "_review" in argv:
                return SimpleNamespace(pid=919191)
            return real_popen(argv, **kw)

        with contextlib.ExitStack() as stack:
            stack.enter_context(mock.patch.object(crq, "discover_merged", return_value=[]))
            for name in ("write_status", "write_heartbeat", "notify_owner"):
                stack.enter_context(mock.patch.object(crq, name))
            stack.enter_context(mock.patch.object(crq, "enroll", return_value=[]))
            stack.enter_context(mock.patch.object(crq.repair_tick, "reconcile_fix_prs"))
            stack.enter_context(mock.patch.object(crq, "make_worktree",
                                                  return_value=(self.root / "wt", "fixture")))
            stack.enter_context(mock.patch.object(crq, "secret_scan_diff",
                                                  return_value=(True, {"denylist_hits": [], "gitleaks_hits": []})))
            child = stack.enter_context(mock.patch.object(crq.subprocess, "Popen", side_effect=fake_child))
            crq.with_lock(crq.tick, dry=False, only=None)
            return sum(call.args[0][0] == sys.executable and "_review" in call.args[0]
                       for call in child.call_args_list)

    def events(self):
        return [json.loads(line) for line in crq.EVENTS.read_text().splitlines() if line.strip()]

    def document(self, item):
        return json.loads((self.state / "receipts" / (item["receipt_id"] + ".json")).read_text())

    def scan_result(self, item):
        return json.loads((crq.RUNS / item["run"]["run_id"] / "secret-scan.json").read_text())

    # ------------------------------------------------------------- tests

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

    def test_prepare_applies_exclude_globs(self):
        self.commit(self.foreign_origin, "range work", when=self.ago(2),
                    files={"code.py": "x = 1\n", "vendored/lib.py": "vendor\n", "docs/guide.md": "doc\n"})
        item = self.enroll_push(exclude=["vendored/**", "docs/*"])
        version_calls = []
        original = crq.run

        def counting(argv, **kw):
            if argv == ["coderabbit", "--version"]:
                version_calls.append(argv)
            return original(argv, **kw)

        with mock.patch.object(crq, "run", side_effect=counting):
            plan = self.prepare(item)
            again = self.prepare(item)  # capture is written once, never re-captured
        self.assertEqual(len(version_calls), 1)
        self.assertEqual(again["base"], plan["base"])
        rows = {r["path"]: r for r in item["capture"]["paths"]}
        self.assertEqual(rows["vendored/lib.py"]["disposition"], "excluded-config")
        self.assertIn(FOREIGN, rows["vendored/lib.py"]["reason"])
        self.assertEqual(rows["docs/guide.md"]["disposition"], "excluded-config")
        self.assertEqual(rows["code.py"]["disposition"], "included")
        diff = self.git(self.foreign, "diff", "--name-status", plan["base"], plan["head"])
        self.assertEqual(diff.splitlines(), ["A\tcode.py"])
        self.assertEqual(plan["review_pin"], plan["target"])

    def test_prepare_applies_include_globs(self):
        self.commit(self.foreign_origin, "range work", when=self.ago(2),
                    files={"code.py": "x = 1\n", "vendored/lib.py": "vendor\n", "docs/guide.md": "doc\n"})
        item = self.enroll_push(include=["code.py"])
        plan = self.prepare(item)
        rows = {r["path"]: r for r in item["capture"]["paths"]}
        self.assertEqual(rows["code.py"]["disposition"], "included")
        for path in ("vendored/lib.py", "docs/guide.md"):
            self.assertEqual(rows[path]["disposition"], "excluded-config")
            self.assertIn(FOREIGN, rows[path]["reason"])
        diff = self.git(self.foreign, "diff", "--name-status", plan["base"], plan["head"])
        self.assertEqual(diff.splitlines(), ["A\tcode.py"])

    def test_scope_split_enrolls_followup_with_paths_filter(self):
        big = {f"f{n}.py": "x" * 256000 + "\n" for n in range(9)}  # 8 fit; the 9th overflows 2 MiB
        c1 = self.commit(self.foreign_origin, "big range", when=self.ago(2), files=big)
        item = self.enroll_push(floor=self.iso_of(self.ago(36)))
        plan = self.prepare(item)
        rows = item["capture"]["paths"]
        self.assertEqual(sum(r["disposition"] == "included" for r in rows), 8)
        split = next(r for r in rows if r["disposition"] == "deferred-split")
        followup = next(i for i in self.q["items"] if i["id"] != item["id"])
        self.assertEqual(followup["id"], push_current.part_id(self.repos[0], self.base, c1, 2))
        self.assertEqual(followup["repo"], FOREIGN)
        self.assertEqual(followup["kind"], push_current.KIND)
        self.assertEqual(followup["depends_on"], item["id"])
        self.assertEqual(followup["subject"]["paths_filter"], [split["path"]])
        self.assertIn(followup["id"], split["reason"])
        self.assertIsNotNone(plan)
        # The follow-up part is its own full review of exactly the overflow path.
        fplan = self.prepare(followup)
        self.assertIsNotNone(fplan)
        self.assertEqual([r["path"] for r in followup["capture"]["paths"]], [split["path"]])
        fdiff = self.git(self.foreign, "diff", "--name-status", fplan["base"], fplan["head"])
        self.assertEqual(fdiff.splitlines(), ["A\t" + split["path"]])

    def test_publish_classes_do_not_block_foreign_diff(self):
        self.commit(self.foreign_origin, "fleet prose", when=self.ago(2),
                    files={"notes.md": _FLEET_PROSE})
        item = self.enroll_push(floor=self.iso_of(self.ago(36)))
        with mock.patch.object(crq.shutil, "which", return_value=None), \
             mock.patch.object(crq, "make_worktree", return_value=(self.root / "wt", "fixture")) as wt, \
             self.fake_spawn():
            crq.launch(self.q, item, self.prepare(item))
        self.assertEqual(item["state"], "reviewing")
        wt.assert_called_once()
        scan = self.scan_result(item)
        # Only the four universal secret-shape classes ran: publish vocabulary is
        # primary-only, so this fleet-prose diff is clean.
        self.assertEqual(scan["denylist_rules"], 4)
        self.assertEqual(scan["denylist_hits"], [])

    def test_universal_secret_class_blocks_foreign_diff(self):
        self.commit(self.foreign_origin, "leaked key", when=self.ago(2),
                    files={"deploy.sh": "#!/bin/sh\ncat <<'EOF'\n" + "-----BEGIN " + "OPENSSH PRIVATE KEY-----" + "\nEOF\n"})
        item = self.enroll_push(floor=self.iso_of(self.ago(36)))
        with mock.patch.object(crq.shutil, "which", return_value=None), \
             mock.patch.object(crq, "make_worktree") as wt, \
             self.fake_spawn() as child:
            run_id = crq.launch(self.q, item, self.prepare(item))
        wt.assert_not_called()
        self.assertEqual(self.spawns(child), [])
        self.assertEqual(item["state"], "blocked")
        self.assertEqual(self.q["starts"], [])
        doc = self.document(item)
        self.assertEqual(doc["outcome"], "blocked-secret-scan")
        self.assertEqual(doc["source"]["type"], "push-range")
        scan = json.loads((crq.RUNS / run_id / "secret-scan.json").read_text())
        self.assertEqual([h["rule"] for h in scan["denylist_hits"]], ["class:token-ssh-plumbing"])

    def test_unknown_extra_scan_class_fails_closed(self):
        self.commit(self.foreign_origin, "range work", when=self.ago(2), files={"code.py": "x = 1\n"})
        item = self.enroll_push(floor=self.iso_of(self.ago(36)),
                                scan_extra_classes=["class:does-not-exist"])
        plan = self.prepare(item)
        with mock.patch.object(crq.shutil, "which", return_value=None):
            with self.assertRaises(RuntimeError) as raised:
                crq.launch(self.q, item, plan)
        self.assertIn("unknown denylist rule", str(raised.exception))
        self.assertEqual(item["state"], "pending")
        self.assertEqual(self.q["starts"], [])

    def test_repo_extra_scan_class_blocks(self):
        self.commit(self.foreign_origin, "extra marker", when=self.ago(2),
                    files={"code.py": "value = 1  # fixture-extra-marker\n"})
        item = self.enroll_push(floor=self.iso_of(self.ago(36)),
                                scan_extra_classes=["class:fixture-extra"])
        with mock.patch.object(crq.shutil, "which", return_value=None), \
             mock.patch.object(crq, "make_worktree") as wt, \
             self.fake_spawn():
            run_id = crq.launch(self.q, item, self.prepare(item))
        wt.assert_not_called()
        self.assertEqual(item["state"], "blocked")
        scan = json.loads((crq.RUNS / run_id / "secret-scan.json").read_text())
        self.assertEqual(scan["denylist_rules"], 5)  # four universal classes + the repo extra
        self.assertEqual([h["rule"] for h in scan["denylist_hits"]], ["class:fixture-extra"])

    def test_registry_scan_extra_classes_validation(self):
        for bad in ([5], "class:x", [None], ["a\nb"]):
            with self.subTest(bad=bad):
                with self.assertRaises(ValueError):
                    repo_registry.parse_entry({"repo": FOREIGN, "clone": "/tmp/x", "scan_extra_classes": bad})
        self.assertEqual(repo_registry.parse_entry({"repo": FOREIGN, "clone": "/tmp/x"})["scan_extra_classes"],
                         [])
        self.assertEqual(repo_registry.parse_entry(
            {"repo": FOREIGN, "clone": "/tmp/x", "scan_extra_classes": ["class:x"]})["scan_extra_classes"],
            ["class:x"])

    def test_foreign_push_item_sorts_between_primary_and_backfill(self):
        self.repos[0] = self.cfg(rank_tier=3)
        current = {"id": "current-x", "kind": review_receipt.KIND, "pr": 7, "state": "pending", "order": 1}
        push = {"id": "push-infra-aaaaaaaaa0-bbbbbbbbb0", "kind": push_current.KIND, "pr": 0,
                "repo": FOREIGN, "state": "pending", "order": 2}
        backfill = {"id": "bf-1", "kind": crq.backfill_jobs.KIND, "pr": 0, "state": "pending", "order": 3}
        self.assertEqual(crq.rank(current), 2)
        self.assertEqual(crq.rank(push), 3)
        self.assertEqual(crq.rank(backfill), crq.coverage.COVERAGE_RANK)
        self.assertEqual([i["id"] for i in sorted([backfill, push, current], key=crq.sort_key)],
                         ["current-x", "push-infra-aaaaaaaaa0-bbbbbbbbb0", "bf-1"])

    def test_harvest_advances_reviewed_tip_only_when_counted(self):
        self.repos[0] = self.cfg(floor=self.iso_of(self.ago(36)))
        self.commit(self.foreign_origin, "mid work", when=self.ago(2), files={"b.txt": "b\n"})
        self.assertEqual(self.tick(), 0)   # floor init
        self.assertEqual(self.tick(), 1)   # enroll + launch the push item
        self.q = crq.load_queue()
        item = self.the_item()
        target = item["capture"]["target"]
        self.assertEqual(item["state"], "reviewing")
        self.terminal_artifacts(item)
        self.assertEqual(self.tick(), 0)   # third tick harvests the counted review
        self.q = crq.load_queue()
        item = next(i for i in self.q["items"] if i["id"] == item["id"])
        self.assertEqual(item["state"], "done")
        self.assertEqual(self.q["push_discovery"][FOREIGN]["reviewed_tip"], target)
        doc = self.document(item)
        self.assertTrue(doc["counted"])
        self.assertEqual(doc["outcome"], "terminal-clean")
        self.assertEqual(doc["source"]["repo"], FOREIGN)
        # A failed review never advances the reviewed tip.
        c3 = self.commit(self.foreign_origin, "later work", when=self.ago(1), files={"e.txt": "e\n"})
        self.assertEqual(self.tick(), 1)   # enroll + launch the next range
        self.q = crq.load_queue()
        item2 = next(i for i in self.q["items"]
                     if i.get("kind") == push_current.KIND and i["id"] != item["id"])
        self.assertEqual((item2["subject"]["base"], item2["subject"]["head"]), (target, c3))
        self.assertEqual(item2["state"], "reviewing")
        result, remove = self.harvest(item2, [None, COMPLETE])  # malformed stream: not counted
        self.assertEqual(item2["state"], "pending")
        self.assertTrue(item2.get("not_before"))
        self.assertEqual(self.q["push_discovery"][FOREIGN]["reviewed_tip"], target)
        self.assertFalse(self.document(item2)["counted"])
        remove.assert_called_once()

    def test_review_worktree_skips_smudging_filters(self):
        with mock.patch.object(crq, "remove_worktree"), \
             mock.patch.object(crq, "git") as git:
            path, branch = crq.make_worktree("wt-review", "abc123", clone=self.foreign)
        self.assertEqual(branch, "crq/wt-review")
        self.assertEqual(path, crq.WT_ROOT / f"{crq.WT_PREFIX}wt-review")
        args, kwargs = git.call_args
        self.assertEqual(args[:6], ("-c", "filter.lfs.smudge=", "-c", "filter.lfs.process=",
                                    "worktree", "add"))
        self.assertEqual(kwargs["env"]["GIT_LFS_SKIP_SMUDGE"], "1")
        self.assertEqual(kwargs["cwd"], self.foreign)

    def test_review_worktree_checkout_failure_blocks_cleanly(self):
        # A reviewed repository whose checkout fails (broken smudge/LFS filter,
        # #347) blocks that item; the tick itself survives.
        self.commit(self.foreign_origin, "range work", when=self.ago(2), files={"code.py": "x = 1\n"})
        item = self.enroll_push(floor=self.iso_of(self.ago(36)))
        plan = self.prepare(item)
        with mock.patch.object(crq, "make_worktree",
                               side_effect=RuntimeError("filter 'lfs' smudge failed")), \
             self.fake_spawn() as child:
            run_id = crq.launch(self.q, item, plan)
        self.assertEqual(self.spawns(child), [])
        self.assertTrue(run_id)
        self.assertEqual(item["state"], "blocked")
        self.assertIn("review worktree checkout failed", item["last_error"])
        self.assertIn("smudge failed", item["last_error"])
        self.assertEqual(self.q["starts"], [])
        blocked = [e for e in self.events() if e.get("event") == "blocked"]
        self.assertEqual([e["item"] for e in blocked], [item["id"]])


    def _reviewing_item_with_findings(self, finding):
        """Floor-init tick, enroll+launch tick, then terminal artifacts with findings."""
        self.repos[0] = self.cfg(floor=self.iso_of(self.ago(36)))
        self.commit(self.foreign_origin, "mid work", when=self.ago(2), files={"b.txt": "b\n"})
        self.assertEqual(self.tick(), 0)   # floor init
        self.assertEqual(self.tick(), 1)   # enroll + launch the push item
        self.q = crq.load_queue()
        item = self.the_item()
        self.assertEqual(item["state"], "reviewing")
        self.terminal_artifacts(item, [finding, COMPLETE])
        return item

    def test_pending_delivery_retries_rotate_within_the_cap(self):
        # A permanently failing delivery must not starve later ones: the cap
        # picks the least recently attempted items, never the same head forever.
        base_item = {"repo": FOREIGN, "kind": push_current.KIND, "pr": 0, "state": "done",
                     "subject": {"type": "push-range", "repo": FOREIGN}, "issue_pending": True}
        for item_id, stamp in (("push-infra-a0-b0", "2026-11-03T01:00:00Z"),
                               ("push-infra-a1-b1", "2026-11-03T02:00:00Z")):
            self.q["items"].append({**base_item, "id": item_id, "issue_attempt_at": stamp})
        never = {**base_item, "id": "push-infra-c0-d0"}
        self.q["items"].append(never)
        crq.save_queue(self.q)
        attempted = []
        with mock.patch.object(crq, "_deliver_push_findings",
                               side_effect=lambda q, i: attempted.append(i["id"])), \
             self.fake_spawn():
            self.tick()
        self.assertEqual(attempted, [never["id"], "push-infra-a0-b0"])

    def test_counted_findings_file_a_repo_issue_after_the_receipt(self):
        finding = {"type": "finding", "severity": "major", "path": "b.txt",
                   "blob": "0" * 40, "intervals": [[1, 2]], "title": "t", "body": "b"}
        item = self._reviewing_item_with_findings(finding)
        filed = {"issue_url": "https://github.com/camerontaylor/infra/issues/3",
                 "issue_number": 3, "created": True}
        with mock.patch.object(crq.finding_issues, "file_issue", return_value=filed) as file_issue:
            self.assertEqual(self.tick(), 0)   # harvests the counted review
        self.q = crq.load_queue()
        done = next(i for i in self.q["items"] if i["id"] == item["id"])
        self.assertEqual(done["state"], "done")
        self.assertEqual(done["issue"], filed)
        self.assertFalse(done.get("issue_pending"))
        meta = file_issue.call_args.kwargs["meta"]
        self.assertEqual(meta["repo"], FOREIGN)
        self.assertEqual(meta["base"], done["subject"]["base"])
        self.assertEqual(meta["head"], done["subject"]["head"])
        self.assertEqual(meta["receipt_id"], done["receipt_id"])
        self.assertEqual(self.q["push_discovery"][FOREIGN]["reviewed_tip"], done["capture"]["target"])

    def test_gh_failure_keeps_the_review_terminal_and_the_delivery_pending(self):
        finding = {"type": "finding", "severity": "critical", "path": "b.txt",
                   "blob": "0" * 40, "intervals": [[1, 2]], "title": "t", "body": "b"}
        item = self._reviewing_item_with_findings(finding)
        target = item["capture"]["target"]
        with mock.patch.object(crq.finding_issues, "file_issue",
                               side_effect=RuntimeError("gh … exit 1: denied")):
            self.assertEqual(self.tick(), 0)   # harvest stays counted; delivery fails
        self.q = crq.load_queue()
        done = next(i for i in self.q["items"] if i["id"] == item["id"])
        self.assertEqual(done["state"], "done")  # the review stays terminal
        self.assertTrue(done["issue_pending"])
        self.assertIn("denied", done["issue_error"])
        self.assertEqual(self.q["push_discovery"][FOREIGN]["reviewed_tip"], target)


if __name__ == "__main__":
    unittest.main()
