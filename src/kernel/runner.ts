// Plan runner — T1.2 slice 2 (R2 §5): a deterministic plan interpreter over a
// committed run manifest (manifest.ts) plus journal-replay resume (journal.ts),
// executed through a p-limit pool.
//
// What this is NOT: no daemon, no workflow engine, and no rescue/escalation
// policy — recovery is not an op here. Resume is the SAME loop re-entered with
// `resume: true`, and rescue decisions belong to T1.3's governor. The runner
// never calls drivers; it invokes ops only through the frozen Op contract.
//
// Flow (every step evented, in order — run-started, per job job-started +
// job-finished, run-finished last):
//   1. runId = `<plan.id>--<timestamp-base36>--<random>`; the filename-safety
//      assert (journal.assertSafeRunId) applies ONLY when journaling — a
//      journaled run requires a filesystem-safe plan id (the plan id is the
//      runId prefix and resume key), while in-memory runs accept any
//      schema-valid plan id.
//   2. makeManifest(plan) — succeeds even for unknown op names; the manifest
//      is op-agnostic. An unknown op fails THAT JOB at execution time.
//   3. Pre-pass: jobs with a missing dependency (or transitively blocked ones)
//      are marked blocked and never scheduled — honest, not a crash.
//   4. topoOrder waves over the schedulable remainder; a cycle throws (an
//      unschedulable plan is plan corruption). Waves run in order through one
//      p-limit pool with EXACTLY opts.concurrency (the one integer knob).
//      Trade-off, named: wave barriers buy deterministic order at a
//      throughput cost — a slow job delays the next wave even when other
//      jobs' dependencies are already ready.
//   5. A job is ready iff all dependsOn ended `ok`. Any dep not ok (failed,
//      blocked, …) → the job is blocked and NOT executed.
//   6. stopOnError: after the first non-ok RESULT, no further job is STARTED;
//      in-flight jobs complete and are recorded (tasks re-check the flag when
//      p-limit actually starts them). Jobs never started are classified in a
//      final sweep (see counts policy below).
//
// Replay (opts.resume === true — which REQUIRES journalDir; requesting resume
// without one throws before a runId exists or anything is journaled): fold
// EVERY prior run of this plan in the dir, in THE FOLD ORDER
// (journal.foldOrderRuns — v1 runs by run-started `at`, ties by runId, ALL
// before every v2 run; v2 runs by `seq`, so a fake/injected clock can no
// longer reorder the fold), with per-job LAST-FINISH-WINS. Candidate
// pre-filter: only files whose runId carries this plan's exact `<planId>--`
// prefix AND whose remainder is the exact two-segment runId tail
// (`<base36>--<hex>` — so plan 'a' does not match plan 'a--b''s files) are
// even PARSED (a corrupt journal of ANOTHER plan cannot block this plan's
// resume), and the run-started event's planId is the exact semantic matcher
// (the frozen RunStartedJournalEvent DOES carry planId). Folding ALL runs —
// not just the latest — is the resume-safety point: a later PARTIAL run
// (crash mid-run) contributes no finishes of its own, so it cannot erase
// older runs' completed jobs (which would re-execute non-idempotent ops); a
// later failed re-attempt does override an older ok, per-job last finish
// wins. A job whose latest prior job-finished has result `ok` AND
// opId === job.op AND inputsHash === the manifest hash is SKIPPED: zero op
// invocation, its JobOutcome reconstructed from that journal event.
// Everything else re-runs — continue-from-first-failure emerges naturally.
// Skipped jobs are RE-ATTESTED in the new run with a job-finished event (no
// job-started — no dispatch happened), copying
// opId/inputsHash/result/usage/costUSD after hash verification: each run's
// journal is then self-contained, so the
// fold rule survives chained resumes.
//
// Governed mode (the 4th `gov` param — ADR-0003 §2, W2.2): with a
// `Governance` handle the runner itself IS the governed composition. Per
// dispatch it ADMITS through the governor keyed on the real plan job id, runs
// the op through the escalation ladder inside the job context (an external
// `gov.signal` is composed into the ladder's controller), folds spend
// evidence — the transitional `reportResult` channel plus the completion-time
// WorkerResult fold — into the per-run ledger and into per-job sums, and owns
// the honest stop (I9): a budget-family trip (USD/token/unpriced, or a
// per-run dispatch-quota refusal) re-marks the rows that never dispatched
// budget-exhausted — transitively, but NEVER past a genuinely-failed
// dependency — and claims stoppedEarly/earlyStopReason 'budget'; a
// `signal`-kind trip claims 'signal' and leaves undispatched rows queued (a
// cancel is not a budget verdict). The governed run always folds the dir's
// history for LEDGER continuity (attempts, spend, cap checks) even without
// resume:true — only the replay-skip map is resume-gated — and seeds the
// governor from it.
//
// Governed refusals (thrown BEFORE anything is emitted or claimed; the CLI
// maps on the 'runPlan: ' prefix):
//   - an ungoverned run over governed history (run governed or opt in with
//     `budget.ungovernedOverGoverned`);
//   - the marker itself on a plan with NO governed history — the opt-in names
//     that one condition, and honouring it history-less would strand the
//     run's spend outside every future ledger (drop the opt-in, run
//     governed);
//   - a governed run over v1 journals with unaccounted dispatches — v1
//     journals carry no spend, so the cap could not bind what already ran
//     (opt in with `budget.legacyJournal=reset`; the reset is recorded on the
//     run's governance block and is STICKY for the named runs);
//   - a cap RAISE over the last governed run's capUsd without
//     `budget.raiseCap` (the honoured raise is recorded as raiseCap
//     from→to).
// A `{ governor: undefined }` handle is refused at the top, beside the caps
// guard (`runPlan: governance requires a governor`).
// `budget.ungovernedOverGoverned` instead marks THIS run UNGOVERNED (the
// `ungoverned` marker on its v2 run-started): ops execute exactly as the
// ungoverned path, with no admission, no spend observation, and no caps; it
// sits outside the spend ledger by explicit opt-in.
//
// Governed journal (v2): run-started carries journalVersion 2, a `seq`
// claimed by exclusive create (journal.claimSeq, BEFORE the event is
// emitted) and the governance record (caps, attendance, honoured opt-ins).
// Governed job-started events carry the admission's real attempt ordinal;
// job-finished events carry the per-job usage/costUSD sums the evidence
// folds observed. A governed run WITHOUT a journalDir journals nothing
// (in-memory run): no seq is claimed and no v2 fields exist.
//
// Journal-less mode (no journalDir): emit becomes a no-op sink. The same
// event SEQUENCE is produced through the same emit call sites, but nothing
// is buffered — no caller or test consumes an in-memory list, and the
// journaled file is the record when persistence is on. Fold semantics are
// mode-independent: journal.deriveJobStatuses over a journaled run's file
// yields the same derived states the runner computed.
//
// Counts policy (frozen RunCounts — all six states, zeros included):
//   - executed/skipped jobs map by result: ok→done, failed→failed,
//     budget-exhausted→budget-exhausted; needs-human→blocked (waiting on a
//     human — 'blocked' is the closest "waiting" state; FRICTION: JobState has
//     no needs-human value); indeterminate→failed (attention needed;
//     FRICTION: no faithful state — resume re-runs these either way).
//   - jobs never started (stopOnError, or a governed trip that stopped
//     dispatch): blocked when some dependency definitively did not succeed
//     (transitively) — even when a sibling dependency is merely queued (a
//     definitively failed dep means the job can never run) — otherwise
//     queued ("not yet dispatched" — exactly true for them). Under a
//     budget-family stop the queued/blocked rows whose non-execution is
//     transitively budget-caused are RE-MARKED budget-exhausted (the runner
//     knows which jobs it admitted — no marker sniffing); running is always
//     0 in a returned report (everything awaited).
//   - never-run rows still appear in jobs[] (the frozen JobOutcome doc says
//     one row per job in the plan): blocked rows carry
//     {status:'failed', error:'blocked: …'} and queued rows
//     {status:'indeterminate', detail:'queued: …'} — the least-dishonest
//     taxonomy values for "did not run" (budget-re-marked rows become
//     {status:'budget-exhausted'}).
//
// Row order is deterministic: dispatch order (topo wave order, in-wave
// manifest order; replay-skipped jobs keep their slot), unschedulable
// (missing-dep) jobs last in manifest order.
//
// opts.maxUsd/maxTokens REQUIRE governance: without a Governance handle
// there is no admission gate and no spend observation, so the caps would be
// silently unenforceable — the guard below throws before anything runs
// (USD stays derived; the governor owns enforcement for BOTH caps and the
// honest stop).
import pLimit from 'p-limit';
import { randomBytes } from 'node:crypto';
import {
  acquirePlanLock,
  assertNoSeqGap,
  assertSafeRunId,
  candidateRunsForPlan,
  foldOrderRuns,
  openRunLog,
  claimSeq,
  type FoldRun,
  type RunLog,
} from './journal.js';
import {
  runLadder,
  validSpendEvidence,
  workerResultOfValue,
  type BudgetReservation,
  type Governance,
  type LadderOutcome,
} from './governor.js';
import { classifyDispatch } from './lanes.js';
import { makeManifest, topoOrder, type ManifestJob } from './manifest.js';
import { OpResultSchema } from './schema.js';
import type { Usage } from '../driver/types.js';
import type {
  JobFinishedJournalEvent,
  JobOutcome,
  JobState,
  JournalEvent,
  Op,
  OpRegistryEntry,
  OpResult,
  Plan,
  RunCounts,
  RunEarlyStopReason,
  RunOptions,
  RunReport,
  RunStartedJournalEvent,
} from './types.js';

/**
 * Read-only op-registry seam, dependency-injected (frozen RunOptions cannot
 * carry it). The return type is `OpRegistryEntry<never, never>` — the bottom
 * instantiation of the op-contract parameters — which keeps the view
 * CO-VARIANT-FRIENDLY for callers: an implementation backed by a
 * `Map<string, OpRegistryEntry<any, any>>` satisfies this interface, because
 * `any`-instantiated type arguments are assignable to `never`. (Hold an
 * `any`- or `never`-instantiated map; an `unknown`-instantiated one will NOT
 * assign — unknown does not widen down to never.)
 */
export interface OpRegistryView {
  get(name: string): OpRegistryEntry<never, never> | undefined;
}

/** Why a job's outcome entered the report without a fresh dispatch this run. */
type EntryOrigin = 'executed' | 'replayed' | 'blocked' | 'queued' | 'quarantined';

interface OutcomeEntry {
  result: OpResult<unknown>;
  state: JobState;
  /** Per-job usage rollup — replay-sourced, or the governed evidence sums. */
  usage?: Usage;
  /** Per-job modeled USD rollup (governed evidence sums; replay copies it too). */
  costUSD?: number;
  origin: EntryOrigin;
}

