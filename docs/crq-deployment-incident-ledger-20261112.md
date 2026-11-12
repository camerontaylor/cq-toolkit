# CRQ deployment incident ledger — 2026-11-12

Operational record from the 2026-11-12 ceres CRQ runner target change
(frozen-c6 attempt and D41 restore). Recorded here because the same classes of
failure mode are relevant to this toolkit's runner docs; this page contains
outcomes and evidence locations only, no private state paths beyond the
desk-continuation directory referenced below.

## Timeline (UTC, 2026-11-12)

| Time      | Event                                                                                                                                                                                                                                                                                                           |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| pre-03:15 | Frozen-c6 preflight completed read-only: wrapper, dist tree, candidate config, signer schema and tag all verified against the recorded digests                                                                                                                                                                  |
| 03:15:22  | c6 deploy wrapper launched on a genuine quiet poll                                                                                                                                                                                                                                                              |
| 03:18:28  | Wrapper failed rc=1 at its fixed 180 s drain timeout: a repair pass had started 10 s before the disable marker and ignores it, so the drain never completed. Fail-stop engaged: phase `recovery_required`, marker owned, nine triggers stopped, no switch (HEAD/config/SDK unchanged, zero controller journals) |
| 04:25:05  | Restore script (independently reviewed, 53-check harness, no P1/P2 findings) executed, exit 0: marker removed, nine triggers restored, exact pre-switch D41 state                                                                                                                                               |
| 04:37:59  | HEALTHY receipt accepted: two advancing ticks, publication delta 11→0, zero new errors                                                                                                                                                                                                                          |

## Corrected operational facts worth keeping

- The nine systemd triggers split 6 active / 3 inactive; a wrapper's internal
  `.service` list (7 units) is not the trigger count.
- A fixed drain bound with no extension is the right default: exceeding it
  must abort via fail-stop, not widen.
- Restore-after-failure must be phase-gated: on a pre-hold failure restore the
  original states; once held/draining or past controller handoff, fail-stop
  governance applies instead.
- Post-recovery tick success is a heuristic. Path-activated units can start at
  any time; do not treat it as a quiet-window guarantee.
- `runner-disabled` markers only help if every long-running drain participant
  checks them before and during their pass.

## Pending follow-up

The #1560 concurrency option (`repair.max_concurrent_items`, 1..10, default 1,
fork-based isolation) is merged; the retain-frozen-c6 versus supersede-with-
a221 decision belongs to the owner and is tracked outside this page.
