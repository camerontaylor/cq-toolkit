"""Validated append-only evidence and fsync-backed operational outboxes.

No import performs I/O. Publication requires an explicitly constructed GitLedger
and uses ordinary pushes only. The schema deliberately admits integer JSON only:
all protocol counters/intervals are integers; floating point is never hashed.
"""
import contextlib
import datetime as dt
import fcntl
import functools
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import tempfile
import shutil

REPO = "camerontaylor/cq-toolkit"
SCHEMA = Path(__file__).resolve().parents[2] / "policy/review-ledger.schema.json"


class IntegrityError(ValueError):
    """Stop publication and credit advancement; operator reconciliation required."""


def canonical(value):
    """RFC 8785 on the schema's integer-only, Unicode-scalar JSON domain."""
    if value is None or type(value) is bool:
        return json.dumps(value).encode()
    if type(value) is int:
        if abs(value) > 9007199254740991:
            raise IntegrityError("integer outside interoperable JSON range")
        return str(value).encode()
    if isinstance(value, str):
        try:
            return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        except UnicodeError as exc:
            raise IntegrityError("non-scalar Unicode") from exc
    if isinstance(value, list):
        return b"[" + b",".join(canonical(v) for v in value) + b"]"
    if isinstance(value, dict) and all(isinstance(k, str) for k in value):
        keys = sorted(value, key=lambda k: k.encode("utf-16be"))
        return b"{" + b",".join(canonical(k) + b":" + canonical(value[k]) for k in keys) + b"}"
    raise IntegrityError("unsupported canonical JSON value")


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def loads(raw):
    def pairs(values):
        result = {}
        for key, value in values:
            if key in result:
                raise IntegrityError("duplicate JSON key")
            result[key] = value
        return result
    def refuse(value):
        raise IntegrityError("unsupported numeric JSON value")
    value = json.loads(raw, object_pairs_hook=pairs, parse_float=refuse, parse_constant=refuse)
    canonical(value)
    return value


def timestamp(value):
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ", value):
        raise IntegrityError("expected exact UTC timestamp")
    return dt.datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=dt.timezone.utc)


def path(value):
    if (not isinstance(value, str) or not value or "\0" in value or "\\" in value
            or str(PurePosixPath(value)) != value or PurePosixPath(value).is_absolute()
            or ".." in PurePosixPath(value).parts or value == "."):
        raise IntegrityError("non-canonical repository path")
    return value


def _schema(value, rule):
    """Evaluate exactly the checked-in schema vocabulary, failing closed."""
    supported = {"$schema", "oneOf", "type", "const", "enum", "required", "properties",
                 "additionalProperties", "items", "minItems", "maxItems", "minimum",
                 "minLength", "pattern"}
    if set(rule) - supported:
        raise IntegrityError("unsupported schema keyword")
    if "oneOf" in rule:
        matches = 0
        for branch in rule["oneOf"]:
            try:
                _schema(value, branch)
                matches += 1
            except IntegrityError:
                pass
        if matches != 1:
            raise IntegrityError("event does not match one schema variant")
        return
    types = {"object": dict, "array": list, "string": str, "integer": int,
             "boolean": bool, "null": type(None)}
    expected = rule.get("type")
    if expected and type(value) not in [types[t] for t in (expected if isinstance(expected, list) else [expected])]:
        raise IntegrityError("schema type mismatch")
    if "const" in rule and value != rule["const"] or "enum" in rule and value not in rule["enum"]:
        raise IntegrityError("schema value mismatch")
    if isinstance(value, dict):
        if set(rule.get("required", [])) - value.keys():
            raise IntegrityError("missing required event fields")
        properties = rule.get("properties", {})
        if rule.get("additionalProperties") is False and value.keys() - properties.keys():
            raise IntegrityError("unknown event fields")
        for key in value.keys() & properties.keys():
            _schema(value[key], properties[key])
    if isinstance(value, list):
        if len(value) < rule.get("minItems", 0) or len(value) > rule.get("maxItems", len(value)):
            raise IntegrityError("schema array bound")
        for item in value:
            _schema(item, rule.get("items", {}))
    if isinstance(value, str):
        if len(value) < rule.get("minLength", 0) or "pattern" in rule and not re.fullmatch(rule["pattern"], value):
            raise IntegrityError("schema string bound")
    if type(value) is int and value < rule.get("minimum", value):
        raise IntegrityError("schema integer bound")


def intervals(rows):
    result = set()
    last = 0
    for start, end in rows:
        if type(start) is not int or type(end) is not int or start <= last or end < start or end > 1_000_000 or len(result) + end - start + 1 > 1_000_000:
            raise IntegrityError("invalid or overlapping intervals")
        result.update(range(start, end + 1))
        last = end
    return result


