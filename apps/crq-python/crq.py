#!/usr/bin/env python3
"""crq — CodeRabbit CLI review queue for camerontaylor/cq-toolkit.

Pays down CodeRabbit CLI review debt at a steady, quota-safe pace while
following docs/coderabbit-review.md (the "protocol"):

  * one immutable base per PR: merge-base against the PR's explicit target
    (its GitHub base ref), the same pin for both cycles (§3);
  * a cycle counts ONLY when the CLI exits 0, the stream ends in a terminal
    non-skipped `complete`, and no `error`/`action_required` event occurred
    (§4/§6) — rate limits, auth failures, skips and interruptions never count;
  * the diff is secret-scanned (denylist classes + gitleaks defaults) before
    upload (§1); --use-credits is never passed (§6 billing);
  * STOP at two cycles per PR (§5).

Everything runs in a dedicated clone + per-run detached worktrees under
/srv/operator/repos/worktrees/coderabbit-queue-*; it never
touches the main cq-toolkit checkout or other agents' PR worktrees.

Python 3.9 stdlib only. See README.md for operations.
"""
from __future__ import annotations

import argparse
import datetime as dt
import fcntl
import hashlib
import json
import os
import re
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

ROOT = Path(__file__).resolve().parent
STATE = ROOT / "state"
RUNS = STATE / "runs"
LEDGER = STATE / "ledger"
QUEUE = STATE / "queue.json"
EVENTS = STATE / "events.jsonl"
LOCK = STATE / "tick.lock"
CONFIG = json.loads((ROOT / "config.json").read_text())

CLONE = Path(CONFIG["clone"])
WT_ROOT = Path(CONFIG["worktree_root"])
WT_PREFIX = CONFIG["worktree_prefix"]
REPO = CONFIG["repo"]
BLOCKING_SEVERITIES = set(CONFIG["address_severities"])
SEVERITIES = ["critical", "major", "minor", "trivial", "info", "none"]

# ---------------------------------------------------------------- utilities


def now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def iso(t: Optional[dt.datetime] = None) -> str:
    return (t or now()).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_iso(s: Optional[str]) -> Optional[dt.datetime]:
    if not s:
        return None
    return dt.datetime.strptime(s.replace(".000", "")[:20].rstrip("Z") + "Z", "%Y-%m-%dT%H:%M:%SZ").replace(
        tzinfo=dt.timezone.utc
    )


def run(cmd: List[str], cwd: Optional[Path] = None, check: bool = True, env: Optional[dict] = None,
        input_text: Optional[str] = None, timeout: int = 600) -> subprocess.CompletedProcess:
    p = subprocess.run(cmd, cwd=str(cwd) if cwd else None, capture_output=True, text=True, env=env,
                       input=input_text, timeout=timeout)
    if check and p.returncode != 0:
        raise RuntimeError(f"{' '.join(cmd[:6])} … exit {p.returncode}: {p.stderr.strip()[:400]}")
    return p


def git(*args: str, check: bool = True, env: Optional[dict] = None, cwd: Optional[Path] = None) -> str:
    return run(["git", *args], cwd=cwd or CLONE, check=check, env=env).stdout.strip()


def is_ancestor(a: str, b: str) -> bool:
    return run(["git", "merge-base", "--is-ancestor", a, b], cwd=CLONE, check=False).returncode == 0


def gh_json(args: List[str]) -> Any:
    return json.loads(run(["gh", *args], cwd=CLONE, timeout=120).stdout)


def paseo_json(args: List[str]) -> Any:
    p = run(["paseo", *args, "--json"], check=False, timeout=120)
    if p.returncode != 0:
        raise RuntimeError(f"paseo {' '.join(args)} failed: {p.stderr.strip()[:300]}")
    return json.loads(p.stdout)


def event(kind: str, **data: Any) -> None:
    STATE.mkdir(parents=True, exist_ok=True)
    with EVENTS.open("a") as f:
        f.write(json.dumps({"at": iso(), "event": kind, **data}) + "\n")


def load_queue() -> Dict[str, Any]:
    return json.loads(QUEUE.read_text())


def save_queue(q: Dict[str, Any]) -> None:
    tmp = QUEUE.with_suffix(".tmp")
    tmp.write_text(json.dumps(q, indent=2) + "\n")
    tmp.replace(QUEUE)


def pid_alive(pid: Optional[int]) -> bool:
    if not pid:
        return False
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def fetch() -> None:
    git("fetch", "--prune", "--quiet", "origin")


# ----------------------------------------------------------- worktrees


def make_worktree(name: str, commit: str) -> Tuple[Path, str]:
    """Worktree on a local-only branch `crq/<name>` (never pushed)."""
    path = WT_ROOT / f"{WT_PREFIX}{name}"
    branch = f"crq/{name}"
    remove_worktree(path, branch)
    git("worktree", "add", "--quiet", "-B", branch, str(path), commit)
    return path, branch


def remove_worktree(path: Path, branch: Optional[str] = None) -> None:
    if path.exists():
        git("worktree", "remove", "--force", str(path), check=False)
        if path.exists() and path.name.startswith(WT_PREFIX):
            shutil.rmtree(path, ignore_errors=True)
    git("worktree", "prune", check=False)
    if branch:
        git("branch", "-D", branch, check=False)


# ----------------------------------------------------------- secret scan

ALLOWLIST_PATHS = [r"(^|/)\.git/", r"(^|/)node_modules/", r"(^|/)dist/", r"(^|/)\.gjc/", r"(^|/)\.DS_Store$",
                   r"^policy/denylist/patterns\.yml$"]


def _unquote(v: str) -> str:
    v = v.strip()
    if v.startswith("'") and v.endswith("'"):
        return v[1:-1].replace("''", "'")
    if v.startswith('"') and v.endswith('"'):
        return json.loads(v)
    return v


def denylist_rules() -> List[Dict[str, str]]:
    """Parse policy/denylist/patterns.yml (constrained format) from origin/merge-queue."""
    text = git("show", "origin/merge-queue:policy/denylist/patterns.yml")
    rules: List[Dict[str, str]] = []
    cur: Optional[Dict[str, str]] = None
    in_rules = False
    for line in text.splitlines():
        if line.startswith("rules:"):
            in_rules = True
            continue
        if line and not line.startswith(" ") and not line.startswith("#"):
            in_rules = False
        if not in_rules:
            continue
        m = re.match(r"^  - id:\s*(.+)$", line)
        if m:
            cur = {"id": _unquote(m.group(1))}
            rules.append(cur)
            continue
        m = re.match(r"^    (regex|path):\s*(.+)$", line)
        if m and cur is not None:
            cur[m.group(1)] = _unquote(m.group(2))
    if not rules or any("regex" not in r for r in rules):
        raise RuntimeError("denylist parse failed (fail closed)")
    return rules


def secret_scan(base: str, head: str, out: Path) -> Tuple[bool, Dict[str, Any]]:
    """Scan added AND removed lines of base..head. Never records matched content."""
    diff = git("diff", "--no-color", "--no-ext-diff", "--unified=0", base, head)
    rules = denylist_rules()
    compiled = [(r["id"], re.compile(r["regex"]), re.compile(r["path"]) if "path" in r else None) for r in rules]
    allow = [re.compile(p) for p in ALLOWLIST_PATHS]
    hits: List[Dict[str, Any]] = []
    path = None
    for n, line in enumerate(diff.splitlines(), 1):
        if line.startswith("+++ ") or line.startswith("--- "):
            p = line[4:]
            if p != "/dev/null":
                path = p[2:] if p[:2] in ("a/", "b/") else p
            continue
        if line.startswith("diff --git"):
            m = re.match(r"diff --git a/(.*) b/(.*)$", line)
            path = m.group(2) if m else None
            continue
        if not line or line[0] not in "+-" or path is None:
            continue
        if any(a.search(path) for a in allow):
            continue
        content = line[1:]
        for rid, rx, prx in compiled:
            if prx is not None and not prx.search(path):
                continue
            if rx.search(content):
                hits.append({"rule": rid, "file": path, "diff_line": n})
    # gitleaks default rules over the same patch (redacted, report to file).
    gl_hits: List[Dict[str, Any]] = []
    gl_status = "not-run"
    if shutil.which("gitleaks"):
        with tempfile.TemporaryDirectory() as td:
            rep = Path(td) / "r.json"
            p = run(["gitleaks", "stdin", "--no-banner", "--redact", "--log-level", "error",
                     "--report-format", "json", "--report-path", str(rep), "--exit-code", "0"],
                    check=False, input_text=diff)
            gl_status = f"exit {p.returncode}"
            if p.returncode == 0 and rep.exists():
                for f in json.loads(rep.read_text() or "[]"):
                    gl_hits.append({"rule": f.get("RuleID"), "diff_line": f.get("StartLine")})
            elif p.returncode != 0:
                gl_hits.append({"rule": "gitleaks-error", "diff_line": None})
    result = {"base": base, "head": head, "denylist_rules": len(rules), "denylist_hits": hits,
              "gitleaks": gl_status, "gitleaks_hits": gl_hits, "diff_bytes": len(diff)}
    out.write_text(json.dumps(result, indent=2) + "\n")
    return (not hits and not gl_hits), result


# ----------------------------------------------------------- NDJSON


SIZE_REFUSAL = re.compile(r"too (large|big|many (files|changes|lines))|diff (is )?too|file limit|max(imum)? (number of )?files"
                          r"|exceed\w* (the )?(max\w*|limit|size)", re.I)


def classify(ndjson: Path, exit_code: Optional[int]) -> Dict[str, Any]:
    events: List[Dict[str, Any]] = []
    bad_lines = 0
    if ndjson.exists():
        for line in ndjson.read_text(errors="replace").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                events.append(json.loads(line))
            except ValueError:
                bad_lines += 1
    errors = [e for e in events if e.get("type") == "error"]
    actions = [e for e in events if e.get("type") == "action_required" or e.get("status") == "awaiting_confirmation"]
    findings = [e for e in events if e.get("type") == "finding"]
    terminal = [e for e in events if e.get("type") not in ("heartbeat", "finding")]
    last = terminal[-1] if terminal else {}
    complete = [e for e in events if e.get("type") == "complete"]
    counts = {s: 0 for s in SEVERITIES}
    for f in findings:
        counts[f.get("severity", "none")] = counts.get(f.get("severity", "none"), 0) + 1
    res: Dict[str, Any] = {"exit": exit_code, "events": len(events), "bad_lines": bad_lines,
                           "findings": len(findings), "severity_counts": counts}
    if actions:
        res.update(outcome="action_required", message=str(actions[0])[:400])
    elif errors:
        e = errors[0]
        et = str(e.get("errorType", "")).lower()
        msg = str(e.get("message", ""))
        res["message"] = f"{e.get('errorType')}: {msg}"[:400]
        if SIZE_REFUSAL.search(f"{et} {msg}"):
            res.update(outcome="too_large")
        elif "rate" in et or "limit" in et or "quota" in et or "rate limit" in msg.lower():
            wait = str((e.get("metadata") or {}).get("waitTime", ""))
            m = re.search(r"(\d+)\s*(second|minute|hour)", wait)
            mins = None
            if m:
                k = {"second": 1 / 60, "minute": 1, "hour": 60}[m.group(2)]
                mins = int(int(m.group(1)) * k) + 1
            res.update(outcome="rate_limited", wait_minutes=mins)
        elif "auth" in et or "login" in msg.lower() or "unauthor" in msg.lower():
            res.update(outcome="auth")
        else:
            res.update(outcome="error")
    elif exit_code is None:
        res.update(outcome="interrupted", message="no exit status recorded")
    elif exit_code != 0:
        res.update(outcome="error", message=f"CLI exit {exit_code}")
    elif not complete or last.get("type") != "complete":
        res.update(outcome="interrupted", message="stream did not end with a terminal complete event")
    elif last.get("status") != "review_completed":
        res.update(outcome="skipped", message=f"complete.status={last.get('status')}")
    else:
        res.update(outcome="completed", reviewed_files=len(last.get("reviewedFiles") or []))
    res["counted"] = res["outcome"] == "completed"
    return res


def findings_md(ndjson: Path, meta: Dict[str, Any], cls: Dict[str, Any]) -> str:
    out = [f"# CodeRabbit CLI findings — {meta['item_id']} ({meta['label']})", "",
           f"- run: `{meta['run_id']}`  outcome: **{cls['outcome']}**  counted: {cls['counted']}",
           f"- base `{meta['base']}` → head `{meta['head']}` (clean tree)",
           f"- severity counts: {json.dumps(cls['severity_counts'])}", ""]
    i = 0
    for line in ndjson.read_text(errors="replace").splitlines():
        try:
            e = json.loads(line)
        except ValueError:
            continue
        if e.get("type") != "finding":
            continue
        i += 1
        text = e.get("codegenInstructions") or e.get("comment") or ""
        out += [f"## F{i} [{e.get('severity')}] {e.get('fileName')}", "", "```text", text.strip()[:4000], "```", ""]
    return "\n".join(out) + "\n"


# ----------------------------------------------------------- PR info / activity


def pr_info(pr: int) -> Dict[str, Any]:
    return gh_json(["pr", "view", str(pr), "--repo", REPO, "--json",
                    "number,state,isDraft,headRefName,headRefOid,baseRefName,updatedAt,mergeCommit,mergedAt"])


_AGENTS_CACHE: Dict[str, Any] = {}


def running_agents() -> List[Dict[str, Any]]:
    if "v" not in _AGENTS_CACHE:
        try:
            _AGENTS_CACHE["v"] = [a for a in paseo_json(["ls"]) if a.get("status") == "running"]
        except Exception as exc:  # fail closed: unknown activity blocks starts
            _AGENTS_CACHE["v"] = None
            event("paseo_ls_failed", error=str(exc)[:300])
    return _AGENTS_CACHE["v"]


