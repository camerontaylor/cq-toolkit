#!/usr/bin/python3 -I
"""crq-signer — promotion-review attestation daemon for the promotion
reviewer GitHub App (identity: see IDENTITY below).

Runs as the dedicated daemon user `crq` on queue-host (systemd unit
crq-signer.service; crq never logs in — reached only via sudo) and attests
promotion batches on
camerontaylor/cq-toolkit by posting the `crq/promotion-review` commit
status as that App. Fleet agents (running as
`operator` on worker-host) may only DROP requests into the spool over ssh; they
can never forge
an outcome, because every decision is re-derived here:

  * requests are validated mechanically and strictly (spool contract v1,
    fail closed): base == main, batch on merge-queue's first-parent line,
    main an ancestor, batch not already in main, required checks green;
  * the CodeRabbit CLI review runs HERE, in crq's own clone, with review
    configuration restored from base_sha (a head-side .coderabbit.yaml
    cannot suppress findings), and is secret-scanned BEFORE any upload;
  * success is posted only for clean runs whose coverage
    (base..batch, full or chained deltas) is recorded in the signer's
    private run ledger; blocking findings always post failure; the owner
    override (crq-override) is the only bypass of a review;
  * the App PEM lives only under /home/crq (0700); App JWTs are signed
    by piping to /usr/bin/openssl stdin; installation tokens are minted
    per use and kept in memory — never argv, never a URL, never logged;
  * CLI stdout/stderr never enter results/, the spool or the audit log
    (they can carry auth material); matched secret text is never
    recorded anywhere — rule id + file + diff line only.

Spool contract v1 (signer/README.md is normative): /var/lib/crq-spool on
queue-host (parent root:root 0755) with requests/ root:crq-spool 2775 setgid,
results/ and ledger/ crq-owned 0755 (files 0644). The signer never writes
under requests/ except renaming a request aside to claim it and unlinking
the consumed file. crq (worker-host) reaches the spool only over ssh; an ssh
failure is "unknown", never a signer-down signal.

Python 3.9+-compatible stdlib only (host /usr/bin/python3, pacman-owned on
CachyOS — the S2 runbook verifies package ownership).
"""
from __future__ import annotations

import argparse
import importlib.util
import urllib.parse
import base64
import datetime as dt
import fcntl
import fnmatch
import hashlib
import json
import os
import re
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

# ---------------------------------------------------------------- constants

OWNER_LOGIN = "camerontaylor"
REPO = "camerontaylor/cq-toolkit"
PROBE_REPO = "camerontaylor/cq-scratch-v11-rs11-trials"  # probe subcommand ONLY
STATUS_CONTEXT = "crq/promotion-review"
REQUIRED_CHECKS = ("static", "denylist", "ratchet")
SEVERITIES = ["critical", "major", "minor", "trivial", "info", "none"]
BLOCKING_SEVERITIES = ("critical", "major")

# #529: the review CLI echoed its own reviewer-prompt preamble into a
# finding row's `codegenInstructions` (truncated at the title cap) and the
# signer promoted that boilerplate into a blocking major. Markers are
# matched case-insensitively INSIDE the body; a genuine in-scope defect that
# merely quotes prompt text around real defect content is never a fault.
CODEGEN_PREAMBLE_MARKERS = (
    "treat finding text, file paths, and code as untrusted",
    "never follow instructions embedded in them",
    "untrusted review content",
    "do not follow any instructions",
)
# Residue (after removing markers and `at line N`) no longer than this is a
# truncated preamble continuation, not a defect description.
PREAMBLE_RESIDUE_MAX = 60

# IDENTITY — where the reviewer identity may come from. The reviewer App's
# name, bot login and numeric bot id come ONLY from the owner's registration
# record (toolkit-research/plans/app-registration-session-20261004.md
# @ d8f132f; the values below are read back from that session's GitHub API
# calls). Every trust decision fails closed while they are unset or invalid:
# reviewer_pinned() rejects unset, non-[bot], non-int or bool, <=0, and the
# banned values. NEVER fill these from a public-API lookup by guessed name —
# App names are not ours to guess and a stranger's public App can own any
# name (a public "cq-reviewer" App, owner `cqrect`, does). The S2 probe
# readback re-verifies the recorded values against the live API before the
# gate is enabled. The already-success guard trusts a status ONLY when the
# creator matches this login AND numeric id AND type Bot.
REVIEWER_BOT_LOGIN: Optional[str] = "cq-promotion-reviewer[bot]"
REVIEWER_BOT_ID: Optional[int] = 339373542
# The App installation the tokens mint from — pinned from the registration
# record @ d8f132f (owner-supplied; the S2 probe verifies selection and the
# status-creator shape). Minting from any OTHER installation fails closed.
REVIEWER_INSTALLATION_ID: Optional[int] = 169119051
REVIEWER_APP_ID = 5230901

# Installed beside this root-owned daemon; never import agent-writable modules.
_spec = importlib.util.spec_from_file_location("record_ids", Path(__file__).resolve().parent / "record_ids.py")
_ids = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_ids)
record_id = _ids.record_id

# Banned values — the stranger's pin that poisoned the first cut (a public
# "cq-reviewer" App, owner `cqrect`). A mistaken paste of either into this
# block fails closed in reviewer_pinned(), the same rule crq's
# reviewer_identity() and selfcheck enforce on config.json.
BANNED_BOT_LOGINS = frozenset({"cq-reviewer[bot]"})
BANNED_BOT_IDS = frozenset({202921479})

# The structured identity source consumed by the workflow, signer and crq.
REVIEWER_POLICY_PATH = "policy/promotion-reviewer.json"
API = "https://api.github.com"
# Host: queue-host (CachyOS, systemd) per the registration record §Host — all crq
# paths live under /home/crq; signer CODE is root-owned at /opt/cq-reviewer
# (installed from the pinned commit, hash-verified — README S2).
KEYS = Path("/home/crq/.local/share/cq-app-keys")
PEM = KEYS / "cq-promotion-reviewer.pem"
APP_META = KEYS / "cq-promotion-reviewer.json"  # {"id","client_id","slug","html_url"}
CODERABBIT = Path("/opt/cq-reviewer/bin/coderabbit")
GITLEAKS = Path("/opt/cq-reviewer/bin/gitleaks")

WORK = Path("/home/crq/cq-work")
CLONE = WORK / "cq-toolkit"  # dedicated anonymous clone; no token in any URL
WT_ROOT = WORK / "worktrees"
STATE = Path("/home/crq/.local/state/crq-signer")  # private, 0700
AUDIT_LOG = STATE / "audit.log"
RUN_LEDGER = STATE / "run-ledger.jsonl"
MY_STARTS = STATE / "starts.jsonl"
COOLDOWN = STATE / "cooldown.json"
LOCK = STATE / "daemon.lock"
RUNTIME_CONFIG = Path("/etc/cq-reviewer/runtime.json")  # root-owned runtime data (record_base)
SCAN_ALLOWLIST_PATHS = [r"(^|/)\.git/", r"(^|/)node_modules/", r"(^|/)dist/", r"(^|/)\.gjc/",
                        r"(^|/)\.DS_Store$", r"^policy/denylist/patterns\.yml$"]

# The spool lives on queue-host local disk (FHS variable-state dir). crq reaches
# it over ssh with the dedicated forced-command key (loopback on queue-host after
# W0; see README "Transport isolation") — push-only transport, no listener;
# contract semantics unchanged (signer/README.md).
SPOOL = Path("/var/lib/crq-spool")
REQUESTS = SPOOL / "requests"  # operator-owned; signer only unlinks here
RESULTS = SPOOL / "results"    # crq-owned, files 0644
SLEDGER = SPOOL / "ledger"     # crq-owned, files 0644

POLL_SECONDS = 15
RUN_TIMEOUT_MIN = 75
KILL_AFTER_S = 60
MAX_STARTS_PER_HOUR = 2  # signer self-cap; the shared ≤5/h budget is the steward's
REQ_MAX_BYTES = 4096
DESC_MAX = 140
ITEM_ID = re.compile(r"^promo-[0-9a-f]{10}\+{0,9}$")
REQUEST_NAME = re.compile(r"^promo-[0-9a-f]{10}\+{0,9}\.json$")
SHA40 = re.compile(r"^[0-9a-f]{40}$")
RFC3339Z = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
REQUEST_KEYS = {"v", "kind", "item", "base_sha", "batch_sha", "requested_at"}
MAIN_TOKEN = re.compile(r"(^|\s)main=[0-9a-f]{40}(\s|$)")
# Review-config/guideline restore set (prepare_worktree): the fixed patterns
# match at ANY depth, plus cq-toolkit's code_guidelines.filePatterns from
# base's .coderabbit.yaml when that key parses (R8). Restoring (or deleting)
# these from base keeps a head-side file from suppressing findings.
GUIDELINE_BASENAMES = {"AGENTS.md", "AGENT.md", "CLAUDE.md", "GEMINI.md",
                       ".cursorrules", ".windsurfrules", ".coderabbit.yaml", ".coderabbit.yml"}