def scope(rows):
    result = {}
    for row in rows:
        key = (path(row["path"]), row["blob"])
        if key in result:
            raise IntegrityError("duplicate scope path/blob")
        result[key] = intervals(row["intervals"])
    return result


def event(kind, source_key, occurred_at, payload):
    value = {"schema": "cq.review-ledger/v1", "event_type": kind,
             "source_key": source_key, "occurred_at": occurred_at, "payload": payload}
    value["id"] = digest(value)
    validate(value)
    return value


@functools.lru_cache(maxsize=4)
def _schema_for_bytes(raw):
    return loads(raw)


def validate(value):
    _schema(value, _schema_for_bytes(SCHEMA.read_bytes()))
    timestamp(value["occurred_at"])
    if value["id"] != digest({k: v for k, v in value.items() if k != "id"}):
        raise IntegrityError("event hash mismatch")
    p = value["payload"]
    if value["event_type"] == "review":
        expected = f"{p['repo']}:{p['source']['producer']}:{p['source']['id']}"
        if value["source_key"] != expected or p["source"]["repo"] != p["repo"]:
            raise IntegrityError("review source identity mismatch")
        requested, input_scope, reviewed = map(scope, (p["requested_scope"], p["input_scope"], p["reviewed_scope"]))
        if digest(p["requested_scope"]) != p["scope_digest"]:
            raise IntegrityError("scope digest mismatch")
        for key, lines in reviewed.items():
            if not lines <= requested.get(key, set()) or not lines <= input_scope.get(key, set()):
                raise IntegrityError("mapped review scope exceeds requested/input scope")
        dispositions = {}
        for row in p["paths"]:
            name = path(row["path"])
            if name in dispositions:
                raise IntegrityError("duplicate path disposition")
            dispositions[name] = row
        for name, blob in reviewed:
            row = dispositions.get(name, {})
            if row.get("disposition") not in ("included", "renamed") or row.get("blob") != blob:
                raise IntegrityError("credit on excluded or mismatched path")
        for finding in p["findings"]:
            if finding["path"] is not None:
                path(finding["path"])
            intervals(finding["intervals"])
            if finding["anchor_status"] == "verified" and (not finding["path"] or not finding["blob"] or not finding["intervals"]):
                raise IntegrityError("verified finding requires exact anchor")
        if p["outcome"] == "completed" and not creditable(value):
            raise IntegrityError("completed review lacks authenticated scoped completion")
    elif value["event_type"] == "finding-event":
        evidence = p["evidence"]
        if not evidence:
            raise IntegrityError("finding disposition requires evidence")
        if p["action"] in ("fixed", "already-fixed") and not (evidence.get("fixing_commit") and evidence.get("verification")):
            raise IntegrityError("fixed disposition requires fixing and verification evidence")
        if p["action"] == "delivered" and not (evidence.get("acknowledgement") and evidence.get("repair_task")):
            raise IntegrityError("delivery requires durable acknowledgement/task")
        if p["action"] == "confirmed" and not (evidence.get("target") and evidence.get("anchor_verified")):
            raise IntegrityError("confirmed finding requires current-tip anchor evidence")
    elif value["event_type"] == "job-state":
        if p["state"] == "quarantine-released" and not p.get("operator"):
            raise IntegrityError("quarantine release requires operator")
        if p["next_eligible_at"] is not None:
            timestamp(p["next_eligible_at"])
    elif value["event_type"] == "import-result":
        if p["result"] == "credited" and not p["review_id"] or p["result"] == "duplicate" and not p["duplicate_id"]:
            raise IntegrityError("import disposition lacks referenced review")
    return value


def creditable(value):
    if value.get("event_type") != "review":
        return False
    p = value["payload"]
    c, s = p["completion"], p["source"]
    producer = s["type"] == "crq-run" and s["producer"] == "crq-runner-app" or s["type"] == "github-review" and s["producer"] == "coderabbitai[bot]"
    return (p["outcome"] == "completed" and producer and s["authenticated"]
            and c["terminal"] and not c["skipped"] and c["scope_verified"]
            and c["exit_code"] == 0 and not c["errors"])


def record_path(value):
    at = timestamp(value["occurred_at"])
    return f"records/{at:%Y/%m}/{value['id']}.json"


