# Disposable-VM feasibility for the CRQ per-unit switch

Status: feasibility evidence only. This does not enable a host adapter, change a
production unit, journal, controller, signer or credential, or establish
controller acceptance. The phase-1.5 proof vehicle remains a later, separately
reviewed slice.

The harness is `ops/vm-feasibility.py`; its guest fixture is
`ops/vm-guest-probe.py`; offline characterization is
`apps/crq-python/test_vm_feasibility.py`. Runtime artifacts and the raw report
stay outside the repository under an owned state directory
(`~/crq-vm-feasibility/` on the probe host).

## Source-derived host topology

Derived from the committed templates and controller only; no production host
was read for this slice. Six services, six timers and two path units:

| Unit | Kind | Activation | Install / dependency | Kill mode |
|---|---|---|---|---|
| `crq-tick.timer` | timer | `OnCalendar=*:0/12`, `Persistent=true` | `Unit=crq-tick.service`; `WantedBy=timers.target` | n/a |
| `crq-tick.service` | oneshot | timer; direct `systemctl --user --no-block start crq-tick.service` from `crq.py:2100` | rendered `python3 crq.py tick` | `process` |
| `crq-slot.timer` | timer | `OnCalendar=*:*:00`, `AccuracySec=1s`, `Persistent=true` | `Unit=crq-slot.service`; `WantedBy=timers.target` | n/a |
| `crq-slot.service` | oneshot | timer | rendered `python3 crq_slot.py` | `process` |
| `crq-repair.timer` | timer | `OnBootSec=10min`, `OnUnitActiveSec=10min` | `Unit=crq-repair.service`; `WantedBy=timers.target` | n/a |
| `crq-repair.path` | path | `PathChanged=<root>/state/repair/inbox` | `Unit=crq-repair.service`; `WantedBy=default.target` | n/a |
| `crq-repair.service` | simple | timer and path | rendered `python3 crq_repair.py`; `Restart=on-failure`, `RestartSec=60` | default (`control-group`) |
| `crq-publisher.timer` | timer | `OnBootSec=1min`, `OnUnitInactiveSec=1min`, `AccuracySec=5s` | `Unit=crq-publisher.service`; `WantedBy=timers.target` | n/a |
| `crq-publisher.path` | path | `PathChanged=<root>/state/backfill/publication/pending` | `Wants=crq-publisher.service`; `Unit=crq-publisher.service`; `WantedBy=default.target` | n/a |
| `crq-publisher.service` | oneshot | timer and path | rendered `python3 backfill_publisher.py` | `control-group` |
| `crq-backfill.timer` | timer | `OnCalendar=*-*-* 00,06,12,18:00:00 UTC`, `Persistent=true` | `Unit=crq-backfill.service`; `WantedBy=timers.target` | n/a |
| `crq-backfill.service` | oneshot | timer | `ConditionPathExists=<root>/state/backfill-rollout.json`; rendered `python3 backfill.py inventory` | `control-group` |
| `crq-watchdog.timer` | timer | `OnBootSec=3min`, `OnUnitActiveSec=12min` | implicit `Unit=crq-watchdog.service`; `WantedBy=timers.target` | n/a |
| `crq-watchdog.service` | oneshot | timer | rendered `python3 ops/crq-watchdog.py` | default |

Relevant topology facts for a switch:

- `Persistent=true` on tick, slot and backfill means a stopped or rebooted
  manager has catch-up activations, not just future elapses.
- `publisher.path` starts `publisher.service` itself (`Wants=`), so path
  activation is also a direct dependency activation.
- Timers activate their `Unit=` on elapse; the two path units activate their
  `Unit=` on a watched-file change and are enabled into `default.target`.
- The harvest path calls `systemctl --user --no-block start crq-tick.service`
  (`crq.py:2100`), so tick has a direct activator outside its timer.
- Tick and slot use `KillMode=process`; repair/publisher/backfill use
  `control-group`. Detached queue-owned work can outlive a `process` stop.
