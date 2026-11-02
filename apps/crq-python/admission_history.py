"""Bounded admission diagnostics and incremental legacy queue loading.

Reservations remain authoritative in backfill_reservations, never in history.
"""
from collections import Counter, deque
import json

VERSION = 1
LIMIT = 256
MARKER = "backfill_admission_history_version"


def summarize(decision):
    observation = decision.get("observation")
    if observation is not None:
        observation = {key: observation[key] for key in
                       ("successful", "observed_at", "remaining") if key in observation}
    holds = decision.get("reservations", {})
    counts = dict(Counter(h.get("quota_state", "unknown") for h in holds.values()))
    return {**{key: decision[key] for key in
               ("at", "item", "ordinary_eligible", "effective_remaining", "decision") if key in decision},
            "observation": observation,
            "reservation_counts": decision.get("reservation_counts", counts)}


def append(queue, decision):
    rows = queue.setdefault("backfill_admissions", [])
    rows.append(summarize(decision))
    del rows[:-LIMIT]
    queue[MARKER] = VERSION


class Reader:
    """Decode one top-level value / admission at a time, in 64 KiB chunks."""
    def __init__(self, stream):
        self.stream, self.buffer, self.eof = stream, "", False
        self.decoder = json.JSONDecoder()

    def fill(self, size=65536):
        chunk = self.stream.read(size)
        self.buffer += chunk
        self.eof = not chunk

    def peek(self):
        self.buffer = self.buffer.lstrip()
        while not self.buffer and not self.eof:
            self.fill()
            self.buffer = self.buffer.lstrip()
        return self.buffer[:1]

    def take(self, token):
        if self.peek() != token:
            raise ValueError("invalid queue JSON delimiter")
        self.buffer = self.buffer[1:]

    def value(self):
        self.peek()
        while True:
            try:
                value, end = self.decoder.raw_decode(self.buffer)
                # A number may straddle a chunk boundary.
                if end == len(self.buffer) and not self.eof:
                    self.fill()
                    continue
                self.buffer = self.buffer[end:]
                return value
            except json.JSONDecodeError:
                if self.eof:
                    raise
                self.fill(max(65536, len(self.buffer)))


def load(path):
    """Return (queue, needs_atomic_save); reject malformed input before writing."""
    with path.open(encoding="utf-8") as stream:
        reader = Reader(stream)
        reader.take("{")
        queue = {}
        while reader.peek() != "}":
            key = reader.value()
            if not isinstance(key, str) or key in queue:
                raise ValueError("invalid or duplicate queue key")
            reader.take(":")
            if key == "backfill_admissions":
                reader.take("[")
                rows = deque(maxlen=LIMIT)
                while reader.peek() != "]":
                    rows.append(summarize(reader.value()))
                    if reader.peek() == "]":
                        break
                    reader.take(",")
                    if reader.peek() == "]":
                        raise ValueError("trailing admission comma")
                reader.take("]")
                queue[key] = list(rows)
            else:
                queue[key] = reader.value()
            if reader.peek() == "}":
                break
            reader.take(",")
            if reader.peek() == "}":
                raise ValueError("trailing queue comma")
        reader.take("}")
        if reader.peek():
            raise ValueError("trailing queue data")
    version = queue.get(MARKER, 0)
    if version > VERSION:
        raise ValueError("unsupported admission history version")
    changed = "backfill_admissions" in queue and version != VERSION
    if changed:
        queue[MARKER] = VERSION
    return queue, changed
