# Live unit-switch binding

Status: CLI composition. `deploy-controller.py` loads
`ops/unit-live-binding.py` lazily for `switch --unit ... --runtime ...` and
`recover --record ...`; it is not a CLI and does not enable a production
switch or recovery. Every host observation is read-only. The module exists so
the mechanical port, root binding, record binding and lock observation can be
tested without a live host.

## Composition

`production_adapter(effects, overlay, unit=..., runtime=...)` calls the
existing factory with:

* `prepare-host.render_service` through `unit-switch-factory.select`;
* `ProductionUnitAdapter` with `DeclaredCapabilities` fed from the verified
  artifact's declared live commands;
* `SystemdJournalCompletionPort` over the real `SystemdJournalSource`;
* `SubprocessSystemd` and `ProcessIdentity`;
* the caller's existing `runner_queue_drain(effects)`.

It returns the adapter and its selected identity. It never calls
`switch_unit`, `recover_unit`, the controller CLI or a unit command.

Recovery composes the same adapter through
`production_adapter(effects, overlay, unit=record.unit,
runtime=record.prior_runtime)`. The controller supplies the unit and prior
runtime from the one retained record it has already validated, under its lock,
and calls the composition callback after the read-only queue-drain gate and
before snapshot validation. The record's snapshot is authoritative for the
bytes, modes, ownership and activation that are restored, so a checkout `HEAD`
advance between the failed switch and the recovery changes the composed
selection but not what recovery restores, and the composed render is not
consumed by the recovery path. Composing for the abandoned target instead
would make recovery depend on an artifact that may no longer be installed.

The adapter's `error_type` and default queue drain come from the loaded
controller module that owns the supplied `Effects` object, not from a second
import of `deploy-controller.py`. This keeps a refusal's class identity at the
controller seam when the controller was imported under another module name.

## Port mapping

`SubprocessSystemd.run(*args)` emits the adapter's actual verbs with the global
user and pager options:

```
systemctl --user --no-pager stop|reset-failed|daemon-reload|start <unit>
```

It returns `{rc, stdout, stderr, timeout}`. The default runner reuses
`unit-completion._read_bounded` and `_stop_process`: both streams are drained
concurrently, each is capped at 256 KiB, the whole read is bounded by the
timeout, only the owned child is terminated, and non-UTF-8 output refuses.

`show(unit, props)` emits `systemctl --user --no-pager show <unit>
--property <p>...` and parses with the existing `parse_show_output`. `jobs()`
emits `list-jobs --no-legend`. `cgroup_pids(unit)` reads `MainPID` and
`ControlGroup` and then `/sys/fs/cgroup<ControlGroup>/cgroup.procs`.

Cgroup containment is strict: the control group must be absolute, have no
empty, `.` or `..` component, resolve to a path strictly below the cgroup root,
and not pass through a symlink. A missing `cgroup.procs` is empty only when
`MainPID` is zero; otherwise it refuses. PID lines must be positive integers and
are deduplicated under a bound.

## Discovery scope

`complete` is true only when every required observation succeeded: declared
path types, unit-directory scan, dependency scan, `list-unit-files`,
`list-units --all` and `list-jobs`. A failed command, unreadable directory,
oversized scan or malformed job line makes `complete` false and names a reason.

`supported` is true only when the observed topology is within the declared
shapes:

* the declared paths are the service, timer, optional path unit and their
  `*.wants`/`*.requires` links under the user unit directory;
* there is exactly one service, exactly one timer and at most one path unit,
  and the service is the requested unit;
* no unexpected prefix entry, enablement link, drop-in directory, extra
  installed or loaded manager unit, or job on an unexpected prefix unit;
* no dependency directive in a source file outside the declared set names an
  expected unit, and no directive in a declared source names a CRQ unit
  outside the expected units: `Wants`, `Requires`, `Requisite`, `BindsTo`,
  `PartOf`, `Conflicts`, `WantedBy`, `RequiredBy`, `Also`, `Upholds`,
  `OnFailure`, `OnSuccess`, `Triggers`, `TriggersBy` and `Unit` (the
  timer/path target). A declared timer may name its own declared service; a
  foreign timer naming that service is still foreign. An undeclared unit of
  another CRQ group naming only its own units is not foreign.

The recursive dependency scan is bounded by visited entry count and does not
follow symlinked directories. A symlink file is read when its resolved target
is a regular file, whether it stays inside the unit directory or points into a
cotenant repository or config tree; cotenant units are routinely installed
that way. The target text is scanned like any other source, so a cotenant unit
naming an expected unit is still foreign, and systemd continuations are joined
with `config_parse` semantics (only an odd trailing backslash continues, a
comment line is ignored, a blank line flushes the accumulated line) so a
wrapped directive cannot hide a dependency. A `/dev/null` mask is skipped, and
a symlinked directory or special file is not followed. A
dangling, looping, unreadable or oversized target, or an unreadable directory
including a descendant, makes `complete` false rather than silently skipping
evidence. A read opens non-blocking and re-checks the descriptor as a regular
file, so a target replaced by a FIFO or other special file between the type
observation and the read refuses instead of blocking. No ownership or mode
gate is added for a cotenant target: its text is read-only evidence, not the
file the switch mutates.

The examined scope is the user unit directory and the user manager's installed
and loaded lists. The following are outside this scope and are not claimed by
`supported`: a non-CRQ unit whose in-memory dependency names a CRQ unit but is
not on disk, transient or generated state outside the manager lists, another
namespace or user, an activator created between the scan and the fence, and a
dependency introduced through a symlinked drop-in directory because symlinked
directories are not followed.
This is the residual that still needs parent-owned actual-topology evidence
before production enablement.

There is no caller policy flag, acceptance gate, registry, role or approval
packet. `supported` is derived from the topology, not asserted by the caller.

## Root, record and lock

`HostLayout.from_overlay` reuses `prepare-host.validate` and
`prepare-host.root_check`. The root must be the overlay `deploy_root`, a full
monorepo top level with a detached HEAD. The record directory must be the
overlay `record_dir`, already existing, not a symlink, mode 0700 and outside
the root. The unit directory is `$XDG_CONFIG_HOME/systemd/user` or
`~/.config/systemd/user`, absolute, not a symlink and a directory.

The lock observation is read-only. It stats
`<root>/apps/crq-python/state/controller.lock` without following a symlink,
reports `dev:ino`, mode, owner and state-directory identity, and refuses a
symlink, non-regular file, group/world-writable mode, foreign owner, or a state
directory that resolves outside the root. The controller writes that lock mode
0600 independently of the ambient umask. It never creates the lock, never
acquires it and adds no new lock or store. Two `Effects` objects on one root
observe the same inode; a second root does not. Cross-namespace identity and
actual contention remain parent-owned.

## Verification

`test_unit_live_binding.py` uses real temporary unit directories, real cgroup
`cgroup.procs` files, real Git roots, real record directories and real lock
files. Only the systemctl process runner is injected. The final test composes
the real adapter and drives the real `deploy_controller.switch_unit` seam; an
unsupported discovery topology refuses before any journal or unit mutation.

The binding is reached through the controller CLI's switch and recover paths.
The recovery wiring tests drive `recover --record` with the real production
adapter and injected systemd and journal ports over a real temporary unit
directory and record directory; an `activation_pending` record still stops and
drains owned work, then refuses with rc 3 and unchanged record bytes. `watchdog`
is the only Node command the verified artifact currently declares; `tick`,
`slot`, `publisher`, `backfill` and `repair` still refuse for a Node target. The
binding does not call `switch_unit` or `recover_unit` itself; the controller
owns that seam.
