#!/usr/bin/env python3
"""Single quota owner: model-free ticks, detached reviews and bounded repair jobs.

Each unreviewed range is reviewed once; terminal success alone earns a cycle.
The tick alone persists the queue and publishes verified repairs. Repair workers
never own GitHub or queue mutation. See README.md and ops/CUTOVER.md.
"""
from __future__ import annotations

import argparse
import contextlib
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
from runtime_target import DEFAULT_REF, DISCOVERY_BRANCHES, DISCOVERY_SELECTOR
import status_summary
import repair_tick
import coverage
import author_quota
import queue_transport
import author_lease
import review_receipt
import deferred_refresh
import merged_reconcile
import usage_slots
import backfill_runtime
import backfill_jobs
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

# Session-log preservation (plan items 2.1/2.5, 2026-10-24): the task log.
# One append-only JSONL in cq's shared vocabulary — one `work-started` line
# per review/repair job, so telemetry-ingest can tag every session this run
# produced with `cq.work:*`. Best-effort BY CONTRACT: a work-record write
# failure is logged and swallowed; the work's verdict outranks the record
# (feature R5). Path overridable for tests via CQ_WORK_RECORDS.
WORK_RECORDS = Path(os.environ.get("CQ_WORK_RECORDS", "") or
                    (STATE / "work.jsonl"))


def append_work_record(record: Dict[str, Any]) -> None:
    """Best-effort append of one work-record line (never fails the work)."""
    try:
        WORK_RECORDS.parent.mkdir(parents=True, exist_ok=True)
        with WORK_RECORDS.open("a") as f:
            f.write(json.dumps(record) + "\n")
    except OSError as exc:  # a full disk must not fail a review
        try:
            event("work_record_failed", error=str(exc)[:200])
        except OSError:
            pass  # same disk; the record stays best-effort


CLONE = Path(CONFIG["clone"])
WT_ROOT = Path(CONFIG["worktree_root"])
WT_PREFIX = CONFIG["worktree_prefix"]
REPO = CONFIG["repo"]
BLOCKING_SEVERITIES = {"critical", "major"}
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


_FORGE_BUDGET = None


class ForgeBudget:
    """One aggregate request/deadline allowance for locked recovery reads."""
    def __init__(self, requests=24, seconds=30, clock=None):
        self.clock = clock or time.monotonic
        self.deadline = self.clock() + seconds
        self.remaining = requests

    def available(self):
        return self.remaining > 0 and self.clock() < self.deadline

    def take(self):
        if not self.available():
            raise deferred_refresh.RefreshExhausted("aggregate forge budget exhausted; debt retained")
        self.remaining -= 1
        return max(0.001, min(10, self.deadline - self.clock()))


@contextlib.contextmanager
def forge_window(budget):
    global _FORGE_BUDGET
    previous = _FORGE_BUDGET
    _FORGE_BUDGET = budget
    try:
        yield
    finally:
        _FORGE_BUDGET = previous


def gh_json(args: List[str]) -> Any:
    timeout = _FORGE_BUDGET.take() if _FORGE_BUDGET is not None else 120
    return json.loads(run(["gh", *args], cwd=CLONE, timeout=timeout).stdout)


def paseo_json(args: List[str]) -> Any:
    p = run(["paseo", *args, "--json"], check=False, timeout=120)
    if p.returncode != 0:
        raise RuntimeError(f"paseo {' '.join(args)} failed: {p.stderr.strip()[:300]}")
    return json.loads(p.stdout)


def event(kind: str, **data: Any) -> None:
    STATE.mkdir(parents=True, exist_ok=True)
    with EVENTS.open("a") as f:
        f.write(json.dumps({"at": iso(), "event": kind, **data}) + "\n")


class SpoolUnreachable(Exception):
    """The dedicated ledger publication transport is unavailable."""


class Spool:
    """Dedicated SSH transport for review-ledger publication only."""

    def __init__(self, cfg: Dict[str, Any]):
        self.key = cfg.get("ssh_key") or cfg.get("key")  # the signer runbook calls it `.key`
        self.host = cfg.get("ssh_alias") or cfg.get("host")
        self.dir = cfg.get("dir") or "/var/lib/crq-spool"
        # removed (owner D4: no fallback): refuse the spool rather than ignore the key
        self.refused = ("publisher_spool.legacy_shell is not supported: the dedicated forced-command "
                        "key is the only transport (owner decision D4) — remove it") if "legacy_shell" in cfg else None
        if self.host and not self.refused and not re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9.:-]*",
                                                               self.host):
            self.refused = (f"publisher_spool.ssh_alias must be a literal user@host (ssh runs with -F none), "
                            f"got {self.host!r}")

    def _ssh(self, remote: str, data: Optional[bytes] = None, *, timeout: int = 45) -> str:
        if self.refused:
            raise SpoolUnreachable(self.refused)
        if self.key:
            # -F none: no ssh_config identities, Match/ProxyCommand or ControlMaster. A shared master
            # opened with a general key would silently ignore -i and bypass the forced command.
            auth = ["-F", "none", "-i", os.path.expanduser(self.key), "-o", "IdentitiesOnly=yes",
                    "-o", "IdentityAgent=none", "-o", "ControlMaster=no", "-o", "ControlPath=none"]
        else:
            raise SpoolUnreachable("no dedicated spool key configured (publisher_spool.ssh_key) — refusing "
                                   "to use a general-purpose ssh identity")
        cmd = ["/usr/bin/ssh", *auth, "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=5",
               "-o", "ServerAliveCountMax=2", self.host, remote]
        try:
            p = subprocess.run(cmd, input=data if data is not None else b"", capture_output=True, timeout=timeout)
        except (subprocess.TimeoutExpired, OSError) as exc:
            raise SpoolUnreachable(f"ssh {self.host}: {exc}"[:200])
        if p.returncode != 0:
            raise SpoolUnreachable(f"ssh {self.host} exit {p.returncode}: {p.stderr.decode(errors='replace').strip()[:200]}")
        return p.stdout.decode(errors="replace")

    def publish_ledger(self, base: str, head: str, bundle: bytes) -> None:
        if not self.host or not all(re.fullmatch(r"[0-9a-f]{40}", value) for value in (base, head)):
            raise OSError("ledger publication requires the dedicated signer transport")
        if not bundle or len(bundle) > 64 * 1024 * 1024:
            raise OSError("invalid ledger bundle size")
        try:
            reply = self._ssh("ledger-publish " + base + " " + head, bundle, timeout=330)
        except SpoolUnreachable as exc:
            raise OSError("ledger signer transport unavailable; retain publication outbox") from exc
        if json.loads(reply) != {"published": head}:
            raise OSError("signer did not acknowledge the exact ledger commit")


def live_items(q):
    """Retain historical promotion records on disk, outside the active queue."""
    return [item for item in q["items"] if item.get("kind") != "promotion"]


def load_queue() -> Dict[str, Any]:
    q = json.loads(QUEUE.read_text())
    # Idempotently retire the superseded second-cycle debt. Explicit optional
    # requeues survive reload; running reviews still have to be harvested.
    for item in live_items(q):
        item.pop("boost", None)
        if (item.get("kind") == "open" and completed_open_cycles(item) >= 1
                and item.get("state") in ("pending", "blocked") and not item.get("optional_cycle")):
            item.update(state="done", not_before=None, last_error=None)
    return q


def save_queue(q: Dict[str, Any]) -> None:
    repair_tick.atomic(QUEUE, q)


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
    try:
        git("worktree", "add", "--quiet", "-B", branch, str(path), commit)
    except RuntimeError:
        remove_worktree(path, branch)
        raise
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
    """Parse policy/denylist/patterns.yml (constrained format) from the default branch."""
    text = git("show", f"{DEFAULT_REF}:policy/denylist/patterns.yml")
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
    return secret_scan_diff(diff, out, base=base, head=head)


def secret_scan_diff(diff: str, out: Path, *, base=None, head=None) -> Tuple[bool, Dict[str, Any]]:
    """Use identical denylist/gitleaks policy for prepared source evidence."""
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
        for line in ndjson.read_text(errors="replace").splitlines() if ndjson.exists() else []:
            line = line.strip()
            if not line:
                continue
            try:
                value = json.loads(line)
                if not isinstance(value, dict) or not isinstance(value.get("type"), str) or value.get("type") not in {
                        "finding", "complete", "error", "action_required", "status", "heartbeat", "review_context"}:
                    bad_lines += 1
                    continue
                if value.get("type") == "finding" and not (isinstance(value.get("severity"), str) and value["severity"]):
                    bad_lines += 1
                events.append(value)
            except ValueError:
                bad_lines += 1
    errors = [e for e in events if e.get("type") == "error"]
    actions = [e for e in events if e.get("type") == "action_required" or e.get("status") == "awaiting_confirmation"]
    findings = [e for e in events if e.get("type") == "finding"]
    terminal = events
    last = terminal[-1] if terminal else {}
    complete = [e for e in events if e.get("type") == "complete"]
    counts = {s: 0 for s in SEVERITIES}
    for f in findings:
        severity = f.get("severity") if isinstance(f.get("severity"), str) else "none"
        counts[severity] = counts.get(severity, 0) + 1
    res: Dict[str, Any] = {"exit": exit_code, "events": len(events), "bad_lines": bad_lines,
                           "findings": len(findings), "severity_counts": counts}
    # Authorization is derived from every structured cause, never message text.
    causes = []
    proof_complete = ndjson.exists() and bad_lines == 0 and type(exit_code) is int
    def hard(code):
        causes.append({"source": "queue", "category": "unknown", "code": code})
    for _ in range(bad_lines):
        hard("malformed-stream")
    for e in events:
        if e.get("type") == "error":
            if e.get("errorType") == "rate_limit" and e.get("recoverable") is True:
                causes.append({"source": "vendor", "category": "vendor-rate-limited", "code": "rate_limit"})
            else:
                code = e.get("errorType")
                hard(code if isinstance(code, str) and re.fullmatch(r"[A-Za-z0-9_-]{1,80}", code)
                     else "unknown-error")
        if e.get("type") == "action_required" or e.get("status") == "awaiting_confirmation":
            hard("action-required")
        # Unknown status values are not evidence of a harmless progress event.
        # In particular scan/budget/cancel statuses must survive a vendor error.
        if e.get("type") == "finding" and isinstance(e.get("severity"), str) and e["severity"] in BLOCKING_SEVERITIES:
            hard("blocking-finding")
        if e.get("type") != "complete" and "status" in e:
            status = e["status"]
            # Explicit protocol progress is neutral, never completion/vendor proof.
            # TS fixtures: status/scanning, reviewing, writing; heartbeat/reviewing.
            progress = (e["type"] == "status" and isinstance(status, str) and
                        status in ("scanning", "reviewing", "writing") or
                        e["type"] == "heartbeat" and status == "reviewing")
            if not progress:
                hard(status if isinstance(status, str) and re.fullmatch(r"[A-Za-z0-9_-]{1,80}", status)
                     else "unrecognized-status")
                proof_complete = False
    if errors and complete:
        hard("conflicting-terminal")
    vendor_only = bool(causes) and all(c["source"] == "vendor" for c in causes)
    if type(exit_code) is not int:
        hard("missing-exit")
    elif exit_code != 0 and not (exit_code == 1 and vendor_only):
        hard("unexpected-exit")
    if actions:
        res.update(outcome="action_required", message="structured action required")
    elif any(e.get("errorType") == "auth" for e in errors):
        # Operational stop only: auth remains a hard cause, never vendor authority.
        res.update(outcome="auth", message="structured authentication failure; owner action needed")
    elif errors:
        if vendor_only and proof_complete and type(exit_code) is int and exit_code in (0, 1):
            res.update(outcome="rate_limited")
            waits = []
            for e in errors:
                metadata = e.get("metadata")
                wait = metadata.get("waitTime") if isinstance(metadata, dict) else None
                m = re.fullmatch(r"(\d+)\s*(second|minute|hour)s?", wait) if isinstance(wait, str) else None
                if m:
                    waits.append(int(m.group(1)) * {"second": 1, "minute": 60, "hour": 3600}[m.group(2)])
            res["wait_seconds"] = max(waits) if waits else None
        else:
            res.update(outcome="error", message="structured failure; see failure provenance")
    elif exit_code is None:
        res.update(outcome="interrupted", message="no exit status recorded")
    elif exit_code != 0:
        res.update(outcome="error", message=f"CLI exit {exit_code}")
    elif bad_lines:
        res.update(outcome="malformed", message="stream contains malformed or unrecognized events")
    elif complete and re.search(r"no fresh (detailed )?(file )?review|review (was )?skipped|skipped (this )?review",
                                str(complete[0].get("message", "")), re.I):
        res.update(outcome="skipped", message="affirmative no-fresh/skipped completion")
    elif len(complete) != 1 or not last or last.get("type") != "complete":
        res.update(outcome="interrupted", message="stream did not end with a terminal complete event")
    elif last.get("status") != "review_completed":
        res.update(outcome="skipped", message=f"complete.status={last.get('status')}")
    else:
        reviewed = last.get("reviewedFiles") or []
        count = len(reviewed) if isinstance(reviewed, list) else reviewed if isinstance(reviewed, int) and not isinstance(reviewed, bool) and reviewed >= 0 else 0
        res.update(outcome="completed", reviewed_files=count)
    if not errors and not actions and res["outcome"] != "completed":
        hard("nonterminal-review")
    # Unknown statuses also invalidate an otherwise apparently successful stream.
    if not proof_complete and res["outcome"] == "completed":
        res.update(outcome="malformed", message="stream contains an unrecognized status")
    res["failure_provenance"] = {"version": 1, "complete": proof_complete, "causes": causes}
    res["counted"] = res["outcome"] == "completed"
    return res


def findings_md(ndjson: Path, meta: Dict[str, Any], cls: Dict[str, Any]) -> str:
    out = [f"# CodeRabbit CLI findings — {meta['item_id']} ({meta['label']})", "",
           f"- run: `{meta['run_id']}`  outcome: **{cls['outcome']}**  counted: {cls['counted']}",
           f"- base `{meta['base']}` → head `{meta['head']}` (clean tree)",
           f"- severity counts: {json.dumps(cls['severity_counts'])}", ""]
    i = 0
    for line in ndjson.read_text(errors="replace").splitlines() if ndjson.exists() else []:
        try:
            e = json.loads(line)
        except ValueError:
            continue
        if not isinstance(e, dict) or e.get("type") != "finding":
            continue
        i += 1
        text = e.get("codegenInstructions") or e.get("comment") or ""
        out += [f"## F{i} [{e.get('severity')}] {e.get('fileName')}", "", "```text", str(text).strip()[:4000], "```", ""]
    return "\n".join(out) + "\n"


# ----------------------------------------------------------- PR info / activity