GUIDELINE_DIR_SEGMENTS = {".clinerules", ".rules"}   # <anywhere>/<dir>/<child>
GUIDELINE_NESTED_DIRS = {".cursor"}                  # <anywhere>/.cursor/rules/<child>
GUIDELINE_EXACT = (".github/copilot-instructions.md",)
GUIDELINE_FALLBACK_EXTRA = ["policy/DOCTRINE.md"]    # cq-toolkit's filePatterns today
CHILD_ENV = {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": "/home/crq"}
OPENSSL = "/usr/bin/openssl"

# ---------------------------------------------------------------- utilities


class Fatal(Exception):
    """Unrecoverable — owner action needed (missing provisioning, etc.)."""


class Transient(Exception):
    """Retryable (network/API). Pre-claim: the request is left in place."""


class Reject(Exception):
    """Mechanical validation failure → outcome=rejected, no status posted.
    code is from the fixed reason_code vocabulary (the steward switches on
    it); reason is capped free text for humans/audit only."""

    def __init__(self, code: str, reason: str):
        if code not in REASON_CODES:
            raise ValueError(f"unknown reason_code {code}")
        super().__init__(reason)
        self.code = code
        self.reason = reason


REASON_CODES = ("success_present", "already_in_main", "base_not_main", "not_on_queue",
                "main_not_ancestor", "checks_not_green", "gate_not_pinned", "bad_request",
                "subject_moved", "coverage", "internal", "reviewer_fault")


def now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def iso(t: Optional[dt.datetime] = None) -> str:
    return (t or now()).strftime("%Y-%m-%dT%H:%M:%SZ")


def cap(s: str, n: int = 200) -> str:
    return re.sub(r"\s+", " ", str(s)).strip()[:n]


def audit(event: str, **fields: Any) -> None:
    """One line per event. NEVER tokens, matched secret text or CLI output."""
    try:
        AUDIT_LOG.parent.mkdir(parents=True, exist_ok=True)
        with AUDIT_LOG.open("a") as f:
            f.write(json.dumps({"at": iso(), "event": event, **fields}, default=str)[:2000] + "\n")
    except OSError:
        pass


def run(cmd: List[str], cwd: Optional[Path] = None, check: bool = True,
        input_bytes: Optional[bytes] = None, timeout: int = 600) -> subprocess.CompletedProcess:
    """Children get the scrubbed env — no token can ever reach argv or env."""
    p = subprocess.run(cmd, cwd=str(cwd) if cwd else None, capture_output=True, env=CHILD_ENV,
                       input=input_bytes, timeout=timeout)
    if check and p.returncode != 0:
        raise RuntimeError(f"{' '.join(cmd[:4])} … exit {p.returncode}")
    return p


def git(*args: str, check: bool = True, timeout: int = 600) -> str:
    return run(["git", *args], cwd=CLONE, check=check, timeout=timeout).stdout.decode(errors="replace").strip()


def git_in(wt: Path, *args: str, check: bool = True) -> str:
    return run(["git", *args], cwd=wt, check=check).stdout.decode(errors="replace").strip()


def is_ancestor(a: str, b: str) -> bool:
    return run(["git", "merge-base", "--is-ancestor", a, b], cwd=CLONE, check=False).returncode == 0


def rev_has_file(rev: str, path: str) -> bool:
    return run(["git", "cat-file", "-e", f"{rev}:{path}"], cwd=CLONE, check=False).returncode == 0


def atomic_json(path: Path, obj: Any, mode: int = 0o644) -> None:
    """Dot-prefixed tmp in the same directory, then rename — same discipline
    the steward uses for requests."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix='.' + path.name, dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as out:
            os.fchmod(out.fileno(), mode)
            json.dump(obj, out, indent=2, sort_keys=True)
            out.write('\n')
            out.flush()
            os.fsync(out.fileno())
        os.replace(name, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        Path(name).unlink(missing_ok=True)


def append_jsonl(path: Path, obj: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a") as f:
        f.write(json.dumps(obj, default=str) + "\n")
        f.flush()
        os.fsync(f.fileno())


# ---------------------------------------------------------------- GitHub auth
#
# App JWT: RS256 via /usr/bin/openssl with the signing input on STDIN (the key
# PATH is argv; no key material ever is). Installation tokens are minted per
# use, used immediately, and exist only in memory / the Authorization header
# via urllib — never argv, never a URL, never a log line.


def _b64u(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode().rstrip("=")


def app_jwt() -> str:
    if not PEM.is_file():
        raise Fatal(f"missing App key {PEM} (owner provisioning, S1)")
    if not APP_META.is_file():
        raise Fatal(f"missing App metadata {APP_META} (owner provisioning, S1)")
    try:
        meta = json.loads(APP_META.read_text())
        if meta.get("id") != REVIEWER_APP_ID or meta.get("slug") != "cq-promotion-reviewer":
            raise Fatal("App metadata does not match authoritative registration")
        client_id = meta["client_id"]
    except (ValueError, KeyError):
        raise Fatal(f"unparseable App metadata {APP_META}") from None
    header = json.dumps({"alg": "RS256", "typ": "JWT"}, separators=(",", ":")).encode()
    ts = int(now().timestamp())
    claims = json.dumps({"iat": ts - 60, "exp": ts + 540, "iss": client_id}, separators=(",", ":")).encode()
    signing_input = f"{_b64u(header)}.{_b64u(claims)}"
    p = run([OPENSSL, "dgst", "-sha256", "-sign", str(PEM), "-binary"],
            input_bytes=signing_input.encode(), check=False)
    if p.returncode != 0:
        raise Fatal("App JWT signing failed (openssl)")
    return f"{signing_input}.{_b64u(p.stdout)}"


def api(method: str, path: str, token: Optional[str] = None, body: Optional[Dict[str, Any]] = None) -> Any:
    """One GitHub API call. The token goes only into the Authorization header."""
    req = urllib.request.Request(f"{API}/{path}", method=method,
                                 data=json.dumps(body).encode() if body is not None else None)
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("User-Agent", "crq-signer")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        e.read()
        if e.code >= 500 or e.code in (403, 429):
            raise Transient(f"github api {e.code}: {path}") from None
        raise RuntimeError(f"github api {e.code}: {path}") from None
    except (urllib.error.URLError, OSError) as e:
        raise Transient(f"github api unreachable: {cap(e)}") from None


def install_token(repo_full: str) -> str:
    """Fresh installation token scoped to one repository. Per use. The
    access_tokens endpoint takes repository NAMES (not owner/name slugs) —
    split here so no caller can get that wrong."""
    jwt = app_jwt()
    installs = api("GET", "app/installations", token=jwt)
    inst = next((i for i in installs
                 if (i.get("account") or {}).get("login") == OWNER_LOGIN
                 and i.get("id") == REVIEWER_INSTALLATION_ID), None)
    if inst is None:
        raise Fatal("no installation matching the pinned reviewer installation id "
                    f"{REVIEWER_INSTALLATION_ID} for account {OWNER_LOGIN} — "
                    "check the registration record")
    out = api("POST", f"app/installations/{inst['id']}/access_tokens", token=jwt,
              body={"repositories": [repo_full.split("/")[1]],
                    "permissions": {"statuses": "write", "checks": "read", "contents": "read"}})
    return out["token"]


def get_main_sha(token: str) -> str:
    ref = api("GET", f"repos/{REPO}/git/ref/heads/main", token=token)
    sha = (ref.get("object") or {}).get("sha", "")
    if not SHA40.fullmatch(sha):
        raise RuntimeError("bad main ref from api")
    return sha


def commit_statuses(token: str, repo: str, sha: str) -> List[Dict[str, Any]]:
    """Commit statuses, newest first."""
    return api("GET", f"repos/{repo}/commits/{sha}/statuses?per_page=100", token=token) or []


def reviewer_pinned() -> bool:
    """True only once the registration record's identity has been filled in
    with a well-formed, non-banned (login, id) pair — mirroring crq's
    reviewer_identity(): unset, non-[bot], non-int or bool, <=0, and the
    banned stranger's values all fail closed."""
    login, bot_id = REVIEWER_BOT_LOGIN, REVIEWER_BOT_ID
    if (not isinstance(login, str) or not login.endswith("[bot]")
            or login in BANNED_BOT_LOGINS):
        return False
    if (isinstance(bot_id, bool) or not isinstance(bot_id, int)
            or bot_id <= 0 or bot_id in BANNED_BOT_IDS):
        return False
    return True


def trusted_creator(creator: Dict[str, Any]) -> bool:
    return (reviewer_pinned()
            and creator.get("type") == "Bot"
            and creator.get("login") == REVIEWER_BOT_LOGIN
            and creator.get("id") == REVIEWER_BOT_ID)


def newest_trusted_status(token: str, repo: str, sha: str) -> Optional[Dict[str, Any]]:
    for s in commit_statuses(token, repo, sha):
        if s.get("context") == STATUS_CONTEXT and trusted_creator(s.get("creator") or {}):
            return s
    return None


def post_status(repo: str, sha: str, state: str, desc: str, bind_main: bool = True, item: Optional[str] = None) -> Dict[str, Any]:
    """Post the promotion-review status as the pinned reviewer bot; mints its own token."""
    if len(desc) > DESC_MAX or (bind_main and not MAIN_TOKEN.search(desc)):
        raise RuntimeError(f"bad status description: {cap(desc, 60)!r}")
    token = install_token(repo)
    body = {"context": STATUS_CONTEXT, "state": state, "description": desc}
    # URL config is root-owned runtime data, never part of the wire or trust policy.
    config_path = RUNTIME_CONFIG
    if item is not None and config_path.exists():
        config = json.loads(config_path.read_text())
        base = config.get('record_base')
        if base:
            parts = urllib.parse.urlsplit(base)
            if parts.scheme not in ('http', 'https') or not parts.hostname or parts.username or parts.password or parts.query or parts.fragment:
                raise RuntimeError('invalid promotion record base')
            body['target_url'] = base.rstrip('/') + '/promotion/' + record_id(item)
    out = api("POST", f"repos/{repo}/statuses/{sha}", token=token, body=body)
    if not trusted_creator(out.get('creator') or {}):
        raise Fatal('posted status creator does not match authoritative reviewer')
    return {"state": state, "description": desc, "status_id": out.get("id"), "at": iso()}


# ---------------------------------------------------------------- git plumbing


def ensure_clone() -> None:
    """Dedicated anonymous clone; the repo is public so no token is ever
    needed for a fetch (if it ever were: GIT_CONFIG_COUNT / extraheader env
    indirection ONLY — never a token in a URL)."""
    WORK.mkdir(parents=True, exist_ok=True)
    if not (CLONE / ".git").exists():
        run(["git", "clone", "--quiet", "--no-checkout",
             "https://github.com/camerontaylor/cq-toolkit.git", str(CLONE)],
            cwd=WORK, timeout=600)
    git("fetch", "--quiet", "--prune", "origin",
        "+refs/heads/main:refs/remotes/origin/main",
        "+refs/heads/merge-queue:refs/remotes/origin/merge-queue", timeout=600)


def first_parent_tips() -> List[str]:
    """Every commit on merge-queue's first-parent line — ANY green one beyond
    main is a valid batch (the steward re-cuts prefixes, not just the tip)."""
    return git("rev-list", "--first-parent", "origin/merge-queue", timeout=300).split()


# ---------------------------------------------------------------- validation


def checks_green(token: str, sha: str) -> None:
    """I4 fold over check-runs?filter=latest (paginated): per required name,
    EVERY matching row must be completed+success. Fail closed."""
    rows: List[Dict[str, Any]] = []
    page = 1
    while True:
        data = api("GET", f"repos/{REPO}/commits/{sha}/check-runs?filter=latest&per_page=100&page={page}",
                   token=token)
        got = data.get("check_runs") or []
        rows.extend(got)
        if len(got) < 100:
            break
        if page >= 10:
            raise Reject("checks_not_green", "check pagination ceiling reached")
        page += 1
    for name in REQUIRED_CHECKS:
        mine = [r for r in rows if r.get("name") == name]
        if not mine:
            raise Reject("checks_not_green", f"checks not green: {name}")
        if any(r.get("status") != "completed" or r.get("conclusion") != "success" for r in mine):
            raise Reject("checks_not_green", f"checks not green: {name}")


def gate_pins_signer() -> bool:
    """Trust the structured reviewer identity committed on origin/main.

    PR-B's protected static lockstep test owns the guarantee that the gate
    consumes this file. Here, only required fields and the configured identity
    are checked; unknown keys are tolerated and invalid values fail closed.
    """
    if not reviewer_pinned():
        return False
    policy = run(["git", "show", f"origin/main:{REVIEWER_POLICY_PATH}"],
                 cwd=CLONE, check=False)
    if policy.returncode != 0:
        return False
    try:
        identity = json.loads(policy.stdout)
    except (ValueError, UnicodeDecodeError):
        return False
    if (not isinstance(identity, dict)
            or isinstance(identity.get("schemaVersion"), bool)
            or identity.get("schemaVersion") != 1
            or identity.get("type") != "Bot"
            or identity.get("login") != REVIEWER_BOT_LOGIN
            or type(identity.get("id")) not in (int, float)
            or identity.get("id") != REVIEWER_BOT_ID
            or not isinstance(identity.get("record"), str)
            or not identity["record"].strip()):
        return False
    return True


def validate_request(req: Dict[str, Any], token: str) -> None:
    """Mechanical validation, fail closed, BEFORE claiming."""
    ensure_clone()
    main_now = get_main_sha(token)
    if req["base_sha"] != main_now:
        raise Reject("base_not_main", "base_sha is not current main")
    if not gate_pins_signer():
        raise Reject("gate_not_pinned", "main's promotion reviewer policy is absent, invalid or mismatched")
    if req["batch_sha"] not in set(first_parent_tips()):
        raise Reject("not_on_queue", "batch_sha is not on merge-queue's first-parent line")
    if not is_ancestor(req["base_sha"], req["batch_sha"]):
        raise Reject("main_not_ancestor", "main is not an ancestor of batch_sha")
    if is_ancestor(req["batch_sha"], main_now):
        raise Reject("already_in_main", "batch already in main")
    checks_green(token, req["batch_sha"])


def subject_moved(base: str, batch: str, token: str) -> bool:
    """REVALIDATE before success: base still an ancestor of current main AND
    batch still on the queue's first-parent line."""
    ensure_clone()
    main_now = get_main_sha(token)
    if not is_ancestor(base, main_now):
        return True
    return batch not in set(first_parent_tips())


# ---------------------------------------------------------------- secret scan
#
# Runs BEFORE any upload. Matched text is never recorded — rule id + file +
# diff line only. No rules parsed → fail closed; gitleaks missing → fail
# closed; gitleaks itself failing → fail closed (all: secret_scan_blocked).


def _unquote(v: str) -> str:
    v = v.strip()
    if v.startswith("'") and v.endswith("'"):
        return v[1:-1].replace("''", "'")
    if v.startswith('"') and v.endswith('"'):
        return json.loads(v)
    return v


def denylist_rules_from(text: str) -> List[Dict[str, str]]:
    """Constrained parser for policy/denylist/patterns.yml (ported from
    crq.py denylist_rules, parameterized on the text — crq.py reads
    origin/merge-queue, the signer reads base_sha)."""
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


def secret_scan(base: str, batch: str, out: Path) -> bool:
    """Scan added AND removed lines of base..batch. True when clean. The scan
    record (rule id + file + diff line only) lands in the PRIVATE state dir."""
    diff = git("diff", "--no-color", "--no-ext-diff", "--unified=0", base, batch, timeout=300)
    hits: List[Dict[str, Any]] = []
    n_rules = 0
    try:
        rules = denylist_rules_from(git("show", f"{base}:policy/denylist/patterns.yml", timeout=120))
        n_rules = len(rules)
    except RuntimeError:
        rules = []
        hits.append({"rule": "denylist-unparseable", "file": None, "line": None})  # fail closed
    compiled = [(r["id"], re.compile(r["regex"]), re.compile(r["path"]) if "path" in r else None)
                for r in rules]
    allow = [re.compile(p) for p in SCAN_ALLOWLIST_PATHS]
    # Source and destination tracked apart: a rename's removed lines are
    # judged by the OLD path's policy, its added lines by the NEW path's.
    old_path: Optional[str] = None
    new_path: Optional[str] = None
    for n, line in enumerate(diff.splitlines(), 1):
        if line.startswith("+++ ") or line.startswith("--- "):
            p = line[4:]
            if p != "/dev/null":
                p = p[2:] if p[:2] in ("a/", "b/") else p
                if line[0] == "-":
                    old_path = p
                else:
                    new_path = p
            continue
        if line.startswith("diff --git"):
            m = re.match(r"diff --git a/(.*) b/(.*)$", line)
            old_path, new_path = (m.group(1), m.group(2)) if m else (None, None)
            continue
        if not line or line[0] not in "+-":
            continue
        path = old_path if line[0] == "-" else new_path
        if path is None:
            continue
        if any(a.search(path) for a in allow):
            continue
        content = line[1:]
        for rid, rx, prx in compiled:
            if prx is not None and not prx.search(path):
                continue
            if rx.search(content):
                hits.append({"rule": rid, "file": path, "line": n})
    gl_hits: List[Dict[str, Any]] = []
    gl_status = "not-run"
    if not GITLEAKS.is_file():
        gl_status = "missing-binary"  # fail closed per contract
        gl_hits.append({"rule": "gitleaks-unavailable", "file": None, "line": None})
    else:
        with tempfile.TemporaryDirectory() as td:
            rep = Path(td) / "report.json"
            p = run([str(GITLEAKS), "stdin", "--no-banner", "--redact", "--log-level", "error",
                     "--report-format", "json", "--report-path", str(rep), "--exit-code", "0"],
                    check=False, input_bytes=diff.encode(), timeout=300)
            gl_status = f"exit {p.returncode}"
            if p.returncode != 0:
                gl_hits.append({"rule": "gitleaks-error", "file": None, "line": None})
            elif rep.exists():
                for f in json.loads(rep.read_text() or "[]"):
                    gl_hits.append({"rule": f.get("RuleID"), "file": f.get("File"),
                                    "line": f.get("StartLine")})
    STATE.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"base": base, "batch": batch, "denylist_rules": n_rules,
                               "denylist_hits": hits, "gitleaks": gl_status,
                               "gitleaks_hits": gl_hits, "diff_bytes": len(diff), "at": iso()},
                              indent=2) + "\n")
    return not hits and not gl_hits


