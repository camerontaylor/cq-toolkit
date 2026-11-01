"""Shared default target; legacy names are metadata aliases, never Git refs."""

DEFAULT_BRANCH = "main"
DEFAULT_REF = f"origin/{DEFAULT_BRANCH}"
DEFAULT_FETCH_REFSPEC = f"refs/heads/{DEFAULT_BRANCH}:refs/remotes/{DEFAULT_REF}"
LEGACY_BRANCH = "merge-queue"
DISCOVERY_BRANCHES = (DEFAULT_BRANCH, LEGACY_BRANCH)
DISCOVERY_SELECTOR = f"{DEFAULT_BRANCH}-or-{LEGACY_BRANCH}"
