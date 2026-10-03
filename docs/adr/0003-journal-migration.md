# ADR-0003 annex — Journal v2 schema and replay rules

Status: **accepted** (owner G1 sign-off, 2026-09-26; drafted as proposed, revision r1; part of ADR-0003).

- Critic round 1 dispositions: `adr-0003-r1-dispositions.md` (private `toolkit-research` repository, not published here) (M2, M3, m4, m5, m6, m8 touch this annex).
- Anchors (cq-toolkit `5e52707`): `src/kernel/types.ts:167-221`, `src/kernel/schema.ts:348-420`,
  `src/kernel/journal.ts`, `src/kernel/runner.ts:412-451,557-584`.

## 1. Baseline (journal v1, frozen by T1.1)

- There are four events: `run-started`, `job-started`, `job-finished`, `run-finished`. Every zod mirror is
  `.strict()`.
- `job-finished.usage?` exists in the type, but the runner never writes it (J1 C2).
- `job-started.attempt` is always `1`.
- Appends are buffered with no fsync (`journal.ts:120-127`).
- Read policy: every complete line must validate; only an unterminated last line may be dropped.
- There is no version marker. Fold order is `run-started.at` (`runner.ts:444`).

## 2. v2 schema

All v1 events are unchanged except for **optional** additions. New event types are added to the discriminated
union. The mirrors stay `.strict()`.

```ts
// additions to existing events
RunStartedJournalEvent   += { journalVersion?: 2;                 // absent ⇒ v1
                              seq?: number;                       // v2: 1 + max(prior seq) for this plan, assigned
                                                                  //     UNDER the plan lock; the fold orders on it (§3)
                              governance?: {                      // present iff the run is governed
                                capUsd?: number; capTokens?: number;
                                attended: boolean; allowAdvisory: boolean;
                                legacyJournal?: { mode: 'reset'; v1RunIds: string[] };  // sticky (§4)
                                raiseCap?: { from: number; to: number };                 // present iff opted in (§3 rule 6)
                                config?: ResolvedConfigRecord;    // P7 provenance; shape owned by RS-15 / W3.6
                              };
                              ungoverned?: { optIn: true } }      // present iff budget.ungovernedOverGoverned (ADR §2.5)
JobStartedJournalEvent   : attempt is now real (1 + prior job-started for jobId across folded runs)
JobFinishedJournalEvent  += { usage?: Usage;                      // r1 (m8): Σ reservation-settled.usage for this attempt,
                                                                  //   ABSENT (not zero) if any of its reservations settled
                                                                  //   with basis 'full' or was abandoned (unknown, DD-9)
                              costUSD?: number;                   // modeled, Σ settled costUSD, same absence rule
                              charged?: { usd?: number; tokens?: number } } // Σ charged (always present when governed)
RunFinishedJournalEvent  : earlyStopReason ∈ 'budget' | 'signal' | 'stalled' | 'deferred' | 'lock-lost' | 'provider'

// new events (all carry runId + at)
ReservationOpened   { type:'reservation-opened'; jobId; attempt; invocationId; lane: LaneId; provider; model;
                      aliases?: string[];                          // the served-model alias set priced (ADR §2.2 step 1)
                      class:'hard'|'advisory'; usd?; tokens?; innerCapUsd?; overshootUsd;
                      sizedUp?: true }                             // r = floor > proposal (ADR §2.2 step 3)
                                                                   // FDATASYNC, then fence, then dispatch
ReservationSettled  { type:'reservation-settled'; invocationId; stopReason: DriverStopReason;
                      errorClass?: WorkerErrorClass;               // G1 reconciliation: the structured class channel
                      providerSignals?: ProviderSignals;           //   (ADR-0002 §2.2/§2.7; read by rescue rows + W2.6)
                      usage: Usage; costUSD?; chargedUsd?; chargedTokens?;
                      basis: 'reported'|'observed+w'|'full'|'released';
                      failedAttempts?: number;                     // in-process abort path: the W_step × (1 + failedAttempts) term (ADR §2.2 step 8)
                      failedAttemptsObserved?: number;             // CLI lanes, reported path: api_retry frames charged W_max(main) each (ADR §2.2 step 8)
                      breach?: true; seamViolation?: true }        // FDATASYNC
ReservationRefused  { type:'reservation-refused'; jobId; attempt; invocationId;
                      reason:'advisory-lane'|'advisory-dimension'|'cap-below-concurrency-floor'|
                             'exhausted'|'tripped'|'stalled'|'provider'; detail? }
ReservationAbandoned{ type:'reservation-abandoned'; invocationId; chargedUsd?; chargedTokens? }
BudgetTripped       { type:'budget-tripped'; kind:'exhausted'|'breach'|'token-cap'|'signal'|'lock-lost'|'provider'; detail }
AdmissionDeferred   { type:'admission-deferred'; jobId?; provider; untilMs; reason }
JobQuarantined      { type:'job-quarantined'; jobId; invocationIds: string[]; reason:'unresolved-reservation'|'abandoned' }
QuarantineReleased  { type:'quarantine-released'; jobId; provenance:'call' }
ApprovalConsumed    { type:'approval-consumed'; jobId; attempt; nonce; kid; subjectHash; workspace: string;
                      children?: Array<{ op: string; subjectHash: string }> }   // FDATASYNC, at exercise (token annex §4)
```