def validate_sequence(values):
    sources, ids, reviews, findings, tips = {}, {}, {}, {}, {}
    for value in values:
        validate(value)
        key, ident = value["source_key"], value["id"]
        if key in sources and sources[key] != ident:
            raise IntegrityError("source evidence conflict")
        if ident in ids:
            continue
        sources[key], ids[ident] = ident, value
        if value["event_type"] == "review":
            reviews[ident] = value
            for finding in value["payload"]["findings"]:
                fid = finding["id"]
                if fid in findings:
                    raise IntegrityError("finding occurrence collision")
                findings[fid] = ident
                tips[fid] = None
        elif value["event_type"] == "finding-event":
            p = value["payload"]
            fid = p["finding_id"]
            if findings.get(fid) != p["review_id"] or fid not in tips or tips[fid] != p["previous_event_id"]:
                raise IntegrityError("missing finding or stale/forked predecessor")
            tips[fid] = ident
        elif value["event_type"] == "import-result":
            p = value["payload"]
            linked = p["review_id"] if p["result"] == "credited" else p["duplicate_id"]
            if linked and linked not in reviews:
                raise IntegrityError("import references missing review")
    return ids


def fsync_dir(directory):
    fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def atomic(filename, data):
    filename = Path(filename)
    filename.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=filename.parent, delete=False) as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
        temporary = stream.name
    os.replace(temporary, filename)
    fsync_dir(filename.parent)


@contextlib.contextmanager
def locked(filename):
    filename = Path(filename)
    filename.parent.mkdir(parents=True, exist_ok=True)
    with filename.open("a+b") as stream:
        fcntl.flock(stream, fcntl.LOCK_EX)
        yield


class ArtifactStore:
    """A separately provisioned durable volume, never transient runs/ storage."""
    def __init__(self, root):
        self.root = Path(root).resolve()

    def put(self, data):
        ident = hashlib.sha256(data).hexdigest()
        filename = self.root / "sha256" / ident
        if filename.exists():
            if filename.read_bytes() != data:
                raise IntegrityError("artifact store corruption")
        else:
            atomic(filename, data)
        return {"sha256": ident, "location": str(filename)}

    def verify(self, reference):
        expected = self.root / "sha256" / reference["sha256"]
        if Path(reference["location"]).resolve() != expected:
            raise IntegrityError("artifact outside configured durable store")
        hasher = hashlib.sha256()
        if not expected.is_file():
            raise IntegrityError("missing or corrupt retained artifact")
        with expected.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                hasher.update(chunk)
        if hasher.hexdigest() != reference["sha256"]:
            raise IntegrityError("missing or corrupt retained artifact")

    def put_file(self, filename):
        hasher = hashlib.sha256()
        with Path(filename).open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                hasher.update(chunk)
        ident = hasher.hexdigest()
        destination = self.root / "sha256" / ident
        destination.parent.mkdir(parents=True, exist_ok=True)
        if not destination.exists():
            with tempfile.NamedTemporaryFile(dir=destination.parent, delete=False) as stream:
                with Path(filename).open("rb") as source:
                    shutil.copyfileobj(source, stream)
                stream.flush(); os.fsync(stream.fileno()); temporary = stream.name
            os.replace(temporary, destination); fsync_dir(destination.parent)
        reference = {"sha256": ident, "location": str(destination)}
        self.verify(reference)
        return reference


class Outbox:
    def __init__(self, root, artifacts):
        self.root, self.artifacts = Path(root), artifacts

    def spool(self, value):
        validate(value)
        for reference in value["payload"].get("artifacts", []):
            self.artifacts.verify(reference)
        filename = self.root / "pending" / (value["id"] + ".json")
        with locked(self.root / "outbox.lock"):
            if filename.exists() and loads(filename.read_bytes()) != value:
                raise IntegrityError("outbox replay conflict")
            atomic(filename, canonical(value))
        return value["id"]

    def retained(self):
        """Acknowledged events remain recovery authority after local state loss."""
        return [loads(p.read_bytes()) for p in sorted((self.root / "pending").glob("*.json"))]

    def pending(self):
        return [value for value in self.retained()
                if not (self.root / "ack" / (value["id"] + ".json")).exists()]

    def acknowledge(self, value, remote_ids):
        if value["id"] not in remote_ids:
            raise IntegrityError("publication requires remote acknowledgement")
        atomic(self.root / "ack" / (value["id"] + ".json"), canonical({"id": value["id"]}))


