# TypeScript live backfill continuation

The live inventory and baseline routes do not establish backfill cutover readiness.
The systemd backfill unit invokes `backfill.py inventory`; the TypeScript route
is `runBackfillUnit` in `src/adapters/crq/backfillSource.ts`, with off-lock
preparation and a guarded merge in `src/ops/crq/internal/backfillTransaction.ts`.
The `baseline` route pins the existing ranked inventory under `tick.lock`.
Do not declare the broader backfill capability or activate a unit on that basis.

The TypeScript baseline deliberately differs from `backfill.py` in two safety
checks. It retains the content-addressed artifact before writing the baseline
pin, so a failed retention leaves no pin and can be retried. A successful put
followed by a failed pin can leave a harmless orphaned artifact. It also refuses
with exit 3 when the ranked `manifest_id` differs from the queue manifest `id`:
an interrupted inventory can otherwise mix ranked rows with older provenance.

## Next implementation seams

- Scheduler: port `select` in `apps/crq-python/backfill_runtime.py`, and the
  remaining transitions in
  `apps/crq-python/backfill_jobs.py`. The TypeScript
  `src/policy/crq/backfillJobs.ts` supplies enqueue, eligibility, admission,
  bind and pre-vendor cancellation as lossless pure queue transitions. It does
  not acquire a lock, save a queue, refresh usage, emit state events or launch.
  The caller must use the freshly loaded queue under `tick.lock`, compute the
  observation and ordinary-work priority as `rank4_gate` does, and durably save
  the reservation before any vendor spawn. An admission decision alone is not
  an authorization to launch.
  The injected `src/ops/crq/internal/backfillGate.ts` implements usage context and the
  rank-four gate, including event-before-queue-save sequencing. Its caller must
  hold `tick.lock` and provide real refresh, event and queue-save effects. These
  bindings, selection and launch are not wired, and the seam is not a live
  endpoint or activation. The non-launching selection seam in
  `src/ops/crq/internal/backfillSelection.ts` consumes injected validated
  coverage snapshots and a dry gate probe, returning a replacement queue and
  candidate index. An optional real gate can persist a reservation, with
  refusal continuation marking later jobs and reconciliation. The caller must
  hold `tick.lock`, flush pending refusal events first, persist returned state,
  and complete or recover every reserved candidate. Coverage refresh hints are
  written before a real reservation so hint failure cannot strand one. This
  differs from Python's post-launch best-effort hint ordering.
  `src/ops/crq/internal/backfillBinding.ts` binds a recorded reviewing run,
  spools its state event and saves, or reloads the durable queue and saves
  unknown ownership on bind failure. On any thrown launch, reload under the
  same lock, reconcile the exact item and attempt, and never retry the spawn or
  overwrite a durable run with the pre-launch queue. The caller still owns
  launch, live effects and exception recovery. The pure terminal transition is
  `src/policy/crq/backfillTerminal.ts`; counters and retry seconds are required
  to be integral, stricter than Python on malformed float state. The injected
  `src/ops/crq/internal/backfillRefusal.ts` reloads and validates the exact
  unbound attempt, then saves quarantine plus a replay marker before spooling
  the idempotent event and clearing the marker. Its caller must hold `tick.lock`
  and reload on failure. It requires positive pre-spawn evidence: a child exit,
  even exit 3 with `pre_vendor_refusal`, or an absent PID is not such proof and
  must never release the reservation. A binding identity-guard failure still
  conservatively retains unknown ownership. No seam is wired to a live executor.
  For the next slice, use
  `apps/crq-python/backfill_runtime.py` at main commit
  `0cb627ebf38dafb3089b2fe7eb4f1e153665f307`: `usage_context` reflects or
  expires terminal holds and subtracts unrepresented starts; `rank4_gate`
  refreshes stale observations, subtracts later ordinary starts, records the
  state event and daily capacity, then saves the queue before launch. Preserve
  that ordering and retry behavior rather than treating this pure policy as a
  live reservation endpoint.
  Selection must consume fresh coverage snapshots, preserve ordinary-work
  priority and reserve quota durably before vendor launch. Coordinate the
  exported seam with the worker integrating `src/queue-runner/tick.ts` and
  `src/adapters/crq/tickSource.ts` rather than independently changing that glue.
- Harvest: `src/ops/crq/internal/backfillHarvest.ts` and
  `src/adapters/crq/backfillHarvestArtifacts.ts` provide an unwired, bounded
  failure-only seam. The caller must hold `tick.lock`, load the fresh durable
  queue, and independently prove terminal liveness for the exact run and exit.
  Artifact existence or an ambiguous PID is not proof. The seam verifies the
  bound item, attempt and run, retains raw review and exit bytes, emits the
  state event, saves terminal state and capacity plus attempt history, then
  cleans up. Reload durable state after any error and never relaunch blindly.
  Unlike Python, counted completions and all quota or mixed quota outcomes are
  deliberately unhandled without retention or mutation, and attempt history is
  saved atomically with the terminal state. The reader assumes the state tree
  is not concurrently altered by an adversary during path resolution. Port the
  remaining `completion_event` and `harvest` paths in
  `apps/crq-python/backfill_runtime.py` and their call site in
  `apps/crq-python/crq.py`: counted git and scope verification, outbox,
  finding ingestion, publication and Q49 quota handling remain missing.
- History: port `collect_history_unlocked` and the `import-history` branch in
  `apps/crq-python/backfill.py`, together with `backfill_history.py`. Collection
  uses an output-specific persistent flock and snapshots the queue separately.
- Findings: port `Inbox.triage` and `Inbox.deliver` from
  `apps/crq-python/finding_delivery.py`, including their `backfill.py` service
  wiring, retained events, repair transport and flock boundaries. The existing
  `src/policy/crq/findingDelivery.ts` covers only finding identity and recovery
  transitions, not these commands.
- Operator recovery: `release`, `quarantine-release`, and
  `reconcile-no-launch` also remain unavailable in the live route. Follow the
  evidence binding and state-event order in `backfill.py` and `backfill_jobs.py`.

`src/adapters/crq/backfillAccounting.ts` has cache primitives, but the live
inventory adapter constructs its accounting repository without a disk cache.
`src/adapters/crq/backfillQueueLoad.ts` performs a read-only compaction preview,
not persistence of a compacted queue. These are residual performance and
compaction gaps, not grounds to trust stale evidence or weaken transaction guards.
Exercise future changes with local fixtures only, preserve unknown fields and
lossless JSON, and use the focused-check contract rather than a local full suite.
