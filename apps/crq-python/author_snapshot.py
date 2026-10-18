"""Bounded v1 Git-object snapshot; no checkout, shell, hooks or compressed payload."""
import base64
import hashlib
import os
from pathlib import Path
import re
import subprocess
import tempfile

from author_quota import AuthorRefused

MAX_CONTENT = 4 * 1024 * 1024
MAX_OBJECTS = 4096
MAX_WIRE = 6 * 1024 * 1024
OID = re.compile(r"^[0-9a-f]{40}$")


def commit_bytes(base, tree):
    return (f"tree {tree}\nparent {base}\n"
            "author cq snapshot <snapshot@localhost> 0 +0000\n"
            "committer cq snapshot <snapshot@localhost> 0 +0000\n\n"
            "cq author snapshot v1\n").encode()


def git(repo, *args, data=None):
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    env.update(GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull,
               GIT_TERMINAL_PROMPT="0")
    try:
        with tempfile.TemporaryFile() as output:
            subprocess.run(["git", "--no-replace-objects", "-c", "core.hooksPath=/dev/null",
                                 "-c", "core.fsmonitor=false", *args], cwd=repo, env=env,
                           input=data, stdout=output, stderr=subprocess.DEVNULL,
                           timeout=10, check=True)
            output.seek(0)
            result = output.read(MAX_WIRE + 1)
    except (OSError, subprocess.SubprocessError) as exc:
        raise AuthorRefused("snapshot Git operation refused") from exc
    if len(result) > MAX_WIRE:
        raise AuthorRefused("snapshot Git output exceeds bound")
    return result


def decode(snapshot, binding):
    if not isinstance(snapshot, dict) or set(snapshot) != {"v", "tree", "objects", "sha256"}:
        raise AuthorRefused("invalid snapshot fields")
    if type(snapshot["v"]) is not int or snapshot["v"] != 1:
        raise AuthorRefused("unsupported snapshot version")
    tree = snapshot["tree"]
    objects = snapshot["objects"]
    if not isinstance(tree, str) or not OID.fullmatch(tree):
        raise AuthorRefused("invalid snapshot tree")
    if not isinstance(objects, list) or not 1 <= len(objects) <= MAX_OBJECTS:
        raise AuthorRefused("snapshot object count exceeds bound")
    decoded, digest, total, previous = [], hashlib.sha256(), 0, ""
    for obj in objects:
        if not isinstance(obj, dict) or set(obj) != {"oid", "type", "data"}:
            raise AuthorRefused("invalid snapshot object fields")
        oid, kind, encoded = obj["oid"], obj["type"], obj["data"]
        if not isinstance(oid, str) or not OID.fullmatch(oid) or oid <= previous:
            raise AuthorRefused("snapshot objects must be unique and sorted")
        if kind not in ("blob", "tree", "commit") or not isinstance(encoded, str):
            raise AuthorRefused("invalid snapshot object type")
        try:
            data = base64.b64decode(encoded, validate=True)
        except (ValueError, UnicodeError) as exc:
            raise AuthorRefused("invalid snapshot object encoding") from exc
        if base64.b64encode(data).decode() != encoded:
            raise AuthorRefused("noncanonical snapshot object encoding")
        total += len(data)
        if total > MAX_CONTENT:
            raise AuthorRefused("snapshot content exceeds bound")
        actual = hashlib.sha1(kind.encode() + b" " + str(len(data)).encode() + b"\0" + data).hexdigest()
        if actual != oid or (kind == "commit" and (oid != binding["head"] or data != commit_bytes(binding["base"], tree))):
            raise AuthorRefused("snapshot object identity mismatch")
        digest.update((oid + "\0" + kind + "\0" + encoded + "\n").encode())
        decoded.append((oid, kind, data))
        previous = oid
    if digest.hexdigest() != snapshot["sha256"]:
        raise AuthorRefused("snapshot digest mismatch")
    expected = commit_bytes(binding["base"], tree)
    head = hashlib.sha1(b"commit " + str(len(expected)).encode() + b"\0" + expected).hexdigest()
    if head != binding["head"]:
        raise AuthorRefused("snapshot commit binding mismatch")
    return decoded


