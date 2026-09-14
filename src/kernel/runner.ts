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
// EVERY prior run of this plan in the dir, ordered by each run's run-started
// `at` (ties by runId — deterministic, mtime-independent), with
// per-job LAST-FINISH-WINS. Candidate pre-filter: only files whose runId
// carries this plan's exact `<planId>--` prefix AND whose remainder is the
// exact two-segment runId tail (`<base36>--<hex>` — so plan 'a' does not
// match plan 'a--b''s files) are even PARSED (a corrupt journal of ANOTHER
// plan cannot block this plan's resume), and the run-started event's planId
// is the exact semantic matcher (the frozen RunStartedJournalEvent DOES
// carry planId). Folding ALL runs — not just the latest — is the
// resume-safety point: a later PARTIAL run (crash mid-run) contributes no
// finishes of its own, so it cannot erase older runs' completed jobs (which
// would re-execute non-idempotent ops); a later failed re-attempt does
// override an older ok, per-job last finish wins. A job whose latest prior
// job-finished has result `ok` AND opId === job.op AND inputsHash === the
// manifest hash is SKIPPED: zero op invocation, its JobOutcome reconstructed
// from that journal event. Everything else re-runs — continue-from-first-
// failure emerges naturally. Skipped jobs are RE-ATTESTED in the new run with
// a job-finished event (no job-started — no dispatch happened), copying
// opId/inputsHash/result/usage after hash verification: each run's journal is
// then self-contained, so the fold rule survives chained resumes.
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
//   - jobs never started (stopOnError): blocked when some dependency
//     definitively did not succeed (transitively) — even when a sibling
//     dependency is merely queued (a definitively failed dep means the job
//     can never run) — otherwise queued ("not yet dispatched" — exactly true
//     for them). running is always 0 in a returned report (everything
//     awaited).
//   - never-run rows still appear in jobs[] (the frozen JobOutcome doc says
//     one row per job in the plan): blocked rows carry
//     {status:'failed', error:'blocked: …'} and queued rows
//     {status:'indeterminate', detail:'queued: …'} — the least-dishonest
//     taxonomy values for "did not run".
//
// Row order is deterministic: dispatch order (topo wave order, in-wave
// manifest order; replay-skipped jobs keep their slot), unschedulable
// (missing-dep) jobs last in manifest order.
//
// opts.maxUsd and opts.maxTokens are advisory and untouched here (USD stays
// derived; T1.3 owns budget enforcement for BOTH caps and honest-stop: this
// runner always reports stoppedEarly: false with no earlyStopReason).
import pLimit from 'p-limit';
import { randomBytes } from 'node:crypto';
import { assertSafeRunId, candidateRunsForPlan, openRunLog, type RunLog } from './journal.js';
import { makeManifest, topoOrder, type ManifestJob } from './manifest.js';
import { OpResultSchema } from './schema.js';
import type { Usage } from '../driver/types.js';
import type {
  JobFinishedJournalEvent,
  JobOutcome,
  JobState,
  JournalEvent,
  OpRegistryEntry,
  OpResult,
  Plan,
  RunCounts,
  RunOptions,
  RunReport,
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
type EntryOrigin = 'executed' | 'replayed' | 'blocked' | 'queued';

interface OutcomeEntry {
  result: OpResult<unknown>;
  state: JobState;
  /** Per-job usage rollup — only ever sourced from a replayed journal event. */
  usage?: Usage;
  origin: EntryOrigin;
}

/** Error message of an unknown throwable, for `failed` results. */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * JSON-LOSSLESSNESS check for op results (the journal line is a JSON.stringify
 * of the result; replay reconstructs from that line). stringify-throwing
 * values (BigInt, circular) are caught by the stringify probe; this walk
 * catches the SILENTLY lossy ones — Map/Set/Date/RegExp/class instances
 * stringify as `{}` or strings, function/symbol members vanish, undefined
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
        for (let i = 0; i < value.length; i++) {
          const element = value[i];
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
      for (const memberValue of Object.values(value)) {
        if (memberValue === undefined) continue; // absent-key semantics
        assertJsonLossless(memberValue);
      }
      return;
    }
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
 * an honest `failed` OpResult. This function never throws, so a bad op (or a
 * bad registry) can never corrupt the journal or kill the run.
 */
async function executeOp(
  job: Pick<ManifestJob, 'op' | 'input'>,
  lookup: (op: string) => OpRegistryEntry<never, never> | undefined,
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
  try {
    const op = await entry.importer();
    const raw: OpResult<unknown> = await op(parsed as never);
    // Validate before journaling: the journal only accepts real OpResults, so
    // a contract-violating return must be caught HERE, not blow up the append.
    const checked = OpResultSchema.safeParse(raw);
    if (!checked.success) {
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
    // function/symbol members, undefined array elements). See
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

/**
 * Run one plan to completion (or honest early stop) and return its report.
 * See the header for the full contract.
 */
export async function runPlan(
  plan: Plan,
  opts: RunOptions,
  registry: OpRegistryView,
): Promise<RunReport> {
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

  const runId = makeRunId(plan.id, opts.journalDir !== undefined);
  const manifest = makeManifest(plan);
  const jobById = new Map<string, ManifestJob>(
    manifest.jobs.map((job): [string, ManifestJob] => [job.id, job]),
  );

  // One journal surface for both modes: events are ALWAYS produced through
  // the same emit call sites in the same order; with a journalDir they are
  // validated + appended to `<runId>.ndjson`, otherwise the sink is a no-op.
  // Journal-less runs keep the identical event-SEQUENCE semantics without
  // buffering an unconsumed array — the journaled file is the record (no
  // caller or test consumes an in-memory list). The fold over the sequence —
  // journal deriveJobStatuses over a journaled run's file — is
  // mode-independent by construction.
  const runLog: RunLog | undefined = opts.journalDir !== undefined ? openRunLog(opts.journalDir) : undefined;
  const emit = async (event: JournalEvent): Promise<void> => {
    if (runLog) await runLog.append(runId, event);
  };

  // --- Replay: fold EVERY prior run of this plan, per-job last-finish-wins --
  const replay = new Map<string, JobFinishedJournalEvent>();
  if (opts.resume === true && runLog) {
    // Shared candidate pre-filter (journal.candidateRunsForPlan — the same
    // helper governor.seedFromRunLog uses): runIds embed the plan id
    // (`<planId>--<timestamp>--<random>`) and must carry the exact
    // two-segment tail, so only THIS plan's files are ever parsed — a planId
    // that merely extends this one ('a' vs 'a--b') cannot slip in, and a
    // corrupt middle line in ANOTHER plan's journal cannot block THIS plan's
    // resume. The run-started planId check below remains the semantic
    // matcher for every file that IS parsed.
    const candidates = candidateRunsForPlan(await runLog.runs(), plan.id);
    // Parse every candidate, then order the fold by each run's run-started
    // `at` (ties broken by runId) — NOT by mtime: mtime reflects the last
    // append and can be perturbed or tied under concurrent runs, while `at`
    // is the run's own claim about when it started. With that order the
    // per-job LAST finish wins — within a run (retries append later
    // finishes) and ACROSS runs: a later partial run contributes only the
    // jobs it actually finished, so it cannot erase older runs' completed
    // jobs; a later failed re-attempt DOES override an older ok.
    const folded: Array<{ at: string; runId: string; events: JournalEvent[] }> = [];
    for (const priorRunId of candidates) {
      const priorEvents = await runLog.read(priorRunId);
      let priorPlanId: string | undefined;
      let startedAt: string | undefined;
      for (const event of priorEvents) {
        if (event.type === 'run-started' && startedAt === undefined) startedAt = event.at;
        if (event.type === 'run-started') priorPlanId = event.planId;
      }
      if (priorPlanId !== plan.id || startedAt === undefined) continue;
      folded.push({ at: startedAt, runId: priorRunId, events: priorEvents });
    }
    folded.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.runId < b.runId ? -1 : 1));
    for (const prior of folded) {
      for (const event of prior.events) {
        if (event.type === 'job-finished') replay.set(event.jobId, event);
      }
    }
    // No prior run for this plan → fresh run; nothing to replay.
  }

  // --- Scheduling: missing-dep pre-pass, then waves over the remainder -----
  const jobIds = new Set(jobById.keys());
  const unschedulable = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const job of manifest.jobs) {
      if (unschedulable.has(job.id)) continue;
      const missingDep = job.dependsOn.find(
        (dep) => !jobIds.has(dep) || unschedulable.has(dep),
      );
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

  // blocked rows for jobs whose dependency chain is broken from the start.
  const entries = new Map<string, OutcomeEntry>();
  for (const job of manifest.jobs) {
    if (!unschedulable.has(job.id)) continue;
    const missing = job.dependsOn.find((dep) => !jobIds.has(dep));
    entries.set(job.id, {
      result: {
        status: 'failed',
        error: missing !== undefined
          ? `blocked: dependency '${missing}' missing from plan`
          : 'blocked: upstream dependency did not succeed',
      },
      state: 'blocked',
      origin: 'blocked',
    });
  }

  await emit({ type: 'run-started', runId, at: now(), planId: plan.id });

  // --- Execute waves through one pool, EXACTLY opts.concurrency in flight --
  const limit = pLimit(opts.concurrency);
  const stop = { requested: false };

  const runOne = async (job: ManifestJob): Promise<void> => {
    // p-limit starts queued tasks when a slot frees; re-check the stop flag at
    // actual start so "do not START any further jobs" holds while in-flight
    // ones still complete.
    if (stop.requested) return;

    await emit({
      type: 'job-started',
      runId,
      at: now(),
      jobId: job.id,
      op: job.op,
      attempt: 1, // retries are T1.3; every dispatch this goal is attempt 1
    });

    const result = await executeOp(job, (name) => registry.get(name));

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

  const blockedResult = (job: ManifestJob): OpResult<unknown> => {
    // Name a dependency that DEFINITIVELY did not succeed (failed/blocked/
    // budget-exhausted), not a merely queued sibling still awaiting dispatch.
    // Both call sites guarantee such a dep exists (wave: the job was not
    // ready; sweep: anyNotOk), so the first find always hits.
    const notOk = job.dependsOn.find((dep) => {
      const state = entries.get(dep)?.state;
      return state !== 'done' && state !== 'queued';
    });
    return {
      status: 'failed',
      error: `blocked: dependency '${notOk}' did not succeed`,
    };
  };

  for (const wave of waveJobs) {
    if (stop.requested) break;
    const submissions: Array<Promise<void>> = [];
    for (const job of wave) {
      // Ready iff every dependency ended ok (skipped-replayed jobs count as
      // done — they carry a verified prior ok).
      const ready = job.dependsOn.every((dep) => entries.get(dep)?.state === 'done');
      if (!ready) {
        entries.set(job.id, { result: blockedResult(job), state: 'blocked', origin: 'blocked' });
        continue;
      }
      // Replay skip: terminal ok + same op + same input hash → zero
      // invocation, outcome reconstructed from the journal event. Re-attested
      // with a finish-only event so THIS run's journal stays self-contained
      // for the next resume.
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
        });
        entries.set(job.id, {
          result: prior.result,
          state: 'done',
          ...(prior.usage !== undefined ? { usage: prior.usage } : {}),
          origin: 'replayed',
        });
        continue;
      }
      submissions.push(limit(() => runOne(job)));
    }
    await Promise.all(submissions);
  }

  // --- Stop sweep: classify jobs this run never started --------------------
  // Wave order guarantees a job's dependencies are classified first. The
  // classification precedence: any dependency that definitively did not
  // succeed (failed/blocked/budget-exhausted, transitively) → blocked — the
  // job can never run THIS run, even when a sibling dependency is merely
  // queued; only all-done-or-queued dependencies → queued (dispatch never
  // happened). Budget attribution composes downstream: withBudgetStop
  // re-marks only rows whose non-execution is transitively budget-caused,
  // so a blocked row whose failed dep was a genuine failure stays failed.
  for (const wave of waveJobs) {
    for (const job of wave) {
      if (entries.has(job.id)) continue;
      const depStates = job.dependsOn.map((dep) => entries.get(dep)?.state);
      // undefined (no entry) counts as not-ok — honest.
      const anyNotOk = depStates.some((state) => state !== 'done' && state !== 'queued');
      if (anyNotOk) {
        entries.set(job.id, { result: blockedResult(job), state: 'blocked', origin: 'blocked' });
      } else {
        entries.set(job.id, {
          result: { status: 'indeterminate', detail: 'queued: run stopped before dispatch' },
          state: 'queued',
          origin: 'queued',
        });
      }
    }
  }

  await emit({ type: 'run-finished', runId, at: now(), stoppedEarly: false });

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
    };
  });

  const counts = emptyCounts();
  for (const entry of entries.values()) counts[entry.state] += 1;

  // Rollups: only over jobs that reported usage, keys omitted otherwise.
  // Per-job/run costUSD is NOT computed here: cost is derived by the
  // price-map layer (T1.4) from usage — runPlan never fabricates cost
  // (frozen journal events carry usage only). RunReport keeps its optional
  // costUSD field for that layer.
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
    usage = { input, output, cacheRead, cacheWrite, ...(reasoning !== undefined ? { reasoning } : {}) };
  }

  return {
    runId,
    stoppedEarly: false, // honest-stop is T1.3's; this goal never claims it
    counts,
    jobs: rows,
    ...(usage !== undefined ? { usage } : {}),
  };
}
