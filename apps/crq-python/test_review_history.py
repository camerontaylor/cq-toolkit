"""S3a: advisory history, predecessor classification and degraded cues."""
import json
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest

import author_snapshot
import crq
import review_admission as admission
import review_history as history
import review_operation as operation
import review_transport as transport
from test_author_snapshot_fixtures import SnapshotGitFixture

REPO = "camerontaylor/cq-toolkit"
FACTS_PROFILE = {"adapter": "coderabbit-cli", "revision": "committed-full-diff-v1"}


def facts(*, base, base_tree, head, head_tree):
    return dict(v=1, repo=REPO, base_commit=base, base_tree=base_tree, head_commit=head,
                head_tree=head_tree, scope="full-diff", projection="full-diff",
                config_digest="c" * 64, profile=FACTS_PROFILE)


def item(name, resolved, *, task=None, branch=None, created="2026-11-01T00:00:00Z",
         state="done", receipt=True, target="main"):
    return dict(id=name, kind=operation.KIND, repo=REPO, target=target,
                identity="a" * 64, identity_inputs=resolved,
                profile={**FACTS_PROFILE, "flags": []}, generation=1,
                repeat_requested=False, ancestry_repeat=False, observers=[],
                notify=[], state=state, pr=None, created_at=created, order=1,
                cycles=[], attempts=[], failures=0, depends_on=[],
                scope_adequate=True, receipt_id=("f" * 64) if receipt else None,
                task=task, branch=branch)


def queue(*items):
    q = {"items": list(items), "review_requests": {}}
    for index, row in enumerate(items):
        q["review_requests"][f"req-{index}"] = dict(v=1, key_digest="b" * 64,
                                                    identity=row["identity"],
                                                    item=row["id"],
                                                    created_at=row["created_at"])
    return q


class HistoryGitMixin:
    def hist_git(self):
        def run(*args):
            try:
                return author_snapshot.git(self.repo, *args)
            except author_snapshot.AuthorRefused as exc:
                raise history.GitUnavailable(str(exc)) from exc
        return run

    def git_at(self, repo):
        def run(*args):
            try:
                return author_snapshot.git(repo, *args)
            except author_snapshot.AuthorRefused as exc:
                raise history.GitUnavailable(str(exc)) from exc
        return run

    def project(self, q, **kw):
        target = kw.pop("target", "main")
        value = history.project(q, repo=REPO, target=target,
                                head_commit=kw.pop("head", self.head),
                                head_tree=kw.pop("head_tree", self.changed_tree),
                                git=kw.pop("git", self.hist_git()), **kw)
        operation.validate("history", value)
        return value


