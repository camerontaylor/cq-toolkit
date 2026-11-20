"""Repo-scoped exemptions for known-fake secret fixtures in the pre-upload scan.

Exemptions are read from the BASE commit only (.crq/scan-exemptions.toml);
only inline-secret-assignments and gitleaks generic-api-key are exemptible.
"""
import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("crq_scan_exempt_crq", ROOT / "crq.py")
crq = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = crq
spec.loader.exec_module(crq)

CORPUS = (ROOT.parents[1] / "policy/denylist/patterns.yml").read_text()
SWARM = "crates/jcode-app-core/src/server/swarm_tests.rs"
MSG = "crates/jcode-base/src/message/tests.rs"
# Spelled in pieces so this file itself stays clean of secret shapes.
FAKES = {
    SWARM: ["DEPLOY_TOKEN=" + "tok_live_4f9a8b7c6d5e", "let k = \"API_KEY=" + "abcd1234efgh \";"],
    MSG: ["DB_PASSWORD=" + "hunter2hunter2 x", "api-key: " + "abc123def"],
}
EXEMPT_TOML = """
[[exempt]]
path = "crates/**/*tests.rs"
rule = "class:inline-secret-assignments"
reason = "upstream redaction fixtures"

[[exempt]]
path = "crates/jcode-app-core/src/server/swarm_tests.rs"
rule = "generic-api-key"
reason = "upstream redaction fixtures"
"""


def diff_of(files):
    out = ""
    for path, lines in files.items():
        out += (f"diff --git a/{path} b/{path}\n--- /dev/null\n+++ b/{path}\n@@ -0,0 +1,{len(lines)} @@\n"
                + "".join("+" + ln + "\n" for ln in lines))
    return out


class ScanExemptionTest(unittest.TestCase):
    def setUp(self):
        self.td = tempfile.TemporaryDirectory()
        self.addCleanup(self.td.cleanup)
        self.root = Path(self.td.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        self.g("init", "-q", "-b", "main")
        self.g("config", "user.email", "t@example.com")
        self.g("config", "user.name", "t")

    def g(self, *a):
        return subprocess.run(["git", *a], cwd=self.repo, check=True, capture_output=True, text=True).stdout.strip()

    def commit(self, files, msg="c"):
        for p, t in files.items():
            f = self.repo / p
            f.parent.mkdir(parents=True, exist_ok=True)
            f.write_text(t)
        self.g("add", "-A")
        self.g("commit", "-q", "-m", msg)
        return self.g("rev-parse", "HEAD")

    def scan(self, files, exemptions=(), classes=crq.UNIVERSAL_SCAN_CLASSES, gitleaks=False):
        which = crq.shutil.which if gitleaks else (lambda *_: None)
        with mock.patch.object(crq, "git", return_value=CORPUS), \
             mock.patch.object(crq.shutil, "which", side_effect=which):
            return crq.secret_scan_diff(diff_of(files), self.root / "scan.json", classes=classes,
                                        exemptions=list(exemptions))

    def exemptions_from(self, toml):
        base = self.commit({crq.SCAN_EXEMPTIONS_PATH: toml})
        ex, err = crq.load_scan_exemptions(base, self.repo)
        self.assertIsNone(err)
        return ex

    # (a) jcode #32 shaped fixtures pass, reported as exempted
    def test_fixtures_exempted_and_reported(self):
        ok, res = self.scan(FAKES, self.exemptions_from(EXEMPT_TOML), gitleaks=True)
        self.assertTrue(ok, res)
        self.assertEqual(res["denylist_hits"], [])
        self.assertEqual(res["gitleaks_hits"], [])
        self.assertTrue(res["exempted"]["denylist"])
        if crq.shutil.which("gitleaks"):  # CI runners may not ship it
            self.assertTrue(res["exempted"]["gitleaks"])
        text = json.dumps(res)
        for secret in ("hunter2hunter2", "tok_live_4f9a8b7c6d5e"):
            self.assertNotIn(secret, text)

    # (b) an exemption present only on the head side has no effect
    def test_head_side_exemption_ignored(self):
        base = self.commit({"README.md": "x\n"})
        self.commit({crq.SCAN_EXEMPTIONS_PATH: EXEMPT_TOML}, "head adds exemptions")
        ex, err = crq.load_scan_exemptions(base, self.repo)
        self.assertEqual((ex, err), ([], None))
        ok, res = self.scan(FAKES, ex)
        self.assertFalse(ok)
        self.assertTrue(res["denylist_hits"])

    # (c) real-looking secret in a non-exempt path still blocks
    def test_non_exempt_path_blocks(self):
        files = {"src/deploy.rs": ["DB_PASSWORD=" + "hunter2hunter2 x"], **FAKES}
        ok, res = self.scan(files, self.exemptions_from(EXEMPT_TOML))
        self.assertFalse(ok)
        self.assertEqual({h["file"] for h in res["denylist_hits"]}, {"src/deploy.rs"})
        self.assertTrue(res["exempted"]["denylist"])

    # (d) universal / non-generic classes cannot be exempted
    def test_universal_classes_not_exemptible(self):
        for rule in ("class:token-ssh-plumbing", "class:route-key-material", "class:key-material-env"):
            base = self.commit({crq.SCAN_EXEMPTIONS_PATH: f'[[exempt]]\npath="**"\nrule="{rule}"\nreason="r"\n'}, rule)
            ex, err = crq.load_scan_exemptions(base, self.repo)
            self.assertEqual(ex, [])
            self.assertIn("not exemptible", err)
        key = "-----BEGIN " + "OPENSSH PRIVATE KEY-----"
        forced = [{"path": "k.pem", "rule": "class:token-ssh-plumbing", "reason": "r", "rx": crq._glob_regex("**")}]
        ok, res = self.scan({"k.pem": [key]}, forced)
        self.assertFalse(ok)
        self.assertEqual(res["denylist_hits"][0]["rule"], "class:token-ssh-plumbing")

    def test_provider_shaped_token_blocks_even_in_exempt_path(self):
        if not crq.shutil.which("gitleaks"):
            self.skipTest("gitleaks not installed")
        real = "ghp_" + "aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dE3fG5"
        ok, res = self.scan({SWARM: ["token = \"" + real + "\""]}, self.exemptions_from(EXEMPT_TOML), gitleaks=True)
        self.assertFalse(ok)
        self.assertTrue(any(h["rule"] != "generic-api-key" for h in res["gitleaks_hits"]))

    def test_malformed_file_fails_closed(self):
        base = self.commit({crq.SCAN_EXEMPTIONS_PATH: "[[exempt]\nbroken"})
        self.assertEqual(crq.load_scan_exemptions(base, self.repo)[0], [])
        self.assertIsNotNone(crq.load_scan_exemptions(base, self.repo)[1])

    def test_glob_semantics(self):
        rx = crq._glob_regex("crates/*/tests.rs")
        self.assertTrue(rx.match("crates/a/tests.rs"))
        self.assertFalse(rx.match("crates/a/b/tests.rs"))
        self.assertTrue(crq._glob_regex("**/tests.rs").match("tests.rs"))
        self.assertTrue(crq._glob_regex("a/**").match("a/b/c"))


if __name__ == "__main__":
    unittest.main()
