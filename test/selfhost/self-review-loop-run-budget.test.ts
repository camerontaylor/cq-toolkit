// Split from self-review-loop.test.ts (pure move); shared fixtures in ./self-review-loop-fakes.js.
import { readCqEnv } from '../../src/config/env.js';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { runSelfReviewLoop } from '../../src/selfhost/self-review-loop.js';
import { SelfhostDefaults } from '../../src/selfhost/config.js';
import {
  type RecordedCall,
  baseCfg,
  baseDeps,
  cleanupTempRoots,
  fakeGh,
  fakeLoop,
  fakeOutcome,
  outcomeWithFixCost,
  outcomeWithFixTokens,
  pullRow,
  tempJournalRoot,
} from './self-review-loop-fakes.js';

afterEach(cleanupTempRoots);

describe('runSelfReviewLoop — real run', () => {
  test('the maxUsd cap is sweep-level: a PR reached at zero remaining is recorded, not looped', async () => {
    const calls: RecordedCall[] = [];
    const gh = fakeGh([pullRow(7), pullRow(8)]);
    const summary = await runSelfReviewLoop(
      baseDeps(
        gh,
        fakeLoop(calls, async (pr) => outcomeWithFixCost(pr, 2)),
      ),
      baseCfg({ maxUsd: 1.5, journalRoot: tempJournalRoot() }),
    );

    // PR 7's fix run spent 2 of the 1.5 sweep cap; PR 8 never dispatches —
    // and the skip is a RECORDED row, never a silent one.
    expect(calls).toHaveLength(1);
    expect(summary.results.map((row) => row.pr)).toEqual([7]);
    expect(summary.excluded).toEqual([{ pr: 8, reason: 'sweep budget exhausted (I9)' }]);
  });

  test('the default TOKEN cap is sweep-level: unpriced usage carries forward and a spent budget records the PR', async () => {
    const calls: RecordedCall[] = [];
    const gh = fakeGh([pullRow(7), pullRow(8), pullRow(9)]);
    const summary = await runSelfReviewLoop(
      baseDeps(
        gh,
        fakeLoop(calls, async (pr) => outcomeWithFixTokens(pr, 600)),
      ),
      baseCfg({ maxTokens: 1000, journalRoot: tempJournalRoot() }),
    );

    // 1000 → 400 → -200: PR 9 is reached at ≤ 0 remaining and is a recorded
    // row. No USD cap is ever set (unpriced model), so no USD bookkeeping.
    expect(calls.map((call) => call.opts.runOptions?.maxTokens)).toEqual([1000, 400]);
    expect(calls.every((call) => call.opts.runOptions?.maxUsd === undefined)).toBe(true);
    expect(summary.results.map((row) => row.pr)).toEqual([7, 8]);
    expect(summary.excluded).toEqual([{ pr: 9, reason: 'sweep budget exhausted (I9)' }]);
    // D11b: the reported usage mirrors the gating budget exactly — the rows
    // were recorded where the carry-forward was decremented.
    expect(summary.usage).toEqual({
      capTokens: 1000,
      totalTokensUsed: 1200,
      perPrTokens: [
        { pr: 7, tokens: 600 },
        { pr: 8, tokens: 600 },
      ],
      remainingTokens: -200,
      exhausted: true,
    });
  });

  test('a thrown loop deducts its propagated TOKEN spend from the sweep budget', async () => {
    const calls: RecordedCall[] = [];
    const gh = fakeGh([pullRow(7), pullRow(8)]);
    const summary = await runSelfReviewLoop(
      baseDeps(
        gh,
        fakeLoop(calls, async (pr, opts) => {
          if (pr === 7) {
            opts.onSpend?.(0, 300);
            throw new Error('injected loop boom after token spend');
          }
          return fakeOutcome(pr);
        }),
      ),
      baseCfg({ maxTokens: 1000, journalRoot: tempJournalRoot() }),
    );

    expect(calls[1]?.opts.runOptions?.maxTokens).toBe(700);
    expect(summary.failures).toEqual([
      {
        pr: 7,
        error:
          'injected loop boom after token spend — accounted spend 0 and 300 tokens deducted from the sweep budget',
      },
    ]);
    // D11b: the thrown loop's PROPAGATED spend is the recorded row, and the
    // sibling whose report carries no finite rollup records 0 — every
    // looped PR appears exactly once.
    expect(summary.usage.perPrTokens).toEqual([
      { pr: 7, tokens: 300 },
      { pr: 8, tokens: 0 },
    ]);
    expect(summary.usage.remainingTokens).toBe(700);
    expect(summary.usage.exhausted).toBe(false);
  });

  test('the sweep cap carries forward: each loop gets the remaining budget, not a fresh cap', async () => {
    const calls: RecordedCall[] = [];
    const gh = fakeGh([pullRow(7), pullRow(8), pullRow(9)]);
    const summary = await runSelfReviewLoop(
      baseDeps(
        gh,
        fakeLoop(calls, async (pr) => outcomeWithFixCost(pr, 1)),
      ),
      baseCfg({ maxUsd: 3, journalRoot: tempJournalRoot() }),
    );

    // Per-PR maxUsd is the REMAINING sweep budget after each prior fix
    // run's cost rollup: 3 − 1 → 2 − 1 → 1. Three looped PRs, one cap.
    expect(calls.map((call) => call.opts.runOptions?.maxUsd)).toEqual([3, 2, 1]);
    expect(summary.results.map((row) => row.pr)).toEqual([7, 8, 9]);
    expect(summary.excluded).toEqual([]);
  });

  test('a PR whose head is the protected branch is excluded before the loop', async () => {
    const calls: RecordedCall[] = [];
    const gh = fakeGh([pullRow(7, { ref: 'main' }), pullRow(8)]);
    const summary = await runSelfReviewLoop(
      baseDeps(
        gh,
        fakeLoop(calls, async (pr) => fakeOutcome(pr)),
      ),
      baseCfg({ journalRoot: tempJournalRoot() }),
    );

    // The recorded reason names the rule: a review fix would push worker
    // commits to the protected branch.
    expect(summary.excluded).toEqual([
      {
        pr: 7,
        reason: `protected-branch head (a review fix would push worker commits to ${SelfhostDefaults.protectedBranch})`,
      },
    ]);
    expect(summary.results.map((row) => row.pr)).toEqual([8]);
    expect(calls.map((call) => call.opts.pr)).toEqual([8]); // the loop never ran for 7
  });

  test('the resolved CQ_MERGE_PROTECTED_BRANCH (either spelling) governs the protected-head exclusion', async () => {
    const calls: RecordedCall[] = [];
    const gh = fakeGh([pullRow(7, { ref: 'release' }), pullRow(8)]);
    const summary = await runSelfReviewLoop(
      baseDeps(
        gh,
        fakeLoop(calls, async (pr) => fakeOutcome(pr)),
      ),
      {
        ...baseCfg({ journalRoot: tempJournalRoot() }),
        cqEnv: readCqEnv({ CQ_MERGE_PROTECTED_BRANCH: 'refs/heads/release' }),
      },
    );
    expect(summary.excluded).toEqual([expect.objectContaining({ pr: 7 })]);
    expect(summary.results.map((row) => row.pr)).toEqual([8]);
  });

  test('an invalid CQ_MERGE_PROTECTED_BRANCH snapshot fails config before any gh call', async () => {
    const calls: RecordedCall[] = [];
    const gh = fakeGh([pullRow(7)]);
    let listed = 0;
    const counting = ((...args: Parameters<typeof gh>) => {
      listed += 1;
      return gh(...args);
    }) as typeof gh;
    const err = await runSelfReviewLoop(
      baseDeps(
        counting,
        fakeLoop(calls, async (pr) => fakeOutcome(pr)),
      ),
      {
        ...baseCfg({ journalRoot: tempJournalRoot() }),
        cqEnv: readCqEnv({ CQ_MERGE_PROTECTED_BRANCH: 'release branch' }),
      },
    ).catch((e: unknown) => e);
    expect((err as { dispatchClass?: string }).dispatchClass).toBe('config');
    expect(listed).toBe(0);
  });

  test('the bounded prune keeps the newest 5 audit dirs and never touches the dispatch logs', async () => {
    const calls: RecordedCall[] = [];
    const journalRoot = mkdtempSync(join(tmpdir(), 'self-review-loop-'));
    try {
      // 7 prior-run audit dirs (oldest stamp first) plus the flat dedupe
      // log and a non-matching journal resident the prune must leave alone.
      for (let i = 0; i < 7; i++) {
        mkdirSync(join(journalRoot, `7-${String(1_700_000_000_000 + i)}`), { recursive: true });
      }
      writeFileSync(join(journalRoot, 'dispatch-7.ndjson'), '{}\n');
      writeFileSync(join(journalRoot, 'worktree-registry.json'), '{}\n');

      const gh = fakeGh([pullRow(7)]);
      const summary = await runSelfReviewLoop(
        baseDeps(
          gh,
          fakeLoop(calls, async (pr) => fakeOutcome(pr)),
        ),
        baseCfg({ journalRoot }),
      );
      expect(summary.results).toHaveLength(1);

      // Exactly the five NEWEST stamps survive; the flat dispatch log (the
      // cross-run dedupe memory) and the registry never match the
      // `<pr>-<stamp>` directory pattern and ride untouched.
      const expected = [
        ...[2, 3, 4, 5, 6].map((i) => `7-${String(1_700_000_000_000 + i)}`),
        'dispatch-7.ndjson',
        'worktree-registry.json',
      ].sort();
      expect(readdirSync(journalRoot).sort()).toEqual(expected);
    } finally {
      rmSync(journalRoot, { recursive: true, force: true });
    }
  });
});
