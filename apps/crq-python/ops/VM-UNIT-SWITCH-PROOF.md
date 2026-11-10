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

Pending the committed guest run. The host harness writes ``report.json`` and
``raw-guest-evidence.tar.gz`` under
``~/crq-vm-feasibility/state/runs/<run>/`` outside the worktree, with the
source commit and SHA-256 of every executed script. ``verify`` recomputes the
checks and re-hashes the retained artifacts; a stored check or artifact hash
that disagrees is a failure.

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
python3 apps/crq-python/ops/vm-unit-switch.py \
  --state-dir ~/crq-vm-feasibility \
  --tools ~/crq-vm-feasibility/tools \
  run --source-commit "$commit"
python3 apps/crq-python/ops/vm-unit-switch.py \
  verify ~/crq-vm-feasibility/state/runs/<run>/report.json
```

Run the named tests locally:

```sh
pnpm test:narrow apps/crq-python/test_unit_switch_adapter.py \
  apps/crq-python/test_unit_switch_cli.py \
  apps/crq-python/test_vm_unit_switch.py
```
