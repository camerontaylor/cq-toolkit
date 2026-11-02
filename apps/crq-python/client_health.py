"""Bounded, advisory runner health; queue-v1 serves only the durable snapshot."""
import datetime as dt
from pathlib import Path
import re

TITLE = "crq: merged discovery incomplete"
MARKER = "<!-- crq-discovery-health-v1 -->"


def checkout_sha(root):
    """Read Git metadata for the runner, including linked worktrees and packed refs."""
    try:
        root = Path(root).resolve()
        git = root / ".git"
        if git.is_file():
            git = (root / git.read_text().strip().removeprefix("gitdir: ")).resolve()
        head = (git / "HEAD").read_text().strip()
        if head.startswith("ref: "):
            ref = head[5:]
            common = (git / (git / "commondir").read_text().strip()).resolve() if (git / "commondir").exists() else git
            head = None
            for directory in (git, common):
                path = directory / ref
                if path.is_file():
                    head = path.read_text().strip()
                    break
            if head is None and (common / "packed-refs").exists():
                with (common / "packed-refs").open() as stream:
                    for line in stream:
                        fields = line.split()
                        if len(fields) == 2 and fields[1] == ref:
                            head = fields[0]
                            break
        return head if isinstance(head, str) and re.fullmatch(r"[0-9a-f]{40}", head) else None
    except (OSError, ValueError):
        return None


def snapshot(q):
    health = q.get("client_health", {})
    completed = health.get("completed_at")
    age = None
    if completed:
        age = max(0, (dt.datetime.now(dt.timezone.utc) -
                      dt.datetime.fromisoformat(completed.replace("Z", "+00:00"))).total_seconds())
    return {"lastCompletedTick": completed, "ageSeconds": age,
            "discoveryComplete": health.get("complete"),
            "incompleteTicks": health.get("incomplete_ticks", 0),
            "pending": sum(i.get("state") == "pending" for i in q.get("items", [])),
            "blocked": sum(i.get("state") == "blocked" for i in q.get("items", [])),
            "deployedSha": health.get("sha")}


def advisory(c, q, health, budget):
    """At most three calls, using a separate fixed budget; settled transitions are quiet."""
    threshold = c.CONFIG.get("discovery_incomplete_ticks", 3)
    if type(threshold) is not int or not 1 <= threshold <= 1000000:
        threshold = 3
    desired = health["incomplete_ticks"] >= threshold or (health.get("issue_open", False) and health["complete"] is False)
    update_due = desired and health["incomplete_ticks"] // threshold > health.get("issue_ticks", 0) // threshold
    if desired == health.get("issue_open", False) and not update_due and not health.get("opening"):
        return
    calls = 0

    def forge(args):
        nonlocal calls
        if calls >= 3 or not budget.available():
            raise RuntimeError("health advisory budget exhausted")
        calls += 1
        return c.gh_json(args)

    with c.forge_window(budget):
        number = health.get("issue_number")
        if number is None:
            rows = forge(["issue", "list", "--repo", c.REPO, "--state", "all",
                          "--limit", "100", "--json", "number,title,body"])
            matches = [r for r in rows if r.get("title") == TITLE and MARKER in (r.get("body") or "")]
            number = matches[0]["number"] if matches else None
        if number is None and health.get("opening"):
            raise RuntimeError("opening issue not yet found; attempt skipped")
        body = MARKER + "\nDiscovery incomplete for " + str(health["incomplete_ticks"]) + " ticks. Advisory only."
        if desired:
            if number is None:
                health["opening"] = True
                c.save_queue(q)  # persist intent before an ambiguous create response
                result = forge(["api", f"repos/{c.REPO}/issues", "-f", "title=" + TITLE, "-f", "body=" + body])
                number = result["number"]
                health["issue_number"] = number
                c.save_queue(q)
            else:
                forge(["api", f"repos/{c.REPO}/issues/{number}", "-X", "PATCH", "-f", "state=open", "-f", "body=" + body])
            health["recovery_commented"] = False
        elif number is not None:
            if not health.get("recovery_commented"):
                forge(["api", f"repos/{c.REPO}/issues/{number}/comments", "-f", "body=" + MARKER + "\nDiscovery complete again."])
                health["recovery_commented"] = True
            forge(["api", f"repos/{c.REPO}/issues/{number}", "-X", "PATCH", "-f", "state=closed"])
        health.update(issue_open=desired, issue_number=number, opening=False,
                      issue_ticks=health["incomplete_ticks"])


def record(c, q, *, discovery_enabled):
    health = q.setdefault("client_health", {})
    complete = (q.get("merged_discovery") or {}).get("complete") if discovery_enabled else health.get("complete")
    streak = health.get("incomplete_ticks", 0)
    if discovery_enabled and complete is False:
        streak = min(1000000, streak + 1)
    elif discovery_enabled and complete is True:
        streak = 0
    sha = checkout_sha(c.RUNNER_ROOT)
    health.update(completed_at=c.iso(), complete=complete, incomplete_ticks=streak, sha=sha)
    # Skipped discovery retains the last observation without advancing history.
    if not discovery_enabled or complete is None:
        return ["health advisory skipped: discovery not run"]
    try:
        advisory(c, q, health, c.ForgeBudget(requests=3, seconds=10))
    except Exception as exc:
        # Never include forge responses or credential-bearing exception text.
        return ["health advisory skipped or failed: " + type(exc).__name__]
    return []
