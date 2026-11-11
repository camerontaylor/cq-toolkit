# Isolated unit-switch proof vehicle

Status: bounded fixture proof vehicle only. This is not a production adapter,
cutover authorization, C2 readiness, parity evidence or CQ enablement. The
production adapter remains unavailable and no real runtime completion exists.
The restart/reboot matrix below does restart the real guest user manager and
reboot the real guest OS at the tested transaction boundaries, but it remains
fixture-only and is not power-loss proof.

## Scope

The vehicle exercises the *actual* controller seam
(``deploy-controller.switch_unit`` and ``recover_unit``) against two declared
harmless guest topologies in a disposable guest: ``crq-tick.service`` with a
timer (the base and matrix modes), and ``crq-repair.service`` with a timer, a
path activator and one declared blocker drop-in (the activators mode). It does
not modify the controller's unit allowlist, add a journal, lock, pointer
store, ledger, approval mechanism or resolution file, and it does not touch a
production host, checkout, credential or provider.

Files:

| File | Role |
|---|---|
| ``ops/unit-switch-adapter.py`` | Guest-only adapter: durable ``/dev/null`` service replacement, target staged behind the mask until ``start`` releases it, exact path/type/bytes/mode/uid/gid snapshot and restoration, bounded job/cgroup drain, fake unit/runtime-bound completion provider. |
| ``ops/unit-switch.py`` | Explicit ``switch``/``recover`` CLI; calls the real controller and requires ``--proof-fixture``. No default or production adapter. |
| ``ops/unit-switch-fixture.py`` / ``.mjs`` | Harmless Python and Node fixtures emitting distinguishable runtime-bound completion records with real systemd invocation IDs. |
| ``ops/vm-unit-switch-guest.py`` | In-guest driver: exact runner-source extraction, isolated git checkout, seeded queue/heartbeat and runner metadata, completed historical record, drain refusals and harvest, both directions, interruption, repeated recovery, the activation-fence probe, the restart/reboot matrix at the ``drained``, ``restore_staged`` and ``activation_pending`` boundaries, and the second topology with an allowlisted timer/path/drop-in inventory, positive controls and refusal matrix. |
| ``ops/vm-unit-switch.py`` | Host harness reusing ``vm-feasibility.py`` lifecycle, uploading exact script bytes and ``git archive HEAD apps/crq-python`` as the runner source, restarting the real guest user manager or rebooting the guest OS between a boundary and its observation, retaining raw guest evidence and a report outside the worktree, and recomputing the exact repair topology bytes, paths, metadata, unit states and record snapshots. |

## Sequence

1. ``prepare``: verify the ``crq-probe`` guest layout; extract the uploaded
   ``crq-runner-source.tar.gz`` (``git archive HEAD apps/crq-python``) into a
   throwaway git checkout, requiring ``crq.py`` and ``author_quota.py``;
   seed ``queue.json`` and ``heartbeat.json``; install the harmless Python
   fixture as ``crq-tick.service`` and its timer; seed a completed historical
   ``controller-*.json`` record and retain its bytes.
2. ``drain-alive``: seed a real detached session-leader process and a genuine
   ``review.pid`` entry for a runner-owned queued run, so
   ``crq.run_liveness`` reports ``alive``. Invoke the actual switch CLI.
   Require rc ``2`` and an explicit ``queue-owned work`` refusal before the
   adapter preflight, snapshot or journal write; unchanged queue bytes, no new
   journal record, no fixture completion, unchanged unit metadata and
   activation, and both the owned and an unrelated detached guest process
   still alive with unchanged ``/proc`` identity. The guest harness alone
   cleans up the seeded processes.
3. ``switch-node``: actual ``switch_unit`` from Python to a fake
   ``node:<sha>`` runtime. Require two advancing, distinct invocation-bound
   completions.
4. ``drain-ambiguous``: seed a recorded runner run with no pidfile, pid or
   terminal artifact, so liveness is genuinely ``ambiguous``. Require the same
   refusal and preservation as ``drain-alive``.
5. ``switch-python``: actual ``switch_unit`` back to the Python runtime with the
   same completion requirement.