class GitLedger:
    """Single publisher, isolated Git index; retries fetch/rebuild after push races."""
    def __init__(self, repo, remote="origin", branch="cq/review-ledger"):
        self.repo, self.remote, self.branch = Path(repo), remote, branch
        if remote.startswith("-") or branch != "cq/review-ledger":
            raise IntegrityError("invalid publication destination")

    def git(self, *args, env=None, input=None, check=True, timeout=300):
        return subprocess.run(["git", *args], cwd=self.repo, env=env, input=input,
                              capture_output=True, check=check, timeout=timeout).stdout

    def read(self, head):
        values = []
        commits = self.git("rev-list", "--reverse", head).decode().splitlines()
        for commit in commits:
            parents = self.git("rev-list", "--parents", "-n", "1", commit).decode().split()[1:]
            if len(parents) > 1:
                raise IntegrityError("ledger merge history unsupported")
            changes = self.git("diff-tree", "--root", "--no-commit-id", "-r", "--name-status", "-z", commit).split(b"\0")
            batch = []
            for i in range(0, len(changes) - 1, 2):
                status, filename = changes[i].decode(), changes[i + 1].decode()
                if status != "A":
                    raise IntegrityError("ledger history modifies/deletes existing records")
                mode = self.git("ls-tree", commit, "--", filename).split(b" ", 1)[0]
                if mode != b"100644":
                    raise IntegrityError("ledger records must be regular non-executable blobs")
                raw = self.git("show", commit + ":" + filename)
                value = loads(raw)
                validate(value)
                if filename != record_path(value):
                    raise IntegrityError("incorrect event location")
                batch.append(value)
            # A writer serializes transitions in separate commits. Reviews precede
            # imports; predecessor chains must already exist in earlier commits.
            values.extend(sorted(batch, key=lambda v: (v["event_type"] != "review", v["id"])))
        validate_sequence(values)
        return values

    def fetch(self):
        self.git("fetch", "--no-tags", self.remote, "refs/heads/" + self.branch)
        head = self.git("rev-parse", "FETCH_HEAD").decode().strip()
        checkpoint = "refs/crq/review-ledger-validated"
        previous = self.git("rev-parse", "--verify", "--quiet", checkpoint, check=False).decode().strip()
        if previous and subprocess.run(["git", "merge-base", "--is-ancestor", previous, head], cwd=self.repo, capture_output=True).returncode:
            raise IntegrityError("ledger head is not a descendant of validated history")
        values = self.read(head)
        self.git("update-ref", checkpoint, head, previous or "0" * len(head))
        return head, values

    def publish(self, outbox, attempts=3):
        common = self.git("rev-parse", "--git-common-dir").decode().strip()
        lock = (self.repo / common).resolve() / "review-ledger-publisher.lock"
        with locked(lock):
            for _ in range(attempts):
                head, values = self.fetch()
                ids = validate_sequence(values)
                pending = outbox.pending()
                # Order by causal dependencies rather than hash/file arrival.
                ordered, available = [], set(ids)
                while pending:
                    ready = []
                    for value in pending:
                        p = value["payload"]
                        deps = []
                        if value["event_type"] == "finding-event":
                            deps = [p["review_id"], p["previous_event_id"]]
                        elif value["event_type"] == "import-result":
                            deps = [p["review_id"], p["duplicate_id"]]
                        if all(d is None or d in available for d in deps):
                            ready.append(value)
                    if not ready:
                        raise IntegrityError("outbox has missing/forked causal dependencies")
                    for value in ready:
                        ordered.append(value); available.add(value["id"]); pending.remove(value)
                pending = ordered
                for value in pending:
                    if value["id"] in ids:
                        outbox.acknowledge(value, ids)
                        continue
                    for reference in value["payload"].get("artifacts", []):
                        outbox.artifacts.verify(reference)
                    if creditable(value):
                        from backfill_accounting import Repository
                        repository = Repository(self.repo)
                        repository.restore(value["payload"].get("artifacts", []), outbox.artifacts)
                        repository.verify_review(value)
                    validate_sequence(values + [value])
                    with tempfile.TemporaryDirectory() as directory:
                        env = dict(os.environ, GIT_INDEX_FILE=str(Path(directory) / "index"),
                                   GIT_AUTHOR_NAME="crq", GIT_AUTHOR_EMAIL="crq@localhost",
                                   GIT_COMMITTER_NAME="crq", GIT_COMMITTER_EMAIL="crq@localhost",
                                   GIT_AUTHOR_DATE=value["occurred_at"], GIT_COMMITTER_DATE=value["occurred_at"])
                        self.git("read-tree", head, env=env)
                        blob = self.git("hash-object", "-w", "--stdin", input=canonical(value)).decode().strip()
                        self.git("update-index", "--add", "--cacheinfo", "100644," + blob + "," + record_path(value), env=env)
                        tree = self.git("write-tree", env=env).decode().strip()
                        commit = self.git("commit-tree", tree, "-p", head, "-m", "Append review event " + value["id"], env=env).decode().strip()
                    try:
                        self.git("push", self.remote, commit + ":refs/heads/" + self.branch)
                    except (subprocess.SubprocessError, OSError):
                        break  # Includes timeout after push: next fetch reconciles.
                    head, values = self.fetch()
                    ids = validate_sequence(values)
                    outbox.acknowledge(value, ids)
                if not outbox.pending():
                    return head
            raise IntegrityError("publication pending; retain scope ownership and reconcile")