def pr_info(pr: int) -> Dict[str, Any]:
    return gh_json(["pr", "view", str(pr), "--repo", REPO, "--json",
                    "number,state,isDraft,headRefName,headRefOid,baseRefName,updatedAt,mergeCommit,mergedAt"])


def deferred_forge(args: List[str]) -> Any:
    """Normalize a bounded forge timeout into retryable deferred debt."""
    try:
        return gh_json(args)
    except subprocess.TimeoutExpired:
        raise RuntimeError("deferred forge request timed out") from None


def verify_deferred_source(repo: str, pr: int) -> Dict[str, Any]:
    """Trusted forge identity for one explicitly enrolled request, no discovery."""
    if repo != REPO or not re.fullmatch(r"[\w.-]+/[\w.-]+", repo):
        raise ValueError("deferred repository is outside configured scope")
    if type(pr) is not int or pr <= 0:
        raise ValueError("invalid deferred PR")
    data = deferred_forge(["api", f"repos/{repo}/pulls/{pr}"])
    if not isinstance(data, dict):
        raise ValueError("missing forge PR metadata")
    base = data.get("base") or {}
    head = data.get("head") or {}
    user = data.get("user") or {}
    if (not isinstance(base, dict) or not isinstance(head, dict) or not isinstance(user, dict) or
            not isinstance(base.get("repo"), dict) or base["repo"].get("full_name") != repo or
            type(data.get("number")) is not int or data["number"] != pr or
            not isinstance(user.get("login"), str) or not user["login"] or
            not isinstance(head.get("sha"), str) or not re.fullmatch(r"[0-9a-f]{40}", head["sha"]) or
            not isinstance(base.get("ref"), str) or not base["ref"] or type(data.get("merged")) is not bool or
            data.get("state") not in ("open", "closed") or (data["merged"] and data["state"] != "closed")):
        raise ValueError("invalid forge PR identity")
    merge = data.get("merge_commit_sha") if data["merged"] else None
    if data["merged"] and (not isinstance(merge, str) or not re.fullmatch(r"[0-9a-f]{40}", merge)):
        raise ValueError("missing immutable forge merge identity")
    return {"repo": repo, "pr": pr, "producer": user["login"], "head": head["sha"],
            "target": base["ref"], "state": "MERGED" if data["merged"] else data["state"].upper(),
            "mergeSha": merge}


def find_deferred_source(repo: str, producer: str, head: str, target: str, limit: int) -> List[Dict[str, Any]]:
    """Recover a lost publication reply, all states, refusing incomplete search.

    Search is restricted to the explicit request's repo/producer/head/base. Its
    candidates are re-read as trusted PR metadata; search snippets are no proof.
    Search text is not identity: a candidate that re-reads as a well-formed forge
    PR naming another publication (different producer/head/target) is skipped as
    search noise. Malformed candidates, an incomplete or over-limit envelope and
    duplicate candidates still fail closed, as does any malformed trusted re-read.
    Empty/index-lag results leave the intent unpublished for a later tick.
    """
    if (repo != REPO or not isinstance(producer, str) or
            not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9-]*(?:\[bot\])?", producer) or
            not isinstance(head, str) or not re.fullmatch(r"[0-9a-f]{40}", head) or
            queue_transport.branch_fault(target) is not None or type(limit) is not int or limit != 2):
        raise ValueError("invalid deferred publication binding")
    query = f"repo:{repo} is:pr author:{producer} base:{target} {head}"
    result = deferred_forge(["api", "--method", "GET", "search/issues", "-f", "q=" + query,
                             "-f", "per_page=" + str(limit), "-f", "page=1"])
    if (not isinstance(result, dict) or result.get("incomplete_results") is not False or
            type(result.get("total_count")) is not int or not isinstance(result.get("items"), list) or
            not 0 <= result["total_count"] <= limit or len(result["items"]) != result["total_count"]):
        raise RuntimeError("deferred publication search incomplete; debt retained")
    matches = []
    seen = set()
    for candidate in result["items"]:
        if not isinstance(candidate, dict) or not isinstance(candidate.get("pull_request"), dict):
            raise ValueError("search candidate is not a forge PR")
        number = candidate.get("number")
        actual = verify_deferred_source(repo, number)
        # Count every verified candidate before the match test: a duplicate fails
        # closed whether or not it names this publication.
        if number in seen:
            raise RuntimeError("duplicate search candidate; debt retained")
        seen.add(number)
        if any(actual[k] != value for k, value in (("producer", producer), ("head", head), ("target", target))):
            continue  # well-formed forge PR for another publication: search noise
        matches.append(actual)
    return matches


_AGENTS_CACHE: Dict[str, Any] = {}


def running_agents() -> List[Dict[str, Any]]:
    if "v" not in _AGENTS_CACHE:
        try:
            hosts = CONFIG.get("paseo_hosts")
            if not hosts or len(hosts) < 2:
                raise RuntimeError("both Paseo endpoints must be configured")
            agents = []
            for host in hosts:
                data = paseo_json(["ls", "--host", host])
                for agent in data.get("agents", []) if isinstance(data, dict) else data:
                    agents.append({**agent, "crq_endpoint": host})
            _AGENTS_CACHE["v"] = [a for a in agents if a.get("status") in ("running", "initializing")]
        except Exception as exc:  # fail closed: unknown activity blocks starts
            _AGENTS_CACHE["v"] = None
            event("paseo_ls_failed", error=str(exc)[:300])
    return _AGENTS_CACHE["v"]


def agent_branch(cwd: str) -> Optional[str]:
    p = Path(os.path.expanduser(cwd))
    # Never inspect an unrelated repository merely because an agent lists it.
    if "webfront" in p.parts or not p.is_relative_to(WT_ROOT) and not p.is_relative_to(CLONE):
        return None
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
        cwd = a.get("cwd") or ""
        if (re.search(rf"#{pr}\b", title) or re.search(rf"pr-?{pr}\b", cwd)
                or os.path.basename(cwd.rstrip("/")) == slug):
            hits.append(f"{a.get('shortId') or a.get('id', '')[:8]} {title[:50]}")
        elif cwd and "webfront" not in Path(cwd).parts:
            # A foreign cwd must not be interpreted using this host's files.
            # Conservatively block toolkit activity whose branch is unknown.
            if any(x in cwd for x in ("cq-toolkit", "identity-cq-reviewer", "coderabbit-queue-repo")):
                hits.append(f"{a.get('shortId') or a.get('id', '')[:8]} toolkit agent active; branch unknown")
            elif agent_branch(cwd) == branch:
                hits.append(f"{a.get('shortId') or a.get('id', '')[:8]} active on PR branch")
    return hits


def quiet_reason(item: Dict[str, Any], info: Dict[str, Any], ignore_age: bool = False) -> Optional[str]:
    """Return why the PR head is not quiet enough to review (None = quiet)."""
    branch = info["headRefName"]
    act = active_agents_for(item["pr"], branch)
    if act is None:
        return "paseo agent list unavailable (fail closed)"
    if act:
        return "active agent(s): " + "; ".join(act)
    if ignore_age:
        return None
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


def measure_merged(item: Dict[str, Any], target: Optional[str] = None) -> Dict[str, Any]:
    """Blame-based survival: of the lines the PR added, how many are still
    attributed (git blame -w -M) to the PR's own commits at the selected target.
    Without an explicit target, use the shared default branch."""
    merge = item["merge_commit"]
    mq = target if target is not None else git("rev-parse", DEFAULT_REF)
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
    # Per-file synthetic delta (pre-merge → default branch). A path joins the
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


def build_synthetic(item: Dict[str, Any], target: str) -> Tuple[str, str, int]:
    """Explicit immutable T; generation pins replace mutable per-PR refs."""
    repo = backfill_runtime.accounting.Repository(CLONE)
    repo.resolve(target)
    merge = item["merge_commit"]
    paths = (item.get("measure") or {}).get("synthetic_paths") or synth_paths(merge, target)
    live = repo.entries(target)
    paths = sorted(p for p in paths if p in live)
    # Legacy subjects use the same safe full-file projection when provenance
    # cannot establish complete residual scope. New A unions use the bounded
    # synthetic/residual constructor in backfill_subjects directly.
    base, head = backfill_runtime.subjects.projection(repo, target, paths)
    identity = backfill_runtime.ledger.digest({"item": item["id"], "target": target, "paths": paths})
    backfill_runtime.subjects.pin(repo, identity, item.get("generation", 0), 0, base, head, target)
    return base, head, len(paths)


# ----------------------------------------------------------- merged-current Q1


def current_paths(merge: str, target: str) -> List[Dict[str, Any]]:
    """Full affected files at T, without blame/survival or historical content."""
    if not is_ancestor(merge, target):
        raise NotReady("not-yet-promoted: source merge is not an ancestor of selected target")
    # An explicit first parent is required. Never guess at missing source history.
    pre = git("rev-parse", f"{merge}^1")
    source = run(["git", "diff", "--name-only", "--no-renames", "-z", pre, merge], cwd=CLONE).stdout
    names = sorted(set(source.rstrip("\0").split("\0"))) if source else []
    raw = run(["git", "diff", "--name-status", "-M50%", "-z", merge, target], cwd=CLONE).stdout
    fields = raw.rstrip("\0").split("\0") if raw else []
    renames = {}
    removed = []
    added = []
    while fields:
        status = fields.pop(0)
        old = fields.pop(0)
        if status.startswith(("R", "C")):
            new = fields.pop(0)
            if status.startswith("R"):
                renames[old] = new
                removed.append(old)
                added.append(new)
        elif status == "D":
            removed.append(old)
        elif status == "A":
            added.append(old)
    # Git's rename heuristic can arbitrarily pair duplicate identical files.
    # Such lineage is not enough to claim current scope; retain ambiguity.
    old_blobs = [git("rev-parse", merge + ":" + path) for path in removed]
    new_blobs = [git("rev-parse", target + ":" + path) for path in added]
    result = []
    total = 0
    for original in names:
        path = original
        evidence = "same-path-current"
        if not path_exists(target, path) and path in renames:
            blob = git("rev-parse", merge + ":" + path)
            path = renames[path]
            if old_blobs.count(blob) > 1 or new_blobs.count(blob) > 1:
                result.append({"source_path": original, "path": path, "resolution": "git-rename-M50",
                               "disposition": "ambiguous", "reason": "duplicate blobs make rename lineage ambiguous"})
                continue
            evidence = "git-rename-M50"
        row = {"source_path": original, "path": path, "resolution": evidence}
        if any(c in path for c in "\n\r\t\\"):
            row.update(disposition="unsupported", reason="path cannot be safely scanned")
            result.append(row)
            continue
        ls = run(["git", "ls-tree", "-z", target, "--", ":(literal)" + path], cwd=CLONE).stdout
        entries = [e for e in ls.split("\0") if e]
        if not entries:
            row.update(disposition="deleted", reason="no current path or evidenced rename")
        elif len(entries) != 1:
            row.update(disposition="ambiguous", reason="current path resolves to multiple entries")
        else:
            mode, typ, rest = entries[0].split(" ", 2)
            blob = rest.split("\t", 1)[0]
            row.update(blob=blob, mode=mode)
            if typ != "blob" or mode not in ("100644", "100755"):
                row.update(disposition="unsupported", reason="non-regular file; never dereferenced")
            else:
                size = int(git("cat-file", "-s", blob))
                row["bytes"] = size
                if size > 262144 or total + size > 2097152:
                    row.update(disposition="unsupported", reason="current content exceeds scope byte cap")
                else:
                    data = subprocess.run(["git", "cat-file", "blob", blob], cwd=CLONE,
                                          capture_output=True, check=True).stdout
                    try:
                        data.decode("utf-8")
                        text = b"\0" not in data
                    except UnicodeDecodeError:
                        text = False
                    if not text:
                        row.update(disposition="unsupported", reason="binary or non-UTF8 current blob")
                    elif not size:
                        row.update(disposition="excluded-with-reason", reason="empty current file")
                    else:
                        total += size
                        row.update(disposition="renamed" if path != original else "included")
        result.append(row)
    return result


def build_current_projection(target: str, paths: List[str]) -> Tuple[str, str]:
    """B = T minus selected files; H.tree = T, so B..H contains only additions."""
    with tempfile.TemporaryDirectory() as td:
        env = dict(os.environ, GIT_INDEX_FILE=str(Path(td) / "index"), GIT_LITERAL_PATHSPECS="1")
        git("read-tree", target, env=env)
        for path in sorted(set(paths)):
            git("update-index", "--force-remove", "--", path, env=env)
        tree = git("write-tree", env=env)
    ident = dict(os.environ, GIT_AUTHOR_NAME="crq", GIT_AUTHOR_EMAIL="crq@localhost",
                 GIT_COMMITTER_NAME="crq", GIT_COMMITTER_EMAIL="crq@localhost")
    base = git("commit-tree", tree, "-p", target, "-m", "crq current affected files removed", env=ident)
    head = git("commit-tree", target + "^{tree}", "-p", base, "-m", "crq current affected files restored", env=ident)
    return base, head


def current_document(item: Dict[str, Any], outcome: str, *, meta=None, cls=None, rdir=None) -> Dict[str, Any]:
    findings = []
    artifacts = {}
    if rdir:
        for name in ("meta.json", "review.ndjson", "exit.json", "secret-scan.json"):
            if (rdir / name).exists():
                artifacts[name] = sha256_file(str(rdir / name))
        stream = rdir / "review.ndjson"
        for line in stream.read_text(errors="replace").splitlines() if stream.exists() else []:
            try:
                value = json.loads(line)
            except ValueError:
                continue
            if isinstance(value, dict) and value.get("type") == "finding":
                findings.append(value)
    return {"version": 1, "item_id": item["id"], "request_id": item.get("request_id"), "source": item["subject"],
            "capture": item["capture"], "outcome": outcome, "classification": cls,
            "counted": bool(cls and cls["counted"]), "findings": findings,
            "run_id": (meta or {}).get("run_id"), "started_at": (meta or {}).get("started_at"),
            "artifacts": artifacts, "remediation": "disabled/deferred", "independent_acceptance": False,
            "cli_functional_acceptance": "pending-D1"}


