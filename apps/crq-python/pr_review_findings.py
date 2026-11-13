"""Post crq findings on an open PR in any reviewed repository as one GitHub pull-request review.

A counted open/delta review becomes ONE exact-head verdict review
(`POST /repos/{repo}/pulls/{pr}/reviews`, event COMMENT, `commit_id` = the
reviewed head). Each finding whose lines fall inside the PR diff for that
commit becomes an inline comment, so it opens its own resolvable review thread
(GraphQL `reviewThreads` / reply / `resolveReviewThread`). Findings that cannot
be anchored are listed in the review body instead.

The counted-run path uses the cq-review App transport and a PASS/ITERATE header.
The independent-review CLI keeps its caller-provided summary. Both start with
`<!-- crq-findings run=<run_id> -->`; before posting, the PR's existing reviews
are searched for that marker, so a crash between the POST and the queue save
is safe to retry and one run is never posted twice.

Pure module: plain data in, `gh` injected (the same shape as finding_issues).
"""
import argparse
import crq_review_identity
import crq_review_receipt
import json
import sys
import hashlib
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
# CommonMark fences: a run of 3+ backticks or tildes at line start (0-3 spaces
# indent); a backtick fence's info string holds no backtick. Mid-line runs are
# inline code spans, closed only by an equal-length run on the same line.
FENCE_OPEN = re.compile(r"^ {0,3}(`{3,}(?=[^`]*$)|~{3,})")
SPAN = re.compile(r"(?<!`)(`+)(?!`)(.+?)(?<!`)\1(?!`)")
MENTION = re.compile(r"(?<![\w`@/.])@(?=[A-Za-z0-9])")
LOGIN = re.compile(r"[A-Za-z0-9][A-Za-z0-9-]{0,38}(?:\[bot\])?")
ZWJ = "\u200d"

Gh = Callable[..., Any]


def marker(run_id: str) -> str:
    return f"<!-- crq-findings run={run_id} -->"


# ----------------------------------------------------------- findings


def load_findings(ndjson: Path, *, highest_severity=False) -> List[Dict[str, Any]]:
    """Finding events from the run's review.ndjson, exact duplicates dropped.

    The CLI sometimes emits the same finding twice in one stream; posting both
    would open two identical threads."""
    out: List[Dict[str, Any]] = []
    seen = {}
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
            if highest_severity:
                rank = {"fatal": 7, "blocker": 6, "critical": 5, "major": 4, "minor": 3, "trivial": 2, "info": 1, "none": 0}
                prior = out[seen[key]]
                if rank.get(finding["severity"].lower(), 0) > rank.get(prior["severity"].lower(), 0):
                    prior["severity"] = finding["severity"]
            continue
        seen[key] = len(out)
        out.append(finding)
    return out


def _line(value: Any) -> Optional[int]:
    return value if type(value) is int and value > 0 else None


def _prose(segment: str) -> str:
    """Prose outside code: no live mention, no opening of an HTML comment."""
    return MENTION.sub("@" + ZWJ, segment).replace("<!--", "&lt;!--")


def _inline(line: str) -> str:
    out, at = [], 0
    for match in SPAN.finditer(line):
        out += [_prose(line[at:match.start()]), match.group(0)]
        at = match.end()
    return "".join(out + [_prose(line[at:])])


def neutralise_mentions(text: str) -> str:
    """Insert a zero-width joiner after every `@` that GitHub would treat as a
    user or team mention, and escape any `<!--` left in prose, outside code, so
    a posted finding never notifies anyone or hides the text after it. Code
    spans and line-start fences stay byte-identical (`@types/node`). A fence
    left open is closed here, so it cannot swallow the next finding in the
    same body and turn that finding's fenced code into live prose."""
    out, fence = [], None
    for line in text.split("\n"):
        if fence:
            out.append(line)
            stripped = line.strip()
            indent = len(line) - len(line.lstrip(" "))
            if (indent <= 3 and stripped and set(stripped) == {fence[0]}
                    and len(stripped) >= len(fence)):
                fence = None
            continue
        opened = FENCE_OPEN.match(line)
        if opened:
            fence = opened.group(1)
            out.append(line)
            continue
        out.append(_inline(line))
    if fence:
        out.append(fence)
    return "\n".join(out)


