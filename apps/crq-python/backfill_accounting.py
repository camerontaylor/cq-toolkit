"""Explicit scope accounting; Git provenance carries credit, never creates it."""
import collections
import datetime as dt
from pathlib import Path
import re
import subprocess
import tempfile
import sys
from types import MappingProxyType

import review_ledger as ledger

ENTRY_CACHE_TREES = 1024
ENTRY_CACHE_BYTES = 256 * 1024 * 1024
LINEAGE_CACHE_BYTES = 32 * 1024 * 1024
# Bump when lineage/proven_deleted result semantics change: persisted required-PR
# mappings written under an older epoch must stop matching.
LINEAGE_RESULT_EPOCH = 1
FACT_CACHE_BYTES = 64 * 1024 * 1024

BLAME_OPTIONS = ["--line-porcelain", "--encoding=UTF-8"]


def line_bytes(data):
    return data.split(b"\n")[:-1] if data.endswith(b"\n") else data.split(b"\n") if data else []


def ranges(lines):
    result = []
    for number in sorted(set(lines)):
        if result and result[-1][1] == number - 1:
            result[-1][1] = number
        else:
            result.append([number, number])
    return result


def _int(v, low=0):
    return type(v) is int and v >= low


def _opt_str(v):
    return v is None or isinstance(v, str)


def _rows(v):
    return isinstance(v, list) and all(isinstance(r, list) and len(r) == 2 and _int(r[0], 1) and _int(r[1], 1) for r in v)


def _hexstr(v):
    return isinstance(v, str) and re.fullmatch(r"(?:[0-9a-f]{2})*", v) is not None


# Shape of every persisted fact kind. A digest-valid value of the wrong shape
# (e.g. written by a same-VERSION code change) is a miss, never trusted.
FACT_SHAPES = {
    "blame": lambda v: isinstance(v, list) and all(
        isinstance(r, list) and len(r) == 4 and isinstance(r[0], str) and _int(r[1]) and _hexstr(r[2]) and _hexstr(r[3])
        for r in v),
    "lineage_step": lambda v: isinstance(v, dict) and set(v) == {"parent", "changes"} and isinstance(v["parent"], str)
        and isinstance(v["changes"], list) and all(
            isinstance(r, list) and len(r) == 3 and isinstance(r[0], str) and isinstance(r[1], str) and _opt_str(r[2])
            for r in v["changes"]),
    "lineage": lambda v: isinstance(v, dict) and set(v) == {"path"} and _opt_str(v["path"]),
    "carry": lambda v: isinstance(v, dict) and set(v) == {"path", "matches", "old_lines"} and _opt_str(v["path"])
        and _int(v["old_lines"]) and isinstance(v["matches"], list) and all(
            isinstance(r, list) and len(r) == 2 and _int(r[0], 1) and r[0] <= v["old_lines"] and _int(r[1], 1)
            for r in v["matches"]),
    "coverage": lambda v: isinstance(v, dict) and set(v) == {"covered", "evidence"}
        and isinstance(v["covered"], dict) and all(_rows(r) for r in v["covered"].values())
        and isinstance(v["evidence"], dict) and all(
            isinstance(ids, list) and all(isinstance(i, str) for i in ids) for ids in v["evidence"].values()),
    "verified_review": lambda v: isinstance(v, dict) and all(_rows(r) for r in v.values()),
}


