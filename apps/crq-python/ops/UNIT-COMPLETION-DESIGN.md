# Unit completion provider design

2026-11-12. Companion to `ops/unit-completion.py` and
`test_unit_completion.py`. This is a read-only evidence provider. It does not
install, start, stop, mask or restore a unit, and it is not wired into the
production adapter or controller.

## Contract

The provider answers one question: is there a distinct successful systemd
invocation of the exact selected unit and runtime, and what are its actual
systemd facts?

Evidence must bind:

* **Unit**: `systemctl show` `FragmentPath` equals the selected installed unit
  in `unit_dir`, and the journal witness names the same unit.
* **Runtime**: the installed `ExecStart` parses to `python` or
  `node:<source-sha>`.
* **Selected identity**: the installed service SHA-256 equals the expected
  rendered service digest, and the evidence carries the selected source commit
  and template blob. Node also carries the verified observed whole-artifact
  content digest, artifact source SHA and `crq.js` digest. The adapter is
  responsible for re-rendering and verifying the artifact tree against the
  manifest; this provider requires the selected values and rejects a bare
  current-file echo.
* **Invocation**: `systemctl show` `InvocationID` is 32 lowercase hex, is not
  the baseline invocation, and is not already returned.
* **Sequence**: `ExecMainExitTimestampMonotonic` is a `CLOCK_MONOTONIC`
  microsecond integer, strictly greater than the previous sequence.
* **Success**: `Result=success`, `ExecMainStatus=0`, `ActiveState=inactive`,
  `SubState=dead`. Other `Result` values refuse.
* **Boot**: the baseline and completion boot IDs match. A boot change during the
  transaction refuses as ambiguous.

Two distinct advancing completions are required by the controller. A reboot
during the transaction is an ambiguity, not a lower sequence.

## Systemd field audit

Local systemd 259 man pages were read. They are primary documentation, not a
live host query. Sources: `systemd.journal-fields(7)` sections
`INVOCATION_ID=, USER_INVOCATION_ID=`, `UNIT=, USER_UNIT=`,
`_SYSTEMD_INVOCATION_ID=` and `__MONOTONIC_TIMESTAMP=`; `systemd.exec(5)`
`$INVOCATION_ID`; `org.freedesktop.systemd1(5)` `InvocationID`,
`ExecMainExitTimestampMonotonic`, `Result` and `ExecMainStatus`; and
`journalctl(1)` `--unit` and `--user-unit`.

`systemd.journal-fields(7)` distinguishes:

* `_SYSTEMD_UNIT=` / `_SYSTEMD_USER_UNIT=` and
  `_SYSTEMD_INVOCATION_ID=` for messages from the unit's own processes.
* `UNIT=` / `USER_UNIT=` and `INVOCATION_ID=` / `USER_INVOCATION_ID=` for
  messages from the system or user manager about a unit.

`journalctl --unit` expands to `_SYSTEMD_UNIT=NAME` plus manager matches such as
`UNIT=NAME _PID=1`. `journalctl --user-unit` similarly adds
`_SYSTEMD_USER_UNIT=` and manager matches. A quiet `Type=oneshot` service may
emit no unit-process message. The provider therefore accepts both families and
does not infer invocation absence from a missing `_SYSTEMD_*` record. A manager
witness may be logged at or after the main process exit is detected, so the
provider matches boot, unit and invocation and does not require the journal
timestamp to precede `ExecMainExitTimestampMonotonic`.

`systemd.exec(5)` says `$INVOCATION_ID` is a new 128-bit ID assigned when a unit
changes from inactive to activating or active. `org.freedesktop.systemd1(5)`
exposes `InvocationID` as a read-only property but does not document retention
across unload, `daemon-reload` or `mask`. The provider captures the first ID
immediately after `start()` and does not rely on a completed ID surviving a mask
or reload.

`org.freedesktop.systemd1(5)` defines `ExecMainExitTimestampMonotonic` as a
`CLOCK_MONOTONIC` microsecond timestamp. `systemd.journal-fields(7)` defines
`__MONOTONIC_TIMESTAMP` as `CLOCK_MONOTONIC` microseconds. They are comparable
only within one `_BOOT_ID`.

`Result=success` means the unit did not fail. `ExecMainStatus` is the main
process exit status. A successful oneshot requires both. `ExecMainCode` is not
documented in the local man page and is not required.

