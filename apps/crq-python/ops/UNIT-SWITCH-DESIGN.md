# Per-unit switch and recovery: design for review

Status: proposed, not a cutover authorization. The controller CLI composes the
injected switch path (`switch --unit ... --runtime ...`) and the production
recovery entry point (`recover --record ...`), and the adapter reads a
machine-readable capability declaration from the verified artifact. A unit
recovery adapter exists: `ProductionUnitAdapter` implements `validate_snapshot`,
`restore` and `restore_activation`, and the controller's `recover_unit` seam is
reachable from the production CLI. What is missing is live evidence, not the
adapter or the entry point: the recovery snapshot's host operations still need
an independent design review and disposable-VM proof, and no production switch
or recovery has run on a host.

A bounded proof vehicle now exercises the actual ``switch_unit``/``recover_unit``
seam against two declared harmless fixtures in a disposable KVM guest. The
original tick topology run
``20261110T173225Z-de36ec18`` passed both directions, preactivation
interruption, interrupted recovery, repeat-recovery refusal and the
activation-fence probe. The second ``crq-repair`` topology adds a timer, a path
activator and one declared blocker drop-in, and is exercised by a dedicated
``activators`` mode with its own allowlisted inventory, positive controls,
refusal matrix, queued-job fence and interrupt/recovery path. It is
fixture-only evidence, not production enablement: production journal
interoperability, a real runtime-bound completion provider, exhaustive
activator discovery, and path-topology manager-restart/reboot remain open. See
[VM-UNIT-SWITCH-PROOF.md](VM-UNIT-SWITCH-PROOF.md).

## Probe evidence and its limits

