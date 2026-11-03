// Split from runner-governed.test.ts (owner-mandated file-size split).
// chained governed resumes: the fold reads ALL runs (spent dispatch
// quota carries across resumes) and a corrupt sibling-plan journal
// cannot block the fold (review VB1B).
// Pure move: shared fixtures live in runner-governed.helpers.ts.

import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  ACQUISITION_STEP_MS,
  journalEnclosure,
  runPlan,
  settleFixtureWork,
  entry,
  viewWith,
  countingOp,
  rowStatuses,
  type ShortCircuitEvent,
} from './runner-governed.helpers.js';
import { appendFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGovernor } from '../../src/kernel/governor.js';
import { openRunLog } from '../../src/kernel/journal.js';
import { makeManifest } from '../../src/kernel/manifest.js';
import { type Plan } from '../../src/kernel/types.js';

// ---------------------------------------------------------------------------
// 3c. Chained governed resumes — the deleted seedFromRunLog helper's pins,
//     now against the runner's own fold (W2.2 slice C)
// ---------------------------------------------------------------------------

describe('the governed fold reads ALL chained runs (review VB1B)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cq-runner-chained-'));
  });

  afterEach(async () => {
    await settleFixtureWork();
    await rm(dir, { recursive: true, force: true });
  }, ACQUISITION_STEP_MS + 5_000);

  test(
    'a spent dispatch quota carries across TWO governed resumes',
    async () => {
      const calls: string[] = [];
      const plan: Plan = {
        id: 'plan-chained-quota',
        jobs: [
          { id: 'j1', op: 'fake', input: { jobId: 'j1' } },
          { id: 'j2', op: 'fake', input: { jobId: 'j2' } },
          { id: 'j3', op: 'fake', input: { jobId: 'j3' } },
        ],
      };
      // Run 1: j1 and j2 spend the quota of 2; j3 is refused.
      const report1 = await runPlan(
        plan,
        { concurrency: 1, stopOnError: false, journalDir: dir },
        viewWith(entry('fake', countingOp(calls))),
        { governor: createGovernor({ runDispatchQuota: 2 }), allowAdvisory: true },
      );
      expect(rowStatuses(report1)).toEqual(['ok', 'ok', 'budget-exhausted']);
      expect(calls).toEqual(['j1', 'j2']);

      // Resume with a FRESH governor: the fold seeds the spent quota (ALL
      // prior runs, not just the latest), so j3 stays refused — while j1/j2
      // replay-skip (a replay consumes no quota).
      const governor2 = createGovernor({ runDispatchQuota: 2 });
      const report2 = await runPlan(
        plan,
        { concurrency: 1, stopOnError: false, journalDir: dir, resume: true },
        viewWith(entry('fake', countingOp(calls))),
        { governor: governor2, allowAdvisory: true },
      );
      expect(calls).toEqual(['j1', 'j2']); // UNCHANGED — j3 never runs the op
      expect(rowStatuses(report2)).toEqual(['ok', 'ok', 'budget-exhausted']);
      const refusals = governor2.events.filter(
        (event): event is ShortCircuitEvent => event.kind === 'short-circuited',
      );
      expect(refusals.map((event) => event.reason)).toEqual(['dispatch-quota']);
      expect(governor2.dispatchCount).toBe(2); // seeded from the fold; refusals do not consume
    },
    journalEnclosure(2),
  );

  test(
    'a corrupt sibling-plan journal cannot block this plan’s governed resume ("a" vs "a--b", shared filter)',
    async () => {
      // Review VB1C r1: a prefix-only candidate filter read a corrupt journal
      // of plan 'a--b' into plan 'a's fold. The shared candidateRunsForPlan
      // filter rejects it (the runId remainder after 'a--' is THREE segments,
      // not the exact two-segment tail), so the governed run below — which
      // folds the whole dir — never parses the corrupt file.
      const log = openRunLog(dir);
      const plan: Plan = {
        id: 'a',
        jobs: [{ id: 'j1', op: 'fake', input: { jobId: 'j1' } }],
      };
      const hash = makeManifest(plan).jobs[0]?.inputsHash ?? '';
      const runId = 'a--r1--aa';
      await log.append(runId, {
        type: 'run-started',
        runId,
        at: '2026-01-01T00:00:00.000Z',
        planId: 'a',
        journalVersion: 2,
        seq: 1,
        governance: { attended: false },
      });
      await log.append(runId, {
        type: 'job-started',
        runId,
        at: '2026-01-01T00:00:00.000Z',
        jobId: 'j1',
        op: 'fake',
        attempt: 1,
      });
      await log.append(runId, {
        type: 'job-finished',
        runId,
        at: '2026-01-01T00:00:01.000Z',
        jobId: 'j1',
        opId: 'fake',
        inputsHash: hash,
        result: { status: 'ok', value: 'j1' },
      });
      // A corrupt MIDDLE line in the sibling plan's file (prefix 'a--' matches).
      await appendFile(
        join(dir, 'a--b--k3y--c0ffee.ndjson'),
        `${JSON.stringify({ type: 'run-started', runId: 'a--b--k3y--c0ffee', at: '2026-01-01T00:00:00.000Z', planId: 'a--b' })}\n{"type":"job-started","runI\n`,
        'utf8',
      );

      const calls: string[] = [];
      const report = await runPlan(
        plan,
        { concurrency: 1, stopOnError: false, journalDir: dir, resume: true },
        viewWith(entry('fake', countingOp(calls))),
        { governor: createGovernor({}), allowAdvisory: true },
      );
      expect(calls).toEqual([]); // j1 replayed from the fold — no corrupt-read blowup
      expect(report.counts.done).toBe(1);
    },
    journalEnclosure(1),
  );

  test(
    'a dependency cycle throws BEFORE anything is claimed or journalled',
    async () => {
      // Plan corruption is invalid input: the rejection must precede the seq
      // claim and the governed run-started append, or the failed invocation
      // would permanently establish governed history and refuse later
      // corrected (uncapped, opt-in-free) runs as ungoverned-over-governed.
      const calls: string[] = [];
      const plan: Plan = {
        id: 'plan-gov-cycle',
        jobs: [
          { id: 'j1', op: 'fake', input: { jobId: 'j1' }, dependsOn: ['j2'] },
          { id: 'j2', op: 'fake', input: { jobId: 'j2' }, dependsOn: ['j1'] },
        ],
      };
      await expect(
        runPlan(
          plan,
          { concurrency: 1, stopOnError: false, journalDir: dir },
          viewWith(entry('fake', countingOp(calls))),
          { governor: createGovernor({ maxUsd: 5 }), allowAdvisory: true },
        ),
      ).rejects.toThrow(/dependency cycle/);
      expect(calls).toEqual([]); // nothing dispatched either
      // The journal dir stays empty: no claim tombstone, no run-started file.
      expect(await readdir(dir)).toEqual([]);
    },
    journalEnclosure(1),
  );
});
