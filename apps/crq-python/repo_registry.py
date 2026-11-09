"""Per-repo review configuration; the primary repo stays top-level in config.

Multi-repo shape and semantics: docs/multi-repo.md. Parsing is fail-closed:
any unknown key, bad slug, bad timestamp or out-of-range rank refuses the
whole config, mirroring the denylist parser's posture. Rank values match the
scheduler's tiers: cq-toolkit ordinary work is 0-2, backfill/coverage/author
are 4, so a non-primary repo defaults to 3 (between ordinary and backfill).
"""
import datetime as dt
import fnmatch
import re
from typing import Any, Dict, List, Optional

SLUG = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,99}/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}")
BRANCH = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9._/-]*[A-Za-z0-9])?")
TIMESTAMP = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z")

DEFAULT_RANK = 3
MIN_RANK = 2  # a configured repo may compete with primary ordinary work, never outrank pre-merge reviews
MAX_RANK = 4  # never below backfill/coverage/author tier 4
DEFAULT_FINDINGS = "issue"
FINDINGS_MODES = ("issue", "none")

_ALLOWED = frozenset({"repo", "clone", "default_branch", "discovery", "floor", "quiet_minutes",
                      "include", "exclude", "rank_tier", "findings", "scan_extra_classes"})


def _identity(slug: Any) -> str:
    """Normalized repository identity for comparisons.

    GitHub treats owner/name as case-insensitive, so duplicate checks, the
    primary check and repository lookup all compare identities, never the raw
    spelling: `Owner/Repo` and `owner/repo` are one repository.
    """
    return slug.casefold() if isinstance(slug, str) else ""


def same_repo(left: Any, right: Any) -> bool:
    """Compare non-empty repository identities without changing their spelling."""
    return bool(_identity(left)) and _identity(left) == _identity(right)


def _refuse(entry: Any, why: str) -> None:
    slug = entry.get("repo") if isinstance(entry, dict) else None
    raise ValueError(f"repos entry {slug if isinstance(slug, str) else '?'}: {why}")


def _string_list(entry: Dict[str, Any], key: str, default: List[str]) -> List[str]:
    value = entry.get(key, default)
    if not isinstance(value, list) or (not value and key == "include"):
        _refuse(entry, f"{key} must be a non-empty list of globs" if key == "include"
                else f"{key} must be a list of globs")
    for pattern in value:
        if not isinstance(pattern, str) or not pattern or "\n" in pattern or "\r" in pattern or "\0" in pattern:
            _refuse(entry, f"{key} contains an invalid glob")
    return list(value)


