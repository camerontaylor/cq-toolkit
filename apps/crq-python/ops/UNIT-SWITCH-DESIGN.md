# Per-unit switch and recovery: design for review

Status: proposed, not a production adapter or cutover authorization. The
current controller exposes an injected adapter seam and retains its snapshot in
a private fsynced journal, but its CLI provides no unit-switch or unit-recovery
adapter. The recovery snapshot's structure and host operations still need an
independent design review and disposable-VM proof.

A bounded proof vehicle now exercises the actual ``switch_unit``/``recover_unit``
seam against one harmless fixture in a disposable KVM guest; run
``20261110T173225Z-de36ec18`` passed both directions, preactivation
interruption, interrupted recovery, repeat-recovery refusal and the
activation-fence probe. It is
fixture-only evidence, not production enablement: production journal
interoperability, a real runtime-bound completion provider, and the
manager-restart/reboot matrix remain open. See
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
   in either activation-pending phase is ambiguous: stop/drain, retain the
   intent and investigate rather than blindly replay or restore. That drain
   can interrupt live work launched after activation; the adapter must identify
   owned work without stopping unrelated sessions. The fake adapter test does
   not establish real process ownership or systemd behavior. Queue data is
   never restored from the snapshot. Actual controller retries and interruption
   at each phase require VM proof; synthetic recovery is not that proof.

The installed templates provide tick, slot, backfill and watchdog timers;
repair and publisher each have both timer and path activators. The host adapter
must discover and account for direct starts, dependencies and any other
activation sources, queued jobs, service cgroups and owned work outside them.
The exact inventory and the proof that it is complete remain open. Release of
each activator and the service must be controlled and crash-tested; the seam's
single `start` call is not evidence that production release is safe.

Checkout deploy/rollback and unit switch/recovery now share one symmetric
unfinished-transaction guard in the supplied journal directory. It classifies
every ``controller-*.json`` record by ``(operation, outcome)``: pending
deploy/rollback and pending or recovery-required unit transactions block both
seams; completed deploy/rollback, ``refused_no_change``, completed/rolled-back
unit switches, and a ``recovery_required`` record whose retained prior identity
still matches the physical state are history and do not block. ``recover_unit``
excludes exactly the record it is recovering, so a legitimate recovery does not
block itself. Unreadable, malformed, unknown, unsupported-schema and legacy
recovery records without a verifiable prior identity refuse with the record
named; ``OPERATOR-RESOLUTION.md`` prose is never consumed and original record
bytes are never rewritten.

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