class ExampleTests(HistoryGitMixin, SnapshotGitFixture, unittest.TestCase):
    """Spec §6 examples: verified ancestry, unrelated work, unknown data."""

    def test_a6_new_head_follows_reviewed_task_head(self):
        q = queue(item("lr-a", facts(base=self.base, base_tree=self.base_tree,
                                     head=self.base, head_tree=self.base_tree), task="T"))
        result = self.project(q, task="T")
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["relation"], "ancestral")
        self.assertTrue(result["repeat"])
        self.assertEqual(result["predecessor"]["ancestry"], "server")
        self.assertEqual(result["delta"]["commits_ahead"], 1)
        self.assertEqual(result["delta"]["files"], 1)
        self.assertGreater(result["delta"]["insertions"], 0)
        self.assertIn("server-verified", result["cue"])
        self.assertIn("wait behind first reviews", result["cue"])

    def test_a7_main_ancestor_and_unrelated_sibling_earn_no_repeat(self):
        q = queue(item("lr-main", facts(base=self.base_tree, base_tree=self.base_tree,
                                        head=self.base, head_tree=self.base_tree),
                       branch="main"))
        # A main/target review alone never establishes same work.
        self.assertFalse(self.project(q, branch="main")["repeat"])
        self.assertEqual(self.project(q, branch="main")["relation"], "none")
        # An unrelated sibling in the same task is visible, not a repeat.
        sibling = self.commit(self.tree(b"sibling\n"), self.base)
        q = queue(item("lr-sib", facts(base=self.base, base_tree=self.base_tree,
                                       head=sibling, head_tree=self.tree(b"sibling\n")),
                       task="T"))
        result = self.project(q, task="T")
        self.assertFalse(result["repeat"])
        self.assertEqual(result["relation"], "none")
        self.assertEqual(result["entries"][0]["relationship"], "unrelated")

    def test_a8_branch_reuse_or_rebase_has_no_fabricated_ancestry(self):
        missing = self.commit(self.tree(b"rewritten\n"), self.base)
        q = queue(item("lr-old", facts(base=self.base, base_tree=self.base_tree,
                                       head=missing, head_tree=self.tree(b"rewritten\n")),
                       branch="shared"))
        real = self.hist_git()

        def unavailable(*args):
            if args[:2] == ("cat-file", "-e") and args[2].startswith(missing):
                raise history.GitUnavailable("object missing")
            if args[:2] == ("merge-base", "--is-ancestor"):
                raise history.GitUnavailable("object missing")
            return real(*args)
        result = self.project(q, branch="shared", git=unavailable)
        self.assertEqual(result["relation"], "possible")
        self.assertFalse(result["repeat"])
        self.assertIsNone(result["predecessor"]["ancestry"])
        self.assertIn("Possible earlier review", result["cue"])
        self.assertNotIn("wait behind", result["cue"])

    def test_a10_binary_and_shallow_data_are_unknown_not_zero(self):
        blob = self.git("hash-object", "-w", "--stdin", data=b"\x00\x01\x02")
        binary = self.git("mktree", data=f"100644 blob {blob}\timage.bin\n".encode())
        binary_commit = self.commit(binary, self.base)
        q = queue(item("lr-bin", facts(base=self.base, base_tree=self.base_tree,
                                       head=self.base, head_tree=self.base_tree), task="T"))
        result = self.project(q, task="T", head=binary_commit, head_tree=binary)
        self.assertGreaterEqual(result["delta"]["files"], 1)
        self.assertEqual(result["delta"]["binary_files"], 1)
        self.assertIsNone(result["delta"]["insertions"])
        self.assertIsNone(result["delta"]["deletions"])
        self.assertTrue(result["delta"]["partial"])
        real = self.hist_git()

        def shallow(*args):
            if args[:2] == ("cat-file", "-e") and args[2].startswith(self.base):
                raise history.GitUnavailable("shallow")
            if args[:2] == ("rev-list", "--count"):
                raise history.GitUnavailable("shallow")
            return real(*args)
        shallow_result = self.project(q, task="T", head=binary_commit,
                                      head_tree=binary, git=shallow)
        self.assertIsNone(shallow_result["delta"]["commits_ahead"])
        self.assertNotEqual(shallow_result["delta"]["commits_ahead"], 0)

    def test_a19_same_branch_string_alone_is_possible_history(self):
        sibling = self.commit(self.tree(b"unrelated\n"), self.base)
        q = queue(item("lr-br", facts(base=self.base, base_tree=self.base_tree,
                                      head=sibling, head_tree=self.tree(b"unrelated\n")),
                       branch="shared"))
        result = self.project(q, branch="shared")
        self.assertFalse(result["repeat"])
        self.assertIn(result["relation"], ("none", "possible"))
        self.assertNotIn("wait behind", result["cue"] or "")

    def test_a24_degraded_projection_is_explicit_and_exact(self):
        value = history.degraded("history index unavailable")
        operation.validate("history", value)
        self.assertEqual(value["status"], "degraded")
        self.assertIn("history index unavailable", value["reason"])
        self.assertIsNone(value["summary"])
        self.assertFalse(value["repeat"])

    def test_explicit_predecessor_outside_repository_is_ignored(self):
        foreign = item("lr-foreign", {**facts(base=self.base, base_tree=self.base_tree,
                                              head=self.base, head_tree=self.base_tree),
                                      "repo": "other/repo"}, task="T")
        result = self.project(queue(foreign), task="T", predecessor="req-0")
        self.assertEqual(result["relation"], "none")
        self.assertEqual(result["entries"], [])
        self.assertFalse(result["repeat"])

    def test_explicit_predecessor_for_other_target_is_ignored(self):
        other_target = item("lr-release", facts(base=self.base, base_tree=self.base_tree,
                                                head=self.base, head_tree=self.base_tree),
                            task="T", target="release")
        result = self.project(queue(other_target), task="T", predecessor="req-0")
        self.assertEqual(result["relation"], "none")
        self.assertEqual(result["entries"], [])
        self.assertFalse(result["repeat"])

    def test_explicit_legacy_predecessor_keeps_link_scope(self):
        legacy = item("lr-legacy", facts(base=self.base, base_tree=self.base_tree,
                                         head=self.base, head_tree=self.base_tree),
                      task=None, target=None)
        result = self.project(queue(legacy), task="T", predecessor="req-0")
        self.assertEqual(result["relation"], "ancestral")
        self.assertTrue(result["repeat"])
        self.assertEqual(result["entries"][0]["request_id"], "req-0")
        self.assertTrue(result["entries"][0]["same_task"])
        self.assertTrue(result["entries"][0]["same_branch"])

    def test_a10_shallow_clone_with_both_endpoints_is_unknown(self):
        with tempfile.TemporaryDirectory() as tmp:
            clone = Path(tmp) / "shallow"
            self.git("update-ref", "refs/heads/shallow-base", self.base)
            self.git("update-ref", "refs/heads/shallow-head", self.head)
            self.git("symbolic-ref", "HEAD", "refs/heads/shallow-head")
            self.git("clone", "-q", "--depth", "1", "file://" + str(self.repo), str(clone))
            self.git("-C", str(clone), "fetch", "-q", "--depth", "1", "origin",
                     "shallow-base:refs/remotes/origin/shallow-base")
            self.assertEqual(
                self.git("-C", str(clone), "rev-parse", "--is-shallow-repository"), "true")
            for rev in (self.base, self.head):
                self.git("-C", str(clone), "cat-file", "-e", rev + "^{commit}")
            q = queue(item("lr-shallow", facts(base=self.base, base_tree=self.base_tree,
                                               head=self.base, head_tree=self.base_tree), task="T"))
            result = self.project(q, task="T", git=self.git_at(clone))
        self.assertEqual(result["relation"], "possible")
        self.assertFalse(result["repeat"])
        self.assertIsNone(result["predecessor"]["ancestry"])
        self.assertEqual(result["entries"][0]["relationship"], "possible")
        self.assertIn("Possible earlier review", result["cue"])

    def test_targetless_legacy_items_need_an_explicit_link(self):
        prior = [item(f"lr-legacy-{index}", facts(base=self.base, base_tree=self.base_tree,
                                                  head=self.base, head_tree=self.base_tree),
                      task="T", target=None) for index in range(2)]
        current = item("lr-current", facts(base=self.base, base_tree=self.base_tree,
                                           head=self.head, head_tree=self.changed_tree),
                       task="T", target=None)
        result = self.project(queue(*prior, current), target=None, task="T",
                              exclude_item=current["id"])
        self.assertEqual(result["relation"], "none")
        self.assertEqual(result["entries"], [])
        self.assertFalse(result["repeat"])

    def test_reverse_ancestry_is_server_verified_unrelated(self):
        child = item("lr-child", facts(base=self.base, base_tree=self.base_tree,
                                       head=self.head, head_tree=self.changed_tree), task="T")
        result = self.project(queue(child), task="T", head=self.base, head_tree=self.base_tree)
        self.assertEqual(result["entries"][0]["relationship"], "unrelated")
        self.assertEqual(result["entries"][0]["ancestry"], "server")
        self.assertFalse(result["repeat"])

    def test_observed_client_ancestry_is_labelled_client(self):
        missing = "e" * 40
        observed_item = item("lr-observed", facts(base=self.base, base_tree=self.base_tree,
                                                  head=missing, head_tree=self.base_tree),
                             task=None, target=None)
        result = self.project(queue(observed_item), task="T", predecessor="req-0",
                              observed={"ancestor": True, "commits_ahead": 2})
        self.assertEqual(result["relation"], "ancestral")
        self.assertTrue(result["repeat"])
        self.assertEqual(result["predecessor"]["ancestry"], "client")
        self.assertEqual(result["delta"]["commits_ahead"], 2)
        self.assertIn("client-verified", result["cue"])

    def test_pagination_is_bounded_and_ordered(self):
        rows = [item(f"lr-{i}", facts(base=self.base, base_tree=self.base_tree,
                                     head=self.base, head_tree=self.base_tree),
                     task="T", created=f"2026-11-0{i}T00:00:00Z") for i in range(1, 4)]
        q = queue(*rows)
        first = self.project(q, task="T", limit=2, cursor=0)
        self.assertEqual(len(first["entries"]), 2)
        self.assertEqual(first["next_cursor"], 2)
        second = self.project(q, task="T", limit=2, cursor=first["next_cursor"])
        self.assertEqual(len(second["entries"]), 1)
        self.assertIsNone(second["next_cursor"])
        with self.assertRaises(ValueError):
            self.project(q, task="T", limit=51)
        with self.assertRaises(ValueError):
            self.project(q, task="T", cursor=-1)


