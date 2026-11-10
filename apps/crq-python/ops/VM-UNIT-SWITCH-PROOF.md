# Isolated unit-switch proof vehicle

Status: bounded fixture proof vehicle only. This is not a production adapter,
cutover authorization, C2 readiness, parity evidence or CQ enablement. The
production adapter remains unavailable and no real runtime completion exists.
The restart/reboot matrix below does restart the real guest user manager and
reboot the real guest OS at the tested transaction boundaries, but it remains
fixture-only and is not power-loss proof.

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
| ``ops/vm-unit-switch-guest.py`` | In-guest driver: isolated git checkout, seeded queue/heartbeat, completed historical record, both directions, interruption, repeated recovery, the activation-fence probe, and the restart/reboot matrix at the ``drained``, ``restore_staged`` and ``activation_pending`` boundaries. |
| ``ops/vm-unit-switch.py`` | Host harness reusing ``vm-feasibility.py`` lifecycle, uploading exact script bytes, restarting the real guest user manager or rebooting the guest OS between a boundary and its observation, retaining raw guest evidence and a report outside the worktree. |

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
8. ``rollback-fence``: start one more Python-to-Node switch and SIGKILL it at
   ``install``. Invoke recovery and SIGKILL it at ``restore_staged``, after the
   prior Python service has been written to the staged path but before the
   controller journals ``restore_activation_pending``. Require the retained
   record to remain ``drained`` with unchanged bytes, the durable
   ``/dev/null`` mask still in place, a refused direct start, the staged prior
   Python service, and no new completion. Complete recovery, require
   ``rolled_back`` with exact Python restoration and no staged path, then
   require repeated recovery to refuse without changing the record.
9. ``inspect``: confirm the final Python unit, no mask, preserved queue,
   heartbeat and historical record bytes.
10. ``fence``: start one more Python-to-Node switch and SIGKILL the controller
   at the ``start`` boundary, after ``install`` staged the target and the
   controller durably journaled ``activation_pending`` but before ``start``
   releases the mask. Require the pending ``activation_pending`` record, the
   ``/dev/null`` service mask, a refused direct ``systemctl start`` with an
   explicit mask error, the staged target behind the mask, no new completion,
   and a recovery refusal that leaves the record bytes unchanged. This probe
   intentionally leaves the disposable guest ambiguous.

## Restart/reboot matrix

``run --mode matrix`` keeps steps 1-9, inserts the matrix below, and uses the
final ``fence`` as step 20. The host process survives every guest boundary.

11. ``matrix-restart-drained``: Python-to-Node switch killed at ``install``;
    real ``systemctl restart user@$(id -u).service``; observe the retained
    ``drained`` record, ``/dev/null`` mask, missing staged target, inactive
    timer and no owned work; recovery rolls back to Python; repeated recovery
    refuses.
12. ``matrix-restart-restore-staged``: Python-to-Node switch killed at
    ``install``, then recovery killed at ``restore_staged``; real user-manager
    restart; observe the ``drained`` record, mask, staged prior Python service
    and no completion; recovery rolls back; repeated recovery refuses.
13. ``matrix-restart-ambiguity``: Python-to-Node switch killed at ``start``;
    real user-manager restart; observe the ``activation_pending`` record, mask,
    staged Node target and no completion; two recoveries refuse with rc 3 and
    leave the record bytes unchanged.
14. ``matrix-reset-python``: restore the fixture to Python without touching the
    retained ambiguity record.
15. ``matrix-switch-node``: actual completed Python-to-Node switch so the
    reboot cases start from Node.
16. ``matrix-reboot-drained``: Node-to-Python switch killed at ``install``;
    real ``systemctl reboot``; observe a changed boot ID, a changed
    user-manager invocation, the retained ``drained`` record, mask and missing
    staged target; recovery rolls back to Node; repeated recovery refuses.
17. ``matrix-reboot-restore-staged``: Node-to-Python switch killed at
    ``install``, recovery killed at ``restore_staged``; real guest reboot;
    observe the ``drained`` record, mask, staged prior Node service and no
    completion; recovery rolls back; repeated recovery refuses.
18. ``matrix-reboot-ambiguity``: Node-to-Python switch killed at ``start``;
    real guest reboot; observe the ``activation_pending`` record, mask, staged
    Python target and no completion; two recoveries refuse with rc 3.
19. ``matrix-reset-python-final``: restore the fixture to Python without
    touching the second retained ambiguity record.
20. ``fence``: the base activation fence from Python to Node.

The ambiguity cases keep their pending records in private directories
(``records/ambiguity-manager-restart`` and ``records/ambiguity-guest-reboot``)
so independent cases do not block each other. That is test isolation, not a
resolution mechanism and not a fix for the known cross-directory journal
interoperability gap.

## Recorded evidence

One base-mode run completed on Pluto (KVM, Ubuntu noble guest ``crq-probe``)
from source commit ``0f9111d70aa06b8f907e453109bb1b791e19f48c``:

- run ``20261110T180943Z-f3acc725``
- ``report.json`` SHA-256
  ``589d6b9c3b0f3d57617b1b31eed8e82849297ae28bb2d940c7e51a375d6bdd9d``
