# Per-unit switch and recovery: design for review

Status: proposed, not a production adapter or cutover authorization. The
current controller exposes an injected adapter seam and retains its snapshot in
a private fsynced journal, but its CLI provides no unit-switch or unit-recovery
adapter. The recovery snapshot's structure and host operations still need an
independent design review and disposable-VM proof.

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

Both synthetic user-manager restarts timed out during startup. The diagnostic
job is green because it recorded the failures as data; it is not a restart pass.
Socket startup helpers blocked while setting the manager environment; the cause
was not established and the initial environment comparison was not fully
hermetic. [Restart diagnosis](https://github.com/camerontaylor/cq-toolkit/actions/runs/42720216729/job/129511976423).
No VM reboot or power-loss test has been performed. A further bounded probe of
metadata and recovery interruption on an already-running manager is underway.

## Proposed stable-manager sequence

1. Under the existing controller lock, validate the unit and target, artifact
   identity, runtime-bound completion provider, installed unit and activator
   inventory. Refuse unknown or unverifiable state before host mutation.
2. Capture the exact prior service file identity and bytes or symlink target,
   metadata and pointer, plus each relevant timer/path and service activation
   state. Persist the complete intent and snapshot with atomic replacement and
   file and directory fsync before changing the host. The adapter must validate
   the snapshot's shape and paths before it acts; the present generic seam does
   not validate adapter-specific snapshot contents.
3. Stop the unit's timer and path activators, install the durable service mask,
   reload the stable manager, and explicitly stop or cancel the target's queued
   and running work. Verify the manager has no pending service job and no
   owned work remains before installing a new unit. Refuse ambiguous results;
   masking alone is insufficient. Exact process ownership, mask replacement,
   metadata preservation and race handling need VM proof.
4. Install the selected unit and pointer while fenced, reload, restore the
   intended activators and require two advancing successful completions bound
   to this unit and runtime. Persist completion only after these checks. In the
   absence of a real completion provider, refuse before mutation.
5. On failure or an incomplete intent, keep or re-establish the fence, verify
   drain, restore the retained file, pointer and activation state, verify
   preserved data, and only then mark the journal rolled back. Recovery must be
   idempotent and retain a recoverable intent when any operation is ambiguous
   or interrupted. Queue data is never restored from the snapshot.

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