def prepare_current(q: Dict[str, Any], item: Dict[str, Any], dry: bool) -> Optional[Dict[str, Any]]:
    if dry:
        return {"base": "(dispatch-pin)", "head": "(dispatch-pin)", "target": item["subject"]["target_selector"],
                "cycle": None, "branch": None, "label": "affected current files (not captured)", "notes": []}
    if any(i.get("kind") == "merged" and i.get("pr") == item["pr"] and i.get("state") == "reviewing"
           for i in live_items(q)):
        raise NotReady("legacy source review still owns a live/ambiguous run; no new dispatch")
    if not item.get("capture"):
        selector = item["subject"]["target_selector"]
        target = git("rev-parse", review_receipt.SELECTORS[selector] + "^{commit}")
        paths = current_paths(item["merge_commit"], target)
        selected = sorted({r["path"] for r in paths if r["disposition"] in ("included", "renamed")})
        capture = {"target": target, "tree": git("rev-parse", target + "^{tree}"), "paths": paths,
                   "scope_digest": review_receipt.digest(paths), "policy": review_receipt.POLICY,
                   "projection": "current-affected-files/full-file-addition-projection",
                   "reviewer": "coderabbit-review-agent-committed-v1",
                   "reviewer_version": run(["coderabbit", "--version"]).stdout.strip()[:100],
                   "captured_at": iso()}
        capture["equivalence"] = review_receipt.current_equivalence(capture)
        if selected:
            capture["base"], capture["head"] = build_current_projection(target, selected)
            # Keep objects reachable through GC and daemon/caller restart.
            for part in ("base", "head"):
                git("update-ref", f"refs/crq/current/{item['id']}/{part}", capture[part])
        item["capture"] = capture
        save_queue(q)
    capture = item["capture"]
    for other in q["items"]:
        if other is item or other.get("kind") != review_receipt.KIND:
            continue
        if (other.get("capture") or {}).get("equivalence") != capture["equivalence"]:
            continue
        if other.get("receipt_id") and other.get("state") in ("done", "no-current-code", "unsupported"):
            # Verify retained bytes and semantic proof, never reuse legacy synthetic credit.
            manifest = review_receipt.read_receipt(STATE / "receipts", other["receipt_id"])
            document = json.loads((STATE / "receipts" / (manifest["receipt_id"] + ".json")).read_text())
            if review_receipt.current_equivalence(document["capture"]) != review_receipt.current_equivalence(capture):
                raise ValueError("reuse receipt scope mismatch")
            if other["state"] == "done" and not review_receipt.reusable_current(document, capture):
                continue
            item.update(state=other["state"], receipt_id=other["receipt_id"], reused_from=other["id"])
            save_queue(q)
            return None
        if other.get("state") == "reviewing":
            raise NotReady("equivalent current subject already reviewing: " + other["id"])
    selected = [r for r in capture["paths"] if r["disposition"] in ("included", "renamed")]
    if not selected:
        unsupported = any(r["disposition"] in ("unsupported", "ambiguous") for r in capture["paths"])
        outcome = "unsupported" if unsupported else "no-current-code"
        item["receipt_id"] = review_receipt.write_receipt(STATE / "receipts", current_document(item, outcome))
        item["state"] = outcome
        save_queue(q)
        return None
    return {"base": capture["base"], "head": capture["head"], "target": capture["target"],
            "review_pin": capture["target"], "cycle": None, "branch": None,
            "label": "affected current files at " + capture["target"], "notes": []}


def enqueue_merged(pr: int, merge_sha: str, request_id: str, target_selector: str = "promoted-main") -> Dict[str, Any]:
    # Verify before touching the queue. PR number alone is never scope authority.
    info = pr_info(pr)
    if (info.get("number") != pr or info.get("state") != "MERGED" or
            (info.get("mergeCommit") or {}).get("oid") != merge_sha or info.get("baseRefName") not in DISCOVERY_BRANCHES):
        raise ValueError("source must be a verified merged PR into an accepted target branch with matching merge SHA")
    q = load_queue()
    result = review_receipt.enroll(q, repo=REPO, pr=pr, merge_sha=merge_sha, request_id=request_id,
                                   at=iso(), target_selector=target_selector)
    save_queue(q)
    return review_receipt.status(q, request_id)


def current_report(request_id: str, receipt_id: Optional[str] = None, cursor: Optional[str] = None) -> Dict[str, Any]:
    status = review_receipt.status(load_queue(), request_id)
    actual = status["receipt_id"]
    if receipt_id and receipt_id != actual:
        raise ValueError("receipt does not match request")
    if not actual:
        if cursor:
            raise ValueError("request has no receipt")
        # Pending path manifests may be large too: supported status is deliberately bounded.
        return {k: v for k, v in status.items() if k != "capture"}
    return review_receipt.read_receipt(STATE / "receipts", actual, cursor)


class DiscoveryStorageFailed(RuntimeError):
    """Durability is uncertain: abort this tick before any further effects."""


def _save_discovery_queue(q, stage):
    try:
        save_queue(q)
    except OSError:
        raise DiscoveryStorageFailed("merged discovery storage failure: " + stage +
                                     "; tick aborted; persisted progress must be revalidated") from None


def _read_reconcile_wrapper(path, interval, page_budget, recent=False):
    try:
        text = path.read_text()
    except FileNotFoundError:
        return None
    except UnicodeDecodeError:
        raise merged_reconcile.ReconcileRefused("wrapper-decode: invalid text") from None
    except OSError:
        raise DiscoveryStorageFailed("merged discovery storage failure: wrapper-read; tick aborted") from None
    try:
        wrapper = json.loads(text)
    except (ValueError, RecursionError):
        raise merged_reconcile.ReconcileRefused("wrapper-decode: invalid JSON") from None
    if (not isinstance(wrapper, dict) or set(wrapper) != {"source", "checkpoint", "digest"} or
            not isinstance(wrapper["source"], dict)):
        raise merged_reconcile.ReconcileRefused("wrapper-schema: required fields malformed")
    source = wrapper["source"]
    if (set(source) != {"version", "method", "repo", "base", "repository_id", "ceiling", "window"} or
            type(source.get("version")) is not int or source["version"] != 1 or
            source.get("method") != ("closed-updated-v1" if recent else "all-number-slots-v1") or source.get("repo") != REPO or
            source.get("base") != DISCOVERY_SELECTOR or source.get("window") != merged_reconcile.NUMBER_WINDOW or
            not isinstance(source.get("repository_id"), str) or not source["repository_id"] or
            type(source.get("ceiling")) is not int or
            not 0 <= source["ceiling"] <= merged_reconcile.MAX_REPOSITORY_NUMBER):
        raise merged_reconcile.ReconcileRefused("wrapper-schema: source identity malformed")
    if wrapper["digest"] != review_receipt.digest({k: v for k, v in wrapper.items() if k != "digest"}):
        raise merged_reconcile.ReconcileRefused("source/checkpoint wrapper digest mismatch")
    if wrapper["checkpoint"] is not None:
        wrapper["checkpoint"] = merged_reconcile.load_checkpoint(wrapper["checkpoint"], interval, page_budget,
            repo=REPO, base=DISCOVERY_SELECTOR, allow_complete=True)
    return wrapper


def reconcile_merged(q, *, after, before, page_budget, dry_run=False, recent=False):
    """Caller owns tick.lock; persist source/page before reads and Q1 before watermark."""
    interval = merged_reconcile.normalize_interval(after, before)
    if before >= iso():
        raise merged_reconcile.ReconcileRefused("upper bound must precede scan startup")
    merged_reconcile.normalize_page_budget(page_budget)
    key = review_receipt.digest({"repo": REPO, "base": DISCOVERY_SELECTOR, **interval,
                                **({"method": "closed-updated-v1"} if recent else {})})
    path = STATE / "reconcile" / (key + ".json")
    wrapper = _read_reconcile_wrapper(path, interval, page_budget, recent=recent)

    def save_wrapper():
        wrapper["digest"] = review_receipt.digest({k: v for k, v in wrapper.items() if k != "digest"})
        try:
            repair_tick.atomic(path, wrapper)
        except OSError:
            raise DiscoveryStorageFailed("merged discovery storage failure: wrapper-save; tick aborted") from None

    def forge(query):
        try:
            return gh_json(["api", "graphql", "-f", "query=" + query])
        except (OSError, RuntimeError, subprocess.TimeoutExpired, ValueError, deferred_refresh.RefreshExhausted):
            raise merged_reconcile.PageFailed("forge read unavailable; cursor retained") from None

    if wrapper is None:
        source = ({"version": 1, "method": "closed-updated-v1", "repo": REPO,
                   "base": DISCOVERY_SELECTOR, "repository_id": REPO, "ceiling": 0,
                   "window": merged_reconcile.NUMBER_WINDOW} if recent else
                  merged_reconcile.freeze_source(forge, repo=REPO, base=DISCOVERY_SELECTOR))
        wrapper = {"source": source, "checkpoint": None}
        if not dry_run:
            save_wrapper()
    source = wrapper["source"]

    def persist(checkpoint):
        wrapper["checkpoint"] = checkpoint
        save_wrapper()

    raw = wrapper["checkpoint"]
    if raw and raw.get("complete"):
        result = merged_reconcile.load_checkpoint(raw, interval, page_budget, repo=REPO,
                                                   base=DISCOVERY_SELECTOR, allow_complete=True)
    else:
        result = merged_reconcile.reconcile(None,
            lambda cursor: (recent_merged_page(cursor, after) if recent else
                merged_reconcile.number_page(forge, source, cursor, repo=REPO, base=DISCOVERY_SELECTOR)),
            repo=REPO, base=DISCOVERY_SELECTOR, **interval, page_budget=page_budget, checkpoint_raw=raw,
            checkpoint_save=persist, dry_run=dry_run)
    summary = {**result["summary"], "inventory_digest": result["digest"],
               "source": source, "checkpoint_key": key}
    if result["complete"]:
        existing = [v["binding"] for v in q.get("merged_current_requests", {}).values()]
        plan = merged_reconcile.enrollment_plan(result, repo=REPO, existing_requests=existing, dry_run=dry_run)
        if not dry_run:
            # The adapter validated live forge provenance for each exact slot.
            # No second per-PR read of mutable metadata, no inline review launch.
            staged = json.loads(json.dumps(q))
            for entry in plan["entries"]:
                if entry["disposition"] != "intent":
                    continue
                binding = {k: v for k, v in entry["binding"].items() if k != "policy"}
                review_receipt.enroll(staged, **binding, request_id=entry["request_id"], at=iso())
            staged["merged_reconcile"] = summary
            # Completeness does not confer review credit, even on old done/skipped items.
            _save_discovery_queue(staged, "enrollment-save")
            q.clear()
            q.update(staged)
    elif not dry_run:
        staged = json.loads(json.dumps(q))
        staged["merged_reconcile"] = summary
        _save_discovery_queue(staged, "inventory-summary-save")
        q.clear()
        q.update(staged)
    return summary


def rolling_discovery_interval(q, config):
    """Keep the configured history floor; freeze only each in-progress scan."""
    before = iso(now() - dt.timedelta(seconds=1))
    floor = merged_reconcile.normalize_interval(config.get("after"), before)["after"]
    active = q.get("merged_discovery") or {}
    if (not active.get("complete") and active.get("after", "") >= floor
            and active.get("before", "") < before and active.get("after", "") < active.get("before", "")):
        return merged_reconcile.normalize_interval(active["after"], active["before"])
    watermark = q.get("merged_watermark")
    after = max(floor, iso(parse_iso(watermark) - dt.timedelta(minutes=5))) if watermark else floor
    return merged_reconcile.normalize_interval(after, before)


def recent_merged_page(cursor, after):
    """Newest closed PRs first; stop at the history floor, with resumable pages."""
    page = 1 if cursor is None else int(cursor)
    if page < 1 or (cursor is not None and str(page) != cursor):
        raise merged_reconcile.ReconcileRefused("invalid closed-PR page cursor")
    try:
        rows = gh_json(["api", f"repos/{REPO}/pulls?state=closed&sort=updated&direction=desc&per_page=100&page={page}"])
    except (OSError, RuntimeError, subprocess.TimeoutExpired, ValueError, deferred_refresh.RefreshExhausted):
        raise merged_reconcile.PageFailed("forge read unavailable; cursor retained") from None
    if not isinstance(rows, list) or len(rows) > 100:
        raise merged_reconcile.ReconcileRefused("invalid closed-PR page")
    records = []
    older = False
    for row in rows:
        if not isinstance(row, dict):
            raise merged_reconcile.ReconcileRefused("invalid closed-PR record")
        updated = row.get("updated_at")
        merged_reconcile.normalize_interval("1970-01-01T00:00:00Z", updated)
        if updated <= after:
            older = True
        if "merged_at" not in row:
            raise merged_reconcile.ReconcileRefused("missing merge metadata")
        if row["merged_at"] and (row.get("base") or {}).get("ref") in DISCOVERY_BRANCHES:
            records.append({"number": row.get("number"), "mergedAt": row["merged_at"],
                "mergeCommit": {"oid": row.get("merge_commit_sha")},
                "headRefOid": (row.get("head") or {}).get("sha")})
    more = len(rows) == 100 and not older
    return {"records": records, "has_next_page": more, "next_cursor": str(page + 1) if more else None}


def discover_merged(q, budget, *, interval=None, recent=False):
    """Persist a bounded discovery scan; resume it before rolling the next upper."""
    caller = q
    q = json.loads(json.dumps(q))
    active = q.get("merged_discovery") or {}
    if interval is not None:
        after, before = interval["after"], interval["before"]
    elif active and not active.get("complete"):
        after, before = active["after"], active["before"]
    else:
        watermark = q.get("merged_watermark") or q["created_at"]
        after = iso(parse_iso(watermark) - dt.timedelta(minutes=5))
        before = iso(now() - dt.timedelta(seconds=1))
    if after >= before:
        return []
    # Record the frozen bounds in queue too: a crash after source pinning but
    # before page one must not cause the next tick to choose a different upper.
    if interval is not None or not active or active.get("complete"):
        q["merged_discovery"] = {"after": after, "before": before, "complete": False}
        _save_discovery_queue(q, "bounds-save")
    try:
        with forge_window(budget):
            result = reconcile_merged(q, after=after, before=before, page_budget=4, recent=recent)
        q["merged_discovery"] = {"after": after, "before": before, "complete": result["complete"]}
        _save_discovery_queue(q, "discovery-summary-save")
        if result["complete"]:
            q["merged_watermark"] = before
            _save_discovery_queue(q, "watermark-save")
        caller.clear()
        caller.update(q)
        return [f"merged discovery: complete={result['complete']} represented={result['represented']}"]
    except (merged_reconcile.ReconcileRefused, merged_reconcile.PageFailed) as exc:
        q["merged_discovery"]["error"] = str(exc)[:200]
        _save_discovery_queue(q, "refusal-debt-save")
        caller.clear()
        caller.update(q)
        return ["merged discovery incomplete; cursor/debt retained: " + str(exc)[:200]]


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
    for record in item.get("cycles", []):
        if (record.get("base") == pin and record.get("head") == head and
                record.get("dirty_diff") == "clean tree" and record.get("run_id") and
                record.get("range_policy") == "full-range-once-v1"):
            raise NothingToReview("exact captured base/head range already reviewed")
    if item.get("pinned_base") and pin != item["pinned_base"]:
        notes.append("base drift: retain prior evidence; review the newly captured range once")
    if not dry:
        item["pinned_base"] = pin
        item["target_ref"] = target
    cycle = len(item.get("cycles", [])) + 1
    return {"base": pin, "head": head, "target": target, "label": "one review of captured range", "cycle": cycle,
            "notes": notes, "branch": info["headRefName"], "review_pin": pin,
            "range_policy": "full-range-once-v1"}


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
    """Conservative full-range fallback when equivalent scope is unproven."""
    if info["state"] not in ("OPEN", "MERGED"):
        raise NotReady(f"PR is {info['state']}")
    head = info["headRefOid"]
    if not ensure_commit(item["pr"], head):
        raise NotReady("source head unavailable")
    target = f"{info['mergeCommit']['oid']}^1" if info["state"] == "MERGED" else f"origin/{info['baseRefName']}"
    pin = git("merge-base", target, head)
    for record in item.get("cycles", []):
        if (record.get("base") == pin and record.get("head") == head and
                record.get("range_policy") == "full-range-once-v1" and record.get("run_id")):
            raise NothingToReview("equivalent captured full range already reviewed")
    return {"base": pin, "head": head, "pr_head": head, "target": target,
            "label": "one full-range review (prior equivalent scope unproven)", "cycle": None,
            "notes": [], "branch": info.get("headRefName") if info["state"] == "OPEN" else None,
            "review_pin": pin, "range_policy": "full-range-once-v1"}


