"""Bounded v1 Git-object snapshot; no checkout, shell, hooks or compressed payload."""
import base64
import hashlib
import os
from pathlib import Path
import re
import selectors
import subprocess
import tempfile
import time

from author_quota import AuthorRefused

MAX_CONTENT = 4 * 1024 * 1024
MAX_ORIGINAL_CONTENT = 3 * 1024 * 1024
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
    command = ["git", "--no-replace-objects", "-c", "core.hooksPath=/dev/null",
               "-c", "core.fsmonitor=false", *args]
    try:
        with tempfile.TemporaryFile() as source:
            if data is not None:
                source.write(data)
                source.seek(0)
            with subprocess.Popen(command, cwd=repo, env=env, stdin=source,
                                  stdout=subprocess.PIPE, stderr=subprocess.DEVNULL) as process:
                deadline = time.monotonic() + 10
                result = bytearray()
                try:
                    with selectors.DefaultSelector() as ready:
                        ready.register(process.stdout, selectors.EVENT_READ)
                        while ready.get_map():
                            remaining = deadline - time.monotonic()
                            if remaining <= 0 or not ready.select(remaining):
                                raise subprocess.TimeoutExpired(command, 10)
                            chunk = os.read(process.stdout.fileno(), min(65536, MAX_WIRE + 1 - len(result)))
                            if not chunk:
                                ready.unregister(process.stdout)
                                break
                            result.extend(chunk)
                            if len(result) > MAX_WIRE:
                                raise AuthorRefused("snapshot Git output exceeds bound")
                    if process.wait(timeout=max(0.001, deadline - time.monotonic())):
                        raise AuthorRefused("snapshot Git operation refused")
                finally:
                    if process.poll() is None:
                        process.kill()
                        process.wait()
    except (OSError, subprocess.SubprocessError) as exc:
        raise AuthorRefused("snapshot Git operation refused") from exc
    return bytes(result)


def write_objects(repo, objects, message):
    """Write all objects with one hash-object process per type (not per object).

    Each object's returned OID must equal its declared OID, in order.
    """
    with tempfile.TemporaryDirectory(prefix="cq-author-objects-") as temp:
        for kind in ("blob", "tree", "commit"):
            group = [(oid, data) for oid, k, data in objects if k == kind]
            if not group:
                continue
            paths = []
            for index, (_, data) in enumerate(group):
                path = Path(temp) / f"{kind}-{index}"
                path.write_bytes(data)
                paths.append(str(path))
            written = git(repo, "hash-object", "-w", "--no-filters", "-t", kind, "--stdin-paths",
                          data=("\n".join(paths) + "\n").encode()).decode().split()
            if written != [oid for oid, _ in group]:
                raise AuthorRefused(message)


def read_blobs(repo, oids):
    """Contents of the given blob OIDs from one `cat-file --batch`, bounded by git()'s output limit."""
    oids = sorted(set(oids))
    if not oids:
        return {}
    out = git(repo, "cat-file", "--batch", data=("\n".join(oids) + "\n").encode())
    blobs, pos = {}, 0
    for oid in oids:
        nl = out.find(b"\n", pos)
        header = out[pos:nl].split(b" ") if nl >= 0 else []
        if len(header) != 3 or header[0].decode() != oid or header[1] != b"blob" or not header[2].isdigit():
            raise AuthorRefused("snapshot entry is not a readable blob")
        size = int(header[2])
        if nl + 1 + size >= len(out):
            raise AuthorRefused("snapshot entry is not a readable blob")
        blobs[oid] = out[nl + 1:nl + 1 + size]
        pos = nl + 1 + size + 1
    return blobs


def decode(snapshot, binding, *, original=False):
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
        content_limit = MAX_ORIGINAL_CONTENT if original else MAX_CONTENT
        if total > content_limit:
            raise AuthorRefused(f"snapshot content exceeds {content_limit} decoded bytes; reduce the commit range")
        actual = hashlib.sha1(kind.encode() + b" " + str(len(data)).encode() + b"\0" + data).hexdigest()
        if actual != oid or (not original and kind == "commit" and (oid != binding["head"] or data != commit_bytes(binding["base"], tree))):
            raise AuthorRefused("snapshot object identity mismatch")
        digest.update((oid + "\0" + kind + "\0" + encoded + "\n").encode())
        decoded.append((oid, kind, data))
        previous = oid
    if digest.hexdigest() != snapshot["sha256"]:
        raise AuthorRefused("snapshot digest mismatch")
    if original:
        head = next((data for oid, kind, data in decoded
                     if oid == binding["head"] and kind == "commit"), None)
        if head is None or not head.startswith(("tree " + tree + "\n").encode()):
            raise AuthorRefused("original snapshot head/tree mismatch")
        return decoded
    expected = commit_bytes(binding["base"], tree)
    head = hashlib.sha1(b"commit " + str(len(expected)).encode() + b"\0" + expected).hexdigest()
    if head != binding["head"]:
        raise AuthorRefused("snapshot commit binding mismatch")
    return decoded