**Durability.**

- `append(event, {durable: true})` writes with the `a` flag, then calls `fdatasync`. It is used for
  `reservation-opened`, `reservation-settled`, `reservation-abandoned`, `approval-consumed` and `job-finished`.
- The journal directory is fsync'd when a run file is created.
- The serialized write chain (`journal.ts:107,125-127`) is kept.
- macOS `F_FULLFSYNC` is a recorded power-loss residual. Process-crash durability does not depend on it.

**Invariants the reader checks** (a violation is corruption, which throws).

- An `invocationId` is opened at most once per file. It is settled or abandoned at most once, only after it was
  opened in **the same file**.
  - r1 (M3): no writer ever produces a settle without an open. Ungoverned runs write **no** reservation events.
- `reservation-*` events appear only in files whose `run-started.journalVersion === 2` and which have no
  `ungoverned` marker.
- No event follows `run-finished`.
- Within a plan's files, `seq` values are unique. A v2 file without `seq` is corrupt. Uniqueness holds by
  construction: `seq = n` is claimed by exclusive create of `<journalDir>/<planId>.seq.<n>` (G1 reconciliation,
  critic r2 m-b), so racing stealers cannot both write `n`.
- A torn last line that would have been a `reservation-opened` is dropped. Its fsync never returned, so the fence
  and dispatch never happened.

## 3. Replay and seed rules (v2 reader)

**Fold order (r1, m4).**

- v2 runs are ordered by `seq`. v1 runs have no `seq`; they are ordered by `at` (then runId) and all precede
  every v2 run.
- The injected clock can no longer reorder the fold. `at` is display-only for v2 runs.
- `seq` is claimed by exclusive create (`<planId>.seq.<n>`, `'wx'`, retry `n + 1` on `EEXIST`), under the plan
  lock (ADR §2.5, §2.8). r1 said the lock alone made two equal values impossible; two racing dead-holder
  stealers could each fold before the other's `run-started` landed (critic r2 m-b), so the claim file is what
  guarantees it.

1. **Job replay-skip.** This is the v1 rule verbatim: the per-job last `job-finished` wins, and a skip requires
   `ok` + the same `opId` + the same `inputsHash`. Re-attestation copies `usage`, `costUSD` and `charged`.
2. **Attempts.** `attempt(job) = 1 + |job-started(jobId)|` over the folded runs.
3. **Ledger seed.**
   - `S = Σ chargedUsd(settled) + Σ chargedUsd(abandoned) + Σ usd(opened ∧ ¬settled ∧ ¬abandoned)`, per
     dimension.
   - `O = 0` at start.
   - Charges are counted from reservation events only, never from `job-finished`, so chained resumes can't
     double-count.
   - An unresolved `reservation-opened` whose process lost its fence (ADR §2.2 step 6) is folded identically:
     charged `r`. It over-charges, and that is conservative.
4. **Quarantine.**
   - A job with any unresolved or abandoned reservation is quarantined unless a later `quarantine-released`
     exists.
   - "Later" means **fold position** (`seq`, then line order), never a timestamp.
   - Quarantine overrides replay-skip only when the quarantining reservation is later than the job's last `ok`
     finish. Since every run over governed history is governed, or opted-in and quarantine-honouring, an `ok`
     finish after a quarantining reservation requires an explicit release.