def plan_merged(item: Dict[str, Any], dry: bool) -> Dict[str, Any]:
    if dry:
        return {"base": "(synthetic)", "head": "(synthetic)", "target": DEFAULT_REF,
                "label": "post-merge synthetic review", "cycle": None, "notes": [], "branch": None}
    target = git("rev-parse", DEFAULT_REF + "^{commit}")
    if not is_ancestor(item["merge_commit"], target):
        raise NotReady("not-yet-promoted: merge commit is not an ancestor of origin/main")
    base, head, n = build_synthetic(item, target)
    return {"base": base, "head": head, "target": target, "cycle": None, "branch": None,
            "label": f"post-merge current projection ({n} PR-touched paths at promoted main)", "notes": []}


def object_present(sha: str) -> bool:
    return run(["git", "cat-file", "-e", f"{sha}^{{commit}}"], cwd=CLONE, check=False).returncode == 0


def plan_author(item: Dict[str, Any], dry: bool) -> Dict[str, Any]:
    """Author review plan. The binding's base/head are immutable commits; verify
    both are present in the clone (fetching if needed) before a worktree is cut,
    so an unpushed head WAITS (NotReady) instead of crashing the tick."""
    author_lease.check_queue(item, at=iso())
    plan = author_quota.plan(item)
    if dry:
        return plan
    if not (object_present(plan["base"]) and object_present(plan["head"])):
        fetch()
        if not (object_present(plan["base"]) and object_present(plan["head"])):
            raise NotReady(f"author binding not fetchable ({plan['base'][:10]}..{plan['head'][:10]})")
    if not run(["git", "diff", "--name-only", plan["base"], plan["head"]], cwd=CLONE,
               check=False).stdout.strip():
        raise NothingToReview("author binding has an empty diff")
    return plan


# ----------------------------------------------------------- launching


def starts_last_hour(q: Dict[str, Any]) -> int:
    cutoff = now() - dt.timedelta(hours=1)
    return sum(1 for s in q.get("starts", []) if parse_iso(s) > cutoff)


def notify_owner(text: str) -> Dict[str, Any]:
    """Paseo message to the chancellor (the owner's desk). promotion.alert_agent_host
    names its daemon when it is not the local one (queue-host runner → worker-host). Never
    raises: an unreachable daemon must not stall the tick that is reporting."""
    res: Dict[str, Any] = {}
    aid = CONFIG.get("promotion", {}).get("alert_agent_id")
    if aid:
        host = CONFIG.get("promotion", {}).get("alert_agent_host")
        try:
            p = run(["paseo", "send", "--no-wait", *(["--host", host] if host else []), aid, text], check=False,
                    timeout=30 if host else 90)
            res["paseo_send"] = p.returncode if p.returncode == 0 else f"{p.returncode}: {p.stderr.strip()[:150]}"
        except (subprocess.TimeoutExpired, OSError) as exc:
            res["paseo_send"] = f"error: {exc}"[:150]
    return res


def inflight(q: Dict[str, Any]) -> List[Dict[str, Any]]:
    return [i for i in live_items(q) if (i["state"] == "reviewing" or (i.get("kind") in backfill_jobs.RANK4 and backfill_jobs.is_execution_owner(i)))]


def launch(q: Dict[str, Any], item: Dict[str, Any], plan: Dict[str, Any]) -> str:
    if item["kind"] == author_quota.AUTHOR_KIND:
        author_lease.check_queue(item, at=iso())
    run_id = f"{item['id']}-{now().strftime('%Y%m%dT%H%M%SZ')}"
    rdir = RUNS / run_id
    rdir.mkdir(parents=True)
    if item["kind"] == review_receipt.KIND:
        patch = git("diff", "--text", "--no-textconv", "--no-ext-diff", "--no-renames", "--no-color",
                    "--unified=0", plan["base"], plan["head"])
        ok, scan = secret_scan_diff(patch, rdir / "secret-scan.json", base=plan["base"], head=plan["head"])
    else:
        ok, scan = secret_scan(plan["base"], plan["head"], rdir / "secret-scan.json")
    if ok and item["kind"] == backfill_jobs.KIND:
        context = backfill_runtime.ledger.canonical(item.get("context", {})).decode()
        patch = "diff --git a/.crq-review-context.json b/.crq-review-context.json\n--- /dev/null\n+++ b/.crq-review-context.json\n@@ -0,0 +1 @@\n+" + context + "\n"
        ok, scan = secret_scan_diff(patch, rdir / "context-secret-scan.json", base=plan["base"], head=plan["head"])
    if not ok:
        item["state"] = "blocked"
        item["last_error"] = (f"secret scan failed before upload: {len(scan['denylist_hits'])} denylist + "
                              f"{len(scan['gitleaks_hits'])} gitleaks hit(s) — see {rdir}/secret-scan.json")
        if item["kind"] == author_quota.AUTHOR_KIND and "author_lease" in item:
            item["author_lease"]["secret_scan_blocked"] = True
            save_queue(q)
        if item["kind"] == review_receipt.KIND:
            item["receipt_id"] = review_receipt.write_receipt(STATE / "receipts",
                current_document(item, "blocked-secret-scan", rdir=rdir))
            save_queue(q)
        event("blocked", item=item["id"], reason=item["last_error"])
        return run_id
    try:
        wt, wbranch = make_worktree(f"wt-{run_id}", plan["head"])
    except RuntimeError as exc:
        if item["kind"] != author_quota.AUTHOR_KIND:
            raise
        # An admitted author head the clone cannot check out (e.g. a runner-configured
        # required smudge filter) stays ungranted and waits for its lease deadline, which
        # authorizes the agent fallback, instead of failing every tick.
        raise author_quota.AuthorRefused("author head cannot be checked out") from exc
    cli_cmd = ["coderabbit", "review", "--agent", "--deep"]
    if item["kind"] in (author_quota.AUTHOR_KIND, review_receipt.KIND) or plan.get("range_policy"):
        # Author/current/full-range cycles review the COMMITTED base..head (the original manual cycle 1
        # form) on a clean worktree, never uncommitted working-tree edits. The
        # natural argv is deliberately unchanged.
        cli_cmd.append("--committed")
    meta = {"run_id": run_id, "item_id": item["id"], "pr": item["pr"], "kind": item["kind"],
            "workId": f"crq:{run_id}",
            "label": plan["label"], "cycle": plan["cycle"], "base": plan["base"], "head": plan["head"],
            "pr_head": plan.get("pr_head", plan["head"]), "review_pin": plan.get("review_pin", plan["base"]),
            "target": plan["target"], "pr_branch": plan["branch"], "worktree": str(wt), "wt_branch": wbranch,
            "dirty_diff": "clean tree", "range_policy": plan.get("range_policy"), "started_at": iso(),
            "cmd": [*cli_cmd, "--base-commit", plan["base"]]}
    if item["kind"] == backfill_jobs.KIND:
        meta["backfill"] = {k: item[k] for k in ("subject_id", "job_id", "attempt_id", "target", "scope_digest")}
    if item["kind"] == review_receipt.KIND:
        meta["capture"] = item["capture"]
        meta["source"] = item["subject"]
    if item["kind"] in ("merged", "coverage"):
        meta["planned_paths"] = (item.get("measure") or {}).get("synthetic_paths")
        meta["reviewed_tip"] = (item.get("measure") or {}).get("merge_queue")
        meta["coverage_sha"] = item.get("coverage_sha")
        meta["coverage_paths"] = item.get("coverage_paths")
    if item["kind"] == author_quota.AUTHOR_KIND:
        a = item.get("author") or {}
        meta["author"] = {k: a.get(k) for k in ("request_id", "base", "head", "target", "cycle")}
    if item["kind"] == author_quota.AUTHOR_KIND:
        try:
            # Scan/worktree preparation may outlast the wait deadline. Recheck
            # immediately before reservation, still under the same tick lock.
            author_lease.grant_queue(item, at=iso())
        except author_quota.AuthorRefused:
            remove_worktree(wt, wbranch)
            raise
    repair_tick.atomic(rdir / "meta.json", meta)
    # Session-log preservation (item 2.1): one work-started line per review,
    # linking the run to its workId. Best-effort (R5) — a failed append never
    # fails the launch; telemetry-ingest's crq-run adapter reads either this
    # or meta.json's workId.
    append_work_record({
        "type": "work-started",
        "workId": meta["workId"],
        "at": meta["started_at"],
        "source": "crq",
        "role": "reviewer",
        "task": f"pr{item['pr']}",
        "runId": run_id,
        "host": os.uname().nodename,
        "harness": "coderabbit",
        "repo": REPO,
        "pr": item["pr"],
        "head": plan["head"],
    })
    item["state"] = "reviewing"
    item["run"] = {"run_id": run_id, "pid": None, "started_at": meta["started_at"], "launch_pending": True}
    item["wait_reason"] = None
    q.setdefault("starts", []).append(meta["started_at"])
    # Reserve identity/quota BEFORE any child or remote status mutation. A
    # crash leaves a known run to reconcile, never a pending item to redispatch.
    save_queue(q)
    try:
        with (rdir / "runner.log").open("a") as output:
            proc = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "_review", run_id],
                                    cwd=ROOT, stdin=subprocess.DEVNULL, stdout=output, stderr=output,
                                    start_new_session=True)
    except OSError as exc:
        # A failed spawn is a CONSUMED, DISTINCT terminal admission: the start
        # was already persisted above, so no automatic retry can double-spend it.
        # Only author items get this terminal here; every other kind keeps the
        # previous (raise) behaviour.
        if item["kind"] != author_quota.AUTHOR_KIND:
            raise
        item["run"] = {"run_id": run_id, "pid": None, "started_at": meta["started_at"],
                       "launch_pending": False, "spawn_failed_at": iso(), "error": str(exc)[:200]}
        item["state"] = author_quota.AUTHOR_FAILED
        item["last_error"] = f"author spawn failed (no retry): {exc}"[:300]
        event("spawn_failed", item=item["id"], run=run_id, error=str(exc)[:200])
        save_queue(q)
        return run_id
    item["run"].update(pid=proc.pid, launch_pending=False)
    save_queue(q)
    event("review_started", item=item["id"], run=run_id, base=plan["base"], head=plan["head"], label=plan["label"])
    return run_id


def review_wrapper_argv(cli_cmd: List[str], tmo_min: int) -> List[str]:
    """The review deadline wrapper (GNU coreutils `timeout`).

    `--foreground` is REQUIRED and is the whole point. Verified against coreutils
    9.11: WITHOUT it, timeout moves the managed command into a NEW process group
    whose pgid is the wrapper's own pid, so `review.pid`'s runner pgid (written
    BEFORE the child is spawned) does NOT cover the running review; a runner
    killed between Popen and the cli_pid write leaves the recorded group empty
    while the review lives in an unrecorded group (a false "gone"). WITH
    `--foreground` the wrapper keeps the command in the runner's OWN group, so
    the pre-recorded pgid always covers a live review.

    Deadline semantics (a review wall-clock guard, NOT a repair hard-budget or a
    spend proof): SIGTERM at `tmo_min` (GNU timeout then exits 124), and
    `--kill-after=60` SIGKILLs the direct child 60s later (which can surface as
    137). The child records `timed_out` for a wrapper exit in (124, 137); a 137
    can ALSO be an external KILL, so the deadline is not independently proved as
    the cause and no timeout reason is inferred.

    `--foreground` signals the DIRECT child only, and the group probe covers the
    runner's own group: a descendant that creates its OWN session/group escapes
    both the deadline and the probe and is an explicit UNTRACKED residual (not a
    retained-capacity guarantee; proving ownership of an escaped group would need
    cgroups/units, which are out of this scope).
    """
    return [CONFIG.get("timeout_bin", "timeout"), "--foreground", "--kill-after=60",
            f"{tmo_min}m", *cli_cmd]


