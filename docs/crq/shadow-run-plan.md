# CRQ tick and slot shadow-run plan (not activated)

Status: plan only. Nothing in this document is wired to a schedule, a service
or a runtime entry point. It depends on the orchestrators (`tickOrchestrator.ts`,
`slotOrchestrator.ts`) and their adapter PRs landing first.

## Goal

Show, on the queue host, that the TypeScript tick and slot produce the same
decisions as the Python runner for the same inputs, with zero writes to live
state, before any cutover is proposed.

## Method

1. **Frozen input.** Copy the live state root (`queue.json`, `config.json`,
   `runner-disabled` marker presence) to a scratch directory on the queue host
   with `cp -a`, read-only on the source. The copy is the only thing either
   implementation touches.
2. **Two runs, one input.** Run the Python tick/slot against copy A and the TS
   `runTick`/`runScheduledSlot` against copy B (identical bytes), with the clock
   pinned to one instant (`now` injected in TS; `CRQ_NOW` or a faketime wrapper
   for Python).
3. **Heavy phases stubbed identically.** Forge, vendor and git calls are
   replaced by one recorded-response fixture set replayed to both sides. No
   network, no `gh`, no vendor invocation, no `notifyOwner`.
4. **Compare artefacts**, not logs:
   - final `queue.json` via `ledgerValueEqual` (key order ignored, `1 == 1.0`);
   - `events.jsonl` line sequence, comparing `at` after normalising the pinned
     clock;
   - `heartbeat.json` bytes;
   - the ordered list of phase calls and the slot lock/early-exit decision
     (`SLOT_RUNNER_DISABLED_LOG`, `SLOT_QUEUE_CHANGED_LOG`).
5. **Report.** One JSON diff per sample, written to a scratch directory; a
   summary count of identical, explained-divergence and unexplained samples.

## Safety (read-only guarantees)

- The harness never opens the live state root for writing and never takes
  `tick.lock` or the slot lock on it.
- Scratch copies live under a fresh directory removed with `trash` afterwards.
- Both sides run with `HOME` and `XDG_STATE_HOME` pointed into the scratch tree,
  so the heartbeat and event writes cannot reach live paths.
- A pre-flight asserts the live `queue.json` sha256 is unchanged after the run;
  any change aborts the sample and is reported.

## Samples

Capture on a schedule chosen by the owner, not by this plan: a rolling set of
queue snapshots covering idle, runner-disabled, backfill-pending, quota
cooldown and mid-slot states. Minimum before any cutover proposal: the owner's
chosen count, with zero unexplained divergences.

## Known explained divergences to seed the allow-list

- `loadQueue(persist)` refuses a queue needing compaction migration (TS) where
  Python migrates in place.
- Backfill counted completion refuses unexpected provenance shapes more strictly
  (see the vendor-output and completion PR bodies).

## Not in this plan

Activation, scheduling, a cutover switch, write-mode comparison, and any
required check or approval step.