5. **Approvals.** Nonces in `approval-consumed` across folded runs are spent. This is in addition to the operator
   ledger (token annex §5).
6. **Cap on resume (r1, m5).**
   - `C_now ≤ C_prev` (the latest governed run's `capUsd`): allowed, and journalled.
   - `C_now > C_prev`: **throws** `runPlan: cap raised from <prev> to <now>` unless `optIn: budget.raiseCap`. The
     opt-in is journalled as `governance.raiseCap`.
   - DoD 2's bound is stated against `C_max` over the plan's governed runs (ADR §2.3).
   - If `S > C − floor` for every class the plan can use, the run trips `exhausted` before admitting anything.
     This preserves the v1 "seed trips before admission" behaviour (`governor.ts:1092-1110`).
7. **Ungoverned-marked runs** (`run-started.ungoverned`).
   - They contribute rules 1, 2 and 4 (skips, attempts, quarantine re-attestations) and **nothing** to `S`.
   - A later governed run emits `cq: bound excludes ungoverned runs <runIds>`.

## 4. Replaying old (v1) journals

| Situation                                                                                     | Behaviour                                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Ungoverned** run, plan history v1-only                                                      | Works unchanged: rule 1 only. It takes the plan lock when `journalDir` is set                                                                                                                                                                           |
| **Ungoverned** run, plan history contains any governed v2 run                                 | **Refused** (`runPlan: plan <id> has governed history; run governed or pass --opt-in budget.ungovernedOverGoverned`). With the opt-in: it takes the lock, honours quarantine, writes no reservation events, and marks `run-started.ungoverned` (rule 7) |
| **Governed**, v1 files that contain **no** `job-started` events                               | Works. There is no unaccounted dispatch                                                                                                                                                                                                                 |
| **Governed**, v1 files containing dispatches (any `job-started`) not covered by a prior reset | **Refused** before any state is written: `runPlan: governed resume over v1 journals with unaccounted dispatches (<n> jobs in <runIds>); v1 journals carry no spend. Pass --opt-in budget.legacyJournal=reset.`                                          |
| Opt-in `legacyJournal=reset`                                                                  | Those v1 dispatches are charged 0. `governance.legacyJournal = {mode:'reset', v1RunIds:[…]}` records exactly which v1 runs the bound excludes                                                                                                           |
| **Later** governed resume after a reset (r1, m6)                                              | The refusal checks only v1 runs **not** listed in any prior `governance.legacyJournal.v1RunIds`. The reset is sticky for the files it named, and a newly appearing v1 file (an operator copy) still refuses                                             |
| A mixed dir (v1 runs, then v2 runs)                                                           | Each file is folded by its own version. v1 runs precede v2 runs in fold order                                                                                                                                                                           |
| **An old binary reading a v2 file**                                                           | The v1 strict reader throws `corrupt line` on `run-started` itself (`journalVersion` is rejected by `.strict()`). It **fails closed**                                                                                                                   |

Why v1 dispatches refuse rather than estimate: any estimate would be fabricated (DD-2/DD-9). A refusal plus an
explicit, journalled, sticky reset is the P8 shape.

## 5. Fixtures and evidence

- Old fixtures snapshots are not converted (V11PLAN §1 non-goals).
- A golden test replays a verbatim v1 journal from the current corpus.
- **A12b:** truncate after the durable `reservation-opened` (and a driver-side charge) but before
  `reservation-settled` → the resume seeds `S += r`, quarantines the job, and does not dispatch it.
- **Lock variants** (ADR §2.5):
  - SIGSTOP holder, then more than `somaxconn` probes → a second process is refused;
  - two contenders with different `TMPDIR`, and one with none → exactly one holds (the record in the journal dir
    is the rendezvous);
  - SIGKILL holder → a second process acquires, folds the unresolved reservations as `r`, and assigns
    `seq = prev + 1`;
  - racing stealers → exactly one passes the fence, and every `run-started.seq` in the plan is unique.
- **Fold order:** two runs whose `at` values are reversed by a fake clock still fold in `seq` order.
- **Sticky reset:** reset once, resume twice → no second refusal. Add a new v1 file → refused.
