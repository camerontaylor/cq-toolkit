"""crq findings posted on open PRs across repositories as one pull-request review.

Covers the pure module (anchoring, payload, idempotent delivery with a fake
gh) and the crq integration (debt at harvest, bounded post-harvest pass,
bounded retries). No network: every gh call is faked.
"""
import datetime as dt
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import crq
import pr_review_findings as prf

REPO = crq.REPO
HEAD = "a" * 40
BASE = "b" * 40
PATCH = "@@ -1,3 +1,4 @@\n a\n+b\n c\n d\n@@ -40,2 +41,6 @@\n x\n+y\n"
ANCHORED = {"type": "finding", "severity": "major", "fileName": "src/a.py", "startLine": 2, "endLine": 3,
            "title": "Check the bound", "comment": "**Check the bound**\n\nOff by one.<!-- foreign marker -->",
            "codegenInstructions": "prompt text"}
OUTSIDE = {"type": "finding", "severity": "minor", "fileName": "src/a.py", "startLine": 20, "endLine": 22,
           "title": "Rename", "comment": "Rename it."}
NO_FILE = {"type": "finding", "severity": "minor", "fileName": "docs/x.md", "startLine": 1, "title": "Doc",
           "comment": "Doc gap."}


def write_ndjson(root, events):
    path = Path(root) / "review.ndjson"
    path.write_text("".join(json.dumps(e) + "\n" for e in events))
    return path


class FakeGh:
    """Records argv/stdin; answers by endpoint shape."""

    def __init__(self, state="open", merged=False, existing=None, post=None):
        self.calls = []
        self.state, self.merged, self.existing = state, merged, existing
        self.post = list(post or [(0, json.dumps({"id": 77, "html_url": "https://x/r/77"}), "")])

    login = "crq-host"

    def __call__(self, argv, *, input_text=None):
        self.calls.append((argv, input_text))
        if argv[2:3] == ["user"]:
            return SimpleNamespace(returncode=0, stdout=self.login + "\n", stderr="")
        target = next(a for a in argv[2:] if a.startswith("repos/"))
        if "--method" in argv:
            code, out, err = self.post.pop(0)
            return SimpleNamespace(returncode=code, stdout=out, stderr=err)
        if target.endswith("/reviews?per_page=100"):
            out = json.dumps(self.existing) + "\n" if self.existing else ""
            return SimpleNamespace(returncode=0, stdout=out, stderr="")
        if "/compare/" in target:
            files = [{"filename": "src/a.py", "status": "modified", "patch": PATCH},
                     {"filename": "bin.dat", "status": "modified", "patch": None}]
            return SimpleNamespace(returncode=0, stdout=json.dumps(files), stderr="")
        return SimpleNamespace(returncode=0, stdout=json.dumps(
            {"state": self.state, "merged": self.merged, "base": BASE}), stderr="")

    def posts(self):
        return [json.loads(stdin) for argv, stdin in self.calls if "--method" in argv]


META = {"run_id": "pr7-20261106T000000Z", "item_id": "pr7", "base": BASE, "head": HEAD}