def one_line(text: str) -> str:
    """A heading field (severity, title): one line, sanitised like prose."""
    return neutralise_mentions(" ".join(HTML_COMMENT.sub("", " ".join(str(text).split())).split()))


def code_span(text: str) -> str:
    """`text` as one inline code span whatever backticks it holds (CommonMark:
    a longer delimiter run, padded when the content touches a backtick)."""
    text = " ".join(str(text).split())
    runs = [len(r) for r in re.findall(r"`+", text)]
    tick = "`" * (max(runs) + 1 if runs else 1)
    pad = " " if text.startswith("`") or text.endswith("`") else ""
    return f"{tick}{pad}{text}{pad}{tick}"


def clean_text(text: str, title: str = "") -> str:
    """Finding prose without HTML comments (no foreign bot markers) and without
    a leading bold copy of the title. Committable ```suggestion blocks become
    plain fences: a clamped anchor could otherwise offer to replace the wrong
    lines."""
    text = HTML_COMMENT.sub("", text).strip()
    if title and text.startswith(f"**{title}**"):
        text = text[len(title) + 4:].lstrip()
    text = re.sub(r"^( {0,3})```suggestion\b", r"\1```text", text, flags=re.M)
    return neutralise_mentions(text)


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


def _fence_state(lines):
    """The open fence run after scanning lines with the module's own rules.

    Openers are FENCE_OPEN over the RAW line (spaces-only indent, so a
    tab-indented delimiter never opens). Closers use the neutralise rule:
    `line.strip()`, so a tab-prefixed closer of the same character with at
    least the opener's length does close, exactly as in `_neutralise`.
    """
    fence = None
    for line in lines:
        opened = FENCE_OPEN.match(line)
        if fence is None:
            if opened:
                fence = opened.group(1)
            continue
        stripped = line.strip()
        indent = len(line) - len(line.lstrip(" "))
        if indent <= 3 and stripped and set(stripped) == {fence[0]} and len(stripped) >= len(fence):
            fence = None
    return fence


def _body_cap(body: str, limit: int) -> str:
    """Cut `body` to `limit`, closing any open fence, so the WHOLE result
    (prefix + closure + trailer) stays within `limit`.

    Shortening the prefix can re-open an earlier (longer) fence, so one
    reservation is not enough; iterate: reserve the currently-scanned
    closure from the budget, rescan, until the scan is stable (the
    reservation already fits). Each round either stabilises or strictly
    shrinks the budget toward the trailer-length floor, so it terminates;
    a stable round satisfies prefix+closure+trailer == limit exactly.
    """
    trailer = "\n\n… (truncated; full text in the crq run artifacts)\n"
    budget = limit
    best: Optional[Tuple[int, str]] = None
    while True:
        prefix = body[:budget]
        fence = _fence_state(prefix.split("\n"))
        closure = "" if fence is None else "\n" + fence
        total = len(prefix) + len(closure) + len(trailer)
        if total <= limit and (best is None or len(prefix) > best[0]):
            best = (len(prefix), prefix + closure + trailer)
        reserved = limit - len(closure) - len(trailer)
        if reserved >= budget:
            return prefix + closure + trailer
        if reserved <= 0:
            break
        budget = reserved
    # Degenerate contents (a fence opener longer than any budget can
    # carry its closure): re-emit with the prefix cut BEFORE the first
    # fence opener line, so nothing opens and the output stays closed.
    # 59900/60000-tilde summaries land here (iteration oscillates or the
    # best emission leaves an open fence) and keep the marker + prose head
    # instead of losing everything to an unterminated run.
    floor = limit - len(trailer)
    offset = 0
    for line in body.split("\n"):
        if offset > floor:
            break
        if FENCE_OPEN.match(line):
            prefix = body[:offset]
            if prefix:
                return prefix.rstrip("\n") + trailer
            return trailer.lstrip("\n")
        offset += len(line) + 1
    if best is not None:
        return best[1]
    return body[:floor] + trailer