6. ``drain-harvest``: seed a real detached process that has exited, with a
   completed ``exit.json``, so liveness is ``harvest``. Require the drain to
   accept it, both real switches (Python to Node and back) to proceed with
   advancing completions, and the seeded queue bytes and unrelated detached
   process to be preserved.
7. ``interrupt``: start a Python-to-Node switch and SIGKILL the controller at
   the ``install`` boundary, after the journal reached ``drained`` and the
   durable mask was established. ``install`` stages the target without
   releasing the mask, so the pending record and mask must remain.
8. ``recover-drain-alive``: retain the ``interrupt`` ``drained`` record, then
   seed live runner-owned queue work. Invoke the actual recovery CLI. Require
   it to re-observe ownership independently and refuse with rc ``2`` before
   snapshot validation, re-fencing, restore or journal rewrite; unchanged
   record bytes and phase, unchanged durable mask and absent staged path,
   unchanged service/timer activation, unchanged queue bytes, no completion,
   and both seeded processes alive.
9. ``recover-kill``: invoke the actual recovery CLI and SIGKILL it during the
   re-drain. Require the retained record bytes to remain unchanged.
10. ``recover``: invoke recovery again. Require ``rolled_back`` and exact
   restoration of the prior Python service bytes, mode, ownership and timer
   activation/enablement.
11. ``recover-repeat``: invoke recovery against the completed rollback again.
   Require an explicit refusal and unchanged record bytes.
12. ``rollback-fence``: start one more Python-to-Node switch and SIGKILL it at
   ``install``. Invoke recovery and SIGKILL it at ``restore_staged``, after the
   prior Python service has been written to the staged path but before the
   controller journals ``restore_activation_pending``. Require the retained
   record to remain ``drained`` with unchanged bytes, the durable
   ``/dev/null`` mask still in place, a refused direct start, the staged prior
   Python service, and no new completion. Complete recovery, require
   ``rolled_back`` with exact Python restoration and no staged path, then
   require repeated recovery to refuse without changing the record.
13. ``inspect``: confirm the final Python unit, no mask, preserved queue,
   heartbeat and historical record bytes.
14. ``fence``: start one more Python-to-Node switch and SIGKILL the controller
   at the ``start`` boundary, after ``install`` staged the target and the
   controller durably journaled ``activation_pending`` but before ``start``
   releases the mask. Require the pending ``activation_pending`` record, the
   ``/dev/null`` service mask, a refused direct ``systemctl start`` with an
   explicit mask error, the staged target behind the mask, no new completion,
   and a recovery refusal that leaves the record bytes unchanged. This probe
   intentionally leaves the disposable guest ambiguous.

## Restart/reboot matrix

``run --mode matrix`` keeps steps 1-13, inserts the matrix below, and uses the
final ``fence`` as step 24. The host process survives every guest boundary.

15. ``matrix-restart-drained``: Python-to-Node switch killed at ``install``;
    real ``systemctl restart user@$(id -u).service``; observe the retained
    ``drained`` record, ``/dev/null`` mask, missing staged target, inactive
    timer and no owned work; recovery rolls back to Python; repeated recovery
    refuses.
16. ``matrix-restart-restore-staged``: Python-to-Node switch killed at
    ``install``, then recovery killed at ``restore_staged``; real user-manager
    restart; observe the ``drained`` record, mask, staged prior Python service
    and no completion; recovery rolls back; repeated recovery refuses.
17. ``matrix-restart-ambiguity``: Python-to-Node switch killed at ``start``;
    real user-manager restart; observe the ``activation_pending`` record, mask,
    staged Node target and no completion; two recoveries refuse with rc 3 and
    leave the record bytes unchanged.
18. ``matrix-reset-python``: restore the fixture to Python without touching the
    retained ambiguity record.
19. ``matrix-switch-node``: actual completed Python-to-Node switch so the
    reboot cases start from Node.
20. ``matrix-reboot-drained``: Node-to-Python switch killed at ``install``;
    real ``systemctl reboot``; observe a changed boot ID, a changed
    user-manager invocation, the retained ``drained`` record, mask and missing
    staged target; recovery rolls back to Node; repeated recovery refuses.
21. ``matrix-reboot-restore-staged``: Node-to-Python switch killed at
    ``install``, recovery killed at ``restore_staged``; real guest reboot;
    observe the ``drained`` record, mask, staged prior Node service and no
    completion; recovery rolls back; repeated recovery refuses.