/** Error message of an unknown throwable, for `failed` results. */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Σ of the frozen Usage fields — the DD-9 token rollup (`reasoning` is an
 * `output` breakdown already included in it, never added on top). Identical
 * to the governor's private fold; kept local so the runner's once-only
 * evidence flags mark exactly what the governor will fold.
 */
function usageTokens(usage: Usage): number {
  return usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

/** Sum two Usage rollups (the governed per-job evidence sums). */
function addUsage(a: Usage, b: Usage): Usage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    ...(a.reasoning !== undefined || b.reasoning !== undefined
      ? { reasoning: (a.reasoning ?? 0) + (b.reasoning ?? 0) }
      : {}),
  };
}

/**
 * JSON-LOSSLESSNESS check for op results (the journal line is a JSON.stringify
 * of the result; replay reconstructs from that line). stringify-throwing
 * values (BigInt, circular) are caught by the stringify probe; this walk
 * catches the SILENTLY lossy ones — Map/Set/Date/RegExp/class instances
 * stringify as `{}` or strings, function members, symbol-keyed or non-enumerable (hidden) members vanish, undefined
 * array elements become null — where the journal would otherwise disagree
 * with the value the run produced. One normalization is accepted, matching
 * JSON semantics: an undefined-valued member of a nested object IS absent
 * data ({a: undefined} and {} are the same JSON record) — required-field
 * positions (the ok variant's `value`) are guarded by the caller.
 * Plain objects: prototype null or Object.prototype only.
 * Requires cycle-freedom — call only after the stringify probe passed.
 */
function assertJsonLossless(value: unknown): void {
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return;
    case 'number':
      if (!Number.isFinite(value)) throw new Error(`non-finite number ${String(value)}`);
      return;
    case 'object': {
      if (value === null) return;
      if (Array.isArray(value)) {
        // Arrays carry ONLY their indexed elements and `length`: any other
        // own key — a symbol, a hidden non-enumerable toJSON, an enumerable
        // `extra` property — is dropped by JSON.stringify exactly like the
        // object-side cases (PR #103 review, Codex P1; this branch returned
        // before the Reflect.ownKeys loop below, leaving arrays unvalidated).
        for (const key of Reflect.ownKeys(value)) {
          if (key === 'length') continue;
          if (typeof key === 'symbol') {
            throw new Error(
              `symbol-keyed own member '${key.toString()}' — JSON.stringify drops it`,
            );
          }
          const index = Number(key);
          // A real array index is 0..2^32-2 (PR #114 review, CodeRabbit
          // Major + Codex P2): "4294967295" is a plain property — length
          // never grows, JSON.stringify drops it — so it must NOT pass as
          // an index here.
          if (
            Number.isInteger(index) &&
            index >= 0 &&
            index <= 2 ** 32 - 2 &&
            String(index) === key
          ) {
            continue;
          }
          throw new Error(
            key === 'toJSON'
              ? "own 'toJSON' on an array — JSON.stringify invokes the hook, so the serialized shape diverges from the walked one"
              : `non-index own member '${key}' on an array — JSON.stringify drops it`,
          );
        }
        for (let i = 0; i < value.length; i++) {
          const element: unknown = value[i];
          if (element === undefined) throw new Error(`undefined array element at [${i}]`);
          assertJsonLossless(element);
        }
        return;
      }
      const proto = Object.getPrototypeOf(value) as object | null;
      if (proto !== Object.prototype && proto !== null) {
        const name = (value as object).constructor?.name ?? 'unknown';
        throw new Error(`non-plain object of type '${name}'`);
      }
      // ALL own keys, not just the enumerable string-keyed ones (PR #31
      // review, Codex P1 + review-debt #76): a SYMBOL-keyed member is
      // dropped by JSON.stringify, so the journal would reconstruct less
      // than the walk accepted; a NON-ENUMERABLE own member is the worse
      // divergence when it is a hidden `toJSON` hook — Object.values
      // skips it while stringify INVOKES it, so the journal would
      // reconstruct the hook's output instead of the walked shape (and
      // any non-enumerable member is data invisible to the serialization
      // either way). An ENUMERABLE own toJSON needs no special case: the
      // member walk below reaches it as a function value and throws.
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key === 'symbol') {
          throw new Error(`symbol-keyed own member '${key.toString()}' — JSON.stringify drops it`);
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor !== undefined && !descriptor.enumerable) {
          throw new Error(
            key === 'toJSON'
              ? "non-enumerable own 'toJSON' — JSON.stringify invokes the hidden hook, so the journal would reconstruct its output instead of the walked shape"
              : `non-enumerable own member '${key}' — invisible to JSON.stringify`,
          );
        }
      }
      for (const memberValue of Object.values(value)) {
        if (memberValue === undefined) continue; // absent-key semantics
        assertJsonLossless(memberValue);
      }
      return;
    }
    case 'bigint':
    case 'function':
    case 'symbol':
    case 'undefined':
    default:
      throw new Error(`non-JSON value of type '${typeof value}'`);
  }
}

/** ISO-8601 timestamp for journal events. */
const now = (): string => new Date().toISOString();

/**
 * `<planId>--<timestamp-base36>--<random>`. The filename-safety assert is
 * conditional: journaled runIds become file names (`<runId>.ndjson`) and
 * resume keys, so they stay asserted; in-memory runs accept any schema-valid
 * plan id.
 */
function makeRunId(planId: string, requireFileSafe: boolean): string {
  const runId = `${planId}--${Date.now().toString(36)}--${randomBytes(4).toString('hex')}`;
  if (requireFileSafe) assertSafeRunId(runId);
  return runId;
}

/** All-six-states counts table, zeros included. */
function emptyCounts(): RunCounts {
  return { queued: 0, running: 0, blocked: 0, done: 0, failed: 0, 'budget-exhausted': 0 };
}

/**
 * Result.status → report JobState for jobs that reached a terminal outcome
 * this run (executed or replayed). needs-human/indeterminate have no faithful
 * frozen state — see the counts policy in the header.
 */
function stateFromResult(result: OpResult<unknown>): JobState {
  switch (result.status) {
    case 'ok':
      return 'done';
    case 'failed':
      return 'failed';
    case 'budget-exhausted':
      return 'budget-exhausted';
    case 'needs-human':
      return 'blocked';
    case 'indeterminate':
      return 'failed';
  }
}

/**
 * The ONLY op invocation path (frozen Op contract): `inputSchema.parseAsync`,
 * then the lazily imported op. Every failure mode — a throwing registry
 * lookup, a missing registry entry, schema violation, a throwing op or
 * importer, a contract-violating return, a non-serializable return — becomes
 * an honest `failed` OpResult. Ordinary op errors never throw, so a bad op
 * (or registry) cannot corrupt the journal or kill the run. The private
 * infrastructure guard rejects to the run's shared failure authority.
 *
 * `onDispatchUnknown` marks every post-invocation failure the returned
 * verdict cannot carry: the op BODY rejecting, or a body that RESOLVED to
 * something that is not an `OpResult` at all. Both happened AFTER the
 * dispatch was entered, so spend may exist that no evidence fold will ever
 * see. executeOp turns each into a `failed` result, so without this signal
 * the caller settles the reservation `observed` and charges zero. The
 * pre-dispatch failures below it — a throwing registry lookup, an unknown
 * op, a schema violation, a throwing importer — provably spent nothing and
 * deliberately do NOT signal, and neither does a well-formed result whose
 * VALUE the journal refuses (the evidence guard's lying-measurement case).
 */
async function executeOp(
  job: Pick<ManifestJob, 'op' | 'input'>,
  lookup: (op: string) => OpRegistryEntry<never, never> | undefined,
  onDispatchUnknown?: () => void,
  guard?: {
    beforeBody(): Promise<OpResult<unknown> | undefined | void>;
    assertAllowed(): OpResult<unknown> | undefined | void;
  },
): Promise<OpResult<unknown>> {
  // The lookup itself is guarded: a registry.get that throws must fail THIS
  // job, not reject the whole run.
  let entry: OpRegistryEntry<never, never> | undefined;
  try {
    entry = lookup(job.op);
  } catch (err) {
    return {
      status: 'failed',
      error: `registry lookup for op '${job.op}' failed: ${messageOf(err)}`,
    };
  }
  if (entry === undefined) {
    return { status: 'failed', error: `unknown op '${job.op}'` };
  }
  let parsed: unknown;
  try {
    parsed = await entry.inputSchema.parseAsync(job.input);
  } catch (err) {
    return { status: 'failed', error: messageOf(err) };
  }
  let op: Op<never, never>;
  try {
    op = await entry.importer();
  } catch (err) {
    return { status: 'failed', error: messageOf(err) };
  }
  // Validation and import may await arbitrarily. Recheck immediately before
  // entering the body, OUTSIDE the ordinary op-error conversion. The sync
  // check closes the failure microtask window after the async nonce read.
  const preparationRefusal = await guard?.beforeBody();
  if (preparationRefusal !== undefined) return preparationRefusal;
  const entryRefusal = guard?.assertAllowed();
  if (entryRefusal !== undefined) return entryRefusal;
  try {
    let raw: OpResult<unknown>;
    try {
      raw = await op(parsed as never);
    } catch (err) {
      // The op BODY rejected: the dispatch was entered, so spend may exist
      // that no evidence fold will ever see. Signal it, then fall into the
      // shared handler below (ordinary op-error conversion is unchanged).
      onDispatchUnknown?.();
      throw err;
    }
    // Validate before journaling: the journal only accepts real OpResults, so
    // a contract-violating return must be caught HERE, not blow up the append.
    const checked = OpResultSchema.safeParse(raw);
    if (!checked.success) {
      // Post-invocation like the rejection above: the body RAN (and may have
      // spent), then resolved to something that is not an OpResult.
      onDispatchUnknown?.();
      return {
        status: 'failed',
        error: `op '${job.op}' violated the op contract: did not return an OpResult`,
      };
    }
    // OpResultSchema's value slot is z.unknown(), so a result can pass the
    // shape check yet not survive the journal line (each is JSON.stringify'd
    // at append) — or survive it LOSSILY, the journal disagreeing with the
    // value the run produced. Two probes, both HERE, recording an honest
    // per-job failure instead: stringify rejects throwing values (BigInt,
    // cycles, and — via the replacer — non-finite numbers); the losslessness
    // walk rejects silently-lossy values (Maps, Dates, class instances,
    // function members, symbol-keyed or non-enumerable (hidden) members, undefined array elements). See
    // assertJsonLossless for the one accepted normalization.
    try {
      JSON.stringify(checked.data, (_key, value: unknown) => {
        if (typeof value === 'number' && !Number.isFinite(value)) {
          throw new Error(`non-finite number ${String(value)}`);
        }
        return value;
      });
      // The frozen ok variant REQUIRES its value in the journaled record
      // (JournalEventSchema fails on read for {status:'ok'} without one), so
      // an undefined value is a lossy result, not absent data.
      if (checked.data.status === 'ok' && checked.data.value === undefined) {
        throw new Error("ok result without a 'value'");
      }
      assertJsonLossless(checked.data);
    } catch (err) {
      // NOT a post-invocation unknown: the body resolved to a WELL-FORMED
      // OpResult (an 'ok' WorkerResult here) whose VALUE the journal cannot
      // take. The evidence guard already judged that value — a lying
      // measurement (NaN/negative cost) folds nothing by design, and a
      // full-reservation charge here would let a bad number invent spend
      // the folds never saw (pinned: test/kernel/governor.test.ts (b2), a
      // lying cost claims nothing). The lossy/unsupported value keeps the
      // 'observed' basis, charging exactly what the folds saw.
      return {
        status: 'failed',
        error: `op '${job.op}' returned a non-serializable result: ${messageOf(err)}`,
      };
    }
    return checked.data;
  } catch (err) {
    return { status: 'failed', error: messageOf(err) };
  }
}

