// Split from runner-governed.test.ts (owner-mandated file-size split).
// Governed journal v2 + resume — replay re-attestation (costUSD copy, op-reported sessions, workId,
// Paseo-parent correlation), tombstone fold refusal, ANNEX goldens.
// Pure move: shared fixtures live in runner-governed.helpers.ts.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  ACQUISITION_STEP_MS,
  journalEnclosure,
  runPlan,
  settleFixtureWork,
  entry,
  viewWith,
  independentPlan,
  countingOp,
  jobFinishes,
  jobStarts,
} from './runner-governed.helpers.js';
import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { currentJobContext, createGovernor } from '../../src/kernel/governor.js';
import { readCqEnv } from '../../src/config/env.js';
import { openRunLog } from '../../src/kernel/journal.js';
import { makeManifest } from '../../src/kernel/manifest.js';
import { type OpResult, type Plan } from '../../src/kernel/types.js';

describe('governed journal v2 + resume', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cq-runner-governed-'));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await settleFixtureWork();
    await rm(dir, { recursive: true, force: true });
  }, ACQUISITION_STEP_MS + 5_000);

  test(
    'replay-skip re-attestation copies the prior finish\u2019s costUSD, not just usage (composition M2)',
    async () => {
      const USAGE = { input: 6, output: 3, cacheRead: 0, cacheWrite: 0 };
      const calls: string[] = [];
      const spendy = async (raw: unknown): Promise<OpResult<unknown>> => {
        calls.push((raw as { jobId: string }).jobId);
        currentJobContext()?.reportResult({ usage: USAGE, costUSD: 0.25 });
        return { status: 'ok', value: 'done' };
      };
      const plan = independentPlan('plan-gov-reattest-cost', 1, 'spendy');
      await runPlan(
        plan,
        { concurrency: 1, stopOnError: false, journalDir: dir },
        viewWith(entry('spendy', spendy)),
        { governor: createGovernor({ maxUsd: 5 }), allowAdvisory: true },
      );
      // Resume: the job replay-skips (zero invocation); the re-attested
      // finish-only event must carry usage AND costUSD (annex §3 rule 1) so
      // this run's journal self-containedly prices the fold.
      const report2 = await runPlan(
        plan,
        { concurrency: 1, stopOnError: false, journalDir: dir, resume: true },
        viewWith(entry('spendy', spendy)),
        { governor: createGovernor({ maxUsd: 5 }), allowAdvisory: true },
      );
      expect(calls).toEqual(['j1']); // run 1 only — the resume skipped
      const events2 = await openRunLog(dir).read(report2.runId);
      expect(jobFinishes(events2)).toMatchObject([
        { jobId: 'j1', result: { status: 'ok' }, usage: USAGE, costUSD: 0.25 },
      ]);
    },
    journalEnclosure(2),
  );

  test(
    'job-finished links op-reported sessions + workId/role, and replay re-attestation keeps them (session-log 1.3/1.5)',
    async () => {
      vi.stubEnv('CQ_WORK_ID', 'original-parent');
      const calls: string[] = [];
      const seenWorkIds: (string | undefined)[] = [];
      const linked = async (raw: unknown): Promise<OpResult<unknown>> => {
        calls.push((raw as { jobId: string }).jobId);
        const ctx = currentJobContext();
        seenWorkIds.push(ctx?.info.correlation?.workId);
        ctx?.reportSession?.({ driver: 'ai-sdk', sessionId: 'store-1', nativeSessionId: 'n-1' });
        // A malformed report is dropped, never journalled.
        ctx?.reportSession?.({ driver: 'ai-sdk', sessionId: '' });
        // The result-derived link (driver 'unknown', no native id) for the
        // SAME session merges with the reported one — no metadata lost.
        return { status: 'ok', value: { sessionId: 'store-1' } };
      };
      const plan = independentPlan('plan-gov-session-links', 1, 'linked');
      const report1 = await runPlan(
        plan,
        { concurrency: 1, stopOnError: false, journalDir: dir },
        viewWith(entry('linked', linked)),
        { governor: createGovernor({ maxUsd: 5 }), allowAdvisory: true },
      );
      const expectedLinks = {
        jobId: 'j1',
        workId: `${report1.runId}:j1:1`,
        role: 'linked',
        parentWorkId: 'original-parent',
        sessions: [{ driver: 'ai-sdk', sessionId: 'store-1', nativeSessionId: 'n-1' }],
      };
      expect(seenWorkIds).toEqual([`${report1.runId}:j1:1`]);
      const events1 = await openRunLog(dir).read(report1.runId);
      expect(jobFinishes(events1)).toMatchObject([expectedLinks]);
      expect(jobFinishes(events1)[0]?.sessions).toHaveLength(1);

      vi.stubEnv('CQ_WORK_ID', 'changed-parent');
      const report2 = await runPlan(
        plan,
        { concurrency: 1, stopOnError: false, journalDir: dir, resume: true },
        viewWith(entry('linked', linked)),
        { governor: createGovernor({ maxUsd: 5 }), allowAdvisory: true },
      );
      expect(calls).toEqual(['j1']); // the resume replay-skipped
      const events2 = await openRunLog(dir).read(report2.runId);
      expect(jobFinishes(events2)).toMatchObject([expectedLinks]);
    },
    journalEnclosure(2),
  );

  test(
    'an empty reported driver is treated as unknown, never journalled as an empty string',
    async () => {
      // validSessionLink promises non-empty strings only. A reported '' must
      // not replace the result-derived 'unknown' in the merged link, and must
      // not reach the journal (z.string() would accept it and persist it).
      const blank = async (): Promise<OpResult<unknown>> => {
        currentJobContext()?.reportSession?.({ driver: '', sessionId: 'store-blank' });
        return { status: 'ok', value: { sessionId: 'store-blank' } };
      };
      const plan = independentPlan('plan-gov-session-blank-driver', 1, 'blank');
      const report = await runPlan(
        plan,
        { concurrency: 1, stopOnError: false, journalDir: dir },
        viewWith(entry('blank', blank)),
        { governor: createGovernor({ maxUsd: 5 }), allowAdvisory: true },
      );
      const sessions = jobFinishes(await openRunLog(dir).read(report.runId))[0]?.sessions;
      expect(sessions).toEqual([{ driver: 'unknown', sessionId: 'store-blank' }]);
    },
    journalEnclosure(1),
  );

  test(
    'an empty job.op fails that one job instead of rejecting the run (role is omitted)',
    async () => {
      // PlanSchema accepts op '' (z.string()), but JobFinishedJournalEventSchema
      // requires role.min(1). Journalling the empty role made the append throw
      // and failed the whole run instead of giving the job its failed row.
      const plan: Plan = {
        id: 'plan-empty-op',
        jobs: [{ id: 'j1', op: '', input: { jobId: 'j1' } }],
      };
      const report = await runPlan(
        plan,
        { concurrency: 1, stopOnError: false, journalDir: dir },
        viewWith(),
        { governor: createGovernor({ maxUsd: 1 }), allowAdvisory: true },
      );
      expect(report.jobs[0]?.result).toMatchObject({ status: 'failed', error: "unknown op ''" });
      const finishes = jobFinishes(await openRunLog(dir).read(report.runId));
      expect(finishes).toMatchObject([{ jobId: 'j1', opId: '', result: { status: 'failed' } }]);
      expect(finishes[0]?.role).toBeUndefined();
    },
    journalEnclosure(1),
  );

  test.each([false, true])(
    'resume preserves recorded parents and falls back for legacy journals (legacy=%s)',
    async (legacy) => {
      const seen: Array<{ jobId: string; parent: string | undefined }> = [];
      let fail = true;
      let allowThird = false;
      const probe = async (raw: unknown): Promise<OpResult<unknown>> => {
        const jobId = (raw as { jobId: string }).jobId;
        seen.push({ jobId, parent: currentJobContext()?.info.correlation?.parentWorkId });
        if ((jobId === 'j2' && fail) || (jobId === 'j3' && !allowThird))
          return { status: 'failed', error: 'retry on resume' };
        return { status: 'ok', value: {} };
      };
      const plan = independentPlan('plan-parent-retry', 3, 'probe');
      const run = (resume: boolean) =>
        runPlan(
          plan,
          { concurrency: 1, stopOnError: false, journalDir: dir, resume },
          viewWith(entry('probe', probe)),
          { governor: createGovernor({ maxUsd: 5 }), allowAdvisory: true },
        );
      vi.stubEnv('CQ_WORK_ID', legacy ? '' : 'original-parent');
      vi.stubEnv('CQ_PARENT_WORK_ID', '');
      vi.stubEnv('PASEO_AGENT_ID', '');
      await run(false);
      fail = false;
      vi.stubEnv('CQ_WORK_ID', 'changed-parent');
      await run(true);
      allowThird = true;
      vi.stubEnv('CQ_WORK_ID', 'third-parent');
      const resumed = await run(true);
      expect(seen).toEqual([
        { jobId: 'j1', parent: legacy ? undefined : 'original-parent' },
        { jobId: 'j2', parent: legacy ? undefined : 'original-parent' },
        { jobId: 'j3', parent: legacy ? undefined : 'original-parent' },
        { jobId: 'j2', parent: legacy ? 'changed-parent' : 'original-parent' },
        { jobId: 'j3', parent: legacy ? 'changed-parent' : 'original-parent' },
        { jobId: 'j3', parent: legacy ? 'changed-parent' : 'original-parent' },
      ]);
      expect(jobFinishes(await openRunLog(dir).read(resumed.runId))).toMatchObject([
        { jobId: 'j1', ...(legacy ? {} : { parentWorkId: 'original-parent' }) },
        { jobId: 'j2', parentWorkId: legacy ? 'changed-parent' : 'original-parent' },
        { jobId: 'j3', parentWorkId: legacy ? 'changed-parent' : 'original-parent' },
      ]);
    },
    journalEnclosure(3),
  );

  test(
    'job correlation names the launching Paseo agent as parent; explicit CQ_* wins (session-log 1.3)',
    async () => {
      const seen: (string | undefined)[] = [];
      const probe = async (): Promise<OpResult<unknown>> => {
        seen.push(currentJobContext()?.info.correlation?.parentWorkId);
        return { status: 'ok', value: {} };
      };
      const run = async (planId: string) =>
        runPlan(
          independentPlan(planId, 1, 'probe'),
          { concurrency: 1, stopOnError: false, journalDir: dir },
          viewWith(entry('probe', probe)),
          { governor: createGovernor({ maxUsd: 5 }), allowAdvisory: true },
        );
      try {
        vi.stubEnv('CQ_WORK_ID', '');
        vi.stubEnv('CQ_PARENT_WORK_ID', '');
        vi.stubEnv('PASEO_AGENT_ID', '');
        await run('plan-gov-parent-none');
        vi.stubEnv('PASEO_AGENT_ID', 'agent-7');
        await run('plan-gov-parent-paseo');
        vi.stubEnv('CQ_PARENT_WORK_ID', 'outer-parent');
        await run('plan-gov-parent-explicit');
        vi.stubEnv('CQ_WORK_ID', 'crq:r-1');
        await run('plan-gov-parent-work');
      } finally {
        vi.unstubAllEnvs();
      }
      expect(seen).toEqual([undefined, 'paseo:agent-7', 'outer-parent', 'crq:r-1']);
    },
    journalEnclosure(4),
  );

  test(
    'the run entry CqEnv snapshot fixes the parent against post-entry ambient drift (#1185)',
    async () => {
      const seen: (string | undefined)[] = [];
      const probe = async (): Promise<OpResult<unknown>> => {
        seen.push(currentJobContext()?.info.correlation?.parentWorkId);
        return { status: 'ok', value: {} };
      };
      const cqEnv = readCqEnv({ CQ_WORK_ID: 'snapshot-parent' });
      try {
        // Hostile ambient after the snapshot was taken: none of it may win.
        vi.stubEnv('CQ_WORK_ID', 'ambient-parent');
        vi.stubEnv('CQ_PARENT_WORK_ID', 'ambient-outer');
        vi.stubEnv('PASEO_AGENT_ID', 'agent-7');
        await runPlan(
          independentPlan('plan-gov-parent-entry-snapshot', 1, 'probe'),
          { concurrency: 1, stopOnError: false, journalDir: dir, cqEnv },
          viewWith(entry('probe', probe)),
          { governor: createGovernor({ maxUsd: 5 }), allowAdvisory: true },
        );
      } finally {
        vi.unstubAllEnvs();
      }
      expect(seen).toEqual(['snapshot-parent']);
    },
    journalEnclosure(1),
  );

  test(
    'the live Paseo fallback still applies when the entry snapshot carries no CQ_* identity (#1185)',
    async () => {
      const seen: (string | undefined)[] = [];
      const probe = async (): Promise<OpResult<unknown>> => {
        seen.push(currentJobContext()?.info.correlation?.parentWorkId);
        return { status: 'ok', value: {} };
      };
      const cqEnv = readCqEnv({});
      try {
        // An ambient CQ_WORK_ID is NOT a fallback tier any more (the CQ_*
        // tiers are snapshot-only); the foreign Paseo id still is.
        vi.stubEnv('CQ_WORK_ID', 'ambient-parent');
        vi.stubEnv('CQ_PARENT_WORK_ID', '');
        vi.stubEnv('PASEO_AGENT_ID', 'agent-7');
        await runPlan(
          independentPlan('plan-gov-parent-live-paseo', 1, 'probe'),
          { concurrency: 1, stopOnError: false, journalDir: dir, cqEnv },
          viewWith(entry('probe', probe)),
          { governor: createGovernor({ maxUsd: 5 }), allowAdvisory: true },
        );
      } finally {
        vi.unstubAllEnvs();
      }
      expect(seen).toEqual(['paseo:agent-7']);
    },
    journalEnclosure(1),
  );

  test(
    'resume keeps the recorded parent over a new entry snapshot and ambient drift (#1185)',
    async () => {
      const seen: (string | undefined)[] = [];
      let fail = true;
      const probe = async (): Promise<OpResult<unknown>> => {
        seen.push(currentJobContext()?.info.correlation?.parentWorkId);
        return fail ? { status: 'failed', error: 'retry on resume' } : { status: 'ok', value: {} };
      };
      const plan = independentPlan('plan-gov-parent-resume-snapshot', 1, 'probe');
      const run = (opts: { resume?: boolean; cqEnv: ReturnType<typeof readCqEnv> }) =>
        runPlan(
          plan,
          { concurrency: 1, stopOnError: false, journalDir: dir, ...opts },
          viewWith(entry('probe', probe)),
          { governor: createGovernor({ maxUsd: 5 }), allowAdvisory: true },
        );
      await run({ cqEnv: readCqEnv({ CQ_WORK_ID: 'recorded-parent' }) });
      fail = false;
      try {
        // The finish recorded 'recorded-parent'; neither the new entry
        // snapshot nor the ambient identity may replace it.
        vi.stubEnv('CQ_WORK_ID', 'resume-ambient-parent');
        vi.stubEnv('CQ_PARENT_WORK_ID', 'resume-ambient-outer');
        vi.stubEnv('PASEO_AGENT_ID', 'agent-9');
        await run({
          resume: true,
          cqEnv: readCqEnv({ CQ_WORK_ID: 'resume-snapshot-parent' }),
        });
      } finally {
        vi.unstubAllEnvs();
      }
      expect(seen).toEqual(['recorded-parent', 'recorded-parent']);
    },
    journalEnclosure(2),
  );

  test(
    'a claim tombstone beyond the highest folded seq refuses the fold — a deleted run file cannot silently lower the seed (composition H2)',
    async () => {
      const plan: Plan = {
        id: 'plan-gov-seqgap',
        jobs: [{ id: 'j1', op: 'fake', input: { jobId: 'j1' } }],
      };
      const log = openRunLog(dir);
      const run1 = 'plan-gov-seqgap--r1--aa';
      await log.append(run1, {
        type: 'run-started',
        runId: run1,
        at: '2026-01-01T00:00:00.000Z',
        planId: 'plan-gov-seqgap',
        journalVersion: 2,
        seq: 1,
        governance: { attended: false },
      });
      // The seq-2 claim tombstone EXISTS but its run file does not: a deleted
      // run (or an orphaned claim). The fold sees maxPriorSeq 1 and must refuse
      // — governed AND plain — instead of silently forgetting the missing
      // run's spend.
      await appendFile(join(dir, 'plan-gov-seqgap.seq.2'), '', 'utf8');
      const calls: string[] = [];
      await expect(
        runPlan(
          plan,
          { concurrency: 1, stopOnError: false, journalDir: dir, resume: true },
          viewWith(entry('fake', countingOp(calls))),
          { governor: createGovernor({}), allowAdvisory: true },
        ),
      ).rejects.toThrow(/journal: corrupt — seq gap for plan 'plan-gov-seqgap'/);
      await expect(
        runPlan(
          plan,
          { concurrency: 1, stopOnError: false, journalDir: dir, resume: true },
          viewWith(entry('fake', countingOp(calls))),
        ),
      ).rejects.toThrow(/seq gap/);
      expect(calls).toEqual([]);
    },
    journalEnclosure(2),
  );

  test(
    'ANNEX §5 golden: a verbatim v1 journal replays with a zero-invocation skip and a v1-shaped run-started',
    async () => {
      // The golden replay rule (annex §5), against a file written RAW exactly
      // as a v1 binary wrote it — versionless run-started, attempt-1
      // job-started, the frozen replay record, run-finished. The ungoverned
      // resume must skip the job (ok + same op + same inputsHash) with zero op
      // invocation and write its OWN run-started still v1-shaped.
      const plan: Plan = {
        id: 'plan-gov-golden-v1',
        jobs: [{ id: 'j1', op: 'fake', input: { jobId: 'j1' } }],
      };
      const hash = makeManifest(plan).jobs[0]?.inputsHash ?? '';
      const v1RunId = 'plan-gov-golden-v1--20260101--abcd1234';
      const v1Lines = [
        JSON.stringify({
          type: 'run-started',
          runId: v1RunId,
          at: '2026-01-01T00:00:00.000Z',
          planId: 'plan-gov-golden-v1',
        }),
        JSON.stringify({
          type: 'job-started',
          runId: v1RunId,
          at: '2026-01-01T00:00:00.000Z',
          jobId: 'j1',
          op: 'fake',
          attempt: 1,
        }),
        JSON.stringify({
          type: 'job-finished',
          runId: v1RunId,
          at: '2026-01-01T00:00:01.000Z',
          jobId: 'j1',
          opId: 'fake',
          inputsHash: hash,
          result: { status: 'ok', value: 'j1' },
        }),
        JSON.stringify({
          type: 'run-finished',
          runId: v1RunId,
          at: '2026-01-01T00:00:02.000Z',
          stoppedEarly: false,
        }),
      ];
      await appendFile(join(dir, `${v1RunId}.ndjson`), `${v1Lines.join('\n')}\n`, 'utf8');

      const calls: string[] = [];
      const report = await runPlan(
        plan,
        { concurrency: 1, stopOnError: false, journalDir: dir, resume: true },
        viewWith(entry('fake', countingOp(calls))),
      );
      expect(calls).toEqual([]); // the v1 ok finish skips — zero invocation
      expect(report.counts.done).toBe(1);
      const log = openRunLog(dir);
      const runs = await log.runs();
      expect(runs).toHaveLength(2);
      const events = await log.read(report.runId);
      const started = events[0] as { type: string; journalVersion?: unknown; seq?: unknown };
      expect(started.type).toBe('run-started');
      expect('journalVersion' in started).toBe(false); // the new run is v1-shaped too
      expect('seq' in started).toBe(false);
      // The self-contained re-attestation: this run's journal carries the
      // finish-only event for j1.
      expect(jobFinishes(events)).toMatchObject([
        { jobId: 'j1', opId: 'fake', result: { status: 'ok' } },
      ]);
    },
    journalEnclosure(1),
  );

  test(
    'ANNEX §4 row 1: an ungoverned run over v1-only history works unchanged (skip + re-run, no refusal)',
    async () => {
      // v1 history: j1 finished ok (skips), j2 started and never finished (the
      // crash — re-runs). The plain path neither refuses nor changes shape.
      const plan: Plan = {
        id: 'plan-gov-v1row1',
        jobs: [
          { id: 'j1', op: 'fake', input: { jobId: 'j1' } },
          { id: 'j2', op: 'fake', input: { jobId: 'j2' } },
        ],
      };
      const manifest = makeManifest(plan);
      const v1RunId = 'plan-gov-v1row1--20260101--beefcafe';
      const log = openRunLog(dir);
      await log.append(v1RunId, {
        type: 'run-started',
        runId: v1RunId,
        at: '2026-01-01T00:00:00.000Z',
        planId: 'plan-gov-v1row1',
      });
      await log.append(v1RunId, {
        type: 'job-started',
        runId: v1RunId,
        at: '2026-01-01T00:00:00.000Z',
        jobId: 'j1',
        op: 'fake',
        attempt: 1,
      });
      await log.append(v1RunId, {
        type: 'job-finished',
        runId: v1RunId,
        at: '2026-01-01T00:00:01.000Z',
        jobId: 'j1',
        opId: 'fake',
        inputsHash: manifest.jobs[0]?.inputsHash ?? '',
        result: { status: 'ok', value: 'j1' },
      });
      await log.append(v1RunId, {
        type: 'job-started',
        runId: v1RunId,
        at: '2026-01-01T00:00:01.000Z',
        jobId: 'j2',
        op: 'fake',
        attempt: 1,
      });

      const calls: string[] = [];
      const report = await runPlan(
        plan,
        { concurrency: 1, stopOnError: false, journalDir: dir, resume: true },
        viewWith(entry('fake', countingOp(calls))),
      );
      expect(calls).toEqual(['j2']); // j1 skipped (verified ok); j2 re-runs
      expect(report.counts.done).toBe(2);
      const events = await log.read(report.runId);
      expect(jobStarts(events).map((event) => event.jobId)).toEqual(['j2']); // j1 was never re-dispatched
    },
    journalEnclosure(1),
  );
});