22. ``matrix-reboot-ambiguity``: Node-to-Python switch killed at ``start``;
    real guest reboot; observe the ``activation_pending`` record, mask, staged
    Python target and no completion; two recoveries refuse with rc 3.
23. ``matrix-reset-python-final``: restore the fixture to Python without
    touching the second retained ambiguity record.
24. ``fence``: the base activation fence from Python to Node.

The ambiguity cases keep their pending records in private directories
(``records/ambiguity-manager-restart`` and ``records/ambiguity-guest-reboot``)
so independent cases do not block each other. That is test isolation, not a
resolution mechanism and not a fix for the known cross-directory journal
interoperability gap.

## Activation-inventory mode

``run --mode activators`` keeps ``prepare`` as the original tick baseline and
then exercises the second topology. It does not re-run the drain, fake
completion, interrupt or restart/reboot proofs; those keep the base and matrix
modes as their evidence. The mode is fixture-only and does not change the
journal schema or action enum.

1. ``activators-install``: install ``crq-repair.service``, its timer, a
   ``PathExists=`` path unit, the exact ``timers.target.wants`` and
   ``default.target.wants`` links, and one declared blocker drop-in. Reload and
   take the adapter inventory. Require the exact six owned paths, the exact
   activator names and states, no other ``crq-repair*`` entry, and an
   unchanged original tick state.
2. ``activators-positive``: prove a real timer firing, a real path trigger, a
   direct start, a dependency caller start and a genuinely queued start behind
   a running blocker. Every negative or queued observation retains the command
   result, unit, job line, load state, completion baseline and bounded wait.
   The queued job is cancelled by a real ``stop``; mask and reload alone are
   not treated as cancellation.
3. ``activators-unknown``: refuse a rogue ``crq-repair.socket``, an unexpected
   enablement link, an unexpected drop-in and group/world-writable drop-in
   metadata before any journal write or unit mutation. The original tick
   state, record set and completion log must be unchanged and the rogue entry
   removed after each case.
4. ``activators-fence``: run a Python-to-Node switch with a real queued target
   behind a verified blocker. A bounded guest-only pause after the durable
   mask reload issues an external direct start, an external dependency start
   and a path trigger, and observes the queue, blocker identity, unit states
   and completion log. Require the queued job and all external attempts to be
   refused or cancelled, the drain to settle with no service or activator job,
   and exactly two post-release completions that are absent from the
   pre-release and pause baselines. The released timer is active and the
   enabled path stays inactive.
5. ``activators-switch-back``: complete the reverse switch to Python and
   require two advancing completions and the same independent activation
   policy.
6. ``activators-interrupt``: SIGKILL at ``install``; require a pending
   ``drained`` record, the durable ``/dev/null`` mask, no staged target, both
   activators stopped and no completion.
7. ``activators-recover`` / ``activators-repeat``: recover to the exact Python
   service and the prior independent active/enabled states, then refuse a
   repeated recovery without changing the record bytes.
8. ``activators-inspect``: require the final Python service, active timer,
   enabled but inactive path, exact drop-in and wants links, absent staged and
   trigger paths, three retained activator records, the unchanged tick
   baseline, and an unrelated detached process that survives the switch and is
   cleaned up only by the harness.

The adapter inventory is an allowlisted guest topology, not exhaustive
production activator discovery. Other-name dependency units, default-target
links and socket units outside the exact declared paths remain a production
inventory gap. Path-topology manager restart and guest reboot are deferred to
a later slice; the existing restart/reboot matrix covers the tick topology
only.

## Recorded evidence

### Activators proof run (current)

One fresh activators run completed on Pluto (KVM, Ubuntu noble guest
``crq-probe``) from source commit
``779ef5c494494acb689951cd77d66ae216a63674``:

- report ``~/crq-vm-feasibility/state/runs/20261111T032335Z-7d2896be/report.json``
- all 19 checks true; ``problems: []``
- ``raw-guest-evidence.tar.gz`` 1,175,424 bytes, SHA-256
  ``c404cb18c0a01aa7cf218ed73a16c87bf2fbe74b0eed948b685a0cd4f7ab194b``
