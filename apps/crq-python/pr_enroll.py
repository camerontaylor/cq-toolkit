"""Open-PR enrollment for non-primary repositories (docs/multi-repo.md, discovery `pr`).

Each configured repo with `discovery.pr` gets one pass per tick: an open PR
whose base is that repo's default branch enrolls one kind-open item, and a PR
head whose current full range lacks equivalent captured evidence enrolls one
delta — the same equivalent-evidence rule as the primary repo's enrollment
(crq.enroll) with repo-prefixed item ids. Stacked PRs (base != default branch)
are logged and skipped in v1; merged-PR content is push ranges' concern, never
this mode's. The runner module is injected exactly like push_current receives
`crq` — no import cycle, tests pass fakes. A repo without `discovery.pr` — or
an empty repos list — does nothing at all: no forge read, no queue change, so
the primary repo's enrollment behavior stays byte-identical.
"""
import subprocess
from pathlib import Path
from typing import Any, Dict, List


def enroll(runner, q: Dict[str, Any], dry: bool) -> List[str]:
    """Per-repo open-PR enrollment; one broken repo skips only itself."""
    log: List[str] = []
    for cfg in runner.REPOS:
        if not cfg["pr"]:
            continue
        try:
            opened = runner.gh_json(["pr", "list", "--repo", cfg["repo"], "--state", "open",
                                     "--limit", "200", "--json",
                                     "number,isDraft,baseRefName,headRefName,headRefOid"])
        except Exception as exc:
            log.append(f"pr discovery skipped {cfg['repo']}: {exc}"[:300])
            continue
        log += _enroll_repo(runner, q, cfg, opened, dry)
    return log


def _enroll_repo(runner, q: Dict[str, Any], cfg: Dict[str, Any], opened: List[Dict[str, Any]],
                 dry: bool) -> List[str]:
    log: List[str] = []
    repo, branch, clone = cfg["repo"], cfg["default_branch"], Path(cfg["clone"])
    try:
        # Every local read below (quiet window, merge-base, plan) needs a current
        # default branch; ensure_commit then brings the PR head into the clone.
        runner.fetch(clone=clone, refspec=f"+refs/heads/{branch}:refs/remotes/origin/{branch}")
    except Exception as exc:
        log.append(f"pr discovery {repo}: fetch failed: {str(exc)[:200]}")
        return log
    for p in sorted(opened, key=lambda x: x["number"]):
        n, head = p["number"], p["headRefOid"]
        if p["isDraft"]:
            continue
        if p["baseRefName"] != branch:
            # No stacked-chain walking in v1 (docs/multi-repo.md): only PRs
            # targeting the repo's default branch are enrollable.
            log.append(f"pr discovery {repo}: PR #{n} targets {p['baseRefName']}, not {branch}; skipped")
            continue
        # The head must be local BEFORE any tick reads it (quiet window runs
        # before the plan), so fetch it for every enrollable PR, not only deltas.
        try:
            if not runner.ensure_commit(n, head, clone=clone):
                raise runner.NotReady("source head unavailable")
            pin = runner.git("merge-base", f"origin/{branch}", head, cwd=clone)
        except (runner.NotReady, OSError, RuntimeError, subprocess.TimeoutExpired):
            log.append(f"pr discovery {repo}: PR #{n} range identity unavailable; enrollment deferred")
            continue
        # PR numbers collide across repos: scope every lookup to this repo.
        mine = [i for i in runner.live_items(q) if i["pr"] == n and i["kind"] in ("open", "delta")
                and runner.item_repo(i) == repo]
        if not mine:
            runner.new_item(q, log, dry, id=f"{cfg['name']}-pr{n}", repo=repo, pr=n,
                            kind="open", tier=1, why="open PR not yet enrolled")
            continue
        if any(i["state"] in ("pending", "reviewing", "repairing", "blocked")
               and not runner.optional_open(i) for i in mine):
            continue
        evidence = [record for item in mine for record in item.get("cycles", [])]
        equivalent = any(record.get("base") == pin and record.get("head") == head and
                         record.get("range_policy") == "full-range-once-v1" and record.get("run_id")
                         for record in evidence)
        identity = f"{cfg['name']}-pr{n}-range-{pin[:10]}-{head[:10]}"
        if not equivalent and not any(i["id"] == identity for i in mine):
            runner.new_item(q, log, dry, id=identity, repo=repo, pr=n, kind="delta", followup="open",
                            why="current full range lacks equivalent captured evidence; retain earlier cycles/findings")
    return log
