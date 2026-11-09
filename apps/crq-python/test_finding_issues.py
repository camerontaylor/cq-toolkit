"""finding_issues: GitHub-issue delivery of non-primary-repo findings (docs/multi-repo.md)."""
import json
import unittest
from unittest import mock
from types import SimpleNamespace

import finding_issues

REPO = "camerontaylor/infra"
CFG = {"repo": REPO, "findings": "issue"}
BASE, HEAD = "aaaaaaaaaa1111", "bbbbbbbbbb2222"
META = {"repo": REPO, "item_id": "push-infra-aaaaaaaaaa-bbbbbbbbbb",
        "run_id": "r-20261103T120000Z-abcd", "base": BASE, "head": HEAD,
        "receipt_id": "c" * 64}
COUNTS = {"critical": 1, "major": 1, "minor": 1}
MD = "### Findings\n\n- something\n"
TITLE = finding_issues.title(BASE, HEAD, COUNTS, META["item_id"])
SEARCH_ARGV = ["gh", "issue", "list", "--repo", REPO, "--state", "all", "--limit", "20",
               "--json", "number,title,url", "--search", f'in:title "{TITLE}"']
CREATE_ARGV = ["gh", "issue", "create", "--repo", REPO, "--title", TITLE, "--body-file", "-"]
EXISTING = {"number": 7, "url": f"https://github.com/{REPO}/issues/7", "title": TITLE}


def ok(stdout="", stderr="", returncode=0):
    return SimpleNamespace(returncode=returncode, stdout=stdout, stderr=stderr)


class FakeGh:
    """Scripted gh: records every call, replays one result per call in order."""

    def __init__(self, *results):
        self.results = list(results)
        self.calls = []

    def __call__(self, argv, *, input_text=None):
        self.calls.append({"argv": argv, "input_text": input_text})
        result = self.results.pop(0)
        if isinstance(result, Exception):
            raise result
        return result


class EnabledTests(unittest.TestCase):
    def test_explicit_issue_enabled(self):
        self.assertTrue(finding_issues.enabled({"findings": "issue"}))

    def test_explicit_none_disabled(self):
        self.assertFalse(finding_issues.enabled({"findings": "none"}))

    def test_absent_key_defaults_to_issue(self):
        self.assertTrue(finding_issues.enabled({"repo": REPO}))
        self.assertTrue(finding_issues.enabled({}))


class TitleTests(unittest.TestCase):
    def test_exact_format_with_blocking(self):
        self.assertEqual(TITLE, f"crq: {BASE[:10]}..{HEAD[:10]} — 3 findings (2 blocking) "
                                f"[{META['item_id']}]")

    def test_item_identity_distinguishes_split_parts(self):
        parent = finding_issues.title(BASE, HEAD, COUNTS, "push-infra-aaaaaaaaaa-bbbbbbbbbb")
        part = finding_issues.title(BASE, HEAD, COUNTS, "push-infra-aaaaaaaaaa-bbbbbbbbbb-p2")
        self.assertNotEqual(parent, part)

    def test_zero_blocking(self):
        self.assertEqual(finding_issues.title(BASE, HEAD, {"minor": 2}),
                         f"crq: {BASE[:10]}..{HEAD[:10]} — 2 findings (0 blocking)")

    def test_empty_counts(self):
        self.assertEqual(finding_issues.title(BASE, HEAD, {}),
                         f"crq: {BASE[:10]}..{HEAD[:10]} — 0 findings (0 blocking)")

    def test_missing_severity_keys_count_zero(self):
        self.assertEqual(finding_issues.title(BASE, HEAD, {"major": 1}),
                         f"crq: {BASE[:10]}..{HEAD[:10]} — 1 findings (1 blocking)")

    def test_short_refs_unchanged(self):
        self.assertEqual(finding_issues.title("abc", "def", {}), "crq: abc..def — 0 findings (0 blocking)")


class BodyTests(unittest.TestCase):
    def test_identity_fields_when_present(self):
        text = finding_issues.body(META, MD)
        self.assertIn(f"- Repo: `{REPO}`", text)
        self.assertIn(f"- Item: `{META['item_id']}`", text)
        self.assertIn(f"- Run: `{META['run_id']}`", text)
        self.assertIn(f"- Range: `{BASE}..{HEAD}`", text)
        self.assertIn(f"- Receipt: `{META['receipt_id']}`", text)
        self.assertIn("- something", text)
        self.assertTrue(text.rstrip("\n").endswith(finding_issues.FOOTER))

    def test_absent_fields_degrade_cleanly(self):
        text = finding_issues.body({}, MD)
        self.assertIn("- Range: `..`", text)
        self.assertNotIn("Receipt", text)
        self.assertTrue(text.rstrip("\n").endswith(finding_issues.FOOTER))
        self.assertIn("- something", text)

    def test_body_exactly_at_the_limit_is_not_truncated(self):
        room = finding_issues.MAX_BODY - len(finding_issues.body(META, ""))
        text = finding_issues.body(META, "x" * room)
        self.assertEqual(len(text), finding_issues.MAX_BODY)
        self.assertNotIn(finding_issues.TRUNCATED.strip(), text)
        self.assertTrue(text.rstrip("\n").endswith(finding_issues.FOOTER))

    def test_oversized_findings_are_truncated_to_the_limit(self):
        text = finding_issues.body(META, "x" * (finding_issues.MAX_BODY + 5000))
        self.assertEqual(len(text), finding_issues.MAX_BODY)
        self.assertIn(finding_issues.TRUNCATED.strip(), text)
        self.assertIn(f"- Receipt: `{META['receipt_id']}`", text)
        self.assertTrue(text.rstrip("\n").endswith(finding_issues.FOOTER))


