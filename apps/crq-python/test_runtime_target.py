"""Default-branch integration without any retired refs or network access."""
import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location("crq_main_target_fixture", Path(__file__).with_name("crq.py"))
crq = importlib.util.module_from_spec(spec)
spec.loader.exec_module(crq)


class MainTargetTest(unittest.TestCase):
    def test_denylist_and_attribution_need_only_main_ref(self):
        with tempfile.TemporaryDirectory() as td:
            repo = Path(td)

            def git(*args):
                return subprocess.run(["git", *args], cwd=repo, check=True,
                                      text=True, capture_output=True).stdout.strip()

            def commit(message):
                git("add", ".")
                git("commit", "-qm", message)
                return git("rev-parse", "HEAD")

            git("init", "-q")
            git("config", "user.name", "Offline fixture")
            git("config", "user.email", "fixture@example.invalid")
            (repo / "source.py").write_text("original = 1\n")
            base = commit("base")
            (repo / "source.py").write_text("original = 1\naddition = 2\n")
            source = commit("source PR")
            merged = git("commit-tree", source + "^{tree}", "-p", base,
                         "-p", source, "-m", "merge source PR")
            git("checkout", "--detach", merged)
            rules = repo / "policy/denylist/patterns.yml"
            rules.parent.mkdir(parents=True)
            rules.write_text("rules:\n  - id: fixture-rule\n    regex: fixture-sensitive-marker\n")
            target = commit("main policy")
            git("update-ref", "refs/remotes/" + crq.DEFAULT_REF, target)
            refs = git("for-each-ref", "--format=%(refname)")
            self.assertNotIn("merge-queue", refs)
            self.assertNotIn("cq/promoted", refs)
            with mock.patch.object(crq, "CLONE", repo):
                self.assertEqual(crq.denylist_rules(), [
                    {"id": "fixture-rule", "regex": "fixture-sensitive-marker"}])
                measured = crq.measure_merged({"merge_commit": merged})
            self.assertEqual(measured["merge_queue"], target)  # historical result field
            self.assertEqual(measured["added"], 1)
            self.assertEqual(measured["surviving"], 1)
            self.assertEqual(crq.review_receipt.SELECTORS["merge-queue"], crq.DEFAULT_REF)
