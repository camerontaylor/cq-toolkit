"""Disposable, content-verified indexes for immutable inventory facts.

The durable artifact store remains authoritative for bytes. An index can be
removed, stale or read-only without blocking acquisition. Failed acquisitions
are never stored. Bump VERSION when the accounting meaning of facts changes.
"""
from pathlib import Path

import review_ledger as ledger

VERSION = 1


class Cache:
    def __init__(self, root, store):
        self.root, self.store = Path(root), store

    def _key(self, kind, identity):
        if not kind.isidentifier():
            raise ValueError("invalid inventory cache namespace")
        return ledger.digest({"version": VERSION, "kind": kind, "identity": identity})

    def get(self, kind, identity):
        key = self._key(kind, identity)
        try:
            reference = ledger.loads((self.root / "facts" / kind / (key + ".json")).read_bytes())
            self.store.verify(reference)
            value = ledger.loads(Path(reference["location"]).read_bytes())
            if isinstance(value, dict) and value.get("key") == key and "value" in value:
                return value["value"]
        except (OSError, ValueError, KeyError, TypeError):
            pass
        return None

    def put(self, kind, identity, value):
        key = self._key(kind, identity)
        # Artifact failures are real evidence-volume failures, not index misses.
        reference = self.store.put(ledger.canonical({"key": key, "value": value}))
        try:
            ledger.atomic(self.root / "facts" / kind / (key + ".json"), ledger.canonical(reference))
        except OSError:
            pass
