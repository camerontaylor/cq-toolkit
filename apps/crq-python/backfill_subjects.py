"""Bounded current-tip subjects with immutable, generation-specific Git pins."""
import os
from pathlib import Path
import subprocess
import tempfile

import review_ledger as ledger
from backfill_accounting import ranges
from backfill_inventory import effective_limits


def _commit(repo, tree, parent, message):
    env = dict(os.environ, GIT_AUTHOR_NAME="crq", GIT_AUTHOR_EMAIL="crq@localhost",
               GIT_COMMITTER_NAME="crq", GIT_COMMITTER_EMAIL="crq@localhost",
               GIT_AUTHOR_DATE="2000-01-01T00:00:00Z", GIT_COMMITTER_DATE="2000-01-01T00:00:00Z")
    return repo.git("commit-tree", tree, "-p", parent, "-m", message, env=env).decode().strip()


def projection(repo, target, names):
    repo.resolve(target)
    with tempfile.TemporaryDirectory() as td:
        env = dict(os.environ, GIT_INDEX_FILE=str(Path(td) / "index"), GIT_LITERAL_PATHSPECS="1")
        repo.git("read-tree", target, env=env)
        for name in sorted(set(names), key=lambda n: n.encode()):
            ledger.path(name)
            repo.git("update-index", "--force-remove", "--", name, env=env)
        tree = repo.git("write-tree", env=env).decode().strip()
    base = _commit(repo, tree, target, "crq current projection base")
    return base, _commit(repo, repo.tree(target), base, "crq current projection head")


def synthetic(repo, target, names, members):
    """Earliest applicable pre-merge baseline on a linear ancestry chain.

    members: retained {merge, paths:[{source_path,path,lineage_verified}]}.
    Missing/conflicting lineage or a nonlinear union safely projects whole files.
    """
    target = repo.resolve(target)
    ordered = sorted(members, key=lambda m: m["merge"])
    def ancestor(a, b):
        return subprocess.run(["git", "merge-base", "--is-ancestor", a, b], cwd=repo.root,
                              capture_output=True).returncode == 0
    for member in ordered:
        repo.resolve(member["merge"])
    ordered.sort(key=lambda m: (sum(ancestor(other["merge"], m["merge"]) for other in ordered), m["merge"]))
    if any(not ancestor(a["merge"], b["merge"]) for a, b in zip(ordered, ordered[1:])):
        return (*projection(repo, target, names), {n: {"method": "projection", "reason": "nonlinear stack baselines"} for n in names})
    baselines = {}
    for name in names:
        for member in ordered:
            matches = [p for p in member["paths"] if p.get("path") == name]
            if not matches:
                continue
            row = matches[0]
            if len(matches) != 1 or not row.get("lineage_verified"):
                break
            original = ledger.path(row["source_path"])
            if repo.lineage(member["merge"], target, original) != name:
                break
            pre = repo.git("rev-parse", member["merge"] + "^1").decode().strip()
            old = repo.entries(pre).get(original)
            baselines[name] = {"method": "pre-merge", "merge": member["merge"], "pre": pre,
                               "source_path": original, "entry": old}
            break
    if len(baselines) != len(names):
        return (*projection(repo, target, names), {n: {"method": "projection", "reason": "missing/ambiguous baseline lineage"} for n in names})
    with tempfile.TemporaryDirectory() as td:
        env = dict(os.environ, GIT_INDEX_FILE=str(Path(td) / "index"), GIT_LITERAL_PATHSPECS="1")
        repo.git("read-tree", target, env=env)
        for name, baseline in baselines.items():
            entry = baseline["entry"]
            if entry and entry["mode"] in ("100644", "100755"):
                repo.git("update-index", "--add", "--cacheinfo", f"{entry['mode']},{entry['blob']},{name}", env=env)
            elif entry:
                return (*projection(repo, target, names), {n: {"method": "projection", "reason": "non-regular baseline"} for n in names})
            else:
                repo.git("update-index", "--force-remove", "--", name, env=env)
        tree = repo.git("write-tree", env=env).decode().strip()
    base = _commit(repo, tree, target, "crq pinned synthetic base")
    return base, _commit(repo, repo.tree(target), base, "crq pinned synthetic head"), baselines


def pin(repo, identity, generation, partition, base, head, target):
    if not isinstance(generation, int) or generation < 0 or not isinstance(partition, int) or partition < 0:
        raise ledger.IntegrityError("invalid pin generation/partition")
    if len(identity) != 64 or any(c not in "0123456789abcdef" for c in identity):
        raise ledger.IntegrityError("invalid subject identity")
    prefix = f"refs/crq/backfill/{identity}/{generation}/{partition}"
    for label, sha in (("base", base), ("head", head), ("target", target)):
        ref = prefix + "/" + label
        existing = repo.git("rev-parse", "--verify", "--quiet", ref, check=False).decode().strip()
        if existing and existing != sha:
            raise ledger.IntegrityError("immutable subject pin conflict")
        if not existing:
            repo.git("update-ref", ref, sha, "0" * len(sha))
    return prefix


