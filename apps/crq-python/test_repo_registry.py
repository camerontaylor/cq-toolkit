"""repo_registry: per-repo config parsing, rank mapping, scope globs (docs/multi-repo.md)."""
import unittest

import repo_registry

PRIMARY = "camerontaylor/cq-toolkit"


def entry(**over):
    base = {"repo": "camerontaylor/infra", "clone": "/srv/crq/infra"}
    base.update(over)
    return base


class ParseTests(unittest.TestCase):
    def test_missing_repos_key_keeps_single_repo(self):
        self.assertEqual(repo_registry.parse({"repo": PRIMARY}), [])
        self.assertEqual(repo_registry.parse({"repo": PRIMARY, "repos": []}), [])

    def test_defaults(self):
        (cfg,) = repo_registry.parse({"repo": PRIMARY, "repos": [entry()]})
        self.assertEqual(cfg["repo"], "camerontaylor/infra")
        self.assertEqual(cfg["name"], "infra")
        self.assertEqual(cfg["default_branch"], "main")
        self.assertEqual(cfg["default_ref"], "origin/main")
        self.assertTrue(cfg["push"])
        self.assertFalse(cfg["pr"])
        self.assertIsNone(cfg["floor"])
        self.assertIsNone(cfg["quiet_minutes"])
        self.assertEqual(cfg["include"], ["**"])
        self.assertEqual(cfg["exclude"], [])
        self.assertEqual(cfg["rank_tier"], repo_registry.DEFAULT_RANK)
        self.assertEqual(cfg["findings"], "issue")

    def test_explicit_values(self):
        (cfg,) = repo_registry.parse({"repo": PRIMARY, "repos": [entry(
            default_branch="trunk", discovery={"push": False, "pr": True},
            clone="  /srv/crq/infra  ",
            floor="2026-11-10T00:00:00Z", quiet_minutes=15, include=["bin/**"],
            exclude=["**/*.png", "secrets/*"], rank_tier=2, findings="none")]})
        self.assertEqual(cfg["default_ref"], "origin/trunk")
        self.assertEqual(cfg["clone"], "/srv/crq/infra")  # surrounding whitespace stripped
        self.assertFalse(cfg["push"])
        self.assertTrue(cfg["pr"])
        self.assertEqual(cfg["floor"], "2026-11-10T00:00:00Z")
        self.assertEqual(cfg["quiet_minutes"], 15)
        self.assertEqual(cfg["rank_tier"], 2)
        self.assertEqual(cfg["findings"], "none")

    def test_primary_repo_duplication_refused(self):
        with self.assertRaises(ValueError):
            repo_registry.parse({"repo": PRIMARY, "repos": [entry(repo=PRIMARY)]})

    def test_duplicate_repo_refused(self):
        with self.assertRaises(ValueError):
            repo_registry.parse({"repo": PRIMARY, "repos": [entry(), entry()]})

    def test_repo_identity_is_case_insensitive(self):
        # GitHub treats owner/name as case-insensitive: one repository, not two.
        with self.assertRaisesRegex(ValueError, "duplicated"):
            repo_registry.parse({"repo": PRIMARY, "repos": [
                entry(), entry(repo="CameronTaylor/Infra", clone="/srv/crq/infra2")]})
        with self.assertRaisesRegex(ValueError, "primary repo"):
            repo_registry.parse({"repo": PRIMARY, "repos": [entry(repo=PRIMARY.upper())]})
        with self.assertRaisesRegex(ValueError, "name collides"):
            repo_registry.parse({"repo": PRIMARY, "repos": [
                entry(), entry(repo="other/Infra", clone="/srv/crq/infra2")]})

    def test_duplicate_name_suffix_refused(self):
        with self.assertRaisesRegex(ValueError, "name collides"):
            repo_registry.parse({"repo": PRIMARY, "repos": [
                entry(), entry(repo="other/infra", clone="/srv/crq/infra2")]})

    def test_unknown_key_refused(self):
        with self.assertRaises(ValueError):
            repo_registry.parse({"repo": PRIMARY, "repos": [entry(priority=1)]})

    def test_bad_shapes_refused(self):
        base = {"repo": PRIMARY}
        for bad in (
            {"repos": {"repo": "a/b"}},                              # not a list
            {"repos": ["camerontaylor/infra"]},                      # not an object
            {"repos": [entry(repo="infra")]},                        # not owner/name
            {"repos": [entry(repo="camerontaylor/a b")]},            # space in slug
            {"repos": [entry(clone="")]},                            # missing clone path
            {"repos": [entry(default_branch="-main")]},              # bad branch
            {"repos": [entry(default_branch="a..b")]},
            {"repos": [entry(default_branch="a//b")]},
            {"repos": [entry(default_branch="refs.lock")]},
            {"repos": [entry(discovery={"pushes": True})]},          # unknown mode key
            {"repos": [entry(discovery={"push": "yes"})]},           # non-bool
            {"repos": [entry(floor="2026-11-10")]},                  # not an ISO Z timestamp
            {"repos": [entry(floor="2026-13-40T99:00:00Z")]},
            {"repos": [entry(quiet_minutes=0)]},
            {"repos": [entry(quiet_minutes="30")]},
            {"repos": [entry(rank_tier=1)]},                         # below MIN_RANK
            {"repos": [entry(rank_tier=5)]},                         # above MAX_RANK
            {"repos": [entry(rank_tier=3.0)]},
            {"repos": [entry(findings="comment")]},                  # unsupported mode
            {"repos": [entry(include=[])]},                          # include may not be empty
            {"repos": [entry(exclude=["a\nb"])]},                    # newline in glob
        ):
            with self.assertRaises(ValueError, msg=repr(bad)):
                repo_registry.parse({**base, **bad})


