"""Same-SHA signer identity must match monorepo policy without importing a daemon."""
import ast
import json
from pathlib import Path
import unittest


class PolicyPins(unittest.TestCase):
    def test_signer_pins_equal_policy(self):
        root = Path(__file__).resolve().parent
        policy = json.loads((root.parent.parent / "policy/promotion-reviewer.json").read_text())
        tree = ast.parse((root / "signer/crq-signer.py").read_text())
        pins = {}
        for node in tree.body:
            if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
                if node.target.id in {"REVIEWER_BOT_LOGIN", "REVIEWER_BOT_ID"}:
                    pins[node.target.id] = ast.literal_eval(node.value)
        self.assertEqual(pins["REVIEWER_BOT_LOGIN"], policy["login"])
        self.assertEqual(pins["REVIEWER_BOT_ID"], policy["id"])
        self.assertEqual(policy["type"], "Bot")