def install(snapshot, binding, runner):
    """Caller holds tick.lock. Validate/scan in quarantine, then pin before enrollment.

    Pins intentionally survive interrupted enrollment and rollback. They can only
    be collected by a future operator GC after queue/recovery retention expires.
    """
    objects = decode(snapshot, binding)
    clone = Path(runner.CLONE).resolve()
    if git(clone, "cat-file", "-t", binding["base"]).strip() != b"commit":
        raise AuthorRefused("snapshot base must already be available")
    object_dir = git(clone, "rev-parse", "--git-path", "objects").decode().strip()
    object_dir = (clone / object_dir).resolve()
    with tempfile.TemporaryDirectory(prefix="cq-author-snapshot-") as temp:
        quarantine = Path(temp)
        git(quarantine, "init", "--bare", "--template=", "-q")
        (quarantine / "objects/info/alternates").write_text(str(object_dir) + "\n")
        for oid, kind, data in objects:
            if git(quarantine, "hash-object", "-w", "-t", kind, "--stdin", data=data).decode().strip() != oid:
                raise AuthorRefused("snapshot import identity mismatch")
        needed = set(git(quarantine, "rev-list", "--objects", "--no-object-names",
                         binding["head"], "^" + binding["base"]).decode().split())
        if needed != {oid for oid, _, _ in objects}:
            raise AuthorRefused("snapshot contains missing or unrelated objects")
        entries = git(quarantine, "ls-tree", "-r", "-z", binding["head"]).split(b"\0")
        if any(entry and entry.split(b" ", 1)[0] not in (b"100644", b"100755", b"120000") for entry in entries):
            raise AuthorRefused("snapshot gitlinks or unsupported modes refused")
        diff = git(quarantine, "diff", "--no-ext-diff", "--no-textconv", "--no-color", "--unified=0",
                   binding["base"], binding["head"]).decode("utf-8", errors="replace")
        if not diff:
            raise AuthorRefused("empty snapshot diff")
        # Attributes/binary diff suppression must not hide incoming blob bytes.
        # Feed every incoming blob through the existing path-aware scan policy,
        # independently of the worker's operator-configured pre-upload scan.
        blobs = {oid: data for oid, kind, data in objects if kind == "blob"}
        scan_parts = [diff]
        scan_size = len(diff.encode())
        for entry in entries:
            if not entry:
                continue
            meta, raw_path = entry.split(b"\t", 1)
            path = raw_path.decode("utf-8", errors="strict")
            if any(ord(c) < 32 or ord(c) == 127 for c in path) or any(
                    part in (".", "..") or part.lower() == ".git" for part in path.split("/")):
                raise AuthorRefused("unsafe snapshot path")
            oid = meta.rsplit(b" ", 1)[1].decode()
            contents = blobs.get(oid, b"").decode("utf-8", errors="replace")
            part = ("diff --git a/" + path + " b/" + path + "\n+++ b/" + path + "\n+" + path + "\n" +
                    "\n".join("+" + line for line in contents.splitlines()) + "\n")
            scan_size += len(part.encode())
            if scan_size > MAX_WIRE:
                raise AuthorRefused("snapshot scan exceeds bound")
            scan_parts.append(part)
        ok, _ = runner.secret_scan_diff("\n".join(scan_parts), quarantine / "scan.json",
                                        base=binding["base"], head=binding["head"])
        if not ok:
            raise AuthorRefused("snapshot secret scan refused")
        for oid, kind, data in objects:
            if git(clone, "hash-object", "-w", "-t", kind, "--stdin", data=data).decode().strip() != oid:
                raise AuthorRefused("snapshot installation mismatch")
        git(clone, "update-ref", "refs/crq/author-snapshots/v1/" + binding["head"], binding["head"])