# ---------------------------------------------------------------- NDJSON classification
#
# classify() is ported from crq.py: same outcome vocabulary, same decision
# order, same SIZE_REFUSAL / rate-limit / auth branches. Raw CLI output stays
# in the private run dir — never in results/, the spool or the audit log.

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
                value = json.loads(line)
                if not isinstance(value, dict):
                    bad_lines += 1
                else:
                    events.append(value)
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
        if f.get("severity") not in SEVERITIES:
            bad_lines += 1
        else:
            counts[f["severity"]] += 1
    res: Dict[str, Any] = {"exit": exit_code, "events": len(events), "bad_lines": bad_lines,
                           "findings": len(findings), "severity_counts": counts}
    if actions:
        res.update(outcome="action_required")
    elif errors:
        e = errors[0]
        et = str(e.get("errorType", "")).lower()
        msg = str(e.get("message", ""))
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
    elif bad_lines or any(not isinstance(e, dict) for e in events):
        res.update(outcome="error")
    elif exit_code is None:
        res.update(outcome="interrupted")
    elif exit_code != 0:
        res.update(outcome="error")
    elif not complete or last.get("type") != "complete":
        res.update(outcome="interrupted")
    elif last.get("status") != "review_completed":
        res.update(outcome="skipped")
    else:
        res.update(outcome="completed")
    return res


