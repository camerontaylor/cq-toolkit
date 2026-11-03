// Split from test/ops/merge/executeMerges.test.ts (F3): the bounded retry
// on "base branch was modified" (e).
import { describe, expect, test } from 'vitest';
import { match } from '../../helpers/matchers.js';
import { DEFAULT_MAX_RETRIES, executeMerges } from '../../../src/ops/merge/executeMerges.js';
import { OK, entry, FakeMergeEffects, handPlan, mergeCalls, sha } from './executeMerges.helpers.js';

describe('executeMerges — (e) bounded retry on "base branch was modified"', () => {
  const baseModified = {
    code: 1,
    stdout: '',
    stderr: 'error: base branch was modified. Please try again.',
  };

  test('fails twice then succeeds → merged, revalidation between attempts', async () => {
    const fake = new FakeMergeEffects();
    fake.heads.set(7, sha('a'));
    fake.mergeQueue.set(7, [
      baseModified,
      { ...baseModified, stderr: 'Base branch was modified — retry' },
      OK,
    ]);

    const report = await executeMerges({ plan: handPlan([entry(7)]), effects: fake });

    expect(report.merged).toEqual([7]);
    expect(report.failed).toEqual([]);
    expect(mergeCalls(fake).length).toBe(3);
    // The exact retry shape: attempt → FETCH+revalidate → attempt →
    // FETCH+revalidate → attempt (round 1: the between-attempt check
    // fetches first). Baseline + pre-merge + two between-attempt
    // revalidations = 4 validations total.
    expect(fake.calls).toEqual([
      'fetch:refs/pull/7/head', // baseline fetch (CR-4)
      'validate:refs/pull/7/head', // baseline
      'fetch:refs/pull/7/head',
      'validate:refs/pull/7/head', // pre-merge
      'readBase:7', // forge base re-read (#193)
      'merge:7:merge', // attempt 1 — base modified
      'fetch:refs/pull/7/head', // revalidation fetch FIRST (round 1)
      'validate:refs/pull/7/head', // revalidate
      'readBase:7', // base re-read between attempts (#193)
      'merge:7:merge', // attempt 2 — base modified
      'fetch:refs/pull/7/head',
      'validate:refs/pull/7/head',
      'readBase:7', // base re-read between attempts (#193)
      'merge:7:merge', // attempt 3 — merged
    ]);
  });

  test('a base that moves between attempt 1 and the retry → stale, never a second merge (#193)', async () => {
    const fake = new FakeMergeEffects();
    fake.heads.set(7, sha('a'));
    fake.mergeQueue.set(7, [baseModified, OK]); // attempt 1 fails retryably; attempt 2 would succeed
    fake.baseDriftRef = 'release'; // the forge retargets between attempts
    fake.baseDriftFromCall = 1; // call 0 (pre-merge) sees the planned base; call 1 (retry) sees the move

    const report = await executeMerges({ plan: handPlan([entry(7)]), effects: fake });

    expect(report.merged).toEqual([]);
    expect(report.failed).toEqual([]);
    expect(report.stale).toEqual([
      { pr: 7, detail: match.stringContaining('base moved while revalidating') },
    ]);
    // Exactly ONE merge attempt: the moved base stopped the retry before a
    // second merge could land in the changed base.
    expect(mergeCalls(fake)).toEqual(['merge:7:merge']);
    // The retry re-read happened AFTER the head revalidation.
    const afterFirstMerge = fake.calls.slice(fake.calls.indexOf('merge:7:merge') + 1);
    expect(afterFirstMerge).toEqual([
      'fetch:refs/pull/7/head',
      'validate:refs/pull/7/head',
      'readBase:7',
    ]);
  });

  test('the cap is honored: default 3 retries → at most 4 attempts, then failed', async () => {
    expect(DEFAULT_MAX_RETRIES).toBe(3);
    const fake = new FakeMergeEffects();
    fake.heads.set(7, sha('a'));
    fake.mergeQueue.set(7, [baseModified, baseModified, baseModified, baseModified]);

    const report = await executeMerges({ plan: handPlan([entry(7)]), effects: fake });

    expect(report.merged).toEqual([]);
    expect(report.failed).toEqual([
      { pr: 7, error: match.stringContaining('base branch was modified') },
    ]);
    expect(mergeCalls(fake).length).toBe(4); // 1 attempt + 3 retries, never a 5th
  });

  test('an explicit maxRetries bounds the attempts too', async () => {
    const fake = new FakeMergeEffects();
    fake.heads.set(7, sha('a'));
    fake.mergeQueue.set(7, [baseModified, baseModified, baseModified]);

    const report = await executeMerges({
      plan: handPlan([entry(7)]),
      effects: fake,
      maxRetries: 1,
    });
    expect(mergeCalls(fake).length).toBe(2); // 1 attempt + 1 retry
    expect(report.failed).toEqual([{ pr: 7, error: match.any(String) }]);
  });

  test('a non-retryable failure is recorded immediately, never retried', async () => {
    const fake = new FakeMergeEffects();
    fake.heads.set(7, sha('a'));
    fake.mergeQueue.set(7, [{ code: 1, stdout: '', stderr: 'Merge blocked by branch protection' }]);

    const report = await executeMerges({ plan: handPlan([entry(7)]), effects: fake });

    expect(report.merged).toEqual([]);
    expect(report.failed).toEqual([
      { pr: 7, error: match.stringContaining('Merge blocked by branch protection') },
    ]);
    expect(mergeCalls(fake)).toEqual(['merge:7:merge']); // exactly one attempt
    // No between-attempt revalidation ever ran (2 validations: baseline +
    // pre-merge only).
    expect(fake.calls.filter((call) => call.startsWith('validate:')).length).toBe(2);
  });

  test('a head that moves during a retry makes the action stale, not a blind retry', async () => {
    const fake = new FakeMergeEffects();
    fake.heads.set(7, sha('a'));
    fake.mergeQueue.set(7, [baseModified]);
    // Drift only from the THIRD validation: baseline (0) and the pre-merge
    // revalidation (1) still see the planned sha; the between-attempt
    // revalidation (2) sees the moved head.
    fake.driftSha = sha('z');
    fake.driftFromCall = 2;

    const report = await executeMerges({ plan: handPlan([entry(7)]), effects: fake });

    expect(report.merged).toEqual([]);
    expect(report.stale).toEqual([
      { pr: 7, detail: match.stringContaining('moved while revalidating') },
    ]);
    expect(mergeCalls(fake).length).toBe(1);
  });

  test('round-1 blind-retry regression: a REMOTE head that moves mid-retry → stale, never a second attempt', async () => {
    const fake = new FakeMergeEffects();
    fake.heads.set(7, sha('a'));
    fake.mergeQueue.set(7, [baseModified]); // attempt 1 fails retryably
    // The remote's sha timeline: the first TWO fetches (baseline + pre-merge)
    // still report the planned sha; the between-attempt fetch is what
    // reveals the move — a local-only revalidation would have missed it.
    fake.remoteQueue.set(7, [sha('a'), sha('a'), sha('f')]);

    const report = await executeMerges({ plan: handPlan([entry(7)]), effects: fake });

    expect(report.merged).toEqual([]);
    expect(report.stale).toEqual([
      { pr: 7, detail: match.stringContaining('moved while revalidating') },
    ]);
    expect(mergeCalls(fake)).toEqual(['merge:7:merge']); // never a blind second attempt
    // The between-attempt check FETCHED first — the fetch is what the
    // validation then read the moved sha through.
    const afterFirstMerge = fake.calls.slice(fake.calls.indexOf('merge:7:merge') + 1);
    expect(afterFirstMerge).toEqual(['fetch:refs/pull/7/head', 'validate:refs/pull/7/head']);
  });

  test('a nonzero fetch during between-attempt revalidation → failed (never retried blind)', async () => {
    const fake = new FakeMergeEffects();
    fake.heads.set(7, sha('a'));
    fake.mergeQueue.set(7, [baseModified]);
    // Fetch calls 0 (baseline) and 1 (pre-merge) pass; call 2 — the
    // between-attempt revalidation fetch — fails.
    fake.fetchFailFromCall.set(7, 2);

    const report = await executeMerges({ plan: handPlan([entry(7)]), effects: fake });

    expect(report.merged).toEqual([]);
    expect(report.stale).toEqual([]);
    expect(report.failed).toEqual([
      { pr: 7, error: match.stringContaining('retry revalidation: fetch') },
    ]);
    expect(mergeCalls(fake)).toEqual(['merge:7:merge']);
  });
});