def _clip(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    cut = text[:limit].rstrip()
    # A clip can sever a code fence; close it so the trailer renders as
    # prose (same policy in the TypeScript port). The closure is the full
    # opener run, matching what _neutralise appends, so a 4-backtick or
    # 5-tilde fence is genuinely closed.
    fence = _fence_state(cut.split("\n"))
    if fence is not None:
        cut += "\n" + fence
    return cut + "\n\n… (truncated; full text in the crq run artifacts)"


def build_review(meta: Dict[str, Any], findings: List[Dict[str, Any]],
                 hunks: Optional[Dict[str, List[Tuple[int, int]]]]) -> Dict[str, Any]:
    """Review payload. `hunks=None` means no diff is known: body-only, no commit_id."""
    run_id, base, head = meta["run_id"], meta["base"], meta["head"]
    comments, unanchored = [], []
    for number, finding in enumerate(findings, 1):
        position = anchor(finding, hunks) if hunks is not None and (meta.get("crq_receipt") or len(comments) < MAX_INLINE) else None
        intended = ""
        if meta.get("crq_receipt") and hunks and any(hunks.values()):
            if position is None:
                path = finding["path"] if hunks.get(finding["path"]) else next(path for path, ranges in hunks.items() if ranges)
                position = {"path": path, "line": hunks[path][0][0], "side": "RIGHT"}
                intended = f"\n\nThread anchor is a PR changed line, not the finding's intended location: {code_span(finding['path'] or '(unspecified file)')} {_lines(finding)}."
        heading = f"**crq finding F{number} [{one_line(finding['severity'])}]**"
        if finding["title"]:
            heading += f" {one_line(finding['title'])}"
        text = clean_text(finding["text"], finding["title"])
        if position:
            where = _lines(finding)
            note = intended + f"\n\n<sub>crq run `{run_id}`{', ' + where if where else ''}</sub>"
            if meta.get("receipt_binding"):
                identity = hashlib.sha256(json.dumps(finding, sort_keys=True).encode()).hexdigest()
                note += f"\n<!-- crq-review-thread run={run_id} head={head} finding={identity} -->"
            comments.append({**position, "body": _clip(f"{heading}\n\n{text}", MAX_COMMENT) + note})
        else:
            unanchored.append((number, finding, heading, text))
    counts: Dict[str, int] = {}
    for finding in findings:
        severity = one_line(finding["severity"])
        counts[severity] = counts.get(severity, 0) + 1
    summary = ", ".join(f"{n} {s}" for s, n in sorted(counts.items()))
    label = one_line(meta.get("label") or f"crq findings (CodeRabbit CLI, local run {run_id}, {base[:10]}..{head[:10]})")
    lines = [marker(run_id)]
    if meta.get("receipt_binding"):
        lines += [meta["receipt_binding"]]
        body_major = any(finding["severity"].lower() in crq_review_receipt.BLOCKING
                         for _, finding, _, _ in unanchored)
        suffix = " body-major=1" if body_major else ""
        scope = "whole-pr-success" if meta.get("whole_pr_scan") else "narrow-success"
        lines += [f"<!-- crq-review-scan run={run_id} {scope}{suffix} -->"]
        lines += [meta["receipt_header"]]
        if meta.get("unattested"):
            lines += ["Unattested: App identity unavailable; posted with the host account."]
        lines += ["Legacy body-only findings are not covered or claimed resolved by this receipt."]
    lines += [clean_text(meta.get("summary", "")),
             f"### {label}", "",
             f"{('0 findings' if not findings and meta.get('crq_receipt') else str(len(findings)) + ' finding(s)')} ({summary}): {len(comments)} as inline threads, "
             f"{len(unanchored)} listed below.", "",
             f"Queue item `{meta.get('item_id', '')}`, reviewed range `{base}..{head}`. "
             + (f"{label}. Reply on a thread or resolve it after an explicit disposition." if meta.get("label") else
              "Posted by crq, the local review queue that runs the CodeRabbit CLI on this host. "
              "This is not a CodeRabbit PR review. Reply on a thread or resolve it once addressed.")]
    if unanchored:
        lines += ["", "#### Not anchored to the PR diff", ""]
        for number, finding, heading, text in unanchored:
            where = " ".join(x for x in (code_span(finding["path"]) if finding["path"] else "", _lines(finding)) if x)
            lines += [f"{heading}{' (' + where + ')' if where else ''}", "", _clip(text, MAX_COMMENT), ""]
    body = "\n".join(lines).rstrip() + "\n"
    if len(body) > MAX_BODY:
        body = _body_cap(body, MAX_BODY)
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
                      "--jq", "{state: .state, merged: .merged, base: .base.sha, head: .head.sha}"])
    if not isinstance(data, dict) or data.get("state") not in ("open", "closed"):
        raise RuntimeError(f"unexpected PR metadata for {repo}#{pr}")
    return data


