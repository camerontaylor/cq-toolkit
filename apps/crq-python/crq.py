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
import json
import os
import re
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
        if "rate" in et or "limit" in et or "quota" in et or "rate limit" in msg.lower():
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


def plan_delta(item: Dict[str, Any], info: Dict[str, Any], dry: bool) -> Dict[str, Any]:
    if info["state"] != "OPEN":
        raise NotReady(f"PR is {info['state']}")
    head = info["headRefOid"]
    target = f"origin/{info['baseRefName']}"
    base = git("merge-base", target, head)
    scope = "full PR diff (old cycle head not an ancestor)"
    since = item.get("since")
    if since:
        r = run(["git", "rev-parse", "--verify", "--quiet", f"{since}^{{commit}}"], cwd=CLONE, check=False)
        if r.returncode == 0 and is_ancestor(r.stdout.strip(), head) and r.stdout.strip() != head:
            base = r.stdout.strip()
            scope = f"delta since last CLI-reviewed head {since}"
    return {"base": base, "head": head, "target": target, "label": f"informational post-cycle review — {scope}",
            "cycle": None, "notes": [], "branch": info["headRefName"]}


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
    return [i for i in q["items"] if i["state"] == "reviewing"]


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
            "target": plan["target"], "pr_branch": plan["branch"], "worktree": str(wt), "wt_branch": wbranch,
            "dirty_diff": "clean tree", "started_at": iso(),
            "cmd": ["coderabbit", "review", "--agent", "--base-commit", plan["base"]]}
    (rdir / "meta.json").write_text(json.dumps(meta, indent=2) + "\n")
    log = (rdir / "runner.log").open("w")
    proc = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "_review", run_id],
                            stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
                            start_new_session=True, close_fds=True, cwd=str(ROOT))
    item["state"] = "reviewing"
    item["run"] = {"run_id": run_id, "pid": proc.pid, "started_at": meta["started_at"]}
    item["wait_reason"] = None
    q.setdefault("starts", []).append(meta["started_at"])
    event("review_started", item=item["id"], run=run_id, base=plan["base"], head=plan["head"], label=plan["label"])
    return run_id


def cmd_review_child(run_id: str) -> int:
    """Detached child: run the CLI once, record exit status. Never retries."""
    rdir = RUNS / run_id
    meta = json.loads((rdir / "meta.json").read_text())
    tmo = CONFIG["review_timeout_min"]
    cmd = ["gtimeout", "--kill-after=60", f"{tmo}m", *meta["cmd"]]
    with (rdir / "review.ndjson").open("w") as out, (rdir / "stderr.log").open("w") as err:
        rc = subprocess.call(cmd, cwd=meta["worktree"], stdout=out, stderr=err, stdin=subprocess.DEVNULL)
    (rdir / "exit.json").write_text(json.dumps({"exit": rc, "ended_at": iso(), "timed_out": rc == 124}) + "\n")
    return 0


# ----------------------------------------------------------- harvesting


def harvest_review(q: Dict[str, Any], item: Dict[str, Any], dry: bool) -> Optional[str]:
    r = item["run"]
    rdir = RUNS / r["run_id"]
    exitf = rdir / "exit.json"
    if not exitf.exists():
        if pid_alive(r.get("pid")):
            return None
        exit_code = None
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
    if o == "skipped" or item["failures"] >= CONFIG["max_item_failures"]:
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
            check=False, timeout=180)
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


# ----------------------------------------------------------- tick


