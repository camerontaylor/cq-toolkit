// Split from self-review-loop.test.ts (pure move); shared fixtures in ./self-review-loop-fakes.js.
import { afterEach, describe, expect, test } from 'vitest';
import { runSelfReviewLoop } from '../../src/selfhost/self-review-loop.js';
import { SelfhostDefaults } from '../../src/selfhost/config.js';
import {
  REPO_PATH,
  type RecordedCall,
  baseCfg,
  baseDeps,
  cleanupTempRoots,
  fakeGh,
  fakeLoop,
  fakeOutcome,
  pullRow,
  tempJournalRoot,
} from './self-review-loop-fakes.js';

afterEach(cleanupTempRoots);

describe('runSelfReviewLoop — real run', () => {
  test('a head renamed since the listing is caught by the pre-dispatch revalidation — excluded row, loop never invoked', async () => {
    const calls: RecordedCall[] = [];
    const ghCalls: string[] = [];
    // The listing says head `pr-7`; the single-PR payload disagrees — the
    // branch was renamed between the listing read and this dispatch.
    const gh = fakeGh([pullRow(7)], {
      singlePull: () => ({ head: { ref: 'pr-7-renamed' } }),
      calls: ghCalls,
    });
    const summary = await runSelfReviewLoop(
      baseDeps(
        gh,
        fakeLoop(calls, async (pr) => fakeOutcome(pr)),
      ),
      baseCfg({ journalRoot: tempJournalRoot() }),
    );

    // Recorded, not silent — and the loop was NEVER dispatched against the
    // stale name (no fixes pushed to a branch the forge no longer names).
    expect(summary.results).toEqual([]);
    expect(summary.failures).toEqual([]);
    expect(summary.excluded).toEqual([
      { pr: 7, reason: 'head ref renamed since listing (pr-7 -> pr-7-renamed)' },
    ]);
    expect(calls).toHaveLength(0);
    // The revalidation rode the single-PR endpoint (the candidates argv
    // pattern), not some GraphQL detour.
    expect(ghCalls.some((line) => line.endsWith(`repos/${REPO_PATH}/pulls/7`))).toBe(true);
  });

  test('a PR closed or drafted after the listing is caught by the revalidation payload — excluded row, loop never invoked', async () => {
    const calls: RecordedCall[] = [];
    // Both payloads vouch for the LISTED head ref, so only the state/draft
    // half of the revalidation can stop these dispatches: PR 7 reads
    // closed, PR 8 reads converted-to-draft.
    const gh = fakeGh([pullRow(7), pullRow(8)], {
      singlePull: (pr) =>
        pr === 7
          ? { state: 'closed', draft: false, head: { ref: 'pr-7' } }
          : { state: 'open', draft: true, head: { ref: 'pr-8' } },
    });
    const summary = await runSelfReviewLoop(
      baseDeps(
        gh,
        fakeLoop(calls, async (pr) => fakeOutcome(pr)),
      ),
      baseCfg({ journalRoot: tempJournalRoot() }),
    );

    // Recorded exclusion-style rows naming the reason; the loop is never
    // dispatched against a PR the forge no longer shows open and non-draft.
    expect(summary.results).toEqual([]);
    expect(summary.failures).toEqual([]);
    expect(summary.excluded).toEqual([
      { pr: 7, reason: 'closed after listing' },
      { pr: 8, reason: 'converted to draft after listing' },
    ]);
    expect(calls).toHaveLength(0);
  });

  test('a failed head-revalidation read fails closed: a failure row, no dispatch, and the sibling still runs on an unburned budget', async () => {
    const calls: RecordedCall[] = [];
    // PR 7's revalidation GET exits 1; PR 8's vouches for its listed head
    // and its open, non-draft status.
    const gh = fakeGh([pullRow(7), pullRow(8)], {
      singlePull: (pr) =>
        pr === 7 ? 'fail' : { state: 'open', draft: false, head: { ref: `pr-${String(pr)}` } },
    });
    const summary = await runSelfReviewLoop(
      baseDeps(
        gh,
        fakeLoop(calls, async (pr) => fakeOutcome(pr)),
      ),
      baseCfg({ journalRoot: tempJournalRoot() }),
    );

    // PR 7: an unverifiable head is not a dispatchable head — failed row,
    // never dispatched.
    expect(summary.failures).toHaveLength(1);
    expect(summary.failures[0]?.pr).toBe(7);
    expect(summary.failures[0]?.error.startsWith('head revalidation failed: ')).toBe(true);
    // PR 8: the sibling carried on — and the sweep budget was NOT burned by
    // the skip (nothing was spent), so it ran against the full default cap.
    expect(summary.results.map((row) => row.pr)).toEqual([8]);
    expect(summary.excluded).toEqual([]);
    const eighth = calls.find((call) => call.opts.pr === 8);
    expect(eighth?.opts.runOptions?.maxTokens).toBe(SelfhostDefaults.maxTokens);
  });

  test('matching heads: every dispatched loop is preceded by exactly one vouching single-PR read', async () => {
    const calls: RecordedCall[] = [];
    const ghCalls: string[] = [];
    const gh = fakeGh([pullRow(7), pullRow(8)], { calls: ghCalls });
    const summary = await runSelfReviewLoop(
      baseDeps(
        gh,
        fakeLoop(calls, async (pr) => fakeOutcome(pr)),
      ),
      baseCfg({ journalRoot: tempJournalRoot() }),
    );

    // The ordinary world is unchanged: vouching payloads, both loops run.
    expect(summary.results.map((row) => row.pr)).toEqual([7, 8]);
    expect(summary.excluded).toEqual([]);
    expect(summary.failures).toEqual([]);
    // One revalidation GET per dispatched PR, in listing order.
    expect(ghCalls.filter((line) => /^api repos\/octo\/widget\/pulls\/\d+$/.test(line))).toEqual([
      `api repos/${REPO_PATH}/pulls/7`,
      `api repos/${REPO_PATH}/pulls/8`,
    ]);
  });
});