- report SHA-256
  ``a1be30f096300ea1b1f12026ca19cfcbe64f82e5d16d647966bbad63cd0cb090``
- host script SHA-256
  ``030895b048ad239f88e3fbd3d2a55d5202f22fb7c529e9b4852942faecb58b3f``
- guest script SHA-256
  ``5c9b68542a90fce42e994d3092f6106c1dfc6e1a92ba975fdb9c84649c53a9dc``

Two independent ``verify`` invocations against the retained report both
returned ``problems: []`` with ``host_matches_run: true``,
``guest_matches_run: true`` and ``validator_only: false``.

The queue positive control recorded the exact waiting job
``52 crq-repair.service start waiting``; its raw list-jobs command is the exact
``systemctl --user list-jobs --no-legend --no-pager`` argv with rc ``0`` and
stdout containing the blocker job ``32`` and the target job ``52``. The
retained lines equal the normalized stdout, and the post-stop command stdout
contains only the blocker job. The fence seed recorded the same exact argv
with blocker job ``191`` and target job ``211``, and the pause retained the
same job ID, unit, type and state with the same blocker ``MainPID`` and
``InvocationID``. The drain list-jobs command has empty stdout and an empty
line list, a successful service stop, and both activators inactive. The
pre-release and during completion inventories are identical, so the zero
external delta is derived rather than trusted; the fence record
``controller-6daefc0cec4746f4ae53aaf29c387d15`` (SHA-256
``540d3002b83f27225cc814a0848fb2ec416a9e2d6dc5597ba0183c72edb1333f``)
is ``completed`` at ``activation_pending`` for ``node:bbbb…`` with distinct
completion sequences ``5`` and ``6``. The released timer was active, the
enabled path inactive and the settled service inactive. The switch-back
completed to ``python`` with sequences ``8`` and ``9`` after a real inactive
transition; the interrupt retained a pending ``drained`` record; recovery
rolled it back at ``restore_activation_pending``; repeated recovery refused
with rc ``2``; and inspection retained three activator records, an active
timer, an enabled but inactive path, the exact service bytes, and an unrelated
process that survived until harness cleanup. All four refusal cases retained
present, paired, empty journal inventories and unchanged completion counts.

The adapter now refuses a repair preflight or snapshot with both timer and
path inactive, before the controller can journal or mutate a unit; an
enabled-but-inactive activator does not count as active. Actual controller
and adapter tests cover one active activator (the inactive path is preserved)
and both inactive (``Refused`` with no controller record, unchanged service
and no completion). Removing the precondition makes those three tests fail;
removing the raw stdout binding makes the queued and fence contradiction
tests fail.

### Earlier review-fix activators run (preserved)

The run ``20261111T025413Z-dc3fff72`` from source commit
``2f5e8fd23e7eb893f67af7fd06fe23a11d020b6f`` remains preserved: all 19 checks
true, report SHA-256
``eeb54fd9ca4ae784b1a520596d361a6a0f20ae979bc52faa4a352d435e11e5ac``,
raw tar 1,171,689 bytes with SHA-256
``65c1354c11b80c1eda71f7162c56e296d38f4ce1fe60e1dca2a4ee87e98a7c48``,
host script
``8db220ec25a4f35620cc289ba38b002c1ee07e0f54090d26e1fa6e842b42a83c`` and
guest script
``5c9b68542a90fce42e994d3092f6106c1dfc6e1a92ba975fdb9c84649c53a9dc``.
It predates the raw stdout binding and the repair activation precondition;
the current run above is the fresh committed-source-bound evidence.

### Earlier activators proof run (preserved)

The earlier fresh activators run from source commit
``8e4b302d958f02387d0d2be96f4d65d6bf399598`` is preserved as genuine
provenance: run ``20261111T021704Z-110a85ab``, report SHA-256
``e7aec082cd1d5997d805bf793479c6bb47ccb8b8e3a35ec3bebed1ed0b2efbea``,
raw tar 1,165,031 bytes with SHA-256
``76475f1641bfd061d6a52737e2ec42c74dceede8f854c59c45bc88749c896e15``,
host script ``46ffd8cc948419e6aea83ed28be41316d20d11a862f614873f600de0fb6d5fec``
and guest script
``500038395e90cb87a6a9e2043d3e9748311a1fb8468b52aac03fc3b5e4e311b4``.
It remains valid evidence for the state it observed, but it predates the
typed settlement, job-identity, derived-delta and refusal-inventory checks;
the current run above is the fresh committed-source-bound evidence for the
second topology. The later test and documentation commits do not change the
proof scripts; their recorded hashes remain the binding.

