"""Local-review v1 contract and canonical identity. No runner or network I/O.

The caller resolves Git facts before identity(); client claims are never proof.
Canonical bytes deliberately use review_receipt, rather than ledger JSON rules.
"""
import functools
import json
from pathlib import Path

from review_ledger import _schema
from review_receipt import canonical, digest

SCHEMA = Path(__file__).resolve().parents[2] / "policy/review-operation.schema.json"
VERSION = 1
KIND = "local-review"
RECEIPT_KIND = "local-review-full-diff"


@functools.lru_cache(maxsize=1)
def _contract():
    return json.loads(SCHEMA.read_text())


def validate(kind, value):
    """Reject unknown fields, including caller-supplied extra context."""
    _schema({"type": kind, "value": value}, _contract())
    return value


def identity(inputs):
    """Hash a resolved review-identity-v1 document, including semantic revision."""
    validate("identity", inputs)
    return digest(inputs)


def equivalent(a, b):
    """Only pinned facts with a known profile qualify for exact reuse.

    Historical cycles must be normalized by the runner after resolving their
    stored commits; a missing profile is intentionally never inferred.
    """
    try:
        for value in (a, b):
            validate("identity", value)
        fields = ("repo", "base_commit", "head_commit", "scope", "projection",
                  "config_digest")
        return (all(a[k] == b[k] for k in fields)
                and a["profile"] == b["profile"])
    except (ValueError, TypeError):
        return False