def cmd_review_child(run_id: str) -> int:
    """Detached child: run the CLI once, record exit status. Never retries."""
    signal.signal(signal.SIGHUP, signal.SIG_IGN)
    rdir = RUNS / run_id
    meta = json.loads((rdir / "meta.json").read_text())
    cmd = review_wrapper_argv(meta["cmd"], CONFIG["review_timeout_min"])
    reviewer_env = dict(os.environ, CODERABBIT_CLI_DISABLE_AUTO_UPDATE="true",
                        CODERABBIT_CLI_UPDATE_MANAGED="true")
    pidfile = rdir / "review.pid"
    identity = {"run_id": run_id, "pid": os.getpid(), "ppid": os.getppid(), "pgid": os.getpgrp(),
                "sid": os.getsid(0), "group_owner": author_quota.GROUP_OWNER_MARKER}
    repair_tick.atomic(pidfile, identity)
    try:
        if meta.get("kind") == backfill_jobs.KIND:
            version = subprocess.run([meta["cmd"][0], "--version"], capture_output=True, text=True, check=True, timeout=30, env=reviewer_env).stdout.strip()
            if version not in backfill_runtime.history.REVIEWER_FORMATS:
                raise RuntimeError("backfill scope adapter refuses unknown CodeRabbit version")
            repository = backfill_runtime.accounting.Repository(meta["worktree"])
            if repository.git("rev-parse", "HEAD^{commit}").decode().strip() != meta["head"] or repository.git("status", "--porcelain").strip():
                raise RuntimeError("backfill submission must match clean pinned head")
            proof = {"cli_version": version, "format": backfill_runtime.history.REVIEWER_FORMATS[version], "run_id": run_id,
                     "head": meta["head"], "base": meta["base"], "attempt_id": meta["backfill"]["attempt_id"],
                     "submitted_scope": backfill_runtime.history.submitted_scope(repository, meta["base"], meta["head"])}
            repair_tick.atomic(rdir / "submission.json", proof)
    except (ValueError, RuntimeError, OSError, subprocess.SubprocessError) as exc:
        (rdir / "review.ndjson").write_text(json.dumps({"type": "error", "message": str(exc)}) + "\n")
        repair_tick.atomic(rdir / "exit.json", {"exit": 3, "ended_at": iso(), "timed_out": False,
                                               "pre_vendor_refusal": True})
        return 3
    with (rdir / "review.ndjson").open("w") as out, (rdir / "stderr.log").open("w") as err:
        proc = subprocess.Popen(cmd, cwd=meta["worktree"], stdout=out, stderr=err, stdin=subprocess.DEVNULL, env=reviewer_env)
        repair_tick.atomic(pidfile, {**identity, "cli_pid": proc.pid})
        rc = proc.wait()
    # GNU timeout exits 124 when it sends TERM at the deadline; a `--kill-after`
    # SIGKILL (or an external KILL) can surface as 137. Record both as timed_out
    # WITHOUT inferring the cause: a 137 may be an external kill, so the deadline
    # is not independently proved.
    repair_tick.atomic(rdir / "exit.json",
                       {"exit": rc, "ended_at": iso(), "timed_out": rc in (124, 137)})
    try:
        run(["systemctl", "--user", "--no-block", "start", "crq-tick.service"], check=False, timeout=10)
    except (OSError, subprocess.TimeoutExpired):
        pass  # periodic tick remains the recovery path on non-systemd hosts
    return 0


def proc_cmdline(pid: int) -> str:
    return run(["ps", "-o", "command=", "-p", str(pid)], check=False, timeout=20).stdout.strip()


def ident_pid(value: Any) -> Optional[int]:
    """A positive integer pid/pgid, or None. Guards os.kill against bools/strs."""
    return value if isinstance(value, int) and not isinstance(value, bool) and value > 0 else None


def read_pidfile(rdir: Path) -> Optional[Dict[str, Any]]:
    """The recorded run identity dict, or None when absent/malformed/foreign.
    Never raises: an unreadable pidfile is unverifiable evidence, not a crash."""
    pf = rdir / "review.pid"
    if not pf.exists():
        return None
    try:
        loaded = json.loads(pf.read_text())
    except (ValueError, OSError):
        return None
    return loaded if isinstance(loaded, dict) else None


def group_alive(pgid: Optional[int]) -> bool:
    """True unless the recorded process group is PROVED empty (fail closed).

    `timeout --foreground` keeps the whole review in the runner's own group, so a
    non-empty group means a review process is still live. Anything other than a
    proved-empty group (a non-positive pgid, our own group, a permission error,
    an unknown failure) counts as alive and retains capacity. A merely re-used
    pgid can therefore retain an item until owner disposition: the deliberate
    fail-closed choice, never a silent release of a possibly-live review.
    """
    pid = ident_pid(pgid)
    if not pid:
        return False
    if pid == os.getpgrp():
        return True
    try:
        os.killpg(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except OSError:
        return True


def run_liveness(rdir: Path, item: Dict[str, Any], r: Dict[str, Any], has_exit: bool) -> str:
    """Shared detached-review liveness for author AND natural runs.

    Probes the recorded runner pid, the CLI pid and every process group that can
    own the review:
      * the runner's own group (the MANAGED protocol: `timeout --foreground` keeps
        the whole review in it, and the pidfile carries GROUP_OWNER_MARKER);
      * for a LEGACY launch (no marker) with a recorded cli_pid, the wrapper's own
        group, whose pgid IS that cli_pid under GNU timeout's default. A legacy
        identity whose wrapper group is unknown is unverifiable and never released.
    """
    pidfile = read_pidfile(rdir)
    kind = author_quota.identity_kind(pidfile, run_id=r.get("run_id"), queue_pid=r.get("pid"))
    pid = ident_pid((pidfile or {}).get("pid")) or ident_pid(r.get("pid"))
    cli = ident_pid((pidfile or {}).get("cli_pid"))
    runner_alive = bool(pid) and pid_alive(pid) and r["run_id"] in proc_cmdline(pid)
    cli_alive = bool(cli) and pid_alive(cli) and "coderabbit" in proc_cmdline(cli)
    runner_group_alive = group_alive((pidfile or {}).get("pgid"))
    wrapper_group_alive = group_alive(cli) if (kind == "legacy" and cli) else None
    return author_quota.run_state(has_exit=has_exit, identity=kind, runner_alive=runner_alive,
                                  cli_alive=cli_alive, runner_group_alive=runner_group_alive,
                                  wrapper_group_alive=wrapper_group_alive)


def author_dispatch_failed(item: Dict[str, Any], r: Dict[str, Any], o: str, cls: Dict[str, Any],
                           why: Optional[str] = None) -> None:
    """Every attempted author dispatch ends in a distinct CONSUMED terminal with
    NO automatic retry. Global rate-limit cooldown / auth pause are set by the
    caller and preserved; only the item's retry is suppressed."""
    detail = why or f"author review {o} (not counted)"
    suffix = "" if why else (f": {cls.get('message')}" if cls.get("message") else "")
    item["state"] = author_quota.AUTHOR_FAILED
    item["last_error"] = f"{detail}{suffix}; no automatic retry — owner disposition required"[:300]
    item["run"] = None
    event("author_failed", item=item["id"], run=r["run_id"], outcome=o)


# ----------------------------------------------------------- harvesting


def set_rate_cooldown(q, cls, rdir):
    seconds = cls.get("wait_seconds")
    if seconds is None:
        seconds = (q.get("rl_backoff_min") or CONFIG["rate_limit_default_backoff_min"]) * 60
    try:
        ended = parse_iso(json.loads((rdir / "exit.json").read_text()).get("ended_at")) or now()
    except (OSError, ValueError, TypeError):
        ended = now()
    until = ended + dt.timedelta(seconds=seconds)
    current = parse_iso(q.get("cooldown_until"))
    q["cooldown_until"] = iso(max(current, until) if current else until)


def has_collectable_runs(q):
    """Match the minute harvester's reviewing/run eligibility without probing owners."""
    return any(i["state"] == "reviewing" and i.get("run") for i in live_items(q))


def refresh_slot_deadline(q, usage, remaining, gate, at=None):
    at = now() if at is None else at
    if q.get("paused") or gate == "inflight" or not any(i["state"] == "pending" for i in live_items(q)):
        deadline = at + dt.timedelta(minutes=12)
    elif q.get("cooldown_until") and parse_iso(q["cooldown_until"]) > at:
        deadline = parse_iso(q["cooldown_until"])
    elif remaining <= 0:
        deadline = usage_slots.next_slot([parse_iso(s) for s in q.get("starts", [])], at, usage)
        deadline = deadline or at + dt.timedelta(seconds=60)
    else:
        deadline = at + dt.timedelta(minutes=12)  # available slots, no eligible item
    hint = deadline
    if has_collectable_runs(q):
        # Detached reviews need minute collection; signer holds await full ticks.
        hint = min(hint, at.replace(second=0, microsecond=0) + dt.timedelta(minutes=1))
    usage_slots.write_next(STATE / "next-review-at", hint)
    return deadline  # admission time, not the earlier result-collection hint


def harvest_review(q: Dict[str, Any], item: Dict[str, Any], dry: bool) -> Optional[str]:
    r = item["run"]
    rdir = RUNS / r["run_id"]
    exitf = rdir / "exit.json"
    has_exit = exitf.exists()
    state = run_liveness(rdir, item, r, has_exit)
    if state == "alive":
        item["wait_reason"] = ("author: run alive" if item["kind"] == author_quota.AUTHOR_KIND
                               else "detached review still alive")
        return None
    if state == "ambiguous":
        # Fail closed: retain capacity and require owner disposition. This covers
        # a missing/malformed identity, a MISSING exit artifact (absence is never
        # asserted), and a legacy launch with incomplete ownership evidence. No
        # TTL release. The event is suppressed on a dry run.
        if not dry:
            event("review_ambiguous", item=item["id"], run=r["run_id"])
        item["wait_reason"] = ("author: run not releasable (unverifiable identity, missing exit, or "
                               "incomplete legacy ownership) — capacity retained, owner disposition required"
                               if item["kind"] == author_quota.AUTHOR_KIND
                               else "run not releasable (unverifiable identity, missing exit, or incomplete "
                                    "legacy ownership) — capacity retained, owner disposition required")
        return None
    # state == "harvest": terminal exit evidence + valid identity + complete
    # ownership evidence + nothing alive.
    exit_code = json.loads(exitf.read_text())["exit"]
    if dry:
        return f"would harvest {r['run_id']}"
    usage_slots.write_next(STATE / "next-review-at", now())
    meta = json.loads((rdir / "meta.json").read_text())
    cls = classify(rdir / "review.ndjson", exit_code)
    (rdir / "classification.json").write_text(json.dumps(cls, indent=2) + "\n")
    (rdir / "findings.md").write_text(findings_md(rdir / "review.ndjson", meta, cls))
    if item["kind"] == review_receipt.KIND:
        # Receipt before queue mutation: a crash here is recovered by re-harvest.
        partial = any(p["disposition"] in ("unsupported", "ambiguous") for p in item["capture"]["paths"])
        outcome = ("partial-scope" if partial else "terminal-with-findings" if cls["findings"] else "terminal-clean") if cls["counted"] else cls["outcome"]
        item["receipt_id"] = review_receipt.write_receipt(STATE / "receipts",
            current_document(item, outcome, meta=meta, cls=cls, rdir=rdir))
        item.setdefault("attempts", []).append({"run_id": r["run_id"], "outcome": cls["outcome"],
                                              "counted": cls["counted"], "receipt_id": item["receipt_id"]})
        item["run"] = None
        # Separate from cycles: repair_tick.backfill must never enqueue these findings.
        item["state"] = "done" if cls["counted"] else "blocked"
        item["last_error"] = cls.get("message")
        if cls["outcome"] == "rate_limited":
            set_rate_cooldown(q, cls, rdir)
        if cls["outcome"] in ("action_required", "auth"):
            q.update(paused=True, pause_reason=f"{cls['outcome']} on {r['run_id']}; owner action needed")
        save_queue(q)
        remove_worktree(Path(meta["worktree"]), meta["wt_branch"])
        return f"{item['id']}: {outcome}; receipt {item['receipt_id']} (no repair)"
    if item["kind"] == backfill_jobs.KIND:
        return backfill_runtime.harvest(sys.modules[__name__], q, item, rdir, meta, cls, exit_code,
                                        terminal_verified=(state == "harvest"))
    if item["kind"] == "coverage":
        try:
            coverage._legacy_origins(q, item)
        except ValueError as exc:
            item.update(state="blocked", vendor_state="terminal", run=None,
                        last_error="legacy coverage lineage unresolved: " + str(exc))
            if item.get("attempt_id"):
                q.get("backfill_reservations", {}).get(item["attempt_id"], {})["terminal_at"] = iso()
            if cls["outcome"] in ("auth", "action_required"):
                q.update(paused=True, pause_reason=f"{cls['outcome']} on {r['run_id']}; owner action needed")
            if cls["outcome"] == "rate_limited":
                set_rate_cooldown(q, cls, rdir)
            save_queue(q)
            remove_worktree(Path(meta["worktree"]), meta["wt_branch"])
            return item["last_error"]
    if item["kind"] == "coverage" and item.get("attempt_id"):
        item["vendor_state"] = "terminal"
        q.get("backfill_reservations", {}).get(item["attempt_id"], {})["terminal_at"] = iso()
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
                  "dirty_diff": "clean tree", "range_policy": meta.get("range_policy"), "ndjson": str(rdir / "review.ndjson"),
                  "findings": cls["findings"], "severity_counts": cls["severity_counts"], "completed_at": iso()}
        if item["kind"] == author_quota.AUTHOR_KIND:
            # Genuine cycle evidence, but NEVER repair debt and NEVER promoted
            # coverage credit: author_cycles is not scanned by repair_tick.backfill,
            # and a branch-only review earns no coverage path credit.
            author_quota.record_cycle(item, record)
            item["state"] = "done"
            return f"{item['id']}: completed ({cls['findings']} findings) [author: no repair/coverage credit]"
        item.setdefault("cycles", []).append(record)
        terminal_paths = []
        for line in (rdir / "review.ndjson").read_text().splitlines():
            try:
                terminal = json.loads(line)
            except ValueError:
                continue
            if terminal.get("type") == "complete":
                reviewed = terminal.get("reviewedFiles") or []
                # Count-only terminal formats cannot establish per-path credit.
                for path in reviewed if isinstance(reviewed, list) else []:
                    value = path if isinstance(path, str) else (path.get("path") or path.get("fileName")) if isinstance(path, dict) else None
                    if value:
                        terminal_paths.append(value)
        q["coverage"] = coverage.record_review(q.get("coverage") or coverage.new_ledger(),
            run_id=meta["run_id"], completed_at=record["completed_at"], reviewed_paths=terminal_paths,
            review_sha=meta.get("coverage_sha") or meta.get("reviewed_tip") or meta["head"],
            counted=True, outcome="completed", focus_paths=meta.get("coverage_paths") or meta.get("planned_paths"))
        if item["kind"] == "coverage" and item.get("coverage_source"):
            coverage.record_legacy_success(q, item, terminal_paths)
        repair_pending = repair_tick.enqueue(sys.modules[__name__], q, item, meta, rdir)
        item["state"] = "repairing" if repair_pending else "done"
        return f"{item['id']}: completed ({cls['findings']} findings)"
    if o == "rate_limited":
        set_rate_cooldown(q, cls, rdir)
        attempt["deadline"] = q["cooldown_until"]
        q["rl_backoff_min"] = min(240, (q.get("rl_backoff_min") or CONFIG["rate_limit_default_backoff_min"]) * 2)
        item["last_error"] = f"rate limited ({cls.get('message')}); not counted"
        if item["kind"] == author_quota.AUTHOR_KIND:
            author_dispatch_failed(item, r, o, cls,
                                   why=f"rate limited ({cls.get('message')}); global cooldown until {q['cooldown_until']}")
            return f"{item['id']}: rate limited → global cooldown until {q['cooldown_until']}; author terminal (no retry)"
        item["state"] = "pending"
        return f"{item['id']}: rate limited → global cooldown until {q['cooldown_until']}"
    if o in ("action_required", "auth"):
        q["paused"] = True
        q["pause_reason"] = f"{o} on {r['run_id']}: {cls.get('message')} — owner action needed (never --use-credits)"
        item["last_error"] = q["pause_reason"]
        event("queue_paused", reason=q["pause_reason"])
        if item["kind"] == author_quota.AUTHOR_KIND:
            author_dispatch_failed(item, r, o, cls, why=f"{o} → queue PAUSED ({q['pause_reason']})")
            return f"{item['id']}: {o} → queue PAUSED; author terminal (no retry)"
        item["state"] = "pending"
        return f"{item['id']}: {o} → queue PAUSED"
    # error / interrupted / skipped / too_large: item-level backoff, never counted
    item["failures"] = item.get("failures", 0) + 1
    item["last_error"] = f"{o}: {cls.get('message')}"
    if item["kind"] == "coverage":
        coverage.record_legacy_failure(q, item, iso(), o, r["run_id"])
    if item["kind"] == author_quota.AUTHOR_KIND:
        # An attempted author dispatch is always a consumed terminal: the generic
        # pending/backoff retry path below must never apply to it.
        author_dispatch_failed(item, r, o, cls)
        return f"{item['id']}: {o} (not counted) → {item['state']} (author, no retry)"
    if o in ("skipped", "too_large") or item["failures"] >= CONFIG["max_item_failures"]:
        item["state"] = "blocked"
    else:
        item["state"] = "pending"
        item["not_before"] = iso(now() + dt.timedelta(minutes=CONFIG["error_backoff_min"] * 2 ** (item["failures"] - 1)))
    return f"{item['id']}: {o} (not counted) → {item['state']}"


