"""Advisory review history and predecessor classification (S3a).

The projection is descriptive: every value names its source, and missing Git
objects, shallow history and binary line counts are ``None`` (unknown), never
zero. Nothing here grants review credit or establishes exact reuse; the only
scheduling effect is the repeat class consumed by ``crq.rank``.
"""
import hashlib
import json

import review_operation as operation
import repo_registry

MAX_ENTRIES = 50
DEFAULT_LIMIT = 20
SCOPE_TASK = "task"
SCOPE_BRANCH = "branch"
SCOPE_NONE = "none"


class GitUnavailable(Exception):
    """A Git object or operation needed for an observation is unavailable."""


def _digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"),
                                    ensure_ascii=True).encode()).hexdigest()


def _identity(item):
    return item.get("identity_inputs") or {}


def _head(item):
    return _identity(item).get("head_commit")


def _tree(item):
    return _identity(item).get("head_tree")


def _same_repo(a, b):
    return isinstance(a, str) and isinstance(b, str) and repo_registry.same_repo(a, b)


def _present(git, rev):
    if not rev:
        return False
    try:
        git("cat-file", "-e", rev + "^{commit}")
        return True
    except GitUnavailable:
        return False


def _ancestry(git, prior_head, head):
    """('ancestral'|'same'|'unrelated'|'unknown', commits_ahead).

    Both commits must be present for the server to make a claim. A server-side
    non-ancestor is unrelated; a missing object stays unknown.
    """
    if not prior_head or not head:
        return "unknown", None
    if not (_present(git, prior_head) and _present(git, head)):
        return "unknown", None
    if prior_head == head:
        return "same", 0
    try:
        git("merge-base", "--is-ancestor", prior_head, head)
    except GitUnavailable:
        return "unrelated", None
    try:
        return "ancestral", int(git("rev-list", "--count", prior_head + ".." + head))
    except (GitUnavailable, ValueError):
        return "ancestral", None


def _delta(git, prior_tree, head_tree):
    """Tree comparison only; commits and ancestry are reported separately."""
    result = dict(method="tree", files=None, insertions=None, deletions=None,
                  binary_files=None, partial=True)
    if not (prior_tree and head_tree):
        return result
    try:
        for tree in (prior_tree, head_tree):
            git("cat-file", "-e", tree + "^{tree}")
        raw = git("diff", "--numstat", prior_tree, head_tree).decode()
    except GitUnavailable:
        return result
    files = insertions = deletions = binary = 0
    for line in raw.splitlines():
        parts = line.split("\t")
        if len(parts) < 3:
            continue
        files += 1
        if parts[0] == "-" or parts[1] == "-":
            binary += 1
            continue
        try:
            insertions += int(parts[0])
            deletions += int(parts[1])
        except ValueError:
            binary += 1
    # Binary line counts are unknown, so a mixed delta reports no line totals.
    known = binary == 0
    result.update(files=files, binary_files=binary,
                  insertions=insertions if known else None,
                  deletions=deletions if known else None,
                  partial=binary > 0)
    return result


def _entries_for(q, *, repo, target, task, branch, predecessor, head, head_tree, git,
                 exclude_item=None):
    """Associated items, newest first, with their relationship to this head."""
    requests = q.get("review_requests") or {}
    by_item = {}
    for request_id, binding in requests.items():
        item_id = binding.get("item")
        if item_id is not None:
            by_item.setdefault(item_id, request_id)
    linked = []
    for item in q.get("items") or []:
        if item.get("kind") != operation.KIND:
            continue
        if exclude_item is not None and item.get("id") == exclude_item:
            continue
        inputs = _identity(item)
        if not _same_repo(inputs.get("repo"), repo):
            continue
        # Legacy items predate the recorded target; they are reachable only
        # through an explicit predecessor link, never a broad association.
        if not target or item.get("target") != target:
            continue
        prior_head = inputs.get("head_commit")
        same_task = task is not None and item.get("task") == task
        same_branch = (branch is not None and branch != target
                       and item.get("branch") == branch)
        if predecessor is not None and by_item.get(item.get("id")) == predecessor:
            same_task = same_task or item.get("task") is not None
        if not (same_task or same_branch):
            continue
        relation, distance = _ancestry(git, prior_head, head)
        tree_available = bool(_tree(item) and head_tree)
        linked.append(dict(
            item=item.get("id"), request_id=by_item.get(item.get("id")),
            generation=item.get("generation", 1), state=item.get("state"),
            created_at=item.get("created_at"), head_commit=prior_head,
            head_tree=_tree(item), task=item.get("task"), branch=item.get("branch"),
            same_task=same_task, same_branch=same_branch,
            relationship=("ancestral" if relation in ("ancestral", "same")
                          else "possible" if relation == "unknown" else "unrelated"),
            ancestry="server" if relation in ("ancestral", "same", "unrelated") else None,
            commits_ahead=distance,
            delta=_delta(git, _tree(item), head_tree) if tree_available else None,
        ))
    linked.sort(key=lambda row: (row.get("created_at") or "", row.get("item") or ""), reverse=True)
    return linked