def install(snapshot, binding, runner, *, original=False, clone=None, classes=None):
    """Caller holds tick.lock. Validate/scan in quarantine, then pin before enrollment.

    Pins intentionally survive interrupted enrollment and rollback. They can only
    be collected by a future operator GC after queue/recovery retention expires.
    """
    objects = decode(snapshot, binding, original=original)
    clone = Path(clone if clone is not None else runner.CLONE).resolve()
    if git(clone, "cat-file", "-t", binding["base"]).strip() != b"commit":
        raise AuthorRefused("snapshot base must already be available")
    object_dir = git(clone, "rev-parse", "--git-path", "objects").decode().strip()
    object_dir = (clone / object_dir).resolve()
    with tempfile.TemporaryDirectory(prefix="cq-author-snapshot-") as temp:
        quarantine = Path(temp)
        git(quarantine, "init", "--bare", "--template=", "-q")
        (quarantine / "objects/info/alternates").write_text(str(object_dir) + "\n")
        write_objects(quarantine, objects, "snapshot import identity mismatch")
        needed = set(git(quarantine, "rev-list", "--objects", "--no-object-names",
                         binding["head"], "^" + binding["base"]).decode().split())
        if needed != {oid for oid, _, _ in objects}:
            raise AuthorRefused("snapshot contains missing or unrelated objects")
        # Only entries that differ from base are checked: unchanged entries already exist in the
        # review clone, and walking the whole tree would bound-fail on large repositories.
        raw = git(quarantine, "diff-tree", "-r", "-z", "--no-renames", binding["base"], binding["head"]).split(b"\0")
        def entries_from(parts):
            result = []
            for meta, raw_path in zip(parts[0::2], parts[1::2]):
                _, mode, _, oid, _ = meta.split(b" ")
                if mode != b"000000":
                    result.append((mode, oid.decode(), raw_path))
            return result
        head_entries = entries_from(raw)
        history_entries = []
        if original:
            # The vendor can inspect original history, including blobs removed
            # before HEAD. Scan each transferred commit's changes against every
            # parent; -m includes merge introductions, --root includes roots.
            history_bytes = sum(len(part) + 1 for part in raw)
            for oid, kind, _ in objects:
                if kind == "commit":
                    history = git(quarantine, "diff-tree", "-r", "-m", "-z", "--no-renames",
                                  "--no-commit-id", "--root", oid).split(b"\0")
                    history_bytes += sum(len(part) + 1 for part in history)
                    if history_bytes > MAX_WIRE:
                        raise AuthorRefused("snapshot history scan exceeds bound; reduce the commit range")
                    history_entries.extend(entry for entry in entries_from(history)
                                           if entry[0] != b"160000")  # gitlinks have no blob bytes
        if any(mode not in (b"100644", b"100755", b"120000") for mode, _, _ in head_entries):
            raise AuthorRefused("snapshot gitlinks or unsupported modes refused")
        entries = sorted(set(head_entries + history_entries)) if original else head_entries
        head_entries = set(head_entries)
        # Tree entries are typed by mode, not by object: a 100644 entry may name a tree.
        # Require every entry to resolve to a real blob so it can be scanned and checked out.
        kinds = git(quarantine, "cat-file", "--batch-check=%(objecttype)",
                    data="".join(oid + "\n" for _, oid, _ in entries).encode()).split()
        if len(kinds) != len(entries) or any(kind != b"blob" for kind in kinds):
            raise AuthorRefused("snapshot entry mode disagrees with object type")
        diff = git(quarantine, "diff", "--no-ext-diff", "--no-textconv", "--no-color", "--unified=0",
                   binding["base"], binding["head"]).decode("utf-8", errors="replace")
        if not diff and not original:
            raise AuthorRefused("empty snapshot diff")
        # Attributes/binary diff suppression must not hide incoming blob bytes.
        # Feed every incoming blob through the existing path-aware scan policy,
        # independently of the worker's operator-configured pre-upload scan.
        blobs = {oid: data for oid, kind, data in objects if kind == "blob"}
        # Blobs reused from base are not in the transferred closure but still land at new paths.
        blobs.update(read_blobs(quarantine, [oid for _, oid, _ in entries if oid not in blobs]))
        # Checkout happens under WT_ROOT, which may be on a different filesystem than the clone.
        limits = Path(runner.WT_ROOT)
        while not limits.exists() and limits != limits.parent:
            limits = limits.parent
        name_max = os.pathconf(limits, "PC_NAME_MAX")
        fs_path_max = os.pathconf(limits, "PC_PATH_MAX")
        path_max = fs_path_max - len(str(runner.WT_ROOT)) - 256
        rules = runner.denylist_rules() if classes is None else runner.denylist_rules(classes)  # raises (fail closed) when the policy is absent
        compiled = [(re.compile(rule["regex"]), re.compile(rule["path"]) if "path" in rule else None)
                    for rule in rules]
        allow = [re.compile(pattern) for pattern in runner.ALLOWLIST_PATHS]
        scan_parts = [diff]
        scan_size = len(diff.encode())
        if original:
            # Original commit messages, author/committer names and extra
            # headers are uploaded context too. Only path-less rules apply:
            # commit metadata has no file path. Scan all text, not just the message tail.
            for oid, kind, data in objects:
                if kind != "commit":
                    continue
                text = data.decode("utf-8", errors="replace")
                if any(regex.search(line) for regex, path_regex in compiled
                       if path_regex is None for line in text.splitlines()):
                    raise AuthorRefused("snapshot commit metadata secret scan refused")
                part = "commit " + oid + "\n" + text
                scan_size += len(part.encode()) + 1
                if scan_size > MAX_WIRE:
                    raise AuthorRefused("snapshot scan exceeds bound")
                scan_parts.append(part)
        for mode, oid, raw_path in entries:
            materialized = (mode, oid, raw_path) in head_entries
            path = raw_path.decode("utf-8", errors="strict" if materialized else "replace")
            if materialized and (any(ord(c) < 32 or ord(c) == 127 for c in path) or any(
                    part in (".", "..") or part.lower() == ".git" for part in path.split("/"))):
                raise AuthorRefused("unsafe snapshot path")
            # A later `git worktree add` must be able to create every path on the runner filesystem.
            if materialized and (len(raw_path) > path_max or any(len(part) > name_max for part in raw_path.split(b"/"))):
                raise AuthorRefused("snapshot path too long to check out")
            # A symlink must be materializable exactly: non-empty target, no NUL truncation.
            if materialized and mode == b"120000" and (
                    not blobs[oid] or b"\0" in blobs[oid] or len(blobs[oid]) >= fs_path_max):
                raise AuthorRefused("snapshot symlink target is not representable")
            contents = blobs[oid].decode("utf-8", errors="replace")
            # Never encode untrusted contents as patch headers for policy checks:
            # a blob line beginning '++ b/...' could forge an allowlisted path.
            if not any(pattern.search(path) for pattern in allow):
                for regex, path_regex in compiled:
                    if path_regex is None or path_regex.search(path):
                        if regex.search(path) or any(regex.search(line) for line in contents.splitlines()):
                            raise AuthorRefused("snapshot secret scan refused")
            # Existing gitleaks stdin sees all bytes, independently of patch syntax.
            part = path + "\n" + contents + "\n"
            scan_size += len(part.encode()) + 1  # +1: the newline joining parts below
            if scan_size > MAX_WIRE:
                raise AuthorRefused("snapshot scan exceeds bound")
            scan_parts.append(part)
        ok, scan = runner.secret_scan_diff("\n".join(scan_parts), quarantine / "scan.json",
                                           base=binding["base"], head=binding["head"],
                                           **({"classes": classes} if classes is not None else {}))
        if not ok:
            # Still fail closed, but a scanner that could not run is an operator
            # fault, not evidence of a secret: say so instead of "refused".
            hits = (scan or {}).get("gitleaks_hits") or []
            if (not (scan or {}).get("denylist_hits") and hits
                    and all(h.get("rule") == "gitleaks-error" for h in hits)):
                raise AuthorRefused("snapshot secret scanner unavailable on the runner (gitleaks did not run); "
                                    "operator must make gitleaks resolvable on the queue identity PATH")
            raise AuthorRefused("snapshot secret scan refused")
        write_objects(clone, objects, "snapshot installation mismatch")
        git(clone, "update-ref", "refs/crq/author-snapshots/v1/" + binding["head"], binding["head"])