def parse_entry(entry: Any) -> Dict[str, Any]:
    if not isinstance(entry, dict) or set(entry) - _ALLOWED:
        _refuse(entry, "must be an object with only known keys (see docs/multi-repo.md)")
    repo = entry.get("repo")
    if not isinstance(repo, str) or not SLUG.fullmatch(repo):
        _refuse(entry, "repo must be owner/name")
    clone = entry.get("clone")
    if not isinstance(clone, str) or not clone.strip():
        _refuse(entry, "clone path is required (host overlay supplies it)")
    clone = clone.strip()
    branch = entry.get("default_branch", "main")
    if (not isinstance(branch, str) or not BRANCH.fullmatch(branch) or ".." in branch
            or "//" in branch or branch.endswith(".lock")):
        _refuse(entry, "invalid default_branch")
    discovery = entry.get("discovery", {})
    if not isinstance(discovery, dict) or set(discovery) - {"push", "pr"}:
        _refuse(entry, "discovery may only contain push/pr booleans")
    push = discovery.get("push", True)
    pr = discovery.get("pr", False)
    if type(push) is not bool or type(pr) is not bool:
        _refuse(entry, "discovery push/pr must be booleans")
    floor = entry.get("floor")
    if floor is not None:
        if not isinstance(floor, str) or not TIMESTAMP.fullmatch(floor):
            _refuse(entry, "floor must be an ISO Z timestamp (set at deploy time)")
        try:  # the shape matches; reject impossible calendar values too
            dt.datetime.strptime(floor, "%Y-%m-%dT%H:%M:%SZ")
        except ValueError:
            _refuse(entry, "floor is not a real UTC timestamp")
    quiet = entry.get("quiet_minutes")
    if quiet is not None and (type(quiet) is not int or quiet <= 0):
        _refuse(entry, "quiet_minutes must be a positive integer")
    rank = entry.get("rank_tier", DEFAULT_RANK)
    if type(rank) is not int or not MIN_RANK <= rank <= MAX_RANK:
        _refuse(entry, f"rank_tier must be an integer in [{MIN_RANK}, {MAX_RANK}]")
    findings = entry.get("findings", DEFAULT_FINDINGS)
    if findings not in FINDINGS_MODES:
        _refuse(entry, f"findings must be one of {FINDINGS_MODES}")
    scan_extra = entry.get("scan_extra_classes", [])
    if not isinstance(scan_extra, list) or any(
            not isinstance(x, str) or not x or "\n" in x or "\r" in x or "\0" in x for x in scan_extra):
        _refuse(entry, "scan_extra_classes must be a list of denylist class ids")
    return {"repo": repo, "name": repo.split("/", 1)[1], "clone": clone, "default_branch": branch,
            "default_ref": f"origin/{branch}", "push": push, "pr": pr, "floor": floor,
            "quiet_minutes": quiet, "include": _string_list(entry, "include", ["**"]),
            "exclude": _string_list(entry, "exclude", []), "rank_tier": rank, "findings": findings,
            "scan_extra_classes": list(scan_extra)}


def parse(config: Dict[str, Any]) -> List[Dict[str, Any]]:
    entries = config.get("repos", [])
    if not isinstance(entries, list):
        raise ValueError("repos must be a list of per-repo objects")
    repos: List[Dict[str, Any]] = []
    seen = set()
    names = set()
    for entry in entries:
        parsed = parse_entry(entry)
        if _identity(parsed["repo"]) in seen:
            raise ValueError(f"repos entry duplicated: {parsed['repo']}")
        if _identity(parsed["name"]) in names:
            raise ValueError(f"repos entry name collides with another repo: {parsed['name']}")
        if _identity(parsed["repo"]) == _identity(config.get("repo")):
            raise ValueError("repos must not repeat the primary repo (top-level config owns it)")
        seen.add(_identity(parsed["repo"]))
        names.add(_identity(parsed["name"]))
        repos.append(parsed)
    return repos


def by_repo(repos: List[Dict[str, Any]], slug: Optional[str]) -> Optional[Dict[str, Any]]:
    if not slug:
        return None
    wanted = _identity(slug)
    return next((cfg for cfg in repos if _identity(cfg["repo"]) == wanted), None)


def rank_for(item: Dict[str, Any], primary: str, repos: List[Dict[str, Any]]) -> Optional[int]:
    """Scheduler rank for a non-primary repo's item; None keeps the kind's own rank.

    Legacy items without a repo field are primary. A repo removed from config
    still schedules at DEFAULT_RANK (its items surface planning errors rather
    than silently changing tier).
    """
    slug = item.get("repo") or primary
    if _identity(slug) == _identity(primary):
        return None
    cfg = by_repo(repos, slug)
    return cfg["rank_tier"] if cfg else DEFAULT_RANK


def in_scope(cfg: Dict[str, Any], path: str) -> bool:
    """fnmatch globs over the full repo-relative path; * crosses /.

    include (default **) and exclude both match full paths, so "vendored/**"
    excludes the subtree and "dist/*" also covers "dist/a/b".
    """
    if any(fnmatch.fnmatchcase(path, pattern) for pattern in cfg["exclude"]):
        return False
    return any(fnmatch.fnmatchcase(path, pattern) for pattern in cfg["include"])
