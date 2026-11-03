// Split provenance: test/ops/review/addressBookkeeping.test.ts was split into the
// addressBookkeeping.*.test.ts siblings in this directory; shared fixtures live in
// addressBookkeeping.helpers.ts.
import { readFile } from 'node:fs/promises';
import { expect, test } from 'vitest';
import { usageHarness, withUsageEnv } from './addressBookkeeping.helpers.js';

// ---------------------------------------------------------------------------
// M7-address: retain address exit spend. Each settled driver dispatch folds
// into the report's usageSummary exactly once, on every terminal exit route.
// These cases run the REAL makeReviewAddress local path (test repo, fake
// drivers, gitleaks fixture): no fixture-object loops, no pre-assigned
// carriers.
// ---------------------------------------------------------------------------

test('M7-address nominal evidence', async () => {
  return withUsageEnv(async () => {
    const f = await usageHarness();
    try {
      const result = await f.op({
        repoRoot: f.repoRoot,
        source: 'local',
        journalDir: f.journalDir,
      });
      expect(result.status, JSON.stringify(result.report?.reasons)).toBe('ok');
      if (result.status !== 'ok') throw new Error('expected success');
      const runs = f.runs;
      expect(runs).toBeGreaterThan(0);
      // Success retains settled usage exactly once: every dispatch measured
      // 2 in / 1 out, and the summary folds to precisely runs x that
      // measurement.
      expect(result.value.usageSummary).toEqual({
        usage: { input: 2 * runs, output: runs, cacheRead: 0, cacheWrite: 0 },
        knownCount: runs,
        unknownCount: 0,
        unpricedCount: runs,
      });
      // Parent totals agree with the summary: no double counting.
      expect(result.value.usage.input).toBe(2 * runs);
      expect(result.value.usage.output).toBe(runs);
      // The persisted artifact carries the same summary as the envelope.
      const persisted = JSON.parse(await readFile(result.value.reportPath, 'utf8')) as {
        usageSummary?: unknown;
      };
      expect(persisted.usageSummary).toEqual(result.value.usageSummary);
    } finally {
      await f.cleanup();
    }
  });
});

test('M7-address missing evidence', async () => {
  return withUsageEnv(async () => {
    // Every dispatch reports legacy usage without provenance: the summary must
    // be explicit unknown (unknownCount = runs), never a fabricated measured
    // zero, while the run itself still completes honestly.
    const f = await usageHarness({ usage: null });
    try {
      const result = await f.op({
        repoRoot: f.repoRoot,
        source: 'local',
        journalDir: f.journalDir,
      });
      expect(result.status, JSON.stringify(result.report?.reasons)).toBe('ok');
      if (result.status !== 'ok') throw new Error('expected success');
      const runs = f.runs;
      expect(runs).toBeGreaterThan(0);
      expect(result.value.usageSummary).toEqual({
        knownCount: 0,
        unknownCount: runs,
        unpricedCount: runs,
      });
      expect(result.value.usageSummary?.usage).toBeUndefined();
    } finally {
      await f.cleanup();
    }
  });
});