def _summary(q, linked):
    item_ids = {row["item"] for row in linked}
    request_ids = {rid for rid, binding in (q.get("review_requests") or {}).items()
                   if binding.get("item") in item_ids}
    items = [i for i in q.get("items") or [] if i.get("id") in item_ids]
    invocations = sum(len(i.get("attempts") or []) + (1 if i.get("run") else 0) for i in items)
    completed = sum(1 for i in items
                    if i.get("state") == "done" and i.get("scope_adequate") is True
                    and bool(i.get("receipt_id")))
    failed = sum(int(i.get("failures") or 0) for i in items)
    return dict(requests=len(request_ids), invocations=invocations,
                completed=completed, failed=failed)


def _cue(predecessor, delta, summary, repeat):
    if predecessor is None:
        return None
    head = (predecessor.get("head_commit") or "")[:12]
    if predecessor["relationship"] == "possible":
        return (f"Possible earlier review at {head} (task/branch continuity, "
                f"ancestry unverified). {summary['completed']} CodeRabbit "
                f"review(s) completed for this work.")
    since = []
    if delta is None or delta.get("commits_ahead") is None:
        since.append("commit distance unknown (shallow or missing history)")
    else:
        commits = delta["commits_ahead"]
        since.append(f"{commits} commit{'s' if commits != 1 else ''} "
                     f"({predecessor['ancestry']}-verified)")
    if delta is not None and delta.get("files") is not None:
        since.append(f"{delta['files']} files")
    if delta is not None and delta.get("insertions") is not None:
        since.append(f"+{delta['insertions']}/-{delta['deletions']} (tree comparison)")
    elif delta is not None:
        since.append("line counts unknown (binary or missing trees)")
    text = f"Previously reviewed at {head}. Since then: {', '.join(since)}. "
    text += f"{summary['completed']} CodeRabbit review(s) completed for this work."
    if repeat:
        text += " This request will wait behind first reviews. It is queued; keep working or wait."
    return text