class Repository:
    def __init__(self, root):
        self.root = Path(root)
        self.immutable_cache = None
        self._cache_bytes = 0
        self._entry_cache = collections.OrderedDict()
        self._entry_bytes = 0
        self._lineage_steps = {}
        self._lineage_bytes = 0
        self.disk_cache = None
        self._facts = collections.OrderedDict()
        self._fact_bytes = 0
        self._verified = {}  # review digest -> verified credit or failure; immutable_cache invocations only
        self._inventories = {}  # (commit, max_file_bytes) -> rows; immutable_cache invocations only

    def begin_invocation(self):
        """Enable the immutable-object cache and forget earlier verification
        outcomes, so a gap from a previous invocation is retried."""
        self.immutable_cache = {}
        self._verified = {}
        self._inventories = {}
        self._lineage_steps = {}
        self._lineage_bytes = 0
        self._facts.clear()
        self._fact_bytes = 0

    def _cached(self, kind, identity):
        value = self.disk_cache.get(kind, identity) if self.disk_cache is not None else None
        return value if value is not None and FACT_SHAPES[kind](value) else None

    def _persist(self, kind, identity, value):
        if self.disk_cache is not None:
            self.disk_cache.put(kind, identity, value)

    def _has_commit(self, commit):
        return subprocess.run(["git", "cat-file", "-e", str(commit) + "^{commit}"], cwd=self.root,
                              capture_output=True, check=False).returncode == 0

    def _memo(self, key):
        if self.immutable_cache is not None and key in self._facts:
            self._facts.move_to_end(key)
            return self._facts[key][0]
        return None

    def _remember(self, key, value, size):
        if self.immutable_cache is not None and size <= FACT_CACHE_BYTES:
            if key in self._facts:
                _, previous = self._facts.pop(key)
                self._fact_bytes -= previous
            while self._facts and self._fact_bytes + size > FACT_CACHE_BYTES:
                _, (_, evicted) = self._facts.popitem(last=False)
                self._fact_bytes -= evicted
            self._facts[key] = (value, size)
            self._fact_bytes += size

    def git(self, *args, check=True, env=None, input=None, timeout=300):
        cacheable = (self.immutable_cache is not None and check and env is None and input is None
                     and ((len(args) == 3 and args[:2] == ("rev-list", "--first-parent") and re.fullmatch(r"[0-9a-f]{40,64}", args[2]))
                          or (len(args) == 2 and args[0] == "rev-parse" and re.fullmatch(r"[0-9a-f]{40,64}(?:\^1|\^\{commit\}|\^\{tree\})", args[1]))
                          or (len(args) == 4 and args[:3] == ("ls-tree", "-r", "-z") and re.fullmatch(r"[0-9a-f]{40,64}", args[3]))
                          or (args[:-2] in (("diff", "--name-status", "-z", "--find-renames=100%"),
                                               ("diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-status", "-z"),
                                               ("diff", "--no-ext-diff", "--no-textconv", "--find-renames", "-l0", "--name-status", "-z"))
                              and all(re.fullmatch(r"[0-9a-f]{40,64}", a) for a in args[-2:]))))
        if cacheable and args in self.immutable_cache:
            return self.immutable_cache[args]
        result = subprocess.run(["git", *args], cwd=self.root, capture_output=True,
                                check=check, env=env, input=input, timeout=timeout).stdout
        if cacheable and len(result) <= 256 * 1024 * 1024:
            if self._cache_bytes + len(result) > 256 * 1024 * 1024 or len(self.immutable_cache) >= 100000:
                self.immutable_cache.clear()
                self._cache_bytes = 0
            self.immutable_cache[args] = result
            self._cache_bytes += len(result)
        return result


    def resolve(self, value):
        if not re.fullmatch(r"[0-9a-f]{40,64}", value):
            raise ledger.IntegrityError("target must be an immutable full object ID")
        return self.git("rev-parse", value + "^{commit}").decode().strip()

    def retain(self, store, commits):
        refs = []
        for commit in sorted(set(commits)):
            self.resolve(commit)
            ref = "refs/crq/evidence/" + commit
            existing = self.git("rev-parse", "--verify", "--quiet", ref, check=False).decode().strip()
            if existing and existing != commit:
                raise ledger.IntegrityError("retained object ref conflict")
            if not existing:
                try:
                    self.git("update-ref", ref, commit, "0" * len(commit))
                except subprocess.CalledProcessError:
                    if self.git("rev-parse", "--verify", ref).decode().strip() != commit:
                        raise
            refs.append(ref)
        with tempfile.TemporaryDirectory() as directory:
            filename = Path(directory) / "evidence.bundle"
            self.git("bundle", "create", str(filename), *refs)
            return {**store.put_file(filename), "kind": "git-bundle"}

    def restore(self, artifacts, store):
        for reference in artifacts:
            store.verify(reference)
            if reference.get("kind") == "git-bundle":
                self.git("bundle", "verify", reference["location"])
                self.git("bundle", "unbundle", reference["location"])

    def tree(self, commit):
        return self.git("rev-parse", self.resolve(commit) + "^{tree}").decode().strip()

    def entries(self, commit):
        # Public callers own their dictionaries; string leaves are immutable.
        return {name: dict(entry) for name, entry in self._entries(commit).items()}

    def _entries(self, commit):
        """Read-only tree shared by trusted internal loops for this invocation."""
        commit = self.resolve(commit)
        if self.immutable_cache is not None and commit in self._entry_cache:
            self._entry_cache.move_to_end(commit)
            return self._entry_cache[commit][0]
        result = {}
        size = 0
        for raw in self.git("ls-tree", "-r", "-z", commit).split(b"\0"):
            if not raw:
                continue
            meta, name = raw.split(b"\t", 1)
            mode, kind, blob = meta.decode().split()
            try:
                name = ledger.path(name.decode("utf-8"))
            except (UnicodeError, ValueError):
                name = "git-path-bytes:" + name.hex()
            entry = {"path": name, "mode": mode, "kind": kind, "blob": blob}
            frozen = MappingProxyType(entry)
            # Conservative retained-size accounting includes dicts, proxies,
            # string leaves; the four literal field keys are shared.
            size += sys.getsizeof(name) + sys.getsizeof(entry) + sys.getsizeof(frozen)
            size += sum(sys.getsizeof(v) for v in entry.values())
            result[name] = frozen
        frozen = MappingProxyType(result)
        size += sys.getsizeof(result) + sys.getsizeof(frozen) + sys.getsizeof(commit) + 256
        if self.immutable_cache is not None and size <= ENTRY_CACHE_BYTES:
            while self._entry_cache and (len(self._entry_cache) >= ENTRY_CACHE_TREES
                                         or self._entry_bytes + size > ENTRY_CACHE_BYTES):
                _, (_, evicted_size) = self._entry_cache.popitem(last=False)
                self._entry_bytes -= evicted_size
            self._entry_cache[commit] = (frozen, size)
            self._entry_bytes += size
        return frozen

    def inventory(self, target, max_file_bytes):
        """Rows for every object at target. Each subject construction asks for the
        same target, so an invocation reads each blob once; callers get copies."""
        key = (self.resolve(target), max_file_bytes)
        if self.immutable_cache is not None and key in self._inventories:
            return [dict(row) for row in self._inventories[key]]
        rows = self._inventory(target, max_file_bytes)
        if self.immutable_cache is not None:
            self._inventories = {key: tuple(dict(row) for row in rows)}  # one target per invocation
        return rows

    def _inventory(self, target, max_file_bytes):
        rows = []
        for name, entry in sorted(self._entries(target).items(), key=lambda v: v[0].encode()):
            row = {**entry, "lines": None, "bytes": None, "disposition": "unsupported", "reason": "non-regular object"}
            if name.startswith("git-path-bytes:"):
                row["reason"] = "non-canonical or non-UTF8 path"
            elif entry["mode"] in ("100644", "100755") and entry["kind"] == "blob":
                try:
                    data = self.git("cat-file", "blob", entry["blob"])
                    row["bytes"] = len(data)
                    data.decode("utf-8")
                    if b"\0" in data:
                        row["reason"] = "binary blob"
                    else:
                        row["lines"] = len(line_bytes(data))
                        if len(data) > max_file_bytes:
                            row["reason"] = "current content exceeds per-file limit"
                        elif data:
                            row.update(disposition="included", reason="tracked regular UTF8 text")
                        else:
                            row.update(disposition="empty", reason="empty current blob")
                except UnicodeError:
                    row["reason"] = "non-UTF8 blob"
                except (OSError, subprocess.SubprocessError):
                    row["reason"] = "unreadable blob"
            rows.append(row)
        return rows

    def changed_intervals(self, base, head):
        result, current = {}, None
        # --no-ext-diff/--no-textconv ensure repository configuration cannot run
        # helpers; --no-color and explicit prefixes pin the header format the
        # parser expects against user/global diff.* and color.* config.
        # Literal path/blob mapping comes from raw name-status + hunks.
        patch = self.git("diff", "--no-ext-diff", "--no-textconv", "--no-color", "--src-prefix=a/", "--dst-prefix=b/",
                         "--no-renames", "--unified=0", base, head).decode("utf-8", "replace")
        old_left = new_left = 0
        for line in patch.split("\n"):
            if old_left or new_left:
                if line.startswith(" "):
                    old_left -= 1; new_left -= 1
                elif line.startswith("-"):
                    old_left -= 1
                elif line.startswith("+"):
                    new_left -= 1
                elif line.startswith("\\ No newline at end of file"):
                    continue
                else:
                    raise ledger.IntegrityError("malformed diff hunk")
                if old_left < 0 or new_left < 0:
                    raise ledger.IntegrityError("malformed diff hunk length")
                continue
            if line.startswith("+++ b/"):
                name = line[6:]
                if " " in name and name.endswith("\t"):
                    name = name[:-1]
                if name.startswith('"') or "\\" in name:
                    current = None  # quoted names use whole-file residual fallback
                else:
                    current = name
                    result.setdefault(current, set())
            elif line.startswith("+++ "):
                current = None
            elif line.startswith("@@ "):
                match = re.match(r"@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@", line)
                if match:
                    old_left = int(match[1] if match[1] is not None else 1)
                    start, new_left = int(match[2]), int(match[3] if match[3] is not None else 1)
                    if current:
                        result[current].update(range(start, start + new_left))
                else:
                    raise ledger.IntegrityError("malformed diff hunk header")
        if old_left or new_left:
            raise ledger.IntegrityError("truncated diff hunk")
        return result

    def verify_review(self, value):
        ledger.validate(value)
        if not ledger.creditable(value):
            return {}
        p = value["payload"]
        if self.tree(p["target"]) != p["target_tree"] or self.tree(p["head"]) != p["head_tree"]:
            raise ledger.IntegrityError("review tree mismatch")
        target, head = self._entries(p["target"]), self._entries(p["head"])
        changed = self.changed_intervals(p["base"], p["head"])
        result = {}
        for (name, blob), lines in ledger.scope(p["reviewed_scope"]).items():
            if target.get(name, {}).get("blob") != blob or head.get(name, {}).get("blob") != blob:
                raise ledger.IntegrityError("synthetic head/target blob mismatch")
            if target[name]["mode"] not in ("100644", "100755"):
                raise ledger.IntegrityError("reviewed non-regular object")
            maximum = len(line_bytes(self.git("cat-file", "blob", blob)))
            if any(n < 1 or n > maximum for n in lines) or not lines <= changed.get(name, set()):
                raise ledger.IntegrityError("credit outside head-side changed intervals")
            result[name] = set(lines)
        return result

    def blame(self, target, name):
        name = ledger.path(name)
        cacheable = re.fullmatch(r"[0-9a-f]{40,64}", target) is not None
        key = ("blame", target, name)
        remembered = self._memo(key) if cacheable else None
        if remembered is not None:
            return list(remembered)
        identity = {"target": target, "path": name, "options": BLAME_OPTIONS}
        cached = self._cached("blame", identity) if cacheable else None
        if isinstance(cached, list):
            try:
                result = [(r[0], r[1], bytes.fromhex(r[2]), bytes.fromhex(r[3])) for r in cached]
                self._remember_blame(key, result)
                return result
            except (TypeError, ValueError, IndexError):
                pass
        raw = self.git("blame", *BLAME_OPTIONS, target, "--", name).splitlines()
        result, origin, original_line, filename = [], None, None, None
        for line in raw:
            header = re.fullmatch(rb"([0-9a-f]{40,64}) (\d+) (\d+)(?: \d+)?", line)
            if header:
                origin, original_line = header[1].decode(), int(header[2])
            elif line.startswith(b"filename "):
                filename = line[9:]
            elif line.startswith(b"\t"):
                result.append((origin, original_line, filename, line[1:]))
        if cacheable and all(isinstance(r[2], bytes) for r in result):
            self._persist("blame", identity, [[r[0], r[1], r[2].hex(), r[3].hex()] for r in result])
            self._remember_blame(key, result)
        return result

    def _remember_blame(self, key, rows):
        frozen = tuple(rows)
        size = sys.getsizeof(frozen) + 256
        size += sum(sys.getsizeof(row) + sum(sys.getsizeof(v) for v in row) for row in frozen)
        self._remember(key, frozen, size)

    def _lineage_step(self, commit):
        if self.immutable_cache is not None and commit in self._lineage_steps:
            return self._lineage_steps[commit]
        identity = {"commit": commit}
        cached = self._cached("lineage_step", identity)
        if isinstance(cached, dict) and "parent" in cached and isinstance(cached.get("changes"), list):
            parent, changes = cached["parent"], [tuple(row) for row in cached["changes"]]
        else:
            parent = self.git("rev-parse", commit + "^1").decode().strip()
            raw = self.git("diff", "--name-status", "-z", "--find-renames=100%", parent, commit)
            fields, changes, i = raw.split(b"\0"), [], 0
            while i < len(fields) - 1:
                status, source = fields[i].decode(), fields[i + 1].decode("utf-8", "replace")
                i += 2
                destination = None
                if status.startswith(("R", "C")):
                    destination = fields[i].decode("utf-8", "replace"); i += 1
                changes.append((status, source, destination))
            self._persist("lineage_step", identity, {"parent": parent, "changes": [list(row) for row in changes]})
        result = parent, tuple(changes)
        # Conservative bound for decoded strings, tuples and dictionary entries.
        size = 256 + sum(256 + sum(len(v.encode()) * 4 for v in row if v is not None) for row in changes)
        if self.immutable_cache is not None and size <= LINEAGE_CACHE_BYTES:
            if self._lineage_bytes + size > LINEAGE_CACHE_BYTES:
                self._lineage_steps.clear()
                self._lineage_bytes = 0
            self._lineage_steps[commit] = result
            self._lineage_bytes += size
        return result

    def lineage(self, old, new, name):
        """Only first-parent ancestry and unique exact renames are evidenced v1.

        Changing what this returns requires bumping LINEAGE_RESULT_EPOCH.

        Any intermediate deletion, copy, non-exact rename or duplicate source blob
        ends inherited coverage. Explicit verified nonancestor mappings may be
        supplied by a later evidence importer; ancestry alone cannot provide one.
        """
        if self.disk_cache is None or not all(re.fullmatch(r"[0-9a-f]{40,64}", c) for c in (old, new)):
            return self._lineage(old, new, name)
        key = ("lineage", old, new, name)
        remembered = self._memo(key)
        if remembered is not None:
            return remembered[0]
        identity = {"old": old, "new": new, "path": name}
        cached = self._cached("lineage", identity)
        if isinstance(cached, dict) and "path" in cached:
            result = cached["path"]
        else:
            result = self._lineage(old, new, name)
            self._persist("lineage", identity, {"path": result})
        self._remember(key, (result,), 256 + sum(sys.getsizeof(v) for v in key) + sys.getsizeof(result))
        return result

    def _lineage(self, old, new, name):
        if name not in self._entries(old):
            return None
        chain = self.git("rev-list", "--first-parent", new).decode().splitlines()
        if old not in chain:
            return None
        current = name
        for commit in reversed(chain[:chain.index(old)]):
            parent, changes = self._lineage_step(commit)
            for status, source, destination in changes:
                if source != current:
                    continue
                if status == "D" or status.startswith("C"):
                    return None
                if status.startswith("R"):
                    # Ordinary edits and unrelated paths cannot remove current:
                    # the complete name-status diff above witnesses every
                    # deletion/rename. Only a rename needs whole-tree blob
                    # counts to reject ambiguous copies. Scanning every tree
                    # for every path thrashes the bounded tree cache.
                    before = self._entries(parent)
                    entries = self._entries(commit)
                    blob = before.get(current, {}).get("blob")
                    if status != "R100" or sum(e["blob"] == blob for e in before.values()) != 1 or sum(e["blob"] == blob for e in entries.values()) != 1:
                        return None
                    current = destination
        return current if current in self._entries(new) else None

    def proven_deleted(self, old, new, name):
        """Recognize only an unambiguous deletion; other missing lineage is unknown."""
        old_entries, new_entries = self._entries(old), self._entries(new)
        if name not in old_entries or name in new_entries:
            return False
        if old not in self.git("rev-list", "--first-parent", new).decode().splitlines():
            return False
        blob = old_entries[name]["blob"]
        if sum(e["blob"] == blob for e in old_entries.values()) != 1 or any(e["blob"] == blob for e in new_entries.values()):
            return False
        changes = self.git("diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-status", "-z", old, new).split(b"\0")
        if not changes or changes[-1] != b"" or len(changes) % 2 != 1:
            return False
        if (b"D", name.encode("utf-8")) not in zip(changes[0:-1:2], changes[1:-1:2]):
            return False
        renamed = self.git("diff", "--no-ext-diff", "--no-textconv", "--find-renames", "-l0", "--name-status", "-z", old, new).split(b"\0")
        for index, part in enumerate(renamed[:-1]):
            if part.startswith((b"R", b"C")) and index + 1 < len(renamed) and renamed[index + 1] == name.encode("utf-8"):
                return False
        return True

    def carry(self, old, new, name, lines):
        cacheable = all(re.fullmatch(r"[0-9a-f]{40,64}", c) for c in (old, new))
        key = ("carry", old, new, name, tuple(BLAME_OPTIONS))
        outcome = self._memo(key) if cacheable else None
        identity = {"old": old, "new": new, "path": name, "options": BLAME_OPTIONS}
        if outcome is None:
            cached = self._cached("carry", identity) if cacheable else None
            if isinstance(cached, dict) and "path" in cached and "old_lines" in cached and isinstance(cached.get("matches"), list):
                outcome = cached["path"], dict(cached["matches"]), cached["old_lines"]
            else:
                mapped = self.lineage(old, new, name)
                matches, maximum = {}, 0
                if mapped is not None:
                    old_blame, new_blame = self.blame(old, name), self.blame(new, mapped)
                    counts, old_counts = collections.Counter(new_blame), collections.Counter(old_blame)
                    positions = {sig: i for i, sig in enumerate(new_blame, 1) if counts[sig] == 1}
                    matches = {i: positions[sig] for i, sig in enumerate(old_blame, 1)
                               if old_counts[sig] == 1 and sig in positions}
                    maximum = len(old_blame)
                outcome = mapped, matches, maximum
                if cacheable:
                    self._persist("carry", identity, {"path": mapped, "matches": [[k, v] for k, v in matches.items()], "old_lines": maximum})
            if cacheable:
                size = 512 + sys.getsizeof(outcome[1]) + sum(sys.getsizeof(k) + sys.getsizeof(v) for k, v in outcome[1].items())
                self._remember(key, outcome, size)
        mapped, matches, maximum = outcome
        if mapped is None:
            return None, set()
        selected = set()
        for number in lines:
            if number <= maximum:
                normalized = number if number > 0 else maximum + number
                if normalized < 1:
                    raise IndexError("list index out of range")
                if normalized in matches:
                    selected.add(matches[normalized])
        return mapped, selected

    def coverage(self, target, reviews, artifacts):
        ledger.validate_sequence(reviews)
        creditable = [value for value in reviews if ledger.creditable(value)]
        identity = {"target": target, "reviews": [value["id"] for value in creditable], "options": BLAME_OPTIONS}
        cached = self._cached("coverage", identity)
        if isinstance(cached, dict):
            try:
                for value in creditable:
                    for reference in value["payload"]["artifacts"]:
                        artifacts.verify(reference)
                return ({name: ledger.intervals(rows) for name, rows in cached["covered"].items()},
                        {name: list(ids) for name, ids in cached["evidence"].items()}, [])
            except (OSError, ValueError, KeyError, TypeError):
                pass  # Missing evidence is retried below and becomes a gap.
        covered, evidence, gaps = collections.defaultdict(set), collections.defaultdict(list), []
        self.fold(target, reviews, artifacts, covered, evidence, gaps)
        if not gaps:
            self._persist("coverage", identity, {"covered": {name: ranges(lines) for name, lines in covered.items()},
                                                  "evidence": dict(evidence)})
        return dict(covered), dict(evidence), gaps

    def fold(self, target, reviews, artifacts, covered, evidence, gaps):
        """Add each creditable review's credit at target. Coverage is a union over
        independent reviews, so callers may fold an already validated ledger
        sequence incrementally (a suffix, or retried gap reviews)."""
        for value in reviews:
            if not ledger.creditable(value):
                continue
            try:
                verified = self._verify_once(value, artifacts)
                for name, lines in verified.items():
                    mapped, inherited = (name, lines) if value["payload"]["target"] == target else self.carry(value["payload"]["target"], target, name, lines)
                    if inherited:
                        covered[mapped].update(inherited)
                        evidence[mapped].append(value["id"])
            except (OSError, ValueError, subprocess.SubprocessError) as exc:
                gaps.append({"review": value["id"], "reason": str(exc)[:200]})

    def _verify_once(self, value, artifacts):
        """Restore and verify a review's evidence. Both are target-independent:
        with the invocation cache on, the outcome (credit or failure) is reused
        for every target instead of repeating bundle restore per target."""
        key = ledger.digest(value) if self.immutable_cache is not None else None
        if key in self._verified:
            outcome = self._verified[key]
            if isinstance(outcome, Exception):
                raise outcome
            return outcome
        try:
            for ref in value["payload"]["artifacts"]:
                artifacts.verify(ref)
            identity = {"review": key or ledger.digest(value)}
            cached = self._cached("verified_review", identity)
            outcome = None
            if isinstance(cached, dict):
                try:
                    outcome = {name: ledger.intervals(rows) for name, rows in cached.items()}
                except (TypeError, ValueError):
                    pass
            if outcome is not None and not self._has_commit(value["payload"]["target"]):
                # Later lineage/blame at the review target needs its objects.
                self.restore(value["payload"]["artifacts"], artifacts)
            if outcome is None:
                self.restore(value["payload"]["artifacts"], artifacts)
                outcome = self.verify_review(value)
                self._persist("verified_review", identity, {name: ranges(lines) for name, lines in outcome.items()})
        except (OSError, ValueError, subprocess.SubprocessError) as exc:
            if key:
                self._verified[key] = exc
            raise
        if key:
            self._verified[key] = outcome
        return outcome

    def churn(self, target, evaluated_at):
        at = ledger.timestamp(evaluated_at)
        since = (at - dt.timedelta(days=30)).strftime("%Y-%m-%dT%H:%M:%SZ")
        commits = self.git("rev-list", "--first-parent", "--since=" + since, "--until=" + evaluated_at, target).decode().splitlines()
        counts = collections.Counter()
        for commit in commits:
            parents = self.git("rev-list", "--parents", "-n", "1", commit).decode().split()[1:]
            names = self.git("diff-tree", "--root", "--no-commit-id", "--name-only", "-r", "-z", *( [parents[0], commit] if parents else [commit]))
            counts.update(set(n.decode("utf-8", "replace") for n in names.split(b"\0") if n))
        return dict(counts)
