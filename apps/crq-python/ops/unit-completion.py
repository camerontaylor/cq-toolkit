"""Read-only completion evidence from actual systemd invocation facts.

This module is a pure completion provider. It does not install, start, stop,
mask or restore a unit. It reads ``systemctl show`` and the user journal through
an injected ``JournalSource`` and returns evidence only when the observed
invocation is a completed, distinct, successful, selected-runtime invocation.

The selected identity is explicit. A provider constructed without the exact
rendered service digest, source commit, template blob and, for Node, artifact
identity refuses to return a completion. Hashing the currently installed file
alone is not enough.

No completion store, schema, ledger or fixture completion log is introduced.
The adapter remains responsible for the transaction, queue drain, activation
and the final selection checks. This provider only answers: "is there a
distinct successful systemd invocation of this exact selected unit and runtime,
and what are its actual systemd facts?"
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
import os
import re
import selectors
import shlex
import subprocess
import time
from pathlib import Path
from typing import Any, Callable, Mapping, Protocol, Sequence


HEX32_RE = re.compile(r"[0-9a-f]{32}")
HEX40_RE = re.compile(r"[0-9a-f]{40}")
HEX64_RE = re.compile(r"[0-9a-f]{64}")
UNIT_RE = re.compile(r"[A-Za-z0-9_.@:-]+\.service")
NODE_POINTER_RE = re.compile(
    r"^(?P<root>.+)/dist/queue-runner/crq\.js$")


class CompletionError(RuntimeError):
    """The source or the evidence cannot support a completion claim."""


class CompletionUnavailable(CompletionError):
    """The source is temporarily unavailable; the caller may retry."""


class CompletionRefused(CompletionError):
    """The observed facts cannot prove the required completion."""


@dataclass(frozen=True)
class ExpectedIdentity:
    """The selected, already rendered identity the completion must bind.

    ``service_sha256`` is the digest of the exact rendered service bytes that
    preflight selected and install released. ``source_sha`` and
    ``template_blob_oid`` name the pinned source. Node additionally carries the
    whole-artifact observed inventory identity produced by ``prepare-host``
    (``observed_content_sha256``). The adapter is responsible for re-rendering
    and verifying the artifact tree; this provider binds the service file and
    requires the expected fields.
    """
    unit: str
    runtime: str
    service_sha256: str
    source_sha: str
    template_blob_oid: str
    artifact_content_sha256: str | None = None
    artifact_source_sha: str | None = None
    crq_js_sha256: str | None = None

    @classmethod
    def from_render(cls, *, unit: str, runtime: str,
                    render: Mapping[str, Any]) -> "ExpectedIdentity":
        """Build the selected identity from a ``render_service`` result.

        The adapter already caches this result at preflight and install. This
        helper does not render or verify anything; it only maps the selected
        values into the completion contract.
        """
        if not isinstance(render, Mapping):
            raise CompletionRefused("render identity is not an object")
        if render.get("unit") != unit:
            raise CompletionRefused("render identity names a different unit")
        if render.get("runtime") != runtime:
            raise CompletionRefused("render identity names a different runtime")
        artifact = render.get("artifact")
        if artifact is not None and not isinstance(artifact, Mapping):
            raise CompletionRefused("render artifact identity is not an object")

        def value(key: str, source: Mapping[str, Any]) -> str:
            item = source.get(key)
            if not isinstance(item, str) or item == "":
                raise CompletionRefused("render identity lacks " + key)
            return item

        artifact_content_sha256 = None
        if artifact is not None:
            observed = value("observed_content_sha256", artifact)
            declared = value("declared_content_sha256", artifact)
            if observed != declared:
                raise CompletionRefused(
                    "render artifact digests disagree")
            artifact_content_sha256 = observed

        return cls(
            unit=unit,
            runtime=runtime,
            service_sha256=value("sha256", render),
            source_sha=value("source_sha", render),
            template_blob_oid=value("template_blob_oid", render),
            artifact_content_sha256=artifact_content_sha256,
            artifact_source_sha=(value("source_sha", artifact)
                                 if artifact is not None else None),
            crq_js_sha256=(value("crq_js_sha256", artifact)
                           if artifact is not None else None),
        )

    def validate(self) -> None:
        if not isinstance(self.unit, str) or UNIT_RE.fullmatch(self.unit) is None:
            raise CompletionRefused("expected identity names an invalid unit")
        if not isinstance(self.runtime, str) or not self.runtime:
            raise CompletionRefused("expected identity lacks a runtime")
        if self.runtime != "python" \
                and re.fullmatch(r"node:[0-9a-f]{40}", self.runtime) is None:
            raise CompletionRefused("expected identity has an invalid runtime")
        if not isinstance(self.service_sha256, str) \
                or HEX64_RE.fullmatch(self.service_sha256) is None:
            raise CompletionRefused("expected identity lacks a service digest")
        if not isinstance(self.source_sha, str) \
                or HEX40_RE.fullmatch(self.source_sha) is None:
            raise CompletionRefused("expected identity lacks a source commit")
        if not isinstance(self.template_blob_oid, str) \
                or HEX40_RE.fullmatch(self.template_blob_oid) is None:
            raise CompletionRefused("expected identity lacks a template blob")
        if self.runtime != "python":
            if not isinstance(self.artifact_content_sha256, str) \
                    or HEX64_RE.fullmatch(self.artifact_content_sha256) is None:
                raise CompletionRefused(
                    "expected node identity lacks an artifact content digest")
            if not isinstance(self.artifact_source_sha, str) \
                    or HEX40_RE.fullmatch(self.artifact_source_sha) is None:
                raise CompletionRefused(
                    "expected node identity lacks an artifact source commit")
            if not isinstance(self.crq_js_sha256, str) \
                    or HEX64_RE.fullmatch(self.crq_js_sha256) is None:
                raise CompletionRefused(
                    "expected node identity lacks the runner entry digest")
            if self.artifact_source_sha != self.runtime[5:]:
                raise CompletionRefused(
                    "expected node identity source does not match the pointer")


class JournalSource(Protocol):
    """Injected, read-only access to systemd and the journal."""

    def show(self, unit: str, props: Sequence[str]) -> Mapping[str, str]:
        """Return ``systemctl show`` property values for one unit."""

    def records(self, unit: str, *,
                after_monotonic: int) -> Mapping[str, Any]:
        """Return ``{"boot_id": str, "records": list[dict]}`` for one unit."""

    def boot_id(self) -> str:
        """Return the current kernel boot ID as 32 lowercase hex."""


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def parse_runtime_from_unit(path: Path) -> str:
    """Parse the installed unit's single ExecStart into python or node:<sha>.

    This mirrors the adapter's shape check without importing it. It does not
    prove the executable exists or that its artifact tree is intact; those are
    adapter responsibilities.
    """
    try:
        text = path.read_text()
    except OSError as exc:
        raise CompletionRefused("installed unit is unreadable: "
                                + str(exc)[:160]) from exc
    lines = [line for line in text.splitlines() if line.startswith("ExecStart=")]
    if len(lines) != 1:
        raise CompletionRefused("installed unit must contain one ExecStart")
    try:
        parts = shlex.split(lines[0][len("ExecStart="):])
    except ValueError as exc:
        raise CompletionRefused("installed unit ExecStart cannot be parsed: "
                                + str(exc)[:160]) from exc
    if len(parts) < 3 or Path(parts[0]).name != "env":
        raise CompletionRefused("installed unit ExecStart is not the expected shape")
    interpreter = Path(parts[1]).name
    script = str(Path(parts[2]))
    if interpreter == "python3":
        return "python"
    if interpreter == "node":
        match = NODE_POINTER_RE.fullmatch(script)
        if match is None:
            raise CompletionRefused(
                "installed node ExecStart is not the canonical artifact pointer")
        name = Path(match.group("root")).name
        if not name.startswith("crq-") \
                or HEX40_RE.fullmatch(name[4:]) is None:
            raise CompletionRefused(
                "installed node artifact pointer lacks a source commit")
        return "node:" + name[4:]
    raise CompletionRefused("installed unit interpreter is unsupported")


def _one(value: Any) -> str:
    if isinstance(value, list):
        if not value:
            return ""
        value = value[0]
    if value is None:
        return ""
    return str(value)


def _integer(value: Any) -> int | None:
    text = _one(value)
    if text == "":
        return None
    try:
        return int(text)
    except (TypeError, ValueError):
        return None


def parse_show_output(text: str) -> dict[str, str]:
    """Parse the simple ``Key=Value`` output of ``systemctl show``."""
    result: dict[str, str] = {}
    for line in text.splitlines():
        if line == "":
            continue
        if "=" not in line:
            raise CompletionRefused("systemctl show returned a malformed line")
        key, value = line.split("=", 1)
        if key == "" or key in result:
            raise CompletionRefused("systemctl show returned a duplicate property")
        result[key] = value
    return result


def parse_journal_json(text: str, *, max_records: int) -> list[dict[str, Any]]:
    """Parse bounded ``journalctl --output=json`` lines."""
    records: list[dict[str, Any]] = []
    for line in text.splitlines():
        if line.strip() == "":
            continue
        if len(records) >= max_records:
            raise CompletionRefused("journal response exceeds the record bound")
        try:
            record = json.loads(line)
        except (TypeError, ValueError) as exc:
            raise CompletionRefused("journal record is not valid JSON") from exc
        if not isinstance(record, dict):
            raise CompletionRefused("journal record is not an object")
        records.append(record)
    return records


def read_boot_id() -> str:
    """Read and normalize the current kernel boot ID."""
    try:
        text = Path("/proc/sys/kernel/random/boot_id").read_text().strip()
    except OSError as exc:
        raise CompletionUnavailable("kernel boot ID is unavailable: "
                                    + str(exc)[:160]) from exc
    value = text.replace("-", "").lower()
    if HEX32_RE.fullmatch(value) is None:
        raise CompletionRefused("kernel boot ID is malformed")
    return value


def _stop_process(process: subprocess.Popen) -> None:
    """Terminate and reap only the child this provider owns."""
    if process.poll() is not None:
        return
    try:
        process.terminate()
    except OSError:
        pass
    try:
        process.wait(timeout=1)
    except subprocess.TimeoutExpired:
        try:
            process.kill()
        except OSError:
            pass
        try:
            process.wait(timeout=1)
        except subprocess.TimeoutExpired:
            pass


def _read_bounded(process: subprocess.Popen, *, timeout: float,
                  max_bytes: int) -> tuple[bytes, bytes]:
    """Read both child streams without buffering past the byte bound.

    The selector drains stdout and stderr concurrently so a full stderr pipe
    cannot deadlock the child. Exceeding either stream bound refuses and the
    caller reaps the owned child. The timeout is measured over the whole read.
    """
    deadline = time.monotonic() + timeout
    if process.stdout is None or process.stderr is None:
        raise CompletionUnavailable("systemd read has no output streams")
    streams = {
        process.stdout: bytearray(),
        process.stderr: bytearray(),
    }
    try:
        with selectors.DefaultSelector() as selector:
            for stream in streams:
                selector.register(stream, selectors.EVENT_READ)
            while selector.get_map():
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise subprocess.TimeoutExpired(process.args, timeout)
                for key, _ in selector.select(remaining):
                    stream = key.fileobj
                    buffer = streams[stream]
                    try:
                        chunk = os.read(stream.fileno(), 65536)
                    except InterruptedError:
                        continue
                    if chunk == b"":
                        selector.unregister(stream)
                        continue
                    if len(buffer) + len(chunk) > max_bytes:
                        raise CompletionRefused(
                            "systemd read exceeds the byte bound")
                    buffer.extend(chunk)
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise subprocess.TimeoutExpired(process.args, timeout)
            process.wait(timeout=remaining)
    except CompletionError:
        raise
    except subprocess.TimeoutExpired:
        raise
    except (OSError, ValueError) as exc:
        raise CompletionUnavailable("systemd read failed") from exc
    return bytes(streams[process.stdout]), bytes(streams[process.stderr])


class SystemdJournalSource:
    """Read-only ``systemctl show`` and ``journalctl`` source.

    The source is intentionally not constructed by tests. It is the live
    binding used later by a parent-owned factory. Every command is read-only and
    bounded: ``max_bytes`` applies to each of stdout and stderr while both are
    drained concurrently. The unit name is validated before it reaches a
    command line.
    """

    def __init__(self, *, user: bool = True,
                 systemctl: str = "systemctl",
                 journalctl: str = "journalctl",
                 popen: Callable[..., subprocess.Popen] = subprocess.Popen,
                 timeout: float = 10.0,
                 max_bytes: int = 256 * 1024,
                 max_records: int = 256) -> None:
        self.user = user
        self.systemctl = systemctl
        self.journalctl = journalctl
        self.popen = popen
        self.timeout = timeout
        self.max_bytes = max_bytes
        self.max_records = max_records

    def _run(self, command: list[str]) -> str:
        process = None
        try:
            process = self.popen(
                command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                stderr=subprocess.PIPE)
        except OSError as exc:
            raise CompletionUnavailable("systemd read failed") from exc
        try:
            out, err = _read_bounded(process, timeout=self.timeout,
                                     max_bytes=self.max_bytes)
            if process.returncode != 0:
                raise CompletionUnavailable(
                    "systemd read returned %d" % process.returncode)
            try:
                output = out.decode("utf-8")
                err.decode("utf-8")
            except UnicodeDecodeError as exc:
                raise CompletionRefused(
                    "systemd read is not valid UTF-8") from exc
            return output
        except CompletionError:
            raise
        except subprocess.TimeoutExpired as exc:
            raise CompletionUnavailable("systemd read timed out") from exc
        finally:
            _stop_process(process)
            for stream in (process.stdout, process.stderr):
                if stream is not None:
                    stream.close()

    def _unit(self, unit: str) -> None:
        if UNIT_RE.fullmatch(unit) is None:
            raise CompletionRefused("invalid unit name")

    def show(self, unit: str, props: Sequence[str]) -> Mapping[str, str]:
        self._unit(unit)
        command = [self.systemctl]
        if self.user:
            command.append("--user")
        command += ["show", unit, "--no-pager"]
        for prop in props:
            command += ["--property", prop]
        return parse_show_output(self._run(command))

    def records(self, unit: str, *,
                after_monotonic: int) -> Mapping[str, Any]:
        self._unit(unit)
        if type(after_monotonic) is not int or after_monotonic < 0:
            raise CompletionRefused("invalid journal lower bound")
        command = [self.journalctl]
        if self.user:
            command.append("--user")
        # journalctl has no monotonic --since. Fetch a bounded tail and let the
        # provider filter by boot, invocation and record bound.
        command += ["--user-unit" if self.user else "--unit", unit,
                    "--output=json", "--no-pager",
                    "--lines=%d" % self.max_records]
        text = self._run(command)
        return {"boot_id": read_boot_id(),
                "records": parse_journal_json(text, max_records=self.max_records)}

    def boot_id(self) -> str:
        return read_boot_id()


class SystemdJournalCompletionPort:
    """Completion provider over injected systemd and journal facts."""

    def __init__(self, *, unit_dir: Path, source: JournalSource,
                 expected: ExpectedIdentity,
                 now: Callable[[], float] = time.time,
                 max_records: int = 256,
                 require_journal_witness: bool = False) -> None:
        expected.validate()
        self.unit_dir = Path(unit_dir)
        self.source = source
        self.expected = expected
        self.now = now
        self.max_records = max_records
        self.require_journal_witness = require_journal_witness
        self._baseline_boot_id: str | None = None
        self._baseline_invocation = ""
        self._baseline_sequence = 0
        self._baseline_set = False
        self._returned: set[str] = set()

    # -- source helpers -------------------------------------------------
    def _show(self, unit: str) -> dict[str, str]:
        props = ("LoadState", "ActiveState", "SubState", "InvocationID",
                 "Result", "ExecMainStatus", "ExecMainExitTimestampMonotonic",
                 "FragmentPath")
        try:
            values = self.source.show(unit, props)
        except CompletionError:
            raise
        except Exception as exc:
            raise CompletionUnavailable("systemd show failed: "
                                        + (str(exc) or type(exc).__name__)[:200]) from exc
        if not isinstance(values, Mapping):
            raise CompletionRefused("systemd show did not return properties")
        result = {}
        for prop in props:
            if prop not in values:
                raise CompletionRefused("systemd show omitted " + prop)
            value = values[prop]
            if not isinstance(value, str):
                raise CompletionRefused("systemd show property is not a string")
            result[prop] = value
        return result

    def _boot(self) -> str:
        try:
            value = self.source.boot_id()
        except CompletionError:
            raise
        except Exception as exc:
            raise CompletionUnavailable("boot ID read failed: "
                                        + (str(exc) or type(exc).__name__)[:200]) from exc
        if not isinstance(value, str):
            raise CompletionRefused("boot ID is not a string")
        value = value.replace("-", "").lower()
        if HEX32_RE.fullmatch(value) is None:
            raise CompletionRefused("boot ID is malformed")
        return value

    def _service(self, unit: str, runtime: str) -> tuple[Path, str]:
        path = self.unit_dir / unit
        if path.is_symlink() or not path.is_file():
            raise CompletionRefused("installed service is not a regular file")
        if parse_runtime_from_unit(path) != runtime:
            raise CompletionRefused("installed unit does not select the runtime")
        digest = sha256_file(path)
        if digest != self.expected.service_sha256:
            raise CompletionRefused(
                "installed service digest does not match the selected render")
        return path, digest

    def _unit_and_runtime(self, unit: str, runtime: str) -> None:
        if unit != self.expected.unit:
            raise CompletionRefused("unit does not match the selected identity")
        if runtime != self.expected.runtime:
            raise CompletionRefused("runtime does not match the selected identity")

    # -- CompletionPort contract ----------------------------------------
    def sequence(self, unit: str) -> int:
        """Return the baseline completed-invocation monotonic sequence.

        A masked or never-run unit has no completed invocation, so the first
        baseline is 0. An active or transitioning unit is not a stable
        baseline and refuses. The baseline invocation ID is retained only as a
        distinctness hint; retention across mask, reload or unload is not
        assumed.

        The controller re-reads the sequence after its drain/mask, while the
        adapter preflight read it with the prior unit installed. A later
        masked or zero observation never lowers an established baseline: doing
        so would let the prior runtime's completed invocation be credited to
        the selected runtime. A newer successful prior invocation may raise
        it.
        """
        self._unit_and_runtime(unit, self.expected.runtime)
        show = self._show(unit)
        fragment = Path(show["FragmentPath"])
        if fragment.resolve() != (self.unit_dir / unit).resolve():
            raise CompletionRefused("installed unit path does not match the selected unit")
        active = show["ActiveState"]
        if active != "inactive":
            raise CompletionRefused("unit is not in a stable inactive state")
        invocation = show["InvocationID"]
        if invocation and HEX32_RE.fullmatch(invocation) is None:
            raise CompletionRefused("baseline InvocationID is malformed")
        exit_monotonic = _integer(show["ExecMainExitTimestampMonotonic"])
        if exit_monotonic is None or exit_monotonic < 0:
            raise CompletionRefused("baseline exit timestamp is malformed")
        result = show["Result"]
        status = show["ExecMainStatus"]
        if show["LoadState"] == "masked" or exit_monotonic == 0:
            if self._baseline_set:
                return self._baseline_sequence
            baseline = 0
            invocation = ""
        elif result == "success" and status == "0":
            baseline = exit_monotonic
        else:
            raise CompletionRefused("prior completed invocation is not successful")
        if self._baseline_set and baseline <= self._baseline_sequence:
            return self._baseline_sequence
        self._baseline_boot_id = self._boot()
        self._baseline_invocation = invocation
        self._baseline_sequence = baseline
        self._baseline_set = True
        self._returned.clear()
        return baseline

    def read(self, unit: str, runtime: str, previous: int) -> dict[str, Any] | None:
        """Return one completion, or None when no new completion is visible.

        A completed invocation with failed status or an identity mismatch
        raises. A still-running invocation returns None. A completed invocation
        that is not distinct from the baseline or a previous return also
        returns None; the adapter's deadline turns that into a refusal.
        """
        self._unit_and_runtime(unit, runtime)
        if not self._baseline_set:
            raise CompletionRefused("completion baseline was not established")
        if type(previous) is not int or previous < 0:
            raise CompletionRefused("invalid completion sequence")
        # systemctl show is the mandatory manager exit witness. Journal records
        # are separate corroboration because quiet oneshot emission is unproven.
        show = self._show(unit)
        fragment = Path(show["FragmentPath"])
        if fragment.resolve() != (self.unit_dir / unit).resolve():
            raise CompletionRefused("installed unit path does not match the selected unit")
        load = show["LoadState"]
        if load == "masked":
            return None
        if load != "loaded":
            raise CompletionRefused("installed unit is not loaded")
        active = show["ActiveState"]
        if active in ("active", "activating", "reloading"):
            return None
        if active == "failed":
            raise CompletionRefused("unit is failed")
        if active != "inactive" or show["SubState"] != "dead":
            return None

        result = show["Result"]
        status = show["ExecMainStatus"]
        if result != "success":
            if result == "":
                return None
            raise CompletionRefused("unit result is not success: " + result)
        if status != "0":
            raise CompletionRefused("unit exit status is not zero: " + status)
        exit_monotonic = _integer(show["ExecMainExitTimestampMonotonic"])
        if exit_monotonic is None or exit_monotonic <= 0:
            return None
        if exit_monotonic <= previous:
            return None

        invocation = show["InvocationID"]
        if invocation == "":
            return None
        if HEX32_RE.fullmatch(invocation) is None:
            raise CompletionRefused("completion InvocationID is malformed")
        if invocation == self._baseline_invocation or invocation in self._returned:
            return None

        _, service_sha = self._service(unit, runtime)
        boot = self._boot()
        if self._baseline_boot_id is not None \
                and boot != self._baseline_boot_id:
            raise CompletionRefused("boot ID changed during the completion window")

        witness = self._witness(unit, invocation, boot, exit_monotonic)
        if witness is None and self.require_journal_witness:
            raise CompletionRefused(
                "no journal witness for the completed invocation")
        self._returned.add(invocation)
        return {
            "unit": unit,
            "runtime": runtime,
            "success": True,
            "sequence": exit_monotonic,
            "invocation": invocation,
            "service_sha256": service_sha,
            "source_sha": self.expected.source_sha,
            "template_blob_oid": self.expected.template_blob_oid,
            "artifact_content_sha256": self.expected.artifact_content_sha256,
            "artifact_source_sha": self.expected.artifact_source_sha,
            "crq_js_sha256": self.expected.crq_js_sha256,
            "boot_id": boot,
            "witness": witness or "none",
            "at": self._at(),
        }

    # -- journal witness ------------------------------------------------
    def _witness(self, unit: str, invocation: str, boot: str,
                 exit_monotonic: int) -> str | None:
        try:
            response = self.source.records(unit, after_monotonic=exit_monotonic)
        except CompletionUnavailable:
            if self.require_journal_witness:
                raise
            return None
        if not isinstance(response, Mapping):
            raise CompletionRefused("journal response is not an object")
        if response.get("boot_id") != boot:
            raise CompletionRefused("journal boot ID does not match the unit boot")
        records = response.get("records")
        if not isinstance(records, list):
            raise CompletionRefused("journal records are not a list")
        if len(records) > self.max_records:
            raise CompletionRefused("journal response exceeds the record bound")
        found: str | None = None
        for record in records:
            if not isinstance(record, Mapping):
                raise CompletionRefused("journal record is not an object")
            if _one(record.get("_BOOT_ID")) != boot:
                continue
            raw_monotonic = record.get("__MONOTONIC_TIMESTAMP")
            if raw_monotonic is None or raw_monotonic == "":
                raise CompletionRefused(
                    "journal monotonic timestamp is missing")
            record_monotonic = _integer(raw_monotonic)
            if record_monotonic is None:
                raise CompletionRefused(
                    "journal monotonic timestamp is malformed")
            unit_process = (
                (_one(record.get("_SYSTEMD_USER_UNIT")) == unit
                 and _one(record.get("_SYSTEMD_INVOCATION_ID")) == invocation)
                or (_one(record.get("_SYSTEMD_UNIT")) == unit
                    and _one(record.get("_SYSTEMD_INVOCATION_ID")) == invocation))
            manager = (
                (_one(record.get("USER_UNIT")) == unit
                 and _one(record.get("USER_INVOCATION_ID")) == invocation)
                or (_one(record.get("UNIT")) == unit
                    and _one(record.get("INVOCATION_ID")) == invocation))
            if unit_process:
                found = "unit-process"
            elif manager:
                found = "manager"
            if found is not None:
                break
        return found

    def _at(self) -> str:
        return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(self.now()))
