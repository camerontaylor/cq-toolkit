"""Shared fixture surface for the split author-quota admission suite.

Narrow isolated tests for supported author enrollment and shared-quota
admission. No live queue/state, no models, no Git: every queue is a plain dict in
a temp dir and every launch/git/coverage/repair effect is mocked. One class spawns
a real, harmless `timeout`+`sleep` wrapper (never the model CLI) to regression-test
the GNU timeout process-group requirement, for both the managed and legacy shapes.

Split provenance: apps/crq-python/test_author_quota.py was split into
test_author_quota_admission.py, test_author_quota_launch.py,
test_author_quota_runner.py, test_author_quota_crash_recovery.py,
test_author_quota_harvest.py, test_author_quota_tick.py,
test_author_quota_observation.py and test_author_quota_open_cycle.py. This module
holds the module bootstrap, shared constants and queue builders; it defines no
tests.
"""
import importlib.machinery
import importlib.util
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

import author_quota  # noqa: E402

loader = importlib.machinery.SourceFileLoader("crq_author_under_test", str(ROOT / "crq.py"))
spec = importlib.util.spec_from_loader(loader.name, loader)
assert spec is not None
crq = importlib.util.module_from_spec(spec)
sys.modules[loader.name] = crq
loader.exec_module(crq)

BASE = "a" * 40
HEAD = "b" * 40
REQ = "author-cycle-1"
MARKER = author_quota.GROUP_OWNER_MARKER


def binding(**over):
    d = {"request_id": REQ, "base": BASE, "head": HEAD, "target": "origin/merge-queue", "cycle": 1}
    d.update(over)
    return d


def empty_queue():
    return {"created_at": crq.iso(), "items": [], "starts": [], "paused": False,
            "author_requests": {}, "author_observations": []}


def author_item(q):
    return author_quota.enroll(q, **binding(), at=crq.iso())["item"]