class AdmissionRepeatTests(unittest.TestCase):
    def test_ancestral_repeat_changes_rank_not_identity(self):
        resolved = facts(base="a" * 40, base_tree="b" * 40, head="c" * 40, head_tree="d" * 40)
        inputs = dict(repo=REPO, target="main", base_commit="a" * 40, base_tree="b" * 40,
                      head_commit="c" * 40, head_tree="d" * 40, projection="full-diff")
        profile = {**FACTS_PROFILE, "flags": []}
        q = {"items": [], "review_requests": {}}
        created = admission.admit(q, request_id="one", inputs=inputs, resolved=resolved,
                                  profile=profile, at=crq.iso(),
                                  ancestry_repeat=True)
        row = q["items"][0]
        self.assertTrue(row["ancestry_repeat"])
        self.assertEqual(created["generation"], 1)
        self.assertEqual(crq.rank(row), 1)
        row["created_at"] = "2020-01-01T00:00:00Z"
        self.assertEqual(crq.rank(row), 0)  # aging still bounds repeats
        row.update(ancestry_repeat=False)
        row["created_at"] = crq.iso()
        self.assertEqual(crq.rank(row), 0)


class DegradedTransportTests(unittest.TestCase):
    def test_degraded_projection_keeps_submission_path_unchanged(self):
        # history_projection swallows index failures into a degraded document;
        # the admission path consumes only `repeat`, so reuse is unaffected.
        # An unconfigured repository is a structural index failure, not a
        # missing object: the projection degrades instead of raising.
        runner = SimpleNamespace(REPO="other/place", CLONE=Path("/nonexistent"), REPOS=[])
        value = transport.history_projection({"items": [], "review_requests": {}}, runner,
                                             repo=REPO, target="main")
        operation.validate("history", value)
        self.assertEqual(value["status"], "degraded")
        self.assertFalse(value["repeat"])
        self.assertIsNotNone(value["digest"])
        cue = json.loads(json.dumps(value))
        self.assertEqual(cue["status"], "degraded")