- `prepare-host.py` renders into `--units-output` (the runbook uses
  `$HOME/.config/systemd/user`), enables nothing, and only runs
  `daemon-reload`; enablement links live in `timers.target.wants/` and
  `default.target.wants/`.
- State is `<deploy-root>/apps/crq-python/state` (`queue.json`, `runs/`,
  `receipts/`, `tick.lock`, `controller.lock`). The completion heartbeat is
  `$XDG_STATE_HOME/crq/heartbeat.json` or `~/.local/state/crq/heartbeat.json`
  (`crq.py:3527-3541`).
- The controller journal is `controller-<32 hex>.json`, schema 1, mode 0600,
  atomically replaced and fsynced in the operator-supplied private mode-0700
  `--record-dir` (`deploy-controller.py:241-269`). The transaction phases are
  `snapshot`, `drained`, `activation_pending`, `restore_activation_pending`
  (`deploy-controller.py:1363-1405`).

## Journal interoperability: the code gap

This is ours to design and implement; only the physical reconciliation of
production history belongs to the parent. The source shows a concrete defect,
not merely an unknown record location.

1. **Two record roots are not bound to each other.** `prepare-host.record()`
   writes render-intent `<uuid>.json` records into the overlay `record_dir`
   (`prepare-host.py:305-319`). The deploy controller writes
   `controller-<uuid>.json` into its own `--record-dir`
   (`deploy-controller.py:241-269`). Nothing in source requires those paths to
   resolve to the same directory, and the runbook's example values differ
   (`HOST-DEPLOY.md:65-66`, `HOST-DEPLOY.md:204-206`). An operator can
   therefore maintain two stores without any tool noticing.
2. **The unfinished guard is one-sided.** `refuse_unfinished_unit_switches`
   (`deploy-controller.py:1324-1333`) blocks only an unfinished
   `operation == "unit_switch"`. Checkout mutations are written as
   `deploy_pending`/`rollback_pending` (`mutation_record`,
   `deploy-controller.py:1120-1135`), failures as `recovery_required`
   (`deploy-controller.py:1149`), and successful checkout records as
   `operation: "deploy"` (`deploy-controller.py:1431-1449`) or
   `"rollback"` (`deploy-controller.py:1563`). Therefore:
   - a pending deploy, rollback or checkout `recovery_required` record does
     **not** block a unit switch;
   - a pending unit switch **does** block deploy and rollback, because both
     call the same guard (`deploy-controller.py:1218`, `:1528`);
   - a unit-switch `recovery_required` blocks, because its outcome is neither
     `completed` nor `rolled_back`.
   The asymmetry is the interop defect: a host mutation can be pending while
   the unit seam believes it is clear.
3. **There is no machine-verifiable resolution.** `recover_unit`
   (`deploy-controller.py:1271-1320`) accepts only `operation ==
   "unit_switch"`. `HOST-DEPLOY.md:319-330` says earlier intent, recovery and
   refusal records are not consumed by later preflight, and resolution is a
   separate prose `OPERATOR-RESOLUTION.md`. Prose is not checked against the
   retained record or the physical state.
4. **Record identity is weak.** Records do not retain the record root, the
   controller version or a host identity. The controller lock is
   `state/controller.lock` inside the checkout (`deploy-controller.py:85`,
   `:215-226`), so an older controller or a different `--record-dir` bypasses
   the guard without touching the same lock.

Implementation plan, in the existing controller rather than a second store:

- Derive the transaction root from the private overlay's `record_dir`; refuse
  when `--record-dir` resolves to a different real path. Do not create a new
  journal.
- Replace the one-sided guard with `refuse_unfinished_transactions(effects)`
  that classifies every `controller-*.json` by `(operation, outcome)` and fails
  closed on malformed or unknown records:
  - block a unit switch on `deploy_pending`, `rollback_pending`, checkout or
    unit `recovery_required`, and unfinished `unit_switch`;
  - block deploy and rollback on the same set;
  - keep completed `deploy`/`rollback` and refused/no-change outcomes as
    history, not blockers.