def agent_branch(cwd: str) -> Optional[str]:
    p = Path(os.path.expanduser(cwd))
    if not p.is_dir():
        return None
    r = run(["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd=p, check=False, timeout=20)
    return r.stdout.strip() if r.returncode == 0 else None


def active_agents_for(pr: int, branch: str) -> Optional[List[str]]:
    """Running Paseo agents that look like they work on this PR (None = unknown)."""
    agents = running_agents()
    if agents is None:
        return None
    hits = []
    slug = branch.replace("/", "-")
    for a in agents:
        title = a.get("name") or a.get("title") or ""
        if title.startswith(CONFIG["tick_agent_title_prefix"]):
            continue
        cwd = a.get("cwd") or ""
        if (re.search(rf"#{pr}\b", title) or re.search(rf"pr-?{pr}\b", cwd)
                or os.path.basename(cwd.rstrip("/")) == slug or agent_branch(cwd) == branch):
            hits.append(f"{a.get('shortId') or a.get('id', '')[:8]} {title[:50]}")
    return hits


def quiet_reason(item: Dict[str, Any], info: Dict[str, Any]) -> Optional[str]:
    """Return why the PR head is not quiet enough to review (None = quiet)."""
    branch = info["headRefName"]
    act = active_agents_for(item["pr"], branch)
    if act is None:
        return "paseo agent list unavailable (fail closed)"
    if act:
        return "active agent(s): " + "; ".join(act)
    ours = (item.get("last_push") or {}).get("sha") == info["headRefOid"]
    if ours:
        return None  # head is our own addressing push and nobody else is running on it
    ct = int(git("log", "-1", "--format=%ct", info["headRefOid"]))
    last = max(ct, parse_iso(info["updatedAt"]).timestamp())
    age = (time.time() - last) / 60
    if age < CONFIG["quiet_minutes"]:
        return f"recent activity {age:.0f}m ago (< {CONFIG['quiet_minutes']}m quiet window)"
    return None


# ----------------------------------------------------------- merged PRs: supersession + synthetic diff


def pr_commit_set(merge: str) -> set:
    p, h = f"{merge}^1", f"{merge}^2"
    return set(git("rev-list", f"{p}..{h}").split()) | {git("rev-parse", merge)}


def rename_map(a: str, b: str) -> Dict[str, str]:
    out = {}
    for line in git("diff", "-M50%", "--name-status", "--diff-filter=R", a, b).splitlines():
        parts = line.split("\t")
        if len(parts) == 3:
            out[parts[1]] = parts[2]
    return out


def path_exists(rev: str, path: str) -> bool:
    return run(["git", "cat-file", "-e", f"{rev}:{path}"], cwd=CLONE, check=False).returncode == 0


def is_doc(path: str) -> bool:
    return path.endswith((".md", ".mdx", ".txt")) or path.startswith("docs/")


def measure_merged(item: Dict[str, Any]) -> Dict[str, Any]:
    """Blame-based survival: of the lines the PR added, how many are still
    attributed (git blame -w -M) to the PR's own commits in origin/merge-queue."""
    merge = item["merge_commit"]
    mq = git("rev-parse", "origin/merge-queue")
    commits = pr_commit_set(merge)
    renames = rename_map(merge, mq)
    files = []
    tot_add = tot_surv = nondoc_surv = 0
    for line in git("diff", "--numstat", "--no-renames", f"{merge}^1", merge).splitlines():
        a, d, path = line.split("\t", 2)
        if a == "-":
            continue
        added = int(a)
        if added == 0:
            continue
        cur = path if path_exists(mq, path) else renames.get(path)
        surv = 0
        if cur:
            blame = git("blame", "-w", "-M", "--line-porcelain", mq, "--", cur, check=False)
            for bl in blame.splitlines():
                m = re.match(r"^([0-9a-f]{40}) \d+ \d+", bl)
                if m and m.group(1) in commits:
                    surv += 1
        surv = min(surv, added)
        tot_add += added
        tot_surv += surv
        if not is_doc(path):
            nondoc_surv += surv
        files.append({"path": path, "now": cur, "added": added, "surviving": surv})
    # Per-file synthetic delta (pre-merge → merge-queue). A path joins the
    # synthetic review only when the PR's surviving lines are a meaningful
    # share of that path's later churn; otherwise the review would mostly
    # re-review other PRs' work on a hot file.
    all_paths = synth_paths(merge, mq)
    syn_by_path: Dict[str, int] = {}
    if all_paths:
        for x in git("diff", "--numstat", "--no-renames", f"{merge}^1", mq, "--", *all_paths).splitlines():
            a2, _d2, p2 = x.split("\t", 2)
            syn_by_path[p2] = 0 if a2 == "-" else int(a2)
    thr = CONFIG.get("merged_min_file_focus", 0.25)
    include, excluded = set(), []
    for f in files:
        cur = f["now"]
        syn = syn_by_path.get(cur or "", 0)
        f["synthetic_added"] = syn
        if cur and syn and f["surviving"] / syn >= thr:
            include.update({f["path"], cur})
        elif cur:
            excluded.append(f"{cur} ({f['surviving']}/{syn})")
    syn_add = sum(syn_by_path.get(f["now"] or "", 0) for f in files if f["path"] in include)
    inc_surv = sum(f["surviving"] for f in files if f["path"] in include)
    return {"measured_at": iso(), "merge_queue": mq, "pr_commits": len(commits), "added": tot_add,
            "surviving": tot_surv, "surviving_nondoc": nondoc_surv,
            "survival": round(tot_surv / tot_add, 3) if tot_add else None,
            "synthetic_paths": sorted(include), "excluded_paths": excluded,
            "synthetic_added": syn_add, "covered_surviving": inc_surv,
            "focus": round(inc_surv / syn_add, 3) if syn_add else None,
            "file_level_focus": round(tot_surv / max(1, sum(syn_by_path.values())), 3),
            "docs_only": nondoc_surv == 0 and all(is_doc(f["path"]) for f in files), "files": files}


def synth_paths(merge: str, mq: str) -> List[str]:
    names = set()
    for line in git("diff", "--name-status", "--no-renames", f"{merge}^1", merge).splitlines():
        names.add(line.split("\t", 1)[1])
    renames = rename_map(merge, mq)
    for p in list(names):
        if p in renames:
            names.add(renames[p])
    return sorted(names)


def build_synthetic(item: Dict[str, Any]) -> Tuple[str, str, int]:
    """Synthetic pair, both descending from current merge-queue:
         MQ → B' (PR-touched paths reset to pre-merge content) → H (tree == MQ)
       Reviewing H against B' shows exactly what the PR introduced to those
       paths plus every later change to them, with today's tree as context."""
    merge = item["merge_commit"]
    mq = git("rev-parse", "origin/merge-queue")
    pre = git("rev-parse", f"{merge}^1")
    paths = (item.get("measure") or {}).get("synthetic_paths") or synth_paths(merge, mq)
    with tempfile.TemporaryDirectory() as td:
        env = dict(os.environ, GIT_INDEX_FILE=str(Path(td) / "index"))
        git("read-tree", mq, env=env)
        for p in paths:
            ls = git("ls-tree", pre, "--", p)
            if ls:
                mode, _typ, rest = ls.split(" ", 2)
                sha = rest.split("\t", 1)[0]
                git("update-index", "--add", "--cacheinfo", f"{mode},{sha},{p}", env=env)
            else:
                git("update-index", "--force-remove", "--", p, env=env)
        tree = git("write-tree", env=env)
    ident = dict(os.environ, GIT_AUTHOR_NAME="crq", GIT_AUTHOR_EMAIL="crq@localhost",
                 GIT_COMMITTER_NAME="crq", GIT_COMMITTER_EMAIL="crq@localhost")
    base = run(["git", "commit-tree", tree, "-p", mq, "-m",
                f"crq synthetic base: PR #{item['pr']} paths at pre-merge {pre[:10]}"], cwd=CLONE, env=ident).stdout.strip()
    head = run(["git", "commit-tree", f"{mq}^{{tree}}", "-p", base, "-m",
                f"crq synthetic head: PR #{item['pr']} paths at merge-queue {mq[:10]}"], cwd=CLONE, env=ident).stdout.strip()
    git("update-ref", f"refs/crq/synth/pr{item['pr']}-base", base)
    git("update-ref", f"refs/crq/synth/pr{item['pr']}-head", head)
    return base, head, len(paths)


# ----------------------------------------------------------- planning a review


class NotReady(Exception):
    pass


def plan_open(item: Dict[str, Any], info: Dict[str, Any], dry: bool) -> Dict[str, Any]:
    if info["state"] != "OPEN":
        raise NotReady(f"PR is {info['state']}")
    if info["isDraft"]:
        raise NotReady("PR is draft")
    head = info["headRefOid"]
    target = f"origin/{info['baseRefName']}"
    pin = git("merge-base", target, head)
    notes = []
    if item.get("pinned_base"):
        # The merge-base only moves when the PR absorbs newer target commits
        # (restack/rebase/merge-in). Then old-pin..head would drag unrelated
        # target changes into the review, so the old pair cannot complete.
        # (Ancestry alone is not enough: an old target pin stays an ancestor.)
        if pin != item["pinned_base"]:
            notes.append(f"base drift: merge-base moved {item['pinned_base'][:10]} → {pin[:10]} (PR restacked) "
                         f"→ earlier cycles void, re-pinned, 2 cycles owed")
            if not dry:
                item.setdefault("voided_cycles", []).extend(item.get("cycles", []))
                item["cycles"] = []
                item["prior_cycles"] = 0
                item["pinned_base"] = pin
        else:
            pin = item["pinned_base"]
    else:
        if item.get("prior_cycles") and item.get("prior_base") and item["prior_base"] != pin:
            notes.append(f"prior cycle-1 base {item['prior_base'][:10]} ≠ current merge-base {pin[:10]} "
                         f"→ prior cycle cannot pair with a new one; 2 cycles owed")
            if not dry:
                item["voided_prior_cycles"] = item["prior_cycles"]
                item["prior_cycles"] = 0
        if not dry:
            item["pinned_base"] = pin
            item["target_ref"] = target
    cycle = item.get("prior_cycles", 0) + len(item.get("cycles", [])) + 1
    return {"base": pin, "head": head, "target": target, "label": f"cycle {cycle} of 2", "cycle": cycle,
            "notes": notes, "branch": info["headRefName"]}


class NothingToReview(Exception):
    pass


def ensure_commit(pr: int, sha: str) -> bool:
    """Merged/force-pushed heads may be gone from branch refs; fetch the PR ref."""
    def have() -> bool:
        return run(["git", "cat-file", "-e", f"{sha}^{{commit}}"], cwd=CLONE, check=False).returncode == 0
    if not have():
        git("fetch", "--quiet", "origin", f"+refs/pull/{pr}/head:refs/remotes/pr/{pr}", check=False)
    return have()


def plan_delta(item: Dict[str, Any], info: Dict[str, Any], dry: bool) -> Dict[str, Any]:
    """One informational review of what the last CLI review did not see.
    Open PRs: since..head. Merged PRs: since..final head against the target as
    it was at merge. Restacked (pin moved / since not an ancestor): replay the
    reviewed head onto the new pin with merge-tree and review new-head vs that
    replay, so only post-review changes show; a conflicting replay falls back
    to the full PR diff (still ONE review, not a two-cycle redo)."""
    merged = info["state"] == "MERGED"
    if info["state"] not in ("OPEN", "MERGED"):
        raise NotReady(f"PR is {info['state']}")
    head = info["headRefOid"]
    if not ensure_commit(item["pr"], head):
        raise NotReady(f"head {head[:10]} not fetchable")
    target = f"{info['mergeCommit']['oid']}^1" if merged else f"origin/{info['baseRefName']}"
    pin = git("merge-base", target, head)
    base, review_head = pin, head
    scope = "full PR diff (no usable last CLI-reviewed head)"
    since = item.get("since")
    if since and ensure_commit(item["pr"], since):
        since = git("rev-parse", f"{since}^{{commit}}")
        if since == head:
            raise NothingToReview(f"head {head[:10]} is the last CLI-reviewed head")
        if is_ancestor(since, head) and git("merge-base", target, since) == pin:
            base, scope = since, f"delta since last CLI-reviewed head {since[:10]}"
        else:
            m = run(["git", "merge-tree", "--write-tree", "--no-messages", pin, since], cwd=CLONE, check=False)
            tree = m.stdout.split()[0] if m.returncode == 0 and m.stdout.strip() else None
            if tree is None:
                scope = f"full PR diff (reviewed head {since[:10]} does not replay cleanly onto {pin[:10]})"
            elif tree == git("rev-parse", f"{head}^{{tree}}"):
                raise NothingToReview(f"pure restack of reviewed head {since[:10]} onto {pin[:10]}; nothing unreviewed")
            else:
                scope = f"delta since {since[:10]}, replayed onto restacked pin {pin[:10]}"
                if not dry:
                    ident = dict(os.environ, GIT_AUTHOR_NAME="crq", GIT_AUTHOR_EMAIL="crq@localhost",
                                 GIT_COMMITTER_NAME="crq", GIT_COMMITTER_EMAIL="crq@localhost")
                    base = run(["git", "commit-tree", tree, "-p", pin, "-m",
                                f"crq replay: PR #{item['pr']} reviewed head {since[:10]} on {pin[:10]}"],
                               cwd=CLONE, env=ident).stdout.strip()
                    review_head = run(["git", "commit-tree", f"{head}^{{tree}}", "-p", base, "-m",
                                       f"crq replay head: PR #{item['pr']} at {head[:10]}"],
                                      cwd=CLONE, env=ident).stdout.strip()
                    git("update-ref", f"refs/crq/synth/pr{item['pr']}-delta-base", base)
                    git("update-ref", f"refs/crq/synth/pr{item['pr']}-delta-head", review_head)
    when = "post-merge" if merged else "post-cycle"
    return {"base": base, "head": review_head, "pr_head": head, "target": target,
            "label": f"informational {when} review — {scope}", "cycle": None, "notes": [],
            "branch": None if merged else info["headRefName"]}


def plan_merged(item: Dict[str, Any], dry: bool) -> Dict[str, Any]:
    if dry:
        return {"base": "(synthetic)", "head": "(synthetic)", "target": "origin/merge-queue",
                "label": "post-merge synthetic review", "cycle": None, "notes": [], "branch": None}
    base, head, n = build_synthetic(item)
    return {"base": base, "head": head, "target": "origin/merge-queue", "cycle": None, "branch": None,
            "label": f"post-merge synthetic review ({n} PR-touched paths, pre-merge → merge-queue)", "notes": []}


# ----------------------------------------------------------- launching


def starts_last_hour(q: Dict[str, Any]) -> int:
    cutoff = now() - dt.timedelta(hours=1)
    return sum(1 for s in q.get("starts", []) if parse_iso(s) >= cutoff)


def inflight(q: Dict[str, Any]) -> List[Dict[str, Any]]:
    return [i for i in q["items"] if i["state"] == "reviewing" or (i["kind"] == "promotion" and i["state"] in SIGNER_STATES)]


def launch(q: Dict[str, Any], item: Dict[str, Any], plan: Dict[str, Any]) -> str:
    run_id = f"{item['id']}-{now().strftime('%Y%m%dT%H%M%SZ')}"
    rdir = RUNS / run_id
    rdir.mkdir(parents=True)
    ok, scan = secret_scan(plan["base"], plan["head"], rdir / "secret-scan.json")
    if not ok:
        item["state"] = "blocked"
        item["last_error"] = (f"secret scan failed before upload: {len(scan['denylist_hits'])} denylist + "
                              f"{len(scan['gitleaks_hits'])} gitleaks hit(s) — see {rdir}/secret-scan.json")
        event("blocked", item=item["id"], reason=item["last_error"])
        return run_id
    wt, wbranch = make_worktree(f"wt-{run_id}", plan["head"])
    meta = {"run_id": run_id, "item_id": item["id"], "pr": item["pr"], "kind": item["kind"],
            "label": plan["label"], "cycle": plan["cycle"], "base": plan["base"], "head": plan["head"],
            "pr_head": plan.get("pr_head", plan["head"]),
            "target": plan["target"], "pr_branch": plan["branch"], "worktree": str(wt), "wt_branch": wbranch,
            "dirty_diff": "clean tree", "started_at": iso(),
            "cmd": ["coderabbit", "review", "--agent", "--base-commit", plan["base"]]}
    (rdir / "meta.json").write_text(json.dumps(meta, indent=2) + "\n")
    # Double fork via sh: the review is reparented to launchd before this tick
    # returns. A tick agent whose session ends while the tick is still running
    # has its background task tree-killed by ppid walk; setsid alone does not
    # escape that (20 merged-tier runs died ~2 min in, at tick-agent end).
    child = " ".join(shlex.quote(a) for a in (sys.executable, str(Path(__file__).resolve()), "_review", run_id))
    p = run(["/bin/sh", "-c", f"{child} </dev/null >>{shlex.quote(str(rdir / 'runner.log'))} 2>&1 & echo $!"],
            cwd=ROOT, timeout=30)
    pid = int(p.stdout.strip())
    item["state"] = "reviewing"
    item["run"] = {"run_id": run_id, "pid": pid, "started_at": meta["started_at"]}
    item["wait_reason"] = None
    q.setdefault("starts", []).append(meta["started_at"])
    event("review_started", item=item["id"], run=run_id, base=plan["base"], head=plan["head"], label=plan["label"])
    return run_id


def cmd_review_child(run_id: str) -> int:
    """Detached child: run the CLI once, record exit status. Never retries."""
    signal.signal(signal.SIGHUP, signal.SIG_IGN)
    rdir = RUNS / run_id
    meta = json.loads((rdir / "meta.json").read_text())
    tmo = CONFIG["review_timeout_min"]
    cmd = ["gtimeout", "--kill-after=60", f"{tmo}m", *meta["cmd"]]
    pidfile = rdir / "review.pid"
    pidfile.write_text(json.dumps({"pid": os.getpid(), "ppid": os.getppid()}) + "\n")
    with (rdir / "review.ndjson").open("w") as out, (rdir / "stderr.log").open("w") as err:
        proc = subprocess.Popen(cmd, cwd=meta["worktree"], stdout=out, stderr=err, stdin=subprocess.DEVNULL)
        pidfile.write_text(json.dumps({"pid": os.getpid(), "ppid": os.getppid(), "cli_pid": proc.pid}) + "\n")
        rc = proc.wait()
    (rdir / "exit.json").write_text(json.dumps({"exit": rc, "ended_at": iso(), "timed_out": rc == 124}) + "\n")
    return 0


def proc_cmdline(pid: int) -> str:
    return run(["ps", "-o", "command=", "-p", str(pid)], check=False, timeout=20).stdout.strip()


def review_alive(rdir: Path, r: Dict[str, Any]) -> Optional[str]:
    """Liveness probe for a detached review: returns why it counts as alive,
    or None when it is provably gone (no matching runner or CLI process)."""
    pf = rdir / "review.pid"
    pids = json.loads(pf.read_text()) if pf.exists() else {"pid": r.get("pid")}
    if pids.get("pid") and pid_alive(pids["pid"]) and r["run_id"] in proc_cmdline(pids["pid"]):
        return f"runner pid {pids['pid']} alive"
    if pids.get("cli_pid") and pid_alive(pids["cli_pid"]) and "coderabbit" in proc_cmdline(pids["cli_pid"]):
        return f"CLI pid {pids['cli_pid']} alive (runner gone)"
    if not pf.exists() and (now() - parse_iso(r["started_at"])).total_seconds() < 60:
        return "just launched (no pidfile yet)"
    return None


# ----------------------------------------------------------- harvesting


def harvest_review(q: Dict[str, Any], item: Dict[str, Any], dry: bool) -> Optional[str]:
    r = item["run"]
    rdir = RUNS / r["run_id"]
    exitf = rdir / "exit.json"
    if not exitf.exists():
        if review_alive(rdir, r):
            return None
        exit_code = None  # provably gone without an exit status → interrupted
    else:
        exit_code = json.loads(exitf.read_text())["exit"]
    if dry:
        return f"would harvest {r['run_id']}"
    meta = json.loads((rdir / "meta.json").read_text())
    cls = classify(rdir / "review.ndjson", exit_code)
    (rdir / "classification.json").write_text(json.dumps(cls, indent=2) + "\n")
    (rdir / "findings.md").write_text(findings_md(rdir / "review.ndjson", meta, cls))
    remove_worktree(Path(meta["worktree"]), meta["wt_branch"])
    attempt = {"run_id": r["run_id"], "outcome": cls["outcome"], "counted": cls["counted"], "at": iso(),
               "head": meta["head"], "base": meta["base"], "message": cls.get("message")}
    item.setdefault("attempts", []).append(attempt)
    item["run"] = None
    event("review_finished", item=item["id"], run=r["run_id"], outcome=cls["outcome"],
          findings=cls["findings"], severity=cls["severity_counts"])
    o = cls["outcome"]
    if o == "completed":
        item["failures"] = 0
        item["last_error"] = None
        record = {"run_id": r["run_id"], "cycle": meta["cycle"], "base": meta["base"], "head": meta["head"],
                  "pr_head": meta.get("pr_head", meta["head"]),
                  "dirty_diff": "clean tree", "ndjson": str(rdir / "review.ndjson"),
                  "findings": cls["findings"], "severity_counts": cls["severity_counts"], "completed_at": iso()}
        if item["kind"] == "open":
            item.setdefault("cycles", []).append(record)
            blocking = sum(cls["severity_counts"].get(s, 0) for s in BLOCKING_SEVERITIES)
            if blocking and CONFIG["spawn_addressing"]:
                spawn_addressing(item, meta, rdir)
            else:
                record["addressing"] = "none needed (no critical/major findings; minor/trivial recorded, not chased)"
                advance_open(item)
        elif item["kind"] == "promotion":
            item.setdefault("cycles", []).append(record)
            ledger_append(item, meta, cls, rdir)
            return f"{item['id']}: completed ({cls['findings']} findings) {harvest_promotion(item, meta, cls, rdir)}"
        else:
            item.setdefault("cycles", []).append(record)
            ledger_append(item, meta, cls, rdir)
            item["state"] = "done"
        return f"{item['id']}: completed ({cls['findings']} findings)"
    if o == "rate_limited":
        mins = cls.get("wait_minutes") or q.get("rl_backoff_min") or CONFIG["rate_limit_default_backoff_min"]
        q["cooldown_until"] = iso(now() + dt.timedelta(minutes=mins + 2))
        q["rl_backoff_min"] = min(240, (q.get("rl_backoff_min") or CONFIG["rate_limit_default_backoff_min"]) * 2)
        item["state"] = "pending"
        item["last_error"] = f"rate limited ({cls.get('message')}); not counted"
        return f"{item['id']}: rate limited → global cooldown until {q['cooldown_until']}"
    if o in ("action_required", "auth"):
        q["paused"] = True
        q["pause_reason"] = f"{o} on {r['run_id']}: {cls.get('message')} — owner action needed (never --use-credits)"
        item["state"] = "pending"
        item["last_error"] = q["pause_reason"]
        event("queue_paused", reason=q["pause_reason"])
        return f"{item['id']}: {o} → queue PAUSED"
    # error / interrupted / skipped: item-level backoff, never counted
    item["failures"] = item.get("failures", 0) + 1
    item["last_error"] = f"{o}: {cls.get('message')}"
    if item["kind"] == "promotion" and o in ("skipped", "too_large"):
        item["state"] = "split_needed"  # promotion_tick re-cuts a smaller prefix (never reported as success)
    elif item["kind"] == "promotion":  # retried, never blocked: promotion must not stall on a flaky run
        item["state"] = "pending"
        item["not_before"] = iso(now() + dt.timedelta(minutes=min(60, CONFIG["error_backoff_min"] * 2 ** (item["failures"] - 1))))
    elif o in ("skipped", "too_large") or item["failures"] >= CONFIG["max_item_failures"]:
        item["state"] = "blocked"
    else:
        item["state"] = "pending"
        item["not_before"] = iso(now() + dt.timedelta(minutes=CONFIG["error_backoff_min"] * 2 ** (item["failures"] - 1)))
    return f"{item['id']}: {o} (not counted) → {item['state']}"


def advance_open(item: Dict[str, Any]) -> None:
    done = item.get("prior_cycles", 0) + len(item.get("cycles", []))
    if done >= 2:
        item["state"] = "done"
    else:
        item["state"] = "pending"
        item["boost"] = True  # finish the PR's pair on the same pin before starting new PRs


def ledger_append(item: Dict[str, Any], meta: Dict[str, Any], cls: Dict[str, Any], rdir: Path) -> None:
    LEDGER.mkdir(parents=True, exist_ok=True)
    f = LEDGER / f"{item['kind']}-findings.md"
    with f.open("a") as out:
        out.write(f"\n## PR #{item['pr']} — {meta['label']} — {iso()}\n\n"
                  f"- run `{meta['run_id']}`; base `{meta['base'][:12]}` head `{meta['head'][:12]}`; "
                  f"{cls['findings']} findings {json.dumps(cls['severity_counts'])}\n"
                  f"- details: {rdir}/findings.md\n"
                  f"- disposition: owner review (no follow-up PR/issue without owner approval)\n")


# ----------------------------------------------------------- addressing agents


def top_level_env() -> Dict[str, str]:
    """Without these, `paseo run` from a tick agent creates the tick agent's
    SUBAGENT — and archiving old tick agents could interrupt it mid-fix."""
    return {k: v for k, v in os.environ.items() if k not in ("PASEO_AGENT_ID", "PASEO_AGENT_CWD")}


def spawn_addressing(item: Dict[str, Any], meta: Dict[str, Any], rdir: Path) -> None:
    cycle = meta["cycle"]
    wt, wbranch = make_worktree(f"addr-{item['id']}-c{cycle}", meta["head"])
    result = rdir / "address-result.json"
    tmpl = (ROOT / "prompts" / "address.md").read_text()
    prompt = (tmpl.replace("{PR}", str(item["pr"])).replace("{BRANCH}", meta["pr_branch"])
              .replace("{WORKTREE}", str(wt)).replace("{BASE}", meta["base"]).replace("{HEAD}", meta["head"])
              .replace("{CYCLE}", str(cycle)).replace("{FINDINGS_MD}", str(rdir / "findings.md"))
              .replace("{NDJSON}", str(rdir / "review.ndjson")).replace("{RESULT}", str(result))
              .replace("{TARGET}", meta["target"]))
    (rdir / "address-prompt.md").write_text(prompt)
    # --new-workspace local: without it an agent-scoped caller's workspace
    # (e.g. the tick agent's) silently overrides --cwd.
    p = run(["paseo", "run", "--background", "--json", "--new-workspace", "local",
             "--provider", CONFIG["address_provider"], "--mode", CONFIG["address_mode"], "--cwd", str(wt),
             "--title", f"crq address PR #{item['pr']} cycle {cycle}", "--label", "crq=address", prompt],
            check=False, timeout=180, env=top_level_env())
    agent_id = cwd_ok = None
    ws = re.search(r"Created workspace (wks_[0-9a-f]+)", p.stdout + p.stderr)
    try:
        out = json.loads(p.stdout[p.stdout.index("{"):])
        agent_id = out.get("agentId")
        cwd_ok = out.get("cwd") == str(wt)
    except ValueError:
        pass
    if p.returncode != 0 or not agent_id or not cwd_ok:
        if agent_id:  # wrong cwd: never let it work outside its worktree
            run(["paseo", "archive", "--force", agent_id], check=False, timeout=60)
        item["state"] = "blocked"
        item["last_error"] = f"could not spawn addressing agent: {p.stderr.strip()[:200] or p.stdout[:200]}"
        event("blocked", item=item["id"], reason=item["last_error"])
        return
    if ws:  # its own workspace (a shared one would override --cwd); give it a findable name
        run(["paseo", "workspace", "rename", ws.group(1), f"crq · address PR #{item['pr']} c{cycle}"],
            check=False, timeout=60, env=top_level_env())
    item["state"] = "addressing"
    item["addressing"] = {"agent_id": agent_id, "run_id": meta["run_id"], "cycle": cycle, "worktree": str(wt),
                          "wt_branch": wbranch, "result": str(result), "started_at": iso(),
                          "workspace_id": ws.group(1) if ws else None}
    event("addressing_started", item=item["id"], agent=agent_id, cycle=cycle)


def harvest_addressing(item: Dict[str, Any], dry: bool) -> Optional[str]:
    a = item["addressing"]
    result = Path(a["result"])
    if result.exists():
        if dry:
            return f"would harvest addressing result for {item['id']}"
        try:
            res = json.loads(result.read_text())
        except ValueError as exc:
            res = {"status": "blocked", "reason": f"unparseable result file: {exc}"}
        cyc = next((c for c in item["cycles"] if c["run_id"] == a["run_id"]), None)
        if cyc is not None:
            cyc["addressing"] = {"agent_id": a["agent_id"], **{k: res.get(k) for k in
                                 ("status", "pushed_sha", "summary", "dispositions", "checks", "reason")}}
        if res.get("pushed_sha"):
            item["last_push"] = {"sha": res["pushed_sha"], "at": iso()}
        remove_worktree(Path(a["worktree"]), a["wt_branch"])
        run(["paseo", "archive", a["agent_id"]], check=False, timeout=60)
        if a.get("workspace_id"):
            run(["paseo", "workspace", "archive", a["workspace_id"]], check=False, timeout=60)
        item["addressing"] = None
        if res.get("status") in ("pushed", "no_changes"):
            advance_open(item)
            event("addressing_finished", item=item["id"], status=res.get("status"), sha=res.get("pushed_sha"))
            return f"{item['id']}: addressing {res.get('status')} → {item['state']}"
        item["state"] = "blocked"
        item["last_error"] = f"addressing blocked: {res.get('reason')}"
        event("blocked", item=item["id"], reason=item["last_error"])
        return f"{item['id']}: addressing blocked"
    started = parse_iso(a["started_at"])
    age = (now() - started).total_seconds() / 60
    try:
        st = (paseo_json(["inspect", a["agent_id"]]).get("Status") or "unknown").lower()
    except Exception:
        st = "unknown"
    if st == "running" and age < CONFIG["address_timeout_min"]:
        return None
    if st == "running" or age > 5:
        if dry:
            return f"would block {item['id']} (addressing agent {st}, no result)"
        item["state"] = "blocked"
        item["last_error"] = (f"addressing agent {a['agent_id'][:8]} status={st} after {age:.0f}m without "
                              f"writing {result.name}; worktree kept at {a['worktree']}")
        event("blocked", item=item["id"], reason=item["last_error"])
        return f"{item['id']}: addressing stalled → blocked"
    return None


# ----------------------------------------------------------- promotion to main
#
# cq-toolkit docs/promotion-policy.md (PR #269): main is promoted in batches,
# and only to a merge-queue sha carrying an owner-posted `crq/promotion-review`
# status whose description binds `main=<base>`. crq cuts the batch, reviews
# base..batch (or reviewed..batch for a delta) and posts the status.

PROMO = CONFIG.get("promotion", {})
OPEN_PROMO_STATES = ("pending", "reviewing", "findings", "promoting", "split_needed", "chain_next", "blocked",
                     "requested", "signer_running")
MAIN_TOKEN = re.compile(r"(^|\s)main=[0-9a-f]{40}(\s|$)")


def policy_at(rev: str) -> bool:
    return run(["git", "cat-file", "-e", f"{rev}:docs/promotion-policy.md"], cwd=CLONE, check=False).returncode == 0


def promotion_gate_live() -> bool:
    """The gate only exists once #269's policy is on main; before that a
    promotion review would spend quota on nothing."""
    return policy_at("origin/main")


def main_sha() -> str:
    return run(["gh", "api", f"repos/{REPO}/git/ref/heads/main", "--jq", ".object.sha"], timeout=60).stdout.strip()


def checks_verdict(sha: str) -> str:
    """Mirror merge-queue-gate's I4 fold over check-runs?filter=latest: per
    required name, pass only when EVERY row is completed+success."""
    rows = run(["gh", "api", f"repos/{REPO}/commits/{sha}/check-runs?filter=latest", "--paginate", "--jq",
                '.check_runs[] | [.name, .status, (.conclusion // "")] | @tsv'], timeout=120).stdout.splitlines()
    for name in PROMO.get("checks", ["static", "denylist", "ratchet"]):
        mine = [r.split("\t") for r in rows if r.split("\t")[0] == name]
        if not mine:
            return f"{name} missing"
        bad = [f"{s}/{c}" for _n, s, c in mine if s != "completed" or c != "success"]
        if bad:
            return f"{name} {bad[0]}"
    return "pass"


def newest_green_tip(base: str, log: List[str]) -> Optional[str]:
    """Newest first-parent merge-queue commit beyond `base` whose gate checks all passed."""
    for sha in git("rev-list", "--first-parent", "-n", str(PROMO.get("tip_search_depth", 15)),
                   f"{base}..origin/merge-queue").split():
        v = checks_verdict(sha)
        if v == "pass":
            return sha
        log.append(f"promotion: skip tip {sha[:10]} ({v})")
    return None


def post_promotion_status(item: Dict[str, Any], sha: str, state: str, desc: str, log: List[str]) -> None:
    if not MAIN_TOKEN.search(desc) or len(desc) > 140:
        raise RuntimeError(f"bad promotion status description: {desc!r}")
    if not PROMO.get("post_status", False):
        log.append(f"promotion: status NOT posted (post_status off): {state} {sha[:10]} {desc}")
        return
    if promotion_mode() != "user":  # the gate trusts only the signer's bot now; a User status would go red
        log.append(f"promotion: status NOT posted ({promotion_mode()} mode): {state} {sha[:10]}")
        return
    # A status from a non-allowed creator turns the gate RED; never post as anyone but the owner's User.
    who = run(["gh", "api", "user", "--jq", '.login + " " + .type'], timeout=60).stdout.strip()
    if who != f"{PROMO['poster']} User":
        raise RuntimeError(f"refusing to post {PROMO['status_context']}: gh auth is {who!r}, not {PROMO['poster']} (User)")
    out = run(["gh", "api", "-X", "POST", f"repos/{REPO}/statuses/{sha}", "-f", f"context={PROMO['status_context']}",
               "-f", f"state={state}", "-f", f"description={desc}"], timeout=60).stdout
    # the GitHub status id is what the promotion audit matches against
    item.setdefault("statuses", []).append({"at": iso(), "sha": sha, "state": state, "description": desc,
                                            "id": json.loads(out).get("id")})
    event("promotion_status", item=item["id"], sha=sha, state=state, description=desc)
    log.append(f"promotion: posted {state} on {sha[:10]}: {desc}")


def first_parents(start: str, end: str) -> List[str]:
    """merge-queue first-parent commits in start..end, oldest first (one per merge)."""
    return git("rev-list", "--first-parent", "--reverse", f"{start}..{end}").split()


def green_within(fps: List[str], log: List[str]) -> Optional[str]:
    """Newest commit of a contiguous oldest-first prefix whose gate checks are all green."""
    for sha in reversed(fps):
        v = checks_verdict(sha)
        if v == "pass":
            return sha
        log.append(f"promotion: skip tip {sha[:10]} ({v})")
    return None


def split_promotion(q: Dict[str, Any], item: Dict[str, Any], log: List[str], dry: bool) -> None:
    """CodeRabbit skipped/refused the batch: re-cut the oldest contiguous half of
    its merges; escalate to the owner only when a single-merge batch is refused."""
    st = q.setdefault("promotion", {})
    start = item.get("reviewed_sha") or item["base_sha"]
    fps = first_parents(start, item["batch_sha"])
    outcome = (item.get("attempts") or [{}])[-1].get("outcome", "skipped")
    if len(fps) <= 1:
        if dry:
            log.append(f"promotion: would escalate {item['id']} (single-merge batch {outcome})")
            return
        item.update(state="blocked", last_error=f"single-merge batch {outcome} by CodeRabbit — owner override needed")
        post_promotion_status(item, item["batch_sha"], "error",  # no-op in signer mode (the signer posted error)
                              f"review {outcome} on 1-merge batch main={item['base_sha']} crq#{item['id']}"[:140], log)
        st.setdefault("escalations", []).append({"at": iso(), "item": item["id"], "sha": item["batch_sha"],
                                                 "base": item["base_sha"], "outcome": outcome, "acked": None})
        st["attempts"] = st.get("attempts", []) + [{"at": iso(), "item": item["id"], "merges": 1, "why": f"{outcome} → ESCALATED"}]
        event("promotion_escalated", item=item["id"], sha=item["batch_sha"], outcome=outcome)
        notify_owner(f"crq PROMOTION NEEDS OWNER OVERRIDE: CodeRabbit {outcome} the single-merge batch "
                     f"{item['batch_sha'][:10]} (main={item['base_sha'][:10]}). Override per docs/promotion-policy.md, "
                     f"then `crq.py promotion-ack {item['batch_sha'][:10]} \"<reason>\"`.")
        log.append(f"promotion: {item['id']} single-merge batch {outcome} → escalated to owner")
        return
    n = len(fps) // 2
    tip = green_within(fps[:n], log)
    if not tip:
        log.append(f"promotion: {item['id']} {outcome}; no green tip in the oldest {n} merges yet — waiting")
        return
    if not dry:
        item.update(state="split", last_error=f"{outcome} at {len(fps)} merges → re-cut to {n}")
        st["continue_to"] = st.get("continue_to") or item["batch_sha"]
        st["batch_cap"] = n
    if promotion_mode() == "signer":  # full prefix review from main under a fresh id
        cut_promotion(q, log, dry, item["base_sha"], tip, f"{outcome} at {len(fps)} merges → oldest {n}")
        return
    cut_promotion(q, log, dry, item["base_sha"], tip, f"{outcome} at {len(fps)} merges → oldest {n}",
                  reviewed=item.get("reviewed_sha"), carried=item.get("blocking"),
                  must_reach=(item.get("must_reach") or item["batch_sha"]) if item.get("blocking") else None)


def open_promotion(q: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    return next((i for i in q["items"] if i["kind"] == "promotion" and i["state"] in OPEN_PROMO_STATES), None)


def cut_promotion(q: Dict[str, Any], log: List[str], dry: bool, base: str, batch: str, why: str,
                  reviewed: Optional[str] = None, carried: Optional[List[Dict[str, Any]]] = None,
                  must_reach: Optional[str] = None) -> Optional[Dict[str, Any]]:
    if promotion_mode() == "signer":
        iid = fresh_signer_id(q, batch)
        if iid is None:
            signer_alert(q, None, f"no fresh signer id left for batch {batch[:10]} (10 attempts used)", log)
            return None
    else:
        iid = f"promo-{batch[:10]}{'-delta' if reviewed else ''}"
        while any(i["id"] == iid for i in q["items"]):
            iid += "+"
    merges = len(first_parents(reviewed or base, batch))
    item = new_item(q, log, dry, id=iid, pr=0, kind="promotion", base_sha=base, batch_sha=batch,
                    reviewed_sha=reviewed, blocking=carried or [], merges=merges, why=why)
    if promotion_mode() == "signer":
        item["signer"] = True  # cut under the signer gate (user-era items get re-requested once)
    if must_reach and must_reach != batch:
        item["must_reach"] = must_reach  # carries resolved findings: success only once the fix tip is reviewed
    if not dry:
        st = q.setdefault("promotion", {})
        st["requested"] = False
        st["attempts"] = (st.get("attempts", []) + [{"at": iso(), "item": iid, "merges": merges, "why": why}])[-30:]
    log.append(f"promotion: {'would cut' if dry else 'cut'} {item['id']} {(reviewed or base)[:10]}..{batch[:10]} "
               f"main={base[:10]} ({why})")
    return item


def promotion_tick(q: Dict[str, Any], dry: bool) -> List[str]:
    """Advance the (single) open promotion, or cut a new one when a trigger fired."""
    log: List[str] = []
    if not PROMO.get("enabled"):
        return log
    if not promotion_gate_live():
        return ["promotion: dormant (origin/main has no docs/promotion-policy.md yet)"]
    st = q.setdefault("promotion", {})
    mode = promotion_mode()
    if mode == "signer_unconfigured":
        if not st.get("unconfigured_alerted") and not dry:
            st["unconfigured_alerted"] = iso()
            signer_alert(q, None, f"reviewer identity not pinned: {_MODE_WHY.get('origin/main', '?')} — promotion "
                                  f"halted (no User statuses: they would go red). Fill promotion.signer from the "
                                  f"owner's registration record only.", log)
        return log + [f"promotion: HALTED — reviewer identity not pinned ({_MODE_WHY.get('origin/main', '?')})"]
    main = main_sha()
    if not st.get("last_promoted_at"):
        # epoch, not %cI: %cI carries the committer's UTC offset, and truncating it to "...Z" skewed this by hours
        st["last_promoted_at"] = iso(dt.datetime.fromtimestamp(int(git("log", "-1", "--format=%ct", "origin/main")), dt.timezone.utc))
    item = open_promotion(q)
    if mode == "signer" and item and not item.get("signer") and item["state"] != "reviewing":
        # cut under the User-status gate: its statuses no longer count — re-request a full signer review
        recut_promotion(q, item, log, dry, "superseded", "gate switched to the promotion reviewer signer")
        return log
    if item and item["state"] in ("pending", "findings", "split_needed", "chain_next", "blocked") \
            and is_ancestor(item["batch_sha"], main):
        if not dry:  # e.g. the owner overrode an escalated batch: the slot must not stay held
            item.update(state="done", last_error=f"batch already in main {main[:10]} (promoted outside crq)")
            event("promoted_outside_crq", item=item["id"], sha=item["batch_sha"])
        log.append(f"promotion: {item['id']} batch already in main → closed")
        item = None
    if item and item["state"] == "promoting":
        if is_ancestor(item["batch_sha"], main):
            if not dry:
                item["state"] = "done"
                st.update(last_promoted_sha=item["batch_sha"], last_promoted_at=iso())
                event("promoted", item=item["id"], sha=item["batch_sha"])
            log.append(f"promotion: main reached {item['batch_sha'][:10]} → {item['id']} done")
            item = None
        elif not is_ancestor(item["base_sha"], main):
            if not dry:
                item.update(state="skipped", last_error=f"main moved to {main[:10]}, which lacks the review base")
            log.append(f"promotion: {item['id']} superseded (main {main[:10]} lacks base) → re-cut")
            item = None
        else:
            since = (now() - parse_iso(item["success_at"])).total_seconds() / 60
            if since >= PROMO.get("dispatch_after_min", 20) and not item.get("dispatched") and not dry:
                if PROMO.get("post_status"):
                    run(["gh", "workflow", "run", "merge-queue-gate.yml", "--repo", REPO, "--ref", "main",
                         "-f", f"sha={item['batch_sha']}"], check=False, timeout=60)
                item["dispatched"] = iso()
                event("promotion_dispatch", item=item["id"], sha=item["batch_sha"])
                log.append(f"promotion: main not at {item['batch_sha'][:10]} {since:.0f}m after success → gate dispatched")
            return log
    if item and item["state"] == "findings":
        if not is_ancestor(item["base_sha"], main):
            if not dry:
                item.update(state="skipped", last_error=f"main moved to {main[:10]}, which lacks the review base")
            item = None
        elif all(b.get("resolution") for b in item["blocking"]) and mode == "signer":
            # signer-owned coverage: no agent-judged success, no delta — a FULL re-review of main..tip
            tip = newest_green_tip(main, log)
            if not tip or tip == item["batch_sha"]:
                return log + [f"promotion: {item['id']} resolved but no newer green tip yet — waiting for the fix to "
                              f"merge (false positives need an owner override)"]
            if not dry:
                item.update(state="done", last_error="superseded by a full re-review after promotion-resolve")
            cut_promotion(q, log, dry, main, tip, f"full re-review after {item['id']} findings resolved")
            return log
        elif all(b.get("resolution") for b in item["blocking"]):
            tip = newest_green_tip(main, log)
            if tip == item["batch_sha"]:
                n = len(item["blocking"])
                if not dry:
                    post_promotion_status(item, tip, "success",
                                          f"reviewed; {n} blocking dispositioned main={item['base_sha']} crq#{item['id']}"[:140], log)
                    item.update(state="promoting", success_at=iso())
                return log
            if tip and is_ancestor(item["batch_sha"], tip):
                if not dry:
                    item["state"] = "done"
                cut_promotion(q, log, dry, item["base_sha"], tip, f"blocking findings of {item['id']} addressed",
                              reviewed=item["batch_sha"], carried=item["blocking"])
                return log
            if tip:
                if not dry:
                    item.update(state="skipped", last_error=f"new green tip {tip[:10]} does not descend from the batch")
                item = None
            else:
                return log + ["promotion: findings resolved; waiting for a green merge-queue tip"]
        else:
            open_n = sum(1 for b in item["blocking"] if not b.get("resolution"))
            return log + [f"promotion: {item['id']} waiting on {open_n} unresolved blocking finding(s)"]
    if item and item["state"] == "chain_next":
        st_cap = st.get("batch_cap")
        rest = first_parents(item["batch_sha"], item["must_reach"])
        tip = green_within(rest[:st_cap or len(rest)], log)
        if tip:
            if not dry:
                item["state"] = "done"
            cut_promotion(q, log, dry, item["base_sha"], tip, f"chained delta toward fix tip {item['must_reach'][:10]}",
                          reviewed=item["batch_sha"], carried=item["blocking"], must_reach=item["must_reach"])
        return log
    if item and item["state"] == "split_needed":
        split_promotion(q, item, log, dry)
        return log
    if item:
        return log  # pending / reviewing / blocked: the start loop and harvest own it
    target = st.get("continue_to")
    if target and is_ancestor(target, main):
        if not dry:
            st.pop("continue_to", None)
            st.pop("batch_cap", None)
        log.append(f"promotion: split batch {target[:10]} fully promoted")
    elif target:  # promote a split batch prefix by prefix, at the size CodeRabbit accepted
        rest = first_parents(main, target)
        tip = green_within(rest[:st.get("batch_cap") or len(rest)], log)
        if tip:
            cut_promotion(q, log, dry, main, tip, f"continuing split batch toward {target[:10]} "
                          f"(≤{st.get('batch_cap')} of {len(rest)} remaining merges)")
        else:
            log.append(f"promotion: continuing split batch toward {target[:10]}; no green tip in the next prefix yet")
        return log
    merges = int(git("rev-list", "--count", "--merges", "--first-parent", f"{main}..origin/merge-queue"))
    age_h = (now() - parse_iso(st["last_promoted_at"])).total_seconds() / 3600
    why = ("on demand" if st.get("requested") else
           f"{merges} merges since last promotion" if merges >= PROMO.get("merges_trigger", 5) else
           f"{age_h:.1f}h since last promotion" if merges and age_h >= PROMO.get("hours_trigger", 8) else None)
    if not why:
        return log
    tip = newest_green_tip(main, log)
    if not tip or is_ancestor(tip, main):
        return log + [f"promotion: trigger fired ({why}) but no merge-queue tip beyond main has all gate checks green"]
    cut_promotion(q, log, dry, main, tip, why)
    return log


# ----------------------------------------------------------- signer mode (promotion reviewer bot, contract v1)
#
# Once main's merge-queue-gate.yml pins the promotion reviewer bot (cq-toolkit PR-B),
# the gate trusts only that bot's statuses. The signer (the dedicated `crq`
# macOS user) then reviews AND posts. crq only spools requests and reads
# results: it never judges success and never posts a status. Until the pin is
# on main, everything above runs unchanged ("user" mode).

SIGNER = PROMO.get("signer", {})
SPOOL = Path(SIGNER.get("spool_dir", "/Users/Shared/crq-spool"))
SIGNER_ID = re.compile(r"^promo-[0-9a-f]{10}\+{0,9}$")
SIGNER_DONE_CODES = {"success_present", "already_in_main"}
SIGNER_RECUT_CODES = {"base_not_main", "main_not_ancestor", "checks_not_green", "subject_moved"}
SIGNER_STATES = ("requested", "signer_running")
_MODE: Dict[str, str] = {}
_MODE_WHY: Dict[str, str] = {}
# A THIRD PARTY's public App (owner cqrect, App 1175046), wrongly pinned on
# 2026-10-04 from a public-API lookup by a guessed name. Never trusted, never
# used, even if it reappears in config. The reviewer identity comes ONLY from the
# owner's registration record (toolkit-research/plans/app-registration-session-20261004.md).
BANNED_BOT_IDS = {202921479}
BANNED_BOT_LOGINS = {"cq-reviewer[bot]"}
GATE_UNSET = "@@UNSET-REVIEWER-BOT-LOGIN@@"
GATE_PIN_LOGIN = re.compile(r"--arg bot_login '([^']*)'")
GATE_PIN_ID = re.compile(r"--argjson bot_id (-?\d+)")


def reviewer_identity() -> Optional[Tuple[str, int]]:
    """(bot login, numeric bot user id) from config, or None (unpinned → fail closed).
    No defaults anywhere: an unset, malformed or banned identity is never trusted."""
    login, bot_id = SIGNER.get("app_login"), SIGNER.get("reviewer_bot_id")
    if not isinstance(login, str) or not login.endswith("[bot]") or isinstance(bot_id, bool) or not isinstance(bot_id, int):
        return None
    if bot_id <= 0 or bot_id in BANNED_BOT_IDS or login in BANNED_BOT_LOGINS:
        return None
    return login, bot_id


def promotion_mode_at(rev: str) -> str:
    """'signer' only when the gate at `rev` pins a reviewer bot (rendered
    `--arg bot_login '<login>'` + `--argjson bot_id <n>`) that EXACTLY equals crq's
    configured identity. 'signer_unconfigured' when the gate has the bot-pin
    machinery but it is UNSET (PR-B sentinels), pins an identity crq does not
    have, or is unparseable: promotion halts (a User status would be refused red).
    'user' when the gate has no bot pin at all (the #269 User-allowlist gate)."""
    if rev not in _MODE:
        p = run(["git", "show", f"{rev}:.github/workflows/merge-queue-gate.yml"], cwd=CLONE, check=False)
        text = p.stdout if p.returncode == 0 else ""
        # every rendered pin occurrence must agree (same rule as the signer's gate_pins_signer)
        logins, ids = set(GATE_PIN_LOGIN.findall(text)), {int(x) for x in GATE_PIN_ID.findall(text)}
        ident = reviewer_identity()
        if GATE_UNSET in text or any(x.startswith("@@UNSET") for x in logins) or any(x <= 0 for x in ids):
            _MODE[rev], _MODE_WHY[rev] = "signer_unconfigured", "the gate's reviewer identity is an UNSET sentinel"
        elif logins or ids:
            if len(logins) != 1 or len(ids) != 1:
                _MODE[rev], _MODE_WHY[rev] = "signer_unconfigured", (f"the gate's reviewer pins are inconsistent "
                                                                    f"(logins {sorted(logins)}, ids {sorted(ids)})")
                return _MODE[rev]
            pinned = (next(iter(logins)), next(iter(ids)))
            if ident and ident == pinned:
                _MODE[rev] = "signer"
            else:
                _MODE[rev] = "signer_unconfigured"
                _MODE_WHY[rev] = (f"the gate pins {pinned[0]}/{pinned[1]} but crq's identity is "
                                  f"{'unset' if not ident else f'{ident[0]}/{ident[1]}'}")
        elif re.search(r"bot_login|bot_id|REVIEWER_BOT", text):
            _MODE[rev], _MODE_WHY[rev] = "signer_unconfigured", "the gate has an unrecognised reviewer-pin format"
        else:
            _MODE[rev] = "user"
    return _MODE[rev]


def promotion_mode() -> str:
    return promotion_mode_at("origin/main")


def signer_alert(q: Dict[str, Any], item: Optional[Dict[str, Any]], text: str, log: List[str]) -> None:
    st = q.setdefault("promotion", {})
    sha = (item or {}).get("batch_sha") or "signer"
    st.setdefault("signer_alerts", []).append({"at": iso(), "item": (item or {}).get("id"), "sha": sha,
                                               "text": text[:300], "acked": None})
    event("promotion_signer_alert", item=(item or {}).get("id"), text=text[:300])
    notify_owner(f"crq PROMOTION SIGNER: {text[:500]} — see {STATE / 'status.md'}; ack with "
                 f"`crq.py promotion-ack {sha[:10]} \"<reason>\"`.")
    log.append(f"promotion: SIGNER ALERT {text[:200]}")


def apply_signer_backoff(q: Dict[str, Any], log: List[str]) -> None:
    """The signer publishes deferrals in ledger/backoff.json ({"v":1,"item",
    "wait_minutes","until","at","reason":"budget"|"rate_limit"}). A rate limit is
    the shared CodeRabbit quota, so it extends crq's global cooldown. A budget
    deferral is only the signer's own 2/h cap: it must not stall crq's PR
    reviews, it only explains an unclaimed request (see harvest_signer). (If
    ledger/ is unwritable, rate_limited results still reach crq via harvest.)"""
    try:
        b = json.loads((SPOOL / "ledger" / "backoff.json").read_text())
        until = parse_iso(b["until"]) if b.get("v") == 1 and b.get("until") else None
    except (OSError, ValueError, KeyError, TypeError):
        return
    if until:
        q.setdefault("promotion", {})["signer_deferral"] = {"item": b.get("item"), "until": iso(until),
                                                           "reason": b.get("reason")}
    cur = parse_iso(q.get("cooldown_until"))
    if b.get("reason", "rate_limit") != "rate_limit":
        return
    if until and until > now() and (cur is None or until > cur):
        q["cooldown_until"] = iso(until)
        log.append(f"signer backoff ({b.get('item')}, {b.get('wait_minutes')}m) → cooldown until {q['cooldown_until']}")


def fresh_signer_id(q: Dict[str, Any], batch: str) -> Optional[str]:
    """promo-<sha10> plus up to nine '+', unused in the queue AND in results/
    (the signer treats an existing results/<id>.json as already done)."""
    for k in range(10):
        iid = f"promo-{batch[:10]}{'+' * k}"
        if not any(i["id"] == iid for i in q["items"]) and not (SPOOL / "results" / f"{iid}.json").exists():
            return iid
    return None


def request_promotion_review(q: Dict[str, Any], item: Dict[str, Any], log: List[str]) -> None:
    """Spool requests/<id>.json atomically (tmp + rename, never rewritten)."""
    if not SIGNER_ID.match(item["id"]):
        raise NotReady(f"item id {item['id']} does not fit the signer id pattern")
    body = json.dumps({"v": 1, "kind": "promotion", "item": item["id"], "base_sha": item["base_sha"],
                       "batch_sha": item["batch_sha"], "requested_at": iso()}, sort_keys=True).encode()
    req_dir = SPOOL / "requests"
    tmp = req_dir / f".{item['id']}.json.tmp"
    tmp.write_bytes(body)
    tmp.replace(req_dir / f"{item['id']}.json")
    item["state"] = "requested"
    item["request"] = {"sha256": hashlib.sha256(body).hexdigest(), "requested_at": json.loads(body)["requested_at"]}
    q.setdefault("starts", []).append(item["request"]["requested_at"])  # signer runs share crq's CLI budget
    event("promotion_requested", item=item["id"], base=item["base_sha"], batch=item["batch_sha"])
    log.append(f"promotion: requested signer review {item['id']} main={item['base_sha'][:10]}..{item['batch_sha'][:10]}")


def recut_promotion(q: Dict[str, Any], item: Dict[str, Any], log: List[str], dry: bool, state: str, why: str,
                    batch: Optional[str] = None, not_before: Optional[str] = None) -> None:
    """Close `item` and request a fresh full review (fresh id) from the current main."""
    batch = batch or item["batch_sha"]
    main = main_sha()
    if not dry:
        item.update(state=state, last_error=why)
    if is_ancestor(batch, main):
        log.append(f"promotion: {item['id']} {why}; batch already in main")
        return
    new = cut_promotion(q, log, dry, main, batch, why)
    if new is not None and not_before and not dry:
        new["not_before"] = not_before


def harvest_signer(q: Dict[str, Any], item: Dict[str, Any], dry: bool) -> Optional[str]:
    log: List[str] = []
    iid = item["id"]
    res_f, claim_f, req_f = (SPOOL / "results" / f"{iid}.json", SPOOL / "results" / f"{iid}.claimed",
                             SPOOL / "requests" / f"{iid}.json")
    age = (now() - parse_iso(item["request"]["requested_at"])).total_seconds() / 60
    if not res_f.exists():
        if claim_f.exists():
            if not dry:
                item["state"] = "signer_running"
            if age > PROMO.get("signer_stall_min", 90) and not item.get("stall_alerted") and not dry:
                item["stall_alerted"] = iso()
                signer_alert(q, item, f"{iid} claimed but no result after {age:.0f}m (signer CLI timeout 75m)", log)
            return "; ".join(log) or None
        if item["base_sha"] != main_sha() and not dry:  # stale before the signer claimed it: withdraw (contract B)
            try:
                req_f.unlink()  # the signer renames a request to a dot-name before claiming: we win, or ENOENT
            except FileNotFoundError:
                return f"{iid}: main moved, but the signer already took the request — awaiting its result"
            recut_promotion(q, item, log, dry, "withdrawn", "main moved before the signer claimed the request")
            return "; ".join(log)
        # a healthy signer defers unclaimed (budget / rate limit): count from the end of its published deferral
        d = (q.get("promotion") or {}).get("signer_deferral") or {}
        ref = parse_iso(item["request"]["requested_at"])
        if d.get("item") in (iid, None) and d.get("until") and parse_iso(d["until"]) > ref:
            ref = parse_iso(d["until"])
        idle = (now() - ref).total_seconds() / 60
        if idle > PROMO.get("signer_down_min", 30) and not item.get("down_alerted") and not dry:
            item["down_alerted"] = iso()
            signer_alert(q, item, f"{iid} unclaimed for {age:.0f}m ({idle:.0f}m past any published deferral) — "
                                  f"signer down?", log)
        return "; ".join(log) or None
    if dry:
        return f"would harvest signer result {iid}"
    try:
        r = json.loads(res_f.read_text())
    except ValueError as exc:
        signer_alert(q, item, f"{iid}: unparseable signer result ({exc})", log)
        item["state"] = "blocked"
        return "; ".join(log)
    if (r.get("request_sha256") != item["request"]["sha256"] or r.get("item") != iid
            or r.get("base_sha") != item["base_sha"] or r.get("batch_sha") != item["batch_sha"]):
        if not item.get("mismatch_alerted"):
            item["mismatch_alerted"] = iso()
            signer_alert(q, item, f"{iid}: signer result does not match crq's request (sha256/item/base/batch) — ignored", log)
        return "; ".join(log)
    o, posted = r.get("outcome"), r.get("posted") or {}
    item["signer_result"] = {k: r.get(k) for k in ("outcome", "posted_state", "posted", "blocking", "started_at",
                                                   "ended_at", "wait_minutes", "reason")}
    item.setdefault("attempts", []).append({"run_id": f"signer:{iid}", "outcome": o, "at": iso(), "head": item["batch_sha"],
                                            "base": item["base_sha"], "message": r.get("reason")})
    if posted.get("status_id"):
        item.setdefault("statuses", []).append({"at": posted.get("at"), "sha": item["batch_sha"], "id": posted["status_id"],
                                                "state": posted.get("state"), "description": posted.get("description"),
                                                "by": "signer"})
    event("promotion_signer_result", item=iid, outcome=o, posted_state=r.get("posted_state"), blocking=r.get("blocking"))
    LEDGER.mkdir(parents=True, exist_ok=True)
    with (LEDGER / "promotion-findings.md").open("a") as f:
        f.write(f"\n## promotion {iid} — signer {o}/{r.get('posted_state')} — {iso()}\n\n- main `{item['base_sha'][:12]}`"
                f" → batch `{item['batch_sha'][:12]}`; blocking {json.dumps(r.get('blocking'))}; severity "
                f"{json.dumps(r.get('severity_counts'))}\n"
                + "".join(f"- F{x.get('n')} [{x.get('severity')}] {x.get('file')}:{x.get('line')} — {str(x.get('title'))[:160]}\n"
                          for x in r.get("findings") or []))
    if o == "completed" and r.get("posted_state") == "success":
        item.update(state="promoting", success_at=posted.get("at") or iso(), cycles=[{"run_id": f"signer:{iid}"}])
        return f"{iid}: signer success → promoting"
    if o == "completed" and r.get("posted_state") not in ("success", "failure"):
        # reviewed, but the signer's final post failed: re-request; its coverage ledger usually posts without a new CLI run
        item["failures"] = item.get("failures", 0) + 1
        nb = iso(now() + dt.timedelta(minutes=min(60, CONFIG["error_backoff_min"] * 2 ** (item["failures"] - 1))))
        recut_promotion(q, item, log, dry, "retried", f"signer completed without a final status ({r.get('posted_state')})",
                        not_before=nb)
        return "; ".join(log)
    if o == "completed" and r.get("posted_state") == "failure":
        item.update(state="findings", cycles=[{"run_id": f"signer:{iid}"}],
                    blocking=[{"n": x.get("n"), "severity": x.get("severity"), "file": x.get("file"), "line": x.get("line"),
                               "title": str(x.get("title"))[:160], "resolution": None} for x in r.get("findings") or []])
        return f"{iid}: signer failure ({r.get('blocking')}) → findings"
    if o in ("skipped", "too_large"):
        item["state"] = "split_needed"  # signer already posted error; promotion_tick halves
        return f"{iid}: signer {o} → split"
    if o == "rate_limited":
        mins = (r.get("wait_minutes") or CONFIG["rate_limit_default_backoff_min"]) + 2
        q["cooldown_until"] = iso(now() + dt.timedelta(minutes=mins))
        recut_promotion(q, item, log, dry, "retried", f"signer rate limited ({mins}m)", not_before=q["cooldown_until"])
        return "; ".join(log)
    if o == "auth":
        q["paused"] = True
        q["pause_reason"] = f"signer auth failure on {iid} — owner action needed (never --use-credits)"
        item["state"] = "blocked"
        signer_alert(q, item, q["pause_reason"], log)
        return "; ".join(log)
    code = r.get("reason_code")
    if o in ("rejected", "error") and code:  # machine reason codes; never regex the reason text
        why = f"{code}: {str(r.get('reason') or '')[:150]}"
        if code in SIGNER_DONE_CODES:
            item.update(state="done", last_error=f"signer {o} {why} (treated as done)")
            return f"{iid}: signer {o} {code} → done"
        if code in SIGNER_RECUT_CODES:
            item.update(state="rejected", last_error=f"signer {o} {why}")
            q.setdefault("promotion", {})["requested"] = True  # re-cut from the current main / newest green tip
            return f"{iid}: signer {o} {code} → re-cut"
        item.update(state="blocked", last_error=f"signer {o} {why}")
        signer_alert(q, item, f"{iid}: signer {o} {why}", log)
        return "; ".join(log)
    if o in ("error", "interrupted"):
        item["failures"] = item.get("failures", 0) + 1
        nb = iso(now() + dt.timedelta(minutes=min(60, CONFIG["error_backoff_min"] * 2 ** (item["failures"] - 1))))
        recut_promotion(q, item, log, dry, "retried", f"signer {o}: {r.get('reason') or ''}"[:200], not_before=nb)
        return "; ".join(log)
    if o == "secret_scan_blocked":
        item["state"] = "blocked"
        signer_alert(q, item, f"{iid}: signer secret scan blocked main={item['base_sha'][:10]}..{item['batch_sha'][:10]} "
                              f"— owner must inspect (nothing uploaded)", log)
        return "; ".join(log)
    if o == "rejected":  # without a reason_code: contract violation
        item.update(state="blocked", last_error=f"signer rejected without reason_code: {str(r.get('reason'))[:150]}")
        signer_alert(q, item, f"{iid}: signer rejected without a reason_code ({str(r.get('reason'))[:150]})", log)
        return "; ".join(log)
    item["state"] = "blocked"
    signer_alert(q, item, f"{iid}: unknown signer outcome {o!r}", log)
    return "; ".join(log)


# ----------------------------------------------------------- promotion audit (read-only toward GitHub)
#
# Compensating control (owner ruling, #269 P1): any fleet agent with the
# owner's gh auth can post crq/promotion-review. So on every tick, when main
# has advanced, find the status that authorized the new main sha and require
# that crq itself posted it, for a promotion item with a completed review.


def promotion_statuses(sha: str) -> List[Dict[str, Any]]:
    rows = run(["gh", "api", f"repos/{REPO}/commits/{sha}/statuses?per_page=100", "--paginate", "--jq",
                f'.[] | select(.context == "{PROMO.get("status_context", "crq/promotion-review")}") | '
                '{id, state, description, created_at, login: .creator.login, type: .creator.type, creator_id: .creator.id}'],
               timeout=120).stdout.splitlines()
    return [json.loads(r) for r in rows if r.strip()]


def notify_owner(text: str) -> Dict[str, Any]:
    """Paseo message to the chancellor (the owner's desk; works from the
    Background launchd session ticks run in) plus a best-effort macOS
    notification (osascript exits 0 there but may not display)."""
    res: Dict[str, Any] = {}
    aid = PROMO.get("alert_agent_id")
    if aid:
        p = run(["paseo", "send", "--no-wait", aid, text], check=False, timeout=90, env=top_level_env())
        res["paseo_send"] = p.returncode if p.returncode == 0 else f"{p.returncode}: {p.stderr.strip()[:150]}"
    o = run(["osascript", "-e", f"display notification {json.dumps(text[:220])} with title "
             f"\"crq alert\" sound name \"Basso\""], check=False, timeout=30)
    res["osascript"] = o.returncode
    return res


def audit_signer_advance(q: Dict[str, Any], last: str, main: str, rec: Dict[str, Any]) -> Tuple[List[str], List[str]]:
    """PRIMARY (P1 / admin-bypass detector): main advanced only with a trusted bot
    success (login, Bot, numeric id) whose main=<base> is contained in the
    previous main. Corroboration against crq's own requests is informational."""
    reasons: List[str] = []
    notes: List[str] = []
    if not is_ancestor(last, main):
        reasons.append(f"main did not fast-forward ({last[:10]} is not an ancestor of {main[:10]})")
    sts = promotion_statuses(main)
    ident = reviewer_identity()  # None → nothing is trusted (fail closed)
    bot = [x for x in sts if ident and x["type"] == "Bot" and x["login"] == ident[0] and x.get("creator_id") == ident[1]]
    others = [f"{x['login']}({x['type']},{x.get('creator_id')}) {x['state']}" for x in sts if x not in bot]
    if others:
        rec["other_creators"] = others
    auth = max(bot, key=lambda x: (x["created_at"], x["id"])) if bot else None
    if auth:
        rec["status"] = auth
    if not auth or auth["state"] != "success":
        reasons.append("no trusted reviewer-bot success on the new main sha" + (f" (newest is {auth['state']})" if auth else "")
                       + ("" if ident else " — reviewer identity not pinned in crq"))
        return reasons, notes
    desc = auth.get("description") or ""
    m = re.search(r"(?:^|\s)main=([0-9a-f]{40})(?:\s|$)", desc)
    if not m:
        reasons.append("trusted success binds no main=<base>")
    elif not is_ancestor(m.group(1), last):
        reasons.append(f"trusted success binds main={m.group(1)[:10]}, which the previous main {last[:10]} does not contain")
    if desc.startswith("override"):
        rec["override"] = desc[:140]  # owner override via crq-override: logged, not alerted
        return reasons, notes
    cm = re.search(r"crq#(\S+)", desc)
    item = next((i for i in q["items"] if i["kind"] == "promotion" and cm and i["id"] == cm.group(1)), None)
    if not item or item.get("batch_sha") != main:
        notes.append(f"crq#{cm.group(1) if cm else '?'} is not a crq promotion item cut for {main[:10]}")
    else:
        rec["item"] = item["id"]
        try:
            r = json.loads((SPOOL / "results" / f"{item['id']}.json").read_text())
        except (OSError, ValueError):
            r = {}
        posted = r.get("posted") or {}
        if r.get("outcome") != "completed" or posted.get("state") != "success" or posted.get("status_id") != auth["id"]:
            notes.append(f"signer results/{item['id']}.json does not corroborate status {auth['id']} "
                         f"(outcome={r.get('outcome')}, posted={posted.get('state')}/{posted.get('status_id')})")
        if (item.get("request") or {}).get("sha256") != r.get("request_sha256"):
            notes.append(f"results/{item['id']}.json request_sha256 does not match crq's request")
    return reasons, notes


def promotion_audit(q: Dict[str, Any], dry: bool) -> List[str]:
    a = q.setdefault("promotion_audit", {"records": [], "alerts": []})
    main = main_sha()
    last = a.get("last_main")
    if not last:
        if not dry:
            a["last_main"] = main
        return [f"promotion audit: baseline main={main[:10]}"]
    if main == last:
        return []
    if run(["git", "cat-file", "-e", f"{main}^{{commit}}"], cwd=CLONE, check=False).returncode != 0:
        git("fetch", "--quiet", "origin", "main", check=False)
    rec: Dict[str, Any] = {"at": iso(), "from": last, "to": main}
    reasons: List[str] = []
    if not policy_at(last):
        rec["verdict"] = "pre-policy"  # advanced under the old gate (policy not yet on main)
    elif promotion_mode_at(last) != "user":
        rec["mode"] = "signer"
        reasons, notes = audit_signer_advance(q, last, main, rec)
        rec["verdict"] = ("override" if rec.get("override") and not reasons else "UNVERIFIED" if reasons else
                          "verified" if not notes else "verified-uncorroborated")
        rec["reasons"], rec["notes"] = reasons, notes
    else:
        if not is_ancestor(last, main):
            reasons.append(f"main did not fast-forward ({last[:10]} is not an ancestor of {main[:10]})")
        sts = promotion_statuses(main)
        allowed = {PROMO.get("poster", "camerontaylor")} | set(PROMO.get("allowed_reviewers", []))
        ok_creator = [x for x in sts if x["type"] == "User" and x["login"] in allowed]
        others = [f"{x['login']}({x['type']}) {x['state']}" for x in sts if x not in ok_creator]
        if others:
            rec["other_creators"] = others
        auth = max(ok_creator, key=lambda x: (x["created_at"], x["id"])) if ok_creator else None
        if auth:
            rec["status"] = auth
        if not auth or auth["state"] != "success":
            reasons.append("no qualifying crq/promotion-review success on the new main sha"
                           + (f" (newest allowed is {auth['state']})" if auth else ""))
        else:
            if (auth.get("description") or "").startswith("override"):
                reasons.append(f"owner-style override status by {auth['login']}: {auth['description'][:100]}")
            item = next((i for i in q["items"] if i["kind"] == "promotion" and i.get("batch_sha") == main), None)
            if not item:
                reasons.append("crq has no promotion item for this batch sha")
            else:
                rec["item"] = item["id"]
                if not item.get("cycles"):
                    reasons.append(f"{item['id']} has no completed review")
                if not any(x.get("id") == auth["id"] and x["state"] == "success" for x in item.get("statuses", [])):
                    reasons.append(f"authorizing status {auth['id']} by {auth['login']} was not posted by crq "
                                   f"(crq posted ids {[x.get('id') for x in item.get('statuses', [])]})")
        rec["verdict"] = "UNVERIFIED" if reasons else "verified"
        rec["reasons"] = reasons
    line = f"promotion audit: main {last[:10]} → {main[:10]}: {rec['verdict']}" + (f" — {'; '.join(reasons)}" if reasons else "")
    if dry:
        return [line]
    a["last_main"] = main
    a["records"] = (a["records"] + [rec])[-300:]
    LEDGER.mkdir(parents=True, exist_ok=True)
    with (LEDGER / "promotion-audit.md").open("a") as f:
        f.write(f"- {rec['at']} main {last[:12]} → {main[:12]}: **{rec['verdict']}**"
                f"{' (' + rec['item'] + ', status ' + str(rec['status']['id']) + ')' if rec.get('item') else ''}"
                f"{' — ' + '; '.join(reasons) if reasons else ''}"
                f"{' — notes: ' + '; '.join(rec['notes']) if rec.get('notes') else ''}\n")
    if rec["verdict"] == "UNVERIFIED":
        rec["notified"] = notify_owner(f"crq PROMOTION UNVERIFIED: main advanced {last[:10]} → {main[:10]} without a "
                                       f"crq-verified promotion review. {'; '.join(reasons)[:600]} — see "
                                       f"{STATE / 'status.md'}; ack with `crq.py promotion-ack {main[:10]} \"<reason>\"`.")
        a["alerts"].append({"to": main, "at": rec["at"], "reasons": reasons, "acked": None})
        event("promotion_unverified", **{k: v for k, v in rec.items() if k != "at"})
    else:
        if rec.get("notes"):
            event("promotion_uncorroborated", to=main, notes=rec["notes"])
        event("promotion_verified" if rec["verdict"].startswith("verified") else "promotion_audit",
              **{k: v for k, v in rec.items() if k != "at"})
    return [line]


def blocking_findings(ndjson: Path) -> List[Dict[str, Any]]:
    out = []
    for line in ndjson.read_text(errors="replace").splitlines():
        try:
            e = json.loads(line)
        except ValueError:
            continue
        if e.get("type") == "finding" and e.get("severity") in BLOCKING_SEVERITIES:
            m = re.search(r" at line (\d+)", e.get("codegenInstructions") or e.get("comment") or "")
            out.append({"n": len(out) + 1, "severity": e["severity"], "file": e.get("fileName"),
                        "line": int(m.group(1)) if m else None, "resolution": None})
    return out


def harvest_promotion(item: Dict[str, Any], meta: Dict[str, Any], cls: Dict[str, Any], rdir: Path) -> str:
    log: List[str] = []
    new = blocking_findings(rdir / "review.ndjson")
    base = item["base_sha"]
    if new:
        item["blocking"] = item.get("blocking", []) + [dict(b, n=len(item.get("blocking", [])) + k + 1, run=meta["run_id"])
                                                       for k, b in enumerate(new)]
        sev = ", ".join(f"{sum(1 for b in new if b['severity'] == s)} {s}" for s in ("critical", "major")
                        if any(b["severity"] == s for b in new))
        post_promotion_status(item, item["batch_sha"], "failure", f"blocked: {sev} main={base}", log)
        item["state"] = "findings"
    elif item.get("must_reach") and item["must_reach"] != item["batch_sha"]:
        item["state"] = "chain_next"  # clean, but the fix is beyond this prefix: never promote without it
        log.append(f"prefix clean; continuing toward fix tip {item['must_reach'][:10]} before any success")
    else:
        desc = (f"delta {item['reviewed_sha'][:12]}.. main={base} crq#{item['id']}" if item.get("reviewed_sha")
                else f"reviewed main={base} crq#{item['id']}")
        post_promotion_status(item, item["batch_sha"], "success", desc[:140], log)
        item.update(state="promoting", success_at=iso())
    return "; ".join(log)


def plan_promotion(item: Dict[str, Any]) -> Dict[str, Any]:
    base = item.get("reviewed_sha") or item["base_sha"]
    if not is_ancestor(base, item["batch_sha"]):
        raise NotReady(f"{base[:10]} is not an ancestor of batch {item['batch_sha'][:10]}")
    scope = f"delta {base[:10]}..{item['batch_sha'][:10]}" if item.get("reviewed_sha") else \
        f"main {base[:10]}..{item['batch_sha'][:10]}"
    return {"base": base, "head": item["batch_sha"], "target": "origin/main", "cycle": None, "branch": None,
            "label": f"promotion review — {scope}", "notes": []}


# ----------------------------------------------------------- tick


def rank(item: Dict[str, Any]) -> int:
    """0 open PR cycles · 1 open-PR deltas (both awaiting merge) · 2 newly merged
    follow-ups (merged-tier or post-merge delta) · 3 seeded merged backlog."""
    if item["kind"] in ("open", "promotion"):
        return 0
    if item["kind"] == "delta":
        return 2 if item.get("followup") == "merged" else 1
    return 2 if item.get("source") == "followup" else 3


def sort_key(item: Dict[str, Any]) -> Tuple:
    # promotion (and its delta) takes the next start slot ahead of everything (docs/promotion-policy.md)
    return (0 if item["kind"] == "promotion" else 1, 0 if item.get("boost") else 1, rank(item), item.get("order", 999))


# ----------------------------------------------------------- enrollment


def last_reviewed(q: Dict[str, Any], pr: int) -> Optional[Dict[str, Any]]:
    """Newest completed CLI review of the PR's own head (open cycles and deltas)."""
    recs = [c for i in q["items"] if i["pr"] == pr and i["kind"] in ("open", "delta") for c in i.get("cycles", [])]
    return max(recs, key=lambda c: c["completed_at"]) if recs else None


def reviewed_head(rec: Dict[str, Any]) -> str:
    return rec.get("pr_head") or rec["head"]


def chains_to_merge_queue(p: Dict[str, Any], by_head: Dict[str, Dict[str, Any]]) -> bool:
    for _ in range(8):
        if p["baseRefName"] == "merge-queue":
            return True
        p = by_head.get(p["baseRefName"])
        if p is None:
            return False
    return False


def next_order(q: Dict[str, Any]) -> int:
    return max((i.get("order", 0) for i in q["items"]), default=0) + 1


def new_item(q: Dict[str, Any], log: List[str], dry: bool, **fields: Any) -> Dict[str, Any]:
    dup = next((i for i in q["items"] if i["id"] == fields.get("id")), None)
    if dup is not None:  # ids are unique: an existing item (even skipped) is sticky
        return dup
    item = {"order": next_order(q), "state": "pending", "cycles": [], "attempts": [], **fields}
    item["notes"] = [f"{iso()} auto-enrolled: {fields.get('why', '')}"]
    item.pop("why", None)
    q["items"].append(item)
    if not dry:
        event("enrolled", item=item["id"], reason=item["notes"][0])
    log.append(f"{'DRY-RUN would enroll' if dry else 'enrolled'} {item['id']} ({item['notes'][0].split('auto-enrolled: ', 1)[1]})")
    return item


def enroll(q: Dict[str, Any], dry: bool) -> List[str]:
    """Each tick: (1) open non-draft PRs into merge-queue (or stacked on a chain
    ending there) that are not enrolled → open item, two cycles; (2) a PR whose
    head moved past its last CLI review, with nothing in flight → one delta item
    for the new commits; (3) PRs merged into merge-queue after the seed →
    never CLI-reviewed: merged-tier item (supersession filter); reviewed at an
    older head: post-merge delta; reviewed at the merged head: recorded, skipped."""
    log: List[str] = []
    try:
        opened = gh_json(["pr", "list", "--repo", REPO, "--state", "open", "--limit", "200", "--json",
                          "number,isDraft,baseRefName,headRefName,headRefOid"])
        merged = gh_json(["pr", "list", "--repo", REPO, "--state", "merged", "--base", "merge-queue", "--limit",
                          "100", "--search", f"merged:>={q['created_at'][:10]}", "--json",
                          "number,mergedAt,mergeCommit,headRefOid"])
    except Exception as exc:
        return [f"enrollment skipped: {exc}"[:300]]
    by_head = {p["headRefName"]: p for p in opened}
    for p in sorted(opened, key=lambda x: x["number"]):
        n, head = p["number"], p["headRefOid"]
        if p["isDraft"] or not chains_to_merge_queue(p, by_head):
            continue
        mine = [i for i in q["items"] if i["pr"] == n and i["kind"] in ("open", "delta")]
        if not mine:
            stacked = "" if p["baseRefName"] == "merge-queue" else f", stacked on {p['baseRefName']}"
            new_item(q, log, dry, id=f"pr{n}", pr=n, kind="open", tier=1, prior_cycles=0,
                     why=f"open PR not yet enrolled{stacked}")
            continue
        if any(i["state"] in ("pending", "reviewing", "addressing", "blocked") for i in mine):
            continue
        last = last_reviewed(q, n)
        if last and reviewed_head(last) != head and not any(i["id"] == f"pr{n}-delta-{head[:7]}" for i in mine):
            new_item(q, log, dry, id=f"pr{n}-delta-{head[:7]}", pr=n, kind="delta", followup="open",
                     since=reviewed_head(last), why=f"head moved {reviewed_head(last)[:10]} → {head[:10]} after CLI review")
    seeded_at = parse_iso(q["created_at"])
    for p in sorted(merged, key=lambda x: x["mergedAt"]):
        n, head = p["number"], p["headRefOid"]
        if parse_iso(p["mergedAt"]) <= seeded_at or any(i["pr"] == n and i["kind"] == "merged" for i in q["items"]):
            continue
        mine = [i for i in q["items"] if i["pr"] == n and i["kind"] in ("open", "delta")]
        if any(i["id"] == f"pr{n}-delta-{head[:7]}" for i in mine):
            continue  # this merged head already has its delta (done, skipped as a pure restack, …): sticky
        if any(i["state"] in ("reviewing", "addressing") for i in mine):
            continue  # harvest first
        for i in mine:
            if i["kind"] == "open" and i["state"] == "pending":
                i["state"] = "skipped"
                i["last_error"] = "merged before its cycles ran → post-merge follow-up"
        if any(i["kind"] == "delta" and i["state"] == "pending" for i in mine):
            continue  # a pending delta now plans against the merged head
        last = last_reviewed(q, n)
        common = dict(pr=n, merge_commit=p["mergeCommit"]["oid"], merged_at=p["mergedAt"])
        if last is None:
            item = new_item(q, log, dry, id=f"pr{n}-merged", kind="merged", source="followup",
                            why="merged after the seed without a CLI review → merged-tier", **common)
            apply_measure(item)
        elif reviewed_head(last) == head:
            new_item(q, log, dry, id=f"pr{n}-merged", kind="merged", source="followup", state="skipped",
                     last_error=f"merged head {head[:10]} already CLI-reviewed ({last['run_id']})",
                     why="merged after the seed; merged head already reviewed", **common)
        else:
            new_item(q, log, dry, id=f"pr{n}-delta-{head[:7]}", kind="delta", followup="merged",
                     since=reviewed_head(last), why=f"merged with commits after its last CLI review "
                     f"({reviewed_head(last)[:10]} → {head[:10]}) → post-merge delta", **common)
    return log


def deps_met(q: Dict[str, Any], item: Dict[str, Any]) -> bool:
    dep = item.get("depends_on")
    if not dep:
        return True
    d = next((i for i in q["items"] if i["id"] == dep), None)
    return d is None or d["state"] in ("done", "skipped")


def tick(dry: bool = False, only: Optional[str] = None, ignore_quiet: bool = False) -> List[str]:
    log: List[str] = []
    q = load_queue()
    fetch()
    for item in q["items"]:
        if item["kind"] == "promotion" and item["state"] in SIGNER_STATES:
            msg = harvest_signer(q, item, dry)
            if msg:
                log.append(msg)
        elif item["state"] == "reviewing":
            msg = harvest_review(q, item, dry)
            if msg:
                log.append(msg)
        elif item["state"] == "addressing":
            msg = harvest_addressing(item, dry)
            if msg:
                log.append(msg)
    prev = parse_iso(q.get("last_tick"))
    stale_min = CONFIG.get("stale_alarm_min", 36)
    if prev and not dry and (now() - prev).total_seconds() / 60 > stale_min:
        gap = (now() - prev).total_seconds() / 60
        event("tick_gap", last_tick=q["last_tick"], gap_min=round(gap))
        log.append(f"tick gap: previous tick was {gap:.0f}m ago (> {stale_min}m) — chancellor alerted")
        notify_owner(f"crq RECOVERED after an outage: the previous completed tick was {q['last_tick']} ({gap:.0f}m ago, "
                     f"> {stale_min}m). Schedule runs may have reported 'succeeded' meanwhile. See {STATE / 'status.md'}.")
    q["last_tick"] = iso()
    if PROMO.get("enabled") and promotion_mode() == "signer":
        apply_signer_backoff(q, log)
    log += enroll(q, dry)
    try:
        log += promotion_audit(q, dry)
    except Exception as exc:  # retried next tick: last_main only advances after a completed audit
        log.append(f"promotion audit: error {exc}"[:300])
        if not dry:
            event("promotion_audit_error", error=str(exc)[:300])
    try:
        log += promotion_tick(q, dry)
    except Exception as exc:  # never let promotion bookkeeping stop the queue
        log.append(f"promotion: error {exc}"[:300])
    started = None
    if q.get("paused"):
        log.append(f"queue paused: {q.get('pause_reason')}")
    elif q.get("cooldown_until") and parse_iso(q["cooldown_until"]) > now():
        log.append(f"rate-limit cooldown until {q['cooldown_until']}")
    elif starts_last_hour(q) >= CONFIG["max_starts_per_hour"]:
        log.append(f"hourly cap reached ({CONFIG['max_starts_per_hour']} starts in the last 60m)")
    elif len(inflight(q)) >= CONFIG["max_inflight"]:
        log.append(f"{len(inflight(q))} review(s) in flight (max {CONFIG['max_inflight']})")
    else:
        for item in sorted(q["items"], key=sort_key):
            if only and item["id"] != only:
                continue
            if item["state"] != "pending":
                continue
            if item.get("not_before") and parse_iso(item["not_before"]) > now():
                item["wait_reason"] = f"backoff until {item['not_before']}"
                continue
            if not deps_met(q, item):
                item["wait_reason"] = f"waiting for {item['depends_on']}"
                continue
            try:
                if item["kind"] == "promotion" and promotion_mode() != "user":
                    if promotion_mode() != "signer":
                        raise NotReady("reviewer identity not pinned (signer_unconfigured)")
                    if item["base_sha"] != main_sha():
                        raise NotReady("main moved since the cut; re-cut pending")
                    if dry:
                        log.append(f"DRY-RUN would request signer review {item['id']} "
                                   f"main={item['base_sha'][:10]}..{item['batch_sha'][:10]}")
                    else:
                        request_promotion_review(q, item, log)
                    break
                if item["kind"] == "promotion":
                    plan = plan_promotion(item)
                elif item["kind"] == "merged":
                    plan = plan_merged(item, dry)
                else:
                    info = pr_info(item["pr"])
                    post_merge = item["kind"] == "delta" and info["state"] == "MERGED"
                    if info["state"] != "OPEN" and not post_merge:
                        if not dry:
                            item["state"] = "skipped"
                            item["last_error"] = f"PR {info['state'].lower()} before review"
                        log.append(f"{item['id']}: PR {info['state']} → skipped")
                        continue
                    # merged heads are immutable and get no addressing agent: no busy/quiet gate
                    qr = None if ignore_quiet or post_merge else quiet_reason(item, info)
                    if qr:
                        item["wait_reason"] = qr
                        continue
                    plan = (plan_open if item["kind"] == "open" else plan_delta)(item, info, dry)
            except NotReady as exc:
                item["wait_reason"] = str(exc)
                continue
            except NothingToReview as exc:
                if not dry:
                    item["state"] = "skipped"
                    item["last_error"] = f"nothing to review: {exc}"
                    event("skipped", item=item["id"], reason=item["last_error"])
                log.append(f"{item['id']}: nothing to review ({exc}) → skipped")
                continue
            except Exception as exc:
                item["wait_reason"] = f"planning error: {exc}"[:300]
                log.append(f"{item['id']}: planning error {exc}"[:300])
                continue
            for n in plan["notes"]:
                log.append(f"{item['id']}: {n}")
                if not dry:
                    item.setdefault("notes", []).append(f"{iso()} {n}")
            if dry:
                log.append(f"DRY-RUN would start {item['id']} [{plan['label']}] base {plan['base'][:12]} "
                           f"head {plan['head'][:12]} target {plan['target']}")
            else:
                started = launch(q, item, plan)
                log.append(f"started {item['id']} [{plan['label']}] run {started}")
                if item["kind"] == "promotion" and item["state"] == "reviewing":
                    post_promotion_status(item, item["batch_sha"], "pending",
                                          f"reviewing main={item['base_sha']} crq#{item['id']}"[:140], log)
            break
        else:
            log.append("no eligible item this tick")
        if dry:
            log += [f"  waiting {i['id']}: {i['wait_reason']}" for i in sorted(q["items"], key=sort_key)
                    if i["state"] == "pending" and i.get("wait_reason")]
    if not dry:
        save_queue(q)  # before the slow Paseo calls: a killed tick must not lose a launch
        write_status(q)
        write_heartbeat(q)
        cleanup_tick_agents(q)  # time-boxed, saves incrementally
        save_queue(q)
    return log


def cleanup_tick_agents(q: Dict[str, Any], budget_s: Optional[float] = None) -> None:
    """Archive finished tick agents (+ their workspaces) except the last few,
    each ONCE, within a hard time budget; progress is saved after every
    archive, the rest waits for the next tick. Runs AFTER status.md is
    written, so a slow cleanup can never hide a successful tick.
    History: re-archiving every past run (~3 s per paseo call) once pushed ticks
    past the tick agent's 120 s limit (2026-10-04); on 2026-10-07 a backlog of
    101 failed runs, plus a 500-entry cap that forgot the oldest runs, made each
    tick ~330 s, so no tick ever persisted its progress (a self-feeding wedge)."""
    sid = CONFIG.get("schedule_id")
    if not sid:
        return
    deadline = time.monotonic() + (budget_s if budget_s is not None else CONFIG.get("cleanup_budget_s", 30))
    try:
        runs = paseo_json(["schedule", "inspect", sid]).get("runs") or []
    except Exception:
        return
    done = [r for r in runs if r.get("agentId") and r.get("status") != "running"]
    keep = CONFIG["keep_tick_agents"]
    archived = set(q.get("archived_tick_runs") or [])
    ids = [r["id"] for r in runs]
    if archived:  # archiving is oldest-first: every run older than the oldest recorded one is done
        first = min((ids.index(x) for x in archived if x in ids), default=0)
        archived.update(ids[:first])
    elif "archived_tick_runs" not in q:  # first run ever: earlier ticks archived all but the newest few
        archived = {r["id"] for r in done[:-(keep + 1)]}
    todo = [r for r in (done[:-keep] if len(done) > keep else []) if r["id"] not in archived]
    for n, r in enumerate(todo):
        if time.monotonic() >= deadline:
            q["cleanup_backlog"] = len(todo) - n
            break
        run(["paseo", "archive", r["agentId"]], check=False, timeout=30)
        if r.get("workspaceId"):
            run(["paseo", "workspace", "archive", r["workspaceId"]], check=False, timeout=30)
        archived.add(r["id"])
        q["archived_tick_runs"] = [x for x in ids if x in archived]  # bounded by the schedule's own run list
        save_queue(q)
    else:
        q["cleanup_backlog"] = 0
    q["archived_tick_runs"] = [x for x in ids if x in archived]


# ----------------------------------------------------------- status


def write_status(q: Dict[str, Any]) -> None:
    items = sorted(q["items"], key=sort_key)
    owed_open = sum(max(0, 2 - i.get("prior_cycles", 0) - len(i.get("cycles", []))) for i in items
                    if i["kind"] == "open" and i["state"] not in ("skipped",))
    rows = []
    for i in items:
        if i["kind"] == "open":
            cyc = f"{i.get('prior_cycles', 0) + len(i.get('cycles', []))}/2"
        elif i["kind"] == "promotion":
            cyc = f"{len(i.get('cycles', []))}/1"
            unresolved = sum(1 for b in i.get("blocking", []) if not b.get("resolution"))
            i_extra = (f"{(i.get('reviewed_sha') or i['base_sha'])[:10]}..{i['batch_sha'][:10]} ({i.get('merges', '?')} merges) "
                       f"main={i['base_sha'][:10]}"
                       f"{f'; {unresolved} blocking unresolved' if unresolved else ''}")
        else:
            cyc = f"{len(i.get('cycles', []))}/1"
        extra = i_extra if i["kind"] == "promotion" else ""
        if i["kind"] == "merged" and i.get("measure"):
            m = i["measure"]
            extra = f"survival {m['survival']} ({m['surviving']}/{m['added']}), focus {m['focus']}"
        last = (i.get("attempts") or [{}])[-1]
        why = i.get("wait_reason") if i["state"] == "pending" else (i.get("last_error") or "")
        kind = (f"{i['kind']}{' t' + str(i['tier']) if i.get('tier') else ''}"
                f"{' new' if i.get('source') == 'followup' else ''}{' post-merge' if i.get('followup') == 'merged' else ''}")
        rows.append(f"| {i['id']} | {kind} | {i['state']} | {cyc} "
                    f"| {(i.get('pinned_base') or '')[:10]} | {last.get('outcome', '')} | {(why or '')[:110]} | {extra} |")
    sched = CONFIG.get("schedule_id")
    next_run = ""
    if sched:
        try:
            s = paseo_json(["schedule", "inspect", sched])
            next_run = f"{s.get('status')} · next run {s.get('nextRunAt')} · last run {s.get('lastRunAt')}"
        except Exception as exc:
            next_run = f"(schedule inspect failed: {exc})"[:200]
    recent = EVENTS.read_text().splitlines()[-15:] if EVENTS.exists() else []
    alerts = [x for x in (q.get("promotion_audit") or {}).get("alerts", []) if not x.get("acked")]
    banner = [f"> **ALERT — PROMOTION UNVERIFIED:** main → `{x['to'][:12]}` at {x['at']}: {'; '.join(x['reasons'])[:300]}. "
              f"Ack: `crq.py promotion-ack {x['to'][:10]} \"<reason>\"`" for x in alerts]
    st_p = q.get("promotion") or {}
    for x in st_p.get("escalations", []):
        if not x.get("acked"):
            banner.append(f"> **ALERT — PROMOTION NEEDS OWNER OVERRIDE:** CodeRabbit {x['outcome']} the single-merge batch "
                          f"`{x['sha'][:12]}` (main=`{x['base'][:12]}`, {x['item']}). Owner: override per "
                          f"docs/promotion-policy.md, then `crq.py promotion-ack {x['sha'][:10]} \"<reason>\"`")
    for x in st_p.get("signer_alerts", []):
        if not x.get("acked"):
            banner.append(f"> **ALERT — PROMOTION SIGNER** ({x['at']}): {x['text']}. Ack: "
                          f"`crq.py promotion-ack {x['sha'][:10]} \"<reason>\"`")
    for i in items:
        if i["kind"] == "promotion" and i["state"] == "findings":
            open_b = [b for b in i.get("blocking", []) if not b.get("resolution")]
            if open_b:
                banner.append(f"> **PROMOTION BLOCKED ({i['id']}, batch `{i['batch_sha'][:12]}`):** {len(open_b)} unresolved "
                              + ", ".join(f"#{b['n']} {b['severity']} {b['file']}:{b.get('line')}" for b in open_b)[:300]
                              + f". {PROMO.get('resolver', 'conductor')}: fix in merge-queue, then "
                              f"`crq.py promotion-resolve <n|all> \"fixed in PR #N\"`")
    attempts = [f"{a['item']} ({a['merges']} merges: {a['why']})" for a in st_p.get("attempts", [])[-6:]]
    md = [f"# CodeRabbit review queue — status ({iso()})", "", *banner, *([""] if banner else []),
          f"- queue: {'**PAUSED** — ' + str(q.get('pause_reason')) if q.get('paused') else 'active'}",
          f"- schedule: `{sched}` {next_run}",
          f"- rate-limit cooldown until: {q.get('cooldown_until') or '—'}",
          f"- starts in last 60m: {starts_last_hour(q)}/{CONFIG['max_starts_per_hour']}; in flight: "
          f"{', '.join(i['id'] + ' (' + ((i.get('run') or {}).get('run_id') or 'signer ' + i['state']) + ')' for i in inflight(q)) or 'none'}",
          f"- addressing: {', '.join(i['id'] + ' agent ' + i['addressing']['agent_id'][:8] for i in items if i['state'] == 'addressing') or 'none'}",
          f"- open-PR CLI reviews still owed: {owed_open}",
          f"- promotion: {'enabled' if PROMO.get('enabled') else 'DISABLED'} · mode {promotion_mode()}"
          f"{'' if PROMO.get('post_status') else ' (statuses not posted)'}; last promoted "
          f"{(q.get('promotion') or {}).get('last_promoted_sha', '—')} at {(q.get('promotion') or {}).get('last_promoted_at', '—')}"
          f"{'; splitting toward ' + st_p['continue_to'][:10] + ' at ≤' + str(st_p.get('batch_cap')) + ' merges' if st_p.get('continue_to') else ''}",
          f"- promotion attempts (newest last): {' → '.join(attempts) or '—'}",
          f"- last tick: {q.get('last_tick')}", "",
          "| item | kind | state | cycles | pinned base | last outcome | wait / last error | supersession |",
          "|---|---|---|---|---|---|---|---|", *rows, "", "## Recent events", "", "```", *recent, "```", ""]
    (STATE / "status.md").write_text("\n".join(md))
    (STATE / "status.json").write_text(json.dumps({"generated_at": iso(), "paused": q.get("paused"),
                                                   "cooldown_until": q.get("cooldown_until"),
                                                   "items": [{k: i.get(k) for k in ("id", "kind", "state",
                                                              "prior_cycles", "cycles", "pinned_base", "last_error",
                                                              "wait_reason")} for i in items]}, indent=2) + "\n")


# ----------------------------------------------------------- init / admin


def cmd_init(force: bool) -> None:
    if QUEUE.exists() and not force:
        sys.exit("queue already initialised (use --force to rebuild; this discards state)")
    for d in (STATE, RUNS, LEDGER):
        d.mkdir(parents=True, exist_ok=True)
    fetch()
    git("fetch", "--quiet", "origin", "+refs/pull/*/head:refs/remotes/pr/*")
    seed = json.loads((ROOT / "seed.json").read_text())
    items: List[Dict[str, Any]] = []
    for n, s in enumerate(seed["open"]):
        items.append({"id": f"pr{s['pr']}", "pr": s["pr"], "kind": "open", "tier": s["tier"], "order": n,
                      "prior_cycles": s.get("prior_cycles", 0), "prior_base": s.get("prior_base"),
                      "depends_on": s.get("depends_on"), "notes": [s["note"]] if s.get("note") else [],
                      "state": "pending", "cycles": [], "attempts": []})
    for n, s in enumerate(seed["delta"]):
        items.append({"id": f"pr{s['pr']}-delta", "pr": s["pr"], "kind": "delta", "order": n,
                      "since": s.get("since"), "notes": [s["note"]], "state": "pending", "cycles": [], "attempts": []})
    for n, s in enumerate(seed["merged"]):
        info = pr_info(s["pr"])
        item = {"id": f"pr{s['pr']}-merged", "pr": s["pr"], "kind": "merged", "tier": s["tier"], "order": n,
                "owed_per_audit": s["owed_per_audit"], "merge_commit": info["mergeCommit"]["oid"],
                "merged_at": info["mergedAt"], "state": "pending", "cycles": [], "attempts": [], "notes": []}
        items.append(item)
    q = {"created_at": iso(), "items": items, "starts": [], "paused": False}
    save_queue(q)
    cmd_measure()
    print(f"initialised {len(items)} items")


def apply_measure(i: Dict[str, Any]) -> None:
    """Supersession filter for a merged item (pending ↔ skipped while unreviewed)."""
    i["measure"] = measure_merged(i)
    m = i["measure"]
    ok = ((m["survival"] or 0) >= CONFIG["merged_min_survival"]
          and m["covered_surviving"] >= CONFIG["merged_min_surviving_lines"])
    if i["state"] in ("pending", "skipped") and not i.get("cycles"):
        i["state"] = "pending" if ok else "skipped"
        i["last_error"] = None if ok else (
            f"superseded/too small: survival {m['survival']} ({m['surviving']}/{m['added']} added lines still "
            f"blamed to the PR); only {m['covered_surviving']} sit in paths where the PR is ≥"
            f"{CONFIG.get('merged_min_file_focus', 0.25)} of later churn")


def cmd_measure() -> None:
    q = load_queue()
    fetch()
    merged = [i for i in q["items"] if i["kind"] == "merged"]
    for i in merged:
        if i.get("source") == "followup" and i["state"] == "skipped" and not i.get("measure"):
            continue  # merged head already reviewed; not a supersession decision
        apply_measure(i)
    # rank: code before docs-only, then most surviving non-doc lines first
    ranked = sorted(merged, key=lambda i: (i["measure"]["docs_only"], -i["measure"]["surviving_nondoc"],
                                           -i["measure"]["surviving"]))
    for n, i in enumerate(ranked):
        i["order"] = n
    save_queue(q)
    write_status(q)
    print(f"{'PR':>5} {'added':>6} {'surv':>6} {'ratio':>6} {'filefoc':>7} {'paths':>5} {'excl':>4} {'synth+':>7} {'covered':>7} {'focus':>6} docs state")
    for i in ranked:
        m = i["measure"]
        print(f"{i['pr']:>5} {m['added']:>6} {m['surviving']:>6} {str(m['survival']):>6} {str(m['file_level_focus']):>7} "
              f"{len(m['synthetic_paths']):>5} {len(m['excluded_paths']):>4} {m['synthetic_added']:>7} {m['covered_surviving']:>7} "
              f"{str(m['focus']):>6} {str(m['docs_only'])[0]}    {i['state']}")


WATCHDOG_HOME = Path.home() / "Library" / "Application Support" / "crq"


def write_heartbeat(q: Dict[str, Any]) -> None:
    """For the agent-free launchd watchdog (ops/crq-watchdog.py), which may only
    read files under ~ (TCC blocks launchd python from the external volume)."""
    try:
        WATCHDOG_HOME.mkdir(parents=True, exist_ok=True)
        tmp = WATCHDOG_HOME / ".heartbeat.json.tmp"
        tmp.write_text(json.dumps({"last_tick": q["last_tick"], "stale_alarm_min": CONFIG.get("stale_alarm_min", 36),
                                   "schedule_id": CONFIG.get("schedule_id"), "root": str(ROOT),
                                   "alert_agent_id": PROMO.get("alert_agent_id")}) + "\n")
        tmp.replace(WATCHDOG_HOME / "heartbeat.json")
    except OSError as exc:
        event("heartbeat_failed", error=str(exc)[:200])


def cmd_selfcheck() -> int:
    """Negative check: the third-party App identity wrongly pinned on 2026-10-04 must
    never reappear in config, and an unset identity must keep signer mode off."""
    raw = (ROOT / "config.json").read_text()
    bad = [str(x) for x in BANNED_BOT_IDS if str(x) in raw] + [x for x in BANNED_BOT_LOGINS if x in raw]
    ident, mode = reviewer_identity(), promotion_mode()
    print(f"reviewer identity: {ident or 'UNPINNED (fail closed)'}; main gate mode: {mode}"
          f"{' (' + _MODE_WHY.get('origin/main', '') + ')' if mode == 'signer_unconfigured' else ''}")
    if bad:
        print(f"FAIL: config.json contains banned third-party identity {bad}")
        return 1
    if ident is None and mode == "signer":
        print("FAIL: signer mode with an unpinned identity")
        return 1
    print("ok")
    return 0


def with_lock(fn, *a, **kw):
    STATE.mkdir(parents=True, exist_ok=True)
    fh = LOCK.open("w")
    try:
        fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print("another crq tick holds the lock; exiting")
        return None
    try:
        return fn(*a, **kw)
    finally:
        fcntl.flock(fh, fcntl.LOCK_UN)


def admin(action: str, item_id: Optional[str], reason: Optional[str]) -> None:
    q = load_queue()
    if action in ("pause", "resume"):
        q["paused"] = action == "pause"
        q["pause_reason"] = reason if action == "pause" else None
    elif action == "promotion-ack":
        sha, _, why = (reason or "").partition(" ")
        hit = [x for x in (q.get("promotion_audit") or {}).get("alerts", []) + (q.get("promotion") or {}).get("escalations", [])
               + (q.get("promotion") or {}).get("signer_alerts", [])
               if not x.get("acked") and (sha == "all" or x.get("to", x.get("sha", "")).startswith(sha))]
        if not hit or not why.strip():
            sys.exit('usage: crq.py promotion-ack <main-sha-prefix|all> "<reason>" (no matching open alert?)')
        for x in hit:
            x["acked"] = f"{iso()} {why.strip()}"
    elif action == "promote":
        q.setdefault("promotion", {})["requested"] = True  # cut on the next tick (on demand)
    elif action == "promotion-resolve":
        item = open_promotion(q)
        if not item or item["state"] != "findings":
            sys.exit("no promotion is waiting on findings")
        which, _, how = (reason or "").partition(" ")
        if not how.strip():
            sys.exit('usage: crq.py promotion-resolve <finding-n|all> "<disposition: fixed in PR #N / rebuttal>"')
        hit = [b for b in item["blocking"] if which == "all" or str(b["n"]) == which]
        if not hit:
            sys.exit(f"no blocking finding {which}")
        for b in hit:
            b["resolution"] = f"{iso()} {how.strip()}"
        item_id = item["id"]
    else:
        item = next((i for i in q["items"] if i["id"] == item_id), None)
        if not item:
            sys.exit(f"no item {item_id}")
        if action == "requeue":
            item.update(state="pending", not_before=None, failures=0, last_error=None)
        elif action == "skip":
            item.update(state="skipped", last_error=reason or "skipped by owner")
        elif action == "block":
            item.update(state="blocked", last_error=reason or "blocked by owner")
    event(f"admin_{action}", item=item_id, reason=reason)
    save_queue(q)
    write_status(q)
    print(f"{action} ok")


def main() -> int:
    ap = argparse.ArgumentParser(prog="crq")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("init")
    p.add_argument("--force", action="store_true")
    sub.add_parser("measure")
    p = sub.add_parser("tick")
    p.add_argument("--dry-run", action="store_true")
    p = sub.add_parser("start", help="tick restricted to one item (still honours cap/cooldown/secret scan)")
    p.add_argument("item")
    p.add_argument("--ignore-quiet", action="store_true", help="skip the quiet-window gate (active agents still block)")
    p.add_argument("--dry-run", action="store_true")
    sub.add_parser("status")
    p = sub.add_parser("synth")
    p.add_argument("pr", type=int)
    for a in ("pause", "resume", "promote"):
        p = sub.add_parser(a)
        p.add_argument("reason", nargs="?")
    p = sub.add_parser("promotion-ack", help="acknowledge an unverified-promotion alert")
    p.add_argument("sha")
    p.add_argument("reason")
    p = sub.add_parser("promotion-resolve", help='mark blocking finding(s) of the open promotion addressed')
    p.add_argument("finding", help="finding number, or all")
    p.add_argument("disposition")
    for a in ("requeue", "skip", "block"):
        p = sub.add_parser(a)
        p.add_argument("item")
        p.add_argument("reason", nargs="?")
    sub.add_parser("selfcheck", help="assert config carries no banned/third-party reviewer identity")
    p = sub.add_parser("_review")
    p.add_argument("run_id")
    args = ap.parse_args()

    if args.cmd == "_review":
        return cmd_review_child(args.run_id)
    if args.cmd == "selfcheck":
        return cmd_selfcheck()
    if args.cmd == "init":
        with_lock(cmd_init, args.force)
    elif args.cmd == "measure":
        with_lock(cmd_measure)
    elif args.cmd in ("tick", "start"):
        only = getattr(args, "item", None)
        out = with_lock(tick, args.dry_run, only, getattr(args, "ignore_quiet", False))
        for line in out or []:
            print(line)
        if not args.dry_run:
            print(f"status: {STATE / 'status.md'}")
    elif args.cmd == "status":
        q = load_queue()
        write_status(q)
        print((STATE / "status.md").read_text())
    elif args.cmd == "synth":
        q = load_queue()
        fetch()
        item = next(i for i in q["items"] if i["kind"] == "merged" and i["pr"] == args.pr)
        base, head, n = build_synthetic(item)
        print(f"PR #{args.pr}: {n} paths; base {base} head {head}")
        print(git("diff", "--shortstat", base, head))
    elif args.cmd == "promotion-ack":
        with_lock(admin, args.cmd, None, f"{args.sha} {args.reason}")
    elif args.cmd == "promotion-resolve":
        with_lock(admin, args.cmd, None, f"{args.finding} {args.disposition}")
    else:
        with_lock(admin, args.cmd, getattr(args, "item", None), getattr(args, "reason", None))
    return 0


if __name__ == "__main__":
    signal.signal(signal.SIGPIPE, signal.SIG_DFL)
    sys.exit(main())
