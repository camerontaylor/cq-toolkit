// Split provenance: test/ops/merge/resolveConflict.test.ts was split into
// resolveConflict.{factory-resolution,parse-decision,render-prompt,refname-gate,op-outcomes,op-failures,acted-verification,forge-fact,shipped-prompt,invocation-correlation}.test.ts
// plus the shared fixtures in resolveConflict.helpers.ts (which carries the
// original group-by-group header).
// Subject: Factory resolution (ADR-0002 §2.5) — header group 2.
// Fixtures and the full group header: ./resolveConflict.helpers.ts
import { describe, expect, test } from 'vitest';
import { defaultHarnessConfig } from '../../../src/harness/config.js';
import { DispatchError } from '../../../src/driver/errors.js';
import type { DriverFactory, DriverRequest, ResolvedDriver } from '../../../src/driver/factory.js';
import {
  makeResolveConflictOp,
  default as resolveConflictOp,
} from '../../../src/ops/merge/resolveConflict.js';
import {
  MODEL_SPEC,
  completed,
  baseInput,
  FakeMergeEffects,
  FakeDriver,
  factoryOf,
  firstRequest,
  firstInvocation,
  fakeLoadPrompt,
  scanClean,
} from './resolveConflict.helpers.js';

// ---------------------------------------------------------------------------
// Factory resolution (ADR-0002 §2.5)
// ---------------------------------------------------------------------------

describe('resolveConflict resolves its worker through the DriverFactory', () => {
  test('the request carries role conflict-resolver and the input modelSpec; the harness dep rides the request', async () => {
    const driver = new FakeDriver(completed({ decision: 'acted', summary: 'ok' }));
    const withHarness = factoryOf(driver);
    const opWith = makeResolveConflictOp({
      effects: new FakeMergeEffects(),
      drivers: withHarness,
      loadPrompt: fakeLoadPrompt,
      harnessConfig: defaultHarnessConfig,
      scan: scanClean,
    });
    await opWith(baseInput());
    expect(firstRequest(withHarness)).toEqual({
      role: 'conflict-resolver',
      modelSpec: MODEL_SPEC,
      harness: defaultHarnessConfig,
    });

    // Without the dep the request carries NO harness key (the factory's
    // own default applies).
    const withoutHarness = factoryOf(
      new FakeDriver(completed({ decision: 'acted', summary: 'ok' })),
    );
    const opWithout = makeResolveConflictOp({
      effects: new FakeMergeEffects(),
      drivers: withoutHarness,
      loadPrompt: fakeLoadPrompt,
      scan: scanClean,
    });
    await opWithout(baseInput());
    const request = firstRequest(withoutHarness);
    expect(request.role).toBe('conflict-resolver');
    expect(request.modelSpec).toEqual(MODEL_SPEC);
    expect('harness' in request).toBe(false);
  });

  test('the invocation carries the factory-NORMALISED modelSpec, never the input spec', async () => {
    // The deprecated 'ai-sdk' provider handle is the case normalisation
    // exists for: the fake factory models the real one's behaviour
    // (provider 'ai-sdk' → 'zai') and the invocation must carry the
    // NORMALISED spec.
    const driver = new FakeDriver(completed({ decision: 'acted', summary: 'ok' }));
    const normalised: DriverFactory = {
      resolve: (request: DriverRequest): ResolvedDriver => ({
        driver,
        lane: 'ai-sdk',
        modelSpec: { ...request.modelSpec, provider: 'zai' },
      }),
    };
    const op = makeResolveConflictOp({
      effects: new FakeMergeEffects(),
      drivers: normalised,
      loadPrompt: fakeLoadPrompt,
      scan: scanClean,
    });
    await op({ ...baseInput(), modelSpec: { model: 'resolver-model', provider: 'ai-sdk' } });
    const invocation = firstInvocation(driver);
    expect(invocation.modelSpec).toEqual({ model: 'resolver-model', provider: 'zai' });
  });

  test('a resolve throw with the config class is needs-human — before ANY effect runs', async () => {
    // The real factory throws DispatchError('config') for an unbound
    // provider; the fake hands the op the same surface (§2.9: a
    // 'config'/'auth' pre-dispatch throw is the human's to arrange).
    const broken: DriverFactory = {
      resolve: () => {
        throw new DispatchError('config', "no lane binding for role 'conflict-resolver'");
      },
    };
    const effects = new FakeMergeEffects();
    const op = makeResolveConflictOp({ effects, drivers: broken, loadPrompt: fakeLoadPrompt });

    const result = await op(baseInput());
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') {
      expect(result.reason).toContain('could not dispatch');
      expect(result.reason).toContain('no lane binding');
    }
    // Fail-closed ordering: the refusal precedes the truth fetch — no
    // worktree, no dispatch.
    expect(effects.calls).toEqual([]);
  });

  test('the default op builds — deps default lazily, nothing runs at construction', () => {
    expect(() => makeResolveConflictOp()).not.toThrow();
    expect(typeof makeResolveConflictOp()).toBe('function');
    expect(typeof resolveConflictOp).toBe('function');
  });
});