interface LeaseState {
  lock?: Awaited<ReturnType<typeof acquirePlanLock>>;
  /** A killed op's body was detached and may still run: never release. */
  detached?: boolean;
}

/**
 * Run one plan to completion (or honest early stop) and return its report.
 * See the header for the full contract. The optional `gov` handle turns the
 * run GOVERNED (ADR-0003 §2): admission, spend observation, caps, honest
 * stop, and the v2 journal — see the header's governed-mode section.
 */
export async function runPlan(
  plan: Plan,
  opts: RunOptions,
  registry: OpRegistryView,
  gov?: Governance,
): Promise<RunReport> {
  // The lifecycle owns release even when folding fails before the run's
  // signal listener exists. Keep this wrapper separate from run semantics.
  const lease: LeaseState = {};
  let report: RunReport;
  try {
    report = await runPlanUnderLease(plan, opts, registry, gov, lease);
  } catch (error) {
    // The run's own failure is the root cause: a release that fails too
    // (often the same disk fault) must not replace it. An unreleased record
    // of a finished process stays reclaimable by pid/socket liveness.
    // A detached op body may still be running: keep the lease fenced.
    if (lease.detached !== true) await lease.lock?.release().catch(() => undefined);
    throw error;
  }
  // Fail closed: a killed in-process op is detached, not stopped. Its record
  // stays unreleased so no overlapping run can enter the job; it becomes
  // reclaimable only when this process dies (pid/socket liveness).
  if (lease.detached !== true) await lease.lock?.release();
  return report;
}