- ``raw-guest-evidence.tar.gz`` SHA-256
  ``6ba3b78ee5c7a1b6f659ae2231d2bdede4bd7fc1ec0f56f92130daead2130178``
  (``125853`` bytes)
- host script ``executed-host-script.py`` SHA-256
  ``75d374ef085fbf22dd4c9bf167ee65cc5deb8aa2bb0e2406368dbd1726f3e923``
- host feasibility module ``executed-host-vm-feasibility.py`` SHA-256
  ``04757807a7af3de2824054e9dd79ba3b706c109e62498f8ec5dd56a44362b996``
- guest script ``executed-guest-probe.py`` SHA-256
  ``70aa6e51a841bdcb08f5dc047ffc6d6329c8484cceef8a8cd24dcfcca508be0e``

The report records all 21 checks true and ``problems: []``; a second
``verify`` with the current verifier recomputed the checks and re-hashed the
retained artifacts with ``problems: []``, including comparison of every phase
with the retained raw guest phase JSON, the retained controller journals and
the uploaded script bytes. Provenance verification requires the exact six
uploaded controller and fixture scripts, nonempty matching local and remote
digests, verified upload status, the recorded source commit and the report
directory path. A host-validator-only change may re-run this check against the
retained report when the guest scripts are byte-identical; that is a validator
re-run, not a new guest run. The host checks also refuse a run when the
executed ``vm-unit-switch.py`` or its imported ``vm-feasibility.py`` has
uncommitted changes, so evidence cannot be attributed to HEAD when the host
implementation differs from that commit. Each report retains both executed
host modules under ``provenance.host_modules`` and verifies their artifact
digests. Rollback restores the prior service into the staged path while the
durable ``/dev/null`` mask remains in place; the controller journals
``restore_activation_pending`` before ``restore_activation`` releases the
staged service and restores its prior activation state. Artifacts stay at
``~/crq-vm-feasibility/state/runs/20261110T180943Z-f3acc725/`` on Pluto,
outside the worktree. The earlier run ``20261110T173225Z-de36ec18`` remains on
Pluto as history; it predates the rollback-fence phase and the current
verifier's phase set, so the current verifier does not re-validate it. The
earlier retained run ``20261110T170322Z-9e8c5133`` also remains and is not
rewritten.

The run produced:

| Step | Observed |
|---|---|
| ``switch-node`` | completed; sequences ``1,2`` with distinct invocation IDs; ``node:bbbb…``; queue/heartbeat/history unchanged; ``record_count`` 2 |
| ``switch-python`` | completed; sequences ``3,4`` with distinct invocation IDs; ``python``; queue/heartbeat/history unchanged; ``record_count`` 3 |
| ``interrupt`` | CLI rc ``-9``; pending ``drained`` record ``controller-1e6d7abf…`` SHA-256 ``069c7cf1…``; service left as the durable ``/dev/null`` mask; timer inactive and enabled |
| ``recover-kill`` | CLI rc ``-9``; record SHA-256 ``069c7cf1…`` identical before and after; queue/heartbeat/history unchanged |
| ``recover`` | CLI rc ``0``; ``rolled_back`` at ``restore_activation_pending``; record SHA-256 ``ac9949ee…``; prior Python bytes/mode/uid/gid and timer enablement restored exactly |
| ``recover-repeat`` | CLI rc ``2``; ``invalid unit recovery record``; no further mutation |
| ``rollback-fence`` | CLI rc ``-9``; pending ``drained`` record ``controller-5b1103b8…`` SHA-256 ``91458ea5…``; mask; refused direct start; staged prior Python; no new completion; completed recovery ``rolled_back``; repeated recovery rc ``2`` |
| ``inspect`` | final Python service SHA-256 ``a8a0e280…``; timer SHA-256 ``3edf2fd6…``; five retained records; seeded queue, heartbeat and historical record bytes unchanged |
| ``fence`` | CLI rc ``-9``; pending ``activation_pending`` record ``controller-6c698e3c…`` SHA-256 ``6cbcf082…``; service ``LoadState=masked`` through the ``/dev/null`` symlink; direct start rc ``1`` with ``Unit crq-tick.service is masked.``; staged Node target behind the mask; completions ``4`` before and ``4`` after; recovery rc ``3`` with identical record bytes |

### Restart/reboot matrix run

One matrix run completed on Pluto (KVM, Ubuntu noble guest ``crq-probe``)
from source commit ``b2748889a164d10677b6aa317d467152ccc7969d``:

- run ``20261110T185429Z-a5212c16``
- ``report.json`` SHA-256
  ``bf59192aa838865ad9b101b73ca75d33234847d65c5c79c6fb4b5bfae4225012``
- ``raw-guest-evidence.tar.gz`` SHA-256
  ``cd2885d1b80c0a8cb89e554ed3bbbf403f183a214e91a73dc0ea0cca26e5b5cc``
  (``177539`` bytes)