def completed_open_cycles(item: Dict[str, Any]) -> int:
    # Historical prior_cycles credits have no reviewed head. Preserve that
    # metadata, but only recorded terminal cycles satisfy the head review.
    return len(item.get("cycles", []))


def optional_open(item: Dict[str, Any]) -> bool:
    return item["kind"] == "open" and completed_open_cycles(item) >= 1


def additional_cycle(item: Dict[str, Any]) -> bool:
    return optional_open(item) or (item["kind"] == author_quota.AUTHOR_KIND
                                   and (item.get("author") or {}).get("cycle", 1) > 1)


def parked_merged_linked_receipt(q: Dict[str, Any], item: Dict[str, Any]) -> bool:
    """A merged row parked because a linked current-code receipt owns recovery
    never starts on its own, so it demands no additional-cycle wait."""
    return item["kind"] == "merged" and any(
        i.get("kind") == review_receipt.KIND and i.get("pr") == item["pr"] for i in live_items(q))


def optional_wait(q: Dict[str, Any], item: Dict[str, Any]) -> bool:
    return additional_cycle(item) and any(
        i["state"] == "pending" and rank(i) <= 3 and not parked_merged_linked_receipt(q, i)
        for i in live_items(q) if i is not item)


def advance_open(item: Dict[str, Any]) -> None:
    item["state"] = "done" if completed_open_cycles(item) >= 1 else "pending"
    item.pop("boost", None)
    item.pop("optional_cycle", None)


def ledger_append(item: Dict[str, Any], meta: Dict[str, Any], cls: Dict[str, Any], rdir: Path) -> None:
    LEDGER.mkdir(parents=True, exist_ok=True)
    f = LEDGER / f"{item['kind']}-findings.md"
    with f.open("a") as out:
        out.write(f"\n## PR #{item['pr']} — {meta['label']} — {iso()}\n\n"
                  f"- run `{meta['run_id']}`; base `{meta['base'][:12]}` head `{meta['head'][:12]}`; "
                  f"{cls['findings']} findings {json.dumps(cls['severity_counts'])}\n"
                  f"- details: {rdir}/findings.md\n"
                  f"- disposition: detached repair inbox; see status digest\n")


# ----------------------------------------------------------- tick


def rank(item: Dict[str, Any]) -> int:
    """Required open 0, open delta 1, merged follow-ups/current 2, backlog 3,
    author/coverage 4, optional additional cycles 5."""
    if additional_cycle(item):
        return 5
    if item["kind"] == review_receipt.KIND:
        return 2
    if item["kind"] in ("coverage", backfill_jobs.KIND):
        return coverage.COVERAGE_RANK
    if item["kind"] == author_quota.AUTHOR_KIND:
        return author_quota.AUTHOR_RANK
    if item["kind"] in ("open",):
        return 0
    if item["kind"] == "delta":
        return 2 if item.get("followup") == "merged" else 1
    return 2 if item.get("source") == "followup" else 3


def sort_key(item: Dict[str, Any]) -> Tuple:
    # Explicit operator priority precedes ordinary rank and insertion order.
    return (0 if item.get("operator_priority") else 1, rank(item), item.get("order", 999))


# ----------------------------------------------------------- enrollment


def last_reviewed(q: Dict[str, Any], pr: int) -> Optional[Dict[str, Any]]:
    """Newest completed CLI review of the PR's own head (open cycles and deltas)."""
    recs = [c for i in live_items(q) if i["pr"] == pr and i["kind"] in ("open", "delta") for c in i.get("cycles", [])]
    return max(recs, key=lambda c: c["completed_at"]) if recs else None


def reviewed_head(rec: Dict[str, Any]) -> str:
    return rec.get("pr_head") or rec["head"]


def chains_to_target(p: Dict[str, Any], by_head: Dict[str, Dict[str, Any]]) -> bool:
    for _ in range(8):
        if p["baseRefName"] in DISCOVERY_BRANCHES:
            return True
        p = by_head.get(p["baseRefName"])
        if p is None:
            return False
    return False


def next_order(q: Dict[str, Any]) -> int:
    return max((i.get("order", 0) for i in live_items(q)), default=0) + 1


def new_item(q: Dict[str, Any], log: List[str], dry: bool, **fields: Any) -> Dict[str, Any]:
    dup = next((i for i in live_items(q) if i["id"] == fields.get("id")), None)
    if dup is not None:  # ids are unique: an existing item (even skipped) is sticky
        return dup
    if fields.get("kind") == "open":
        fields["prior_cycles"] = 0  # new PRs always owe a real completed review
    item = {"order": next_order(q), "state": "pending", "cycles": [], "attempts": [], **fields}
    item["notes"] = [f"{iso()} auto-enrolled: {fields.get('why', '')}"]
    item.pop("why", None)
    q["items"].append(item)
    if not dry:
        event("enrolled", item=item["id"], reason=item["notes"][0])
    log.append(f"{'DRY-RUN would enroll' if dry else 'enrolled'} {item['id']} ({item['notes'][0].split('auto-enrolled: ', 1)[1]})")
    return item


def enroll(q: Dict[str, Any], dry: bool) -> List[str]:
    """Enroll open PR work only; merged discovery uses the durable numeric adapter."""
    log: List[str] = []
    try:
        opened = gh_json(["pr", "list", "--repo", REPO, "--state", "open", "--limit", "200", "--json",
                          "number,isDraft,baseRefName,headRefName,headRefOid"])
    except Exception as exc:
        return [f"enrollment skipped: {exc}"[:300]]
    by_head = {p["headRefName"]: p for p in opened}
    for p in sorted(opened, key=lambda x: x["number"]):
        n, head = p["number"], p["headRefOid"]
        if p["isDraft"] or not chains_to_target(p, by_head):
            continue
        mine = [i for i in live_items(q) if i["pr"] == n and i["kind"] in ("open", "delta")]
        if not mine:
            stacked = "" if p["baseRefName"] in DISCOVERY_BRANCHES else f", stacked on {p['baseRefName']}"
            new_item(q, log, dry, id=f"pr{n}", pr=n, kind="open", tier=1, prior_cycles=0,
                     why=f"open PR not yet enrolled{stacked}")
            continue
        if any(i["state"] in ("pending", "reviewing", "repairing", "blocked") and not optional_open(i) for i in mine):
            continue
        try:
            if not ensure_commit(n, head):
                raise NotReady("source head unavailable")
            pin = git("merge-base", f"origin/{p['baseRefName']}", head)
        except (NotReady, OSError, RuntimeError, subprocess.TimeoutExpired):
            log.append(f"PR #{n}: range identity unavailable; enrollment deferred")
            continue
        last = last_reviewed(q, n)
        if last and reviewed_head(last) != head:
            try:
                if repair_tick.own_range(sys.modules[__name__], q, reviewed_head(last), head):
                    continue
            except Exception:
                pass  # without repair proof the full range remains owed
        evidence = [record for item in mine for record in item.get("cycles", [])]
        equivalent = any(record.get("base") == pin and record.get("head") == head and
                         record.get("range_policy") == "full-range-once-v1" and record.get("run_id")
                         for record in evidence)
        identity = f"pr{n}-range-{pin[:10]}-{head[:10]}"
        if not equivalent and not any(i["id"] == identity for i in mine):
            new_item(q, log, dry, id=identity, pr=n, kind="delta", followup="open",
                     why="current full range lacks equivalent captured evidence; retain earlier cycles/findings")
    return log


def deps_met(q: Dict[str, Any], item: Dict[str, Any]) -> bool:
    dep = item.get("depends_on")
    if not dep:
        return True
    d = next((i for i in live_items(q) if i["id"] == dep), None)
    return d is None or d["state"] in ("done", "skipped") or additional_cycle(d)


def ordinary_review_eligible(q):
    if q.get("backfill_ordinary_exhausted"):
        return False
    return any(i.get("state") == "pending" and rank(i) <= 3
               and not parked_merged_linked_receipt(q, i) and deps_met(q, i)
               and (not i.get("not_before") or parse_iso(i["not_before"]) <= now())
               for i in live_items(q))


def coverage_fallback(q, log, dry, only):
    started, available = backfill_runtime.select(sys.modules[__name__], q, log, dry, only)
    if started or available:
        return started, available
    if backfill_runtime.settings(STATE, dispatch=True):
        return None, False
    if only:
        return None, False
    mq = git("rev-parse", DEFAULT_REF + "^{commit}")
    candidates = [i for i in live_items(q) if i["kind"] == "coverage" and i["state"] == "pending"]
    for i in candidates:
        # A captured coverage target is immutable across tip moves.
        i.setdefault("coverage_sha", mq)
    candidates = [i for i in candidates if i["state"] == "pending"]
    if not candidates:
        if any(i["kind"] == "coverage" and i["state"] == "reviewing" for i in live_items(q)):
            return None, False
        for i in live_items(q):
            if i["kind"] == "merged" and i.get("merge_commit"):
                try:
                    i["measure"] = measure_merged(i, mq)
                except Exception as exc:
                    log.append("coverage measurement failed: " + str(exc)[:150])
        candidate = coverage.coverage_candidate(q, q.get("coverage") or coverage.new_ledger(),
            merge_queue_sha=mq, ordinary_eligible=False, now=now(),
            **CONFIG.get("coverage", {}))
        if candidate:
            q["items"].append(candidate)
            candidates = [candidate]
    available = False
    for item in sorted(candidates, key=sort_key):
        if item.get("not_before") and parse_iso(item["not_before"]) > now() or not deps_met(q, item):
            continue
        try:
            source, origins = coverage._legacy_origins(q, item)
            if not origins or any(not coverage._legacy_retry_allowed(q, source["pr"], origin, now())
                                  for origin in origins):
                item["wait_reason"] = "legacy coverage retry history or cooldown unresolved"
                continue
        except (ValueError, KeyError, TypeError):
            item["wait_reason"] = "legacy coverage retry identity unresolved"
            continue
        available = True
        if dry:
            log.append("DRY-RUN would cut coverage " + item["id"])
            return None, True
        try:
            base, head, paths = build_synthetic(item, item["coverage_sha"])
            if not git("diff", "--name-only", base, head):
                item.update(state="skipped", last_error="empty coverage range")
                continue
            plan = dict(base=base, head=head, target=item["coverage_sha"], cycle=None,
                        branch=None, notes=[], label="lowest-priority coverage review")
            if not backfill_runtime.rank4_gate(sys.modules[__name__], q, item, dry):
                continue
            run_id = launch(q, item, plan)
            if item["state"] == "reviewing":
                backfill_jobs.bind_run(q, item, run_id)
            elif not item.get("run"):
                backfill_jobs.cancel_before_vendor(q, item)
            log.append("coverage " + item["id"] + ": " + item["state"])
            return run_id if item["state"] == "reviewing" else None, True
        except Exception as exc:
            item["wait_reason"] = "coverage planning failed: " + str(exc)[:200]
    return None, available


def start_one(q, log, dry, only, ignore_quiet, capture_current=True):
    """Select in policy order; launch reserves identity and quota before spawn."""
    started = None
    has_coverage = False
    reservations_before = len(q.get("starts", []))
    q["backfill_ordinary_exhausted"] = False
    for item in sorted(live_items(q), key=sort_key):
        if only and item["id"] != only:
            continue
        if item["state"] != "pending":
            continue
        if item["kind"] == review_receipt.KIND and not capture_current and not item.get("capture"):
            item["wait_reason"] = "first current capture waits for fetching maintenance tick"
            continue
        if item["kind"] in ("coverage", backfill_jobs.KIND):
            if item.get("operator_priority"):
                started, has_coverage = coverage_fallback(q, log, dry, only)
                if started or (dry and has_coverage):
                    break
            continue
        if only and item["kind"] in (author_quota.AUTHOR_KIND, review_receipt.KIND) and not dry:
            # Author enrollment is PENDING NATURAL-ONLY by design. A selective
            # `crq start <author-id>` would dispatch the author item while a
            # pending ordinary item is skipped by the `only` filter,
            # bypassing the priority order, so it is refused. The natural tick
            # (no `only`) is unaffected. An explicit --dry-run may still show
            # the plan; it never launches.
            log.append(f"{item['id']}: selective start refused — author items start only "
                       f"from the natural tick (pending natural-only)")
            break
        if optional_wait(q, item):
            item["wait_reason"] = "optional cycle waits until no rank <=3 work is pending"
            continue
        if additional_cycle(item):
            # Coverage gets first refusal even though it uses a fallback.
            started, has_coverage = coverage_fallback(q, log, dry, only)
            if started or (dry and has_coverage):
                break
        if item["kind"] == "merged" and any(i.get("kind") == review_receipt.KIND and i.get("pr") == item["pr"]
                                              for i in live_items(q)):
            item["wait_reason"] = "linked merged-current intent owns current-scope recovery; legacy evidence retained"
            continue
        if item.get("not_before") and parse_iso(item["not_before"]) > now():
            item["wait_reason"] = f"backoff until {item['not_before']}"
            continue
        if not deps_met(q, item):
            item["wait_reason"] = f"waiting for {item['depends_on']}"
            continue
        try:
            if item["kind"] == author_quota.AUTHOR_KIND:
                # Author items bind their own base/head/target: no PR, no
                # active-agent quiet gate. Global pause/cooldown/hourly/
                # inflight gates and the pre-upload secret scan still apply.
                plan = plan_author(item, dry)
            elif item["kind"] == review_receipt.KIND:
                plan = prepare_current(q, item, dry)
                if plan is None:
                    log.append(f"{item['id']}: {item['state']} (no vendor start)")
                    continue
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
                qr = None if post_merge else quiet_reason(item, info, ignore_age=ignore_quiet)
                if qr:
                    item["wait_reason"] = qr
                    continue
                plan = (plan_open if item["kind"] == "open" else plan_delta)(item, info, dry)
        except NotReady as exc:
            item["wait_reason"] = str(exc)
            if len(q.get("starts", [])) > reservations_before:
                break  # unknown delivery still owns its journaled admission
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
            if len(q.get("starts", [])) > reservations_before:
                break
            continue
        for n in plan["notes"]:
            log.append(f"{item['id']}: {n}")
            if not dry:
                item.setdefault("notes", []).append(f"{iso()} {n}")
        if dry:
            log.append(f"DRY-RUN would start {item['id']} [{plan['label']}] base {plan['base'][:12]} "
                       f"head {plan['head'][:12]} target {plan['target']}")
        else:
            try:
                started = launch(q, item, plan)
            except author_quota.AuthorRefused as exc:
                item["wait_reason"] = str(exc)
                log.append(f"{item['id']}: author launch refused: {exc}")
                continue
            if item["state"] == "blocked":
                log.append(f"{item['id']}: blocked before vendor start")
                continue
            log.append(f"started {item['id']} [{plan['label']}] run {started}")
        break
    else:
        q["backfill_ordinary_exhausted"] = not bool(only)
        started, has_coverage = coverage_fallback(q, log, dry, only)
        if not started:
            log.append("no eligible item this tick")
    if dry:
        log += [f"  waiting {i['id']}: {i['wait_reason']}" for i in sorted(live_items(q), key=sort_key)
                if i["state"] == "pending" and i.get("wait_reason")]
    return started, has_coverage


