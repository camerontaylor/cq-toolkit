// T1.2 slice 2 — tests for the plan runner (src/kernel/runner.ts).
//
// The centerpiece is THE ws-a replay check: a 10-job chain run against a
// COUNTING FAKE (shared counter object — the goal's counting-fake driver
// seam), crashed on job 5 with stopOnError, then resumed from the journal:
// jobs 1-4 skip via terminal journal records with ZERO new invocations, job 5
// (was failed) re-runs, 6-10 run — exactly 6 (and <= 6) invocations in run 2,
// and the final report counts 10 done.
//
// Also pinned here: stopOnError:false fleet collection (all 10 outcomes,
// downstream blocked), the queued/blocked counts policy for never-started
// jobs (a definitively failed dependency BLOCKS even when a sibling dep is
// merely queued), replay folding ALL prior runs of the plan per-job
// last-finish-wins (a later partial run keeps older completed jobs; a later
// failed re-attempt re-runs), a sibling plan whose id extends this one
// ('a' vs 'a--b') cannot block the resume with its corrupt journal, replay
// re-running an input-changed job (hash mismatch beats terminal ok), replay
// OFF without resume:true, unknown op / schema violation / throwing op /
// contract-violating op / non-serializable op result / throwing registry
// lookup all record honest `failed` results, the runId filename-safety assert
// applying only to journaled runs, p-limit actually caps in-flight work
// (high-water === concurrency), usage reconstruction + rollup from a
// replayed journal, and report JSON-serializability.
//
// Matcher note: bare regex literals passed as values inside toMatchObject
// are wrapped in expect.stringMatching — vitest 5.0.0's subset-compare quirk.
import { appendFile, mkdtemp, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { z } from 'zod';
import { deriveJobStatuses, openRunLog } from '../../src/kernel/journal.js';
import { makeManifest } from '../../src/kernel/manifest.js';
import { runPlan, type OpRegistryView } from '../../src/kernel/runner.js';
import type {
  JobFinishedJournalEvent,
  JournalEvent,
  Op,
  OpRegistryEntry,
  OpResult,
  Plan,
  RunReport,
} from '../../src/kernel/types.js';

// ---------------------------------------------------------------------------
// Counting fake — the driver seam: every op delegates to one shared counter
// ---------------------------------------------------------------------------

interface FakeState {
  /** Job ids in invocation order (one entry per actual op invocation). */
  calls: string[];
  inFlight: number;
  highWater: number;
  /** These jobs get a `failed` RESULT. */
  failOn: Set<string>;
  /** These jobs make the op THROW (contract-visible crash). */
  crashOn: Set<string>;
}

function makeFake(): { state: FakeState; op: (raw: unknown) => Promise<OpResult<unknown>> } {
  const state: FakeState = {
    calls: [],
    inFlight: 0,
    highWater: 0,
    failOn: new Set(),
    crashOn: new Set(),
  };
  const op = async (raw: unknown): Promise<OpResult<unknown>> => {
    const input = raw as { jobId: string };
    state.calls.push(input.jobId);
    state.inFlight += 1;
    state.highWater = Math.max(state.highWater, state.inFlight);
    try {
      // Yield so the pool genuinely overlaps work under load.
      await new Promise((resolve) => setTimeout(resolve, 2));
      if (state.crashOn.has(input.jobId)) throw new Error(`boom ${input.jobId}`);
      if (state.failOn.has(input.jobId)) return { status: 'failed', error: `nope ${input.jobId}` };
      return { status: 'ok', value: input.jobId };
    } finally {
      state.inFlight -= 1;
    }
  };
  return { state, op };
}

// Non-strict on purpose: replay tests add keys to an input to change its hash.
const jobInputSchema = z.object({ jobId: z.string() });

/** Wrap an op as a registry entry (op-contract params cast to the bottom instantiation). */
function entry(
  name: string,
  schema: z.ZodType<unknown>,
  op: (raw: unknown) => Promise<OpResult<unknown>>,
): OpRegistryEntry<never, never> {
  return {
    name,
    inputSchema: schema as unknown as z.ZodType<never>,
    importer: () => Promise.resolve(op as unknown as Op<never, never>),
  };
}

function viewWith(...entries: OpRegistryEntry<never, never>[]): OpRegistryView {
  const map = new Map(
    entries.map((candidate): [string, OpRegistryEntry<never, never>] => [
      candidate.name,
      candidate,
    ]),
  );
  return { get: (name) => map.get(name) };
}

const DEFAULT_VIEW = (): OpRegistryView => viewWith(entry('fake', jobInputSchema, makeFake().op));

/** n-job chain over the 'fake' op; input carries the job id. Job ids are `<prefix><i>` (prefix defaults to 'j'). */
function chainPlan(id: string, n: number, prefix = 'j'): Plan {
  return {
    id,
    jobs: Array.from({ length: n }, (_, i) => {
      const jobId = `${prefix}${i + 1}`;
      return i === 0
        ? { id: jobId, op: 'fake', input: { jobId } }
        : { id: jobId, op: 'fake', input: { jobId }, dependsOn: [`${prefix}${i}`] };
    }),
  };
}

/** n independent jobs (single wave) — for concurrency-pool tests. */
function independentPlan(id: string, n: number): Plan {
  return {
    id,
    jobs: Array.from({ length: n }, (_, i) => {
      const jobId = `i${i + 1}`;
      return { id: jobId, op: 'fake', input: { jobId } };
    }),
  };
}

function jobFinishes(events: JournalEvent[]): JobFinishedJournalEvent[] {
  return events.filter((event): event is JobFinishedJournalEvent => event.type === 'job-finished');
}

/** All six frozen counts keys, for order-insensitive key assertions. */
const SIX_STATES = ['blocked', 'budget-exhausted', 'done', 'failed', 'queued', 'running'].sort();

describe('runPlan — ws-a replay resume (the goal check)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cq-runner-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('10-chain crashed on job 5 resumes with exactly 6 new invocations and ends 10/10 done', async () => {
    const { state, op } = makeFake();
    const registry = viewWith(entry('fake', jobInputSchema, op));
    const plan = chainPlan('plan-wsa', 10);
    state.crashOn.add('j5');

    // --- Run 1: crash on job 5, stopOnError ---
    const report1 = await runPlan(
      plan,
      { concurrency: 1, stopOnError: true, journalDir: dir },
      registry,
    );
    expect(state.calls).toEqual(['j1', 'j2', 'j3', 'j4', 'j5']); // 6-10 never started
    expect(report1.counts).toEqual({
      queued: 0,
      running: 0,
      blocked: 5, // j6..j10: transitively downstream of the failed j5
      done: 4,
      failed: 1,
      'budget-exhausted': 0,
    });
    // Journal run 1: 4 ok + 1 failed terminal records.
    const log = openRunLog(dir);
    const events1 = await log.read(report1.runId);
    const finishes1 = jobFinishes(events1);
    expect(finishes1).toHaveLength(5);
    expect(finishes1.filter((event) => event.result.status === 'ok')).toHaveLength(4);
    expect(finishes1.filter((event) => event.result.status === 'failed')).toHaveLength(1);
    expect(events1[0]).toMatchObject({ type: 'run-started', planId: 'plan-wsa' });
    expect(events1[events1.length - 1]).toMatchObject({
      type: 'run-finished',
      stoppedEarly: false,
    });

    // --- Run 2: resume with the fake fixed ---
    state.calls = [];
    state.crashOn.clear();
    const report2 = await runPlan(
      plan,
      { concurrency: 1, stopOnError: true, journalDir: dir, resume: true },
      registry,
    );
    // jobs 1-4 skip via terminal records with ZERO new invocations; job 5
    // (was failed) re-runs; 6-10 run. Exactly 6 — and the <= 6 bound.
    expect(state.calls).toEqual(['j5', 'j6', 'j7', 'j8', 'j9', 'j10']);
    expect(state.calls.length).toBe(6);
    expect(state.calls.length).toBeLessThanOrEqual(6);
    expect(report2.counts.done).toBe(10);
    expect(report2.counts.failed).toBe(0);
    expect(report2.jobs).toHaveLength(10);
    expect(report2.jobs.map((row) => row.jobId)).toEqual(
      Array.from({ length: 10 }, (_, i) => `j${i + 1}`),
    );
    expect(report2.jobs.every((row) => row.result.status === 'ok')).toBe(true);
    // No job reported usage → the optional rollups are omitted entirely.
    expect('usage' in report2).toBe(false);
    expect('costUSD' in report2).toBe(false);

    // Run 2's journal is self-contained: 6 dispatches, 10 terminal records
    // (jobs 1-4 re-attested from run 1's evidence after hash verification).
    const events2 = await log.read(report2.runId);
    expect(events2.filter((event) => event.type === 'job-started')).toHaveLength(6);
    expect(jobFinishes(events2)).toHaveLength(10);

    // --- Run 3: a chained resume skips everything (latest-run rule holds) ---
    state.calls = [];
    const report3 = await runPlan(
      plan,
      { concurrency: 1, stopOnError: true, journalDir: dir, resume: true },
      registry,
    );
    expect(state.calls).toEqual([]);
    expect(report3.counts.done).toBe(10);
  });
});