- host script ``executed-host-script.py`` SHA-256
  ``8a5782bc807ecffc5ac202a76cf0103cb43151e02e2e4ea794850aab3ef058be``
- host feasibility module ``executed-host-vm-feasibility.py`` SHA-256
  ``04757807a7af3de2824054e9dd79ba3b706c109e62498f8ec5dd56a44362b996``
- guest script ``executed-guest-probe.py`` SHA-256
  ``4c226d84d192b554b6c553ee1170766318c221d60404766342b646dab3acdea1``

The report records all 57 checks true and ``problems: []``. A second
``verify`` recomputed the checks and re-hashed the retained artifacts with
``problems: []``, including every phase against the retained raw guest phase
JSON, the final retained journal state in each record directory (the main
directory plus both private ambiguity directories), the uploaded script
bytes and the final service mask and staged target. The guest observe phase
independently records the boot ID and user-manager invocation before and
after each boundary; the host restart/reboot command records are report
provenance, while the guest observation is the raw-verifiable identity
evidence.

| Case | Boundary | Identity | Retained state | Recovery |
|---|---|---|---|---|
| ``matrix-restart-drained`` | switch killed at ``install`` | boot ID unchanged; manager invocation ``af321eb4…`` to ``fad3d79c…`` | ``drained`` record ``972ed2f2…``; mask; staged missing; completions ``4``/``4`` | rc ``0``, then repeated rc ``2`` |
| ``matrix-restart-restore-staged`` | switch killed at ``install``; recovery killed at ``restore_staged`` | boot ID unchanged; manager invocation ``fad3d79c…`` to ``cf3bce73…`` | ``drained`` record ``bfb0a431…``; mask; staged prior Python; completions ``4``/``4`` | rc ``0``, then repeated rc ``2`` |
| ``matrix-restart-ambiguity`` | switch killed at ``start`` | boot ID unchanged; manager invocation ``cf3bce73…`` to ``fe012cf3…`` | ``activation_pending`` record ``11a1e463…``; mask; staged Node; completions ``4``/``4`` | rc ``3`` twice; record bytes unchanged |
| ``matrix-reboot-drained`` | switch killed at ``install`` | boot ID ``349fe42a…`` to ``45d0c867…``; manager invocation ``fe012cf3…`` to ``47b0d9b8…`` | ``drained`` record ``1742f8c5…``; mask; staged missing; completions ``6``/``6`` | rc ``0``, then repeated rc ``2`` |
| ``matrix-reboot-restore-staged`` | switch killed at ``install``; recovery killed at ``restore_staged`` | boot ID ``45d0c867…`` to ``9a6b6bbb…``; manager invocation ``47b0d9b8…`` to ``c610f0db…`` | ``drained`` record ``b13d6b30…``; mask; staged prior Node; completions ``6``/``6`` | rc ``0``, then repeated rc ``2`` |
| ``matrix-reboot-ambiguity`` | switch killed at ``start`` | boot ID ``9a6b6bbb…`` to ``f10ae3c6…``; manager invocation ``c610f0db…`` to ``23320893…`` | ``activation_pending`` record ``e1c681a6…``; mask; staged Python; completions ``6``/``6`` | rc ``3`` twice; record bytes unchanged |

Both resets restored a loaded inactive Python service and an enabled inactive
timer without changing the retained ambiguity record. The aggregate checks
also require both runtime directions, no ``daemon-reload`` in any restart
command, a changed boot ID for every reboot, no unrecorded completion, and
retained ambiguity after both restart and reboot. The base proof run
``20261110T180943Z-f3acc725``, the earlier historical run
``20261110T173225Z-de36ec18`` and the earlier retained run
``20261110T170322Z-9e8c5133`` remain on Pluto and are not rewritten.

The fixture timer uses ``OnUnitInactiveSec=1s`` and ``AccuracySec=1s``. The
default one-minute timer accuracy outlasted the completion bound in an earlier
attempt; the fixture now bounds it explicitly. This is fixture configuration,
not a production template change.

## Not proven

- No production adapter, allowlist change, production journal interop or
  legacy-resolution mechanism.
- No real Python or Node CRQ runtime completion; the fixture provider is fake.
- The matrix restarts the real guest user manager and reboots the real guest
  OS at the tested boundaries, but it is not power-loss proof, not a
  production host, and not a privileged-ownership, ACL or xattr proof.
- Activation-pending ambiguity is isolated in a private record directory per
  case. That is test isolation, not a resolution mechanism or a fix for the
  known cross-directory journal interoperability gap.
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
  run --source-commit "$commit" --mode matrix
python3 apps/crq-python/ops/vm-unit-switch.py \
  --state-dir "$state" \
  --tools ~/crq-vm-feasibility/tools \
  verify "$state/runs/<run>/report.json"
```

Use ``run --mode base`` for the earlier preactivation-only proof. The matrix
requires the guest to reboot itself; run it only on a disposable guest.

Run the named tests locally:

```sh
pnpm test:narrow apps/crq-python/test_unit_switch_adapter.py \
  apps/crq-python/test_unit_switch_cli.py \
  apps/crq-python/test_vm_unit_switch.py
```
