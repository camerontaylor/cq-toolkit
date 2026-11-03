// Split from runner-governed.test.ts (owner-mandated file-size split).
// Governed journal v2 + resume — journal v2 claims: seq/mkdir, attempt continuation, the ungoverned
// marker opt-in (and its no-history refusal).
// Pure move: shared fixtures live in runner-governed.helpers.ts.

import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  ACQUISITION_STEP_MS,
  journalEnclosure,
  refusalOf,
  runPlan,
  settleFixtureWork,
  entry,
  viewWith,
  independentPlan,
  okOp,
  countingOp,
  jobFinishes,
  jobStarts,
} from './runner-governed.helpers.js';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { GovernanceOptInRefusedError } from '../../src/kernel/errors.js';
import { currentJobContext, createGovernor } from '../../src/kernel/governor.js';
import { acquirePlanLock, openRunLog } from '../../src/kernel/journal.js';
import { type OpResult, type Plan } from '../../src/kernel/types.js';

// ---------------------------------------------------------------------------
// 5. Journal v2 + resume
// ---------------------------------------------------------------------------

describe('governed journal v2 + resume', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cq-runner-governed-'));
  });

  afterEach(async () => {
    await settleFixtureWork();
    await rm(dir, { recursive: true, force: true });
  }, ACQUISITION_STEP_MS + 5_000);

  test(
    'a governed run writes run-started with journalVersion 2, seq 1 and the governance block',
    async () => {
      const governor = createGovernor({ maxUsd: 5 });
      const USAGE = { input: 4, output: 2, cacheRead: 0, cacheWrite: 0 };
      const spendy = async (): Promise<OpResult<unknown>> => {
        currentJobContext()?.reportResult({ usage: USAGE, costUSD: 0.25 });
        return { status: 'ok', value: 'done' };
      };
      const report = await runPlan(
        independentPlan('plan-gov-journal', 1, 'spendy'),
        { concurrency: 1, stopOnError: false, journalDir: dir },
        viewWith(entry('spendy', spendy)),
        { governor, allowAdvisory: true },
      );
      const events = await openRunLog(dir).read(report.runId);
      expect(events[0]).toMatchObject({
        type: 'run-started',
        planId: 'plan-gov-journal',
        journalVersion: 2,
        seq: 1,
        governance: { capUsd: 5, attended: false },
      });
      // The per-job ledger rollups ride the job-finished event.
      const finishes = jobFinishes(events);
      expect(finishes[0]).toMatchObject({ jobId: 'j1', usage: USAGE, costUSD: 0.25 });
      // The run-finished coupling (schema-enforced) stays honest.
      expect(events[events.length - 1]).toMatchObject({
        type: 'run-finished',
        stoppedEarly: false,
      });
      // The seq claim leaves its tombstone.
      const listing = await readdir(dir);
      expect(listing.some((name) => name === 'plan-gov-journal.seq.1')).toBe(true);
    },
    journalEnclosure(1),
  );

  test(
    'a governed run over a NOT-YET-EXISTING journal dir creates it (the seq claim mkdirs)',
    async () => {
      // The v1 append path created the journal dir lazily on first write; the
      // v2 seq claim (exclusive create) runs BEFORE any append, so it must
      // carry the same lazy-create contract — a first governed run with a
      // fresh `--journal-dir` is the CLI's ordinary case.
      const freshDir = join(dir, 'fresh-sub');
      const report = await runPlan(
        independentPlan('plan-gov-fresh-dir', 1, 'ok'),
        { concurrency: 1, stopOnError: false, journalDir: freshDir },
        viewWith(entry('ok', okOp)),
        { governor: createGovernor({ maxUsd: 5 }), allowAdvisory: true },
      );
      const events = await openRunLog(freshDir).read(report.runId);
      expect(events[0]).toMatchObject({ type: 'run-started', journalVersion: 2, seq: 1 });
    },
    journalEnclosure(1),
  );

  test(
    'a governed resume continues attempt numbers (seeded fold → admission attempt 2)',
    async () => {
      const calls: string[] = [];
      let behave: 'fail' | 'ok' = 'fail';
      const flaky = async (raw: unknown): Promise<OpResult<unknown>> => {
        calls.push((raw as { jobId: string }).jobId);
        return behave === 'fail' ? { status: 'failed', error: 'flake' } : okOp(raw);
      };
      const plan: Plan = {
        id: 'plan-gov-attempt',
        jobs: [{ id: 'j1', op: 'flaky', input: { jobId: 'j1' } }],
      };
      const report1 = await runPlan(
        plan,
        { concurrency: 1, stopOnError: false, journalDir: dir },
        viewWith(entry('flaky', flaky)),
        { governor: createGovernor({ maxUsd: 5 }), allowAdvisory: true },
      );
      const log = openRunLog(dir);
      expect(jobStarts(await log.read(report1.runId)).map((event) => event.attempt)).toEqual([1]);

      // Resume with the op fixed: the runner folds run 1, seeds attempt 1, so
      // this dispatch IS attempt 2.
      behave = 'ok';
      const report2 = await runPlan(
        plan,
        { concurrency: 1, stopOnError: false, journalDir: dir, resume: true },
        viewWith(entry('flaky', flaky)),
        { governor: createGovernor({ maxUsd: 5 }), allowAdvisory: true },
      );
      expect(calls).toEqual(['j1', 'j1']);
      const events2 = await log.read(report2.runId);
      expect(events2[0]).toMatchObject({ type: 'run-started', journalVersion: 2, seq: 2 });
      expect(jobStarts(events2).map((event) => event.attempt)).toEqual([2]);
      expect(report2.counts.done).toBe(1);
    },
    journalEnclosure(2),
  );

  test(
    'an UNGOVERNED run over governed history refuses; the opt-in marks the run ungoverned',
    async () => {
      const governor1 = createGovernor({ maxUsd: 5 });
      const report1 = await runPlan(
        independentPlan('plan-gov-mark', 1),
        { concurrency: 1, stopOnError: false, journalDir: dir },
        viewWith(entry('fake', okOp)),
        { governor: governor1, allowAdvisory: true },
      );
      expect(report1.counts.done).toBe(1);
      expect(await openRunLog(dir).runs()).toHaveLength(1);

      // Ungoverned over governed history → refusal, before anything is
      // written. Typed (ADR-0003 §2.9): the class is what the CLI's exit-2
      // mapping reads, so it is pinned beside the message contract.
      const calls: string[] = [];
      const refusal = await refusalOf(
        runPlan(
          independentPlan('plan-gov-mark', 1),
          { concurrency: 1, stopOnError: false, journalDir: dir, resume: true },
          viewWith(entry('fake', countingOp(calls))),
        ),
      );
      expect(refusal).toBeInstanceOf(GovernanceOptInRefusedError);
      expect((refusal as Error).message).toBe(
        'runPlan: plan plan-gov-mark has governed history; run governed or pass --opt-in budget.ungovernedOverGoverned',
      );
      expect(calls).toEqual([]);
      expect(await openRunLog(dir).runs()).toHaveLength(1); // nothing claimed or emitted

      // The opt-in runs UNGOVERNED-MARKED: no admission, no caps, ops execute
      // exactly as the ungoverned path — and the marker is journalled.
      const markerGovernor = createGovernor({});
      const report2 = await runPlan(
        independentPlan('plan-gov-mark', 1),
        { concurrency: 1, stopOnError: false, journalDir: dir },
        viewWith(entry('fake', countingOp(calls))),
        { governor: markerGovernor, optIn: ['budget.ungovernedOverGoverned'], allowAdvisory: true },
      );
      expect(calls).toEqual(['j1']); // the op ran ungoverned
      expect(markerGovernor.events.filter((event) => event.kind === 'admitted')).toEqual([]);
      const events2 = await openRunLog(dir).read(report2.runId);
      expect(events2[0]).toMatchObject({
        type: 'run-started',
        journalVersion: 2,
        seq: 2,
        ungoverned: { optIn: true },
      });
      expect('governance' in (events2[0] as { governance?: unknown })).toBe(false);
      expect(jobStarts(events2).map((event) => event.attempt)).toEqual([1]); // ungoverned attempt
    },
    journalEnclosure(3),
  );

  test('caps + budget.ungovernedOverGoverned refuse — the marker cannot carry unenforceable caps (cycle 2)', async () => {
    // The ungoverned marker dispatches with NO admission, so caps riding it
    // would be silently dead config — fail closed naming both resolutions.
    const calls: string[] = [];
    for (const cap of [{ maxUsd: 1 }, { maxTokens: 100 }] as const) {
      await expect(
        runPlan(
          independentPlan('plan-ungov-caps', 1),
          { concurrency: 1, stopOnError: false, ...cap },
          viewWith(entry('fake', countingOp(calls))),
          {
            governor: createGovernor(cap),
            optIn: ['budget.ungovernedOverGoverned'],
          },
        ),
      ).rejects.toThrow(/marks the run ungoverned.*drop the caps or drop the opt-in/);
    }
    expect(calls).toEqual([]); // never dispatched
  });

  test(
    "an uncapped governed run does not clobber the ledger cap — the raise refusal still sees run 1's cap (cycle 4)",
    async () => {
      // The ledger's C only moves UP with budget.raiseCap. A capless governed
      // run (an opt-in-only handle) journals governance WITHOUT capUsd; if the
      // fold let that undefined clobber prevCapUsd, the next capped run could
      // raise freely — the refusal must still see run 1's cap.
      const view = viewWith(entry('fake', okOp));
      const plan = independentPlan('plan-cap-carry', 1);
      // r1: governed, capped at 1.
      await runPlan(
        plan,
        { concurrency: 1, stopOnError: false, journalDir: dir, maxUsd: 1 },
        view,
        {
          governor: createGovernor({ maxUsd: 1 }),
        },
      );
      // r2: governed, NO cap — the opt-in-free handle is a legal governed shape.
      await runPlan(plan, { concurrency: 1, stopOnError: false, journalDir: dir }, view, {
        governor: createGovernor({}),
      });
      // r3: a raise over r1's 1 refuses without the opt-in...
      await expect(
        runPlan(plan, { concurrency: 1, stopOnError: false, journalDir: dir, maxUsd: 5 }, view, {
          governor: createGovernor({ maxUsd: 5 }),
        }),
      ).rejects.toThrow(/cap raised from 1 to 5/);
      // ...and proceeds WITH it, recording the raise against r1's cap.
      const report = await runPlan(
        plan,
        { concurrency: 1, stopOnError: false, journalDir: dir, maxUsd: 5 },
        view,
        {
          governor: createGovernor({ maxUsd: 5 }),
          optIn: ['budget.raiseCap'],
          allowAdvisory: true,
        },
      );
      const started = (await openRunLog(dir).read(report.runId))[0];
      expect(started).toMatchObject({ governance: { raiseCap: { from: 1, to: 5 } } });
    },
    journalEnclosure(4),
  );

  test(
    'budget.ungovernedOverGoverned with NO governed history refuses — the marker names a condition the plan does not have (composition H3)',
    async () => {
      // Fresh dir: no prior runs. Honouring the marker here would dispatch the
      // ops ungoverned and strand this run's spend outside every future ledger
      // — a silent forfeit. The refusal names the condition and the resolution.
      const calls: string[] = [];
      await expect(
        runPlan(
          independentPlan('plan-gov-mark-nohistory', 1),
          { concurrency: 1, stopOnError: false, journalDir: dir },
          viewWith(entry('fake', countingOp(calls))),
          {
            governor: createGovernor({}),
            optIn: ['budget.ungovernedOverGoverned'],
            allowAdvisory: true,
          },
        ),
      ).rejects.toThrow(
        'runPlan: budget.ungovernedOverGoverned marks the run ungoverned, but plan plan-gov-mark-nohistory has no governed history',
      );
      expect(calls).toEqual([]); // never dispatched
      // Inspecting shared history requires a lease even when the refusal
      // creates no run journal or seq claim. Release retains its lock record.
      const lockName = 'plan-gov-mark-nohistory.lock.json';
      const files = await readdir(dir);
      expect(files.filter((name) => name.endsWith('.ndjson') || name.includes('.seq.'))).toEqual(
        [],
      );
      // The guard lease directory is removed at the end of acquisition.
      expect(files.sort()).toEqual([lockName]);
      const released = JSON.parse(await readFile(join(dir, lockName), 'utf8')) as Record<
        string,
        unknown
      >;
      expect(released.nonce).toMatch(/^[0-9a-f-]{36}$/);
      expect(released.bootId).toMatch(/\S/);
      expect(released.runId).toMatch(/^plan-gov-mark-nohistory--[0-9a-z]+--[0-9a-f]+$/i);
      expect(released).toEqual({
        nonce: released.nonce,
        socketPath: `/tmp/cq-j-${String(released.nonce)}.sock`,
        pid: process.pid,
        host: hostname(),
        bootId: released.bootId,
        runId: released.runId,
        released: true,
      });
      const contender = await acquirePlanLock(dir, 'plan-gov-mark-nohistory', 'refusal-contender');
      try {
        await contender.assertHeld();
      } finally {
        await contender.release();
      }
      const nextReleased = JSON.parse(await readFile(join(dir, lockName), 'utf8')) as Record<
        string,
        unknown
      >;
      expect(nextReleased.nonce).toMatch(/^[0-9a-f-]{36}$/);
      expect(nextReleased).toEqual({
        ...released,
        nonce: nextReleased.nonce,
        socketPath: `/tmp/cq-j-${String(nextReleased.nonce)}.sock`,
        runId: 'refusal-contender',
      });
      expect(nextReleased.nonce).not.toBe(released.nonce);
      // The contender's reclamation leaves its succession claim on the
      // released record.
      expect((await readdir(dir)).sort()).toEqual([
        lockName,
        `${lockName}.${String(released.nonce)}.claim`,
      ]);
    },
    journalEnclosure(2),
  );
});