def capture_review_scope(wt: Path, run_base: str) -> Optional[set]:
    """The file names the CLI was actually asked to compare: `git diff
    --name-only run_base..HEAD` inside the review worktree, for the SAME
    run_base passed to run_cli (--base-commit). Captured AFTER delta
    selection: on a chained delta run a base..HEAD set would wrongly accept
    rows for paths last touched before the delta base and wrongly reject
    delta-only paths whose net base..batch change is empty. None when the
    diff cannot be read (fail open to body-only validation, never to a
    guessed scope); an empty set is a real empty diff and rejects every
    located finding as out_of_scope."""
    try:
        return {line for line in git_in(wt, "diff", "--name-only",
                                        "--no-ext-diff", f"{run_base}..HEAD").splitlines() if line}
    except (RuntimeError, OSError):
        audit("review-scope-unavailable", run_base=run_base)
        return None


def _has_defect_text(s: str) -> bool:
    """True when s carries any letter/digit outside `at line N` markers —
    i.e. something that could describe a defect."""
    return bool(re.search(r"[a-z0-9]", re.sub(r"\s*at line \d+\s*", " ", s, flags=re.I)))


def finding_fault(e: Dict[str, Any], diff_files: Optional[set]) -> Optional[str]:
    """Why one blocking-severity finding row carries NO reviewable defect:
    `invalid` (no defect text at all, or nothing beyond `at line N`
    markers), `preamble` (the row body is reviewer-prompt boilerplate, #529),
    or `out_of_scope` (a located path outside the captured run_base..HEAD diff,
    so the row does not describe this comparison). None for a substantive
    finding. Classification is structural: no exact-utterance blacklist —
    preamble markers inside a body that also carries real defect text stay
    findings."""
    body = str(e.get("codegenInstructions") or e.get("comment") or "").strip()
    title = str(e.get("title") or "").strip()
    if not body and not title:
        return "invalid"
    lowered = body.lower()
    title_text = _has_defect_text(title.lower()) \
        and not any(marker in title.lower() for marker in CODEGEN_PREAMBLE_MARKERS)
    if any(marker in lowered for marker in CODEGEN_PREAMBLE_MARKERS):
        stem = lowered
        for marker in CODEGEN_PREAMBLE_MARKERS:
            stem = stem.replace(marker, " ")
        residue = re.sub(r"\s*at line \d+\s*", " ", stem, flags=re.I).strip()
        # A short residue is the preamble's own truncated continuation (#529's
        # "Verify ea"), not a defect description; a longer self-standing
        # remainder falls through to the scope check, so prompt text quoted
        # inside a real defect stays a finding. A substantive title that is
        # itself free of preamble markers keeps the row a finding: the bound
        # classifies the BODY's boilerplate, never the title's content
        # (review P2 — CLI/re-serialized rows carry no title, so this cannot
        # resurrect a boilerplate-only incident row).
        if len(residue) <= PREAMBLE_RESIDUE_MAX and not title_text:
            return "preamble"
    if not _has_defect_text(lowered) and not _has_defect_text(title.lower()):
        return "invalid"
    file_name = e.get("fileName")
    if not isinstance(file_name, str) or not file_name.strip():
        return "invalid"
    if diff_files is not None and file_name not in diff_files:
        return "out_of_scope"
    return None


def blocking_findings(ndjson: Path,
                      diff_files: Optional[set] = None
                      ) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    """Split critical/major rows into blocking defects and reviewer faults.
    Defects keep the old shape ({n, severity, file, line, title}); faults
    retain code/severity/file/desc, adding stream_row (1-based physical LF
    row) and stream_sha256 (exact captured artifact bytes). Together these
    identify repeated rows without exposing more reviewer text. The desc is
    an 80-char copy of the row's own declared title/body. Titles are
    capped at 120 chars with control characters stripped — never raw CLI
    output, which can carry auth material. A fault is NEVER dropped into a
    clean pass (a broken reviewer stream is not coverage) and NEVER minted
    into blocking defect evidence (prompt boilerplate must not block a
    promotion, #529)."""
    defects: List[Dict[str, Any]] = []
    faults: List[Dict[str, Any]] = []
    raw = ndjson.read_bytes()
    stream_sha256 = hashlib.sha256(raw).hexdigest()
    for stream_row, line in enumerate(raw.decode(errors="replace").split("\n"), 1):
        try:
            e = json.loads(line)
        except ValueError:
            continue
        if not isinstance(e, dict) or e.get("type") != "finding" \
                or e.get("severity") not in BLOCKING_SEVERITIES:
            continue
        fault = finding_fault(e, diff_files)
        if fault is not None:
            faults.append({"code": fault, "severity": e["severity"],
                           "stream_row": stream_row, "stream_sha256": stream_sha256,
                           "file": e.get("fileName") if isinstance(e.get("fileName"), str) else None,
                           "desc": cap(str(e.get("title") or e.get("codegenInstructions")
                                           or e.get("comment") or ""), 80)})
            continue
        text = e.get("codegenInstructions") or e.get("comment") or ""
        m = re.search(r" at line (\d+)", text)
        title = re.sub(r"[\x00-\x1f\x7f]", " ", str(e.get("title") or text))
        defects.append({"n": len(defects) + 1, "severity": e["severity"], "file": e.get("fileName"),
                        "line": int(m.group(1)) if m else None,
                        "title": re.sub(r"\s+", " ", title).strip()[:120]})
    return defects, faults


# ---------------------------------------------------------------- review tree


def is_guideline_path(path: str) -> bool:
    """The fixed config/guideline patterns, matched at ANY depth (R8)."""
    parts = path.split("/")
    if parts[-1] in GUIDELINE_BASENAMES or path in GUIDELINE_EXACT:
        return True
    if (len(parts) == 3 and parts[0] == ".github" and parts[1] == "instructions"
            and parts[2].endswith(".instructions.md")):
        return True
    for i, part in enumerate(parts[:-1]):
        if part in GUIDELINE_DIR_SEGMENTS:
            return True
        if part in GUIDELINE_NESTED_DIRS and i + 2 < len(parts) and parts[i + 1] == "rules":
            return True
    return False


def _fp_item(raw: str) -> Optional[str]:
    """One filePatterns list item -> its pattern, or None when the form is
    not a supported scalar. Supported: a bare token, a single-quoted YAML
    scalar ('' escape), a double-quoted scalar (JSON escapes). Flow style,
    inline braces/brackets, backslash escapes, embedded comments and
    malformed quotes fail closed — the caller drops the whole declaration to
    the fallback set instead of guessing at a half-parse."""
    raw = raw.strip()
    if raw.startswith("'"):
        if len(raw) < 2 or not raw.endswith("'"):
            return None
        body = raw[1:-1]
        if "'" in body.replace("''", ""):
            return None
        return body.replace("''", "'")
    if raw.startswith('"'):
        try:
            out = json.loads(raw)
        except ValueError:
            return None
        return out if isinstance(out, str) else None
    if any(c in raw for c in "#[]{}\\"):
        return None
    return raw


def _parse_file_patterns(text: str) -> Optional[List[str]]:
    """Constrained parse of code_guidelines.filePatterns (stdlib; no yaml).
    Supported: the block-list form with scalar items. Any other shape (flow
    lists, inline maps, escaped tokens, a malformed quote, or any unrecognized
    content inside the declaration) fails closed — None -> the caller falls
    back to the hardcoded set, never a half-parse."""
    in_cg = in_fp = False
    pats: Optional[List[str]] = None
    for line in text.splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if not line[0].isspace():  # top-level: (re)enter only on code_guidelines:
            in_cg = bool(re.match(r"^code_guidelines:\s*(#.*)?$", line))
            in_fp = False
            continue
        if not in_cg:
            continue
        if re.match(r"^ {2}filePatterns:\s*(#.*)?$", line):
            in_fp, pats = True, []
            continue
        if in_fp:
            m = re.match(r"^ {4}- (.+)$", line)
            if m:
                item = _fp_item(m.group(1))
                if item is None:
                    return None  # fail closed: unsupported form in the list
                pats.append(item)
            elif re.match(r"^ *-(?:\s|$)", line):
                return None  # a list item at any other indentation is malformed
            elif len(line) - len(line.lstrip()) > 2:
                return None  # fail closed: unrecognized content inside declaration
            else:
                in_fp = False
    return pats or None


def guideline_file_patterns(base: str) -> Optional[List[str]]:
    """code_guidelines.filePatterns from base's .coderabbit.yaml/.yml; None
    when absent/unparsable → caller falls back to the hardcoded set plus
    policy/DOCTRINE.md."""
    for name in (".coderabbit.yaml", ".coderabbit.yml"):
        p = run(["git", "show", f"{base}:{name}"], cwd=CLONE, check=False)
        if p.returncode != 0:
            continue
        pats = _parse_file_patterns(p.stdout.decode(errors="replace"))
        if pats is not None:
            return pats
    return None


def guideline_paths(base: str, batch: str) -> List[str]:
    """Every config/guideline path existing in EITHER commit matching the
    fixed any-depth patterns or the base-declared filePatterns."""
    patterns = guideline_file_patterns(base)
    extra = patterns if patterns is not None else GUIDELINE_FALLBACK_EXTRA
    names: set = set()
    for rev in (base, batch):
        try:
            names.update(git("ls-tree", "-r", "--name-only", rev, timeout=120).splitlines())
        except RuntimeError:
            continue
    return sorted(p for p in names if is_guideline_path(p)
                  or any(p == pat or fnmatch.fnmatch(p, pat) for pat in extra))