def authenticated_login(gh: Gh) -> str:
    """The account this host's gh posts as; only its reviews count as ours."""
    argv = ["gh", "api", "user", "--jq", ".login"]
    login = (_ok(argv, _call(gh, argv)).stdout or "").strip()
    if not LOGIN.fullmatch(login):
        raise RuntimeError(f"gh api user returned no usable login: {login[:80]!r}")
    return login


def existing_review(gh: Gh, repo: str, pr: int, run_id: str, login: str) -> Optional[Dict[str, Any]]:
    """The PR review by `login` whose body STARTS with this run's marker, across
    every page. Neither another author nor a marker quoted inside some other
    text can suppress a delivery."""
    wanted = json.dumps(marker(run_id))  # a JSON string literal is a jq string literal
    argv = ["gh", "api", "--paginate", f"repos/{repo}/pulls/{pr}/reviews?per_page=100",
            "--jq", f'.[] | select(.user.login == {json.dumps(login)} and '
                    f'((.body // "") | startswith({wanted}))) | {{id: .id, url: .html_url}}']
    out = _ok(argv, _call(gh, argv))
    for line in (out.stdout or "").splitlines():
        try:
            row = json.loads(line)
        except ValueError:
            continue
        if isinstance(row, dict) and type(row.get("id")) is int:
            return {"id": row["id"], "url": row.get("url")}
    return None


def added_ranges(patch):
    """Actual added lines, excluding context/header/deleted coordinates."""
    ranges, line_number = [], None
    for line in patch.splitlines():
        header = HUNK.match(line)
        if header:
            line_number = int(header[1])
        elif line_number is not None:
            if line.startswith('+'):
                ranges.append((line_number, line_number))
                line_number += 1
            elif line.startswith(' '):
                line_number += 1
    return ranges


def diff_hunks(gh: Gh, repo: str, base: str, head: str, *, changed_only=False) -> Dict[str, List[Tuple[int, int]]]:
    """Commentable right-side ranges per path for the PR diff at `head`
    (merge base of the PR base and `head`, as GitHub computes it). Files with no
    patch (binary, oversized, deleted) get no ranges, so their findings go to
    the body."""
    data = _json(gh, ["gh", "api", f"repos/{repo}/compare/{base}...{head}",
                      "--jq", "[.files[]? | {filename, status, patch}]"])
    hunks: Dict[str, List[Tuple[int, int]]] = {}
    for row in data if isinstance(data, list) else []:
        if isinstance(row, dict) and isinstance(row.get("filename"), str) and row.get("status") != "removed":
            ranges = added_ranges(row.get("patch") or "") if changed_only else right_ranges(row.get("patch") or "")
            if ranges:
                hunks[row["filename"]] = ranges
    return hunks


def _post(gh: Gh, repo: str, pr: int, review: Dict[str, Any]) -> Any:
    argv = ["gh", "api", "--method", "POST", f"repos/{repo}/pulls/{pr}/reviews", "--input", "-"]
    return argv, _call(gh, argv, input_text=json.dumps(review))


def select_receipt_identity(repo, meta, gh, login, injected):
    selected = meta.get("posting_identity")
    if not injected:
        if selected and selected != "cq-review[bot]":
            actual = authenticated_login(gh)
            if actual != selected:
                raise ValueError("changed CRQ posting identity")
            login = actual
            meta["unattested"] = True
        else:
            try:
                gh = crq_review_identity.authenticated_gh(repo)
                login = "cq-review[bot]"
            except crq_review_identity.IdentityUnavailable as exc:
                if selected == "cq-review[bot]":
                    raise RuntimeError("App identity selected; credential setup unavailable, retry as App") from None
                meta["unattested"] = True
                meta["identity_reason"] = str(exc)
    login = login or authenticated_login(gh)
    if selected and selected != login:
        raise ValueError("changed CRQ posting identity")
    checkpoint = meta.get("identity_checkpoint")
    if checkpoint:
        checkpoint(login, meta.get("identity_reason"))
    return gh, login, meta


