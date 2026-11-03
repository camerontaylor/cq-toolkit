// Split provenance: test/ops/merge/resolveConflict.test.ts was split into
// resolveConflict.{factory-resolution,parse-decision,render-prompt,refname-gate,op-outcomes,op-failures,acted-verification,forge-fact,shipped-prompt,invocation-correlation}.test.ts
// plus the shared fixtures in resolveConflict.helpers.ts (which carries the
// original group-by-group header).
// Subject: the acted verification — header group 6.
// Fixtures and the full group header: ./resolveConflict.helpers.ts
import { describe, expect, test } from 'vitest';
import { headRefFor } from '../../../src/adapters/forge-github/mergeEffects.js';
import { makeResolveConflictOp } from '../../../src/ops/merge/resolveConflict.js';
import {
  ZERO_USAGE,
  completed,
  baseInput,
  FakeMergeEffects,
  FakeDriver,
  factoryOf,
  failedError,
  fakeLoadPrompt,
} from './resolveConflict.helpers.js';

// ---------------------------------------------------------------------------
// The acted verification ('acted' is a self-report)
// ---------------------------------------------------------------------------

describe('the acted verification', () => {
  test('acted + the head MOVED → ok (the happy default)', async () => {
    const effects = new FakeMergeEffects(); // default: postSha ≠ baselineSha
    const driver = new FakeDriver(completed({ decision: 'acted', summary: 'pushed' }));
    const op = makeResolveConflictOp({
      effects,
      drivers: factoryOf(driver),
      loadPrompt: fakeLoadPrompt,
    });

    await expect(op(baseInput())).resolves.toEqual({
      status: 'ok',
      value: { pr: 44, decision: 'acted', summary: 'pushed', usage: ZERO_USAGE },
    });
  });

  test('acted + sha UNCHANGED → indeterminate with the did-not-move detail', async () => {
    const effects = new FakeMergeEffects();
    effects.postSha = effects.baselineSha; // the self-report lies
    const driver = new FakeDriver(completed({ decision: 'acted', summary: 'pushed' }));
    const op = makeResolveConflictOp({
      effects,
      drivers: factoryOf(driver),
      loadPrompt: fakeLoadPrompt,
    });

    const result = await op(baseInput());
    expect(result.status).toBe('indeterminate');
    if (result.status === 'indeterminate') {
      expect(result.detail).toContain('did not move');
      expect(result.detail).toContain(`baseline ${String(effects.baselineSha)}`);
      expect(result.detail).toContain(headRefFor(44));
    }
  });

  test('acted + head UNRESOLVABLE after the run → indeterminate', async () => {
    const effects = new FakeMergeEffects();
    effects.postSha = null;
    const driver = new FakeDriver(completed({ decision: 'acted', summary: 'pushed' }));
    const op = makeResolveConflictOp({
      effects,
      drivers: factoryOf(driver),
      loadPrompt: fakeLoadPrompt,
    });

    const result = await op(baseInput());
    expect(result.status).toBe('indeterminate');
    if (result.status === 'indeterminate') {
      expect(result.detail).toContain('did not move');
    }
  });

  test('a NONZERO verification fetch → indeterminate (unproven, not failed)', async () => {
    const effects = new FakeMergeEffects();
    effects.verifyFetchCode = 1;
    const driver = new FakeDriver(completed({ decision: 'acted', summary: 'pushed' }));
    const op = makeResolveConflictOp({
      effects,
      drivers: factoryOf(driver),
      loadPrompt: fakeLoadPrompt,
    });

    const result = await op(baseInput());
    expect(result.status).toBe('indeterminate');
    if (result.status === 'indeterminate') {
      expect(result.detail).toContain('did not move');
    }
  });

  test('a THROWING verification fetch → failed (totality)', async () => {
    const effects = new FakeMergeEffects();
    effects.verifyFetchThrows = new Error('verify fetch lost');
    const driver = new FakeDriver(completed({ decision: 'acted', summary: 'pushed' }));
    const op = makeResolveConflictOp({
      effects,
      drivers: factoryOf(driver),
      loadPrompt: fakeLoadPrompt,
    });

    const result = await op(baseInput());
    expect(result.status).toBe('failed');
    expect(failedError(result)).toContain('verify fetch lost');
  });

  test('a THROWING verification validateRef → failed (totality)', async () => {
    const effects = new FakeMergeEffects();
    effects.verifyValidateThrows = new Error('verify validate lost');
    const driver = new FakeDriver(completed({ decision: 'acted', summary: 'pushed' }));
    const op = makeResolveConflictOp({
      effects,
      drivers: factoryOf(driver),
      loadPrompt: fakeLoadPrompt,
    });

    const result = await op(baseInput());
    expect(result.status).toBe('failed');
    expect(failedError(result)).toContain('verify validate lost');
  });

  test('an UNRESOLVABLE baseline → indeterminate: unverifiable acted is never ok', async () => {
    const effects = new FakeMergeEffects();
    effects.baselineSha = null; // the head did not resolve pre-dispatch
    const driver = new FakeDriver(completed({ decision: 'acted', summary: 'pushed' }));
    const op = makeResolveConflictOp({
      effects,
      drivers: factoryOf(driver),
      loadPrompt: fakeLoadPrompt,
    });

    // Without a baseline the self-report cannot be checked — never ok.
    await expect(op(baseInput())).resolves.toEqual({
      status: 'indeterminate',
      detail:
        'conflict agent reported acted but the head ref was unverifiable (pre-dispatch baseline unresolvable)',
    });
    // The check never ran: the only validate is the baseline attempt.
    const validateCalls = effects.calls.filter((call) => call.startsWith('validate:'));
    expect(validateCalls).toEqual([`validate:${headRefFor(44)}`]);
  });

  test('acted payloads carry the session handle when the driver reported one', async () => {
    const effects = new FakeMergeEffects();
    effects.postSha = effects.baselineSha; // the self-report lies
    const driver = new FakeDriver(
      completed({ decision: 'acted', summary: 'pushed' }, 'ses-driver-1'),
    );
    const op = makeResolveConflictOp({
      effects,
      drivers: factoryOf(driver),
      loadPrompt: fakeLoadPrompt,
    });

    const result = await op(baseInput());
    expect(result.status).toBe('indeterminate');
    if (result.status === 'indeterminate') {
      expect(result.detail).toContain('did not move');
      expect(result.detail.endsWith('(session ses-driver-1)')).toBe(true);
    }

    // A failed payload shows the session id too.
    const failing = new FakeDriver(completed('I resolved everything fine', 'ses-driver-2'));
    const failedOp = makeResolveConflictOp({
      effects: new FakeMergeEffects(),
      drivers: factoryOf(failing),
      loadPrompt: fakeLoadPrompt,
    });
    const failedResult = await failedOp(baseInput());
    expect(failedResult.status).toBe('failed');
    expect(failedError(failedResult)).toContain('(session ses-driver-2)');
  });
});