The tick runs below predate ``--mode activators``. They remain valid for the
tick topology and are preserved unchanged.

### Current drain/harvest proof runs

Both current runs completed on Pluto (KVM, Ubuntu noble guest ``crq-probe``)
from source commit ``a5033cb2f6a5cab2c9cd0e45368ef2e9737a869c``. That commit
is also the source of the uploaded ``crq-runner-source.tar.gz``
(``905950`` bytes, SHA-256
``9030c950d6a1009d62a464e0c1f87e1a9833dc5b2868d6c68bc9024256f7c37a``).
The host script is
``3f92755e14bc72a3a34fcd66b26c9c4e68ca23fcbfa5877b57f45091fa3ca77d`` and the
guest script is
``65a92e001f6cf7f5cbb7b60c0f28c21da42010e103d95041b4a85f9a58b13f0d``.

- Base mode, run ``20261110T220347Z-4db17be7``: 26 of 26 checks true,
  ``problems: []``. ``report.json`` SHA-256
  ``f9fa3bd554bc36227267e5d5e8ff3fa69c42053bd586f632d37af457fc9395ec``;
  ``raw-guest-evidence.tar.gz`` SHA-256
  ``1169d21b816696e954324479a6493e6821c9e72e53bf35cad900fdc6dc4b838e``
  (``1066512`` bytes).
- Matrix mode, run ``20261110T220604Z-c9b62fa0``: 62 of 62 checks true,
  ``problems: []``. ``report.json`` SHA-256
  ``766d79964f216b6ef657d50bbe907d12f48fa8aba23913797c0a56c01b8cd5b6``;
  ``raw-guest-evidence.tar.gz`` SHA-256
  ``101439e280ede13cc1dfee5367a3bc70c6d2153c0257b0bb095a2183a91be8c6``
  (``1133509`` bytes).

A second ``verify`` of each retained report returned ``problems: []``,
``host_matches_run: true``, ``guest_matches_run: true`` and
``validator_only: false``, and recomputed every phase, the retained raw
journal state, the uploaded scripts and the runner source archive. The
drain-specific checks are ``runner_source_recorded``,
``drain_alive_refused``, ``drain_ambiguous_refused``,
``drain_harvest_proceeds`` and ``recovery_drain_refused``. Artifacts remain
at ``~/crq-vm-feasibility/state/runs/20261110T220347Z-4db17be7/`` and
``~/crq-vm-feasibility/state/runs/20261110T220604Z-c9b62fa0/`` on Pluto,
outside the worktree.

The tightened preservation checks were then re-run against both retained
reports with host script
``b8793ce76af86d2f88491d26452249d4dcddcf9f97ef553001e12572d64730a9``. That
validator binds the snapshot to the expected guest unit, timer, enablement and
staged paths, their installed types and metadata fields, requires the
independent metadata and file views to agree on every shared field, binds the
history record and expected record roots. Both
still returned ``problems: []``, with ``guest_matches_run: true``,
``host_matches_run: false`` and ``validator_only: true``: only the validator
changed; the guest script, report and raw evidence are unchanged. This is a
validator-only re-verification, not a fresh guest run.

### Earlier base-mode run (historical)

One earlier base-mode run completed on Pluto (KVM, Ubuntu noble guest ``crq-probe``)
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