class ModuleTest(unittest.TestCase):
    def setUp(self):
        self.td = tempfile.TemporaryDirectory()
        self.addCleanup(self.td.cleanup)

    def test_independent_summary_explicit_login_and_base(self):
        meta = {**META, "base": "c" * 40, "label": "Independent reviewer", "summary": f"**Independent review (Sol): PASS for `{HEAD}`**"}
        gh = FakeGh()
        result = prf.deliver(REPO, 7, meta, write_ndjson(self.td.name,
            [{**ANCHORED, "severity": "nonblocking"}, OUTSIDE]), gh=gh, login="cq-review[bot]")
        self.assertEqual(result["inline"], 1)
        payload = gh.posts()[0]
        self.assertTrue(payload["body"].startswith(prf.marker(META["run_id"]) + "\n" + meta["summary"]))
        self.assertIn("Independent reviewer", payload["body"])
        self.assertIn("nonblocking", payload["comments"][0]["body"])
        self.assertIn("lines 20-22", payload["body"])
        self.assertFalse(any(argv[2:3] == ["user"] for argv, _ in gh.calls))
        self.assertTrue(any("repos/" + REPO + "/compare/" + "c" * 40 + "..." + HEAD in argv for argv, _ in gh.calls))

    def test_summary_survives_422_and_empty_findings(self):
        meta = {**META, "summary": f"**Independent review (Sol): PASS for `{HEAD}`**"}
        gh = FakeGh(post=[(1, "", "HTTP 422"), (0, '{"id":77}', "")])
        result = prf.deliver(REPO, 7, meta, write_ndjson(self.td.name, [ANCHORED]), gh=gh)
        self.assertEqual(result["body_only"], 1)
        self.assertIn(meta["summary"], gh.posts()[-1]["body"])
        gh = FakeGh()
        self.assertEqual(prf.deliver(REPO, 7, meta, write_ndjson(self.td.name, []), gh=gh)["state"], "created")

    def test_independent_summary_survives_matching_crq_findings(self):
        class MatchingCrqGh(FakeGh):
            def __call__(self, argv, *, input_text=None):
                if "--paginate" in argv and "crq-local-findings head=" in argv[-1]:
                    return SimpleNamespace(returncode=0, stdout='{"id":66,"url":"https://x/r/66"}', stderr="")
                return super().__call__(argv, input_text=input_text)
        meta = {**META, "summary": f"**Independent review (Sol): PASS for `{HEAD}`**"}
        gh = MatchingCrqGh()
        result = prf.deliver(REPO, 7, meta, write_ndjson(self.td.name, [ANCHORED]), gh=gh)
        self.assertEqual(result["state"], "created")
        self.assertIn(meta["summary"], gh.posts()[0]["body"])

    def test_cli_json(self):
        import contextlib
        import io
        body = Path(self.td.name) / "summary.md"
        body.write_text(f"**Independent review (Sol): PASS for `{HEAD}`**")
        findings = write_ndjson(self.td.name, [ANCHORED])
        argv = ["--repo", REPO, "--pr", "7", "--head", HEAD, "--base", BASE,
                "--run-id", "review-cli", "--findings", str(findings), "--body-file", str(body)]
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            self.assertEqual(prf.main(argv, gh=FakeGh()), 0)
        self.assertEqual(json.loads(output.getvalue())["inline"], 1)
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(prf.main(argv + ["--base", "bad"], gh=FakeGh()), 1)

    def test_cli_rejects_malformed_findings_before_network(self):
        import contextlib
        import io
        body = Path(self.td.name) / "summary.md"
        body.write_text(f"**Independent review (Sol): ITERATE for `{HEAD}`**")
        for event in ({"type": "finding"}, {**ANCHORED, "startLine": "2"},
                      {**ANCHORED, "endLine": True}, {**ANCHORED, "fileName": ""}):
            findings = write_ndjson(self.td.name, [event])
            gh = FakeGh()
            with contextlib.redirect_stderr(io.StringIO()):
                result = prf.main(["--repo", REPO, "--pr", "7", "--head", HEAD, "--base", BASE,
                    "--run-id", "invalid-finding", "--findings", str(findings), "--body-file", str(body)], gh=gh)
            self.assertEqual(result, 1)
            self.assertEqual(gh.calls, [])

    def test_script_entrypoint_publishes_and_reports_errors(self):
        import sys
        root = Path(self.td.name)
        body = root / "summary.md"
        summary = f"**Independent review (Sol): ITERATE for `{HEAD}`**"
        body.write_text(summary, encoding="utf-8")
        findings = write_ndjson(root, [ANCHORED])
        calls = root / "calls.ndjson"
        payload = root / "payload.json"
        # Exercise the real script and subprocess boundary, with no real gh or
        # credentials. Each fake gh process records the endpoint it received.
        fake = root / "gh"
        fake.write_text(f"#!{sys.executable}\n" + """
import json
import sys
from pathlib import Path
root = Path(__file__).parent
args = sys.argv[1:]
with (root / 'calls.ndjson').open('a') as log:
    log.write(json.dumps(args) + '\\n')
if (root / 'fail').exists():
    print('mock publication failure', file=sys.stderr)
    sys.exit(1)
if '--method' in args:
    (root / 'payload.json').write_text(sys.stdin.read())
    print(json.dumps({'id': 77, 'html_url': 'https://example.test/review/77'}))
elif args[1] == 'user':
    print('mock-reviewer')
elif '/compare/' in args[1]:
    print(json.dumps([{'filename': 'src/a.py', 'status': 'modified',
                       'patch': '@@ -1,3 +1,3 @@\\n a\\n+b\\n c'}]))
elif '--paginate' not in args:
    print(json.dumps({'state': 'open', 'merged': False}))
""", encoding="utf-8")
        fake.chmod(0o700)
        env = {"PATH": str(root), "PYTHONIOENCODING": "utf-8"}
        argv = [sys.executable, str(Path(prf.__file__).resolve()),
                "--repo", REPO, "--pr", "7", "--head", HEAD, "--base", BASE,
                "--run-id", "script-review", "--reviewer", "Sol",
                "--findings", str(findings), "--body-file", str(body)]

        def run(extra=()):
            return subprocess.run(argv + list(extra), env=env, cwd=root,
                                  capture_output=True, text=True, timeout=20)

        result = run()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, "")
        self.assertEqual(json.loads(result.stdout), {
            "state": "created", "review_id": 77,
            "review_url": "https://example.test/review/77", "inline": 1, "body_only": 0})
        review = json.loads(payload.read_text())
        self.assertEqual(review["commit_id"], HEAD)
        self.assertIn(summary, review["body"])
        self.assertEqual(review["comments"][0]["path"], "src/a.py")
        self.assertEqual(review["comments"][0]["line"], 3)
        self.assertTrue(any(json.loads(line)[1] == "user"
                            for line in calls.read_text().splitlines()))

        before = calls.read_text()
        for extra in (["--base", "bad"], ["--body-file", str(root / "missing")]):
            with self.subTest(extra=extra):
                result = run(extra)
                self.assertEqual(result.returncode, 1)
                self.assertEqual(result.stdout, "")
                self.assertIn("pr_review_findings:", result.stderr)
                self.assertEqual(calls.read_text(), before)
        (root / "fail").touch()
        result = run()
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, "")
        self.assertIn("mock publication failure", result.stderr)

    def test_right_ranges_cover_each_hunk_including_context(self):
        self.assertEqual(prf.right_ranges(PATCH), [(1, 4), (41, 46)])
        self.assertEqual(prf.right_ranges("@@ -3 +3 @@\n-x\n+y\n@@ -9,2 +8,0 @@\n-a\n-b\n"), [(3, 3)])

    def test_anchor_clamps_to_the_first_overlapping_hunk_and_rejects_out_of_diff(self):
        hunks = {"src/a.py": prf.right_ranges(PATCH)}
        f = lambda s, e, p="src/a.py": {"path": p, "start": s, "end": e}
        self.assertEqual(prf.anchor(f(2, 3), hunks),
                         {"path": "src/a.py", "line": 3, "side": "RIGHT", "start_line": 2, "start_side": "RIGHT"})
        self.assertEqual(prf.anchor(f(3, 9), hunks)["line"], 4)
        self.assertEqual(prf.anchor(f(4, 4), hunks), {"path": "src/a.py", "line": 4, "side": "RIGHT"})
        self.assertIsNone(prf.anchor(f(20, 22), hunks))
        self.assertIsNone(prf.anchor(f(2, 3, "other.py"), hunks))
        self.assertIsNone(prf.anchor({"path": "src/a.py", "start": None, "end": None}, hunks))

    def test_duplicate_cli_findings_post_once(self):
        path = write_ndjson(self.td.name, [ANCHORED, ANCHORED, OUTSIDE, {"type": "complete"}])
        self.assertEqual(len(prf.load_findings(path)), 2)

    def test_payload_is_plainly_crq_with_marker_and_no_foreign_markers(self):
        findings = prf.load_findings(write_ndjson(self.td.name, [ANCHORED, OUTSIDE, NO_FILE]))
        review = prf.build_review(META, findings, {"src/a.py": prf.right_ranges(PATCH)})
        self.assertEqual(review["event"], "COMMENT")
        self.assertEqual(review["commit_id"], HEAD)
        self.assertTrue(review["body"].startswith("<!-- crq-findings run=pr7-20261106T000000Z -->\n"))
        self.assertIn("### crq findings (CodeRabbit CLI, local run pr7-20261106T000000Z, bbbbbbbbbb..aaaaaaaaaa)",
                      review["body"])
        self.assertIn("This is not a CodeRabbit PR review.", review["body"])
        self.assertEqual(len(review["comments"]), 1)
        inline = review["comments"][0]
        self.assertEqual((inline["path"], inline["start_line"], inline["line"]), ("src/a.py", 2, 3))
        self.assertTrue(inline["body"].startswith("**crq finding F1 [major]** Check the bound\n\nOff by one."))
        self.assertNotIn("<!--", inline["body"])
        self.assertNotIn("prompt text", inline["body"])
        self.assertIn("**crq finding F2 [minor]** Rename (`src/a.py` lines 20-22)", review["body"])
        self.assertIn("**crq finding F3 [minor]** Doc (`docs/x.md` line 1)", review["body"])
        self.assertEqual(review["body"].count("<!--"), 1)

    def test_suggestion_fences_never_become_committable(self):
        self.assertEqual(prf.clean_text("x\n```suggestion\ny\n```"), "x\n```text\ny\n```")

    def test_mentions_never_notify_but_code_is_untouched(self):
        zwj = "\u200d"
        text = "Ask @alice and @org/team; mail a@b.com.\n`@types/node` stays.\n```js\nimport x from '@scope/pkg'\n```\n"
        cleaned = prf.clean_text(text)
        self.assertIn(f"@{zwj}alice", cleaned)
        self.assertIn(f"@{zwj}org/team", cleaned)
        self.assertIn("a@b.com", cleaned)
        self.assertIn("`@types/node`", cleaned)
        self.assertIn("'@scope/pkg'", cleaned)
        finding = {**OUTSIDE, "title": "Ping @bob", "comment": "cc @carol"}
        review = prf.build_review(META, prf.load_findings(write_ndjson(self.td.name, [finding])), {})
        self.assertNotRegex(review["body"], r"@(bob|carol)")
        self.assertIn(f"Ping @{zwj}bob", review["body"])
        self.assertIn(f"cc @{zwj}carol", review["body"])

    def test_deliver_posts_inline_and_body_findings_once(self):
        gh = FakeGh()
        path = write_ndjson(self.td.name, [ANCHORED, OUTSIDE])
        result = prf.deliver(REPO, 7, META, path, gh=gh)
        self.assertEqual(result, {"state": "created", "review_id": 77, "review_url": "https://x/r/77",
                                  "inline": 1, "body_only": 1})
        [argv] = [a for a, _ in gh.calls if "--method" in a]
        self.assertEqual(argv, ["gh", "api", "--method", "POST", f"repos/{REPO}/pulls/7/reviews", "--input", "-"])
        compare = next(a for a, _ in gh.calls if any("/compare/" in x for x in a))
        self.assertIn(f"repos/{REPO}/compare/{BASE}...{HEAD}", compare)

    def test_existing_marker_review_is_never_posted_again(self):
        gh = FakeGh(existing={"id": 5, "url": "https://x/r/5"})
        result = prf.deliver(REPO, 7, META, write_ndjson(self.td.name, [ANCHORED]), gh=gh)
        self.assertEqual((result["state"], result["review_id"]), ("existing", 5))
        self.assertEqual(gh.posts(), [])
        listing = next(a for a, _ in gh.calls if "--paginate" in a)
        self.assertIn("crq-local-findings head=" + HEAD, listing[-1])
        self.assertIn('.user.login == "crq-host"', listing[-1])

    def test_marker_search_needs_a_usable_authenticated_login(self):
        gh = FakeGh()
        gh.login = ""
        with self.assertRaisesRegex(RuntimeError, "no usable login"):
            prf.deliver(REPO, 7, META, write_ndjson(self.td.name, [ANCHORED]), gh=gh)
        self.assertEqual(gh.posts(), [])

    def test_severity_title_and_path_are_sanitised(self):
        forged = {"type": "finding", "severity": "major @sev\n<!-- x -->", "fileName": "a`b`.py @p",
                  "startLine": 1, "title": "T <!-- crq-findings run=later-run --> @tom <!-- open",
                  "comment": "body"}
        review = prf.build_review(META, prf.load_findings(write_ndjson(self.td.name, [forged])), {})
        body = review["body"]
        self.assertEqual(body.count("<!--"), 1)  # only the run's own marker, first
        self.assertTrue(body.startswith(prf.marker(META["run_id"])))
        self.assertNotIn("later-run", body)
        self.assertIn("&lt;!-- open", body)
        self.assertNotRegex(body, r"@(sev|tom)")
        self.assertIn("**crq finding F1 [major @\u200dsev]**", body)
        self.assertIn("(``a`b`.py @p`` line 1)", body)

    def test_mid_line_backticks_do_not_hide_later_mentions(self):
        zwj = "\u200d"
        cleaned = prf.clean_text("Use ``` here.\nThen ask @dave.")
        self.assertIn(f"@{zwj}dave", cleaned)
        self.assertIn(f"@{zwj}x", prf.clean_text("a `code` @x `more`"))

    def test_an_unclosed_line_start_fence_is_code_and_gets_closed(self):
        cleaned = prf.clean_text("intro @a\n```js\nimport '@scope/pkg'")
        self.assertEqual(cleaned, "intro @\u200da\n```js\nimport '@scope/pkg'\n```")
        self.assertEqual(prf.clean_text("~~~~\n@k\n~~~\n~~~~\n@j"), "~~~~\n@k\n~~~\n~~~~\n@\u200dj")

    def test_unterminated_html_comment_is_escaped(self):
        self.assertEqual(prf.clean_text("keep <!-- hidden rest"), "keep &lt;!-- hidden rest")
        self.assertEqual(prf.clean_text("a <!-- gone --> b"), "a  b")

    def test_closed_or_merged_pr_is_skipped_without_posting(self):
        for gh in (FakeGh(state="closed"), FakeGh(state="closed", merged=True)):
            result = prf.deliver(REPO, 7, META, write_ndjson(self.td.name, [ANCHORED]), gh=gh)
            self.assertEqual(result["state"], "skipped-closed")
            self.assertEqual(gh.posts(), [])

    def test_validation_422_falls_back_to_one_body_only_review(self):
        gh = FakeGh(post=[(1, "", "gh: Validation Failed (HTTP 422)"),
                          (0, json.dumps({"id": 9, "html_url": "u"}), "")])
        result = prf.deliver(REPO, 7, META, write_ndjson(self.td.name, [ANCHORED, OUTSIDE]), gh=gh)
        first, second = gh.posts()
        self.assertEqual(len(first["comments"]), 1)
        self.assertEqual(second["comments"], [])
        self.assertNotIn("commit_id", second)
        self.assertIn("**crq finding F1 [major]** Check the bound (`src/a.py` lines 2-3)", second["body"])
        self.assertEqual((result["inline"], result["body_only"]), (0, 2))

    def test_other_post_failures_raise_for_a_later_retry(self):
        gh = FakeGh(post=[(1, "", "HTTP 502: bad gateway")])
        with self.assertRaisesRegex(RuntimeError, "502"):
            prf.deliver(REPO, 7, META, write_ndjson(self.td.name, [ANCHORED]), gh=gh)
        self.assertEqual(len(gh.posts()), 1)

    def test_timeout_is_a_runtime_error(self):
        def slow(argv, *, input_text=None):
            raise subprocess.TimeoutExpired(argv, 60)
        with self.assertRaisesRegex(RuntimeError, "timed out"):
            prf.deliver(REPO, 7, META, write_ndjson(self.td.name, [ANCHORED]), gh=slow)

    def test_invalid_identity_is_refused_before_any_gh_call(self):
        gh = FakeGh()
        with self.assertRaises(ValueError):
            prf.deliver(REPO, 7, {**META, "run_id": "bad run -->"}, write_ndjson(self.td.name, [ANCHORED]), gh=gh)
        self.assertEqual(gh.calls, [])

    def test_clip_closes_severed_fence_with_full_opener_run(self):
        """R4 F1: the closure is the full opener run, not three characters."""
        for opener in ("```", "````", "`````", "~~~", "~~~~~"):
            with self.subTest(opener=opener):
                cut = prf._clip(opener + "py\n@user\n" + "x" * 12000, 200)
                body, sep, trailer = cut.partition("\n\n… (truncated")
                self.assertNotEqual(sep, "", "truncation trailer must be present")
                self.assertTrue(body.endswith("\n" + opener),
                                f"{opener}: cut must close with the full run")
                self.assertTrue(trailer.startswith("; full text in the crq run artifacts)"))

    def test_clip_tab_prefixed_closer_closes_but_tab_opener_does_not_open(self):
        """Closers follow the neutralise rule (line.strip()); openers are
        spaces-only, so a tab-indented delimiter never opens a fence."""
        closed = prf._clip("```py\n@user\n\t```\n" + "x" * 12000, 200)
        self.assertFalse(closed.split("\n\n… (truncated")[0].endswith("\n```"))
        opened = prf._clip("text\n\t```py\n" + "x" * 12000, 200)
        self.assertFalse(opened.split("\n\n… (truncated")[0].endswith("\n```"))

    def test_body_cap_closes_severed_fence_within_budget(self):
        """R4 F2: the MAX_BODY cut closes a severed fence, keeps the final
        body at MAX_BODY units, and preserves the identity marker."""
        findings = [{"severity": "none", "path": None, "start": None, "end": None,
                     "title": "", "text": "```py\n" + "x" * 12000} for _ in range(6)]
        review = prf.build_review({"head": HEAD, "base": BASE, "run_id": "r-ok"}, findings, None)
        body = review["body"]
        self.assertEqual(len(body), prf.MAX_BODY)
        self.assertTrue(body.startswith(prf.marker("r-ok")))
        self.assertIn("… (truncated; full text in the crq run artifacts)", body)
        self.assertIsNone(prf._fence_state(body.split("\n")),
                          "fence must be closed at the end of the capped body")

    def test_body_cap_rescan_longer_fence_stays_bounded(self):
        """R4 critic P2: one reservation is not enough. Cutting to reserve a
        3-backtick closure re-opens an earlier 5,600-tilde fence; the cap
        must iterate until the scan is stable so the emitted body (prefix +
        closure + trailer) never exceeds MAX_BODY, and the final fence must
        be closed."""
        findings = [{"severity": "none", "path": None, "start": None, "end": None,
                     "title": "", "text": "x" * 12000} for _ in range(4)] + [
            {"severity": "none", "path": None, "start": None, "end": None,
             "title": "", "text": "x" * 100},
            {"severity": "none", "path": None, "start": None, "end": None,
             "title": "", "text": "~" * 5600 + "\n" + "~" * 5600 + "\n```python\n" + "z" * 200}]
        body = prf.build_review({"head": HEAD, "base": BASE, "run_id": "r-ok"}, findings, None)["body"]
        self.assertLessEqual(len(body), prf.MAX_BODY,
                             "emitted body must stay within MAX_BODY after re-reservation")
        self.assertLessEqual(len(body), 65536, "GitHub hard cap")
        self.assertTrue(body.startswith(prf.marker("r-ok")))
        self.assertTrue(body.endswith("… (truncated; full text in the crq run artifacts)\n"))
        self.assertIsNone(prf._fence_state(body.split("\n")),
                          "final body must not end inside an open fence")

    def test_body_cap_no_fence_keeps_previous_shape(self):
        """Without an open fence the cap keeps the historical shape: prefix
        then trailer, bounded by MAX_BODY, no closure bytes."""
        findings = [{"severity": "none", "path": None, "start": None, "end": None,
                     "title": "", "text": "y" * 12000} for _ in range(6)]
        review = prf.build_review({"head": HEAD, "base": BASE, "run_id": "r-ok"}, findings, None)
        body = review["body"]
        self.assertLessEqual(len(body), prf.MAX_BODY)
        self.assertTrue(body.startswith(prf.marker("r-ok")))
        self.assertTrue(body.endswith("… (truncated; full text in the crq run artifacts)\n"))