class FileIssueTests(unittest.TestCase):
    def test_real_gh_calls_have_short_timeout(self):
        with mock.patch.object(finding_issues.subprocess, 'run', return_value=ok('[]')) as run:
            finding_issues._gh(['gh', 'issue', 'list'])
        self.assertEqual(run.call_args.kwargs['timeout'], 10)

    def test_disabled_repo_is_noop_without_gh_calls(self):
        fake = FakeGh()
        result = finding_issues.file_issue({"repo": REPO, "findings": "none"}, base=BASE, head=HEAD,
                                           meta=META, severity_counts=COUNTS, findings_md=MD, gh=fake)
        self.assertEqual(result, {"issue_url": None, "issue_number": None, "created": False})
        self.assertEqual(fake.calls, [])

    def test_existing_exact_title_is_reused_without_creating(self):
        fake = FakeGh(ok(json.dumps([EXISTING]) + "\n"))
        result = finding_issues.file_issue(CFG, base=BASE, head=HEAD, meta=META,
                                           severity_counts=COUNTS, findings_md=MD, gh=fake)
        self.assertEqual(result, {"issue_url": EXISTING["url"], "issue_number": 7, "created": False})
        self.assertEqual(len(fake.calls), 1)
        self.assertEqual(fake.calls[0]["argv"], SEARCH_ARGV)
        self.assertIsNone(fake.calls[0]["input_text"])

    def test_title_match_is_case_sensitive(self):
        other = dict(EXISTING, title=TITLE.upper())
        fake = FakeGh(ok(json.dumps([other])), ok(f"https://github.com/{REPO}/issues/9\n"))
        result = finding_issues.file_issue(CFG, base=BASE, head=HEAD, meta=META,
                                           severity_counts=COUNTS, findings_md=MD, gh=fake)
        self.assertEqual(result, {"issue_url": f"https://github.com/{REPO}/issues/9",
                                  "issue_number": 9, "created": True})
        self.assertEqual([c["argv"] for c in fake.calls], [SEARCH_ARGV, CREATE_ARGV])

    def test_create_passes_body_on_stdin_and_parses_url(self):
        fake = FakeGh(ok("[]\n"), ok(f"\nhttps://github.com/{REPO}/issues/12\n"))
        result = finding_issues.file_issue(CFG, base=BASE, head=HEAD, meta=META,
                                           severity_counts=COUNTS, findings_md=MD, gh=fake)
        self.assertEqual(result, {"issue_url": f"https://github.com/{REPO}/issues/12",
                                  "issue_number": 12, "created": True})
        self.assertEqual([c["argv"] for c in fake.calls], [SEARCH_ARGV, CREATE_ARGV])
        stdin = fake.calls[1]["input_text"]
        self.assertIn(f"- Item: `{META['item_id']}`", stdin)
        self.assertIn(f"- Range: `{BASE}..{HEAD}`", stdin)
        self.assertIn("- something", stdin)
        self.assertTrue(stdin.rstrip("\n").endswith(finding_issues.FOOTER))
        self.assertIsNone(fake.calls[0]["input_text"])

    def test_gh_failure_raises_runtime_error_with_stderr(self):
        fake = FakeGh(ok("", stderr="  exit 1:GraphQL: Could not resolve to an Issue  \n", returncode=1))
        with self.assertRaises(RuntimeError) as caught:
            finding_issues.file_issue(CFG, base=BASE, head=HEAD, meta=META,
                                      severity_counts=COUNTS, findings_md=MD, gh=fake)
        self.assertIn("GraphQL: Could not resolve to an Issue", str(caught.exception))
        self.assertEqual(len(fake.calls), 1)

    def test_gh_spawn_failure_is_a_runtime_error(self):
        fake = FakeGh(OSError("no gh binary"))
        with self.assertRaises(RuntimeError):
            finding_issues.file_issue(CFG, base=BASE, head=HEAD, meta=META,
                                      severity_counts=COUNTS, findings_md=MD, gh=fake)

    def test_create_without_url_raises(self):
        fake = FakeGh(ok("[]\n"), ok("nothing here\n"))
        with self.assertRaises(RuntimeError) as caught:
            finding_issues.file_issue(CFG, base=BASE, head=HEAD, meta=META,
                                      severity_counts=COUNTS, findings_md=MD, gh=fake)
        self.assertIn("no issue URL", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
