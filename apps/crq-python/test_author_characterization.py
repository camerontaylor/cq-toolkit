"""Legacy author contracts captured before lease changes, at 0e35cd11.

The fixture was produced from the exact imported source, not reconstructed from
the specification. Keep this test green for requests that do not opt into leases.
"""
import copy
import json
import unittest
from pathlib import Path

import author_quota
from test_author_quota import crq, binding

AT = "2026-10-16T06:00:00Z"
FIXTURE = Path(__file__).parent / "fixtures" / "author-0e35cd11.json"


def capture():
    q = {"items": [], "starts": [], "unknown": {"retain": [None, False, 7]}}
    first = author_quota.enroll(q, **binding(), at=AT)
    again = author_quota.enroll(q, **binding(), at=AT)
    before = copy.deepcopy(q)
    try:
        author_quota.enroll(q, **binding(head="c" * 40), at=AT)
    except author_quota.AuthorRefused as exc:
        refusal = str(exc)
    assert q == before
    matrix = []
    for identity in ("managed", "legacy", "invalid"):
        for has_exit in (False, True):
            for wrapper in (None, False, True):
                matrix.append([identity, has_exit, wrapper, author_quota.run_state(
                    has_exit=has_exit, identity=identity, runner_alive=False,
                    cli_alive=False, runner_group_alive=False,
                    wrapper_group_alive=wrapper)])
    return {"queue": q, "first": first, "again": again, "refusal": refusal,
            "plan": author_quota.plan(first["item"]), "liveness": matrix,
            "wrapper": crq.review_wrapper_argv(["coderabbit", "review"], 75)}


class LegacyAuthorCharacterization(unittest.TestCase):
    def test_exact_legacy_state_and_result_bytes(self):
        expected = json.loads(FIXTURE.read_text())
        self.assertEqual(expected["source"], "0e35cd11153fc7ad681f002d580b9b22feb22092")
        self.assertEqual(json.dumps(capture(), sort_keys=True).encode(),
                         json.dumps(expected["capture"], sort_keys=True).encode())


if __name__ == "__main__":
    unittest.main()