On an Ubuntu 24.04 disposable CI VM with systemd 255, a synthetic installed
service replaced by a `/dev/null` symlink and reloaded rejected direct and
`Requires` activation; the fixture also stopped and drained a running oneshot
and restored service bytes and the tested timer/path activation states over two
cycles. [Initial probe](https://github.com/camerontaylor/cq-toolkit/actions/runs/42718122972/job/129504830357).

A queued service job remained queued after the mask and reload. In one case it
cleared without executing after its blocker completed; in a separate case an
explicit stop before releasing the blocker also prevented execution. This is
not evidence that masking cancels an existing job. The adapter must explicitly
stop and verify pending service jobs and owned work as well as activators.
[Queued-job probe](https://github.com/camerontaylor/cq-toolkit/actions/runs/42719123792/job/129508262599).

A separate synthetic procedure wrote and fsynced an intent, was killed at six
transaction boundaries, and restored its tested bytes and activation states
on two recovery attempts at each boundary. That experiment did not run this
controller, test interruption during recovery, or establish restoration of
all file metadata and symlinks. [Synthetic crash probe](https://github.com/camerontaylor/cq-toolkit/actions/runs/42718527065/job/129506220673).
The overall job failed at the later manager-restart step.

A [bounded recovery probe](https://github.com/camerontaylor/cq-toolkit/actions/runs/42721329538/job/129515746878)
on an already-running CI user manager tested a synthetic service symlink to a
0640 backing file with an enabled and active timer. After SIGKILL at six
recovery boundaries, two retries at each boundary restored the tested bytes,
backing-file mode and uid/gid, service symlink target and uid/gid, enablement
link target, and timer enabled/active state. This used synthetic recovery logic
and same-user ownership, not the controller or arbitrary privileged ownership;
it did not test enablement-link ownership/mode, xattrs, ACLs, or power loss.
It covered one state combination and did not restart the manager or reboot.
[Earlier repeated starts](https://github.com/camerontaylor/cq-toolkit/actions/runs/42721244160/job/129515458405)
hit the timer start limit; the passing fixture disabled that limit only for its
synthetic timer. It does not show that production repeated activation avoids
rate limits.

Both synthetic user-manager restarts timed out during startup. The diagnostic
job is green because it recorded the failures as data; it is not a restart pass.
Socket startup helpers blocked while setting the manager environment; the cause
was not established and the initial environment comparison was not fully
hermetic. [Restart diagnosis](https://github.com/camerontaylor/cq-toolkit/actions/runs/42720216729/job/129511976423).
No VM reboot or power-loss test has been performed.

## Offline rendering separation and identity binding

`prepare-host.render_units` now shares a pure byte-render core
(`render_service_text`) with a separate read-only, adapter-facing wrapper
(`render_service`). The wrapper reads the exact
`apps/crq-python/ops/systemd/<unit>` template from a resolved immutable
commit, verifies the Git blob object identity, and returns the rendered bytes
plus the source commit, template path, blob object id and byte digests. For
`node:<sha>` it also checks the packaged artifact against its schema-2
`artifact-manifest.json` using the existing package-runner inventory,
canonical content-digest, required-entry and staged-provenance semantics. That
check is integrity of the observed artifact against its manifest, not
authenticity; it does not execute the runner or load dependencies.

`render_units` keeps its existing behavior and byte output, including the
ability to render a `node:` unit before its artifact is installed. The new
wrapper's stricter artifact checks do not become a prerequisite for the old
renderer.

The CLI switch path is wired (see below), the capability check reads the
declaration this wrapper binds by inventory, and `watchdog` is the first
declared Node command. Rendering a `node:` unit for any other command does not
make that command available. Real per-unit runtime-bound completion on a live
host, exhaustive activation discovery, shared root/lock coverage, drain races,
and restart/reboot/power-loss behavior remain separate acceptance work.

## Production adapter slice

`ops/unit-adapter.py` implements the injected seam with an injected
`SystemdPort`, `IdentityPort`, `CapabilityPort`, `CompletionPort` and
queue-drain observation. It reuses `render_service`, derives its declared
six-unit inventory from the pinned template blobs, and reuses the guest
snapshot payload's schema-version-1 top-level keys and state shapes. It is
composed by `unit-switch-factory.py` and reached through the controller CLI's
`switch` verb. It has no live systemd binding in these offline tests. Node
refuses unless the verified artifact's declaration lists the selected command;
`watchdog` is currently the only such command.

The slice remains fail-closed: discovery must enumerate the exact declared
paths and units and report no foreign activators; unknown entries, missing
completion or queue observations, live jobs, malformed cgroups, non-advancing
or foreign completion evidence, and unsupported snapshot metadata refuse before
mutation or at the fenced boundary. Restore stages the prior service behind the
durable mask; only `restore_activation` releases it, and the caller must have
persisted the pending journal first. The controller lock remains
checkout-local, and the adapter claims no root, caller, arbitrary activator or
production completion coverage. `test_unit_adapter.py` exercises both
runtimes, forward and recovery, real temporary files and injected host ports
only.

Installed environment drop-ins are part of the declared topology, not an
external exception. The production host carries `20-paseo-env.conf` (the shared
messaging environment) under the watchdog, tick and slot service units, and
`coderabbit-managed.conf` under tick and slot. The adapter accepts exactly those
names as a real, identity-owned directory with no group or world write bits;
each entry must be an identity-owned regular file, or an absolute symlink to an
identity-owned regular file outside the unit directory. It never writes,
removes or renames them, so the alert environment survives switch and rollback
unchanged. It reads only the declared drop-in text and allows only
`Environment=` and `EnvironmentFile=` under `[Service]`; any `Type=`,
`TimeoutStartSec=`, execution-shape or activation-shape key refuses before
mutation, so a drop-in cannot invalidate the completion bound derived from the
main unit template. It never follows an `EnvironmentFile=` target. A drop-in
directory for another unit, another entry name, a symlinked directory, or an
unsafe entry target also refuses. Because these paths are host-installed rather
than owned snapshot paths, the adapter revalidates the declared shape at every
phase and the regression test asserts the directory, entries and shared target
are unchanged across a full switch and rollback. The live discovery binding
shares the same declaration, accepts the declared entry names in a real
directory, and still scans their text for dependency directives, so an
absolute environment symlink outside the unit directory is not mistaken for a
dependency escape and a drop-in cannot introduce an unaccounted incoming
activator.

The completion budget is derived from the declared topology rather than a
fixed default. Preflight requires the prior timer to be active, parses the
committed timer schedule and service start timeout, and refuses when the
declared bound exceeds the supported maximum or the caller's deadline is below
it. An inactive timer has no bounded second invocation and refuses before
snapshot or mutation; the 6-hour backfill and 45-minute publisher shapes exceed
the default supported maximum, and an oneshot without a declared start timeout
has no bounded completion and refuses. The watchdog template now declares
`TimeoutStartSec=5min`, so its 300 s start bound and 720 s timer period fit the
1,800 s supported maximum. A
`Type=simple` service has no declared invocation execution bound either, so
preflight refuses that topology rather than treating its startup timeout as a
completion bound; restore still rejects a failed simple service if a recovery
snapshot supplies one. The verified Node artifact tree must also
resolve to the rendered canonical ExecStart tree; an alternate tree that
passes manifest verification is rejected. Staged mode, ownership and xattrs are
validated before the atomic release, so a tampered staged file refuses while
the durable mask is still in place. A forward fence re-checks service bytes
against the snapshot (or the verified rendered target after release); a fresh
recovery adapter does not require the post-switch service to equal the prior
snapshot. `restore_activation` rejects a failed service and requires a simple
service to be active. Drain diagnostics distinguish queued jobs, owned
processes, active services and active activators, and malformed `list-jobs`
observations refuse. A pre-release refusal at `start` leaves the mask in place,
and a failure after `start` is restored automatically only when the fence
demonstrates absence: no matching systemd job, no owned process, an inactive
service, inactive activators and, for an issuing unit, a drained queue. The
rolled-back record keeps the failed phase, the original reason and the fence
observation, so the target's execution is not erased. A fence that cannot
establish absence, or an installed file that matches neither the snapshot nor
the verified released render, stays `recovery_required`.

The installed timer file must hash-match the pinned template before its
schedule is used, so preflight cannot certify a bound for a timer the
transaction will not install. Service start commands use the declared
`TimeoutStartSec` plus the completion margin (`_service_start_timeout`) rather
than a fixed 60-second command timeout; the same applies to the restore service
start. A blocking `systemctl start` for a healthy 10-minute oneshot therefore
does not fail the transaction at 60 seconds.

Restore applies the saved service active/inactive policy and verifies it before
releasing any timer or path activator. A timer or path that then starts the
service is a normal new activation and is not stopped by the recovery. This
avoids killing a path-triggered publisher run after the path is restarted.
Injected capability and completion-sequence failures are converted to refusals
in preflight, so a port exception cannot bypass the adapter's error type.

## Non-issuing watchdog transactions

The controller's queue-drain gate and the adapter's post-fence queue
observation serialize a transaction that stops a unit which can create or
advance queue work. `crq-watchdog.service` is not such a unit: it reads the
completed-tick heartbeat and sends an alert, and writes only its own
`watchdog-state.json`; it never launches a run, advances `queue.json` or
rewrites the heartbeat. `deploy-controller.py` and `unit-adapter.py` therefore
share one explicit classification (`QUEUE_NON_ISSUING_UNITS`, currently only
the watchdog). Every other declared unit is treated as issuing, so a future
unit stays fail-closed until this declaration is extended deliberately. Both
the switch and recovery gates, and the adapter's own post-systemd
observation, are skipped for a non-issuing unit. Its systemd job, cgroup and
activator drain, snapshot/restore, completion evidence and activation fences
are unchanged.

The preservation digest scope follows the same classification. A queue-issuing
transaction captures and compares `queue.json` and the completed heartbeat
byte-for-byte; a non-issuing watchdog transaction captures no queue surface.
That is what makes concurrency safe rather than merely permitted: a live run
owned by another unit may legitimately harvest progress, and the watchdog
switch neither reads that progress as a conflict nor restores a stale
snapshot over it. No queue or heartbeat bytes are ever written or restored
from this evidence; the journal retains the unit snapshot only.

## Offline factory composition

`ops/unit-switch-factory.py` is the internal composition of the merged pieces:
it renders the selected target once through `render_service`, binds a
`SystemdJournalCompletionPort` to that exact selected identity, and constructs
`ProductionUnitAdapter` with `DeclaredCapabilities` and injected systemd,
identity, journal-source and queue-drain ports. The controller CLI calls it
through the live binding for `switch --unit ... --runtime ...`; it still has no
live systemd or journal binding in tests. The factory reads the verified
artifact's declared live commands and passes them to `DeclaredCapabilities`, so
the existing capability check decides whether the selected command is
available.

The lifecycle is the controller's, unchanged: preflight reads the completion
baseline while the prior runtime is installed; the controller drains and masks;
the adapter installs and starts the rendered target; completion evidence must
name the selected source commit, template blob and service digest, and two
distinct advancing successful invocations; otherwise the transaction refuses
or requires recovery. Recovery restores the prior runtime's exact bytes. The
provider retains the pre-install baseline across the controller's post-drain
masked re-read, so a masked observation cannot lower it and a prior runtime
invocation cannot be credited to the selected runtime.

Recovery composes through the same factory for the record's `prior_runtime`, not
for the abandoned target: the target's artifact may no longer be installed and
the retained snapshot is authoritative for the restored bytes, modes, ownership
and activation. The controller invokes that composition callback under its
existing lock, after record-shape validation (including
`snapshot.runtime == prior_runtime`) and the read-only queue-drain gate, and
before `validate_snapshot`. Composition therefore cannot race a second record
read, and a composition failure is an ordinary refusal before any unit mutation
or journal write, never a `recovery_required` state. The composed render is not
consumed by recovery.

`test_unit_switch_factory.py` runs the real adapter, the real completion port
and the real renderer through the actual `switch_unit`/`recover_unit` seams over
real temporary unit files, with a structured systemd port and a journal source
that returns systemd invocation and record fields. It covers a completed
Node-to-Python switch with two advancing invocations, a pre-activation rollback
followed by `recover_unit`, a reboot during completion that rolls back through
a demonstrated fence, a completion-observation failure that restores the prior
unit and timer without manual recovery, changed installed bytes that stay
`recovery_required`, a Python-to-Node watchdog switch whose artifact declares
`watchdog`, and
fail-closed refusal of a Node target whose declaration is empty or names
another command, plus the simple, long-schedule and unbounded oneshot
topologies. It is not live-host evidence.

The interface gap is explicit: the completion provider requires its selected
identity at construction, and the adapter has no public typed accessor for the
render it verified. The factory therefore performs the same read-only render
before constructing the adapter, and the adapter re-renders at preflight and
install. A minimal follow-up seam would expose the adapter's selected identity
and let the provider bind or update that identity, plus cross-check returned
evidence against the adapter's cached render. No such change is made here; no
journal schema, store, lock or new capability mechanism is introduced.

## Proposed stable-manager sequence

1. Under the existing controller lock, validate the unit and target, artifact
   identity, runtime-bound completion provider, installed unit and activator
   inventory. Refuse unknown or unverifiable state before host mutation.
2. Capture the exact prior service file identity and bytes or symlink target,
   metadata and pointer, plus each relevant timer/path and service activation
   state. Persist the complete intent and snapshot with atomic replacement and
   file and directory fsync before changing the host. The adapter must validate
   the snapshot's shape and paths before it acts. The seam calls the adapter's
   validation before fencing or restoration, but has no production snapshot
   schema or path validator yet.
3. Stop the unit's timer and path activators, install the durable service mask,
   reload the stable manager, and explicitly stop or cancel the target's queued
   and running work. Verify the manager has no pending service job and no
   owned work remains before installing a new unit. Refuse ambiguous results;
   masking alone is insufficient. Exact process ownership, mask replacement,
   metadata preservation and race handling need VM proof.
4. Once draining is complete, capture and persist the preservation baseline;
   legitimate work can write state during drain. Install the selected unit and
   pointer while fenced and verify preservation against that baseline. Before
   any activation, persist an `activation_pending` phase; then release the
   intended activators and require two advancing successful completions bound
   to this unit and runtime. Only then persist completion. In the absence of a
   real completion provider, refuse before mutation.
5. Before activation, recovery may re-establish the fence, verify drain and
   restore the snapshot. It persists `restore_activation_pending` before
   releasing prior activation, and records rollback only afterwards. A crash
   in either activation-pending phase is retried by re-establishing and
   observing the fence: a recovery or switch failure after activation restores
   only when stop/drain demonstrates absence, and otherwise retains the intent
   and reports `recovery_required`. The record keeps the failed phase, reason
   and fence evidence so a completed target is not presented as never having
   run. That drain can interrupt live work launched after activation; the
   adapter must identify owned work without stopping unrelated sessions. The
   fake adapter test does not establish real process ownership or systemd
   behavior. Queue data is never restored from the snapshot. Actual controller
   retries and interruption
   at each phase require VM proof; synthetic recovery is not that proof.
   The production entry point does not change this contract: it composes an
   adapter for the record's prior runtime and re-establishes the fence under
   the controller lock before restoring. A fence it cannot demonstrate leaves
   the record bytes unchanged and reports `recovery_required`.

The installed templates provide tick, slot, backfill and watchdog timers;
repair and publisher each have both timer and path activators. The host adapter
must discover and account for direct starts, dependencies and any other
activation sources, queued jobs, service cgroups and owned work outside them.
The exact inventory and the proof that it is complete remain open. The
``activators`` proof mode covers one exact allowlisted timer/path/drop-in
topology and its independent active/enabled release, but it is not exhaustive
production discovery: other-name dependency units, default-target links and
socket units outside the declared paths remain untested. The separate
``partial`` proof mode crash-tests the three ``start`` effect points and the
``restore_activation`` service-file effect point before either activator is
restored across a real user-manager restart and a real guest OS reboot,
requiring pending-record ambiguity, actual source-bound activation states, a
fence-settled completion baseline and unchanged record bytes. It is
fixture-only and does not cover restore timer or
path effect points. Release of each activator and the service must be
controlled and crash-tested; the seam's single `start` call is not evidence
that production release is safe.

Checkout deploy/rollback and unit switch/recovery now share one symmetric
unfinished-transaction guard in the supplied journal directory. It classifies
every ``controller-*.json`` record by its producer-specific operation, outcome
and minimum identity: pending deploy/rollback and pending or recovery-required
unit transactions block both seams; completed deploy/rollback,
``refused_no_change``, and completed/rolled-back unit switches are history and
do not block. A ``recovery_required`` record is never resolved from its stored
digests: those cover file bytes and link targets only, not unit metadata,
activation or live work, so it remains unfinished (or an unsupported legacy
record when its producer identity is incomplete). Classification reads only the
record, so it is stable across later unrelated transactions. ``recover_unit``
excludes exactly the record it is recovering, so a legitimate recovery does not
block itself. Unreadable, malformed, unknown, unsupported-schema and
unsupported-legacy records refuse with the record named;
``OPERATOR-RESOLUTION.md`` prose is never consumed and original record bytes are
never rewritten.

The remaining gaps are unchanged: the guard only sees the caller-supplied
directory (the CLI still accepts an arbitrary ``--record-dir``), older binaries
and a second directory can bypass it, the lock is checkout-local, and a record
does not carry its record root or controller version. Production reconciliation
of the actual deployed record root and old callers remains parent-owned; a host
adapter is not enabled by this change.

## Durable fence boundaries requiring proof

The intent precedes the mask, so a crash before the mask is installed can leave
prior activation live; a journal by itself does not fence systemd. Once a mask
has been written and synced, neither its effective precedence after a user
manager restart nor its behavior after reboot or power loss has been proven by
these experiments. No automatic startup ordering between a retained intent and
systemd activation has been established. A restart or reboot must therefore
be treated as an unverified state requiring inspection; do not infer a fence or
resume automatic recovery from the journal alone.

Before implementing or enabling a host adapter, independently review the
sequence and test on a disposable VM: manager restart and full reboot at each
write/reload/activation boundary; queued and concurrent start races; cgroup and
owned-process drain; exact bytes, modes, owner and symlink restoration; and
crashes during each recovery step followed by repeated recovery. Validate the
actual controller and provider, not just a synthetic procedure. These are
unproven design boundaries, not results of the existing probe.
