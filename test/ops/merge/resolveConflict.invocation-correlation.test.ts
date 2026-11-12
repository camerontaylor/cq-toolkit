// Split provenance: test/ops/merge/resolveConflict.test.ts was split into
// resolveConflict.{factory-resolution,parse-decision,render-prompt,refname-gate,op-outcomes,op-failures,acted-verification,forge-fact,shipped-prompt,invocation-correlation}.test.ts
// plus the shared fixtures in resolveConflict.helpers.ts (which carries the
// original group-by-group header).
// Subject: forward governed invocation correlation (M5b5).
// Fixtures and the full group header: ./resolveConflict.helpers.ts
import { describe, expect, test } from 'vitest';
import { runLadder } from '../../../src/kernel/governor.js';
import { makeResolveConflictOp } from '../../../src/ops/merge/resolveConflict.js';
import {
  completed,
  stopped,
  baseInput,
  FakeMergeEffects,
  FakeDriver,
  factoryOf,
  firstInvocation,
  fakeLoadPrompt,
  scanClean,
} from './resolveConflict.helpers.js';

// ---------------------------------------------------------------------------
// Forward governed invocation correlation (M5b5, session-log items 1.3–1.5)
// ---------------------------------------------------------------------------

describe('forward governed invocation correlation (M5b5)', () => {
  test('M5b5 nominal evidence', async () => {
    const effects = new FakeMergeEffects();
    const driver = new FakeDriver(completed({ decision: 'acted', summary: 'ok' }));
    const op = makeResolveConflictOp({
      effects,
      drivers: factoryOf(driver),
      loadPrompt: fakeLoadPrompt,
      scan: scanClean,
    });

    const outcome = await runLadder(
      () => op(baseInput()),
      {},
      {
        op: 'merge.resolveConflict',
        jobKey: 'j1',
        attempt: 1,
        correlation: { workId: 'run:j1:1', runId: 'run', role: 'merge.resolveConflict' },
      },
    );
    expect(outcome.outcome).toBe('completed');
    // Every OpInvocation built at this site forwards the shared helper
    // result VERBATIM — run/work/parent/role do not silently inherit the
    // outer job; they are exactly what the runner minted.
    expect(driver.invocations).toHaveLength(1);
    expect(firstInvocation(driver).correlation).toEqual({
      workId: 'run:j1:1',
      runId: 'run',
      role: 'merge.resolveConflict',
    });
  });

  test('M5b5 missing evidence', async () => {
    const driver = new FakeDriver(completed({ decision: 'acted', summary: 'ok' }));
    const op = makeResolveConflictOp({
      effects: new FakeMergeEffects(),
      drivers: factoryOf(driver),
      loadPrompt: fakeLoadPrompt,
      scan: scanClean,
    });

    // Ungoverned dispatch (no job context): the invocation carries NO
    // correlation key at all — the exactOptionalPropertyTypes-safe spread
    // of the shared helper's `{}`.
    const result = await op(baseInput());
    expect(result.status).toBe('ok');
    expect('correlation' in firstInvocation(driver)).toBe(false);

    // Governed dispatch whose ladder info carries no correlation either
    // (a job the runner minted no work unit for): still no correlation.
    const driver2 = new FakeDriver(completed({ decision: 'acted', summary: 'ok' }));
    const op2 = makeResolveConflictOp({
      effects: new FakeMergeEffects(),
      drivers: factoryOf(driver2),
      loadPrompt: fakeLoadPrompt,
      scan: scanClean,
    });
    const outcome = await runLadder(
      () => op2(baseInput()),
      {},
      { op: 'merge.resolveConflict', jobKey: 'j2', attempt: 1 },
    );
    expect(outcome.outcome).toBe('completed');
    expect('correlation' in firstInvocation(driver2)).toBe(false);
  });

  test('M5b5 failure evidence', async () => {
    // Even on a NON-complete worker run the invocation was still built —
    // and the correlation is the shared helper's result, with a role that
    // is NOT inherited from the outer job (a correlation with no role gets
    // the helper's fixer fallback, never the op's own role).
    const effects = new FakeMergeEffects();
    const driver = new FakeDriver(stopped('aborted'));
    const op = makeResolveConflictOp({
      effects,
      drivers: factoryOf(driver),
      loadPrompt: fakeLoadPrompt,
      scan: scanClean,
    });

    const outcome = await runLadder(
      () => op(baseInput()),
      {},
      {
        op: 'merge.resolveConflict',
        jobKey: 'j3',
        attempt: 2,
        correlation: { workId: 'run:j3:2', runId: 'run' },
      },
    );
    expect(outcome.outcome).toBe('completed'); // the op maps non-complete honestly, it does not throw
    // stopReason 'aborted' maps FIRST (§2.9 row f): the settled value is
    // indeterminate — neither success nor failure.
    if (outcome.outcome === 'completed') {
      expect(outcome.value.status).toBe('indeterminate');
    }
    expect(driver.invocations).toHaveLength(1);
    expect(firstInvocation(driver).correlation).toEqual({
      workId: 'run:j3:2',
      runId: 'run',
      role: 'fixer',
    });
    // Direct: the missing role falls back to the shared helper's 'fixer'
    // default, never the op's own role.
    expect(firstInvocation(driver).correlation?.role).toBe('fixer');
  });
});