The run report recorded all 21 contemporaneous checks true and
``problems: []``, and its contemporaneous verifier re-hashed the retained
artifacts. It predates the drain phases and the runner-source upload, so the
current verifier does not re-validate it and it is not evidence for the
drain/harvest slice. Provenance verification for the current verifier
requires the exact six uploaded controller and fixture scripts, the
``git archive HEAD apps/crq-python`` runner source, nonempty matching local
and remote digests, verified upload status, the recorded source commit and
the report directory path. A host-validator-only change may re-run a check
against a retained report when the guest scripts are byte-identical; that is
a validator re-run, not a new guest run. The host checks also refuse a run
when the executed ``vm-unit-switch.py``, its imported ``vm-feasibility.py``
or the runner source under ``apps/crq-python`` has uncommitted changes, so
evidence cannot be attributed to HEAD when the exercised implementation
differs from that commit. Each report retains both executed host modules
under ``provenance.host_modules`` and verifies their artifact digests.
Rollback restores the prior service into the staged path while the durable
``/dev/null`` mask remains in place; the controller journals
``restore_activation_pending`` before ``restore_activation`` releases the
staged service and restores its prior activation state. Artifacts stay at
``~/crq-vm-feasibility/state/runs/20261110T180943Z-f3acc725/`` on Pluto,
outside the worktree. The earlier run ``20261110T173225Z-de36ec18`` remains on
Pluto as history; it predates the rollback-fence phase. The earlier retained
run ``20261110T170322Z-9e8c5133`` also remains and is not rewritten.

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

### Earlier restart/reboot matrix run (historical)

One earlier matrix run completed on Pluto (KVM, Ubuntu noble guest
``crq-probe``) from source commit
``c1aa549fc6fb52829cfb2e075c53dfffcd343292``. It predates the drain phases
and the runner-source upload, so the current verifier does not re-validate
it and it is historical evidence for the restart/reboot matrix, not the
current drain/harvest slice:

- run ``20261110T192818Z-f879a12d``
- ``report.json`` SHA-256
  ``2ca6fd047fbf27e8aa61cbb64ee953e05d6f66faf6597ef5dac5448243e257be``
- ``raw-guest-evidence.tar.gz`` SHA-256
  ``163aae8b82627250c466c7d151188f56a74599b1b55af62ea84473f999b59f53``
  (``177986`` bytes)
- host script ``executed-host-script.py`` SHA-256
  ``5f2fa8ea7d52a21871e1a1d6e79d8375aad52d07b20571d9e3c5f0960f996589``
- host feasibility module ``executed-host-vm-feasibility.py`` SHA-256
  ``04757807a7af3de2824054e9dd79ba3b706c109e62498f8ec5dd56a44362b996``
- guest script ``executed-guest-probe.py`` SHA-256
  ``f850e0a92e489be82e95e52318f74464541573eb9adf84ba155fd8f12063b980``

The run report recorded all 57 contemporaneous checks true and
``problems: []``, and its contemporaneous verifier recomputed every phase
against the retained raw guest phase JSON. Every observe phase records
``jobs: []``, no owned PIDs, matching completion counts and an inactive
timer. The guest observe phase independently records the boot ID and
user-manager invocation before and after each boundary; the host
restart/reboot command records are report provenance, while the guest
observation is the raw-verifiable identity evidence.

| Case | Boundary | Identity | Retained state | Recovery |
|---|---|---|---|---|
| ``matrix-restart-drained`` | switch killed at ``install`` | boot ID unchanged; manager invocation ``b354cf5f…`` to ``cb098183…`` | ``drained`` record ``e7faf8fa…``; mask; staged missing; completions ``4``/``4`` | rc ``0``, then repeated rc ``2`` |
| ``matrix-restart-restore-staged`` | switch killed at ``install``; recovery killed at ``restore_staged`` | boot ID unchanged; manager invocation ``cb098183…`` to ``2b7b3526…`` | ``drained`` record ``9f77a76a…``; mask; staged prior Python; completions ``4``/``4`` | rc ``0``, then repeated rc ``2`` |
| ``matrix-restart-ambiguity`` | switch killed at ``start`` | boot ID unchanged; manager invocation ``2b7b3526…`` to ``b68c67d5…`` | ``activation_pending`` record ``e2428f32…``; mask; staged Node; completions ``4``/``4`` | rc ``3`` twice; record bytes unchanged |
| ``matrix-reboot-drained`` | switch killed at ``install`` | boot ID ``0cfbfbc7…`` to ``fea076b7…``; manager invocation ``b68c67d5…`` to ``e6e5e2ce…`` | ``drained`` record ``fc1f60f1…``; mask; staged missing; completions ``6``/``6`` | rc ``0``, then repeated rc ``2`` |
| ``matrix-reboot-restore-staged`` | switch killed at ``install``; recovery killed at ``restore_staged`` | boot ID ``fea076b7…`` to ``b5bfc10a…``; manager invocation ``e6e5e2ce…`` to ``bf23d358…`` | ``drained`` record ``8b6b23bf…``; mask; staged prior Node; completions ``6``/``6`` | rc ``0``, then repeated rc ``2`` |
| ``matrix-reboot-ambiguity`` | switch killed at ``start`` | boot ID ``b5bfc10a…`` to ``ba737382…``; manager invocation ``bf23d358…`` to ``6e7a00d0…`` | ``activation_pending`` record ``c70aa41b…``; mask; staged Python; completions ``6``/``6`` | rc ``3`` twice; record bytes unchanged |