- Add a separate `controller-<id>.resolution.json` for a resolved pending
  record. It names the transaction id, records the observed HEAD, config,
  unit and preserved-state digests, the decision, and the SHA-256 of the
  original record. The guard accepts it only when the digest and every
  observation match the retained record and the current physical state.
  `OPERATOR-RESOLUTION.md` prose is never consumed. The original record is
  never rewritten.
- Record the resolved `record_dir` real path, controller version and helper
  SHA-256 in every transaction; refuse new transactions when existing records
  were written under a different recorded root or schema.
- Add `test_deploy_controller_interop.py`: pending deploy blocks a unit
  switch; pending rollback blocks; checkout `recovery_required` blocks;
  completed deploy history does not block; a resolution with a wrong record
  digest or mismatched physical state does not clear; malformed or unknown
  operations refuse; a different record root is rejected by the binding.

The one input that cannot be derived from source is the actual deployed record
root, the controller versions in use, and the inventory of existing pending or
recovery records. Those are parent-held and must be supplied before
enablement; they are not a reason to leave the code gap in place. Historical
records are preserved byte-for-byte.

## Disposable-VM method

`ops/vm-feasibility.py` does, in order:

1. Fetch `SHA256SUMS` and the Ubuntu 24.04 `noble-server-cloudimg-amd64.img`;
   verify the image against the published checksum. This is download integrity,
   not signed authenticity.
2. Create a fresh `qcow2` overlay over the read-only base image, a NoCloud seed
   with a dedicated `probe` account and an SSH key generated for that run, and
   enable linger. No host account, host unit, host SSH configuration or host
   reboot is changed.
3. Boot QEMU under
   `systemd-run --user --scope -p MemoryMax=3G -p MemorySwapMax=0`, with 2
   vCPU and 2048 MiB of guest RAM. Refuse below 2 GiB host `MemAvailable`.
4. Install harmless fixture units only: a service installed through a symlink
   to a mode-0640 backing file, a timer, a path unit, a dependency-activated
   unit, and a bounded queued-start pair behind a 20-second sleep. No CRQ unit
   name, checkout, journal, credential or provider is present.
5. Exercise direct and dependency starts, then fence the service and record
   direct/dependency refusal, the mask symlink, timer/path state, and the
   queued-job outcome. The queued experiment is recorded behavior, not a
   generalized guarantee that masking cancels a pending job.

### Mask mechanism finding

The first real guest run showed that `systemctl --user mask <unit>` is not a
usable fence for a unit installed in the same user config directory. It
returned 1 with `Failed to mask unit: File
/home/probe/.config/systemd/user/crq-fixture.service already exists.` The
alias-installed case failed with `already exists and is a symlink`. The
runbook installs units into `$HOME/.config/systemd/user`
(`HOST-DEPLOY.md:169-175`), so native mask cannot replace a locally installed
unit: the mask symlink would have to occupy the same path as the unit file.

The fixture therefore implements the fence the adapter actually needs: retain
the original bytes (or symlink target), unlink the installed path, write the
`/dev/null` symlink, and reload. The probe records the native refusal and then
proves that the durable replacement yields `LoadState=masked`, refuses direct,
dependency and path activation, and survives the manager restart and reboot.
The adapter must not report a fence from a successful-looking
`systemctl mask` invocation; it must verify the installed path, the load state
and the activation refusal.

The recorded run adds three activator facts that the adapter must handle:

- Starting the timer or path **while its service is fenced** fails with
  `Job failed` (rc 1). The mask propagates through the activator, so an
  adapter that leaves enabled activators in place after fencing gets failed
  start jobs, not a quiet no-op.
- An already-active path that is triggered after the fence does not start the
  service (`run_delta` empty), but the path unit itself can end up `failed`
  after the trigger; the adapter must stop and reset the activator, not assume
  it remains healthy.
