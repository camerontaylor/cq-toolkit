# Isolated unit-switch proof vehicle

Status: bounded fixture proof vehicle only. This is not a production adapter,
cutover authorization, C2 readiness, parity evidence or CQ enablement. The
production adapter remains unavailable and no real runtime completion exists.

## Scope

The vehicle exercises the *actual* controller seam
(``deploy-controller.switch_unit`` and ``recover_unit``) against one
representative harmless fixture installed under the allowlisted unit name
``crq-tick.service`` in a disposable guest. It does not modify the controller's
unit allowlist, add a journal, lock, pointer store, ledger, approval mechanism
or resolution file, and it does not touch a production host, checkout,
credential or provider.

Files:

| File | Role |
|---|---|
| ``ops/unit-switch-adapter.py`` | Guest-only adapter: durable ``/dev/null`` service replacement, exact path/type/bytes/mode/uid/gid snapshot and restoration, bounded job/cgroup drain, fake unit/runtime-bound completion provider. |
| ``ops/unit-switch.py`` | Explicit ``switch``/``recover`` CLI; calls the real controller and requires ``--proof-fixture``. No default or production adapter. |
| ``ops/unit-switch-fixture.py`` / ``.mjs`` | Harmless Python and Node fixtures emitting distinguishable runtime-bound completion records with real systemd invocation IDs. |
| ``ops/vm-unit-switch-guest.py`` | In-guest driver: isolated git checkout, seeded queue/heartbeat, completed historical record, both directions, interruption and repeated recovery. |
| ``ops/vm-unit-switch.py`` | Host harness reusing ``vm-feasibility.py`` lifecycle, uploading exact script bytes, retaining raw guest evidence and a report outside the worktree. |

## Sequence

1. ``prepare``: verify the ``crq-probe`` guest layout; create a throwaway git
   checkout; seed ``queue.json`` and ``heartbeat.json``; install the harmless
   Python fixture as ``crq-tick.service`` and its timer; seed a completed
   historical ``controller-*.json`` record and retain its bytes.
2. ``switch-node``: actual ``switch_unit`` from Python to a fake
   ``node:<sha>`` runtime. Require two advancing, distinct invocation-bound
   completions.
3. ``switch-python``: actual ``switch_unit`` back to the Python runtime with the
   same completion requirement.
4. ``interrupt``: start a Python-to-Node switch and SIGKILL the controller at
   the ``install`` boundary, after the journal reached ``drained`` and the
   durable mask was established. Require the pending record and mask to remain.
5. ``recover-kill``: invoke the actual recovery CLI and SIGKILL it during the
   re-drain. Require the retained record bytes to remain unchanged.
6. ``recover``: invoke recovery again. Require ``rolled_back`` and exact
   restoration of the prior Python service bytes, mode, ownership and timer
   activation/enablement.
7. ``recover-repeat``: invoke recovery against the completed rollback again.
   Require an explicit refusal and unchanged record bytes.
8. ``inspect``: confirm the final Python unit, no mask, preserved queue,
   heartbeat and historical record bytes.

## Recorded evidence

One run completed on Pluto (KVM, Ubuntu noble guest ``crq-probe``) from source
commit ``4062483f374eb41e4ffd48ed89fdea469e1a75c8``:

- run ``20261110T165618Z-170efa69``
- ``report.json`` SHA-256
  ``3b92d972b940f555bcd392bd2acd8ad5efc15cc8ea92fb32e775b6c821f7ea91``
- ``raw-guest-evidence.tar.gz`` SHA-256
  ``70618f51cafe2c02c85789603ca801098361a4af29f6bd577a682d64505a2387``
- host script ``executed-host-script.py`` SHA-256
  ``bfbe2cf106eb4fd7e9c9fc6170a89d146e21372a5d165709c2ee35282bdbff1a``
- guest script ``executed-guest-probe.py`` SHA-256
  ``42ac97bb9247bb4e7164136fec9de004a50e5c04942b46d0fad2c9c65e8bf51b``

The report records all 18 checks true and ``problems: []``; a second
``verify`` recomputed the checks and re-hashed both retained artifacts with
``problems: []``. Artifacts stay at
``~/crq-vm-feasibility/state/runs/20261110T165618Z-170efa69/`` on
Pluto, outside the worktree.

The run produced:

| Step | Observed |
|---|---|
| ``switch-node`` | completed; sequences ``1,2`` with distinct invocation IDs; ``node:bbbb…``; queue/heartbeat/history unchanged; ``record_count`` 2 |
| ``switch-python`` | completed; sequences ``3,4`` with distinct invocation IDs; ``python``; queue/heartbeat/history unchanged; ``record_count`` 3 |
| ``interrupt`` | CLI rc ``-9``; pending ``drained`` record ``controller-974b…``; service left as the durable ``/dev/null`` mask; timer inactive and enabled |
| ``recover-kill`` | CLI rc ``-9``; record SHA-256 ``72e19f98…`` identical before and after; queue/heartbeat/history unchanged |
| ``recover`` | CLI rc ``0``; ``rolled_back`` at ``restore_activation_pending``; prior Python bytes/mode/uid/gid and timer enablement restored exactly |
| ``recover-repeat`` | CLI rc ``2``; ``invalid unit recovery record``; no further mutation |
| ``inspect`` | final Python service SHA-256 ``a8a0e280…``; timer SHA-256 ``3edf2fd6…``; four retained records; seeded queue, heartbeat and historical record bytes unchanged |

The fixture timer uses ``OnUnitInactiveSec=1s`` and ``AccuracySec=1s``. The
default one-minute timer accuracy outlasted the completion bound in an earlier
attempt; the fixture now bounds it explicitly. This is fixture configuration,
not a production template change.

## Not proven

- No production adapter, allowlist change, production journal interop or
  legacy-resolution mechanism.
- No real Python or Node CRQ runtime completion; the fixture provider is fake.
- No user-manager restart, guest reboot, power loss, ACL, xattr or privileged
  ownership proof.
- No rendered production unit template, installed drop-in, detached
  queue-owned process or complete production activator inventory.
- No C2 shadow, parity, cutover or enablement claim.

## Reproduction

```sh
commit=$(git rev-parse HEAD)
state=$HOME/crq-vm-feasibility/state
python3 apps/crq-python/ops/vm-unit-switch.py \
  --state-dir "$state" \
  --tools ~/crq-vm-feasibility/tools \
  run --source-commit "$commit"
python3 apps/crq-python/ops/vm-unit-switch.py \
  --state-dir "$state" \
  --tools ~/crq-vm-feasibility/tools \
  verify "$state/runs/<run>/report.json"
```

Run the named tests locally:

```sh
pnpm test:narrow apps/crq-python/test_unit_switch_adapter.py \
  apps/crq-python/test_unit_switch_cli.py \
  apps/crq-python/test_vm_unit_switch.py
```