Both resets restored a loaded inactive Python service and an enabled inactive
timer without changing the retained ambiguity record. The aggregate checks
also require both runtime directions, no ``daemon-reload`` in any restart
command, a changed boot ID for every reboot, no unrecorded completion, and
retained ambiguity after both restart and reboot. The previous matrix run
``20261110T185429Z-a5212c16`` from source commit
``b2748889a164d10677b6aa317d467152ccc7969d`` is preserved as historical
evidence; its guest script predates the post-boundary timer check, so it is
not the current bound proof. The base proof run
``20261110T180943Z-f3acc725``, the earlier historical run
``20261110T173225Z-de36ec18`` and the earlier retained run
``20261110T170322Z-9e8c5133`` remain on Pluto and are not rewritten.

The tick fixture timer keeps ``OnUnitInactiveSec=1s``; the repair fixture timer
uses ``OnUnitInactiveSec=5s``. Both use ``AccuracySec=1s``. The default
one-minute timer accuracy outlasted the completion bound in an earlier attempt,
so the fixtures bound it explicitly. Five seconds leaves a stable window in
which the repair timer is active while the oneshot service is still inactive,
so a switch snapshot can capture the active-timer release policy. The tick
fixture timer and its recorded evidence are unchanged. This is fixture
configuration, not a production template change.

### Drain/harvest proof status

The drain-alive, drain-ambiguous, drain-harvest and recover-drain-alive phases
are covered by the current base and matrix runs above. A run is evidence for
this slice only when the report's checks include
``runner_source_recorded``, ``drain_alive_refused``,
``drain_ambiguous_refused``, ``drain_harvest_proceeds`` and
``recovery_drain_refused``, and a second ``verify`` against the retained
report returns ``problems: []``. The host refuses to run when
``apps/crq-python`` has uncommitted changes, because the uploaded runner
source must be the exact implementation under test.

## Not proven

- No production adapter, allowlist change, production journal interop or
  legacy-resolution mechanism.
- No real Python or Node CRQ runtime completion; the fixture provider is fake.
- Ownership coverage is limited to runner state the runner actually records:
  a live pid with matching identity, an ambiguous record, or a completed
  record whose process is dead. A runner-owned process that escaped both the
  queue record and the journal is not represented and is explicitly
  uncovered; the drain cannot prove its absence.
- The refusal phases assert that the controller does not signal the seeded
  owned or unrelated processes; they do not prove that no signal could ever
  be sent, and they do not cover every possible detached-process topology.
- The drain is a point-in-time observation at the controller gate and again
  after the guest adapter's systemd fence. Work dispatched after an
  observation and before the journal advances is not excluded; no lock,
  atomic queue generation or dispatch barrier is claimed.
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
  run --source-commit "$commit" --mode activators
python3 apps/crq-python/ops/vm-unit-switch.py \
  --state-dir "$state" \
  --tools ~/crq-vm-feasibility/tools \
  verify "$state/runs/<run>/report.json"
```

Use ``run --mode base`` for the earlier preactivation-only proof. The matrix
requires the guest to reboot itself; run it only on a disposable guest.
``apps/crq-python`` must be committed at ``--source-commit``; the harness
uploads ``git archive HEAD apps/crq-python`` and refuses a dirty tree.

Run the named tests locally:

```sh
pnpm test:narrow apps/crq-python/test_unit_switch_adapter.py \
  apps/crq-python/test_unit_switch_cli.py \
  apps/crq-python/test_vm_unit_switch.py
```