def read_slot_usage(q):
    """Subtract reservations lacking vendor evidence BEFORE the usage snapshot.

    Aggregate usage cannot identify a detached child still preparing its CLI
    session. Never reallocate those promised slots. Local progress may be
    cached only after a valid
    subsequent usage observation, never from a pid or review_context alone.
    """
    held = []
    observed = []
    for item in live_items(q):
        if item["state"] == "reviewing":
            run = item.get("run") or {}
            if run.get("vendor_observed"):
                continue
            run_id = run.get("run_id")
            if run_id and usage_slots.vendor_progress(RUNS / run_id / "review.ndjson"):
                observed.append(run)
            else:
                held.append(run.get("started_at"))
    usage = usage_slots.read_usage(CLONE)
    if usage is not None:
        for run in observed:
            run["vendor_observed"] = True
    else:
        held.extend(run.get("started_at") for run in observed)
    return usage, held


def collect_finished(q, log):
    """Terminal detached reviews only; no enrollment, repairs or promotion audits."""
    for item in list(live_items(q)):
        if item["state"] != "reviewing" or not item.get("run"):
            continue
        run = item["run"]
        rdir = RUNS / run["run_id"]
        if not (rdir / "exit.json").exists():
            continue
        if run_liveness(rdir, item, run, True) != "harvest":
            continue  # live or unverifiable owners retain their capacity
        msg = harvest_review(q, item, False)
        if msg:
            log.append(msg)


def admit_available(q, usage, log, dry=False, only=None, ignore_quiet=False, reserved=(), capture_current=True):
    before_all = len(q.get("starts", []))
    has_coverage = False
    global_gate = None
    q["usage"] = usage
    backfill_runtime.usage_context(sys.modules[__name__], q, usage, reserved)
    q["backfill_starts_at_observation"] = len(q.get("starts", []))
    if usage is not None:
        slots = max(0, usage["remaining"] - len(reserved))
    else:
        # Recent reservations are already in starts; older/undated outstanding
        # promises still need protection after their local rolling hour expires.
        cutoff = now() - dt.timedelta(hours=1)
        old_holds = sum(1 for stamp in reserved if not stamp or parse_iso(stamp) <= cutoff)
        slots = max(0, CONFIG.get("max_starts_per_hour", 5) - starts_last_hour(q) - old_holds)
    admissions = min(slots, CONFIG.get("max_starts_per_tick", 10),
                     max(0, CONFIG.get("max_inflight", 10) - len(inflight(q))))
    if q.get("paused"):
        global_gate = "paused"
        log.append(f"queue paused: {q.get('pause_reason')}")
    elif q.get("cooldown_until") and parse_iso(q["cooldown_until"]) > now():
        global_gate = "cooldown"
        log.append(f"rate-limit cooldown until {q['cooldown_until']}")
    elif slots <= 0:
        global_gate = "slots"
        log.append("included review slots exhausted" if usage is not None else
                   "hourly cap reached (usage unavailable; conservative start-log fallback)")
    elif len(inflight(q)) >= CONFIG.get("max_inflight", 10):
        global_gate = "inflight"
        log.append(f"{len(inflight(q))} review(s) in flight (max {CONFIG.get('max_inflight', 10)})")
    else:
        while (len(q.get("starts", [])) - before_all < admissions and
               len(inflight(q)) < CONFIG.get("max_inflight", 10)):
            # Recount actual journaled reservations, including unknown delivery,
            # rather than assuming one start_one call spends exactly one slot.
            before = len(q.get("starts", []))
            _, candidate = start_one(q, log, dry, only, ignore_quiet, capture_current=capture_current)
            has_coverage = has_coverage or candidate
            # A dry run, refusal or no eligible candidate cannot reserve more.
            if dry or only or len(q.get("starts", [])) == before:
                break
            if len(inflight(q)) >= CONFIG.get("max_inflight", 10):
                break
    spent = len(q.get("starts", [])) - before_all
    return has_coverage, global_gate, max(0, slots - spent)


def slot():
    """Collect terminal reviews and admit under the tick lock; no enrollment/audit."""
    if (STATE / "runner-disabled").exists():
        return ["runner disabled for host handover"]
    q = load_queue()
    log = []
    # One short wait at most, bounded to <60s; usage can be slow/unavailable.
    # After an early local reservation expiry, the next minute retries rather
    # than trusting fullCapacityInMs as the first available slot.
    for attempt in range(2):
        collect_finished(q, log)
        usage, reserved = read_slot_usage(q)
        _, gate, remaining = admit_available(q, usage, log, reserved=reserved, capture_current=False)
        save_queue(q)
        at = now()
        deadline = refresh_slot_deadline(q, usage, remaining, gate, at=at)
        delay = (deadline - at).total_seconds()
        if attempt == 0 and 0 < delay < 60 and gate in ("slots", "cooldown"):
            time.sleep(delay)
            continue
        break
    return log


def tick(dry: bool = False, only: Optional[str] = None, ignore_quiet: bool = False) -> List[str]:
    log: List[str] = []
    if (STATE / "runner-disabled").exists():
        return ["runner disabled for host handover"]
    q = load_queue()
    fetch()
    if not dry:
        operation = "publication-request"
        try:
            backfill_runtime.publish(sys.modules[__name__], q)
            operation = "inventory"
            rollout = backfill_runtime.settings(STATE)
            if rollout and rollout.get("inventory_mode") == "integrated" and not only:
                backfill_runtime.run_inventory(sys.modules[__name__], q)
        except Exception as exc:
            # Fail closed for rank4 while retaining ordinary scheduler progress.
            if not q.get("backfill_halted") or q.get("backfill_halt_operation") == operation:
                q["backfill_halted"] = str(exc)[:300]
                q["backfill_halt_operation"] = operation
            log.append("backfill halted: " + str(exc)[:300])
    if not dry and only is None:
        budget = ForgeBudget()
        discovery = CONFIG.get("merged_discovery")
        if isinstance(discovery, dict) and discovery.get("enabled") is True:
            try:
                interval = rolling_discovery_interval(q, discovery)
            except (ValueError, TypeError, merged_reconcile.ReconcileRefused):
                log.append("merged discovery disabled: invalid configured interval")
            else:
                log += discover_merged(q, budget, interval=interval, recent=True)
        with forge_window(budget):
            refreshed = deferred_refresh.refresh_deferred(q,
                verify_source=verify_deferred_source, find_source=find_deferred_source,
                at=iso(), limit=20, may_continue=budget.available)
        if refreshed:
            # Binding/enrollment must survive a crash before reservation/dispatch.
            save_queue(q)
            log.append(f"refreshed {len(refreshed)} deferred author intent(s)")
    starts_before = len(q.get("starts", []))
    for item in list(live_items(q)):
        if item["state"] == "reviewing":
            msg = harvest_review(q, item, dry)
            if msg:
                log.append(msg)
        elif item["state"] == "addressing":
            if not dry:
                item["state"] = "repair_failed"
                item["last_error"] = "legacy addressing retained for manual reconciliation; no new dispatch"
        if not dry and item.get("repair_runs"):
            try:
                log.extend(repair_tick.harvest(sys.modules[__name__], q, item))
            except Exception as exc:
                item["last_error"] = "repair harvest failed: " + str(exc)[:300]
    if not dry:
        repair_tick.backfill(sys.modules[__name__], q)
        repair_tick.archive_legacy(sys.modules[__name__], q)
        repair_tick.reconcile_fix_prs(sys.modules[__name__], q)
    prev = parse_iso(q.get("last_tick"))
    stale_min = CONFIG.get("stale_alarm_min", 36)
    if prev and not dry and (now() - prev).total_seconds() / 60 > stale_min:
        gap = (now() - prev).total_seconds() / 60
        event("tick_gap", last_tick=q["last_tick"], gap_min=round(gap))
        log.append(f"tick gap: previous tick was {gap:.0f}m ago (> {stale_min}m) — chancellor alerted")
        notify_owner(f"crq RECOVERED after an outage: the previous completed tick was {q['last_tick']} ({gap:.0f}m ago, "
                     f"> {stale_min}m). Schedule runs may have reported 'succeeded' meanwhile. See {STATE / 'status.md'}.")
    q["last_tick"] = iso()
    log += enroll(q, dry)
    pending_at_selection = any(i["state"] == "pending" for i in live_items(q))
    usage, reserved = read_slot_usage(q)
    has_coverage, global_gate, remaining = admit_available(q, usage, log, dry, only, ignore_quiet, reserved=reserved)
    if not dry:
        q["coverage"] = coverage.record_opportunity(q.get("coverage") or coverage.new_ledger(),
            at=q["last_tick"], started=len(q.get("starts", [])) > starts_before,
            pending=pending_at_selection, candidate_exists=has_coverage,
            blocked_reason=global_gate or ("only" if only else None))
        save_queue(q)  # before the slow Paseo calls: a killed tick must not lose a launch
        refresh_slot_deadline(q, usage, remaining, global_gate)
        write_status(q)
        write_heartbeat(q)
        save_queue(q)
    return log


# ----------------------------------------------------------- status


def write_status(q: Dict[str, Any]) -> None:
    items = sorted(live_items(q), key=sort_key)
    owed_open = sum(max(0, 1 - completed_open_cycles(i)) for i in items
                    if i["kind"] == "open" and i["state"] not in ("skipped",))
    rows = []
    for i in items:
        if i["kind"] == "open":
            cyc = f"{completed_open_cycles(i)}/1"
        elif i["kind"] == author_quota.AUTHOR_KIND:
            a = i.get("author") or {}
            cyc = f"{len(i.get('author_cycles', []))}/1"
            i_extra = (f"author cycle {a.get('cycle')}: {(a.get('base') or '')[:10]}.."
                       f"{(a.get('head') or '')[:10]} → {a.get('target')}")
        else:
            cyc = f"{len(i.get('cycles', []))}/1"
        extra = i_extra if i["kind"] == author_quota.AUTHOR_KIND else ""
        if i["kind"] == "merged" and i.get("measure"):
            m = i["measure"]
            extra = f"survival {m['survival']} ({m['surviving']}/{m['added']}), focus {m['focus']}"
        last = (i.get("attempts") or [{}])[-1]
        why = i.get("wait_reason") if i["state"] == "pending" else (i.get("last_error") or "")
        if i["state"] == "promoting" and i.get("gate_stalled_at"):
            why = f"Owner intervention required — gate stalled since {i['gate_stalled_at']}; {why}"
        kind = (f"{i['kind']}{' t' + str(i['tier']) if i.get('tier') else ''}"
                f"{' new' if i.get('source') == 'followup' else ''}{' post-merge' if i.get('followup') == 'merged' else ''}")
        rows.append(f"| {i['id']} | {kind} | {i['state']} | {cyc} "
                    f"| {(i.get('pinned_base') or '')[:10]} | {last.get('outcome', '')} | {(why or '')[:110]} | {extra} |")
    sched = CONFIG.get("schedule_id")
    next_run = ""
    schedule = {"status": "systemd", "id": "crq-tick.timer"}
    if sched:
        try:
            s = paseo_json(["schedule", "inspect", sched])
            schedule = s
            next_run = f"{s.get('status')} · next run {s.get('nextRunAt')} · last run {s.get('lastRunAt')}"
        except Exception as exc:
            next_run = f"(schedule inspect failed: {exc})"[:200]
    recent = EVENTS.read_text().splitlines()[-15:] if EVENTS.exists() else []
    banner = []
    md = [f"# CodeRabbit review queue — status ({iso()})", "", *banner, *([""] if banner else []),
          f"- queue: {'**PAUSED** — ' + str(q.get('pause_reason')) if q.get('paused') else 'active'}",
          f"- schedule: `{sched}` {next_run}",
          f"- rate-limit cooldown until: {q.get('cooldown_until') or '—'}",
          f"- included review usage: {json.dumps(q.get('usage'))}; local starts in last 60m: {starts_last_hour(q)}; in flight: "
          f"{', '.join(i['id'] + ' (' + ((i.get('run') or {}).get('run_id') or 'signer ' + i['state']) + ')' for i in inflight(q)) or 'none'}",
          f"- legacy addressing: {', '.join(i['id'] + ' agent ' + i['addressing']['agent_id'][:8] for i in items if i['state'] == 'addressing') or 'none'}",
          f"- open-PR CLI reviews still owed: {owed_open}",
          "- merged-current discovery/receipt proof (retained capture T): " +
          json.dumps(status_summary.merged_current(q, STATE / "receipts"), sort_keys=True),
          f"- last tick: {q.get('last_tick')}", "",
          "| item | kind | state | cycles | pinned base | last outcome | wait / last error | supersession |",
          "|---|---|---|---|---|---|---|---|", *rows, "", "## Recent events", "", "```", *recent, "```", ""]
    md.extend(["## Repair and utilization", "", "```json",
               json.dumps({"repair": repair_tick.digest(ROOT, q),
                   "utilization": coverage.utilization_digest(q, q.get("coverage") or coverage.new_ledger(),
                       now=now(), max_starts_per_hour=CONFIG["max_starts_per_hour"])}, indent=2), "```", ""])
    (STATE / "status.md").write_text("\n".join(md))
    (STATE / "status.json").write_text(json.dumps({"generated_at": iso(), "paused": q.get("paused"),
                                                   "cooldown_until": q.get("cooldown_until"),
                                                   "items": [{k: i.get(k) for k in ("id", "kind", "state",
                                                              "prior_cycles", "cycles", "operator_priority", "optional_cycle", "pinned_base", "last_error",
                                                              "wait_reason", "gate_stalled_at")} for i in items]}, indent=2) + "\n")
    try:
        status_summary.publish(ROOT, q, CONFIG, schedule)
    except Exception as exc:
        # Preserve the last complete summary; failed publishing must not stop
        # reviews or manufacture fresh zero counters.
        event("summary_failed", error=type(exc).__name__)


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
    q = {"created_at": iso(), "items": items, "starts": [], "paused": False,
         "author_requests": {}, "author_observations": []}
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
    if (STATE / "runner-disabled").exists():
        return ["runner disabled for host handover"]
    q = load_queue()
    fetch()
    # Repair-only backfill items share the merged kind but have no PR merge.
    merged = [i for i in live_items(q) if i["kind"] == "merged"
              and not (i.get("pr") == 0 and i.get("repair_runs") and not i.get("merge_commit"))]
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


