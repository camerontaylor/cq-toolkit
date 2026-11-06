"""Post crq findings on an open primary-repo PR as one GitHub pull-request review.

A counted open/delta review with findings becomes ONE review
(`POST /repos/{repo}/pulls/{pr}/reviews`, event COMMENT, `commit_id` = the
reviewed head). Each finding whose lines fall inside the PR diff for that
commit becomes an inline comment, so it opens its own resolvable review thread
(GraphQL `reviewThreads` / reply / `resolveReviewThread`). Findings that cannot
be anchored are listed in the review body instead.

The review is labelled plainly as crq output: no CodeRabbit branding, bot
markers or comment format. Its body starts with a hidden marker
`<!-- crq-findings run=<run_id> -->`; before posting, the PR's existing reviews
are searched for that marker, so a crash between the POST and the queue save
is safe to retry and one run is never posted twice.

Pure module: plain data in, `gh` injected (the same shape as finding_issues).
"""
import json
import re
import subprocess
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

GH_TIMEOUT = 60       # seconds per gh call; a delivery makes at most five
MAX_INLINE = 50       # inline threads per review; the rest go in the body
MAX_COMMENT = 12000   # characters per inline comment (GitHub caps at 65536)
MAX_BODY = 60000      # characters per review body (GitHub caps at 65536)
RUN_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,200}")
REPO = re.compile(r"[\w.-]+/[\w.-]+")
SHA = re.compile(r"[0-9a-f]{40}")
HUNK = re.compile(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@", re.M)
HTML_COMMENT = re.compile(r"<!--.*?-->", re.S)

Gh = Callable[..., Any]


def marker(run_id: str) -> str:
    return f"<!-- crq-findings run={run_id} -->"


# ----------------------------------------------------------- findings


def load_findings(ndjson: Path) -> List[Dict[str, Any]]:
    """Finding events from the run's review.ndjson, exact duplicates dropped.

    The CLI sometimes emits the same finding twice in one stream; posting both
    would open two identical threads."""
    out: List[Dict[str, Any]] = []
    seen = set()
    for line in Path(ndjson).read_text(errors="replace").splitlines():
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if not isinstance(event, dict) or event.get("type") != "finding":
            continue
        finding = {"severity": str(event.get("severity") or "none"),
                   "path": event.get("fileName") if isinstance(event.get("fileName"), str) else None,
                   "start": _line(event.get("startLine")), "end": _line(event.get("endLine")),
                   "title": str(event.get("title") or "").strip(),
                   "text": str(event.get("comment") or event.get("title") or "").strip()}
        if finding["start"] and not finding["end"]:
            finding["end"] = finding["start"]
        if finding["end"] and not finding["start"]:
            finding["start"] = finding["end"]
        if finding["start"] and finding["end"] and finding["start"] > finding["end"]:
            finding["start"], finding["end"] = finding["end"], finding["start"]
        key = (finding["path"], finding["start"], finding["end"], finding["title"], finding["text"])
        if key in seen:
            continue
        seen.add(key)
        out.append(finding)
    return out


def _line(value: Any) -> Optional[int]:
    return value if type(value) is int and value > 0 else None


def clean_text(text: str, title: str = "") -> str:
    """Finding prose without HTML comments (no foreign bot markers, and no way
    to forge the crq marker) and without a leading bold copy of the title.
    Committable ```suggestion blocks become plain fences: a clamped anchor
    could otherwise offer to replace the wrong lines."""
    text = HTML_COMMENT.sub("", text).strip()
    if title and text.startswith(f"**{title}**"):
        text = text[len(title) + 4:].lstrip()
    return re.sub(r"^(\s*)```suggestion\b", r"\1```text", text, flags=re.M)


# ----------------------------------------------------------- anchoring


def right_ranges(patch: str) -> List[Tuple[int, int]]:
    """Right-side (new file) line ranges covered by each hunk of a unified patch.

    GitHub accepts a RIGHT-side review comment on any line its diff shows for
    the file, context lines included, and rejects the rest with 422."""
    ranges = []
    for match in HUNK.finditer(patch or ""):
        start = int(match.group(1))
        length = int(match.group(2)) if match.group(2) is not None else 1
        if length > 0:
            ranges.append((start, start + length - 1))
    return ranges


def anchor(finding: Dict[str, Any], hunks: Dict[str, List[Tuple[int, int]]]) -> Optional[Dict[str, Any]]:
    """Inline position for a finding, or None when it must go in the body.

    The first hunk overlapping the finding's lines anchors it, clamped to that
    hunk (GitHub rejects a range spanning hunks)."""
    path, start, end = finding["path"], finding["start"], finding["end"]
    if not path or not start or path not in hunks:
        return None
    for lo, hi in hunks[path]:
        if start <= hi and end >= lo:
            first, last = max(start, lo), min(end, hi)
            position = {"path": path, "line": last, "side": "RIGHT"}
            if first < last:
                position.update(start_line=first, start_side="RIGHT")
            return position
    return None


def _lines(finding: Dict[str, Any]) -> str:
    if not finding["start"]:
        return ""
    if finding["start"] == finding["end"]:
        return f"line {finding['start']}"
    return f"lines {finding['start']}-{finding['end']}"


def _clip(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[:limit].rstrip() + "\n\n… (truncated; full text in the crq run artifacts)"


def build_review(meta: Dict[str, Any], findings: List[Dict[str, Any]],
                 hunks: Optional[Dict[str, List[Tuple[int, int]]]]) -> Dict[str, Any]:
    """Review payload. `hunks=None` means no diff is known: body-only, no commit_id."""
    run_id, base, head = meta["run_id"], meta["base"], meta["head"]
    comments, unanchored = [], []
    for number, finding in enumerate(findings, 1):
        position = anchor(finding, hunks) if hunks is not None and len(comments) < MAX_INLINE else None
        heading = f"**crq finding F{number} [{finding['severity']}]**"
        if finding["title"]:
            heading += f" {finding['title']}"
        text = clean_text(finding["text"], finding["title"])
        if position:
            where = _lines(finding)
            note = f"\n\n<sub>crq run `{run_id}`{', ' + where if where else ''}</sub>"
            comments.append({**position, "body": _clip(f"{heading}\n\n{text}", MAX_COMMENT) + note})
        else:
            unanchored.append((number, finding, heading, text))
    counts: Dict[str, int] = {}
    for finding in findings:
        counts[finding["severity"]] = counts.get(finding["severity"], 0) + 1
    summary = ", ".join(f"{n} {s}" for s, n in sorted(counts.items()))
    lines = [marker(run_id),
             f"### crq findings (CodeRabbit CLI, local run {run_id}, {base[:10]}..{head[:10]})", "",
             f"{len(findings)} finding(s) ({summary}): {len(comments)} as inline threads, "
             f"{len(unanchored)} listed below.", "",
             f"Queue item `{meta.get('item_id', '')}`, reviewed range `{base}..{head}`. "
             "Posted by crq, the local review queue that runs the CodeRabbit CLI on this host. "
             "This is not a CodeRabbit PR review. Reply on a thread or resolve it once addressed."]
    if unanchored:
        lines += ["", "#### Not anchored to the PR diff", ""]
        for number, finding, heading, text in unanchored:
            where = " ".join(x for x in (f"`{finding['path']}`" if finding["path"] else "", _lines(finding)) if x)
            lines += [f"{heading}{' (' + where + ')' if where else ''}", "", _clip(text, MAX_COMMENT), ""]
    body = "\n".join(lines).rstrip() + "\n"
    if len(body) > MAX_BODY:
        body = body[:MAX_BODY] + "\n\n… (truncated; full text in the crq run artifacts)\n"
    review: Dict[str, Any] = {"event": "COMMENT", "body": body, "comments": comments}
    if hunks is not None:
        review["commit_id"] = head
    return review


# ----------------------------------------------------------- gh


def _gh(argv: List[str], *, input_text: Optional[str] = None) -> subprocess.CompletedProcess:
    return subprocess.run(argv, capture_output=True, text=True, input=input_text, timeout=GH_TIMEOUT)


def _call(gh: Gh, argv: List[str], *, input_text: Optional[str] = None) -> Any:
    try:
        return gh(argv, input_text=input_text)
    except subprocess.TimeoutExpired as e:
        raise RuntimeError(f"{' '.join(argv[:4])} … timed out after {GH_TIMEOUT}s") from e
    except OSError as e:
        raise RuntimeError(f"{' '.join(argv[:4])} … could not start: {e}") from e


def _ok(argv: List[str], p: Any) -> Any:
    if getattr(p, "returncode", 0) != 0:
        stderr = (getattr(p, "stderr", "") or "").strip()[:300]
        raise RuntimeError(f"{' '.join(argv[:4])} … exit {p.returncode}: {stderr}")
    return p


def _json(gh: Gh, argv: List[str]) -> Any:
    out = _ok(argv, _call(gh, argv))
    try:
        return json.loads(out.stdout or "null")
    except ValueError as e:
        raise RuntimeError(f"{' '.join(argv[:4])} … unparsable output: {(out.stdout or '').strip()[:200]}") from e


def pr_state(gh: Gh, repo: str, pr: int) -> Dict[str, Any]:
    data = _json(gh, ["gh", "api", f"repos/{repo}/pulls/{pr}",
                      "--jq", "{state: .state, merged: .merged, base: .base.sha}"])
    if not isinstance(data, dict) or data.get("state") not in ("open", "closed"):
        raise RuntimeError(f"unexpected PR metadata for {repo}#{pr}")
    return data


def existing_review(gh: Gh, repo: str, pr: int, run_id: str) -> Optional[Dict[str, Any]]:
    """The PR review already carrying this run's marker, across every page."""
    wanted = json.dumps(marker(run_id))  # a JSON string literal is a jq string literal
    argv = ["gh", "api", "--paginate", f"repos/{repo}/pulls/{pr}/reviews?per_page=100",
            "--jq", f'.[] | select((.body // "") | contains({wanted})) | {{id: .id, url: .html_url}}']
    out = _ok(argv, _call(gh, argv))
    for line in (out.stdout or "").splitlines():
        try:
            row = json.loads(line)
        except ValueError:
            continue
        if isinstance(row, dict) and type(row.get("id")) is int:
            return {"id": row["id"], "url": row.get("url")}
    return None


def diff_hunks(gh: Gh, repo: str, base: str, head: str) -> Dict[str, List[Tuple[int, int]]]:
    """Commentable right-side ranges per path for the PR diff at `head`
    (merge base of the PR base and `head`, as GitHub computes it). Files with no
    patch (binary, oversized, deleted) get no ranges, so their findings go to
    the body."""
    data = _json(gh, ["gh", "api", f"repos/{repo}/compare/{base}...{head}",
                      "--jq", "[.files[]? | {filename, status, patch}]"])
    hunks: Dict[str, List[Tuple[int, int]]] = {}
    for row in data if isinstance(data, list) else []:
        if isinstance(row, dict) and isinstance(row.get("filename"), str) and row.get("status") != "removed":
            ranges = right_ranges(row.get("patch") or "")
            if ranges:
                hunks[row["filename"]] = ranges
    return hunks


def _post(gh: Gh, repo: str, pr: int, review: Dict[str, Any]) -> Any:
    argv = ["gh", "api", "--method", "POST", f"repos/{repo}/pulls/{pr}/reviews", "--input", "-"]
    return argv, _call(gh, argv, input_text=json.dumps(review))


def deliver(repo: str, pr: int, meta: Dict[str, Any], ndjson: Path,
            gh: Optional[Gh] = None) -> Dict[str, Any]:
    """Post this run's findings review on the PR, at most once.

    Returns {"state": "created"|"existing"|"skipped-closed"|"skipped-empty",
    "review_id", "review_url", "inline", "body_only"}. Raises RuntimeError on a
    gh failure; the caller keeps the debt and retries on a later tick."""
    gh = _gh if gh is None else gh
    run_id, head = meta.get("run_id"), meta.get("head")
    if (not REPO.fullmatch(repo or "") or type(pr) is not int or pr <= 0
            or not isinstance(run_id, str) or not RUN_ID.fullmatch(run_id)
            or not isinstance(head, str) or not SHA.fullmatch(head)
            or not isinstance(meta.get("base"), str) or not meta["base"]):
        raise ValueError("invalid PR review delivery identity")
    result = {"review_id": None, "review_url": None, "inline": 0, "body_only": 0}
    findings = load_findings(ndjson)
    if not findings:
        return {**result, "state": "skipped-empty"}
    state = pr_state(gh, repo, pr)
    if state["state"] != "open" or state.get("merged"):
        return {**result, "state": "skipped-closed"}
    found = existing_review(gh, repo, pr, run_id)
    if found:
        return {**result, "state": "existing", "review_id": found["id"], "review_url": found["url"]}
    hunks = diff_hunks(gh, repo, state["base"], head) if state.get("base") else None
    review = build_review(meta, findings, hunks)
    argv, p = _post(gh, repo, pr, review)
    if getattr(p, "returncode", 0) != 0 and "HTTP 422" in (getattr(p, "stderr", "") or "") \
            and (review["comments"] or "commit_id" in review):
        # Validation rejected an anchor or the commit (e.g. force-pushed away):
        # nothing was created, so fall back once to a body-only review.
        review = build_review(meta, findings, None)
        argv, p = _post(gh, repo, pr, review)
    out = _ok(argv, p)
    try:
        posted = json.loads(out.stdout or "{}")
    except ValueError:
        posted = {}
    return {"state": "created", "review_id": posted.get("id"), "review_url": posted.get("html_url"),
            "inline": len(review["comments"]), "body_only": len(findings) - len(review["comments"])}