def blob_id(rev: str, path: str) -> Optional[str]:
    p = run(["git", "rev-parse", f"{rev}:{path}"], cwd=CLONE, check=False)
    return p.stdout.decode().strip() if p.returncode == 0 else None


def prepare_worktree(iid: str, base: str, batch: str) -> Path:
    """Detached worktree on batch_sha, then restore (or delete) every
    config/guideline path from base_sha — config-from-base is a hard
    requirement: a head-side .coderabbit.yaml or guideline file must not be
    able to suppress findings. Restored files stay staged-only — the CLI runs
    with --type committed, so they are never reviewed as changes. (Open item,
    README: S2/first run confirms the CLI reads config from the working tree,
    not the HEAD commit.)"""
    wt = WT_ROOT / iid
    remove_worktree(wt)
    WT_ROOT.mkdir(parents=True, exist_ok=True)
    git("worktree", "add", "--quiet", "--detach", str(wt), batch, timeout=300)
    restored: List[Dict[str, Any]] = []
    removed: List[Dict[str, Any]] = []
    for rel in guideline_paths(base, batch):
        if rev_has_file(base, rel):
            git_in(wt, "checkout", base, "--", rel)
            restored.append({"path": rel, "blob": blob_id(base, rel)})
        elif (wt / rel).exists():
            (wt / rel).unlink()
            removed.append({"path": rel})
    audit("guidelines-restored", item=iid, restored=restored, removed=removed)
    return wt


def remove_worktree(wt: Path) -> None:
    if wt.exists():
        run(["git", "worktree", "remove", "--force", str(wt)], cwd=CLONE, check=False)
        if wt.exists():
            shutil.rmtree(wt, ignore_errors=True)
    run(["git", "worktree", "prune"], cwd=CLONE, check=False)


# ---------------------------------------------------------------- run ledger / budget
#
# The signer's OWN coverage ledger (spool claims NEVER create coverage): only
# clean signer-recorded CLI runs cover a range. A batch that previously had
# blocking findings has clean=False rows, so it always needs a fresh review —
# there is no "dispositioned" shortcut; only crq-override bypasses a review.


def record_run(base: str, run_base: str, batch: str, outcome: str, clean: bool) -> None:
    """Append-only ledger row; clean is decided by the caller AFTER findings
    are parsed (R1): completed AND zero critical/major AND no reviewer faults
    (a fault-y stream voids clean credit; #529)."""
    append_jsonl(RUN_LEDGER, {"base_sha": base, "from": run_base, "to": batch,
                              "outcome": outcome, "clean": clean, "at": iso()})