def deliver(repo: str, pr: int, meta: Dict[str, Any], ndjson: Path,
            gh: Optional[Gh] = None, login: Optional[str] = None) -> Dict[str, Any]:
    """Post this run's findings review on the PR, at most once.

    Returns {"state": "created"|"existing"|"skipped-closed"|"skipped-empty",
    "review_id", "review_url", "inline", "body_only"}. Raises RuntimeError on a
    gh failure; the caller keeps the debt and retries on a later tick."""
    injected = gh is not None
    gh = _gh if gh is None else gh
    run_id, head = meta.get("run_id"), meta.get("head")
    if (not REPO.fullmatch(repo or "") or type(pr) is not int or pr <= 0
            or not isinstance(run_id, str) or not RUN_ID.fullmatch(run_id)
            or not isinstance(head, str) or not SHA.fullmatch(head)
            or not isinstance(meta.get("base"), str) or not meta["base"]):
        raise ValueError("invalid PR review delivery identity")
    result = {"review_id": None, "review_url": None, "inline": 0, "body_only": 0}
    findings = load_findings(ndjson, highest_severity=True) if meta.get("crq_receipt") else load_findings(ndjson)
    if login is not None and not LOGIN.fullmatch(login):
        raise ValueError("invalid posting login")
    if not findings and not meta.get("summary") and not meta.get("local_review") and not meta.get("crq_receipt"):
        return {**result, "state": "skipped-empty"}
    if meta.get("crq_receipt"):
        meta = dict(meta)
        gh, login, meta = select_receipt_identity(repo, meta, gh, login, injected)
        prior = crq_review_receipt.prior_receipt(sys.modules[__name__], gh, repo, pr, meta, login)
        if prior:
            return {**result, "state": "existing", "review_id": prior["id"], "review_url": prior.get("url"),
                    "identity": prior.get("login"), "attested": prior.get("login") == "cq-review[bot]",
                    "verdict": (crq_review_receipt.VERDICT.search(prior.get("body", ""))[1]
                                if crq_review_receipt.VERDICT.search(prior.get("body", "")) else None),
                    "whole_pr_scan": f"<!-- crq-review-scan run={run_id} whole-pr-success" in prior.get("body", ""),
                    "body_major": " body-major=1 -->" in prior.get("body", "")}
    state = pr_state(gh, repo, pr)
    if state["state"] != "open" or state.get("merged"):
        return {**result, "state": "skipped-closed"}
    if meta.get("local_review") and state.get("head") != head:
        return {**result, "state": "skipped-head"}
    if not findings and not meta.get("summary") and not meta.get("crq_receipt"):
        return {**result, "state": "skipped-empty"}
    login = login or authenticated_login(gh)
    if meta.get("crq_receipt"):
        prepared = crq_review_receipt.prepare(sys.modules[__name__], gh, repo, pr, meta, ndjson, findings, login)
        if prepared is None:
            return {**result, "state": "skipped-no-verdict"}
        meta = prepared
    fingerprint = None
    # Independent verdicts keep their reviewer-specific run marker even when
    # their findings match another reviewer's findings.
    if not meta.get("summary"):
        # Hash complete normalized findings, independent of ordering and producer.
        # Serializing each object also makes nullable paths/locations comparable.
        normalized = sorted({json.dumps(f, sort_keys=True, ensure_ascii=True) for f in findings})
        fingerprint = hashlib.sha256(json.dumps(normalized).encode()).hexdigest()
        wanted = f"<!-- crq-local-findings head={head} set={fingerprint} -->"
        argv = ["gh", "api", "--paginate", f"repos/{repo}/pulls/{pr}/reviews?per_page=100", "--jq",
                f'.[] | select(.user.login == {json.dumps(login)} and ((.body // "") | contains({json.dumps(wanted)}))) | {{id: .id, url: .html_url}}']
        out = _ok(argv, _call(gh, argv))
        for line in (out.stdout or "").splitlines():
            row = json.loads(line)
            if type(row.get("id")) is int and not meta.get("crq_receipt"):
                return {**result, "state": "existing", "review_id": row["id"], "review_url": row.get("url")}
    found = None if meta.get("crq_receipt") else existing_review(gh, repo, pr, run_id, login)
    if found:
        return {**result, "state": "existing", "review_id": found["id"], "review_url": found["url"]}
    hunks = diff_hunks(gh, repo, meta["base"], head, changed_only=True) if meta.get("crq_receipt") else diff_hunks(gh, repo, meta["base"], head)
    review = build_review(meta, findings, hunks)
    if fingerprint:
        review["body"] += "\n" + wanted
        if meta.get("local_review") and pr_state(gh, repo, pr).get("head") != head:
            return {**result, "state": "skipped-head"}
    argv, p = _post(gh, repo, pr, review)
    if getattr(p, "returncode", 0) != 0 and "HTTP 422" in (getattr(p, "stderr", "") or "") \
            and (review["comments"] or "commit_id" in review):
        # Validation rejected an anchor or the commit (e.g. force-pushed away):
        # nothing was created, so fall back once to a body-only review.
        if meta.get("crq_receipt") and pr_state(gh, repo, pr).get("head") != head:
            return {**result, "state": "skipped-head"}
        review = build_review(meta, findings, None)
        if fingerprint:
            if meta.get("local_review") and pr_state(gh, repo, pr).get("head") != head:
                return {**result, "state": "skipped-head"}
            review["body"] += "\n" + wanted
        argv, p = _post(gh, repo, pr, review)
    out = _ok(argv, p)
    try:
        posted = json.loads(out.stdout or "{}")
    except ValueError:
        posted = {}
    if meta.get("crq_receipt") and type(posted.get("id")) is not int:
        raise RuntimeError("receipt POST returned no review identity; reconcile before retry")
    result = {"state": "created", "review_id": posted.get("id"), "review_url": posted.get("html_url"),
              "inline": len(review["comments"]), "body_only": len(findings) - len(review["comments"])}
    if meta.get("crq_receipt"):
        result.update(identity=login, attested=login == "cq-review[bot]", identity_reason=meta.get("identity_reason"),
                      verdict=meta.get("receipt_verdict"), whole_pr_scan=meta.get("whole_pr_scan"),
                      body_major=" body-major=1 -->" in review["body"])
    return result