WATCHDOG_HOME = Path(os.environ.get("XDG_STATE_HOME", str(Path.home() / ".local/state"))) / "crq"


def write_heartbeat(q: Dict[str, Any]) -> None:
    """For the agent-free launchd watchdog (ops/crq-watchdog.py), which may only
    read files under ~ (TCC blocks launchd python from the external volume)."""
    try:
        WATCHDOG_HOME.mkdir(parents=True, exist_ok=True)
        tmp = WATCHDOG_HOME / ".heartbeat.json.tmp"
        tmp.write_text(json.dumps({"last_tick": q["last_tick"], "stale_alarm_min": CONFIG.get("stale_alarm_min", 36),
                                   "schedule_id": CONFIG.get("schedule_id"), "root": str(ROOT),
                                   "alert_agent_id": CONFIG.get("promotion", {}).get("alert_agent_id"),
                                   "alert_agent_host": CONFIG.get("promotion", {}).get("alert_agent_host")}) + "\n")
        tmp.replace(WATCHDOG_HOME / "heartbeat.json")
    except OSError as exc:
        event("heartbeat_failed", error=str(exc)[:200])


def cmd_selfcheck() -> int:
    print("ok: post-merge review queue")
    return 0


def with_lock(fn, *a, lock_wait=0, **kw):
    STATE.mkdir(parents=True, exist_ok=True)
    fh = LOCK.open("w")
    deadline = time.monotonic() + lock_wait
    while True:
        try:
            fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
            break
        except BlockingIOError:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                fh.close()
                print("another crq tick holds the lock; exiting", file=sys.stderr)
                return None
            time.sleep(min(0.25, remaining))
    try:
        return fn(*a, **kw)
    finally:
        fcntl.flock(fh, fcntl.LOCK_UN)
        fh.close()


def admin(action: str, item_id: Optional[str], reason: Optional[str], *,
          audit_from: Optional[str] = None, audit_at: Optional[str] = None) -> None:
    q = load_queue()
    if action in ("pause", "resume"):
        q["paused"] = action == "pause"
        q["pause_reason"] = reason if action == "pause" else None
    else:
        item = next((i for i in live_items(q) if i["id"] == item_id), None)
        if not item:
            sys.exit(f"no item {item_id}")
        if action == "requeue" and item["kind"] == review_receipt.KIND:
            raise ValueError("merged-current retries require explicit lineage/ownership authorization; needs-human")
        if action in ("prioritize", "deprioritize"):
            if item["state"] != "pending":
                raise ValueError("operator priority requires a pending item")
            if action == "prioritize":
                item["operator_priority"] = True
            else:
                item.pop("operator_priority", None)
        elif action == "requeue":
            if optional_open(item):
                item["optional_cycle"] = True
            item.update(state="pending", not_before=None, failures=0, last_error=None)
        elif action == "skip":
            item.update(state="skipped", last_error=reason or "skipped by owner")
        elif action == "block":
            item.update(state="blocked", last_error=reason or "blocked by owner")
    event(f"admin_{action}", item=item_id, reason=reason)
    save_queue(q)
    write_status(q)
    print(f"{action} ok")


def is_regular_file(path: str) -> bool:
    p = Path(path)
    try:
        return p.is_file() and not p.is_symlink()
    except OSError:
        return False


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with Path(path).open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def enroll_author(request_id: str, base: str, head: str, target: str, cycle: int,
                  review_policy: Optional[str] = None, fallback_reviewer: Optional[str] = None) -> None:
    """Supported author enrollment: create a PENDING author item in the queue.
    Never dispatches — the locked natural tick launches it when eligible."""
    q = load_queue()
    try:
        if bool(review_policy) != bool(fallback_reviewer):
            raise author_quota.AuthorRefused("--review-policy and --fallback-reviewer are required together")
        lease = (author_lease.new_lease(json.loads(Path(review_policy).read_text()),
                                       fallback_reviewer, at=iso()) if review_policy else None)
        res = author_quota.enroll(q, request_id=request_id, base=base, head=head, target=target,
                                  cycle=cycle, at=iso())
        if lease is not None:
            if res["created"]:
                res["item"]["author_lease"] = lease
            else:
                old = author_lease.read(res["item"])
                if old is None or any(old[k] != lease[k] for k in ("reviewerTimeoutMin", "reviewer")):
                    raise author_quota.AuthorRefused("cannot replace an existing request's lease policy")
    except author_quota.AuthorRefused as exc:
        sys.exit(f"author-enroll refused: {exc}")
    if res["created"]:
        event("author_enrolled", item=res["item"]["id"], request=request_id, base=base, head=head,
              target=target, cycle=cycle)
    save_queue(q)
    write_status(q)
    print(res["message"])


def author_lease_command(request_id: str, claim_fallback: bool) -> Dict[str, Any]:
    """Local protocol only; no model invocation or worker transport here."""
    q = load_queue()
    if claim_fallback:
        result = author_lease.fallback(q, request_id, at=iso())
        # Durable decision precedes response; uncertainty never authorizes retry.
        save_queue(q)
    else:
        result = author_lease.decision(author_lease.find(q, request_id))
    return result


def author_observe(manifest_path: str) -> None:
    """Charge a genuinely evidenced historical author invocation to the rolling
    hour (reserved=false). Append-only; never fabricates a counted cycle. Its
    exact use requires desk approval (see ops/author-reviews.md)."""
    q = load_queue()
    manifest = json.loads(Path(manifest_path).read_text())
    try:
        obs = author_quota.normalize_observation(manifest, now=now())
        author_quota.verify_artifacts(obs, is_regular=is_regular_file, digest_of=sha256_file)
        res = author_quota.charge_observation(q, obs, at=iso())
    except author_quota.AuthorRefused as exc:
        sys.exit(f"author-observe refused: {exc}")
    if res["charged"]:
        event("author_observed", request=obs["request_id"], started_at=obs["started_at"],
              artifacts=[a["path"] for a in obs["artifacts"]])
    save_queue(q)
    write_status(q)
    print(res["message"])


def main() -> int:
    ap = argparse.ArgumentParser(prog="crq")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("init")
    p.add_argument("--force", action="store_true")
    sub.add_parser("measure")
    p = sub.add_parser("repair-prepare", help="prepare ONE new current-tip job from a revalidated historical finding; never dispatch")
    p.add_argument("job")
    p.add_argument("--source-sha", required=True)
    p.add_argument("--revalidation", required=True, help="JSON evidence binding finding digest, source SHA/blob and named reviewer")
    p = sub.add_parser("tick")
    p.add_argument("--dry-run", action="store_true")
    p = sub.add_parser("start", help="tick restricted to one item (still honours cap/cooldown/secret scan)")
    p.add_argument("item")
    p.add_argument("--ignore-quiet", action="store_true", help="skip the quiet-window gate (active agents still block)")
    p.add_argument("--dry-run", action="store_true")
    p = sub.add_parser("author-enroll", help="enroll ONE author CLI cycle into the locked natural tick; "
                                             "creates a PENDING item and never dispatches")
    p.add_argument("--request-id", required=True)
    p.add_argument("--base", required=True, help="immutable base commit sha")
    p.add_argument("--head", required=True, help="immutable reviewed head commit sha")
    p.add_argument("--target", required=True, help=f"target ref, e.g. {DEFAULT_REF}")
    p.add_argument("--cycle", type=int, required=True, help="author cycle number (1 or 2)")
    p.add_argument("--review-policy", help="opt into leases using review.reviewerTimeoutMin from this JSON file")
    p.add_argument("--fallback-reviewer", help="configured agent reviewer identity; requires --review-policy")
    for command in ("author-lease", "author-fallback"):
        p = sub.add_parser(command, help="inspect lease or claim timed one-shot agent fallback (JSON v1)")
        p.add_argument("--request-id", required=True)
    p = sub.add_parser("author-observe", help="charge a genuinely evidenced historical author invocation to the "
                                              "rolling hour (reserved=false); desk approval required before use")
    p.add_argument("manifest", help="observation manifest JSON (binding, started_at, artifact digests)")
    p = sub.add_parser("enqueue-merged", help="enqueue affected current code; never launches inline")
    p.add_argument("--pr", type=int, required=True)
    p.add_argument("--merge-sha", required=True)
    p.add_argument("--request-id", required=True)
    p.add_argument("--target-selector", choices=sorted(review_receipt.SELECTORS), default="promoted-main")
    p = sub.add_parser("reconcile-merged", help="bounded interval inventory and enrollment; no inline dispatch")
    p.add_argument("--after", required=True)
    p.add_argument("--before", required=True)
    p.add_argument("--page-budget", type=int, required=True)
    p.add_argument("--dry-run", action="store_true")
    p = sub.add_parser("report", help="read immutable receipt manifest or bounded chunk; no dispatch")
    p.add_argument("--request-id", required=True)
    p.add_argument("--receipt-id")
    p.add_argument("--cursor")
    sub.add_parser("status")
    sub.add_parser("summary", help="refresh only the home-resident fleet summary; no ticks or reviews")
    p = sub.add_parser("synth")
    p.add_argument("pr", type=int)
    for a in ("pause", "resume"):
        p = sub.add_parser(a)
        p.add_argument("reason", nargs="?")
    for a in ("requeue", "skip", "block", "prioritize", "deprioritize"):
        p = sub.add_parser(a)
        p.add_argument("item")
        p.add_argument("reason", nargs="?")
    sub.add_parser("selfcheck", help="assert config carries no banned/third-party reviewer identity")
    p = sub.add_parser("_review")
    p.add_argument("run_id")
    args = ap.parse_args()

    if args.cmd in ("enqueue-merged", "report", "reconcile-merged"):
        try:
            if args.cmd == "reconcile-merged":
                def reconcile_command():
                    with forge_window(ForgeBudget()):
                        return reconcile_merged(load_queue(), after=args.after, before=args.before,
                                                page_budget=args.page_budget, dry_run=args.dry_run)
                result = with_lock(reconcile_command)
            elif args.cmd == "enqueue-merged":
                result = with_lock(enqueue_merged, args.pr, args.merge_sha, args.request_id, args.target_selector)
            else:
                result = current_report(args.request_id, args.receipt_id, args.cursor)
            if result is None:
                return 3
            print(json.dumps(result, sort_keys=True))
            return 0
        except (ValueError, OSError, RuntimeError, merged_reconcile.ReconcileRefused, merged_reconcile.PageFailed) as exc:
            print(f"{args.cmd} refused: {exc}", file=sys.stderr)
            return 3
    if args.cmd == "_review":
        return cmd_review_child(args.run_id)
    if args.cmd == "selfcheck":
        return cmd_selfcheck()
    if args.cmd == "init":
        with_lock(cmd_init, args.force)
    elif args.cmd == "measure":
        with_lock(cmd_measure)
    elif args.cmd == "repair-prepare":
        def prepare():
            evidence = json.loads(Path(args.revalidation).read_text())
            job_id = repair_tick.prepare_current_job(sys.modules[__name__], load_queue(),
                                                    args.job, args.source_sha, evidence)
            event("repair_prepared", origin_job=args.job, job=job_id, source_sha=args.source_sha)
            print(job_id)
        with_lock(prepare)
    elif args.cmd in ("tick", "start"):
        only = getattr(args, "item", None)
        out = with_lock(tick, args.dry_run, only, getattr(args, "ignore_quiet", False), lock_wait=90)
        for line in out or []:
            print(line)
        if not args.dry_run:
            print(f"status: {STATE / 'status.md'}")
    elif args.cmd == "status":
        q = load_queue()
        write_status(q)
        print((STATE / "status.md").read_text())
    elif args.cmd == "summary":
        q = load_queue()
        schedule = {}
        if CONFIG.get("schedule_id"):
            try:
                schedule = paseo_json(["schedule", "inspect", CONFIG["schedule_id"]])
            except Exception:
                pass
        status_summary.publish(ROOT, q, CONFIG, schedule)
        print(WATCHDOG_HOME / "summary.json")
    elif args.cmd == "synth":
        q = load_queue()
        fetch()
        item = next(i for i in live_items(q) if i["kind"] == "merged" and i["pr"] == args.pr)
        base, head, n = build_synthetic(item, git("rev-parse", DEFAULT_REF + "^{commit}"))
        print(f"PR #{args.pr}: {n} paths; base {base} head {head}")
        print(git("diff", "--shortstat", base, head))
    elif args.cmd == "author-enroll":
        with_lock(enroll_author, args.request_id, args.base, args.head, args.target, args.cycle,
                  args.review_policy, args.fallback_reviewer)
    elif args.cmd in ("author-lease", "author-fallback"):
        try:
            result = with_lock(author_lease_command, args.request_id, args.cmd == "author-fallback")
        except author_quota.AuthorRefused as exc:
            print(f"{args.cmd} refused: {exc}", file=sys.stderr)
            return 3
        if result is None:
            return 3
        print(json.dumps(result, sort_keys=True))
    elif args.cmd == "author-observe":
        with_lock(author_observe, args.manifest)
    else:
        with_lock(admin, args.cmd, getattr(args, "item", None), getattr(args, "reason", None))
    return 0


if __name__ == "__main__":
    signal.signal(signal.SIGPIPE, signal.SIG_DFL)
    sys.exit(main())
