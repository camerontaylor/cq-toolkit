// Split provenance: test/ops/merge/resolveConflict.test.ts was split into
// resolveConflict.{factory-resolution,parse-decision,render-prompt,refname-gate,op-outcomes,op-failures,acted-verification,forge-fact,shipped-prompt,invocation-correlation}.test.ts
// plus the shared fixtures in resolveConflict.helpers.ts (which carries the
// original group-by-group header).
// Subject: 'resolveConflict op' failure surfaces — header group 5 (second half).
// Fixtures and the full group header: ./resolveConflict.helpers.ts
import { describe, expect, test } from 'vitest';
import { currentJobContext, runLadder } from '../../../src/kernel/governor.js';
import { headRefFor } from '../../../src/adapters/forge-github/mergeEffects.js';
import { makeResolveConflictOp } from '../../../src/ops/merge/resolveConflict.js';
import {
  ZERO_USAGE,
  MODEL_SPEC,
  completed,
  baseInput,
  lateBoundInput,
  FakeMergeEffects,
  FakeDriver,
  factoryOf,
  failedError,
  fakeLoadPrompt,
  scanClean,
} from './resolveConflict.helpers.js';

// ---------------------------------------------------------------------------
// The op
// ---------------------------------------------------------------------------

describe('resolveConflict op', () => {
  test('a nonzero fetchRef fails closed before any worktree exists', async () => {
    const effects = new FakeMergeEffects();
    effects.fetchCode = 128;
    effects.fetchStderr = 'fatal: could not read from remote repository';
    const driver = new FakeDriver(completed({ decision: 'acted', summary: 'pushed' }));
    const op = makeResolveConflictOp({
      effects,
      drivers: factoryOf(driver),
      loadPrompt: fakeLoadPrompt,
      scan: scanClean,
    });

    const result = await op(baseInput());
    expect(result.status).toBe('failed');
    expect(failedError(result)).toContain('exit 128');
    // Fail closed: fetch only — no prepare, no remove, no dispatch.
    expect(effects.calls).toEqual([`fetch:${headRefFor(44)}`]);
    expect(driver.invocations).toHaveLength(0);
  });

  test('a throwing fetchRef fails too (a rejecting effect is an outcome, not a crash)', async () => {
    const effects = new FakeMergeEffects();
    effects.fetchThrows = new Error('git spawn lost');
    const driver = new FakeDriver(completed({ decision: 'acted', summary: 'pushed' }));
    const op = makeResolveConflictOp({
      effects,
      drivers: factoryOf(driver),
      loadPrompt: fakeLoadPrompt,
      scan: scanClean,
    });

    const result = await op(baseInput());
    expect(result.status).toBe('failed');
    expect(failedError(result)).toContain('git spawn lost');
  });

  test('worktreePrepare throw → failed with the message; remove NOT called (nothing prepared)', async () => {
    const effects = new FakeMergeEffects();
    effects.prepareThrows = new Error('worktree add exploded');
    const driver = new FakeDriver(completed({ decision: 'acted', summary: 'pushed' }));
    const op = makeResolveConflictOp({
      effects,
      drivers: factoryOf(driver),
      loadPrompt: fakeLoadPrompt,
      scan: scanClean,
    });

    const result = await op(baseInput());
    expect(result.status).toBe('failed');
    expect(failedError(result)).toContain('worktree add exploded');
    // withPreparedWorktree's contract, pinned from the op's side: the
    // prepare throw propagates untouched — fn never ran, so nothing was
    // prepared and there is nothing to remove.
    expect(effects.calls).toEqual([
      `fetch:${headRefFor(44)}`,
      `validate:${headRefFor(44)}`,
      `prepare:44@${headRefFor(44)}`,
    ]);
    expect(driver.invocations).toHaveLength(0);
  });

  test('modelSpec missing at dispatch → failed naming modelSpec; nothing runs', async () => {
    const effects = new FakeMergeEffects();
    const driver = new FakeDriver(completed({ decision: 'acted', summary: 'pushed' }));
    const factory = factoryOf(driver);
    const op = makeResolveConflictOp({
      effects,
      drivers: factory,
      loadPrompt: fakeLoadPrompt,
      scan: scanClean,
    });

    const result = await op(lateBoundInput());
    expect(result.status).toBe('failed');
    expect(failedError(result)).toContain('modelSpec');
    // Refused BEFORE any effect, resolution, or dispatch — no truth fetch,
    // no tree, no factory request, no fabricated vendor default.
    expect(effects.calls).toEqual([]);
    expect(factory.requests).toHaveLength(0);
    expect(driver.invocations).toHaveLength(0);
  });

  test('headBranch === protectedBranch → failed; zero effects/driver calls', async () => {
    const effects = new FakeMergeEffects();
    const driver = new FakeDriver(completed({ decision: 'acted', summary: 'pushed' }));
    const op = makeResolveConflictOp({
      effects,
      drivers: factoryOf(driver),
      loadPrompt: fakeLoadPrompt,
      scan: scanClean,
    });

    // headBranch 'main' with the default protectedBranch 'main' — a
    // cross-field rule the schema cannot express, refused before ANY
    // effect call.
    const result = await op({ ...baseInput(), headBranch: 'main' });
    expect(result.status).toBe('failed');
    expect(failedError(result)).toBe(
      'headBranch equals the protected branch — refusing to resolve a conflict whose publication destination is the protected branch',
    );
    expect(effects.calls).toEqual([]);
    expect(driver.invocations).toHaveLength(0);

    // Both spellings count: the refs/heads/-prefixed form names the same
    // ref, and the prompt's push refspec takes the headBranch verbatim —
    // HEAD:refs/heads/main would target the protected branch through a
    // bare-name-only comparison (codex review wave 2).
    const fullRef = await op({ ...baseInput(), headBranch: 'refs/heads/main' });
    expect(fullRef.status).toBe('failed');
    expect(failedError(fullRef)).toBe(
      'headBranch equals the protected branch — refusing to resolve a conflict whose publication destination is the protected branch',
    );
    // git also expands the short `heads/main` destination to refs/heads/main.
    const shortRef = await op({ ...baseInput(), headBranch: 'heads/main' });
    expect(shortRef.status).toBe('failed');
    expect(failedError(shortRef)).toBe(
      'headBranch equals the protected branch — refusing to resolve a conflict whose publication destination is the protected branch',
    );
    // The prefixed form of a DIFFERENT branch is untouched by the
    // normalization: it is not the protected branch and dispatch proceeds.
    const fullRefOther = await op({ ...baseInput(), headBranch: 'refs/heads/feature' });
    expect(fullRefOther.status).not.toBe('failed');
  });

  test('a driver pre-dispatch throw is needs-human, not a crash (#186)', async () => {
    const driver = new FakeDriver(new Error('unknown model for provider'));
    const op = makeResolveConflictOp({
      effects: new FakeMergeEffects(),
      drivers: factoryOf(driver),
      loadPrompt: fakeLoadPrompt,
      scan: scanClean,
    });

    const result = await op(baseInput());
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') {
      expect(result.reason).toContain('unknown model for provider');
      expect(result.reason).toContain('could not dispatch');
    }
  });

  test('the driver usage + cost are reported to the job context in ONE fold (#185)', async () => {
    const usage = { input: 12, output: 6, cacheRead: 0, cacheWrite: 0 };
    const driver = new FakeDriver({
      model: MODEL_SPEC.model,
      structuredOutput: { decision: 'acted', summary: 'pushed' },
      usage,
      costUSD: 0.11,
      denials: [],
      stopReason: 'complete',
    });
    const op = makeResolveConflictOp({
      effects: new FakeMergeEffects(),
      drivers: factoryOf(driver),
      loadPrompt: fakeLoadPrompt,
      scan: scanClean,
    });
    const reported: Array<{ usage?: unknown; costUSD?: number }> = [];
    const outcome = await runLadder(
      () => op(baseInput()),
      {},
      { op: 'merge.resolveConflict', jobKey: 'j1', attempt: 1 },
      { onResult: (result) => reported.push(result) },
    );
    expect(outcome.outcome).toBe('completed');
    // The op maps the conflict agent's WorkerResult into its own value
    // shape, so the governor's WorkerResult fold cannot see the spend — the
    // job-context report is the merge-plan governor's evidence (#185).
    expect(reported).toEqual([{ usage, costUSD: 0.11 }]);
  });

  test('a driver throw with the governed signal aborted → indeterminate (the ladder cancellation, #191 r2)', async () => {
    const driver = new FakeDriver(new Error('cancelled mid-run'));
    const op = makeResolveConflictOp({
      effects: new FakeMergeEffects(),
      drivers: factoryOf(driver),
      loadPrompt: fakeLoadPrompt,
      scan: scanClean,
    });
    const outcome = await runLadder(
      async () => {
        const signal = currentJobContext()?.signal;
        await new Promise<void>((resolve) => {
          if (signal?.aborted === true) {
            resolve();
            return;
          }
          signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        return op(baseInput());
      },
      { wallClockMs: 5, abortGraceMs: 60_000, killGraceMs: 60_000 },
      { op: 'merge.resolveConflict', jobKey: 'resolve-abort', attempt: 1 },
    );
    expect(outcome.outcome).toBe('completed');
    if (outcome.outcome === 'completed') {
      // The aborted signal makes the thrown run the governed cancellation
      // (I8) → indeterminate, not needs-human.
      expect(outcome.value.status).toBe('indeterminate');
    }
  });

  test('the parse dep is the output gate (an injected parser can read what the real one would refuse)', async () => {
    const driver = new FakeDriver(completed('raw text the real parser would refuse'));
    const op = makeResolveConflictOp({
      effects: new FakeMergeEffects(),
      drivers: factoryOf(driver),
      loadPrompt: fakeLoadPrompt,
      parse: () => ({ decision: 'acted', summary: 'read by the injected parser' }),
      scan: scanClean,
    });

    await expect(op(baseInput())).resolves.toEqual({
      status: 'ok',
      value: {
        pr: 44,
        decision: 'acted',
        summary: 'read by the injected parser',
        usage: ZERO_USAGE,
      },
    });
  });
});