def main(argv=None, gh=None):
    parser = argparse.ArgumentParser(description="Publish findings and an independent-review summary as one review")
    parser.add_argument("--repo", required=True)
    parser.add_argument("--pr", required=True, type=int)
    for name in ("head", "base", "run-id"):
        parser.add_argument("--" + name, required=True)
    parser.add_argument("--findings", required=True, type=Path)
    parser.add_argument("--body-file", required=True, type=Path)
    parser.add_argument("--login")
    parser.add_argument("--reviewer", default="independent reviewer")
    args = parser.parse_args(argv)
    try:
        if not SHA.fullmatch(args.base):
            raise ValueError("--base must be a full SHA")
        for number, line in enumerate(args.findings.read_text(encoding="utf-8").splitlines(), 1):
            if not line.strip():
                continue
            event = json.loads(line)
            if not isinstance(event, dict) or event.get("type") != "finding":
                raise ValueError(f"findings line {number} must be a finding event")
            for field in ("severity", "title", "comment"):
                if not isinstance(event.get(field), str) or not event[field].strip():
                    raise ValueError(f"findings line {number} requires nonempty {field}")
            if "fileName" in event and (not isinstance(event["fileName"], str) or not event["fileName"].strip()):
                raise ValueError(f"findings line {number} has invalid fileName")
            for field in ("startLine", "endLine"):
                if field in event and (_line(event[field]) is None or "fileName" not in event):
                    raise ValueError(f"findings line {number} has invalid {field} or missing fileName")
        summary = args.body_file.read_text(encoding="utf-8")
        if not summary.strip() or len(summary) > 20000:
            raise ValueError("summary must contain 1..20000 characters")
        meta = {"head": args.head, "base": args.base, "run_id": args.run_id,
                "summary": summary, "label": f"Independent review by {args.reviewer} for {args.head}"}
        print(json.dumps(deliver(args.repo, args.pr, meta, args.findings, gh=gh, login=args.login)))
        return 0
    except (OSError, ValueError, RuntimeError) as exc:
        print(f"pr_review_findings: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