## Unproven facts

The following are deliberately not claimed:

* Whether `crq-tick.service` or `crq-slot.service` manager messages actually
  carry `USER_INVOCATION_ID`, and whether a quiet oneshot emits any matching
  journal record. The retained PR1512 evidence contains fixture completion
  records, not a raw `journalctl --user --user-unit` export. The mandatory
  manager exit witness is `systemctl show` `Result=success`,
  `ExecMainStatus=0` and a 32-hex `InvocationID`; a missing or malformed one
  never returns a completion. The optional journal witness is separate
  corroboration. The provider defaults to show-only mode and reports a missing
  journal record as `witness: none`. `require_journal_witness=True` is
  available for a strict parent-owned proof.
* That a completed `InvocationID` survives mask, reload or unload.
* That a read-time service hash proves the bytes systemd loaded at invocation
  start. Equal digests at preflight, start and completion prove observed
  consistency, not historical bytes. A replace-and-restore between observations
  is not excluded. `systemctl show` exposes no unit file digest and the journal
  does not record unit file bytes.
* That journald is a complete invocation ledger. The provider refuses a current
  invocation that differs from the captured start invocation, but it cannot
  prove no intermediate invocation occurred. It does not claim skip detection.

## Source interface

`JournalSource` is injected:

```python
def show(unit, props) -> Mapping[str, str]
def records(unit, *, after_monotonic) -> {"boot_id": str, "records": list[dict]}
def boot_id() -> str
```

`SystemdJournalSource` is the live read-only implementation. It runs
`systemctl --user show` and `journalctl --user --user-unit` with bounded output.
It is not constructed by tests. A parent-owned factory is the only place that
may bind it later.

The provider is pure over the injected source. Tests use a fake source and real
temporary unit files. The source command tests use an injected runner and never
invoke `systemctl` or `journalctl`.

## Minimal adapter proposal

The `CompletionPort` interface is unchanged:

```python
sequence(unit) -> int
read(unit, runtime, previous) -> dict | None
```

The adapter changes, if it is wired later:

1. Add `SUPPORTED_UNITS = {"crq-tick.service", "crq-slot.service"}` and refuse
   every other unit before mutation.
2. In `start()`, after the blocking service start and before releasing
   activators, read `InvocationID` with the existing `_show` and store it as
   `self._service_invocation`. Refuse if it is not 32 lowercase hex.
3. Build the expected identity with
   `ExpectedIdentity.from_render(unit=unit, runtime=runtime,
   render=self._rendered[(unit, runtime)])`. That cached `render_service`
   result already carries `sha256`, `source_sha`, `template_blob_oid` and, for
   Node, the nested `artifact` identity including its verified
   `observed_content_sha256`. No preflight return change is needed.
4. In `completion()`, require the first completion invocation to equal
   `self._service_invocation`, then clear the expectation. Require
   `service_sha256` to equal both `self._install["sha256"]` and
   `self._rendered[(unit, runtime)]["sha256"]`. Re-render with
   `self._render(unit, runtime)` and require the fresh digest to match. For Node
   this re-runs `artifact_identity` over the artifact tree. For Python it
   re-reads the pinned template and checks the script path.
5. Add `source_sha`, `template_blob_oid` and the observed `service_sha256` to
   the returned evidence. The controller accepts extra keys; no journal schema
   version changes.
6. Do not change the controller, queue, heartbeat, templates, queue schema or
   production factory in this slice.

No new store, schema, completion log, CLI enablement or approval mechanism is
introduced. Queue drain and heartbeat health remain adapter and controller
responsibilities. A completion is not credit for completed queue work.

## Proof

Offline tests cover sequence baselines, two advancing distinct invocations,
duplicate invocation suppression, failed and nonzero exits, active and
transitional states, boot changes, selected digest mismatch, runtime mismatch,
unit mismatch, manager and unit-process witnesses, quiet oneshot show-only,
strict witness refusal, foreign witnesses, malformed and oversized journal
records, selected identity validation and read-only source command shape.

The live blocker after this provider is the parent-owned raw user-journal
export and VM proof. Without it, strict journal witness mode remains unproven
for quiet oneshot. The Node direction also remains blocked by the dry-run
TypeScript runner and the empty Node capability declaration.