class RankTests(unittest.TestCase):
    def setUp(self):
        self.repos = repo_registry.parse({"repo": PRIMARY, "repos": [
            entry(rank_tier=2), entry(repo="camerontaylor/hart", clone="/srv/crq/hart")]})

    def test_legacy_and_primary_items_keep_kind_rank(self):
        self.assertIsNone(repo_registry.rank_for({"kind": "open"}, PRIMARY, self.repos))
        self.assertIsNone(repo_registry.rank_for({"kind": "open", "repo": PRIMARY}, PRIMARY, self.repos))

    def test_primary_and_configured_lookups_are_case_insensitive(self):
        # A differently-cased primary item keeps its kind rank (never DEFAULT_RANK).
        self.assertIsNone(repo_registry.rank_for(
            {"kind": "open", "repo": PRIMARY.upper()}, PRIMARY, self.repos))
        configured = repo_registry.by_repo(self.repos, "CameronTaylor/Infra")
        self.assertEqual(configured["rank_tier"], 2)
        self.assertEqual(repo_registry.rank_for(
            {"kind": "push-current", "repo": "CameronTaylor/Infra"}, PRIMARY, self.repos), 2)

    def test_foreign_repo_uses_configured_tier(self):
        self.assertEqual(repo_registry.rank_for(
            {"kind": "push-current", "repo": "camerontaylor/infra"}, PRIMARY, self.repos), 2)
        self.assertEqual(repo_registry.rank_for(
            {"kind": "push-current", "repo": "camerontaylor/hart"}, PRIMARY, self.repos), 3)

    def test_unknown_repo_defaults_between_ordinary_and_backfill(self):
        rank = repo_registry.rank_for({"kind": "open", "repo": "camerontaylor/gone"}, PRIMARY, self.repos)
        self.assertEqual(rank, repo_registry.DEFAULT_RANK)
        self.assertGreater(rank, 2)
        self.assertLess(rank, 4)


class ScopeTests(unittest.TestCase):
    def setUp(self):
        (self.cfg,) = repo_registry.parse({"repo": PRIMARY, "repos": [
            entry(exclude=["**/*.png", "vendored/**"])]})

    def test_default_include_matches_everything(self):
        self.assertTrue(repo_registry.in_scope(self.cfg, "bin/deploy.sh"))

    def test_exclude_wins(self):
        self.assertFalse(repo_registry.in_scope(self.cfg, "assets/logo.png"))
        self.assertFalse(repo_registry.in_scope(self.cfg, "vendored/lib/a.js"))

    def test_star_crosses_slash(self):
        (cfg,) = repo_registry.parse({"repo": PRIMARY, "repos": [entry(
            include=["dist/*"], exclude=[])]})
        self.assertTrue(repo_registry.in_scope(cfg, "dist/a/b.js"))
        self.assertFalse(repo_registry.in_scope(cfg, "src/a.js"))


if __name__ == "__main__":
    unittest.main()
