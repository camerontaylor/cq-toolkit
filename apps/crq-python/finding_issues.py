"""GitHub-issue delivery of review findings for non-primary repos (docs/multi-repo.md).

A counted completed review with at least one finding in a repo configured
`findings: "issue"` files exactly one issue in that repo: there is no PR to
comment on and repair automation stays disabled, so the issue is the whole
delivery. Creation is idempotent — an exact-title search runs before every
create — so a crash between `gh issue create` and queue settle is safe to
retry on a later tick.
"""
import json
import re
import subprocess
from typing import Any, Callable, Dict, List, Optional

# Mirrors repo_registry.DEFAULT_FINDINGS; kept local so this module stays pure
# (plain data in, no app imports — it must be importable standalone).
DEFAULT_FINDINGS = "issue"
# At most two calls per issue and two issues per tick, before admission.
# A stalled forge therefore costs at most 40 seconds and is retried later.
GH_TIMEOUT = 10
FOOTER = "Auto-filed by crq (CodeRabbit review queue). No auto-fix runs for this repository; triage manually."
# GitHub rejects an issue body over this many characters, and a rejected create
# leaves issue_pending set, so every tick would retry the identical oversized
# body. Truncation keeps the review deliverable and points at the receipt.
MAX_BODY = 65536
TRUNCATED = ("\n\n_… findings truncated to fit GitHub's issue body limit; see the receipt "
             "for the full list._")
ISSUE_URL = re.compile(r"https://github\.com/[^/\s]+/[^/\s]+/issues/(\d+)")

# gh(argv, *, input_text=None) -> object with returncode/stdout/stderr.
Gh = Callable[..., Any]


def enabled(repo_cfg: Dict[str, Any]) -> bool:
    """True iff this repo files findings as issues (absent key = the default "issue")."""
    return repo_cfg.get("findings", DEFAULT_FINDINGS) == "issue"


def title(base: str, head: str, severity_counts: Dict[str, int], item_id: str = "") -> str:
    """Fixed issue title: review identity, total findings, blocking count.

    `item_id` distinguishes split parts of one range (same base/head, same
    counts) so an exact-title search never reuses another part's issue."""
    blocking = severity_counts.get("critical", 0) + severity_counts.get("major", 0)
    suffix = f" [{item_id}]" if item_id else ""
    return (f"crq: {base[:10]}..{head[:10]} — {sum(severity_counts.values())} findings "
            f"({blocking} blocking){suffix}")


def body(meta: Dict[str, Any], findings_md: str) -> str:
    """Identity block + findings markdown + fixed footer; every field via .get.

    The findings section is truncated to the remaining budget of GitHub's
    ``MAX_BODY`` characters; the identity block and footer are always kept."""
    lines = ["## Review identity",
             f"- Repo: `{meta.get('repo', '')}`",
             f"- Item: `{meta.get('item_id', '')}`",
             f"- Run: `{meta.get('run_id', '')}`",
             f"- Range: `{meta.get('base', '')}..{meta.get('head', '')}`"]
    if meta.get("receipt_id"):
        lines.append(f"- Receipt: `{meta['receipt_id']}`")
    findings = findings_md.rstrip("\n")
    budget = MAX_BODY - len("\n".join(lines)) - len("\n\n---\n\n") - len("\n\n" + FOOTER + "\n")
    if len(findings) > budget:
        findings = findings[:max(0, budget - len(TRUNCATED))] + TRUNCATED
    return "\n".join([*lines, "", "---", "", findings, "", FOOTER, ""])


def _gh(argv: List[str], *, input_text: Optional[str] = None) -> subprocess.CompletedProcess:
    return subprocess.run(argv, capture_output=True, text=True, input=input_text, timeout=GH_TIMEOUT)


def _invoke(gh: Gh, argv: List[str], *, input_text: Optional[str] = None) -> Any:
    """One gh call; a nonzero return (or a timeout) becomes RuntimeError with the trimmed stderr."""
    try:
        p = gh(argv, input_text=input_text)
    except subprocess.TimeoutExpired as e:
        raise RuntimeError(f"{' '.join(argv[:4])} … timed out after {GH_TIMEOUT}s: {e}") from e
    except OSError as e:
        # A gh that cannot start (missing binary, spawn failure) is a delivery
        # failure like any other: RuntimeError is the one contract callers catch.
        raise RuntimeError(f"{' '.join(argv[:4])} … could not start: {e}") from e
    if getattr(p, "returncode", 0) != 0:
        stderr = (getattr(p, "stderr", "") or "").strip()[:300]
        raise RuntimeError(f"{' '.join(argv[:4])} … exit {p.returncode}: {stderr}")
    return p


def _existing(gh: Gh, repo: str, wanted: str) -> Optional[Dict[str, Any]]:
    """Exact-title (case-sensitive) match among the repo's issues; None means create."""
    argv = ["gh", "issue", "list", "--repo", repo, "--state", "all", "--limit", "20",
            "--json", "number,title,url", "--search", f'in:title "{wanted}"']
    out = _invoke(gh, argv)
    try:
        rows = json.loads(out.stdout or "[]")
    except ValueError as e:
        raise RuntimeError(f"gh issue list returned unparsable output: {(out.stdout or '').strip()[:300]}") from e
    if not isinstance(rows, list):
        raise RuntimeError(f"gh issue list returned unexpected output: {(out.stdout or '').strip()[:300]}")
    for row in rows:
        if (isinstance(row, dict) and row.get("title") == wanted
                and isinstance(row.get("number"), int) and row.get("url")):
            return {"number": row["number"], "url": row["url"]}
    return None


def file_issue(repo_cfg: Dict[str, Any], *, base: str, head: str, meta: Dict[str, Any],
               severity_counts: Dict[str, int], findings_md: str,
               gh: Optional[Gh] = None) -> Dict[str, Any]:
    """File the one issue for this repo's counted review; idempotent by exact title.

    Returns {"issue_url", "issue_number", "created"}. A repo without findings
    mode "issue" returns created=False with None url/number (delivered-noop).
    """
    if not enabled(repo_cfg):
        return {"issue_url": None, "issue_number": None, "created": False}
    gh = _gh if gh is None else gh
    repo = repo_cfg["repo"]
    wanted = title(base, head, severity_counts, meta.get("item_id", ""))
    existing = _existing(gh, repo, wanted)
    if existing:
        return {"issue_url": existing["url"], "issue_number": existing["number"], "created": False}
    out = _invoke(gh, ["gh", "issue", "create", "--repo", repo, "--title", wanted, "--body-file", "-"],
                  input_text=body(meta, findings_md))
    match = ISSUE_URL.search(out.stdout or "")
    if not match:
        raise RuntimeError(f"gh issue create returned no issue URL: {(out.stdout or '').strip()[:300]}")
    return {"issue_url": match.group(0), "issue_number": int(match.group(1)), "created": True}