def sort_key(item: Dict[str, Any]) -> Tuple:
    kind_rank = {"open": 0, "delta": 1, "merged": 2}[item["kind"]]
    return (0 if item.get("boost") else 1, kind_rank, item.get("order", 999))


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
        if item["state"] == "reviewing":
            msg = harvest_review(q, item, dry)
            if msg:
                log.append(msg)
        elif item["state"] == "addressing":
            msg = harvest_addressing(item, dry)
            if msg:
                log.append(msg)
    q["last_tick"] = iso()
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
                if item["kind"] == "merged":
                    plan = plan_merged(item, dry)
                else:
                    info = pr_info(item["pr"])
                    if info["state"] != "OPEN":
                        if not dry:
                            item["state"] = "skipped"
                            item["last_error"] = f"PR {info['state'].lower()} before review"
                        log.append(f"{item['id']}: PR {info['state']} → skipped")
                        continue
                    qr = None if ignore_quiet else quiet_reason(item, info)
                    if qr:
                        item["wait_reason"] = qr
                        continue
                    plan = (plan_open if item["kind"] == "open" else plan_delta)(item, info, dry)
            except NotReady as exc:
                item["wait_reason"] = str(exc)
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
            break
        else:
            log.append("no eligible item this tick")
        if dry:
            log += [f"  waiting {i['id']}: {i['wait_reason']}" for i in sorted(q["items"], key=sort_key)
                    if i["state"] == "pending" and i.get("wait_reason")]
    if not dry:
        save_queue(q)
        write_status(q)
        cleanup_tick_agents()
    return log


def cleanup_tick_agents() -> None:
    sid = CONFIG.get("schedule_id")
    if not sid:
        return
    try:
        runs = paseo_json(["schedule", "inspect", sid]).get("runs") or []
    except Exception:
        return
    done = [r for r in runs if r.get("agentId") and r.get("status") != "running"]
    keep = CONFIG["keep_tick_agents"]
    for r in done[:-keep] if len(done) > keep else []:
        run(["paseo", "archive", r["agentId"]], check=False, timeout=60)
        if r.get("workspaceId"):
            run(["paseo", "workspace", "archive", r["workspaceId"]], check=False, timeout=60)


# ----------------------------------------------------------- status


def write_status(q: Dict[str, Any]) -> None:
    items = sorted(q["items"], key=sort_key)
    owed_open = sum(max(0, 2 - i.get("prior_cycles", 0) - len(i.get("cycles", []))) for i in items
                    if i["kind"] == "open" and i["state"] not in ("skipped",))
    rows = []
    for i in items:
        if i["kind"] == "open":
            cyc = f"{i.get('prior_cycles', 0) + len(i.get('cycles', []))}/2"
        else:
            cyc = f"{len(i.get('cycles', []))}/1"
        extra = ""
        if i["kind"] == "merged" and i.get("measure"):
            m = i["measure"]
            extra = f"survival {m['survival']} ({m['surviving']}/{m['added']}), focus {m['focus']}"
        last = (i.get("attempts") or [{}])[-1]
        why = i.get("wait_reason") if i["state"] == "pending" else (i.get("last_error") or "")
        rows.append(f"| {i['id']} | {i['kind']}{' t' + str(i['tier']) if i.get('tier') else ''} | {i['state']} | {cyc} "
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
    md = [f"# CodeRabbit review queue — status ({iso()})", "",
          f"- queue: {'**PAUSED** — ' + str(q.get('pause_reason')) if q.get('paused') else 'active'}",
          f"- schedule: `{sched}` {next_run}",
          f"- rate-limit cooldown until: {q.get('cooldown_until') or '—'}",
          f"- starts in last 60m: {starts_last_hour(q)}/{CONFIG['max_starts_per_hour']}; in flight: "
          f"{', '.join(i['id'] + ' (' + i['run']['run_id'] + ')' for i in inflight(q)) or 'none'}",
          f"- addressing: {', '.join(i['id'] + ' agent ' + i['addressing']['agent_id'][:8] for i in items if i['state'] == 'addressing') or 'none'}",
          f"- open-PR CLI reviews still owed: {owed_open}",
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


def cmd_measure() -> None:
    q = load_queue()
    fetch()
    merged = [i for i in q["items"] if i["kind"] == "merged"]
    for i in merged:
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
    for a in ("pause", "resume"):
        p = sub.add_parser(a)
        p.add_argument("reason", nargs="?")
    for a in ("requeue", "skip", "block"):
        p = sub.add_parser(a)
        p.add_argument("item")
        p.add_argument("reason", nargs="?")
    p = sub.add_parser("_review")
    p.add_argument("run_id")
    args = ap.parse_args()

    if args.cmd == "_review":
        return cmd_review_child(args.run_id)
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
    else:
        with_lock(admin, args.cmd, getattr(args, "item", None), getattr(args, "reason", None))
    return 0


if __name__ == "__main__":
    signal.signal(signal.SIGPIPE, signal.SIG_DFL)
    sys.exit(main())
