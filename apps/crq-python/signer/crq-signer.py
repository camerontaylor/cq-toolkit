"""Root-owned review-ledger publication capability."""
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


OWNER_LOGIN = "camerontaylor"
REPO = "camerontaylor/cq-toolkit"


REVIEWER_BOT_LOGIN: Optional[str] = "cq-promotion-reviewer[bot]"
REVIEWER_BOT_ID: Optional[int] = 339373542
REVIEWER_INSTALLATION_ID: Optional[int] = 169119051
REVIEWER_APP_ID = 5230901



API = "https://api.github.com"
KEYS = Path("/home/crq/.local/share/cq-app-keys")
PEM = KEYS / "cq-promotion-reviewer.pem"
APP_META = KEYS / "cq-promotion-reviewer.json"  # {"id","client_id","slug","html_url"}

WORK = Path("/home/crq/cq-work")
CLONE = WORK / "cq-toolkit"  # dedicated anonymous clone; no token in any URL


SHA40 = re.compile(r"^[0-9a-f]{40}$")
CHILD_ENV = {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": "/home/crq"}
OPENSSL = "/usr/bin/openssl"


class Fatal(Exception):
    """Unrecoverable — owner action needed (missing provisioning, etc.)."""


class Transient(Exception):
    """Retryable (network/API). Pre-claim: the request is left in place."""


def now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def cap(s: str, n: int = 200) -> str:
    return re.sub(r"\s+", " ", str(s)).strip()[:n]


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
            raw = r.read()
            return json.loads(raw.decode()) if raw else None
    except urllib.error.HTTPError as e:
        e.read()
        if e.code >= 500 or e.code in (403, 429):
            raise Transient(f"github api {e.code}: {path}") from None
        raise RuntimeError(f"github api {e.code}: {path}") from None
    except (urllib.error.URLError, OSError) as e:
        raise Transient(f"github api unreachable: {cap(e)}") from None


def install_token(repo_full: str, *, ledger_write: bool = False) -> str:
    """Fresh installation token scoped to one repository. Per use. The
    access_tokens endpoint takes repository NAMES (not owner/name slugs) —
    split here so no caller can get that wrong."""
    if not ledger_write or repo_full != REPO:
        raise Fatal("ledger token repository refused")
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
                    "permissions": {"contents": "write"}})
    return out["token"]


LEDGER_REF = "refs/heads/cq/review-ledger"
LEDGER_BUNDLE_LIMIT = 64 * 1024 * 1024


def ledger_validator():
    """Load only installed root-owned validation artifacts (source layout in tests)."""
    directory = Path(__file__).resolve().parent
    module = directory / "review_ledger.py"
    schema = directory / "review-ledger.schema.json"
    if not module.exists() and directory.name == "signer":
        module = directory.parent / "review_ledger.py"
        schema = directory.parents[2] / "policy/review-ledger.schema.json"
    if os.geteuid() == 0:
        for path in (module, schema):
            info = path.stat()
            if info.st_uid != 0 or info.st_mode & 0o022:
                raise ValueError("ledger validation artifacts must be root-owned and immutable to callers")
    spec = importlib.util.spec_from_file_location("signer_review_ledger", module)
    validator = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(validator)
    validator.SCHEMA = schema
    return validator


