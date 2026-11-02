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
        while not (root / ".git").exists():
            if root.parent == root:
                return None
            root = root.parent
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


def advisory(c, health, budget):
    """At most three calls, sharing the tick deadline; successful transitions settle."""
    threshold = c.CONFIG.get("discovery_incomplete_ticks", 3)
    if type(threshold) is not int or not 1 <= threshold <= 1000000:
        threshold = 3
    desired = health["incomplete_ticks"] >= threshold or (health.get("issue_open", False) and health["complete"] is False)
    if desired == health.get("issue_open", False):
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
                          "--search", '"crq: merged discovery incomplete" in:title',
                          "--limit", "100", "--json", "number,title,body"])
            matches = [r for r in rows if r.get("title") == TITLE and MARKER in (r.get("body") or "")]
            number = matches[0]["number"] if matches else None
        body = MARKER + "\nDiscovery incomplete for " + str(health["incomplete_ticks"]) + " ticks. Advisory only."
        if desired:
            if number is None:
                result = forge(["api", f"repos/{c.REPO}/issues", "-f", "title=" + TITLE, "-f", "body=" + body])
                number = result["number"]
            else:
                forge(["api", f"repos/{c.REPO}/issues/{number}", "-X", "PATCH", "-f", "state=open", "-f", "body=" + body])
            health["recovery_commented"] = False
        elif number is not None:
            if not health.get("recovery_commented"):
                forge(["api", f"repos/{c.REPO}/issues/{number}/comments", "-f", "body=" + MARKER + "\nDiscovery complete again."])
                health["recovery_commented"] = True
            forge(["api", f"repos/{c.REPO}/issues/{number}", "-X", "PATCH", "-f", "state=closed"])
        health.update(issue_open=desired, issue_number=number)


def record(c, q, *, discovery_enabled, budget=None):
    health = q.setdefault("client_health", {})
    complete = (q.get("merged_discovery") or {}).get("complete") if discovery_enabled else None
    streak = health.get("incomplete_ticks", 0)
    if complete is False:
        streak = min(1000000, streak + 1)
    elif complete is True:
        streak = 0
    sha = checkout_sha(c.ROOT)
    health.update(completed_at=c.iso(), complete=complete, incomplete_ticks=streak, sha=sha)
    # Disabled discovery is unknown, not recovery.
    if complete is None:
        return
    try:
        advisory(c, health, budget or c.ForgeBudget(requests=3, seconds=3))
    except Exception:
        pass  # Credentials, forge outages and budget exhaustion never fail a tick.
