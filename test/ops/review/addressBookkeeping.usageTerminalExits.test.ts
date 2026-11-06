// Split provenance: test/ops/review/addressBookkeeping.test.ts was split into the
// addressBookkeeping.*.test.ts siblings in this directory; shared fixtures live in
// addressBookkeeping.helpers.ts.
import { readFile } from 'node:fs/promises';
import { expect, test } from 'vitest';
import { runLadder } from '../../../src/kernel/governor.js';
import { usageHarness, withUsageEnv } from './addressBookkeeping.helpers.js';

// ---------------------------------------------------------------------------
// M7-address: retain address exit spend. Each settled driver dispatch folds
// into the report's usageSummary exactly once, on every terminal exit route.
// These cases run the REAL makeReviewAddress local path (test repo, fake
// drivers, gitleaks fixture): no fixture-object loops, no pre-assigned
// carriers.
// ---------------------------------------------------------------------------

test('M7-address failure evidence', async () => {
  return withUsageEnv(async () => {
    // The FIRST dispatch throws; the loop's retry then settles measured usage
    // (2 in / 1 out) before the run still exits needs-human carrying the thrown
    // fault. The settled spend is retained exactly once on the failure exit,
    // the THROWN dispatch settles as an explicit unknown (it may already have
    // been paid upstream), and parent totals match the measured run only.
    const f = await usageHarness({ throwOnRun: 1 });
    try {
      const result = await f.op({
        repoRoot: f.repoRoot,
        source: 'local',
        journalDir: f.journalDir,
      });
      expect(result.status).toBe('needs-human');
      if (result.status === 'ok') throw new Error('expected needs-human');
      expect(f.runs).toBe(2);
      expect(result.report?.usageSummary).toEqual({
        usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0 },
        knownCount: 1,
        unknownCount: 1,
        unpricedCount: 2,
      });
      // Parent totals do not double count the settled run's usage.
      expect(result.report?.usage).toEqual({
        input: 2,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
      });
      // The thrown dispatch is a real fault inside the loop; the run still
      // reaches a terminal needs-human exit at the round cap with the thrown
      // run's settled sibling spend retained exactly once.
      expect(result.report?.reasons.join('; ')).toContain(
        'review round cap reached with open findings',
      );
    } finally {
      await f.cleanup();
    }
  });
});

test('M7-address exhaustion evidence', async () => {
  return withUsageEnv(async () => {
    // The FIRST dispatch settles measured usage (2 in / 1 out); that spend
    // consumes the caller-imposed token allowance, so the next partition
    // trips its own BEFORE-dispatch token-budget stop (no second dispatch
    // runs) and finish() records the structured budget marker. The exhausted
    // exit retains the settled spend exactly once, no dispatch invents usage,
    // and parent totals match the summary.
    const f = await usageHarness();
    try {
      const result = await f.op({
        repoRoot: f.repoRoot,
        source: 'local',
        journalDir: f.journalDir,
        // A genuine engine budget trip: the first dispatch's settled spend
        // (3 tokens) consumes the caller-imposed token allowance, so the
        // reviewer partition trips its own before-dispatch budget stop and
        // finish() records the structured budget marker with that spend kept.
        maxTokens: 3,
      });
      expect(result.status, JSON.stringify(result.report?.reasons)).toBe('needs-human');
      if (result.status === 'ok') throw new Error('expected needs-human');
      expect(result.report?.stop).toBe('budget');
      expect(result.report?.reasons.join('; ')).toContain('token or wall budget exhausted');
      // The budget must have tripped AFTER at least one settled dispatch: the
      // exhausted exit proves retention only if spend preceded the trip.
      const summaryAfterTrip = result.report?.usageSummary;
      expect(
        (summaryAfterTrip?.knownCount ?? 0) + (summaryAfterTrip?.unknownCount ?? 0),
        JSON.stringify({ runs: f.runs, reasons: result.report?.reasons }),
      ).toBeGreaterThan(0);
      expect(result.report?.usageSummary).toEqual({
        usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0 },
        knownCount: 1,
        unknownCount: 0,
        unpricedCount: 1,
      });
      expect(result.report?.usage).toEqual({
        input: 2,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
      });
      // The persisted artifact carries the same summary as the envelope.
      const persisted = JSON.parse(await readFile(result.report!.reportPath, 'utf8')) as {
        usageSummary?: unknown;
        stop?: string;
      };
      expect(persisted.usageSummary).toEqual(result.report?.usageSummary);
      expect(persisted.stop).toBe('budget');
    } finally {
      await f.cleanup();
    }
  });
});

test('M7-address cancellation evidence', async () => {
  return withUsageEnv(async () => {
    // A REAL parent cancellation through the engine's own carrier: the first
    // driver dispatch STARTS, is HELD IN FLIGHT until the governing
    // runLadder's cancel lands, and then REJECTS — a genuinely cut-down
    // dispatch. The engine settles that rejection as an explicit unknown
    // (unknownCount 1, never a dropped or fabricated-measured dispatch), the
    // cancelled exit is needs-human 'parent cancelled', and EXACT equality
    // holds between the summary and the parent totals (a double count or an
    // invented measurement fails). The engine's terminal lifetime persists
    // the same summary to the artifact.
    const parent = new AbortController();
    const f = await usageHarness({ abortSignal: parent.signal, holdUntilAbortAfter: 0 });
    try {
      const opPromise = runLadder(
        () => f.op({ repoRoot: f.repoRoot, source: 'local', journalDir: f.journalDir }),
        { wallClockMs: 30000, abortGraceMs: 5000, killGraceMs: 5000 },
        { op: 'review.address', jobKey: 'm7-cancel', attempt: 1 },
        { signal: parent.signal },
      );
      // Abort as soon as the first dispatch has STARTED (it is pending on the
      // abort), so it is cut down mid-flight. Race the poll against the op so
      // an early settle surfaces its own error instead of a poll hang.
      let timer: ReturnType<typeof setInterval> | undefined;
      const cancelledOnceDispatched = new Promise<void>((done) => {
        timer = setInterval(() => {
          if (f.runs >= 1) {
            clearInterval(timer);
            parent.abort();
            done();
          }
        }, 1);
      });
      try {
        await Promise.race([cancelledOnceDispatched, opPromise]);
      } finally {
        clearInterval(timer);
      }
      const ladder = await opPromise;
      expect(ladder.outcome).toBe('completed');
      if (ladder.outcome !== 'completed') throw new Error('ladder did not complete');
      const result = ladder.value;
      expect(result.status).toBe('needs-human');
      if (result.status === 'ok') throw new Error('expected needs-human');
      expect(result.report?.reasons.join('; ')).toContain('parent cancelled');
      // Exactly one dispatch started; the cancel cut it down.
      expect(f.runs).toBe(1);
      // The cut-down dispatch is an explicit unknown, never dropped and never
      // a fabricated measured zero.
      const summary = result.report?.usageSummary;
      expect(summary).toEqual({
        knownCount: 0,
        unknownCount: 1,
        unpricedCount: 1,
      });
      expect(summary?.usage).toBeUndefined();
      // EXACT parent-total equality with the unknown-only summary.
      expect(result.report?.usage).toEqual({
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      });
      // The engine's terminal lifetime persists the same summary to the artifact.
      const persisted = JSON.parse(await readFile(result.report!.reportPath, 'utf8')) as {
        usageSummary?: unknown;
      };
      expect(persisted.usageSummary).toEqual(summary);
    } finally {
      parent.abort();
      await f.cleanup();
    }
  });
});