describe('runPlan — execution semantics', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cq-runner-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('stopOnError:false collects everything — downstream of a failure is blocked, all 10 outcomes present', async () => {
    const { state, op } = makeFake();
    state.failOn.add('j3');
    const report = await runPlan(
      chainPlan('plan-fleet', 10),
      { concurrency: 4, stopOnError: false, journalDir: dir },
      viewWith(entry('fake', jobInputSchema, op)),
    );
    expect(state.calls).toEqual(['j1', 'j2', 'j3']); // j4+ blocked, never invoked
    expect(report.jobs).toHaveLength(10);
    expect(report.counts).toEqual({
      queued: 0,
      running: 0,
      blocked: 7,
      done: 2,
      failed: 1,
      'budget-exhausted': 0,
    });
    const j4 = report.jobs.find((row) => row.jobId === 'j4');
    expect(j4?.result).toMatchObject({
      status: 'failed',
      error: expect.stringMatching(/blocked: dependency 'j3'/),
    });
  });

  test('never-started jobs: queued when deps are fine, blocked when a dependency failed (counts policy)', async () => {
    // Two independent chains; a1 fails with concurrency 2 so b1 (same wave,
    // in flight) still completes. Wave 2 never dispatches: a2 is downstream
    // of the failure (blocked), b2's dependency finished ok (queued).
    const { state, op } = makeFake();
    state.failOn.add('a1');
    const plan: Plan = {
      id: 'plan-stop',
      jobs: [
        { id: 'a1', op: 'fake', input: { jobId: 'a1' } },
        { id: 'a2', op: 'fake', input: { jobId: 'a2' }, dependsOn: ['a1'] },
        { id: 'b1', op: 'fake', input: { jobId: 'b1' } },
        { id: 'b2', op: 'fake', input: { jobId: 'b2' }, dependsOn: ['b1'] },
      ],
    };
    const report = await runPlan(
      plan,
      { concurrency: 2, stopOnError: true, journalDir: dir },
      viewWith(entry('fake', jobInputSchema, op)),
    );
    expect(state.calls.sort()).toEqual(['a1', 'b1']);
    expect(report.counts).toEqual({
      queued: 1, // b2: deps fine, dispatch never happened
      running: 0,
      blocked: 1, // a2: dependency a1 failed
      done: 1, // b1
      failed: 1, // a1
      'budget-exhausted': 0,
    });
    const a2 = report.jobs.find((row) => row.jobId === 'a2');
    const b2 = report.jobs.find((row) => row.jobId === 'b2');
    expect(a2?.result).toMatchObject({
      status: 'failed',
      error: expect.stringMatching(/blocked: dependency 'a1'/),
    });
    expect(b2?.result).toMatchObject({
      status: 'indeterminate',
      detail: expect.stringMatching(/queued: run stopped before dispatch/),
    });
  });

  test('stop sweep precedence: a failed dep beats a queued dep (blocked, not queued)', async () => {
    // c depends on [a1, b2]: a1 definitively failed, b2 is merely queued. The
    // failed dep means c can NEVER run → blocked (old code classified c
    // queued via anyQueued, and the error could name the queued sibling b2).
    const { state, op } = makeFake();
    state.failOn.add('a1');
    const plan: Plan = {
      id: 'plan-sweep-precedence',
      jobs: [
        { id: 'a1', op: 'fake', input: { jobId: 'a1' } },
        { id: 'b1', op: 'fake', input: { jobId: 'b1' } },
        { id: 'b2', op: 'fake', input: { jobId: 'b2' }, dependsOn: ['b1'] },
        { id: 'c', op: 'fake', input: { jobId: 'c' }, dependsOn: ['a1', 'b2'] },
      ],
    };
    const report = await runPlan(
      plan,
      { concurrency: 2, stopOnError: true, journalDir: dir },
      viewWith(entry('fake', jobInputSchema, op)),
    );
    // Wave 1 runs a1 (fails → stop) and b1 (ok, in flight); waves 2-3 never
    // dispatch, so b2 stays queued and c is classified in the sweep.
    expect(state.calls.sort()).toEqual(['a1', 'b1']);
    expect(report.counts).toEqual({
      queued: 1, // b2: all-done deps, dispatch never happened
      running: 0,
      blocked: 1, // c: a1 definitively failed
      done: 1, // b1
      failed: 1, // a1
      'budget-exhausted': 0,
    });
    // The error names the FAILED dep, not the queued sibling.
    expect(report.jobs.find((row) => row.jobId === 'c')?.result).toMatchObject({
      status: 'failed',
      error: expect.stringMatching(/blocked: dependency 'a1' did not succeed/),
    });
  });

  test('dependency on a job missing from the plan is blocked, not a crash (transitive)', async () => {
    const { state, op } = makeFake();
    const plan: Plan = {
      id: 'plan-missing-dep',
      jobs: [
        { id: 'a', op: 'fake', input: { jobId: 'a' } },
        { id: 'b', op: 'fake', input: { jobId: 'b' }, dependsOn: ['ghost'] },
        { id: 'c', op: 'fake', input: { jobId: 'c' }, dependsOn: ['b'] },
      ],
    };
    const report = await runPlan(
      plan,
      { concurrency: 2, stopOnError: false },
      viewWith(entry('fake', jobInputSchema, op)),
    );
    expect(state.calls).toEqual(['a']);
    expect(report.counts).toEqual({
      queued: 0,
      running: 0,
      blocked: 2,
      done: 1,
      failed: 0,
      'budget-exhausted': 0,
    });
    expect(report.jobs.find((row) => row.jobId === 'b')?.result).toMatchObject({
      status: 'failed',
      error: expect.stringMatching(/dependency 'ghost' missing from plan/),
    });
    expect(report.jobs.find((row) => row.jobId === 'c')?.result).toMatchObject({
      status: 'failed',
      error: expect.stringMatching(/blocked/),
    });
  });

  test('dependency cycle throws (plan corruption fails loudly, nothing journaled)', async () => {
    const plan: Plan = {
      id: 'plan-cycle',
      jobs: [
        { id: 'a', op: 'fake', input: { jobId: 'a' }, dependsOn: ['b'] },
        { id: 'b', op: 'fake', input: { jobId: 'b' }, dependsOn: ['a'] },
      ],
    };
    await expect(
      runPlan(plan, { concurrency: 1, stopOnError: false }, DEFAULT_VIEW()),
    ).rejects.toThrow(/cycle/);
  });

  test('resume:true without journalDir throws before anything is generated or journaled', async () => {
    const { state, op } = makeFake();
    await expect(
      runPlan(
        chainPlan('plan-nojournaldir', 2),
        { concurrency: 1, stopOnError: false, resume: true }, // no journalDir
        viewWith(entry('fake', jobInputSchema, op)),
      ),
    ).rejects.toThrow(/resume: true requires journalDir/);
    expect(state.calls).toEqual([]); // no op ever ran
  });

  test('duplicate plan job ids throw before anything runs or is journaled', async () => {
    const { state, op } = makeFake();
    const plan: Plan = {
      id: 'plan-dup',
      jobs: [
        { id: 'a', op: 'fake', input: { jobId: 'a' } },
        { id: 'a', op: 'fake', input: { jobId: 'a-again' } }, // duplicate
        { id: 'b', op: 'fake', input: { jobId: 'b' }, dependsOn: ['a'] },
      ],
    };
    await expect(
      runPlan(
        plan,
        { concurrency: 1, stopOnError: false, journalDir: dir },
        viewWith(entry('fake', jobInputSchema, op)),
      ),
    ).rejects.toThrow(/duplicate job id 'a'/);
    expect(state.calls).toEqual([]); // zero invocations
    // Nothing journaled: the rejection happened before the run existed.
    await expect(openRunLog(dir).runs()).resolves.toEqual([]);
  });

  test('journal-less runs accept any schema-valid plan id (filename assert only when journaling)', async () => {
    // PlanSchema.id is any string; without a journalDir there is no file name
    // and no resume key, so the filesystem-safety assert must not fire.
    const { state, op } = makeFake();
    const plan: Plan = {
      id: 'plan in-mem ω',
      jobs: [{ id: 'a', op: 'fake', input: { jobId: 'a' } }],
    };
    const report = await runPlan(
      plan,
      { concurrency: 1, stopOnError: false },
      viewWith(entry('fake', jobInputSchema, op)),
    );
    expect(report.runId.startsWith('plan in-mem ω--')).toBe(true);
    expect(state.calls).toEqual(['a']); // jobs execute
  });

  test('journaled runs still reject a non-filesystem-safe plan id before any op runs', async () => {
    // Journaled runIds become file names and resume keys, so they stay
    // asserted — loudly, before the run exists.
    const { state, op } = makeFake();
    const plan: Plan = {
      id: 'plan in-mem ω',
      jobs: [{ id: 'a', op: 'fake', input: { jobId: 'a' } }],
    };
    await expect(
      runPlan(
        plan,
        { concurrency: 1, stopOnError: false, journalDir: dir },
        viewWith(entry('fake', jobInputSchema, op)),
      ),
    ).rejects.toThrow(/runId must match/);
    expect(state.calls).toEqual([]); // no op ever ran
    // Nothing journaled: the rejection happened before the run existed.
    await expect(openRunLog(dir).runs()).resolves.toEqual([]);
  });

  test('unknown op name fails that job at execution time with a clear error', async () => {
    const plan: Plan = {
      id: 'plan-ghost-op',
      jobs: [{ id: 'a', op: 'ghost', input: { jobId: 'a' } }],
    };
    const report = await runPlan(plan, { concurrency: 1, stopOnError: false }, DEFAULT_VIEW());
    expect(report.counts.failed).toBe(1);
    expect(report.jobs[0]?.result).toEqual({
      status: 'failed',
      error: "unknown op 'ghost'",
    });
  });

  test('inputSchema violation records failed with the zod message', async () => {
    const plan: Plan = {
      id: 'plan-bad-input',
      jobs: [{ id: 'a', op: 'numbered', input: { n: 'not-a-number' } }],
    };
    const registry = viewWith(
      entry('numbered', z.object({ n: z.number() }).strict(), async () => {
        throw new Error('op must never run');
      }),
    );
    const report = await runPlan(plan, { concurrency: 1, stopOnError: false }, registry);
    expect(report.counts.failed).toBe(1);
    expect(report.jobs[0]?.result.status).toBe('failed');
    expect((report.jobs[0]?.result as { error: string }).error).toMatch(/number/i);
  });

  test('a throwing op records failed with the throw message (contract violation, run survives)', async () => {
    const plan: Plan = {
      id: 'plan-boom',
      jobs: [{ id: 'a', op: 'fake', input: { jobId: 'a' } }],
    };
    const registry = viewWith(
      entry('fake', jobInputSchema, async () => {
        throw new Error('kaboom');
      }),
    );
    const report = await runPlan(plan, { concurrency: 1, stopOnError: false }, registry);
    expect(report.jobs[0]?.result).toEqual({ status: 'failed', error: 'kaboom' });
    expect(report.counts.failed).toBe(1);
  });

  test('an op returning a non-OpResult is a contract violation, recorded as failed', async () => {
    const plan: Plan = {
      id: 'plan-garbage',
      jobs: [{ id: 'a', op: 'fake', input: { jobId: 'a' } }],
    };
    const registry = viewWith(
      entry('fake', jobInputSchema, async () => 42 as unknown as OpResult<unknown>),
    );
    const report = await runPlan(plan, { concurrency: 1, stopOnError: false }, registry);
    expect(report.jobs[0]?.result).toMatchObject({
      status: 'failed',
      error: expect.stringMatching(/violated the op contract/),
    });
  });

  test('a non-serializable op result is an honest per-job failure (run and journal survive)', async () => {
    // OpResultSchema's value is z.unknown(), so a BigInt result passes the
    // shape check but cannot survive JSON.stringify at the journal append —
    // it must come back as THIS job's failure, not kill the run at the emit.
    const { op } = makeFake();
    const registry = viewWith(
      entry('bigint', jobInputSchema, async () => ({ status: 'ok', value: 1n })),
      entry('fake', jobInputSchema, op),
    );
    const plan: Plan = {
      id: 'plan-bigint',
      jobs: [
        { id: 'j1', op: 'bigint', input: { jobId: 'j1' } },
        { id: 'j2', op: 'fake', input: { jobId: 'j2' } },
      ],
    };
    const report = await runPlan(
      plan,
      { concurrency: 2, stopOnError: false, journalDir: dir }, // exercises the append path
      registry,
    );
    expect(report.jobs.find((row) => row.jobId === 'j1')?.result).toMatchObject({
      status: 'failed',
      error: expect.stringMatching(/non-serializable/),
    });
    expect(report.jobs.find((row) => row.jobId === 'j2')?.result).toEqual({
      status: 'ok',
      value: 'j2',
    });
    expect(report.counts).toEqual({
      queued: 0,
      running: 0,
      blocked: 0,
      done: 1,
      failed: 1,
      'budget-exhausted': 0,
    });
    // The journaled failure line is valid: the file still reads cleanly.
    const events = await openRunLog(dir).read(report.runId);
    expect(jobFinishes(events).find((event) => event.jobId === 'j1')?.result).toMatchObject({
      status: 'failed',
    });
  });

  test('a NaN-carrying op result is non-serializable too (NaN would journal as null)', async () => {
    // JSON.stringify silently rewrites NaN/Infinity to null — the journal
    // would then disagree with the value the run produced, and replay would
    // consume the falsified form. The serializability probe rejects
    // non-finite numbers, so this is an honest per-job failure.
    const { op } = makeFake();
    const registry = viewWith(
      entry('nan', jobInputSchema, async () => ({ status: 'ok', value: { score: NaN } })),
      entry('fake', jobInputSchema, op),
    );
    const plan: Plan = {
      id: 'plan-nan',
      jobs: [
        { id: 'j1', op: 'nan', input: { jobId: 'j1' } },
        { id: 'j2', op: 'fake', input: { jobId: 'j2' } },
      ],
    };
    const report = await runPlan(
      plan,
      { concurrency: 2, stopOnError: false, journalDir: dir },
      registry,
    );
    expect(report.jobs.find((row) => row.jobId === 'j1')?.result).toMatchObject({
      status: 'failed',
      error: expect.stringMatching(/non-serializable.*non-finite/s),
    });
    expect(report.counts.done).toBe(1); // j2 unaffected — the run continues
    const events = await openRunLog(dir).read(report.runId);
    expect(jobFinishes(events).find((event) => event.jobId === 'j1')?.result).toMatchObject({
      status: 'failed',
    });
  });

  test('silently-lossy op results are rejected: Map, Date, function member, undefined array hole, symbol key, hidden toJSON, hidden member', async () => {
    // Each of these stringifies WITHOUT throwing but the journal line would
    // disagree with the value the op returned (Map → {}, Date → ISO string,
    // function members vanish, undefined array elements → null).
    const { op } = makeFake();
    const registry = viewWith(
      entry('map-op', jobInputSchema, async () => ({ status: 'ok', value: new Map([['a', 1]]) })),
      entry('date-op', jobInputSchema, async () => ({ status: 'ok', value: new Date(0) })),
      entry('fn-op', jobInputSchema, async () => ({
        status: 'ok',
        value: { compute: () => 1 },
      })),
      entry('hole-op', jobInputSchema, async () => {
        const holey: unknown[] = [1];
        holey[2] = 3; // index 1 left undefined — stringify would null it
        return { status: 'ok', value: holey } as { status: 'ok'; value: unknown };
      }),
      entry('symbol-op', jobInputSchema, async () => ({
        status: 'ok',
        value: { x: 1, [Symbol('hidden')]: 2 } as unknown,
      })),
      entry('tojson-op', jobInputSchema, async () => {
        const hooked = { x: 1 };
        Object.defineProperty(hooked, 'toJSON', {
          value: () => ({ x: 2 }),
          enumerable: false,
        });
        return { status: 'ok', value: hooked } as { status: 'ok'; value: unknown };
      }),
      entry('hidden-op', jobInputSchema, async () => {
        const withHidden = { x: 1 };
        Object.defineProperty(withHidden, 'secret', { value: 3, enumerable: false });
        return { status: 'ok', value: withHidden } as { status: 'ok'; value: unknown };
      }),
      entry('arr-tojson-op', jobInputSchema, async () => {
        const hooked = [1];
        Object.defineProperty(hooked, 'toJSON', { value: () => ({ x: 2 }), enumerable: false });
        return { status: 'ok', value: hooked } as { status: 'ok'; value: unknown };
      }),
      entry('arr-extra-op', jobInputSchema, async () => {
        const withExtra = [1];
        (withExtra as unknown as { extra: string }).extra = 'gone';
        return { status: 'ok', value: withExtra } as { status: 'ok'; value: unknown };
      }),
      entry('fake', jobInputSchema, op),
    );
    const plan: Plan = {
      id: 'plan-lossy',
      jobs: [
        { id: 'm', op: 'map-op', input: { jobId: 'm' } },
        { id: 'd', op: 'date-op', input: { jobId: 'd' } },
        { id: 'f', op: 'fn-op', input: { jobId: 'f' } },
        { id: 'h', op: 'hole-op', input: { jobId: 'h' } },
        { id: 's', op: 'symbol-op', input: { jobId: 's' } },
        { id: 't', op: 'tojson-op', input: { jobId: 't' } },
        { id: 'n', op: 'hidden-op', input: { jobId: 'n' } },
        { id: 'at', op: 'arr-tojson-op', input: { jobId: 'at' } },
        { id: 'ax', op: 'arr-extra-op', input: { jobId: 'ax' } },
        { id: 'ok1', op: 'fake', input: { jobId: 'ok1' } },
      ],
    };
    const report = await runPlan(
      plan,
      { concurrency: 5, stopOnError: false, journalDir: dir },
      registry,
    );
    const failureOf = (id: string): string =>
      (report.jobs.find((row) => row.jobId === id)?.result as { error?: string }).error ?? '';
    expect(failureOf('m')).toMatch(/non-serializable.*non-plain object of type 'Map'/);
    expect(failureOf('d')).toMatch(/non-serializable.*non-plain object of type 'Date'/);
    expect(failureOf('f')).toMatch(/non-serializable.*non-JSON value of type 'function'/);
    expect(failureOf('h')).toMatch(/non-serializable.*undefined array element/);
    // The hidden-key family (PR #31 review, Codex P1 + review-debt #76):
    // stringify DROPS the symbol key, INVOKES the hidden toJSON (the
    // journal would reconstruct x:2 while the walk accepted x:1), and
    // never sees the non-enumerable member.
    expect(failureOf('s')).toMatch(/non-serializable.*symbol-keyed own member/s);
    expect(failureOf('t')).toMatch(/non-serializable.*non-enumerable own 'toJSON'/s);
    expect(failureOf('n')).toMatch(/non-serializable.*non-enumerable own member 'secret'/s);
    expect(failureOf('at')).toMatch(/non-serializable.*own 'toJSON' on an array/s);
    expect(failureOf('ax')).toMatch(/non-serializable.*non-index own member 'extra' on an array/s);
    expect(report.counts.failed).toBe(9);
    expect(report.counts.done).toBe(1); // the run continues
  });

  test("an ok result whose value is undefined is rejected — the journal requires ok's value", async () => {
    // The frozen ok variant carries a REQUIRED value: a journaled
    // {status:'ok'} without one fails JournalEventSchema on read. Undefined
    // is therefore lossy here (not absent data) and must be an honest
    // per-job failure — never a journal line that cannot be replayed.
    const { op } = makeFake();
    const registry = viewWith(
      entry(
        'absent',
        jobInputSchema,
        async () =>
          ({
            status: 'ok',
            value: undefined,
          }) as OpResult<unknown>,
      ),
      entry('fake', jobInputSchema, op),
    );
    const plan: Plan = {
      id: 'plan-absent-value',
      jobs: [
        { id: 'j1', op: 'absent', input: { jobId: 'j1' } },
        { id: 'j2', op: 'fake', input: { jobId: 'j2' } },
      ],
    };
    const report = await runPlan(
      plan,
      { concurrency: 2, stopOnError: false, journalDir: dir },
      registry,
    );
    expect(report.jobs.find((row) => row.jobId === 'j1')?.result).toMatchObject({
      status: 'failed',
      error: expect.stringMatching(/non-serializable.*without a 'value'/),
    });
    expect(report.counts.done).toBe(1); // j2 unaffected — the run continues
    // Every journaled line still reads back cleanly.
    const events = await openRunLog(dir).read(report.runId);
    expect(jobFinishes(events).find((event) => event.jobId === 'j1')?.result).toMatchObject({
      status: 'failed',
    });
  });

  test('a throwing registry lookup records failed with the throw message (run survives)', async () => {
    // A registry backend that throws on read must fail THIS job, not reject
    // the whole runPlan call ('this function never throws' holds).
    const cursedView: OpRegistryView = {
      get(name: string) {
        if (name === 'cursed') throw new Error('registry backend offline');
        return undefined; // other names stay plain unknown ops
      },
    };
    const plan: Plan = {
      id: 'plan-cursed-registry',
      jobs: [
        { id: 'j1', op: 'cursed', input: { jobId: 'j1' } },
        { id: 'j2', op: 'ghost', input: { jobId: 'j2' } },
      ],
    };
    const report = await runPlan(plan, { concurrency: 2, stopOnError: false }, cursedView);
    expect(report.jobs.find((row) => row.jobId === 'j1')?.result).toMatchObject({
      status: 'failed',
      error: expect.stringMatching(
        /registry lookup for op 'cursed' failed: registry backend offline/,
      ),
    });
    expect(report.jobs.find((row) => row.jobId === 'j2')?.result).toEqual({
      status: 'failed',
      error: "unknown op 'ghost'",
    });
    expect(report.counts.failed).toBe(2);
  });

  test('concurrency is the one knob: in-flight high-water equals it under load', async () => {
    const { state, op } = makeFake();
    await runPlan(
      independentPlan('plan-pool', 9),
      { concurrency: 3, stopOnError: false },
      viewWith(entry('fake', jobInputSchema, op)),
    );
    expect(state.highWater).toBe(3);
    expect(state.calls).toHaveLength(9);

    const single = makeFake();
    await runPlan(
      independentPlan('plan-pool-1', 6),
      { concurrency: 1, stopOnError: false },
      viewWith(entry('fake', jobInputSchema, single.op)),
    );
    expect(single.state.highWater).toBe(1);
  });

  test('counts mapping for needs-human/indeterminate results (documented freeze workaround)', async () => {
    const plan: Plan = {
      id: 'plan-taxonomy',
      jobs: [
        { id: 'a', op: 'nh', input: { jobId: 'a' } },
        { id: 'b', op: 'ind', input: { jobId: 'b' } },
      ],
    };
    const registry = viewWith(
      entry('nh', jobInputSchema, async () => ({ status: 'needs-human', reason: 'human please' })),
      entry('ind', jobInputSchema, async () => ({ status: 'indeterminate', detail: 'lost' })),
    );
    const report = await runPlan(plan, { concurrency: 2, stopOnError: false }, registry);
    // needs-human → blocked (waiting on a human); indeterminate → failed.
    // The ROWS keep the true taxonomy statuses.
    expect(report.counts).toEqual({
      queued: 0,
      running: 0,
      blocked: 1,
      done: 0,
      failed: 1,
      'budget-exhausted': 0,
    });
    expect(report.jobs[0]?.result.status).toBe('needs-human');
    expect(report.jobs[1]?.result.status).toBe('indeterminate');
  });

  test('an empty plan runs to an empty, honest report', async () => {
    const report = await runPlan(
      { id: 'plan-empty', jobs: [] },
      { concurrency: 1, stopOnError: false },
      DEFAULT_VIEW(),
    );
    expect(report.jobs).toEqual([]);
    expect(report.counts).toEqual({
      queued: 0,
      running: 0,
      blocked: 0,
      done: 0,
      failed: 0,
      'budget-exhausted': 0,
    });
  });
});

