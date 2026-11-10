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
| ``ops/unit-switch-adapter.py`` | Guest-only adapter: durable ``/dev/null`` service replacement, target staged behind the mask until ``start`` releases it, exact path/type/bytes/mode/uid/gid snapshot and restoration, bounded job/cgroup drain, fake unit/runtime-bound completion provider. |
| ``ops/unit-switch.py`` | Explicit ``switch``/``recover`` CLI; calls the real controller and requires ``--proof-fixture``. No default or production adapter. |
| ``ops/unit-switch-fixture.py`` / ``.mjs`` | Harmless Python and Node fixtures emitting distinguishable runtime-bound completion records with real systemd invocation IDs. |
| ``ops/vm-unit-switch-guest.py`` | In-guest driver: isolated git checkout, seeded queue/heartbeat, completed historical record, both directions, interruption, repeated recovery and the activation-fence probe. |
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
   durable mask was established. ``install`` stages the target without
   releasing the mask, so the pending record and mask must remain.
5. ``recover-kill``: invoke the actual recovery CLI and SIGKILL it during the
   re-drain. Require the retained record bytes to remain unchanged.
6. ``recover``: invoke recovery again. Require ``rolled_back`` and exact
   restoration of the prior Python service bytes, mode, ownership and timer
   activation/enablement.
7. ``recover-repeat``: invoke recovery against the completed rollback again.
   Require an explicit refusal and unchanged record bytes.
8. ``inspect``: confirm the final Python unit, no mask, preserved queue,
   heartbeat and historical record bytes.
9. ``fence``: start one more Python-to-Node switch and SIGKILL the controller
   at the ``start`` boundary, after ``install`` staged the target and the
   controller durably journaled ``activation_pending`` but before ``start``
   releases the mask. Require the pending ``activation_pending`` record, the
   ``/dev/null`` service mask, a refused direct ``systemctl start`` with an
   explicit mask error, the staged target behind the mask, no new completion,
   and a recovery refusal that leaves the record bytes unchanged. This probe
   intentionally leaves the disposable guest ambiguous.

## Recorded evidence

One run completed on Pluto (KVM, Ubuntu noble guest ``crq-probe``) from source
commit ``52695d4e3727bce1898102f38b52ebfdcc69852f``:

- run ``20261110T173225Z-de36ec18``
- ``report.json`` SHA-256
  ``e451b703055a2e0bdaa3fd345b7181f417e43dcfa1fe282940c672beb74d4805``
- ``raw-guest-evidence.tar.gz`` SHA-256
  ``0ea1b761a17601c4c54ce2ff8aeae95e6b0aeaf2dd00eb95e0a37390532bfe2b``
- host script ``executed-host-script.py`` SHA-256
  ``52cc5255b1f0f3d36a03067bac21260527ab43729599265477f302debf3b608b``
- guest script ``executed-guest-probe.py`` SHA-256
  ``f116fd4beb9f6eedbdb483c9480f600fac125b375af026f66569baa6e7a18504``

The report records all 19 checks true and ``problems: []``; a second
``verify`` recomputed the checks and re-hashed both retained artifacts with
``problems: []``, including comparison of every phase with the retained raw
guest phase JSON, the retained controller journals and the uploaded script
bytes. Provenance verification requires the exact six uploaded controller and
fixture scripts, nonempty matching local and remote digests, verified upload
status, the recorded source commit and the report directory path. A
host-validator-only change may re-run this check against the retained report
when the guest scripts are byte-identical; that is a validator re-run, not a
new guest run. The host checks also refuse a run when the executed
``vm-unit-switch.py`` or its imported ``vm-feasibility.py`` has uncommitted
changes, so evidence cannot be attributed to HEAD when the host implementation
differs from that commit. Rollback restores the prior service into the staged
path while the durable ``/dev/null`` mask remains in place; the controller
journals ``restore_activation_pending`` before ``restore_activation`` releases
the staged service and restores its prior activation state. Artifacts stay at
``~/crq-vm-feasibility/state/runs/20261110T173225Z-de36ec18/`` on Pluto,
outside the worktree. The earlier retained run
``20261110T170322Z-9e8c5133`` remains on Pluto; it predates the fence probe
and is not rewritten.

The run produced:

| Step | Observed |
|---|---|
| ``switch-node`` | completed; sequences ``1,2`` with distinct invocation IDs; ``node:bbbb…``; queue/heartbeat/history unchanged; ``record_count`` 2 |
| ``switch-python`` | completed; sequences ``3,4`` with distinct invocation IDs; ``python``; queue/heartbeat/history unchanged; ``record_count`` 3 |
| ``interrupt`` | CLI rc ``-9``; pending ``drained`` record ``controller-edb16e…``; service left as the durable ``/dev/null`` mask; timer inactive and enabled |
| ``recover-kill`` | CLI rc ``-9``; record SHA-256 ``f7c15ba0…`` identical before and after; queue/heartbeat/history unchanged |
| ``recover`` | CLI rc ``0``; ``rolled_back`` at ``restore_activation_pending``; record SHA-256 ``2c7d9748…``; prior Python bytes/mode/uid/gid and timer enablement restored exactly |
| ``recover-repeat`` | CLI rc ``2``; ``invalid unit recovery record``; no further mutation |
| ``inspect`` | final Python service SHA-256 ``a8a0e280…``; timer SHA-256 ``3edf2fd6…``; four retained records; seeded queue, heartbeat and historical record bytes unchanged |
| ``fence`` | CLI rc ``-9``; pending ``activation_pending`` record ``controller-bcba2b…`` SHA-256 ``80aab780…``; service ``LoadState=masked`` through the ``/dev/null`` symlink; direct start rc ``1`` with ``Unit crq-tick.service is masked.``; staged Node target behind the mask; completions ``4`` before and ``4`` after; recovery rc ``3`` with identical record bytes |

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