- After the guest reboot the timer and path are still installed and enabled
  but report `inactive` (`SubState=dead`) because their target service is
  masked. The fence therefore survives the reboot, but the adapter's restore
  path must re-enable and start the activators after unmasking rather than
  relying on their pre-fence active state.
6. Restart the real guest user manager with
   `systemctl restart user@<uid>.service` inside the guest, not a
   `daemon-reload`, and require a different manager PID and invocation ID
   before re-inspecting the units.
7. Reboot the guest OS, detect the disconnect and reconnect from the host-side
   harness, and require a changed kernel `boot_id` before re-inspecting.
8. Unmask and prove the fixture runs again. `destroy` stops only the retained
   QEMU process after matching its `/proc` start time and command line against
   the run's recorded identity, and treats the process as stopped once it no
   longer matches; `--purge` moves this run's overlay, seed and key into
   `state/trash/`, never deleting the shared image or evidence.

All commands and results are recorded in `commands.jsonl`; phase payloads are
saved under `phases/`; the final report is `report.json` and carries host load
and memory stamps for any timing claim. The report schema is 2. It records the
source commit and the SHA-256 of the executed host and guest scripts, keeps
byte copies as `executed-host-script.py` and `executed-guest-probe.py`, and
records the digest observed on the guest after upload. `verify` recomputes
every check from the raw `phases`, `manager_restart` and `reboot` observations,
rejects a saved report whose stored checks disagree, and re-hashes the retained
script bytes. A run without this binding is not accepted as evidence for this
revision.

## Recorded evidence

Run `20261110T144209Z-75683132` on `pluto` (Linux 6.12.63, systemd 255
`255.4-1ubuntu8.18`, Ubuntu 24.04 noble guest) produced
`state/runs/20261110T144209Z-75683132/report.json`; `verify` returned
`{"problems": []}` by recomputing the checks from the raw phase files and
re-hashing the retained scripts. The report is bound to source commit
`8dd2c59beb856d7166ed6b155df74054dac253c2`; the executed host script SHA-256 is
`11df141bf4f8b4ec0665e06c6591aed8389028980d58affc08ba98ae458399ea`, the
executed guest script SHA-256 is
`458f67d45a5199e46047e7449c615875269486143107aac761c5ef2d359b626e`, and the
guest reported the same guest digest after upload. The report SHA-256 is
`972e22699733fc01434a1b734a14883f4a7de409137f0fbe2710548cdbfad1c7`. The host
was busy: load1 12.32 at start and 15.68 at finish, with 7,265,088 KiB and
6,590,996 KiB `MemAvailable` respectively. The harness window was 14:42:06Z to
14:43:52Z (about 103 s); that is an observation under that load, not a
performance claim. The guest had 2 vCPU and 2048 MiB, and the QEMU process
stayed at PID 381631 across the reboot with its start identity verified.

The earlier run `20261110T142207Z-8c1668ea` is retained for history, but it
predates schema 2 and has no executed-script/commit binding; it is not evidence
for the current revision.

