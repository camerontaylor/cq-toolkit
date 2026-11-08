// Split from self-review-loop.test.ts (pure move); shared fixtures in ./self-review-loop-fakes.js.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import type { OpRegistryView } from '../../src/kernel/runner.js';
import type { GhResult } from '../../src/adapters/forge-github/gh.js';
import { runSelfReviewLoop } from '../../src/selfhost/self-review-loop.js';
import { SelfhostDefaults, SelfhostPeak } from '../../src/selfhost/config.js';
import {
  OWNER,
  REPO,
  REPO_PATH,
  type RecordedCall,
  baseCfg,
  baseDeps,
  cleanupTempRoots,
  fakeGh,
  fakeLoop,
  fakeOutcome,
  outcomeWithFixCost,
  pullRow,
  tempJournalRoot,
} from './self-review-loop-fakes.js';

afterEach(cleanupTempRoots);

describe('runSelfReviewLoop — real run', () => {
  test('loops exactly the open same-repo non-draft PRs; passthrough of responderLogin, driver, and journal shapes', async () => {
    const calls: RecordedCall[] = [];
    const journalRoot = tempJournalRoot();
    const gh = fakeGh([
      pullRow(7),
      pullRow(8, { draft: true }), // skipped: draft
      pullRow(9, { headRepo: 'octo/fork' }), // skipped: fork (#142)
      pullRow(10),
    ]);
    const summary = await runSelfReviewLoop(
      baseDeps(
        gh,
        fakeLoop(calls, async (pr) => fakeOutcome(pr)),
      ),
      baseCfg({ journalRoot }),
    );

    // Only PRs 7 and 10 were loopable; both resolved. The skipped rows are
    // RECORDED, not silently dropped: the real run's `excluded` rows carry
    // the same reason strings the dry run surfaces.
    expect(summary.results.map((row) => row.pr)).toEqual([7, 10]);
    expect(summary.failures).toEqual([]);
    expect(summary.excluded).toEqual([
      { pr: 8, reason: 'draft' },
      { pr: 9, reason: 'forked-pr (head repo octo/fork)' },
    ]);
    expect(calls).toHaveLength(2);

    const first = calls[0]?.opts;
    if (first === undefined) throw new Error('the first loop call never happened');
    // Identity passthrough (the round-3 deployment requirement).
    expect(first.responderLogin).toBeNull(); // baseCfg default; overridden in the next test
    // The off-peak driver (this fixture clock, Tue 2023-11-14T22:13:20Z, is
    // outside the peak window): resolved from the run's start stamp, never a
    // vendor choice invented here.
    expect(first.driver).toEqual(SelfhostDefaults.driver);
    expect(first.owner).toBe(OWNER);
    expect(first.repo).toBe(REPO);
    expect(first.pr).toBe(7);
    expect(first.headRefName).toBe('pr-7');
    expect(first.repoRoot).toBe('/checkout');
    // Journal shapes: one dir per PR namespaced by the ONE run stamp; the
    // dispatch log persists per PR directly under the journal root.
    expect(first.runOptions?.journalDir).toBe(join(journalRoot, '7-1700000000000'));
    // Token cap by default; NO USD cap (the served model is unpriced).
    expect(first.runOptions?.maxTokens).toBe(SelfhostDefaults.maxTokens);
    expect(first.runOptions?.maxUsd).toBeUndefined();
    expect(first.dispatchLogPath).toBe(join(journalRoot, 'dispatch-7.ndjson'));
    // Worktrees live under the gitignored runtime root.
    expect(first.worktreeRoot).toBe('/checkout/.selfhost/worktrees');
    // THE CLASSIFY DEFAULT RIDES UNCHANGED: no override is passed, so
    // runReviewLoop's defaultLoopClassifyConfig (bot suppression ON) applies.
    expect(first.classifyConfig).toBeUndefined();
    // No registry-view injection → absent (runReviewLoop builds its default).
    expect(first.driverRegistryView).toBeUndefined();
    // The wall-clock ladder rides every loop (KyE / #137): the frozen
    // default, wrapped in the LIMITS half's one-field shape.
    expect(first.limits).toEqual({ perJobWallClockMs: SelfhostDefaults.perJobWallClockMs });
  });

  test('the run start stamp selects the driver: a peak clock dispatches the peak provider', async () => {
    const calls: RecordedCall[] = [];
    const journalRoot = tempJournalRoot();
    const gh = fakeGh([pullRow(7), pullRow(11)]);
    const summary = await runSelfReviewLoop(
      {
        ...baseDeps(
          gh,
          fakeLoop(calls, async (pr) => fakeOutcome(pr)),
        ),
        // 2026-10-12T07:00:00Z — a Monday inside the 06:00–10:00 UTC peak.
        nowMs: () => Date.parse('2026-10-12T07:00:00Z'),
      },
      baseCfg({ journalRoot }),
    );
    expect(summary.results.map((row) => row.pr)).toEqual([7, 11]);
    // ONE clock read decides the driver for the whole sweep: every loop's
    // opts carry the same resolved peak driver.
    expect(calls.map((call) => call.opts.driver)).toEqual([
      SelfhostPeak.driver,
      SelfhostPeak.driver,
    ]);
  });

  test('cfg.startedAtMs pins the driver and the journal stamp to ONE instant', async () => {
    const calls: RecordedCall[] = [];
    const journalRoot = tempJournalRoot();
    const startedAt = Date.parse('2026-10-12T07:00:00Z'); // inside the peak
    // A later read (what a second clock read would return) is OFF-peak: if the
    // sweep read its own clock, both the driver and the stamp would flip.
    const laterRead = Date.parse('2026-10-12T12:00:00Z');
    let reads = 0;
    const gh = fakeGh([pullRow(7)]);
    const summary = await runSelfReviewLoop(
      {
        gh,
        git: async (): Promise<GhResult> => ({ code: 0, stdout: journalRoot, stderr: '' }),
        nowMs: () => {
          reads += 1;
          return laterRead;
        },
        loop: fakeLoop(calls, async (pr) => fakeOutcome(pr)),
      },
      baseCfg({ journalRoot, startedAtMs: startedAt }),
    );
    expect(summary.results.map((row) => row.pr)).toEqual([7]);
    // The threaded instant drives BOTH the peak driver and the run stamp …
    expect(calls[0]?.opts.driver).toEqual(SelfhostPeak.driver);
    expect(calls[0]?.opts.runOptions?.journalDir).toBe(join(journalRoot, `7-${String(startedAt)}`));
    // … so the sweep reads no clock of its own for the stamp; the only read is
    // the loop's own per-PR opts.nowMs snapshot.
    expect(reads).toBe(1);
    expect(calls[0]?.opts.nowMs).toBe(laterRead);
  });

  test('responderLogin and maxUsd overrides reach the loop opts; the clock is read per PR', async () => {
    const calls: RecordedCall[] = [];
    let tick = 0;
    const journalRoot = tempJournalRoot();
    const gh = fakeGh([pullRow(7), pullRow(8)]);
    const summary = await runSelfReviewLoop(
      {
        gh,
        git: async (): Promise<GhResult> => ({ code: 0, stdout: journalRoot, stderr: '' }),
        nowMs: () => (tick += 1),
        loop: fakeLoop(calls, async (pr) => fakeOutcome(pr)),
      },
      baseCfg({ responderLogin: 'cq-loop-bot', maxUsd: 2, journalRoot }),
    );

    expect(summary.results).toHaveLength(2);
    expect(calls[0]?.opts.responderLogin).toBe('cq-loop-bot');
    expect(calls[0]?.opts.runOptions?.maxUsd).toBe(2);
    // One stamp read before the loop, one clock read per PR for the loop's
    // own nowMs — the per-PR stamps differ (fresh snapshots).
    expect(calls[0]?.opts.nowMs).toBe(2);
    expect(calls[1]?.opts.nowMs).toBe(3);
    expect(calls[0]?.opts.runOptions?.journalDir).toBe(join(journalRoot, '7-1'));
    expect(calls[1]?.opts.runOptions?.journalDir).toBe(join(journalRoot, '8-1'));
  });

  test('per-PR fault isolation: a throwing loop records the failure, its siblings continue', async () => {
    const calls: RecordedCall[] = [];
    const gh = fakeGh([pullRow(7), pullRow(8)]);
    const summary = await runSelfReviewLoop(
      baseDeps(
        gh,
        fakeLoop(calls, async (pr) => {
          if (pr === 8) throw new Error('injected loop boom\nsecond line of spew');
          return fakeOutcome(pr);
        }),
      ),
      baseCfg({ journalRoot: tempJournalRoot() }),
    );

    expect(summary.results.map((row) => row.pr)).toEqual([7]);
    expect(summary.failures).toEqual([
      {
        // ONE line — a log fact, not the dump. No dispatch-log line was
        // written, so the throw carried NO spend evidence and the sweep
        // budget was NOT burned (the spend-evidence-gated rule, KyI) — the
        // fail-closed suffix rides only a burn that happened.
        pr: 8,
        error: 'injected loop boom',
      },
    ]);
    expect(calls).toHaveLength(2); // the sibling was still attempted
  });

  test('first-run journal root: a NON-EXISTENT nested journalRoot is created and the run succeeds (KyA)', async () => {
    const calls: RecordedCall[] = [];
    // Point journalRoot at a path whose PARENT does not exist either — the
    // first-run / cache-miss shape. Before the fix the registry's withLock
    // needed `<journalRoot>/worktree-registry.json.lock` here and every PR
    // failed at resolvePrWorktree; the entry must create the root itself.
    const base = tempJournalRoot();
    const journalRoot = join(base, 'first', 'run', 'journal');
    expect(existsSync(journalRoot)).toBe(false);
    const gh = fakeGh([pullRow(7), pullRow(8)]);
    const summary = await runSelfReviewLoop(
      baseDeps(
        gh,
        fakeLoop(calls, async (pr) => fakeOutcome(pr)),
      ),
      baseCfg({ journalRoot }),
    );

    expect(summary.results.map((row) => row.pr)).toEqual([7, 8]);
    expect(summary.failures).toEqual([]);
    expect(existsSync(journalRoot)).toBe(true); // created, recursively
  });

  test('a thrown loop deducts its PROPAGATED accounted spend (#186): the failure row says so and the next PR sees the remainder', async () => {
    const calls: RecordedCall[] = [];
    const gh = fakeGh([pullRow(7), pullRow(8), pullRow(9)]);
    const summary = await runSelfReviewLoop(
      baseDeps(
        gh,
        fakeLoop(calls, async (pr, opts) => {
          if (pr === 7) {
            // Spend and THROW: the loop propagates the accounted spend
            // through onSpend (its finally report in production), so the
            // entry deducts the KNOWN amount and carries the remainder —
            // no whole-sweep burn, no dispatch-log proxy.
            opts.onSpend?.(1);
            throw new Error('injected loop boom after spend');
          }
          return outcomeWithFixCost(pr, 1);
        }),
      ),
      baseCfg({ maxUsd: 3, journalRoot: tempJournalRoot() }),
    );

    // PR 7 spent 1 of 3 then threw: PR 8 runs with the remaining 2, PR 9 too.
    expect(calls.map((call) => call.opts.pr)).toEqual([7, 8, 9]);
    expect(calls[1]?.opts.runOptions?.maxUsd).toBe(2);
    expect(summary.failures).toEqual([
      {
        pr: 7,
        error: 'injected loop boom after spend — accounted spend 1 deducted from the sweep budget',
      },
    ]);
    expect(summary.excluded).toEqual([]);
    expect(summary.results.map((row) => row.pr)).toEqual([8, 9]);
  });

  test('a loop that throws BEFORE any spend carries the budget forward (nothing to deduct)', async () => {
    const calls: RecordedCall[] = [];
    const gh = fakeGh([pullRow(7), pullRow(8)]);
    const summary = await runSelfReviewLoop(
      baseDeps(
        gh,
        fakeLoop(calls, async (pr) => {
          if (pr === 7) {
            // Throw at entry — a worktree/registry-style fault with no
            // propagated spend: nothing was spent, so the budget must carry
            // forward and the sibling must still run (an unconditional burn
            // would let this PR starve every later PR).
            throw new Error('injected pre-spend fault');
          }
          return outcomeWithFixCost(pr, 1);
        }),
      ),
      baseCfg({ maxUsd: 2, journalRoot: tempJournalRoot() }),
    );

    // PR 8 was dispatched against the FULL remaining allowance, and PR 7's
    // failure row is the plain message — no spend suffix.
    expect(calls.map((call) => call.opts.pr)).toEqual([7, 8]);
    expect(calls[1]?.opts.runOptions?.maxUsd).toBe(2);
    expect(summary.results.map((row) => row.pr)).toEqual([8]);
    expect(summary.failures).toEqual([{ pr: 7, error: 'injected pre-spend fault' }]);
    expect(summary.excluded).toEqual([]);
  });

  test('a listing row without a PR number is recorded as excluded, not silently skipped', async () => {
    const calls: RecordedCall[] = [];
    const gh = fakeGh([
      { state: 'open', draft: false, head: { ref: 'x', sha: 's', repo: { full_name: REPO_PATH } } },
      pullRow(7),
    ]);
    const summary = await runSelfReviewLoop(
      baseDeps(
        gh,
        fakeLoop(calls, async (pr) => fakeOutcome(pr)),
      ),
      baseCfg({ journalRoot: tempJournalRoot() }),
    );
    expect(summary.excluded).toEqual([
      { pr: 0, reason: 'fetch-failed: listing row without a PR number' },
    ]);
    expect(summary.results.map((row) => row.pr)).toEqual([7]);
    expect(calls).toHaveLength(1); // only the numbered PR reached the loop
  });

  test('a listing row without a head ref is recorded as excluded, never dispatched on an unverifiable head', async () => {
    // CLI-substitute finding: an absent `head.ref` maps to an empty
    // headRefName; without the pre-loop guard it would pass every gate
    // (`''` !== the protected branch, and the revalidation's `'' === ''`
    // compare vouches for itself) and dispatch with an empty branch.
    const calls: RecordedCall[] = [];
    const gh = fakeGh([pullRow(8, { ref: '' }), pullRow(7)]);
    const summary = await runSelfReviewLoop(
      baseDeps(
        gh,
        fakeLoop(calls, async (pr) => fakeOutcome(pr)),
      ),
      baseCfg({ journalRoot: tempJournalRoot() }),
    );
    expect(summary.excluded).toEqual([
      { pr: 8, reason: 'fetch-failed: listing row without a head ref' },
    ]);
    expect(summary.results.map((row) => row.pr)).toEqual([7]);
    expect(calls).toHaveLength(1); // only the head-ref'd PR reached the loop
  });

  test('driverRegistryView injection rides through to the loop opts', async () => {
    const calls: RecordedCall[] = [];
    const view: OpRegistryView = { get: () => undefined };
    const gh = fakeGh([pullRow(7)]);
    await runSelfReviewLoop(
      {
        ...baseDeps(
          gh,
          fakeLoop(calls, async (pr) => fakeOutcome(pr)),
        ),
        driverRegistryView: view,
      },
      baseCfg({ journalRoot: tempJournalRoot() }),
    );
    expect(calls[0]?.opts.driverRegistryView).toBe(view);
  });
});