class CrqIntegrationTest(unittest.TestCase):
    def harvest(self, item, events, findings):
        at = dt.datetime(2026, 11, 6, 12, tzinfo=dt.timezone.utc)
        td = tempfile.TemporaryDirectory()
        self.addCleanup(td.cleanup)
        root = Path(td.name)
        rdir = root / "runs" / item["run"]["run_id"]
        rdir.mkdir(parents=True)
        (rdir / "exit.json").write_text(json.dumps({"exit": 0}))
        (rdir / "meta.json").write_text(json.dumps({"run_id": item["run"]["run_id"], "head": HEAD, "base": BASE,
                                                    "cycle": 1, "worktree": str(root / "wt"), "wt_branch": "w"}))
        write_ndjson(rdir, events)
        cls = {"outcome": "completed", "counted": True, "findings": findings,
               "severity_counts": {"major": findings}}
        q = {"items": [item]}
        with mock.patch.object(crq, "RUNS", root / "runs"), mock.patch.object(crq, "STATE", root), \
             mock.patch.object(crq, "run_liveness", return_value="harvest"), mock.patch.object(crq, "now", return_value=at), \
             mock.patch.object(crq, "classify", return_value=cls), mock.patch.object(crq, "findings_md", return_value=""), \
             mock.patch.object(crq, "event"), mock.patch.object(crq, "remove_worktree"), \
             mock.patch.object(crq.coverage, "record_review", side_effect=lambda ledger, **kw: ledger), \
             mock.patch.object(crq.usage_slots, "write_next"), \
             mock.patch.object(crq.repair_tick, "enqueue", return_value=False) as repair, \
             mock.patch.object(crq.pr_review_findings, "deliver") as deliver:
            crq.harvest_review(q, item, False)
        deliver.assert_not_called()  # debt only at harvest
        return item, rdir, repair

    def test_counted_open_and_delta_findings_persist_review_debt(self):
        for kind, item_id, repo in (("open", "pr7", REPO), ("delta", "pr7-range", REPO),
                                    ("open", "infra-pr7", "camerontaylor/infra"),
                                    ("delta", "infra-pr7-range", "camerontaylor/infra")):
            item = {"id": item_id, "repo": repo, "kind": kind, "pr": 7, "state": "reviewing",
                    "run": {"run_id": f"{item_id}-20261106T000000Z"}}
            item, rdir, repair = self.harvest(item, [ANCHORED, {"type": "complete"}], 1)
            self.assertEqual(item["pr_review_request"],
                             {"run_id": f"{item_id}-20261106T000000Z", "pr": 7, "base": BASE, "head": HEAD,
                              "ndjson": str(rdir / "review.ndjson"), "severity_counts": {"major": 1}})
            self.assertTrue(item["pr_review_pending"])
            self.assertEqual(item["pr_review_attempts"], 0)
            self.assertNotIn("issue_pending", item)
            if repo == REPO:
                repair.assert_called_once()
            else:
                repair.assert_not_called()
            self.assertEqual(item["state"], "done")

    def test_clean_review_records_no_debt_in_any_repo(self):
        for repo in (REPO, "camerontaylor/infra"):
            item = {"id": "pr8", "repo": repo, "kind": "open", "pr": 8,
                    "state": "reviewing", "run": {"run_id": "pr8-r"}}
            item, _, _ = self.harvest(item, [{"type": "complete"}], 0)
            self.assertNotIn("pr_review_request", item)
            self.assertNotIn("issue_request", item)

    def pending(self, item_id, stamp=None, repo=None):
        item = {"id": item_id, "kind": "open", "pr": 7, "state": "done", "pr_review_pending": True,
                "pr_review_attempts": 0,
                "pr_review_request": {"run_id": f"{item_id}-r", "pr": 7, "base": BASE, "head": HEAD,
                                      "ndjson": "/nonexistent", "severity_counts": {"major": 1}}}
        if stamp:
            item["pr_review_attempt_at"] = stamp
        if repo:
            item["repo"] = repo
        return item

    def test_post_harvest_pass_is_capped_rotating_across_repos(self):
        q = {"items": [self.pending("pr1", "2026-11-06T02:00:00Z"), self.pending("pr2", "2026-11-06T01:00:00Z"),
                       self.pending("pr3"), self.pending("pr4", repo="camerontaylor/infra")]}
        done = {"state": "created", "review_id": 1, "review_url": "u", "inline": 1, "body_only": 0}
        with mock.patch.object(crq.pr_review_findings, "deliver", return_value=done) as deliver, \
             mock.patch.object(crq, "event"):
            log = crq.deliver_pending_pr_reviews(q)
        self.assertEqual([c.args[2]["item_id"] for c in deliver.call_args_list], ["pr3", "pr4"])
        self.assertEqual([c.args[0] for c in deliver.call_args_list], [REPO, "camerontaylor/infra"])
        self.assertEqual(log, ["findings review on PR #7 (created)"] * 2)
        self.assertEqual(q["items"][2]["pr_review"], done)
        self.assertFalse(q["items"][2]["pr_review_pending"])
        self.assertTrue(q["items"][0]["pr_review_pending"])

    def test_legacy_foreign_issue_debt_migrates_with_pinned_range_and_no_duplicate(self):
        item = {"id": "infra-pr7", "kind": "delta", "repo": "camerontaylor/infra", "pr": 7,
                "state": "done", "head": "c" * 40, "issue_pending": True,
                "issue_request": {"run_id": "old-run", "base": BASE, "head": HEAD,
                                  "findings_md": "/runs/old-run/findings.md", "severity_counts": {"major": 1}}}
        q = {"items": [item]}
        with mock.patch.object(crq.pr_review_findings, "deliver", return_value={"state": "existing"}) as deliver, \
             mock.patch.object(crq, "event"):
            crq.deliver_pending_pr_reviews(q)
            crq.deliver_pending_pr_reviews(q)
        deliver.assert_called_once_with("camerontaylor/infra", 7,
            {"run_id": "old-run", "item_id": "infra-pr7", "base": BASE, "head": HEAD},
            Path("/runs/old-run/review.ndjson"))
        self.assertFalse(item["issue_pending"])
        self.assertFalse(item["pr_review_pending"])

    def test_issue_migration_preserves_newer_review_debt_and_push_debt(self):
        newer = self.pending("infra-pr7", repo="camerontaylor/infra")
        newer.update(issue_pending=True, issue_request={"run_id": "older"})
        posted = {**newer, "id": "infra-pr8", "pr_review_request": None,
                  "pr_review_pending": False, "issue": {"issue_number": 9}}
        push = {"id": "push-infra", "kind": "push-current", "issue_pending": True}
        with mock.patch.object(crq.pr_review_findings, "deliver", return_value={"state": "created"}) as deliver, \
             mock.patch.object(crq, "event"):
            crq.deliver_pending_pr_reviews({"items": [newer, posted, push]})
        self.assertEqual(deliver.call_count, 1)
        self.assertEqual(deliver.call_args.args[2]["run_id"], "infra-pr7-r")
        self.assertTrue(push["issue_pending"])
        self.assertFalse(posted["issue_pending"])

    def test_foreign_delivery_retries_skips_closed_and_deduplicates_on_pinned_head(self):
        for state, existing, expected in (("closed", None, "skipped-closed"),
                                          ("open", {"id": 9, "url": "u"}, "existing"),
                                          ("open", None, "created")):
            with self.subTest(expected=expected), tempfile.TemporaryDirectory() as root:
                item = self.pending("infra-pr7", repo="camerontaylor/infra")
                item["head"] = "c" * 40  # refreshed queue head must never replace reviewed head
                item["pr_review_request"]["ndjson"] = str(write_ndjson(root, [ANCHORED]))
                gh = FakeGh(state=state, existing=existing)
                with mock.patch.object(prf, "_gh", side_effect=RuntimeError("HTTP 502")), \
                     mock.patch.object(crq, "event"):
                    crq.deliver_pending_pr_reviews({"items": [item]})
                self.assertTrue(item["pr_review_pending"])
                with mock.patch.object(prf, "_gh", gh), mock.patch.object(crq, "event"):
                    crq.deliver_pending_pr_reviews({"items": [item]})
                self.assertEqual(item["pr_review"]["state"], expected)
                self.assertFalse(item["pr_review_pending"])
                targets = [x for argv, _ in gh.calls for x in argv if x.startswith("repos/")]
                self.assertTrue(all(x.startswith("repos/camerontaylor/infra/") for x in targets))
                if expected == "created":
                    self.assertEqual(gh.posts()[0]["commit_id"], HEAD)

    def test_failures_retry_then_abandon_after_the_attempt_cap(self):
        item = self.pending("pr5")
        with mock.patch.object(crq.pr_review_findings, "deliver", side_effect=RuntimeError("HTTP 502")), \
             mock.patch.object(crq, "event") as event:
            for attempt in range(1, crq.PR_REVIEW_MAX_ATTEMPTS):
                self.assertIsNone(crq._deliver_pr_review(item))
                self.assertTrue(item["pr_review_pending"])
                self.assertEqual(item["pr_review_attempts"], attempt)
            self.assertIn("abandoned", crq._deliver_pr_review(item))
        self.assertFalse(item["pr_review_pending"])
        self.assertIn("502", item["pr_review_error"])
        self.assertEqual(event.call_args.args[0], "findings_review_abandoned")
        self.assertIsNone(crq._deliver_pr_review(item))  # no further attempts

    def test_malformed_request_settles_at_once_without_raising(self):
        item = self.pending("pr6")
        del item["pr_review_request"]["head"]
        with mock.patch.object(crq.pr_review_findings, "deliver") as deliver, \
             mock.patch.object(crq, "event") as event:
            self.assertIn("abandoned", crq._deliver_pr_review(item))
        deliver.assert_not_called()
        self.assertFalse(item["pr_review_pending"])
        self.assertEqual(item["pr_review_attempts"], 1)
        self.assertIn("malformed", item["pr_review_error"])
        self.assertEqual(event.call_args.args[0], "findings_review_abandoned")

    def test_invalid_identity_value_error_is_permanent(self):
        item = self.pending("pr9")
        with mock.patch.object(crq.pr_review_findings, "deliver",
                               side_effect=ValueError("invalid PR review delivery identity")), \
             mock.patch.object(crq, "event"):
            self.assertIn("abandoned", crq._deliver_pr_review(item))
        self.assertFalse(item["pr_review_pending"])
        self.assertEqual(item["pr_review_attempts"], 1)


if __name__ == "__main__":
    unittest.main()