describe('runPlan — report shape and replay details', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cq-runner-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('report is JSON-serializable, counts carry all six states, honest-stop untouched', async () => {
    const { op } = makeFake();
    const report = await runPlan(
      chainPlan('plan-shape', 3),
      { concurrency: 2, stopOnError: false, journalDir: dir },
      viewWith(entry('fake', jobInputSchema, op)),
    );
    const roundTripped = JSON.parse(JSON.stringify(report)) as RunReport;
    expect(roundTripped).toEqual(report);
    expect(Object.keys(report.counts).sort()).toEqual(SIX_STATES);
    expect(report.stoppedEarly).toBe(false);
    expect('earlyStopReason' in report).toBe(false);
    expect(report.runId).toMatch(/^plan-shape--/);
  });

  test('journaled events are fold-ready: attempt 1, opId+inputsHash match the manifest', async () => {
    const { op } = makeFake();
    const plan = chainPlan('plan-fold', 2);
    const report = await runPlan(
      plan,
      { concurrency: 1, stopOnError: false, journalDir: dir },
      viewWith(entry('fake', jobInputSchema, op)),
    );
    const events = await openRunLog(dir).read(report.runId);
    const manifest = makeManifest(plan);
    const starts = events.filter((event) => event.type === 'job-started');
    expect(starts).toHaveLength(2);
    for (const start of starts) {
      expect(start).toMatchObject({ attempt: 1, runId: report.runId, op: 'fake' });
    }
    const finishes = jobFinishes(events);
    for (const finish of finishes) {
      const job = manifest.jobs.find((candidate) => candidate.id === finish.jobId);
      expect(finish.opId).toBe('fake');
      expect(finish.inputsHash).toBe(job?.inputsHash);
    }
    // The shared fold derives done for every executed job.
    expect(deriveJobStatuses(events)).toEqual([
      { jobId: 'j1', state: 'done' },
      { jobId: 'j2', state: 'done' },
    ]);
  });

  test('replay re-runs a job whose INPUT changed — hash mismatch beats terminal ok', async () => {
    const { state, op } = makeFake();
    const plan = chainPlan('plan-hash', 3);
    await runPlan(
      plan,
      { concurrency: 1, stopOnError: false, journalDir: dir },
      viewWith(entry('fake', jobInputSchema, op)),
    );

    state.calls = [];
    // j2's input changes (extra key → different hash); j1 and j3 keep theirs.
    const changed: Plan = {
      id: 'plan-hash',
      jobs: [
        { id: 'j1', op: 'fake', input: { jobId: 'j1' } },
        { id: 'j2', op: 'fake', input: { jobId: 'j2', v: 2 }, dependsOn: ['j1'] },
        { id: 'j3', op: 'fake', input: { jobId: 'j3' }, dependsOn: ['j2'] },
      ],
    };
    const report = await runPlan(
      changed,
      { concurrency: 1, stopOnError: false, journalDir: dir, resume: true },
      viewWith(entry('fake', jobInputSchema, op)),
    );
    // Per-job rule: only j2 re-runs. j3's own record is terminal-ok with an
    // unchanged hash, so it is attested even though its dependency re-ran.
    expect(state.calls).toEqual(['j2']);
    expect(report.counts.done).toBe(3);
    // The re-run result reflects the fresh dispatch (fake echoes the job id).
    expect(report.jobs[1]?.result).toEqual({ status: 'ok', value: 'j2' });
  });

  test('replay without resume:true starts a fresh run (no skipping)', async () => {
    const { state, op } = makeFake();
    const plan = chainPlan('plan-fresh', 3);
    const report1 = await runPlan(
      plan,
      { concurrency: 1, stopOnError: false, journalDir: dir },
      viewWith(entry('fake', jobInputSchema, op)),
    );

    state.calls = [];
    const report2 = await runPlan(
      plan,
      { concurrency: 1, stopOnError: false, journalDir: dir }, // no resume
      viewWith(entry('fake', jobInputSchema, op)),
    );
    expect(state.calls).toEqual(['j1', 'j2', 'j3']);
    expect(report2.runId).not.toBe(report1.runId);
    const log = openRunLog(dir);
    await expect(log.runs()).resolves.toHaveLength(2);
  });

  test('resume with no prior run for the plan just runs fresh', async () => {
    const { state, op } = makeFake();
    const report = await runPlan(
      chainPlan('plan-noprior', 2),
      { concurrency: 1, stopOnError: false, journalDir: dir, resume: true },
      viewWith(entry('fake', jobInputSchema, op)),
    );
    expect(state.calls).toEqual(['j1', 'j2']);
    expect(report.counts.done).toBe(2);
  });

  test('two plans share one journalDir: resuming A skips only A; B stays untouched', async () => {
    const { state, op } = makeFake();
    const registry = viewWith(entry('fake', jobInputSchema, op));
    // Distinct job-id prefixes so a wrong plan match could not silently skip.
    const planA = chainPlan('plan-alpha', 3, 'a');
    const planB = chainPlan('plan-beta', 3, 'b');
    const reportA1 = await runPlan(
      planA,
      { concurrency: 1, stopOnError: false, journalDir: dir },
      registry,
    );
    const reportB1 = await runPlan(
      planB,
      { concurrency: 1, stopOnError: false, journalDir: dir }, // B's run is NEWER
      registry,
    );
    const log = openRunLog(dir);
    const eventsB1 = await log.read(reportB1.runId);
    // Force deterministic mtimes (real resolution can tie); A2's file gets a
    // real (far later) mtime, so it must sort last.
    const at = (ms: number): Date => new Date(ms);
    await utimes(join(dir, `${reportA1.runId}.ndjson`), at(1000), at(1000));
    await utimes(join(dir, `${reportB1.runId}.ndjson`), at(2000), at(2000));
    const runsBefore = await log.runs();
    expect(runsBefore).toEqual([reportA1.runId, reportB1.runId]);

    // Resume A: only A has prior records for jobs a1..a3 — all skip, zero
    // invocations; B's journal file is byte-identical afterwards.
    state.calls = [];
    const reportA2 = await runPlan(
      planA,
      { concurrency: 1, stopOnError: false, journalDir: dir, resume: true },
      registry,
    );
    expect(state.calls).toEqual([]);
    expect(reportA2.counts.done).toBe(3);
    await expect(log.runs()).resolves.toEqual([...runsBefore, reportA2.runId]);
    await expect(log.read(reportB1.runId)).resolves.toEqual(eventsB1);
    // A's new run attested all three skips without dispatching.
    const eventsA2 = await log.read(reportA2.runId);
    expect(eventsA2.filter((event) => event.type === 'job-started')).toHaveLength(0);
    expect(jobFinishes(eventsA2)).toHaveLength(3);
    // Sanity: the two fresh runs really were distinct files.
    expect(reportA1.runId).not.toBe(reportB1.runId);
  });

  test('torn tail composes with resume: a crashed run with a torn last line resumes cleanly', async () => {
    const { state, op } = makeFake();
    const registry = viewWith(entry('fake', jobInputSchema, op));
    const plan = chainPlan('plan-torn-resume', 8);
    state.crashOn.add('j5');
    const report1 = await runPlan(
      plan,
      { concurrency: 1, stopOnError: true, journalDir: dir },
      registry,
    );
    // Simulate a crash mid-append on run 1's journal file (torn LAST line).
    await appendFile(join(dir, `${report1.runId}.ndjson`), '{"type":"run-finis', 'utf8');

    state.calls = [];
    state.crashOn.clear();
    const report2 = await runPlan(
      plan,
      { concurrency: 1, stopOnError: true, journalDir: dir, resume: true },
      registry,
    );
    // Torn line ignored; the failed job (j5) plus the unstarted ones (j6-j8)
    // re-ran — exactly 4 invocations; everything ends done.
    expect(state.calls).toEqual(['j5', 'j6', 'j7', 'j8']);
    expect(state.calls.length).toBe(4);
    expect(report2.counts.done).toBe(8);
    expect(report2.counts.failed).toBe(0);
  });

  test("resume keeps older runs' completed jobs when the latest run is partial", async () => {
    const { state, op } = makeFake();
    const registry = viewWith(entry('fake', jobInputSchema, op));
    const plan = independentPlan('plan-partial', 3);
    const report1 = await runPlan(
      plan,
      { concurrency: 3, stopOnError: false, journalDir: dir },
      registry,
    );
    expect(report1.counts.done).toBe(3);

    // Hand-append a PARTIAL run 2 — run-started, a job-started for i1, no
    // finish, no run-finished: a crash mid-run. The hand-built runId follows
    // the `<planId>--<base36>--<hex>` shape so the resume pre-filter passes
    // it, and its run-started `at` is stamped AFTER run 1's real clock so
    // the fold (ordered by `at`, not mtime) treats it as the latest run.
    const log = openRunLog(dir);
    const partialRunId = `${plan.id}--partial--deadbeef`;
    await log.append(partialRunId, {
      type: 'run-started',
      runId: partialRunId,
      at: new Date(Date.now() + 1000).toISOString(), // strictly after run 1 started
      planId: plan.id,
    });
    await log.append(partialRunId, {
      type: 'job-started',
      runId: partialRunId,
      at: '2026-01-01T00:00:01.000Z',
      jobId: 'i1',
      op: 'fake',
      attempt: 1,
    });
    // Force mtime ordering: run 1's file old, the partial run 2 newest — the
    // LATEST run really is the partial one.
    const at = (ms: number): Date => new Date(ms);
    await utimes(join(dir, `${report1.runId}.ndjson`), at(1000), at(1000));
    await utimes(join(dir, `${partialRunId}.ndjson`), at(2000), at(2000));

    // Resume: the partial latest run must not erase run 1's completed jobs —
    // zero re-invocations (old code re-ran all three), all rows reconstructed.
    state.calls = [];
    const report2 = await runPlan(
      plan,
      { concurrency: 3, stopOnError: false, journalDir: dir, resume: true },
      registry,
    );
    expect(state.calls).toEqual([]);
    expect(report2.counts.done).toBe(3);
    expect(report2.jobs.every((row) => row.result.status === 'ok')).toBe(true);
  });

  test('last finish wins across runs: a failed re-attempt in a later run re-runs despite an older ok', async () => {
    const { state, op } = makeFake();
    const registry = viewWith(entry('fake', jobInputSchema, op));
    const plan = independentPlan('plan-lastwin', 3);
    const report1 = await runPlan(
      plan,
      { concurrency: 3, stopOnError: false, journalDir: dir },
      registry,
    );
    expect(report1.counts.done).toBe(3);

    // A later run re-attempted i2 and it FAILED there; i1/i3 were untouched.
    const log = openRunLog(dir);
    const laterRunId = `${plan.id}--reattempt--beefdead`;
    const manifest = makeManifest(plan);
    const i2Hash = manifest.jobs.find((job) => job.id === 'i2')?.inputsHash ?? '';
    await log.append(laterRunId, {
      type: 'run-started',
      runId: laterRunId,
      at: new Date(Date.now() + 1000).toISOString(), // strictly after run 1 started
      planId: plan.id,
    });
    await log.append(laterRunId, {
      type: 'job-finished',
      runId: laterRunId,
      at: '2026-01-01T00:00:01.000Z',
      jobId: 'i2',
      opId: 'fake',
      inputsHash: i2Hash,
      result: { status: 'failed', error: 're-attempt blew up' },
    });
    await log.append(laterRunId, {
      type: 'run-finished',
      runId: laterRunId,
      at: '2026-01-01T00:00:02.000Z',
      stoppedEarly: false,
    });
    const at = (ms: number): Date => new Date(ms);
    await utimes(join(dir, `${report1.runId}.ndjson`), at(1000), at(1000));
    await utimes(join(dir, `${laterRunId}.ndjson`), at(2000), at(2000));

    // Resume: the later FAILED finish overrides run 1's ok for i2 (it
    // re-runs); i1/i3 keep their older oks and skip. All end done.
    state.calls = [];
    const report2 = await runPlan(
      plan,
      { concurrency: 3, stopOnError: false, journalDir: dir, resume: true },
      registry,
    );
    expect(state.calls).toEqual(['i2']);
    expect(report2.counts.done).toBe(3);
    expect(report2.counts.failed).toBe(0);
  });

  test('the fold is ordered by run-started `at`, not mtime (concurrent-run safety)', async () => {
    // Two hand-built runs of one plan with DELIBERATELY contradictory
    // orderings: mtime says r2 (failed j1) is newest, but r1 (ok j1) started
    // LATER by its own `at`. The fold must follow `at` — r1's ok wins, so
    // the resume skips j1; mtime order would have re-run it.
    const { state, op } = makeFake();
    const registry = viewWith(entry('fake', jobInputSchema, op));
    const plan: Plan = {
      id: 'plan-atorder',
      jobs: [{ id: 'j1', op: 'fake', input: { jobId: 'j1' } }],
    };
    const hash = makeManifest(plan).jobs[0]?.inputsHash ?? '';
    const log = openRunLog(dir);
    const run1 = `${plan.id}--r1--aaaa`; // started LATER (at 2026-01-02), finished ok
    const run2 = `${plan.id}--r2--bbbb`; // started EARLIER (at 2026-01-01), failed j1
    await log.append(run1, {
      type: 'run-started',
      runId: run1,
      at: '2026-01-02T00:00:00.000Z',
      planId: plan.id,
    });
    await log.append(run1, {
      type: 'job-finished',
      runId: run1,
      at: '2026-01-02T00:00:01.000Z',
      jobId: 'j1',
      opId: 'fake',
      inputsHash: hash,
      result: { status: 'ok', value: 'j1' },
    });
    await log.append(run2, {
      type: 'run-started',
      runId: run2,
      at: '2026-01-01T00:00:00.000Z',
      planId: plan.id,
    });
    await log.append(run2, {
      type: 'job-finished',
      runId: run2,
      at: '2026-01-01T00:00:01.000Z',
      jobId: 'j1',
      opId: 'fake',
      inputsHash: hash,
      result: { status: 'failed', error: 'older attempt blew up' },
    });
    // mtime: run2 NEWEST (2000) — the trap mtime-based folding would fall into.
    const at = (ms: number): Date => new Date(ms);
    await utimes(join(dir, `${run1}.ndjson`), at(1000), at(1000));
    await utimes(join(dir, `${run2}.ndjson`), at(2000), at(2000));

    state.calls = [];
    const report = await runPlan(
      plan,
      { concurrency: 1, stopOnError: false, journalDir: dir, resume: true },
      registry,
    );
    expect(state.calls).toEqual([]); // the by-`at` winner (ok) is honored
    expect(report.counts.done).toBe(1);
  });

  test('case-insensitive runId tails still count as this-plan evidence', async () => {
    // An operator-copied journal with an uppercase hex tail ('A3F2') is
    // well-formed evidence for the plan: the candidate filter is
    // case-insensitive, so it is parsed, its planId matched, and its
    // terminal-ok finish honored (zero re-invocations on resume).
    const { state, op } = makeFake();
    const registry = viewWith(entry('fake', jobInputSchema, op));
    const plan: Plan = {
      id: 'plan-tail',
      jobs: [{ id: 'j1', op: 'fake', input: { jobId: 'j1' } }],
    };
    const hash = makeManifest(plan).jobs[0]?.inputsHash ?? '';
    const log = openRunLog(dir);
    const copiedRunId = 'plan-tail--r7--A3F2';
    await log.append(copiedRunId, {
      type: 'run-started',
      runId: copiedRunId,
      at: '2026-01-01T00:00:00.000Z',
      planId: plan.id,
    });
    await log.append(copiedRunId, {
      type: 'job-finished',
      runId: copiedRunId,
      at: '2026-01-01T00:00:01.000Z',
      jobId: 'j1',
      opId: 'fake',
      inputsHash: hash,
      result: { status: 'ok', value: 'j1' },
    });

    state.calls = [];
    const report = await runPlan(
      plan,
      { concurrency: 1, stopOnError: false, journalDir: dir, resume: true },
      registry,
    );
    expect(state.calls).toEqual([]);
    expect(report.counts.done).toBe(1);
  });

  test("a sibling plan whose id extends this one ('a' vs 'a--b') cannot block the resume", async () => {
    const { state, op } = makeFake();
    const registry = viewWith(entry('fake', jobInputSchema, op));
    const planA = chainPlan('a', 2);
    const reportA1 = await runPlan(
      planA,
      { concurrency: 1, stopOnError: false, journalDir: dir },
      registry,
    );

    // Hand-write plan 'a--b''s journal: valid first/last lines around a
    // corrupt MIDDLE line. A prefix-only candidate filter would parse this
    // file when resuming plan 'a' and die on the corruption.
    const bogusId = 'a--b--k3y--c0ffee';
    await appendFile(
      join(dir, `${bogusId}.ndjson`),
      `${JSON.stringify({
        type: 'run-started',
        runId: bogusId,
        at: '2026-01-01T00:00:00.000Z',
        planId: 'a--b',
      })}\n{"type":"job-started","runI\n${JSON.stringify({
        type: 'run-finished',
        runId: bogusId,
        at: '2026-01-01T00:00:02.000Z',
        stoppedEarly: false,
      })}\n`,
      'utf8',
    );
    // Plan a's file is oldest so candidate iteration is deterministic.
    const at = (ms: number): Date => new Date(ms);
    await utimes(join(dir, `${reportA1.runId}.ndjson`), at(1000), at(1000));
    await utimes(join(dir, `${bogusId}.ndjson`), at(2000), at(2000));

    // Resume plan 'a': the 'a--b' file fails the two-segment tail check
    // ('b--k3y--c0ffee' is not `<base36>--<hex>`) and is never parsed —
    // old code rejected with /corrupt line/. Jobs all skip.
    state.calls = [];
    const reportA2 = await runPlan(
      planA,
      { concurrency: 1, stopOnError: false, journalDir: dir, resume: true },
      registry,
    );
    expect(state.calls).toEqual([]);
    expect(reportA2.counts.done).toBe(2);

    // Plan 'a--b''s OWN corrupt journal is loud (its runId legitimately
    // passes the pre-filter, so read() throws on the corrupt middle line).
    const planB: Plan = {
      id: 'a--b',
      jobs: [{ id: 'b1', op: 'fake', input: { jobId: 'b1' } }],
    };
    await expect(
      runPlan(
        planB,
        { concurrency: 1, stopOnError: false, journalDir: dir, resume: true },
        registry,
      ),
    ).rejects.toThrow(/corrupt line/);
  });

  test('replayed outcomes reconstruct usage and roll it up (usage only ever comes from the journal)', async () => {
    const { state, op } = makeFake();
    const plan: Plan = {
      id: 'plan-usage',
      jobs: [{ id: 'j1', op: 'fake', input: { jobId: 'j1' } }],
    };
    const manifest = makeManifest(plan);
    const log = openRunLog(dir);
    const priorRunId = 'plan-usage--prior--beef';
    await log.append(priorRunId, {
      type: 'run-started',
      runId: priorRunId,
      at: '2026-01-01T00:00:00.000Z',
      planId: 'plan-usage',
    });
    await log.append(priorRunId, {
      type: 'job-finished',
      runId: priorRunId,
      at: '2026-01-01T00:00:01.000Z',
      jobId: 'j1',
      opId: 'fake',
      inputsHash: manifest.jobs[0]?.inputsHash ?? '',
      result: { status: 'ok', value: { jobId: 'j1' } },
      usage: { input: 3, output: 4, cacheRead: 1, cacheWrite: 2 },
    });
    await log.append(priorRunId, {
      type: 'run-finished',
      runId: priorRunId,
      at: '2026-01-01T00:00:02.000Z',
      stoppedEarly: false,
    });

    const report = await runPlan(
      plan,
      { concurrency: 1, stopOnError: false, journalDir: dir, resume: true },
      viewWith(entry('fake', jobInputSchema, op)),
    );
    expect(state.calls).toEqual([]); // zero op invocation
    expect(report.jobs[0]?.usage).toEqual({ input: 3, output: 4, cacheRead: 1, cacheWrite: 2 });
    expect(report.usage).toEqual({ input: 3, output: 4, cacheRead: 1, cacheWrite: 2 });
    expect('costUSD' in report).toBe(false); // no job reported cost → omitted
    expect('reasoning' in (report.usage as { reasoning?: number })).toBe(false);
  });

  test('journal-less runs (no journalDir) produce the same report semantics', async () => {
    const { state, op } = makeFake();
    const plan = chainPlan('plan-mem', 3);
    const memory = await runPlan(
      plan,
      { concurrency: 2, stopOnError: false },
      viewWith(entry('fake', jobInputSchema, op)),
    );
    const { state: state2, op: op2 } = makeFake();
    const journaled = await runPlan(
      plan,
      { concurrency: 2, stopOnError: false, journalDir: dir },
      viewWith(entry('fake', jobInputSchema, op2)),
    );
    expect(memory.runId).toMatch(/^plan-mem--/);
    expect(memory.counts).toEqual(journaled.counts);
    expect(memory.jobs.map((row) => [row.jobId, row.result])).toEqual(
      journaled.jobs.map((row) => [row.jobId, row.result]),
    );
    expect(state.calls).toEqual(state2.calls);
  });
});