def publish_ledger_commit(base: str, head: str, bundle: bytes) -> None:
    """Root-only exact-commit ledger capability. No checkout or caller Git config."""
    if not SHA40.fullmatch(base) or not SHA40.fullmatch(head) or base == head:
        raise ValueError("invalid ledger commit identity")
    if not bundle or len(bundle) > LEDGER_BUNDLE_LIMIT:
        raise ValueError("invalid ledger bundle size")
    token = install_token(REPO, ledger_write=True)
    try:
        with tempfile.TemporaryDirectory(prefix="crq-ledger-") as directory:
            root = Path(directory)
            env = {"PATH": "/usr/bin:/bin", "HOME": directory,
                   "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null",
                   "GIT_TERMINAL_PROMPT": "0", "GIT_CONFIG_COUNT": "3",
                   "GIT_CONFIG_KEY_0": "credential.helper", "GIT_CONFIG_VALUE_0": "",
                   "GIT_CONFIG_KEY_1": "core.hooksPath", "GIT_CONFIG_VALUE_1": "/dev/null",
                   "GIT_CONFIG_KEY_2": "http.https://github.com/.extraHeader",
                   "GIT_CONFIG_VALUE_2": "Authorization: Basic " + base64.b64encode(("x-access-token:" + token).encode()).decode()}
            def git(*args, **kwargs):
                return subprocess.run(["/usr/bin/git", *args], cwd=root, env=env,
                                      capture_output=True, input=kwargs.get("input"),
                                      check=kwargs.get("check", True), timeout=300).stdout
            git("init", "--bare", "--quiet")
            remote = "https://github.com/" + REPO + ".git"
            git("fetch", "--no-tags", remote, LEDGER_REF)
            current = git("rev-parse", "FETCH_HEAD").decode().strip()
            if current == head:
                return  # Push succeeded before an earlier response was lost.
            if current != base:
                raise ValueError("ledger base moved; refetch and rebuild")
            filename = root / "submission.bundle"
            filename.write_bytes(bundle)
            advertised = git("bundle", "list-heads", str(filename)).decode().splitlines()
            if advertised != [head + " refs/crq/ledger-publish/" + head]:
                raise ValueError("bundle does not advertise the exact ledger commit")
            git("bundle", "verify", str(filename))
            git("bundle", "unbundle", str(filename))
            if git("rev-list", "--parents", "-n", "1", head).decode().strip().split() != [head, base]:
                raise ValueError("ledger commit must append directly to the observed base")
            validator = ledger_validator()
            changes = git("diff-tree", "-r", "--no-commit-id", "--no-renames", "--raw", "--no-abbrev", "-z", base, head).split(b"\0")
            count = (len(changes) - 1) // 2
            if not 1 <= count <= validator.IMPORT_BATCH_LIMIT or len(changes) != 2 * count + 1 or changes[-1] != b"":
                raise ValueError("ledger publication exceeds record count bound")
            names, blobs = [], []
            for i in range(0, len(changes) - 1, 2):
                fields, name = changes[i].split(), changes[i + 1]
                if len(fields) != 5 or fields[0] != b":000000" or fields[4] != b"A" or not re.fullmatch(rb"records/[0-9]{4}/[0-9]{2}/[0-9a-f]{64}\.json", name):
                    raise ValueError("ledger publication must add records only")
                if fields[1] != b"100644":
                    raise ValueError("ledger record must be a regular file")
                names.append(name.decode())
                blobs.append(fields[3])
            sizes = git("cat-file", "--batch-check", input=b"\n".join(blobs) + b"\n").splitlines()
            total = 0
            if len(sizes) != count:
                raise ValueError("ledger blob size response mismatch")
            for oid, row in zip(blobs, sizes):
                fields = row.split()
                if len(fields) != 3 or fields[0] != oid or fields[1] != b"blob":
                    raise ValueError("ledger record must be a blob")
                size = int(fields[2])
                if size > 1024 * 1024:
                    raise ValueError("ledger record exceeds validation bound")
                total += size
            if total > validator.IMPORT_BATCH_BYTES:
                raise ValueError("ledger publication exceeds aggregate size bound")
            reader = validator.GitLedger(root)
            reader.git = git  # Every read retains the isolated root Git environment.
            values = reader.read(head)  # Schema, content hash, path identity and sequence.
            if count > 1:
                added = {validator.record_path(value): value for value in values}
                batch = [added[name] for name in names]
                new_ids = {value["id"] for value in batch}
                previous = [value for value in values if value["id"] not in new_ids]
                if not validator.independent_batch(batch, previous):
                    raise ValueError("ledger batch requires independent imports or initial inventory enrollments")
            git("merge-base", "--is-ancestor", base, head)
            git("push", "--porcelain", remote, head + ":" + LEDGER_REF)
    finally:
        api("DELETE", "installation/token", token=token)


def ledger_publish_entry() -> int:
    """Bounded socket frame; return only public commit identity or a generic error."""
    try:
        if os.geteuid() != 0:
            raise ValueError("root ledger service required")
        header = sys.stdin.buffer.readline(4097)
        if len(header) > 4096 or not header.endswith(b"\n"):
            raise ValueError("invalid ledger frame")
        obj = json.loads(header)
        if not isinstance(obj, dict) or set(obj) != {"base", "head", "bytes"}:
            raise ValueError("invalid ledger header")
        size = obj["bytes"]
        if type(size) is not int or not 1 <= size <= LEDGER_BUNDLE_LIMIT:
            raise ValueError("invalid ledger frame size")
        body = sys.stdin.buffer.read(size + 1)
        if len(body) != size:
            raise ValueError("ledger frame length mismatch")
        publish_ledger_commit(obj["base"], obj["head"], body)
        print(json.dumps({"published": obj["head"]}))
        return 0
    except Exception:
        print(json.dumps({"error": "ledger publication refused"}))
        return 2


def main() -> int:
    parser = argparse.ArgumentParser(description="crq review-ledger publisher")
    parser.add_argument("command", choices=["ledger-publish"])
    parser.parse_args()
    return ledger_publish_entry()


if __name__ == "__main__":
    sys.exit(main())
