// Split provenance: test/kernel/journal-lock.test.ts was split by subject; this
// file holds child-process recovery: SIGKILL recovery of an unresolved durable
// reservation through runPlan, independent child sequence claims, and the boot
// identity timeout/cache. Sibling subjects: journal-lock.exclusion.test.ts,
// journal-lock.claims.test.ts, journal-lock.publication-faults.test.ts,
// journal-lock.guard.test.ts, journal-lock.compromise.test.ts,
// journal-lock.corruption.test.ts, journal-lock.artifacts.test.ts; shared
// fixtures live in journal-lock.helpers.ts.
import { expect, test } from 'vitest';
import { createGovernor } from '../../src/kernel/governor.js';
import { openRunLog } from '../../src/kernel/journal.js';
import { runPlan } from '../../src/kernel/runner.js';
import {
  CHILD_STEP_MS,
  directory,
  lockHarness,
  record,
  start,
  workRegistry,
} from './journal-lock.helpers.js';

lockHarness();

// Enclosure: owner write-ahead then parent recovery.
test(
  'SIGKILL recovery charges an unresolved durable reservation and quarantines its job',
  async () => {
    const dir = await directory();
    const owner = start(dir, 'locked--1--a', { J_TEST_CRASH: 'yes' });
    expect((await owner.next()).status).toBe('acquired');
    await record(dir);
    owner.child.kill('SIGKILL');
    await owner.exited;
    const calls: string[] = [];
    const registry = workRegistry(calls);
    const governor = createGovernor({ maxUsd: 10 });
    const report = await runPlan(
      { id: 'locked', jobs: [{ id: 'a', op: 'work', input: { id: 'a' } }] },
      { concurrency: 1, stopOnError: false, journalDir: dir, resume: true },
      registry,
      { governor, allowAdvisory: true },
    );
    expect(calls).toEqual([]);
    expect(governor.usdSpent).toBe(4);
    expect(governor.quarantinedJobs.has('a')).toBe(true);
    expect(governor.outstandingCount).toBe(0);
    expect(governor.inFlight).toBe(0);
    const recoveryEvents = await openRunLog(dir).read(report.runId);
    expect(recoveryEvents.find((event) => event.type === 'run-started')).toMatchObject({
      journalVersion: 2,
      seq: 2,
    });
    const verdict = report.jobs[0]?.result;
    expect(verdict?.status).toBe('needs-human');
    if (verdict?.status !== 'needs-human') throw new Error('missing quarantine verdict');
    expect(verdict.reason).toContain('quarantined:');
  },
  2 * CHILD_STEP_MS,
);

// Enclosure: parallel Node/loader startups; no helper or boot lookup.
test(
  'independent child sequence claims use the real plan and unique positive ordinals',
  async () => {
    const dir = await directory();
    const contenders = [
      start(dir, 'claim-one', { J_TEST_CLAIM_ONLY: 'yes' }),
      start(dir, 'claim-two', { J_TEST_CLAIM_ONLY: 'yes' }),
    ];
    const claims = await Promise.all(contenders.map((worker) => worker.next()));
    expect(claims.map((message) => message.status)).toEqual(['claimed', 'claimed']);
    expect(claims.map((message) => message.seq).sort()).toEqual([1, 2]);
  },
  CHILD_STEP_MS,
);

// Enclosure: three sequential child acquisitions; first failure must remain retryable.
test(
  'boot identity timeout remains retryable; a successful lookup is reused per process',
  async (context) => {
    if (process.platform !== 'darwin') {
      context.skip();
      return;
    }
    const dir = await directory();
    const worker = start(dir, 'cache', { J_TEST_BOOT_CACHE: 'yes' });
    expect(await worker.next()).toMatchObject({
      status: 'refused',
      bootCalls: 1,
      error:
        'journal: boot identity startup/completion deadline exceeded after 10000ms (possible slow host)',
    });
    expect(await worker.next()).toMatchObject({ status: 'released', bootCalls: 2 });
    expect(await worker.next()).toMatchObject({ status: 'released', bootCalls: 2 });
    await worker.exited;
  },
  3 * CHILD_STEP_MS,
);