| Check | Result |
|---|---|
| image checksum verified | yes: `sha256 04e8f2461a16a44e78a370284471f29616cdd9baf1893df25807b71f985b6c94` against the published `SHA256SUMS`; integrity only, not signed authenticity |
| direct start ran | yes, activation delta `["service"]` |
| dependency start ran | yes, activation delta `["service", "dependent"]` |
| native `systemctl mask` refused for the local unit | yes, rc 1: `File /home/probe/.config/systemd/user/crq-fixture.service already exists.` |
| native `systemctl mask` refused for the symlink-installed alias | yes, rc 1: `already exists and is a symlink to ...` |
| durable `/dev/null` replacement reached `LoadState=masked` | yes, and `FragmentPath` still names the installed path |
| alias-installed durable replacement refused a direct start | yes, rc 1 |
| direct start refused while fenced | yes, rc 1: `Unit crq-fixture.service is masked.` |
| dependency start refused while fenced | yes, rc 1: `Unit crq-fixture.service is masked.` |
| mask link target `/dev/null` | yes |
| timer active/enabled while service fenced | active and enabled before the fence; starting it while fenced failed rc 1 |
| path active/enabled while service fenced | active and enabled before the fence; starting it while fenced failed rc 1; a trigger after fencing produced no service run and left the path `failed` after stop |
| queued setup proved in both rounds | yes: both blocker and wrapper starts returned 0, and each round recorded `crq-queued-fixture.service` in `start waiting` |
| queued job behavior recorded | the wrapper ran (`["queued"]`); `queued-fixture` did not run |
| queued job behavior after explicit stop recorded | explicit stop rc 0; the wrapper ran (`["queued"]`); `queued-fixture` did not run |
| user-manager PID and invocation changed | yes: PID 1003 to 1539, invocation `ff4d0ba5...` to `b05be57d...` |
| mask persisted over manager restart | yes, `LoadState=masked` after the new manager was ready, and direct/dependency starts were refused |
| guest `boot_id` changed after reboot | yes: `1e4d25d0-65b1-4337-81e2-eae1320c4794` to `8bfb02a5-8ca1-414c-b56b-73be37d9e683` |
| QEMU PID/start identity unchanged across the guest reboot | yes: PID 381631, identity verified |
| timer and path state recorded after reboot | both `inactive`/`enabled`, `SubState=dead`; target service still masked |
| no new fixture service run after reboot | yes; run log delta empty |
| unit/backing/enablement metadata restored | yes; install and post-unmask file snapshots compared with no changes (the synthetic trigger file is excluded) |
| unit/backing/enablement metadata unchanged across reboot | yes; no changes in the reboot before/after snapshots (trigger excluded) |
| unmask starts the fixture again | yes, unmask delta `["service"]` |
| executed bytes bound and verified | yes; source commit plus host/guest SHA-256, retained copies and remote guest digest all match |

All required checks in the report are true. The two queued checks are recorded
as `false` because the `queued-fixture` unit did not execute; that is the
observed behavior, not a pass/fail assertion about queued work in general. In
this run the wrapper `crq-queued.service` ran in both rounds, including after
the explicit stop of the queued unit, so the adapter cannot assume that
stopping the queued unit also stops its wrapper. The after-reboot activator
checks are recorded strings (`inactive`),
not required to be `active`, because a mask that still blocks the target
service is the property under test.

## What this does not prove

- It is not controller, journal, adapter or production acceptance.
- The native-mask refusal is evidence for units installed in the same user
  config directory. A deployment that installs units somewhere else (for
  example a vendor directory) can use a different mask precedence; the adapter
  must determine and verify its own layout rather than assume this result.
- A guest reboot is not power loss, and the evidence does not cover
  filesystem corruption or a host power cut.
- It proves the observed queued-job behavior for this systemd version and
  fixture shape only; the adapter must still stop and verify pending work.
- It does not establish the real host's complete activator inventory,
  drop-ins, detached queue-owned process ownership, or the historical record
  reconciliation described above.
- The guest uses same-user fixture ownership and a disposable passwordless
  sudo account; it does not test privileged ownership, ACLs or xattrs.

## Reproduction

```sh
# On a Linux host with writable /dev/kvm, qemu and cloud-localds.
python3 apps/crq-python/ops/vm-feasibility.py --state-dir ~/crq-vm-feasibility/state plan
python3 apps/crq-python/ops/vm-feasibility.py --state-dir ~/crq-vm-feasibility/state \
  --tools ~/crq-vm-feasibility/tools run
python3 apps/crq-python/ops/vm-feasibility.py --state-dir ~/crq-vm-feasibility/state \
  verify ~/crq-vm-feasibility/state/runs/<run>/report.json
python3 apps/crq-python/ops/vm-feasibility.py --state-dir ~/crq-vm-feasibility/state \
  destroy --run-id <run>
```

Run the named tests locally:

```sh
pnpm test:narrow apps/crq-python/test_vm_feasibility.py
```
