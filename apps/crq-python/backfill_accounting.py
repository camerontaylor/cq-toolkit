"""Explicit scope accounting; Git provenance carries credit, never creates it."""
import collections
import datetime as dt
from pathlib import Path
import re
import subprocess

import review_ledger as ledger

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


class Repository:
    def __init__(self, root):
        self.root = Path(root)

    def git(self, *args, check=True, env=None, input=None):
        return subprocess.run(["git", *args], cwd=self.root, capture_output=True,
                              check=check, env=env, input=input).stdout

    def resolve(self, value):
        if not re.fullmatch(r"[0-9a-f]{40,64}", value):
            raise ledger.IntegrityError("target must be an immutable full object ID")
        return self.git("rev-parse", value + "^{commit}").decode().strip()

    def tree(self, commit):
        return self.git("rev-parse", self.resolve(commit) + "^{tree}").decode().strip()

    def entries(self, commit):
        result = {}
        for raw in self.git("ls-tree", "-r", "-z", self.resolve(commit)).split(b"\0"):
            if not raw:
                continue
            meta, name = raw.split(b"\t", 1)
            mode, kind, blob = meta.decode().split()
            try:
                name = ledger.path(name.decode("utf-8"))
            except (UnicodeError, ValueError):
                # Keep an explicit reversible representation for unencodable paths.
                name = "git-path-bytes:" + name.hex()
            result[name] = {"path": name, "mode": mode, "kind": kind, "blob": blob}
        return result

    def inventory(self, target, max_file_bytes):
        rows = []
        for name, entry in sorted(self.entries(target).items(), key=lambda v: v[0].encode()):
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
        # helpers. Literal path/blob mapping comes from raw name-status + hunks.
        patch = self.git("diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--unified=0", base, head).decode("utf-8", "replace")
        for line in patch.splitlines():
            if line.startswith("+++ b/"):
                name = line[6:]
                if name.startswith('"') or "\\" in name:
                    current = None  # quoted names use whole-file residual fallback
                else:
                    current = name
                    result.setdefault(current, set())
            elif line == "+++ /dev/null":
                current = None
            elif current and line.startswith("@@ "):
                match = re.match(r"@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@", line)
                if match:
                    start, count = int(match[1]), int(match[2] or 1)
                    result[current].update(range(start, start + count))
        return result

    def verify_review(self, value):
        ledger.validate(value)
        if not ledger.creditable(value):
            return {}
        p = value["payload"]
        if self.tree(p["target"]) != p["target_tree"] or self.tree(p["head"]) != p["head_tree"]:
            raise ledger.IntegrityError("review tree mismatch")
        target, head = self.entries(p["target"]), self.entries(p["head"])
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
        raw = self.git("blame", *BLAME_OPTIONS, target, "--", ledger.path(name)).splitlines()
        result, origin, original_line, filename = [], None, None, None
        for line in raw:
            header = re.fullmatch(rb"([0-9a-f]{40,64}) (\d+) (\d+)(?: \d+)?", line)
            if header:
                origin, original_line = header[1].decode(), int(header[2])
            elif line.startswith(b"filename "):
                filename = line[9:]
            elif line.startswith(b"\t"):
                result.append((origin, original_line, filename, line[1:]))
        return result

    def lineage(self, old, new, name):
        """Only first-parent ancestry and unique exact renames are evidenced v1.

        Any intermediate deletion, copy, non-exact rename or duplicate source blob
        ends inherited coverage. Explicit verified nonancestor mappings may be
        supplied by a later evidence importer; ancestry alone cannot provide one.
        """
        chain = self.git("rev-list", "--first-parent", new).decode().splitlines()
        if old not in chain:
            return None
        current = name
        for commit in reversed(chain[:chain.index(old)]):
            parent = self.git("rev-parse", commit + "^1").decode().strip()
            entries = self.entries(commit)
            before = self.entries(parent)
            changes = self.git("diff", "--name-status", "-z", "--find-renames=100%", parent, commit).split(b"\0")
            i = 0
            while i < len(changes) - 1:
                status, source = changes[i].decode(), changes[i + 1].decode("utf-8", "replace")
                i += 2
                destination = None
                if status.startswith(("R", "C")):
                    destination = changes[i].decode("utf-8", "replace"); i += 1
                if source != current:
                    continue
                if status == "D" or status.startswith("C"):
                    return None
                if status.startswith("R"):
                    blob = before.get(current, {}).get("blob")
                    if status != "R100" or sum(e["blob"] == blob for e in before.values()) != 1 or sum(e["blob"] == blob for e in entries.values()) != 1:
                        return None
                    current = destination
            if current not in entries:
                return None
        return current

    def carry(self, old, new, name, lines):
        mapped = self.lineage(old, new, name)
        if mapped is None:
            return None, set()
        old_blame, new_blame = self.blame(old, name), self.blame(new, mapped)
        original = [old_blame[n - 1] for n in lines if n <= len(old_blame)]
        counts = collections.Counter(new_blame)
        old_counts = collections.Counter(old_blame)
        signatures = {sig for sig in original if counts[sig] == 1 and old_counts[sig] == 1}
        return mapped, {i for i, sig in enumerate(new_blame, 1) if sig in signatures}

    def coverage(self, target, reviews, artifacts):
        ledger.validate_sequence(reviews)
        covered, evidence, gaps = collections.defaultdict(set), collections.defaultdict(list), []
        for value in reviews:
            if not ledger.creditable(value):
                continue
            try:
                for ref in value["payload"]["artifacts"]:
                    artifacts.verify(ref)
                verified = self.verify_review(value)
                for name, lines in verified.items():
                    mapped, inherited = (name, lines) if value["payload"]["target"] == target else self.carry(value["payload"]["target"], target, name, lines)
                    if inherited:
                        covered[mapped].update(inherited)
                        evidence[mapped].append(value["id"])
            except (OSError, ValueError, subprocess.SubprocessError) as exc:
                gaps.append({"review": value["id"], "reason": str(exc)[:200]})
        return dict(covered), dict(evidence), gaps

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