async function runPlanUnderLease(
  plan: Plan,
  opts: RunOptions,
  registry: OpRegistryView,
  gov: Governance | undefined,
  lease: LeaseState,
): Promise<RunReport> {
  // Caps guard, BEFORE anything else: a cap without a governor is a lie —
  // there would be no admission gate and no spend observation to enforce it.
  if ((opts.maxUsd !== undefined || opts.maxTokens !== undefined) && gov === undefined) {
    throw new Error('runPlan: caps require governance');
  }
  // The handle's mirror guard: a `{ governor: undefined }` Governance handle
  // must not degrade to a silent no-op run that still journals a
  // governed-looking v2 record (seq claimed, `governance` block) — fail loud
  // exactly like the caps guard above (review M4).
  if (gov !== undefined && gov.governor === undefined) {
    throw new Error('runPlan: governance requires a governor');
  }
  if (!Number.isInteger(opts.concurrency) || opts.concurrency < 1) {
    throw new Error(`runPlan: concurrency must be an integer >= 1, got ${opts.concurrency}`);
  }
  // Before any state exists: no runId generated, nothing journaled.
  if (opts.resume === true && opts.journalDir === undefined) {
    throw new Error('runPlan: resume: true requires journalDir (there is nothing to replay from)');
  }
  // Full-plan validation BEFORE any filtering: duplicate job ids would make
  // the run internally inconsistent (id-keyed sets collapse them while array
  // views keep both), so they are plan corruption — thrown here, loud and
  // early, consistent with topoOrder's contract (which only ever sees the
  // post-pre-pass subset).
  const seenJobIds = new Set<string>();
  for (const job of plan.jobs) {
    if (seenJobIds.has(job.id)) {
      throw new Error(`runPlan: duplicate job id '${job.id}'`);
    }
    seenJobIds.add(job.id);
  }

  // Governed-run taxonomy: `ungovernedMarked` is the opted-in UNGOVERNED run
  // over governed history (no admission, no ledger — see the header);
  // `governedDispatch` is the governed path proper.
  const governor = gov?.governor;
  const ungovernedMarked = gov?.optIn?.includes('budget.ungovernedOverGoverned') === true;
  const governedDispatch = gov !== undefined && !ungovernedMarked;
  // A capped run cannot ride the ungoverned opt-in: the marker dispatches
  // with NO admission, so the caps would be silently unenforceable — the
  // exact shape the caps-without-governance guard above exists to refuse
  // (review cycle 2). Fail closed, naming both resolutions.
  if (ungovernedMarked && (opts.maxUsd !== undefined || opts.maxTokens !== undefined)) {
    throw new Error(
      'runPlan: budget.ungovernedOverGoverned marks the run ungoverned (no admission, no ledger), so maxUsd/maxTokens could not be enforced — drop the caps or drop the opt-in',
    );
  }

  const runId = makeRunId(plan.id, opts.journalDir !== undefined);
  const manifest = makeManifest(plan);
  const jobById = new Map<string, ManifestJob>(
    manifest.jobs.map((job): [string, ManifestJob] => [job.id, job]),
  );

  // --- Scheduling: missing-dep pre-pass, then waves over the remainder ------
  // Computed BEFORE the ledger fold and the seq claim: a dependency CYCLE is
  // plan corruption (frozen evidence rule: fail loudly) and must throw while
  // nothing is claimed or journalled — a governed run-started written before
  // the rejection would permanently establish governed history for the plan
  // and refuse later corrected runs as ungoverned-over-governed (review
  // thread).
  const jobIds = new Set(jobById.keys());
  const unschedulable = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const job of manifest.jobs) {
      if (unschedulable.has(job.id)) continue;
      const missingDep = job.dependsOn.find((dep) => !jobIds.has(dep) || unschedulable.has(dep));
      if (missingDep !== undefined) {
        unschedulable.add(job.id);
        changed = true;
      }
    }
  }
  // Missing deps are already excluded, so topoOrder can only throw on a
  // genuine cycle — plan corruption (frozen evidence rule: fail loudly).
  const schedulable = manifest.jobs.filter((job) => !unschedulable.has(job.id));
  const waves = topoOrder(schedulable);
  // Waves of job-id strings → waves of jobs (ids come from the same manifest).
  const waveJobs: ManifestJob[][] = waves.map((wave) =>
    wave.map((jobId) => jobById.get(jobId) as ManifestJob),
  );

  // One journal surface for both modes: events are ALWAYS produced through
  // the same emit call sites in the same order; with a journalDir they are
  // validated + appended to `<runId>.ndjson`, otherwise the sink is a no-op.
  // Journal-less runs keep the identical event-SEQUENCE semantics without
  // buffering an unconsumed array — the journaled file is the record (no
  // caller or test consumes an in-memory list). The fold over the sequence —
  // journal deriveJobStatuses over a journaled run's file — is
  // mode-independent by construction.
  const journalDir = opts.journalDir;
  const runLog: RunLog | undefined = journalDir !== undefined ? openRunLog(journalDir) : undefined;
  // One failure authority, shared by BOTH emit paths and every dispatch.
  // An infrastructure failure cancels the governed ladders and waiters;
  // already dispatched jobs still settle while the wave drains. The run
  // rejects with the original error instead of returning a success report.
  let runFailure: { error: unknown } | undefined;
  const failRun = (error: unknown): void => {
    runFailure ??= { error };
    if (governedDispatch) governor?.tripSignal(`journal: run stopped after ${messageOf(error)}`);
  };
  const throwIfFailed = (): void => {
    if (runFailure !== undefined) throw runFailure.error;
  };
  // THE LINE-COUNT LEDGER (W2.3 fix round, comp 2): every emitted event is
  // counted and the total rides run-finished as `eventCount`, so the resume
  // fold's line-count check (journal.foldOrderRuns) can detect a line
  // DELETED from a surviving run file — the corruption shape the
  // paired-line throws cannot see (a deleted `reservation-opened` would
  // silently drop a crashed dispatch's full charge and its quarantine).
  let journalledCount = 0;
  const emit = async (event: JournalEvent): Promise<void> => {
    journalledCount += 1;
    try {
      if (runLog) await runLog.append(runId, event);
    } catch (error) {
      failRun(error);
      throw error;
    }
  };
  // The WRITE-AHEAD channel (W2.3): reservation-opened must be durable
  // BEFORE the dispatch runs and reservation-settled BEFORE the outcome is
  // journalled — the fdatasync'd facts that make a hard crash between them
  // VISIBLE as an unresolved reservation (charged in full + quarantined on
  // resume, A12b) instead of silent lost spend.
  const emitDurable = async (event: JournalEvent): Promise<void> => {
    journalledCount += 1;
    try {
      if (runLog) await runLog.append(runId, event, { durable: true });
    } catch (error) {
      failRun(error);
      throw error;
    }
  };

  // Hold the plan's lease before inspecting or seeding ANY shared history,
  // including plain runs and the ungoverned-over-governed escape.
  const planLock =
    journalDir !== undefined ? await acquirePlanLock(journalDir, plan.id, runId) : undefined;
  if (planLock !== undefined) lease.lock = planLock;
  const fenceDispatch = async (): Promise<void> => {
    throwIfFailed();
    try {
      await planLock?.assertHeld();
    } catch (error) {
      failRun(error);
      throw error;
    }
    // A sibling emit may have failed while the fence read was in flight.
    throwIfFailed();
  };

  await planLock?.assertHeld();

  // --- Fold: EVERY prior run of this plan, v1-then-v2 ----------------------
  // EVERY run over a journal dir folds (ADR-0003 §2.1 is unqualified: a run
  // over a dir whose plan history contains a governed v2 run must be
  // governed — the refusal below needs the history on FRESH runs too, not
  // just resumes). Within the fold: a governed run ALWAYS uses it for ledger
  // continuity (attempts, spend, cap checks, refusals); the replay-skip map
  // stays resume-gated.
  const replay = new Map<string, JobFinishedJournalEvent>();
  // Governed fold facts. governedRunIds is the one fact the UNGOVERNED path
  // also needs (the refusal below must see governed history on fresh runs,
  // not only resumes).
  const governedRunIds: string[] = [];
  const ungovernedRunIds: string[] = [];
  const v1DispatchRuns: string[] = [];
  const priorResets = new Set<string>();
  let prevCapUsd: number | undefined;
  // No `prevCapTokens` twin, deliberately (review M1): the raise refusal (c)
  // gates only the USD bound because USD is the ledger's BINDING unit — a cap
  // raise that outruns prior spend is a real budget-integrity change. Token
  // caps are ADVISORY on every lane in v1.1 (ADR-0003 §2.3 — the DD-9
  // unpriced-model backstop, not a binding ceiling), so a token-cap raise has
  // no spend-integrity consequence to gate; a predecessor check would be
  // enforcement theatre. Symmetry lands when token caps become binding.
  let maxPriorSeq = 0;
  let priorRuns: FoldRun[] = [];
  const seedRuns: Array<{ runId: string; v1: boolean; events: readonly JournalEvent[] }> = [];
  if (runLog) {
    // Shared candidate pre-filter (journal.candidateRunsForPlan): runIds
    // embed the plan id (`<planId>--<timestamp>--<random>`) and must carry
    // the exact two-segment tail, so only THIS plan's files are ever
    // parsed — a planId that merely extends this one ('a' vs 'a--b') cannot
    // slip in, and a corrupt middle line in ANOTHER plan's journal cannot
    // block THIS plan's resume. The run-started planId check below remains
    // the semantic matcher for every file that IS parsed.
    const candidates = candidateRunsForPlan(await runLog.runs(), plan.id);
    const matching: FoldRun[] = [];
    for (const priorRunId of candidates) {
      const priorEvents = await runLog.read(priorRunId);
      let priorPlanId: string | undefined;
      for (const event of priorEvents) {
        if (event.type === 'run-started') {
          priorPlanId = event.planId;
          break;
        }
      }
      if (priorPlanId !== plan.id) continue;
      matching.push({ runId: priorRunId, events: priorEvents });
    }
    // THE FOLD ORDER (annex §3): v1 runs by (at, runId), all before every
    // v2 run; v2 runs by `seq` — `at` is display-only for v2, so an
    // injected clock can no longer reorder the fold. Corruption is loud
    // (a v2 run without seq, or a duplicate seq, throws from foldOrderRuns).
    priorRuns = foldOrderRuns(matching);
    for (const prior of priorRuns) {
      const started = prior.events.find(
        (event): event is RunStartedJournalEvent => event.type === 'run-started',
      );
      if (started === undefined) continue; // unreachable — the matcher required one
      const isV2 = started.journalVersion === 2;
      if (isV2) {
        if (started.governance !== undefined) governedRunIds.push(prior.runId);
        if (started.ungoverned !== undefined) ungovernedRunIds.push(prior.runId);
        if (started.seq !== undefined && started.seq > maxPriorSeq) maxPriorSeq = started.seq;
      }
      if (gov !== undefined) {
        if (!isV2 && prior.events.some((event) => event.type === 'job-started')) {
          v1DispatchRuns.push(prior.runId);
        }
        if (isV2 && started.governance !== undefined) {
          // The LAST governed v2 run THAT SET A CAP owns the previous cap:
          // an uncapped governed run (an opt-in-only handle) journals no
          // capUsd, and letting that undefined clobber prevCapUsd would let
          // the NEXT run raise the cap without budget.raiseCap (review
          // cycle 4). Its legacyJournal resets are sticky for the named v1
          // runs.
          if (started.governance.capUsd !== undefined) {
            prevCapUsd = started.governance.capUsd;
          }
          if (started.governance.legacyJournal !== undefined) {
            for (const resetId of started.governance.legacyJournal.v1RunIds) {
              priorResets.add(resetId);
            }
          }
        }
        // The seed fold itself (below) decides what enters the ledger; each
        // run rides with its version tag so the reset filter can exclude a
        // v1 run's spend without dropping its attempt/dispatch seeds.
        seedRuns.push({ runId: prior.runId, v1: !isV2, events: prior.events });
      }
      if (opts.resume === true) {
        for (const event of prior.events) {
          if (event.type === 'job-finished') replay.set(event.jobId, event);
          // A journalled release invalidates every replay record for that
          // job from BEFORE it (runs fold in order, events in journal
          // order): the release contract is a re-run, so only a
          // post-release finish is fresh evidence. When the release run
          // produces no replacement finish (a sibling's stopOnError halts
          // it first), the next resume would otherwise rebuild this map
          // with the pre-crash ok and replay-skip the released job forever
          // — --release-quarantine a silent permanent no-op across runs.
          else if (event.type === 'quarantine-released') replay.delete(event.jobId);
        }
      }
    }
    // No prior run for this plan → fresh run; nothing to replay.

    // The fold-order corruption checks are loud on duplicates
    // (foldOrderRuns) and on GAPS: a claim tombstone beyond the highest
    // folded seq means a claimed run's FILE is gone (deleted — its spend
    // would silently vanish from the ledger seed), or an orphaned claim
    // (crash between claimSeq and the first append — the operator deletes
    // the tombstone). See journal.assertNoSeqGap (review H2).
    if (journalDir !== undefined) {
      await assertNoSeqGap(journalDir, plan.id, maxPriorSeq);
    }
  }

  // --- Refusals (before anything is emitted or claimed) ---------------------
  let unaccountedV1: string[] = [];
  if (gov === undefined) {
    // (a) Ungoverned over governed history: the plan's ledger is governed —
    // an ungoverned run would split it.
    if (governedRunIds.length > 0) {
      throw new Error(
        `runPlan: plan ${plan.id} has governed history; run governed or pass --opt-in budget.ungovernedOverGoverned`,
      );
    }
  } else if (ungovernedMarked && governedRunIds.length === 0) {
    // (a') The marker HONOURED with no governed history (review H3):
    // `budget.ungovernedOverGoverned` names exactly one condition — an
    // ungoverned run OVER governed history. On a plan with none there is
    // nothing to opt out of, and honouring the marker would dispatch this
    // run's ops with no admission and strand its spend outside every future
    // ledger — a silent forfeit. Refuse, naming the condition and both
    // resolutions (the operator almost certainly meant to run governed).
    throw new Error(
      `runPlan: budget.ungovernedOverGoverned marks the run ungoverned, but plan ${plan.id} has no governed history — the marker exists for an ungoverned run OVER governed history; drop the opt-in and run governed`,
    );
  } else if (!ungovernedMarked) {
    // (b) Governed over unaccounted v1 dispatches — whether or not resume is
    // set: v1 journals carry no spend, so the cap cannot bind what already
    // ran there. The reset opt-in is honoured only when NEEDED.
    unaccountedV1 = v1DispatchRuns.filter((id) => !priorResets.has(id));
    if (unaccountedV1.length > 0 && !gov.optIn?.includes('budget.legacyJournal=reset')) {
      const dispatchedJobIds = new Set<string>();
      for (const prior of priorRuns) {
        if (!unaccountedV1.includes(prior.runId)) continue;
        for (const event of prior.events) {
          if (event.type === 'job-started') dispatchedJobIds.add(event.jobId);
        }
      }
      throw new Error(
        `runPlan: governed resume over v1 journals with unaccounted dispatches (${dispatchedJobIds.size} jobs in ${unaccountedV1.join(' ')}); v1 journals carry no spend. Pass --opt-in budget.legacyJournal=reset.`,
      );
    }
    // (c) Cap raise: the ledger's C only moves UP with the explicit opt-in.
    const nextCapUsd = governor?.config.maxUsd;
    if (
      prevCapUsd !== undefined &&
      nextCapUsd !== undefined &&
      nextCapUsd > prevCapUsd &&
      !gov.optIn?.includes('budget.raiseCap')
    ) {
      throw new Error(`runPlan: cap raised from ${prevCapUsd} to ${nextCapUsd}`);
    }
  }
  // The ungoverned-marked path takes NO refusals: it IS the opt-out — its
  // marker records that this run sits outside the governed ledger, and
  // refusals (b)/(c) are ledger gates.

  // --- Governed ledger continuity: seed the governor from the fold ---------
  // A CAPLESS governed run's conservative inheritance of C_prev (journalled
  // on run-started below); declared here so the run-started emit sees it.
  let inheritedCapUsd: number | undefined;
  if (governedDispatch && governor !== undefined) {
    // A CAPLESS governed run over capped history inherits the predecessor
    // cap (W2.3): the ledger's C never silently disappears between runs —
    // this run reserves against C_prev and journals the inheritance. The
    // predecessor cap for the raise refusal does not move (an inheritance
    // is not a raise).
    if (!ungovernedMarked && governor.config.maxUsd === undefined && prevCapUsd !== undefined) {
      if (governor.inheritCapUsd(prevCapUsd)) {
        inheritedCapUsd = prevCapUsd;
      }
    }
    // LEDGER POLICY (recorded): attempts and the dispatch count seed from
    // ALL runs — attempts are spent regardless of who paid — but SPEND (a
    // job-finished's usage/costUSD) seeds only from runs inside the bound:
    //   - ungoverned-marked runs sit outside it by explicit opt-in;
    //   - v1 runs covered by a reset are "charged 0" (annex §4): the sticky
    //     prior resets, plus — when the refusal above was satisfied by the
    //     honoured opt-in — this fold's unaccounted v1 runs. Their starts
    //     still seed attempts and the dispatch quota.
    const spendExcluded = new Set(priorResets);
    if (gov?.optIn?.includes('budget.legacyJournal=reset') === true) {
      for (const resetId of unaccountedV1) spendExcluded.add(resetId);
    }
    governor.seedFromJournal(
      seedRuns.flatMap((run) =>
        ungovernedRunIds.includes(run.runId) || (run.v1 && spendExcluded.has(run.runId))
          ? run.events.filter((event) => event.type !== 'job-finished')
          : [...run.events],
      ),
    );
    // Annex §3 rule 7: a later governed run announces that the bound excludes
    // the plan's ungoverned-marked runs from the ledger seed — the CLI turns
    // this event into `cq: bound excludes ungoverned runs <runIds>`. Fold
    // order, so the list is deterministic.
    if (ungovernedRunIds.length > 0) {
      governor.record({
        kind: 'bound-excluded-ungoverned',
        runIds: [...ungovernedRunIds],
        atMs: governor.now(),
      });
    }
  }

  // --- Run-level cancel signal (ADR-0003 §2.3) ------------------------------
  // Pre-aborted trips NOW (before the run-started emit); an abort mid-run
  // trips through the listener. The listener is removed in the finally below
  // — no trip can outlive this run.
  let removeSignalListener: (() => void) | undefined;
  const runSignal = gov?.signal;
  if (governedDispatch && governor !== undefined && runSignal !== undefined) {
    // The governor OWNS the cancel binding (I8): an abort trips it with trip
    // kind 'signal', which aborts the governor's trip signal — the one
    // signal every dispatch ladder composes.
    governor.bindRunSignal(runSignal);
    removeSignalListener = (): void => {
      governor.unbindRunSignal();
    };
  }

  try {
    // --- Run-started --------------------------------------------------------
    if (gov !== undefined && runLog && journalDir !== undefined) {
      // v2 run-started: the seq is CLAIMED by exclusive create BEFORE the
      // event is emitted (annex §2 — uniqueness by construction; 1 + max
      // prior seq). A governed run without a journalDir journals nothing:
      // no claim, no v2 fields (the emit sink below is a no-op anyway).
      const seq = await claimSeq(journalDir, plan.id, maxPriorSeq + 1);
      if (ungovernedMarked) {
        // UNGOVERNED-MARKED run: the marker IS the record — no governance
        // block, no caps, no ledger (see the header's governed-mode section).
        const started: RunStartedJournalEvent = {
          type: 'run-started',
          runId,
          at: now(),
          planId: plan.id,
          journalVersion: 2,
          seq,
          ungoverned: { optIn: true },
        };
        await emit(started);
      } else {
        const config = governor?.config ?? {};
        const legacyResetHonoured =
          unaccountedV1.length > 0 && gov.optIn?.includes('budget.legacyJournal=reset') === true;
        const raiseCapHonoured =
          prevCapUsd !== undefined &&
          config.maxUsd !== undefined &&
          config.maxUsd > prevCapUsd &&
          gov.optIn?.includes('budget.raiseCap') === true;
        const started: RunStartedJournalEvent = {
          type: 'run-started',
          runId,
          at: now(),
          planId: plan.id,
          journalVersion: 2,
          seq,
          governance: {
            ...(config.maxUsd !== undefined ? { capUsd: config.maxUsd } : {}),
            ...(config.maxTokens !== undefined ? { capTokens: config.maxTokens } : {}),
            ...(inheritedCapUsd !== undefined ? { inheritedCapUsd } : {}),
            ...(gov.allowAdvisory === true
              ? {
                  allowAdvisory: true,
                  // WHO set the escape (review r1 M4): 'operator' via the
                  // CLI flag, 'product' via an unattended-by-design product
                  // path — the journal distinguishes an operator's escape
                  // from the product's own posture.
                  ...(gov.allowAdvisoryProvenance !== undefined
                    ? { allowAdvisoryProvenance: gov.allowAdvisoryProvenance }
                    : {}),
                }
              : {}),
            attended: gov.attended ?? false,
            ...(legacyResetHonoured
              ? { legacyJournal: { mode: 'reset' as const, v1RunIds: [...unaccountedV1] } }
              : {}),
            ...(raiseCapHonoured && prevCapUsd !== undefined && config.maxUsd !== undefined
              ? { raiseCap: { from: prevCapUsd, to: config.maxUsd } }
              : {}),
          },
        };
        await emit(started);
      }
    } else {
      await emit({ type: 'run-started', runId, at: now(), planId: plan.id });
    }

    // --- Unschedulable rows: blocked for a missing dependency from the start
    // (the pre-pass and waves above already classified them; nothing here can
    // throw — the cycle check ran before anything was claimed or journalled).
    const entries = new Map<string, OutcomeEntry>();
    for (const job of manifest.jobs) {
      if (!unschedulable.has(job.id)) continue;
      const missing = job.dependsOn.find((dep) => !jobIds.has(dep));
      entries.set(job.id, {
        result: {
          status: 'failed',
          error:
            missing !== undefined
              ? `blocked: dependency '${missing}' missing from plan`
              : 'blocked: upstream dependency did not succeed',
        },
        state: 'blocked',
        origin: 'blocked',
      });
    }

    // --- Quarantine enforcement (W2.3, A12b) ---------------------------------
    // Jobs the seed fold found BEHIND an unresolved reservation are
    // quarantined: never dispatched, reported needs-human, re-attested each
    // run until an explicit per-call releaseQuarantine (which never refunds
    // the full charge the seed took). Journalled here so every run's
    // evidence shows the quarantine standing; dependents block through the
    // ordinary dependency rule below (a quarantined row is not a done dep).
    if (governedDispatch && governor !== undefined && !ungovernedMarked) {
      const releases = new Set(gov?.releaseQuarantine ?? []);
      for (const job of manifest.jobs) {
        if (unschedulable.has(job.id)) continue;
        const quarantined = governor.quarantinedJobs.get(job.id);
        if (quarantined === undefined) continue;
        if (releases.has(job.id)) {
          await emit({
            type: 'quarantine-released',
            runId,
            at: now(),
            jobId: job.id,
            provenance: 'call',
          });
          // A release RE-RUNS the job (that is its whole contract — the
          // dispatch behind the crash died in UNKNOWN status, so any older
          // verified ok is stale evidence from before the unknown effects).
          // Drop the replay record so the wave loop's replay-skip cannot
          // mark the released job done without dispatching it (Codex P1 on
          // the fix round: run 1 ok → run 2 crashes after opening its
          // reservation → run 3 resumes WITH the release).
          replay.delete(job.id);
          continue;
        }
        await emit({
          type: 'job-quarantined',
          runId,
          at: now(),
          jobId: job.id,
          reservationId: quarantined.reservationId,
          chargedUsd: quarantined.usd,
          reason: 'unresolved-reservation',
        });
        entries.set(job.id, {
          result: {
            status: 'needs-human',
            reason: `quarantined: unresolved reservation '${quarantined.reservationId}' (charged ${quarantined.usd} USD in full — the dispatch behind a hard crash may have spent it); release with --release-quarantine ${job.id} to re-run (the charge is never refunded)`,
          },
          state: 'blocked', // the frozen-state friction mapping for needs-human (header counts policy)
          origin: 'quarantined',
        });
      }
    }

    // --- Execute waves through one pool, EXACTLY opts.concurrency in flight
    const limit = pLimit(opts.concurrency);
    const stop = { requested: false };
    // Governed honest-stop provenance: the runner KNOWS which jobs it
    // admitted this run — attribution needs no marker strings.
    const admittedJobIds = new Set<string>();

    // Under a governed SIGNAL stop the never-dispatched rows are cancelled,
    // not failed. This is a PREDICATE, not a run-start snapshot: the trip
    // lands MID-RUN (a dispatch trips the governor while later waves are
    // still waiting), so every decision point below must evaluate it at its
    // own moment — a snapshot taken before the waves would fall back to the
    // plain rule for exactly the rows the cancel reached, fabricating
    // `blocked` rows for them (review r1 major; supersedes the composition
    // brief's single-site fix shape).
    const cancelledRun = (): boolean =>
      governedDispatch &&
      governor !== undefined &&
      governor.tripped &&
      governor.tripKind === 'signal';

    // Is this dependency a DEFINITIVE non-success for blocking purposes?
    // failed/blocked/budget-exhausted (transitively) — never a merely queued
    // sibling still awaiting dispatch, and, under a signal stop, never an
    // UNRESOLVED row: no entry (the cancel landed before the dep's wave) and
    // a dispatch cancelled while it waited (result 'indeterminate', which the
    // counts policy maps to failed) are both unresolved, not failures — the
    // pair stays re-runnable on resume, so only a definitive non-success
    // blocks (README "undispatched rows stay queued").
    const definitivelyNotOk = (dep: string): boolean => {
      const entry = entries.get(dep);
      if (entry === undefined) return !cancelledRun();
      const { state } = entry;
      if (state === 'done' || state === 'queued') return false;
      return !(cancelledRun() && entry.result.status === 'indeterminate');
    };

    const blockedResult = (job: ManifestJob): OpResult<unknown> => {
      // Name a dependency that definitively did not succeed. Both call sites
      // guarantee one exists (wave: the plain rule — this is only reached
      // when not cancelled; sweep: anyNotOk), so the first find always hits.
      const notOk = job.dependsOn.find(definitivelyNotOk);
      return {
        status: 'failed',
        error: `blocked: dependency '${notOk}' did not succeed`,
      };
    };

    const plainRunOne = async (job: ManifestJob): Promise<void> => {
      // p-limit starts queued tasks when a slot frees; re-check the stop flag at
      // actual start so "do not START any further jobs" holds while in-flight
      // ones still complete.
      if (stop.requested || runFailure !== undefined) return;

      await emit({
        type: 'job-started',
        runId,
        at: now(),
        jobId: job.id,
        op: job.op,
        attempt: 1, // ungoverned dispatches are single-attempt by construction
      });

      await fenceDispatch();
      const result = await executeOp(job, (name) => registry.get(name), undefined, {
        beforeBody: fenceDispatch,
        assertAllowed: throwIfFailed,
      });

      if (opts.stopOnError && result.status !== 'ok') stop.requested = true;
      await emit({
        type: 'job-finished',
        runId,
        at: now(),
        jobId: job.id,
        opId: job.op,
        inputsHash: job.inputsHash,
        result,
      });
      entries.set(job.id, { result, state: stateFromResult(result), origin: 'executed' });
    };

    // The GOVERNED dispatch (ADR-0003 §2): admission (job.id-keyed) →
    // in-flight slot → escalation ladder inside the job context → evidence
    // folds → honest verdict. Replaces the old governRegistry-composed path
    // inside the runner so the journal carries real attempt ordinals and the
    // per-job spend rollups.
    const governedRunOne = async (job: ManifestJob): Promise<void> => {
      if (governor === undefined) return; // unreachable behind governedDispatch
      // p-limit start re-check (same rule as the plain path).
      if (stop.requested || runFailure !== undefined) return;

      // A12c (W2.3): an ADVISORY-classified dispatch is refused UNATTENDED
      // without an explicit escape (`attended: true`, or `allowAdvisory`).
      // At v1.1 EVERY dispatch classifies ADVISORY (lanes.ts ships no HARD
      // rows — no conformance leg has demonstrated one), so an unattended
      // governed run dispatches nothing unless the operator escapes. The
      // refusal is terminal budget evidence ON THE JOB (ADR §2.9: advisory-*
      // rows stay budget-exhausted on themselves; dependents re-mark
      // transitively), journalled finish-only with the `reservation-refused`
      // fact — nothing was dispatched, no attempt is spent. The gate sits
      // BEHIND the trip check (`!governor.tripped`): on an already-tripped
      // run the REAL cause of a refusal is the trip, and the durable
      // `reservation-refused{reason:'advisory-lane'}` line would name the
      // wrong bound (review r1 M1) — a tripped run falls through to
      // `governor.admit`, whose refusal journals the trip as the cause.
      if (
        gov !== undefined &&
        !governor.tripped &&
        gov.attended !== true &&
        gov.allowAdvisory !== true &&
        classifyDispatch() === 'advisory'
      ) {
        governor.record({
          kind: 'short-circuited',
          op: job.op,
          jobKey: job.id,
          reason: 'advisory-lane',
          atMs: governor.now(),
        });
        if (opts.stopOnError) stop.requested = true;
        // (With stopOnError the halt is the OPERATOR's stop policy, never a
        // governor trip: the honest-stop pass below therefore does not
        // re-mark the undispatched rows budget-exhausted — they stay
        // `queued`, re-runnable, and the run claims no budget stop the
        // journal cannot back with a budget-tripped fact.)
        await emit({
          type: 'reservation-refused',
          runId,
          at: now(),
          jobId: job.id,
          op: job.op,
          reason: 'advisory-lane',
        });
        const advisoryRefused: OpResult<unknown> = { status: 'budget-exhausted' };
        await emit({
          type: 'job-finished',
          runId,
          at: now(),
          jobId: job.id,
          opId: job.op,
          inputsHash: job.inputsHash,
          result: advisoryRefused,
        });
        entries.set(job.id, {
          result: advisoryRefused,
          state: 'budget-exhausted',
          origin: 'executed',
        });
        return;
      }

      const admission = governor.admit(job.id);
      if (admission.decision === 'reject') {
        // admit() answers reason 'budget' for EVERY tripped kind, so a
        // dispatch whose start races the run-level cancel would be labelled
        // budget-exhausted here and strand unre-runnable on resume. A signal
        // trip is a CANCEL, not a budget event (TripKind taxonomy — review
        // cycle 3): return without classifying — the stop sweep marks the
        // row queued (nothing ran) and the honest-stop pass claims 'signal'.
        if (governor.tripKind === 'signal') return;
        // A refusal is a real terminal verdict for this run: recorded and
        // journalled (finish-only — no job-started, no dispatch happened).
        governor.record({
          kind: 'short-circuited',
          op: job.op,
          jobKey: job.id,
          reason: admission.reason,
          atMs: governor.now(),
        });
        const refused: OpResult<unknown> = { status: 'budget-exhausted' };
        if (opts.stopOnError) stop.requested = true;
        await emit({
          type: 'job-finished',
          runId,
          at: now(),
          jobId: job.id,
          opId: job.op,
          inputsHash: job.inputsHash,
          result: refused,
        });
        entries.set(job.id, { result: refused, state: 'budget-exhausted', origin: 'executed' });
        return;
      }
      governor.record({
        kind: 'admitted',
        op: job.op,
        jobKey: job.id,
        attempt: admission.attempt,
        atMs: governor.now(),
      });
      admittedJobIds.add(job.id);
      await emit({
        type: 'job-started',
        runId,
        at: now(),
        jobId: job.id,
        op: job.op,
        attempt: admission.attempt,
      });

      // Per-job ledger sums: everything this invocation's evidence folds
      // actually charged — streamed (reportResult) plus the returned
      // WorkerResult fold, each exactly once (the flags mirror the
      // governor's own once-only guards).
      let jobUsage: Usage | undefined;
      let jobCostUSD: number | undefined;
      let reportedUsage = false;
      let reportedCost = false;
      const foldIntoJobSums = (
        evidence: { usage?: Usage; costUSD?: number },
        counts?: { usageAlreadyCounted?: boolean; costAlreadyCounted?: boolean },
      ): void => {
        if (
          evidence.usage !== undefined &&
          counts?.usageAlreadyCounted !== true &&
          usageTokens(evidence.usage) > 0
        ) {
          jobUsage =
            jobUsage === undefined ? { ...evidence.usage } : addUsage(jobUsage, evidence.usage);
        }
        if (evidence.costUSD !== undefined && counts?.costAlreadyCounted !== true) {
          jobCostUSD = (jobCostUSD ?? 0) + evidence.costUSD;
        }
      };

      await governor.acquireSlot();
      let result: OpResult<unknown>;
      // W2.3 reserve-then-settle: the dispatch's open reservation (undefined
      // on an uncapped run — reservation-less), the settle's returned charge
      // (journalled on the job-finished as `charged`), the ladder outcome
      // (the settle's basis reads the dispatch's ending), and the composed
      // dispatch signal's cleanup.
      let reservation: BudgetReservation | undefined;
      let preserveOpenedReservation = false;
      const fenceInvocation = async (): Promise<void> => {
        try {
          await fenceDispatch();
        } catch (error) {
          preserveOpenedReservation = true;
          throw error;
        }
      };
      let settledCharge:
        | { charged: number; basis: 'observed' | 'full'; priced: boolean }
        | undefined;
      let outcome: LadderOutcome<OpResult<unknown>> | undefined;
      // The op body's own rejection, or a post-invocation value the contract
      // rejects — the UNKNOWN-status endings executeOp's contract flattens
      // into a `failed` verdict. The settle's basis reads the signal; the
      // ladder's 'threw' outcome cannot distinguish these from a private
      // invocation-guard rejection, which preserves the opened fact instead.
      let dispatchUnknown = false;
      // The dispatch-closed guard: once the ladder settles, the dispatch's
      // evidence window is CLOSED — a detached (killed) op promise's late
      // reportResult calls are DROPPED, so the live ledger and the journal's
      // reservation-settled.charged / job-finished rollups stay exactly
      // equal (a post-settle fold would move the ledger with no journal
      // backing, and the next fold would silently undercount it).
      let dispatchClosed = false;

      // The queued-dispatch refusal (the trip KIND decides the verdict): a
      // budget trip leaves the row budget-exhausted, but a SIGNAL trip is a
      // cancel, not a budget event — the row is indeterminate (never ran;
      // resume re-runs it) and the event names the cancel, keeping the trip
      // taxonomy's rule that a signal stop never claims a budget exhaustion.
      const queuedRefusal = (cancelled: boolean): OpResult<unknown> => {
        governor.record({
          kind: 'short-circuited',
          op: job.op,
          jobKey: job.id,
          reason: cancelled ? 'cancelled-while-queued' : 'budget-while-queued',
          atMs: governor.now(),
        });
        return cancelled
          ? {
              status: 'indeterminate',
              detail:
                'cancelled: the run-level signal tripped the governor before this queued dispatch ran',
            }
          : { status: 'budget-exhausted' };
      };

      let dispatchSignal: AbortSignal | undefined;
      const invocationPermission = (): OpResult<unknown> | undefined => {
        // Infrastructure failure remains a run rejection with an unresolved
        // opened fact. Ordinary cancellation instead follows normal settlement.
        try {
          throwIfFailed();
        } catch (error) {
          preserveOpenedReservation = true;
          throw error;
        }
        if (dispatchClosed) {
          // A detached preparation cannot reopen an already settled dispatch,
          // or append fresh governor evidence after its slot was released.
          return { status: 'indeterminate', detail: 'cancelled: dispatch already closed' };
        }
        if (governor.tripped) return queuedRefusal(governor.tripKind === 'signal');
        if (dispatchSignal?.aborted === true) {
          return {
            status: 'indeterminate',
            detail: 'cancelled: dispatch signal aborted before invocation',
          };
        }
        return undefined;
      };
      const dispatchGuard = {
        async beforeBody(): Promise<OpResult<unknown> | undefined> {
          const refusal = invocationPermission();
          if (refusal !== undefined) return refusal;
          await fenceInvocation();
          return invocationPermission();
        },
        // No await separates this check from entry into the operation body.
        assertAllowed: invocationPermission,
      };

      // Interpret ONE ladder outcome into the job's verdict: the completion
      // record, the DD-9 completion-time evidence fold, the kill verdict. A
      // 'threw' outcome re-throws so the caller's catch keeps the runner's
      // failure semantics in charge.
      const interpretOutcome = (
        ladderOutcome: LadderOutcome<OpResult<unknown>>,
        attempt: number,
      ): OpResult<unknown> => {
        if (ladderOutcome.outcome === 'completed') {
          const opResult = ladderOutcome.value;
          governor.record({
            kind: 'completed',
            op: job.op,
            jobKey: job.id,
            attempt,
            status: opResult.status,
            elapsedMs: ladderOutcome.elapsedMs,
            atMs: governor.now(),
          });
          // DD-9 evidence fold: a completed 'ok' OpResult whose value is
          // WorkerResult-shaped carries this invocation's budget evidence —
          // fold it ONCE, skipping whatever the op already streamed (the
          // flags above).
          if (opResult.status === 'ok') {
            const worker = workerResultOfValue(opResult.value);
            if (worker !== undefined) {
              const counts = {
                usageAlreadyCounted: reportedUsage,
                costAlreadyCounted: reportedCost,
              };
              // Mirror-strict exactly like the streamed channel above: a
              // returned WorkerResult the journal/report mirror would
              // reject (fractional counts, extra keys) folds as ZERO
              // evidence — otherwise it lands raw in the per-job sums
              // and trades the defensive guard for a post-record
              // job-finished append throw (review thread).
              const spend = validSpendEvidence(worker);
              governor.observeResult(job.id, spend, counts);
              foldIntoJobSums(spend, counts);
            }
          }
          return opResult;
        }
        if (ladderOutcome.outcome === 'threw') {
          governor.record({
            kind: 'completed',
            op: job.op,
            jobKey: job.id,
            attempt,
            status: 'threw',
            elapsedMs: ladderOutcome.elapsedMs,
            atMs: governor.now(),
          });
          // The runner's catch retains ordinary per-job failure semantics;
          // a private infrastructure guard instead rejects the whole run.
          throw ladderOutcome.error;
        }
        // Rung 3 fired: the op was killed — detached in-process with
        // its rejections suppressed — and the honest known-cause
        // verdict is recorded in its place (I9).
        lease.detached = true;
        governor.record({
          kind: 'completed',
          op: job.op,
          jobKey: job.id,
          attempt,
          status: 'budget-exhausted',
          elapsedMs: ladderOutcome.elapsedMs,
          atMs: governor.now(),
        });
        return { status: 'budget-exhausted' };
      };

      // ONE dispatch ladder, shared by the capped and uncapped paths: the
      // ladder composes the governor's TRIP SIGNAL (aborted by any trip —
      // cancel included, via bindRunSignal — abort-on-trip, W2.3), so an
      // in-flight op sees the abort through currentJobContext().signal. The
      // ladder removes its listener when it settles (governor.runLadder).
      const runDispatchLadder = async (attempt: number): Promise<OpResult<unknown>> => {
        const ladderOutcome = await runLadder(
          (context) => {
            dispatchSignal = context.signal;
            dispatchUnknown = false;
            return executeOp(
              job,
              (name) => registry.get(name),
              () => {
                dispatchUnknown = true;
              },
              dispatchGuard,
            );
          },
          governor.ladderSpec,
          { op: job.op, jobKey: job.id, attempt },
          {
            // ONE time source: the governor's own clock timestamps the
            // ladder AND every recorded event — an override here would
            // run the ladder in a different time domain from the event
            // stream (review thread). Virtualize at createGovernor.
            clock: governor.clock,
            signal: governor.tripAbortSignal,
            onRung: (marker) => {
              // Keep the marker identity: async delivery failures arrive
              // after onRung and must remain visible in the recorded event.
              governor.record(Object.assign(marker, { kind: 'ladder-rung' as const }));
            },
            onResult: (evidence) => {
              if (dispatchClosed) return; // late detached-promise evidence: dropped (see dispatchClosed)
              // The transitional reportResult channel: sanitize (a lying
              // measurement is ZERO evidence, never a throw), mark the
              // once-only flags for the completion fold below, apply
              // DD-9, and accumulate the per-job sums.
              const sanitized = validSpendEvidence(evidence);
              if (sanitized.usage !== undefined && usageTokens(sanitized.usage) > 0) {
                reportedUsage = true;
              }
              if (sanitized.costUSD !== undefined) reportedCost = true;
              governor.observeResult(job.id, sanitized);
              foldIntoJobSums(sanitized);
            },
          },
        );
        // Captured for the settle's basis: the dispatch's ENDING decides
        // whether the charge is 'observed' (definitive verdict) or 'full'
        // (killed / indeterminate / threw — unknown status).
        outcome = ladderOutcome;
        dispatchClosed = true; // close invocation and evidence before interpretation/settlement
        return interpretOutcome(ladderOutcome, attempt);
      };

      try {
        if (governor.tripped) {
          result = queuedRefusal(governor.tripKind === 'signal');
        } else if (governor.capUsd !== undefined) {
          // RESERVE-THEN-SETTLE (W2.3): the dispatch holds a reservation —
          // `settled + outstanding + reserved ≤ C` from the gate's grant
          // until settle. The proposal is the fair share C/concurrency; the
          // gate shrinks it to the remaining capacity or parks FIFO behind
          // outstanding settles.
          const capUsd = governor.capUsd;
          const reserved = await governor.reserve(
            job.id,
            admission.attempt,
            capUsd / opts.concurrency,
            classifyDispatch(),
          );
          if (reserved.outcome === 'tripped') {
            // A trip while parked on reservation capacity: the same refusal
            // shape as the slot-wait refusal, decided by the trip kind.
            result = queuedRefusal(governor.tripKind === 'signal');
          } else {
            const granted = reserved.reservation;
            // WRITE-AHEAD (A12b): the reservation is DURABLE before the op
            // runs. A hard crash after this line and before the settle is
            // exactly the spend-behind-a-crash window W2.2 could not see —
            // the next fold charges the reservation in full and quarantines
            // the job. If the write FAILS, the write-ahead fact never
            // landed: the dispatch never starts, the governor-side hold is
            // abandoned (no charge, no settle journal entry — nothing ran),
            // and the journal failure propagates (a hole in the write-ahead
            // sequence is a loud run stop, never a silent dispatch).
            await emitDurable({
              type: 'reservation-opened',
              runId,
              at: now(),
              jobId: job.id,
              op: job.op,
              attempt: admission.attempt,
              reservationId: `${runId}:${granted.id}`,
              usd: granted.usd,
              class: granted.class,
              ...(granted.proposedUsd !== undefined ? { proposedUsd: granted.proposedUsd } : {}),
            }).catch((err: unknown) => {
              governor.abandonReservation(granted);
              throw err;
            });
            reservation = granted;
            // Durable write-ahead, then ownership fence, then dispatch.
            // A lost fence leaves the durable reservation unresolved for
            // full loss charging/quarantine on resume, without invocation.
            await fenceInvocation();
            try {
              result = await runDispatchLadder(admission.attempt);
            } catch (err) {
              dispatchClosed = true; // a 'threw' outcome escapes interpretOutcome — closed here
              throwIfFailed(); // infrastructure failures reject the run, not an OpResult
              result = { status: 'failed', error: messageOf(err) };
            }
          }
        } else {
          // UNCAPPED (reservation-less): the W2.2 dispatch unchanged —
          // evidence folds roll the ledger and the token cap binds; there is
          // no USD capacity to hold a reservation against.
          await fenceInvocation();
          try {
            result = await runDispatchLadder(admission.attempt);
          } catch (err) {
            dispatchClosed = true; // same as above
            throwIfFailed();
            result = { status: 'failed', error: messageOf(err) };
          }
        }
      } finally {
        if (reservation !== undefined && preserveOpenedReservation) {
          // The durable opened fact behind a failed invocation fence stays
          // UNRESOLVED (ADR §2.2 step 6). Release only local capacity; resume
          // charges the durable amount in full and quarantines until release.
          governor.abandonReservation(reservation);
          reservation = undefined;
        }
        if (reservation !== undefined) {
          // SETTLE — durable BEFORE the job's outcome is journalled. The
          // basis is 'full' when the dispatch ended in UNKNOWN status
          // (killed with its detached promise, an indeterminate verdict, a
          // defensive throw — spend may exist that no fold saw): the charge
          // is at least the full reservation. Definitive verdicts settle
          // 'observed' — the charge is exactly what the evidence folds saw
          // (a pre-dispatch failure like an unknown op folds nothing and
          // settles 0). A pre-dispatch failure and a POST-invocation
          // failure (a rejecting op body, or one resolving to a value the
          // contract rejects) read identically from the verdict alone —
          // executeOp flattens both into `failed` — so the dispatch signal
          // is what keeps the second out of this branch. The slot is held
          // until the settle LANDS — and a
          // failed settle or durable write must still release it (a leaked
          // slot would hang every waiter forever on a run that is already
          // stopping loudly).
          const basis: 'observed' | 'full' =
            outcome === undefined ||
            outcome.outcome === 'killed' ||
            outcome.outcome === 'threw' ||
            dispatchUnknown ||
            (outcome.outcome === 'completed' && outcome.value.status === 'indeterminate')
              ? 'full'
              : 'observed';
          try {
            settledCharge = governor.settle(reservation, {
              basis,
              ...(jobUsage !== undefined ? { usage: jobUsage } : {}),
            });
            await emitDurable({
              type: 'reservation-settled',
              runId,
              at: now(),
              jobId: job.id,
              reservationId: `${runId}:${reservation.id}`,
              charged: settledCharge.charged,
              basis,
              // PRICE PRESENCE (H2/DD-9): the journal distinguishes a
              // legitimate zero-priced lane (costUSD: 0 observed) from
              // unpriced spend, so the resume fold's DD-9 seed check
              // `charged === 0 && usage > 0 && !priced` never hard-stops a
              // priced-at-zero history.
              ...(settledCharge.priced ? { priced: true } : {}),
              ...(jobUsage !== undefined ? { usage: jobUsage } : {}),
            });
          } finally {
            reservation = undefined;
            governor.releaseSlot();
          }
        } else {
          governor.releaseSlot();
        }
      }

      if (opts.stopOnError && result.status !== 'ok') stop.requested = true;
      await emit({
        type: 'job-finished',
        runId,
        at: now(),
        jobId: job.id,
        opId: job.op,
        inputsHash: job.inputsHash,
        result,
        ...(jobUsage !== undefined ? { usage: jobUsage } : {}),
        ...(jobCostUSD !== undefined ? { costUSD: jobCostUSD } : {}),
        ...(settledCharge !== undefined ? { charged: settledCharge.charged } : {}),
      });
      entries.set(job.id, {
        result,
        state: stateFromResult(result),
        origin: 'executed',
        ...(jobUsage !== undefined ? { usage: jobUsage } : {}),
        ...(jobCostUSD !== undefined ? { costUSD: jobCostUSD } : {}),
      });
    };

    const runOne = governedDispatch ? governedRunOne : plainRunOne;

    for (const wave of waveJobs) {
      if (stop.requested || runFailure !== undefined) break;
      const submissions: Array<Promise<void>> = [];
      try {
        for (const job of wave) {
          if (runFailure !== undefined) break;
          // Already classified (quarantined this run — W2.3): never dispatched,
          // the row stands as the quarantine pass set it.
          if (entries.has(job.id)) continue;
          // Ready iff every dependency ended ok (skipped-replayed jobs count as
          // done — they carry a verified prior ok).
          const ready = job.dependsOn.every((dep) => entries.get(dep)?.state === 'done');
          if (!ready) {
            // Under a signal stop the row stays UNCLASSIFIED here — it may be
            // merely unresolved (the cancel landed before its dependency could
            // dispatch), and fabricating `blocked` at dispatch time would lie
            // about it; the stop sweep below owns the classification.
            if (!cancelledRun()) {
              entries.set(job.id, {
                result: blockedResult(job),
                state: 'blocked',
                origin: 'blocked',
              });
            }
            continue;
          }
          // Replay skip: terminal ok + same op + same input hash → zero
          // invocation, outcome reconstructed from the journal event. Re-attested
          // with a finish-only event so THIS run's journal stays self-contained
          // for the next resume — copying usage AND costUSD (annex §3 rule 1;
          // the ledger seed prices a run from its own journal, so a dropped
          // costUSD would make the re-attested spend invisible).
          const prior = replay.get(job.id);
          if (
            prior !== undefined &&
            prior.opId === job.op &&
            prior.inputsHash === job.inputsHash &&
            prior.result.status === 'ok'
          ) {
            await emit({
              type: 'job-finished',
              runId,
              at: now(),
              jobId: job.id,
              opId: prior.opId,
              inputsHash: prior.inputsHash,
              result: prior.result,
              ...(prior.usage !== undefined ? { usage: prior.usage } : {}),
              ...(prior.costUSD !== undefined ? { costUSD: prior.costUSD } : {}),
            });
            entries.set(job.id, {
              result: prior.result,
              state: 'done',
              ...(prior.usage !== undefined ? { usage: prior.usage } : {}),
              ...(prior.costUSD !== undefined ? { costUSD: prior.costUSD } : {}),
              origin: 'replayed',
            });
            continue;
          }
          // Governed: a tripped budget stops dispatch (I9) — 'signal' trips
          // flow through the same gate. The job is left unclassified; the stop
          // sweep marks it queued (or blocked) and the honest-stop pass below
          // owns the budget attribution.
          if (governedDispatch && governor !== undefined && governor.tripped) {
            break;
          }
          // Catch immediately, including while the producer awaits a replay
          // emit, so no rejected job promise can become unhandled before the
          // wave's drain attaches. failRun preserves the original rejection.
          submissions.push(
            limit(async () => {
              try {
                await runOne(job);
              } catch (error) {
                failRun(error);
              }
            }),
          );
        }
      } catch (error) {
        failRun(error);
      }
      const settled = await Promise.allSettled(submissions);
      for (const result of settled) {
        if (result.status === 'rejected') failRun(result.reason as unknown);
      }
      throwIfFailed();
    }

    // --- Stop sweep: classify jobs this run never started --------------------
    // Wave order guarantees a job's dependencies are classified first. The
    // classification precedence: any dependency that definitively did not
    // succeed (failed/blocked/budget-exhausted, transitively) → blocked — the
    // job can never run THIS run, even when a sibling dependency is merely
    // queued; only all-done-or-queued dependencies → queued (dispatch never
    // happened). Budget attribution composes downstream: the honest-stop pass
    // below re-marks only rows whose non-execution is transitively
    // budget-caused, so a blocked row whose failed dep was a genuine failure
    // stays failed.
    //
    // Under a governed SIGNAL stop the `definitivelyNotOk` predicate above
    // inverts the never-classified rule: an unclassified dependency did not
    // FAIL — the run was cancelled before it could dispatch — and neither did
    // a dispatch cancelled while it waited for a slot (its result is
    // 'indeterminate'): only a definitive non-success blocks, everything else
    // stays queued (indeterminate, re-runnable on resume). The predicate is
    // evaluated NOW — after dispatching has ended, so the trip state is final
    // — which is what makes a MID-RUN cancel classify correctly (review
    // cycle 4; r1 major).
    for (const wave of waveJobs) {
      for (const job of wave) {
        if (entries.has(job.id)) continue;
        const anyNotOk = job.dependsOn.some(definitivelyNotOk);
        if (anyNotOk) {
          entries.set(job.id, {
            result: blockedResult(job),
            state: 'blocked',
            origin: 'blocked',
          });
        } else {
          entries.set(job.id, {
            result: { status: 'indeterminate', detail: 'queued: run stopped before dispatch' },
            state: 'queued',
            origin: 'queued',
          });
        }
      }
    }

    // --- Governed honest stop + re-marking (I9) ------------------------------
    // The runner knows the truth (which jobs it admitted: admittedJobIds;
    // which rows are its own never-dispatch fabrications: entry.origin), so
    // attribution needs no marker strings. A budget-family stop re-marks
    // queued/blocked rows whose non-execution is transitively budget-caused;
    // a signal stop re-marks NOTHING (a cancel is not a budget verdict).
    let stoppedEarly = false;
    let earlyStopReason: RunEarlyStopReason | undefined;
    if (governedDispatch && governor !== undefined) {
      if (governor.tripped && governor.tripKind === 'signal') {
        // Rows keep their states; the run claims the stop only when
        // undispatched work actually remains — still-queued entries, or a
        // dispatch that was admitted but cancelled while it waited for a
        // slot (its row is indeterminate, so the state scan alone misses it).
        const cancelledWhileQueued = governor.events.some(
          (event) => event.kind === 'short-circuited' && event.reason === 'cancelled-while-queued',
        );
        if (
          cancelledWhileQueued ||
          [...entries.values()].some((entry) => entry.state === 'queued')
        ) {
          stoppedEarly = true;
          earlyStopReason = 'signal';
        }
      } else {
        // Budget-family stop: the governor tripped (USD/token/unpriced), or
        // the per-run dispatch quota refused a dispatch. An 'attempt-cap' is
        // PER-JOB and deliberately absent — it gates only that job's
        // re-dispatch, never the run.
        const dispatchQuotaRefused = governor.events.some(
          (event) => event.kind === 'short-circuited' && event.reason === 'dispatch-quota',
        );
        // A12c advisory refusals are ADMISSION refusals too (ADR §2.9): the
        // refused job's own row is its terminal budget verdict, and rows
        // whose non-dispatch is transitively caused by it re-mark like any
        // other admission refusal — never fabricated `failed` rows.
        const advisoryRefused = governor.events.some(
          (event) => event.kind === 'short-circuited' && event.reason === 'advisory-lane',
        );
        // The ADMISSION-refusal terms contribute to a budget stop, with ONE
        // gate (composition review comp 1): the advisory-lane term counts
        // only while the run was NOT halted by stopOnError. A classification
        // refusal is a per-row terminal verdict, not a governor trip, so
        // when the operator's stopOnError policy halted the run on it,
        // re-marking the un-dispatched rows budget-exhausted and claiming
        // `earlyStopReason: 'budget'` would report a budget stop the
        // journal has NO budget-tripped fact for — $0 spent, no bound fired,
        // and the sibling rows would lose their re-runnable `queued` state.
        // With stopOnError false (the default) the term stands: dependents
        // re-mark transitively per ADR §2.9. The dispatch-QUOTA term is
        // W2.2's pinned budget-family semantic (its own refusal rows are
        // durable terminal evidence) and is unchanged here.
        const budgetFamilyStop =
          (governor.tripped && governor.tripKind !== 'signal') ||
          dispatchQuotaRefused ||
          (advisoryRefused && !stop.requested);
        if (budgetFamilyStop) {
          // Is this job's non-execution attributable to the budget
          // (transitively)? Memoized per jobId: a diamond dependency must
          // reuse a branch's verdict when the second branch reaches it
          // (the old withBudgetStop walk, marker-free). inProgress is a
          // cycle guard only (runPlan forbids cycles) and is never
          // memoized, so a partial walk cannot poison results.
          const depsOf = new Map<string, readonly string[]>(
            manifest.jobs.map((job) => [job.id, job.dependsOn ?? []]),
          );
          const memo = new Map<string, boolean>();
          const inProgress = new Set<string>();
          const budgetCaused = (jobId: string): boolean => {
            const memoed = memo.get(jobId);
            if (memoed !== undefined) return memoed;
            if (inProgress.has(jobId)) return false; // defensive: runPlan forbids cycles
            inProgress.add(jobId);
            const entry = entries.get(jobId);
            let caused = false;
            if (entry !== undefined) {
              if (entry.result.status === 'budget-exhausted') {
                caused = true;
              } else if (entry.origin === 'queued' && !admittedJobIds.has(jobId)) {
                // A queued-origin row without admission is the runner's own
                // never-dispatched fabrication (an op's fabricated
                // `queued: …` verdict carries origin 'executed' and never
                // re-marks).
                caused = true;
              } else if (entry.origin === 'blocked') {
                // Only the deps that actually blocked this row must be
                // budget-caused: a row is fabricated blocked when SOME dep
                // definitively did not succeed, so a succeeded (or merely
                // queued) sibling dep says nothing about the cause and must
                // not veto the re-mark (a walk over ALL deps let an ok dep
                // keep a budget-blocked row dishonestly failed).
                caused = (depsOf.get(jobId) ?? []).every(
                  (dep) => !definitivelyNotOk(dep) || budgetCaused(dep),
                );
              }
            }
            inProgress.delete(jobId);
            memo.set(jobId, caused);
            return caused;
          };
          let reMarked = false;
          for (const job of manifest.jobs) {
            const entry = entries.get(job.id);
            if (entry === undefined) continue;
            const caused =
              (entry.origin === 'queued' && !admittedJobIds.has(job.id)) ||
              (entry.origin === 'blocked' && budgetCaused(job.id));
            if (caused) {
              entries.set(job.id, {
                result: { status: 'budget-exhausted' },
                state: 'budget-exhausted',
                origin: entry.origin,
              });
              reMarked = true;
            }
          }
          // Honesty rule: the stop must have actually GATED undispatched
          // work — every row kept its real verdict (a refusal row is itself
          // terminal evidence), so there is no early stop to claim (I9).
          if (reMarked) {
            stoppedEarly = true;
            earlyStopReason = 'budget';
          }
        }
      }
    }

    // The trip EVIDENCE (ADR-0003 §2.8 budget-tripped), emitted once per run
    // just before run-finished — the durable record of which bound fired and
    // why (the honest-stop CLAIM above is the report's; this is the journal's
    // fact).
    if (governedDispatch && governor !== undefined && governor.tripped) {
      await emit({
        type: 'budget-tripped',
        runId,
        at: now(),
        tripKind: governor.tripKind ?? 'exhausted',
        reason: governor.tripReason ?? 'budget trip',
      });
    }

    await emit({
      type: 'run-finished',
      runId,
      at: now(),
      stoppedEarly,
      ...(earlyStopReason !== undefined ? { earlyStopReason } : {}),
      // The line-count check's writer half (journal.foldOrderRuns verifies).
      // +1: this run-finished line is itself part of the total — the spread
      // above is evaluated before emit() increments the counter.
      ...(runLog !== undefined ? { eventCount: journalledCount + 1 } : {}),
    });

    // --- Report ---------------------------------------------------------------
    // Deterministic row order: dispatch order over schedulable jobs, then
    // unschedulable (missing-dep) jobs in manifest order. One row per job in
    // the plan (frozen JobOutcome contract).
    const ordered: ManifestJob[] = [
      ...waveJobs.flat(),
      ...manifest.jobs.filter((job) => unschedulable.has(job.id)),
    ];
    const rows: JobOutcome[] = ordered.map((job) => {
      const entry = entries.get(job.id) as OutcomeEntry;
      return {
        jobId: job.id,
        op: job.op,
        result: entry.result,
        ...(entry.usage !== undefined ? { usage: entry.usage } : {}),
        ...(entry.costUSD !== undefined ? { costUSD: entry.costUSD } : {}),
      };
    });

    const counts = emptyCounts();
    for (const entry of entries.values()) counts[entry.state] += 1;

    // Rollups: only over jobs that reported usage, keys omitted otherwise.
    // Run-level costUSD is NOT summed from rows: the governed ledger (the
    // governor's USD rollup) is the run's cost authority and fills it below;
    // an ungoverned run never fabricates cost.
    let usage: Usage | undefined;
    const usageRows = rows.filter((row) => row.usage !== undefined);
    if (usageRows.length > 0) {
      let reasoning: number | undefined;
      let input = 0;
      let output = 0;
      let cacheRead = 0;
      let cacheWrite = 0;
      for (const row of usageRows) {
        const u = row.usage as Usage;
        input += u.input;
        output += u.output;
        cacheRead += u.cacheRead;
        cacheWrite += u.cacheWrite;
        if (u.reasoning !== undefined) reasoning = (reasoning ?? 0) + u.reasoning;
      }
      usage = {
        input,
        output,
        cacheRead,
        cacheWrite,
        ...(reasoning !== undefined ? { reasoning } : {}),
      };
    }

    return {
      runId,
      stoppedEarly,
      ...(earlyStopReason !== undefined ? { earlyStopReason } : {}),
      counts,
      jobs: rows,
      ...(usage !== undefined ? { usage } : {}),
      // The governed run's cost rollup is the LEDGER the governor observed
      // (streamed + folded, once-only) — absent when nothing was spent (a
      // fabricated 0 would claim "spent nothing"). The ungoverned-marked
      // run has no ledger and stays absent.
      ...(governedDispatch && governor !== undefined && governor.usdSpent > 0
        ? { costUSD: governor.usdSpent }
        : {}),
    };
  } finally {
    removeSignalListener?.();
  }
}