def construct(repo, candidate, policy, members=(), *, offline=False):
    limits = effective_limits(policy, require_verified=not offline)
    target = repo.resolve(candidate["target"])
    objects = {r["path"]: r for r in repo.inventory(target, limits["per_file"])}
    for name, row in objects.items():
        row["tier"] = candidate.get("path_tiers", {}).get(name, candidate["tier"])
    requested = {r["path"]: r for r in candidate["scope"]}
    debt, partitions = [], []
    context = {"trust": "untrusted-data-only", "prs": candidate["prs"],
               "sources": [{"pr": m.get("pr"), "context": m.get("context", {})} for m in members]}
    names = sorted(requested, key=lambda n: n.encode())
    names.sort(key=lambda n: objects.get(n, {}).get("tier", candidate["tier"]))
    eligible = []
    for name in names:
        row = objects.get(name)
        if row is None or row["disposition"] != "included" or row["blob"] != requested[name]["blob"]:
            debt.append({"path": name, "reason": (row or {}).get("reason", "missing target path"), "disposition": (row or {}).get("disposition", "ambiguous")})
        else:
            eligible.append(name)

    def cut(nameset, residual=False):
        if not nameset:
            return
        if len(nameset) > limits["files"] or sum(objects[n]["bytes"] for n in nameset) > limits["total"]:
            if len(nameset) == 1:
                debt.append({"path": nameset[0], "disposition": "unsupported", "reason": "single file exceeds total content limit"})
                return
            midpoint = len(nameset) // 2
            cut(nameset[:midpoint], residual); cut(nameset[midpoint:], residual)
            return
        if candidate["kind"] == "A" and not residual:
            base, head, provenance = synthetic(repo, target, nameset, members)
        else:
            base, head = projection(repo, target, nameset)
            provenance = {n: {"method": "projection", "reason": "residual uncovered lines" if residual else "path cluster"} for n in nameset}
        # Context is transported in the synthetic input commit, as inert text.
        # It cannot change the target tree, Git argv, baseline or requested paths.
        if context["sources"]:
            message = "crq pinned current subject\n\nBEGIN UNTRUSTED PR CONTEXT\n" + ledger.canonical(context).decode() + "\nEND UNTRUSTED PR CONTEXT"
            head = _commit(repo, repo.tree(target), base, message)
        diff_bytes = len(repo.git("diff", "--no-ext-diff", "--no-textconv", "--binary", base, head))
        if limits["diff"] is not None and diff_bytes > limits["diff"]:
            if len(nameset) > 1:
                middle = len(nameset) // 2; cut(nameset[:middle], residual); cut(nameset[middle:], residual)
            else:
                debt.append({"path": nameset[0], "disposition": "unsupported", "reason": "single-file diff exceeds verified reviewer byte limit"})
            return
        changed = repo.changed_intervals(base, head)
        scope, remaining = [], []
        for name in nameset:
            lines = ledger.intervals(requested[name]["intervals"])
            seen = lines & changed.get(name, set())
            if seen:
                scope.append({"path": name, "blob": objects[name]["blob"], "intervals": ranges(seen)})
            if lines - seen:
                remaining.append(name)
        if scope:
            number = len(partitions)
            identity = ledger.digest({"parent": candidate["subject_id"], "scope": scope, "partition": number, "residual": residual})
            refs = pin(repo, identity, candidate["generation"], number, base, head, target)
            paths = [{"path": n, "blob": objects[n]["blob"], "mode": objects[n]["mode"], "disposition": "included", "reason": "bounded verified input", "baseline": provenance[n]} for n in nameset]
            partitions.append({**candidate, "subject_id": identity, "inventory_subject_id": candidate["subject_id"],
                               "tier": min(objects[s["path"]]["tier"] for s in scope),
                               "score": sum(candidate.get("path_scores", {}).get(s["path"], 0) for s in scope),
                               "job_id": identity + ":" + str(candidate["generation"]),
                               "partition": number, "scope": scope, "scope_digest": ledger.digest(scope),
                               "base": base, "head": head, "head_tree": repo.tree(head), "target_tree": repo.tree(target),
                               "refs": refs, "paths": paths, "diff_bytes": diff_bytes, "residual": residual,
                               "context": context})
        if remaining:
            if residual:
                debt.extend({"path": n, "disposition": "unsupported", "reason": "projection cannot expose requested head intervals"} for n in remaining)
            else:
                cut(remaining, True)
    cut(eligible)
    return {"partitions": partitions, "debt": debt}