def project(q, *, repo, target, head_commit=None, head_tree=None, task=None,
            branch=None, predecessor=None, observed=None, limit=DEFAULT_LIMIT,
            cursor=0, git, exclude_item=None):
    """Resolve one advisory history projection.

    ``git(*args)`` must return bytes and raise :class:`GitUnavailable` when an
    object cannot be read. A client observation (``observed``) is only
    considered for the explicit ``predecessor`` and is always labelled client.
    """
    if type(limit) is not int or not 1 <= limit <= MAX_ENTRIES:
        raise ValueError("history limit must be an integer from 1 to 50")
    if type(cursor) is not int or cursor < 0:
        raise ValueError("history cursor must be a non-negative integer")
    if branch is not None and target is not None and branch == target:
        branch = None
    linked = _entries_for(q, repo=repo, target=target, task=task, branch=branch,
                          predecessor=predecessor, head=head_commit,
                          head_tree=head_tree, git=git, exclude_item=exclude_item)
    # Explicit predecessor may live outside the association set; include it.
    if predecessor is not None:
        item_id = (q.get("review_requests") or {}).get(predecessor, {}).get("item")
        if (item_id is not None and item_id != exclude_item
                and not any(row["item"] == item_id for row in linked)):
            for item in q.get("items") or []:
                if item.get("id") == item_id and item.get("kind") == operation.KIND:
                    relation, distance = _ancestry(git, _head(item), head_commit)
                    linked.append(dict(
                        item=item_id, request_id=predecessor,
                        generation=item.get("generation", 1), state=item.get("state"),
                        created_at=item.get("created_at"), head_commit=_head(item),
                        head_tree=_tree(item), task=item.get("task"),
                        branch=item.get("branch"), same_task=item.get("task") == task,
                        same_branch=False,
                        relationship=("ancestral" if relation in ("ancestral", "same")
                                      else "possible" if relation == "unknown" else "unrelated"),
                        ancestry="server" if relation in ("ancestral", "same", "unrelated") else None,
                        commits_ahead=distance,
                        delta=_delta(git, _tree(item), head_tree),
                    ))
                    linked.sort(key=lambda row: (row.get("created_at") or "",
                                                 row.get("item") or ""), reverse=True)
                    break
    # A client may supply ancestry and distance only for its explicit link.
    if observed and predecessor is not None:
        for row in linked:
            if row["request_id"] == predecessor and row["ancestry"] is None:
                if observed.get("ancestor") is True:
                    row.update(relationship="ancestral", ancestry="client",
                               commits_ahead=observed.get("commits_ahead"))
                elif observed.get("ancestor") is False:
                    row.update(relationship="unrelated", ancestry="client")
    ancestral = [row for row in linked if row["relationship"] == "ancestral"]
    ancestral.sort(key=lambda row: (row["commits_ahead"] is None,
                                    row["commits_ahead"] or 0,
                                    str(row.get("created_at") or "")))
    headline = None
    if predecessor is not None:
        headline = next((row for row in linked
                         if row["request_id"] == predecessor
                         and row["relationship"] == "ancestral"), None)
    headline = headline or (ancestral[0] if ancestral else None)
    if headline is None:
        possible = next((row for row in linked if row["relationship"] == "possible"), None)
        if possible is not None:
            headline = possible
    summary = _summary(q, linked)
    repeat = bool(headline is not None and headline["relationship"] == "ancestral"
                  and (headline["same_task"]
                       or (headline["same_branch"] and headline["branch"] != target)))
    relation = ("none" if headline is None else
                "ancestral" if headline["relationship"] == "ancestral" else "possible")
    delta = headline.get("delta") if headline is not None else None
    if headline is not None and delta is not None and headline["commits_ahead"] is not None:
        delta = {**delta, "commits_ahead": headline["commits_ahead"],
                 "ancestry": headline["ancestry"]}
    elif headline is not None:
        delta = {**(delta or dict(method="tree", files=None, insertions=None,
                                  deletions=None, binary_files=None, partial=True)),
                 "commits_ahead": None, "ancestry": headline["ancestry"]}
    scope = SCOPE_TASK if task is not None else SCOPE_BRANCH if branch is not None else SCOPE_NONE
    material = dict(relation=relation, repeat=repeat, summary=summary, delta=delta,
                    predecessor=None if headline is None else
                    {k: headline[k] for k in ("item", "head_commit", "ancestry",
                                              "relationship", "commits_ahead")})
    page = linked[cursor:cursor + limit]
    next_cursor = cursor + limit if cursor + limit < len(linked) else None
    return dict(
        v=1, status="ok", scope=scope, relation=relation, repeat=repeat,
        predecessor=(None if headline is None else
                     {k: headline[k] for k in ("request_id", "item", "generation", "state",
                                               "created_at", "head_commit", "head_tree",
                                               "same_task", "same_branch", "relationship",
                                               "ancestry", "commits_ahead")}),
        delta=delta, summary=summary, cue=_cue(headline, delta, summary, repeat),
        entries=page, cursor=cursor, next_cursor=next_cursor,
        digest=_digest(material),
    )


def degraded(reason):
    """Advisory-only failure: exact reuse and admission continue unchanged."""
    return dict(v=1, status="degraded", reason=reason, scope=SCOPE_NONE,
                relation="none", repeat=False, predecessor=None, delta=None,
                summary=None, cue=None, entries=[], cursor=0, next_cursor=None,
                digest=_digest(dict(status="degraded", reason=reason)))
