"""Q2 merged-interval reconciliation: offline fixtures only.

No live forge, provider, scheduler or repair: pages are fakes, the interval
is frozen in the fixture, and every assertion is about REPRESENTATION and
honest incompleteness, never review credit.

Split provenance: test_merged_reconcile.py was split by subject into
test_merged_reconcile_interval.py, test_merged_reconcile_identity.py,
test_merged_reconcile_paging.py, test_merged_reconcile_dedupe.py,
test_merged_reconcile_summary.py, test_merged_reconcile_durable.py and
test_merged_reconcile_numeric.py; this module holds their shared fixtures.
"""
import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("crq_merged_reconcile", ROOT / "merged_reconcile.py")
mr = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mr)

A = "2026-10-01T00:00:00Z"
B = "2026-10-27T00:00:00Z"  # frozen upper bound


def sha(n: int) -> str:
    return format(n, "040x")


def pr(n: int, at: str, merge: str = None, head: str = None) -> dict:
    return {"number": n, "mergedAt": at,
            "mergeCommit": {"oid": merge or sha(n)},
            "headRefOid": head or sha(n + 1000)}


def cursor_page(records: list, next_cursor=None) -> dict:
    """Explicit forge pagination metadata, including on empty pages."""
    return {"records": records, "has_next_page": next_cursor is not None,
            "next_cursor": next_cursor}


class FakeForge:
    """Deterministic multi-page forge: cursor -> records; walks sequentially."""

    def __init__(self, pages: dict):
        self.pages = pages
        self.calls = []

    def fetch(self, cursor):
        self.calls.append(cursor)
        page = self.pages[cursor]
        return cursor_page(page) if isinstance(page, list) else page