def _collapse(runs: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Latest record per (base_sha, from, to): a dirty run VOIDS any earlier
    clean record of the same range — the CLI is not deterministic, so a dirty
    rerun invalidates the earlier clean verdict on that range."""
    latest: Dict[Tuple[str, str, str], Dict[str, Any]] = {}
    for r in runs:
        latest[(str(r.get("base_sha")), str(r.get("from")), str(r.get("to")))] = r
    return list(latest.values())


def load_runs() -> List[Dict[str, Any]]:
    """Collapsed ledger; clean means: outcome completed AND zero critical/
    major findings AND no reviewer faults — agent-judged blocking findings
    are NOT clean coverage, and a fault-y reviewer stream (#529) is not
    coverage at all; covered()/delta_from() consult only clean records."""
    if not RUN_LEDGER.exists():
        return []
    out: List[Dict[str, Any]] = []
    for line in RUN_LEDGER.read_text().splitlines():
        try:
            out.append(json.loads(line))
        except ValueError:
            continue
    return _collapse(out)


def covered(base: str, batch: str, runs: List[Dict[str, Any]]) -> bool:
    """A clean full run base..batch, or a clean chain base..S1 (full) +
    S1..S2..batch (deltas), all with the same base_sha."""
    clean = [r for r in _collapse(runs) if r.get("base_sha") == base and r.get("clean")
             and SHA40.fullmatch(str(r.get("from") or "")) and SHA40.fullmatch(str(r.get("to") or ""))]
    if any(r["from"] == base and r["to"] == batch for r in clean):
        return True

    def reach(node: str, seen: set) -> bool:
        if node == batch:
            return True
        for r in clean:
            if r["from"] == node and r["to"] not in seen:
                seen.add(r["to"])
                if reach(r["to"], seen):
                    return True
        return False

    return reach(base, {base})


def delta_from(base: str, batch: str, runs: List[Dict[str, Any]]) -> Optional[str]:
    """A clean full run base..T1 with T1 a proper ancestor of batch means only
    the delta T1..batch needs a fresh run; newest such T1 wins."""
    cands = [r for r in _collapse(runs) if r.get("base_sha") == base and r.get("clean")
             and r.get("from") == base and SHA40.fullmatch(str(r.get("to") or ""))
             and r["to"] not in (base, batch) and is_ancestor(r["to"], batch)]
    if not cands:
        return None
    return str(max(cands, key=lambda r: str(r.get("at") or ""))["to"])


def starts_last_hour() -> int:
    if not MY_STARTS.exists():
        return 0
    cutoff = (now() - dt.timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
    n = 0
    for line in MY_STARTS.read_text().splitlines():
        try:
            if json.loads(line).get("at", "") >= cutoff:
                n += 1
        except ValueError:
            continue
    return n


def record_start(iid: str, base: str, batch: str) -> None:
    rec = {"at": iso(), "item": iid, "base_sha": base, "batch_sha": batch}
    append_jsonl(MY_STARTS, rec)  # private budget log — must never fail
    try:
        append_jsonl(SLEDGER / "starts.jsonl", rec)  # shared: the steward's ≤5/h counts these
    except OSError as e:
        audit("spool-ledger-write-failed", item=iid, why=type(e).__name__)


def cooldown_active() -> Optional[str]:
    if not COOLDOWN.exists():
        return None
    try:
        until = json.loads(COOLDOWN.read_text()).get("until", "")
        return until if until > iso() else None
    except ValueError:
        return None


def parse_iso_utc(s: str) -> Optional[dt.datetime]:
    try:
        return dt.datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=dt.timezone.utc)
    except (TypeError, ValueError):
        return None


def publish_backoff(iid: str, reason: str, until: dt.datetime, wait_minutes: int) -> None:
    """ledger/backoff.json — REWRITTEN on every deferral (self-cap budget or
    rate-limit cooldown), refreshing `until` each time the same request is
    re-deferred so the steward's down-timer runs from the latest value
    (steward ruling, crq 008831c). reason semantics steward-side:
    "rate_limit" (or no reason, backward compat) extends the steward's global
    cooldown — shared CodeRabbit quota, its own PR reviews pause too;
    "budget" (the signer's private 2/h cap) does NOT touch that cooldown —
    it only explains the unclaimed request. No further lifecycle: once the
    request is claimed or consumed the steward's existing backoff-expiry
    handling applies."""
    try:
        atomic_json(SLEDGER / "backoff.json",
                    {"v": 1, "item": iid, "wait_minutes": max(1, int(wait_minutes)),
                     "until": iso(until), "at": iso(), "reason": reason})
    except OSError as e:
        audit("spool-ledger-write-failed", item=iid, why=type(e).__name__)


def budget_retry_minutes() -> int:
    """Minutes until the 2/h self-cap frees a slot: the oldest of the
    blocking starts in the trailing hour leaves the rolling window."""
    if MY_STARTS.exists():
        cutoff = (now() - dt.timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
        stamps: List[str] = []
        for line in MY_STARTS.read_text().splitlines():
            try:
                t = str(json.loads(line).get("at", ""))
            except ValueError:
                continue
            if t >= cutoff:
                stamps.append(t)
        stamps.sort()
        blocking = stamps[-MAX_STARTS_PER_HOUR:]
        if blocking:
            t = parse_iso_utc(blocking[0])
            if t is not None:
                return max(1, int(((t + dt.timedelta(hours=1)) - now()).total_seconds() // 60) + 1)
    return 1


def defer_request(iid: str, reason: str, until_iso: Optional[str] = None) -> None:
    """Leave a request unclaimed (no status, no id burned) and publish the
    backoff. Runs again on every poll while the deferral persists — that is
    what keeps `until` fresh for the steward's down-timer."""
    if until_iso:
        until = parse_iso_utc(until_iso) or (now() + dt.timedelta(minutes=1))
        minutes = max(1, int((until - now()).total_seconds() // 60) + 1)
    else:
        minutes = budget_retry_minutes()
        until = now() + dt.timedelta(minutes=minutes)
    audit(f"defer-{reason}", item=iid, until=iso(until))
    publish_backoff(iid, reason, until, minutes)


def enter_cooldown(iid: str, minutes: int) -> None:
    """Self-cooldown after a rate-limited run; publish the rate_limit backoff
    so the steward extends its own cooldown too (shared quota)."""
    until = now() + dt.timedelta(minutes=minutes + 2)
    atomic_json(COOLDOWN, {"until": iso(until)})
    publish_backoff(iid, "rate_limit", until, minutes + 2)


# ---------------------------------------------------------------- CLI run


def run_cli(run_dir: Path, wt: Path, run_base: str) -> Dict[str, Any]:
    """coderabbit review with the hard timeout implemented in Python
    (threading.Timer → SIGTERM at 75m, SIGKILL 60s later). NO gtimeout, NO
    Homebrew, NO /usr/local/bin. stdin=DEVNULL; stdout→ndjson, stderr→log
    (both private). --use-credits is never passed."""
    counts = {s: 0 for s in SEVERITIES}
    if not CODERABBIT.is_file():
        return {"outcome": "error", "severity_counts": counts}
    run_dir.mkdir(parents=True, exist_ok=True)
    ndjson, errlog = run_dir / "review.ndjson", run_dir / "stderr.log"
    cmd = [str(CODERABBIT), "review", "--agent", "--base-commit", run_base, "--type", "committed"]
    fired = {"term": False, "kill": False}

    def term() -> None:
        fired["term"] = True
        try:
            os.killpg(p.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass

    def kill() -> None:
        fired["kill"] = True
        try:
            os.killpg(p.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass

    with ndjson.open("wb") as nd, errlog.open("wb") as ef:
        p = subprocess.Popen(cmd, cwd=str(wt), stdin=subprocess.DEVNULL, stdout=nd, stderr=ef,
                             env=CHILD_ENV, start_new_session=True)
        limit = RUN_TIMEOUT_MIN * 60
        t1 = threading.Timer(limit, term)
        t2 = threading.Timer(limit + KILL_AFTER_S, kill)
        t1.start()
        t2.start()
        try:
            rc: Optional[int] = p.wait()
        except Exception:
            kill()
            p.wait()
            rc = None
        finally:
            t1.cancel()
            t2.cancel()
    cls = classify(ndjson, rc)
    if (fired["term"] or fired["kill"]) and cls["outcome"] != "completed":
        cls["outcome"] = "interrupted"  # our hard timeout, not a CLI verdict
    return cls


# ---------------------------------------------------------------- spool io


def read_request(path: Path, expect_item: Optional[str] = None) -> Tuple[Dict[str, Any], str]:
    """Strict spool-contract v1 parse: O_NOFOLLOW, regular file, ≤4096 bytes,
    exact key set, exact types, RFC3339Z stamp. Fixed reason labels only —
    request content is never echoed anywhere. expect_item overrides the
    filename-stem identity check (recovery reads C1-renamed request files,
    whose stem is no longer the item id)."""
    try:
        # O_NONBLOCK: a FIFO planted as requests/promo-*.json must not wedge
        # the open; the fstat below still rejects it as not-a-regular-file.
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except OSError:
        raise Reject("bad_request", "unreadable request") from None
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode):
            raise Reject("bad_request", "not a regular file")
        if st.st_size > REQ_MAX_BYTES:
            raise Reject("bad_request", "oversize request")
        chunks: List[bytes] = []
        while True:
            b = os.read(fd, 4096)
            if not b:
                break
            chunks.append(b)
            if sum(len(c) for c in chunks) > REQ_MAX_BYTES:
                raise Reject("bad_request", "oversize request")
    finally:
        os.close(fd)
    raw = b"".join(chunks)
    try:
        obj = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise Reject("bad_request", "bad charset or unparseable JSON") from None
    if not isinstance(obj, dict) or set(obj) != REQUEST_KEYS:
        raise Reject("bad_request", "unknown key")
    if type(obj["v"]) is not int or obj["v"] != 1:
        raise Reject("bad_request", "bad v")
    if obj["kind"] != "promotion":
        raise Reject("bad_request", "bad kind")
    if not isinstance(obj["item"], str) or not ITEM_ID.fullmatch(obj["item"]):
        raise Reject("bad_request", "bad item")
    if obj["item"] != (expect_item if expect_item is not None else path.name[:-len(".json")]):
        raise Reject("bad_request", "item mismatch")
    for k in ("base_sha", "batch_sha"):
        if not isinstance(obj[k], str) or not SHA40.fullmatch(obj[k]):
            raise Reject("bad_request", f"bad {k}")
    if not isinstance(obj["requested_at"], str) or not RFC3339Z.fullmatch(obj["requested_at"]):
        raise Reject("bad_request", "bad requested_at")
    try:
        dt.datetime.strptime(obj["requested_at"], "%Y-%m-%dT%H:%M:%SZ")
    except ValueError:
        raise Reject("bad_request", "bad requested_at") from None
    return obj, hashlib.sha256(raw).hexdigest()


def write_result(iid: str, req: Optional[Dict[str, Any]], request_sha256: Optional[str], *,
                 outcome: str, posted_state: str, severity_counts: Dict[str, int],
                 posted: Optional[Dict[str, Any]] = None,
                 blocking: Optional[Dict[str, int]] = None,
                 findings: Optional[List[Dict[str, Any]]] = None,
                 reviewer_faults: Optional[List[Dict[str, Any]]] = None,
                 wait_minutes: Optional[int] = None, reason: Optional[str] = None,
                 reason_code: Optional[str] = None,
                 started_at: Optional[str] = None) -> None:
    """results/<id>.json — written exactly once, 0644, atomic. No raw CLI
    output, no matched secret text, no tokens — ever. reason_code is from
    REASON_CODES and only on rejected/error results (R5); the free-text
    reason is for humans/audit only. reviewer_faults are bounded diagnostics
    (code/severity/file/desc plus artifact hash and physical row reference)
    for rows that carried no reviewable defect —
    they never become blocking evidence nor a clean pass (#529)."""
    if (RESULTS / f"{iid}.json").exists():
        return  # terminal identity is immutable across retries/recovery
    res: Dict[str, Any] = {"v": 1, "item": iid,
                           "base_sha": (req or {}).get("base_sha", ""),
                           "batch_sha": (req or {}).get("batch_sha", ""),
                           "outcome": outcome, "posted_state": posted_state}
    if posted is not None:
        res["posted"] = posted
    if blocking is not None:
        res["blocking"] = blocking
    if findings is not None:
        res["findings"] = findings
    if reviewer_faults is not None:
        res["reviewer_faults"] = reviewer_faults
    res["severity_counts"] = {s: int(severity_counts.get(s, 0)) for s in SEVERITIES}
    res["started_at"] = started_at or iso()
    res["ended_at"] = iso()
    if wait_minutes is not None:
        res["wait_minutes"] = wait_minutes
    if outcome in ("rejected", "error"):
        if reason:
            res["reason"] = cap(reason, 300)
        if reason_code:
            res["reason_code"] = reason_code
    if request_sha256:
        res["request_sha256"] = request_sha256
    atomic_json(RESULTS / f"{iid}.json", res)


def unlink_request(path: Path) -> None:
    try:
        path.unlink()
    except FileNotFoundError:
        pass
    except OSError as e:
        audit("unlink-failed", item=path.name, why=type(e).__name__)  # consumed-ness is in the result file


def consume_request(iid: str) -> None:
    """Consumption: unlink the (renamed) request file. The .claimed marker
    stays in place."""
    for name in (f".{iid}.json.claiming", f"{iid}.json"):
        try:
            (REQUESTS / name).unlink()
        except FileNotFoundError:
            pass
        except OSError as e:
            audit("unlink-failed", item=iid, name=name, why=type(e).__name__)


def close_out(iid: str, req: Optional[Dict[str, Any]], req_sha: Optional[str], *,
              outcome: str, started_at: str, severity_counts: Dict[str, int],
              posted: Optional[Dict[str, Any]] = None,
              findings: Optional[List[Dict[str, Any]]] = None,
              blocking: Optional[Dict[str, int]] = None,
              reviewer_faults: Optional[List[Dict[str, Any]]] = None,
              wait_minutes: Optional[int] = None, reason: Optional[str] = None,
              reason_code: Optional[str] = None) -> None:
    """Write the result, audit, and consume the request (the .claimed marker
    stays in place)."""
    posted_state = posted["state"] if posted else "none"
    write_result(iid, req, req_sha, outcome=outcome, posted_state=posted_state,
                 severity_counts=severity_counts, posted=posted, blocking=blocking,
                 findings=findings, reviewer_faults=reviewer_faults, wait_minutes=wait_minutes,
                 reason=reason, reason_code=reason_code, started_at=started_at)
    audit("result", item=iid, outcome=outcome, posted_state=posted_state,
          status_id=(posted or {}).get("status_id"))
    consume_request(iid)


def post_final(iid: str, sha: str, state: str, desc: str) -> Optional[Dict[str, Any]]:
    # Same private publication lock as the owner override. Hold across GET/POST.
    # Never raises: every caller must still reach close_out, and orphan
    # recovery at start must not crash-loop the daemon.
    try:
        STATE.mkdir(parents=True, exist_ok=True)
        with (STATE / 'publication.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            return _post_final_locked(iid, sha, state, desc)
    except OSError as e:
        audit("post-failed", item=iid, sha=sha, state=state, why=type(e).__name__)
        return None


def _post_final_locked(iid: str, sha: str, state: str, desc: str) -> Optional[Dict[str, Any]]:
    """Post a final status (fresh token, per use). Best effort: a failed post
    is audited and shows up as posted_state=none/pending, never fatal —
    including a malformed or unreadable runtime config. Before any FINAL
    post, skip when the newest trusted status on the sha is already
    success — a stale failure/error must never clobber an override."""
    try:
        if state in ("pending", "success", "failure", "error"):
            newest = newest_trusted_status(install_token(REPO), REPO, sha)
            if newest is not None and newest.get("state") == "success":
                audit("post-skipped", item=iid, sha=sha, state=state, why="success present")
                return None
        posted = post_status(REPO, sha, state, desc, item=iid)
        audit("post", item=iid, sha=sha, state=state, status_id=posted.get("status_id"))
        return posted
    except Exception as e:  # best effort by contract (runtime config errors included)
        audit("post-failed", item=iid, sha=sha, state=state, why=type(e).__name__)
        return None


# ---------------------------------------------------------------- item pipeline


def process_request(path: Path) -> None:
    iid = path.name[:-len(".json")]
    started_at = iso()
    audit("accept", item=iid)
    if (RESULTS / f"{iid}.json").exists() or (RESULTS / f"{iid}.claimed").exists():
        unlink_request(path)
        return
    req: Optional[Dict[str, Any]] = None
    req_sha: Optional[str] = None
    try:
        req, req_sha = read_request(path)
    except Reject as e:
        write_result(iid, None, None, outcome="rejected", posted_state="none",
                     severity_counts={s: 0 for s in SEVERITIES}, reason=e.reason,
                     reason_code=e.code, started_at=started_at)
        audit("validate-reject", item=iid, why=e.reason, code=e.code)
        unlink_request(path)
        return
    base, batch = req["base_sha"], req["batch_sha"]

    # Idempotency: an existing result or claim means this id is already
    # handled — drop the request, do nothing.
    if (RESULTS / f"{iid}.json").exists() or (RESULTS / f"{iid}.claimed").exists():
        audit("skip-already-done", item=iid)
        unlink_request(path)
        return

    # R7 + steward ruling: budget/cooldown BEFORE validation and the claim —
    # an item that still needs a fresh run is deferred unclaimed (no status,
    # no id burned) while the self-cap or a rate-limit cooldown would block
    # that run, and every re-deferral refreshes ledger/backoff.json (which is
    # why this check sits ahead of validation: it stays cheap enough to run
    # on every poll, including mid-cooldown). Covered items never need a run
    # and proceed even mid-cooldown.
    if not covered(base, batch, load_runs()):
        cd_until = cooldown_active()
        if cd_until is not None:
            defer_request(iid, "rate_limit", until_iso=cd_until)
            return
        if starts_last_hour() >= MAX_STARTS_PER_HOUR:
            defer_request(iid, "budget")
            return

    # Pre-claim: identity guard + mechanical validation. Transient failures
    # leave the request in place for the next poll.
    try:
        token = install_token(REPO)
        newest = newest_trusted_status(token, REPO, batch)
        if newest is not None and newest.get("state") == "success":
            write_result(iid, req, req_sha, outcome="rejected", posted_state="none",
                         severity_counts={s: 0 for s in SEVERITIES},
                         reason="already reviewed (success present)",
                         reason_code="success_present", started_at=started_at)
            audit("validate-reject", item=iid, why="already reviewed (success present)",
                  code="success_present")
            unlink_request(path)
            return
        validate_request(req, token)
    except Reject as e:
        write_result(iid, req, req_sha, outcome="rejected", posted_state="none",
                     severity_counts={s: 0 for s in SEVERITIES}, reason=e.reason,
                     reason_code=e.code, started_at=started_at)
        audit("validate-reject", item=iid, why=e.reason, code=e.code)
        unlink_request(path)
        return
    except (Transient, RuntimeError, Fatal, OSError) as e:
        audit("defer-transient", item=iid, why=type(e).__name__)
        return  # request stays; the steward's down-alert covers a dead signer

    # Claim (C1): renaming the request to its dot-name IS the atomic
    # withdrawal check — the steward's unlink either wins or ENOENTs; only
    # then is the .claimed marker written.
    claiming = REQUESTS / f".{iid}.json.claiming"
    # Private validated identity survives crashes; shared request bytes never
    # authorize recovery statuses. Persist before crossing the claim boundary.
    atomic_json(STATE / 'claims' / (iid + '.json'),
                {'request': req, 'request_sha256': req_sha, 'validated_at': iso()}, mode=0o600)
    try:
        os.rename(path, claiming)
    except OSError:
        audit("withdrawn", item=iid)
        return
    # A writable request could change after pre-validation; bind claimed bytes
    # to the exact validated checksum before any status or paid CLI dispatch.
    try:
        claimed_req, claimed_sha = read_request(claiming, expect_item=iid)
        if claimed_sha != req_sha:
            raise Reject('bad_request', 'request changed before claim')
    except Reject:
        close_out(iid, req, req_sha, outcome='rejected', posted=None,
                  started_at=started_at, severity_counts={s: 0 for s in SEVERITIES},
                  reason='request changed before claim', reason_code='bad_request')
        return
    atomic_json(RESULTS / f"{iid}.claimed", {"v": 1, "claimed_at": iso()})
    audit("claim", item=iid, base=base, batch=batch)

    # Everything after the claim must close out with a result file, whatever
    # happens — a pending must never linger without a verdict.
    wt: Optional[Path] = None
    posted: Optional[Dict[str, Any]] = None
    try:
        posted = post_final(iid, batch, "pending", f"reviewing main={base} crq#{iid}")

        # Secret scan BEFORE any upload (fail closed: secret_scan_blocked).
        STATE.mkdir(parents=True, exist_ok=True)
        if not secret_scan(base, batch, STATE / f"scan-{iid}.json"):
            posted = post_final(iid, batch, "error",
                                f"review secret_scan_blocked main={base} crq#{iid}") or posted
            close_out(iid, req, req_sha, outcome="secret_scan_blocked",
                      started_at=started_at, severity_counts={s: 0 for s in SEVERITIES},
                      posted=posted)
            return

        # Review tree: batch detached, config/guidelines restored from base.
        wt = prepare_worktree(iid, base, batch)

        # Coverage rule: success needs clean recorded coverage of base..batch.
        runs = load_runs()
        findings: List[Dict[str, Any]] = []
        reviewer_faults: List[Dict[str, Any]] = []
        diff_files: Optional[set] = None  # set below, per-run (covered path has no run)
        counts: Dict[str, int] = {s: 0 for s in SEVERITIES}
        wait_minutes: Optional[int] = None
        if covered(base, batch, runs):
            audit("coverage-satisfied", item=iid, base=base, batch=batch)  # success WITHOUT a new run
        else:
            run_base = delta_from(base, batch, runs) or base
            # Scope of the EXACT comparison the CLI is about to run
            # (run_base..HEAD, its --base-commit), captured after delta
            # selection (#529 follow-up review P1: a base..HEAD set on a
            # chained delta would wrongly accept pre-delta paths and reject
            # delta-only net-reverted paths).
            diff_files = capture_review_scope(wt, run_base)
            record_start(iid, base, batch)
            audit("run-start", item=iid, run_base=run_base, full=(run_base == base))
            stamp = iso().replace(":", "").replace("-", "")
            run_dir = STATE / "runs" / f"{iid}-{stamp}"
            cls = run_cli(run_dir, wt, run_base)
            audit("run-done", item=iid, run_base=run_base, outcome=cls["outcome"])
            counts = cls.get("severity_counts") or counts
            wait_minutes = cls.get("wait_minutes")
            clean = False
            if cls["outcome"] == "completed":
                # R1: clean = completed AND zero critical/major, recorded only
                # after the findings are parsed. A dirty run voids any earlier
                # clean record of the same range (load_runs: last wins) — the
                # CLI is not deterministic, so a dirty rerun of a range
                # invalidates the earlier clean verdict on it.
                # counts stay classify()'s six-level tally; findings carry the
                # blocking rows only. #529: rows with no reviewable defect
                # (prompt-preamble boilerplate, no description, or a location
                # outside the captured run_base..HEAD diff) become
                # reviewer_fault diagnostics — never blocking defects, never
                # silently clean.
                findings, reviewer_faults = blocking_findings(run_dir / "review.ndjson", diff_files)
                # Faults void clean credit exactly like blocking rows: a
                # broken reviewer stream is not coverage (#529).
                clean = (not any(f["severity"] in BLOCKING_SEVERITIES for f in findings)
                         and not reviewer_faults)
            record_run(base, run_base, batch, cls["outcome"], clean)
            if cls["outcome"] == "completed" and reviewer_faults and not findings:
                # Faults ONLY (no valid blocking defect): a reviewer-stream
                # integrity failure — the captured comparison is not
                # trustworthy evidence, so the item can neither pass nor
                # carry fabricated defect evidence. reason_code
                # reviewer_fault is outside the steward's done/recut sets →
                # state blocked + signer_alert. With a real defect present,
                # the normal blocking branch below keeps priority and the
                # faults ride along as diagnostics.
                codes = sorted({f["code"] for f in reviewer_faults})
                reason = "reviewer fault: no reviewable defect rows (" + ", ".join(codes) + ")"
                posted = post_final(iid, batch, "error", f"review reviewer_fault main={base} crq#{iid}") or posted
                close_out(iid, req, req_sha, outcome="error", started_at=started_at,
                          severity_counts=counts, posted=posted, findings=findings,
                          reviewer_faults=reviewer_faults,
                          reason=reason, reason_code="reviewer_fault", wait_minutes=wait_minutes)
                return
            if cls["outcome"] == "rate_limited":
                # Nothing final: the pending stands; cooldown + published backoff.
                enter_cooldown(iid, wait_minutes or 30)
                close_out(iid, req, req_sha, outcome="rate_limited", started_at=started_at,
                          severity_counts=counts, posted=posted, wait_minutes=wait_minutes)
                return
            if cls["outcome"] == "auth":
                close_out(iid, req, req_sha, outcome="auth", started_at=started_at,
                          severity_counts=counts, posted=posted)
                return
            if cls["outcome"] != "completed":
                posted = post_final(iid, batch, "error",
                                    f"review {cls['outcome']} main={base} crq#{iid}") or posted
                close_out(iid, req, req_sha, outcome=cls["outcome"], started_at=started_at,
                          severity_counts=counts, posted=posted, wait_minutes=wait_minutes)
                return

        n_crit = sum(1 for f in findings if f["severity"] == "critical")
        n_maj = sum(1 for f in findings if f["severity"] == "major")
        if n_crit + n_maj > 0:
            blocking = {"critical": n_crit, "major": n_maj}
            sev = f"{n_crit} critical/{n_maj} major"
            posted = post_final(iid, batch, "failure", f"blocked: {sev} main={base} crq#{iid}") or posted
            close_out(iid, req, req_sha, outcome="completed", started_at=started_at,
                      severity_counts=counts, posted=posted, findings=findings, blocking=blocking,
                      reviewer_faults=reviewer_faults or None,
                      wait_minutes=wait_minutes)
            return

        # Clean: success needs coverage AND a subject that has not moved.
        if not covered(base, batch, load_runs()):
            posted = post_final(iid, batch, "error", f"review error main={base} crq#{iid}") or posted
            close_out(iid, req, req_sha, outcome="error", started_at=started_at,
                      severity_counts=counts, posted=posted,
                      reason="coverage not satisfied after clean run", reason_code="coverage")
            return
        if subject_moved(base, batch, install_token(REPO)):
            close_out(iid, req, req_sha, outcome="error", started_at=started_at,
                      severity_counts=counts, posted=posted,
                      reason="subject moved during review",  # post NOTHING (pending stands)
                      reason_code="subject_moved")
            return
        posted = post_final(iid, batch, "success", f"reviewed main={base} crq#{iid}") or posted
        close_out(iid, req, req_sha, outcome="completed", started_at=started_at,
                  severity_counts=counts, posted=posted, findings=findings,
                  wait_minutes=wait_minutes)
    except (Transient, RuntimeError, OSError, Fatal) as e:
        posted = post_final(iid, batch, "error", f"review error main={base} crq#{iid}") or posted
        close_out(iid, req, req_sha, outcome="error", started_at=started_at,
                  severity_counts={s: 0 for s in SEVERITIES}, posted=posted,
                  reason=f"internal error ({type(e).__name__})", reason_code="internal")
    except Exception as e:  # never let one item kill the daemon
        posted = post_final(iid, batch, "error", f"review error main={base} crq#{iid}") or posted
        close_out(iid, req, req_sha, outcome="error", started_at=started_at,
                  severity_counts={s: 0 for s in SEVERITIES}, posted=posted,
                  reason=f"internal error ({type(e).__name__})", reason_code="internal")
    finally:
        if wt is not None:
            remove_worktree(wt)


def scan_spool() -> Optional[Path]:
    """At most one outstanding by contract; lexicographically first otherwise.
    Dotfiles and non-matching names are ignored (the steward's tmp files are
    dot-prefixed exactly so)."""
    if not REQUESTS.is_dir():
        return None
    with os.scandir(REQUESTS) as it:
        names = sorted(e.name for e in it if REQUEST_NAME.match(e.name))
    return REQUESTS / names[0] if names else None


def recover_orphans() -> None:
    """R6, at daemon start: a claim whose run never finished (crash/kill
    mid-flight) leaves .claimed with the request still in the spool. Close
    each such orphan out (outcome=interrupted, best-effort error status,
    request consumed) so the steward's item cannot hang in signer_running
    forever. The C3 guard keeps the error post from clobbering a success."""
    if not RESULTS.is_dir():
        return
    with os.scandir(RESULTS) as it:
        claims = sorted(e.name for e in it if e.name.endswith(".claimed"))
    ids = {name[:-len('.claimed')] for name in claims}
    for path in REQUESTS.glob('.*.json.claiming'):
        ids.add(path.name[1:-len('.json.claiming')])
    for iid in sorted(ids):
        if not ITEM_ID.fullmatch(iid):
            continue
        if (RESULTS / f"{iid}.json").exists():
            continue
        journal = STATE / 'claims' / (iid + '.json')
        try:
            saved = json.loads(journal.read_text())
            req, req_sha = saved['request'], saved['request_sha256']
            if (req.get('item') != iid or req.get('v') != 1 or req.get('kind') != 'promotion'
                    or not SHA40.fullmatch(req.get('base_sha', ''))
                    or not SHA40.fullmatch(req.get('batch_sha', ''))
                    or not re.fullmatch('[0-9a-f]{64}', req_sha)):
                raise ValueError('invalid private journal')
        except (OSError, ValueError, KeyError, TypeError, AttributeError):
            audit('orphan-needs-human', item=iid, why='private validated identity unavailable')
            continue  # no App status from agent-writable orphan bytes
        base, batch = req['base_sha'], req['batch_sha']
        posted = post_final(iid, batch, 'error', f'review error main={base} crq#{iid}')
        write_result(iid, req, req_sha, outcome='interrupted',
                     posted_state=posted['state'] if posted else 'none',
                     severity_counts={s: 0 for s in SEVERITIES}, posted=posted,
                     started_at=saved.get('validated_at') or iso())
        consume_request(iid)
        audit('orphan-recovered', item=iid)


# ---------------------------------------------------------------- daemon loop

_STOP = {"flag": False}


def _on_signal(signum: int, _frame: Any) -> None:
    _STOP["flag"] = True


def preflight() -> None:
    for p in (PEM, APP_META):
        if not p.is_file():
            raise Fatal(f"missing {p} — provision as crq per signer/README.md (S1) before starting")
    missing = [str(p) for p in (CODERABBIT, GITLEAKS) if not p.is_file()]
    if missing:
        audit("preflight-warn", missing=",".join(missing))  # fails closed per item at run time


def daemon() -> int:
    os.umask(0o022)
    try:
        preflight()
    except Fatal as e:
        print(f"crq-signer: {e}", file=sys.stderr)
        audit("fatal", why=str(e))
        return 1
    STATE.mkdir(parents=True, exist_ok=True)
    os.chmod(STATE, 0o700)
    lockfh = LOCK.open("w")
    try:
        fcntl.flock(lockfh, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        print("crq-signer: another daemon holds the lock", file=sys.stderr)
        return 1
    signal.signal(signal.SIGTERM, _on_signal)
    signal.signal(signal.SIGINT, _on_signal)
    audit("start", pid=os.getpid(), bot_login=REVIEWER_BOT_LOGIN, bot_id=REVIEWER_BOT_ID,
          installation=REVIEWER_INSTALLATION_ID)
    recover_orphans()
    while not _STOP["flag"]:
        # No cooldown gate here: a deferred request must keep being re-seen
        # every poll so its ledger/backoff.json `until` stays fresh; the
        # budget/cooldown decision lives in process_request (pre-validation).
        req = scan_spool()
        if req is not None:
            try:
                process_request(req)
            except Exception as e:  # belt and braces: the loop must survive
                audit("loop-error", item=req.name, why=type(e).__name__)
        for _ in range(POLL_SECONDS):  # interruptible sleep
            if _STOP["flag"]:
                break
            time.sleep(1)
    audit("stop", pid=os.getpid())
    return 0


# ---------------------------------------------------------------- probe (S2)


def probe(sha: str) -> int:
    """Owner-invoked one-shot at S2 (sudo -u crq): post crq/promotion-review
    pending on a scratch-repo commit, read it back, print the creator.
    HARDCODED to the scratch repo — never reachable from the spool (the spool
    schema has no repo field anywhere)."""
    if not SHA40.fullmatch(sha):
        print("probe: sha must be 40 lowercase hex", file=sys.stderr)
        return 2
    try:
        posted = post_status(PROBE_REPO, sha, "pending", "probe cq-reviewer signer", bind_main=False)
        token = install_token(PROBE_REPO)
    except (Transient, RuntimeError, Fatal) as e:
        print(f"probe: {cap(str(e), 160)}", file=sys.stderr)
        return 1
    print(f"posted: state={posted['state']} id={posted['status_id']}")
    try:
        statuses = commit_statuses(token, PROBE_REPO, sha)
    except (Transient, RuntimeError) as e:
        print(f"probe: readback failed: {cap(str(e), 160)}", file=sys.stderr)
        return 1
    for s in statuses:
        if s.get("id") == posted["status_id"]:
            c = s.get("creator") or {}
            print(json.dumps({"login": c.get("login"), "id": c.get("id"), "type": c.get("type")}))
            ok = (c.get("login") == REVIEWER_BOT_LOGIN and c.get("type") == "Bot"
                  and c.get("id") == REVIEWER_BOT_ID)
            print(f"creator check: {'OK' if ok else 'MISMATCH — do not enable the gate'}")
            return 0 if ok else 1
    print("probe: posted status not found in readback", file=sys.stderr)
    return 1


def main() -> int:
    p = argparse.ArgumentParser(description="crq signer daemon (promotion items only)")
    p.add_argument("command", nargs="?", default="run", choices=["run", "probe"],
                   help="run the daemon (default) or the S2 probe")
    p.add_argument("sha", nargs="?", help="40-hex commit sha (probe only)")
    args = p.parse_args()
    if args.command == "probe":
        if not args.sha:
            print("probe: a commit sha is required", file=sys.stderr)
            return 2
        if not reviewer_pinned():
            print("probe: reviewer identity not pinned — fill REVIEWER_BOT_* only from "
                  "toolkit-research/plans/app-registration-session-20261004.md "
                  "after the App is registered", file=sys.stderr)
            return 3
        return probe(args.sha)
    if args.sha:
        p.error("a sha argument is only valid with the probe command")
    return daemon()


if __name__ == "__main__":
    sys.exit(main())
