// Strict-budget lane gate — the fail-closed boundary that keeps the shared
// `Budget.strictTokenBudget` promise honest on lanes that do NOT enforce a
// pre-request ceiling (subprocess / claude-agent / acp). A strict request
// routed to such a lane must REFUSE before any session, credential read, spawn
// or provider contact — via the factory's resolved-driver guard AND via direct
// lane construction. The ai-sdk lane (the one lane that enforces the ceiling)
// is unchanged: it still needs an injected trusted capability and still
// refuses without one.
//
// Offline: every lane is constructed with a throwing spy on its own dispatch
// seam (spawn / sdkLoader / spawn), so "not called" is the no-dispatch proof.
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import type { LanguageModelV4CallOptions, LanguageModelV4GenerateResult } from '@ai-sdk/provider';
import { assertStrictTokenBudgetSupported } from '../../src/driver/common/strict-budget.js';
import { DispatchError, errorClassOf } from '../../src/driver/errors.js';
import { AcpDriver } from '../../src/driver/acp/index.js';
import { AiSdkDriver } from '../../src/driver/ai-sdk/index.js';
import { ClaudeAgentDriver } from '../../src/driver/claude-agent/index.js';
import { createDriverFactory } from '../../src/driver/factory.js';
import type { DriverFactoryConfig } from '../../src/driver/factory.js';
import { SubprocessDriver } from '../../src/driver/subprocess/index.js';
import type { Driver, ModelSpec, OpInvocation } from '../../src/driver/types.js';

const STRICT = { strictTokenBudget: { maxInputTokens: 1000, reserveOutputTokens: 64 } };

function invocation(modelSpec: ModelSpec, budget: OpInvocation['budget'] = STRICT): OpInvocation {
  return {
    prompt: 'strict-budget guard probe',
    modelSpec,
    toolPolicy: { allow: [], mode: 'none' },
    sandboxPolicy: { level: 'none' },
    budget,
  };
}

/** A dispatch-seam spy that records the call and then fails loudly. */
function seamSpy(): { calls: number; fn: () => never } {
  const spy = {
    calls: 0,
    fn: (): never => {
      spy.calls += 1;
      throw new Error('dispatch-seam-reached');
    },
  };
  return spy;
}

async function scratch(): Promise<{ root: string; sessionsDir: string }> {
  const root = await mkdtemp(join(tmpdir(), 'cq-strict-guard-'));
  return { root, sessionsDir: join(root, 'sessions') };
}

// ---------------------------------------------------------------------------
// 1. The shared helper
// ---------------------------------------------------------------------------

describe('assertStrictTokenBudgetSupported', () => {
  test('refuses a strict budget on a non-ai-sdk lane as a config failure', () => {
    const err = (() => {
      try {
        assertStrictTokenBudgetSupported(
          { strictTokenBudget: { maxInputTokens: 1, reserveOutputTokens: 1 } },
          'subprocess',
        );
      } catch (caught) {
        return caught;
      }
      throw new Error('expected a refusal');
    })();
    expect(err).toBeInstanceOf(DispatchError);
    expect(errorClassOf(err)).toBe('config');
    expect((err as Error).message).toContain('strictTokenBudget');
    expect((err as Error).message).toContain('subprocess');
  });

  test('is a no-op for the ai-sdk lane and for a budget without a strict ceiling', () => {
    expect(() =>
      assertStrictTokenBudgetSupported(
        { strictTokenBudget: { maxInputTokens: 1, reserveOutputTokens: 1 } },
        'ai-sdk',
      ),
    ).not.toThrow();
    expect(() => assertStrictTokenBudgetSupported({ maxUsd: 5 }, 'subprocess')).not.toThrow();
    expect(() => assertStrictTokenBudgetSupported({}, 'claude-agent')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 2. Direct lane entry — refuse before the dispatch seam (and before sessions)
// ---------------------------------------------------------------------------

describe('direct lane entry refuses a strict budget before dispatch', () => {
  test('subprocess: config throw, seam untouched, no session store created', async () => {
    const { root, sessionsDir } = await scratch();
    try {
      const spy = seamSpy();
      const driver = new SubprocessDriver({ spawn: spy.fn, sessionsDir });
      const err = await driver
        .run(invocation({ provider: 'anthropic', model: 'claude-test' }))
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DispatchError);
      expect(errorClassOf(err)).toBe('config');
      // SPECIFIC guard phrase + lane: a lane-specific preflight failure
      // (missing route key) can no longer masquerade as this refusal.
      expect((err as Error).message).toContain('strictTokenBudget');
      expect((err as Error).message).toContain('does not enforce a pre-request token ceiling');
      expect((err as Error).message).toContain('subprocess');
      expect(spy.calls).toBe(0);
      expect(existsSync(sessionsDir)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('claude-agent: config throw, sdkLoader untouched, no session store created', async () => {
    const { root, sessionsDir } = await scratch();
    try {
      const spy = seamSpy();
      const driver = new ClaudeAgentDriver({ sdkLoader: spy.fn, sessionsDir });
      const err = await driver
        .run(invocation({ provider: 'anthropic', model: 'claude-test' }))
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DispatchError);
      expect(errorClassOf(err)).toBe('config');
      expect((err as Error).message).toContain('strictTokenBudget');
      expect((err as Error).message).toContain('does not enforce a pre-request token ceiling');
      expect((err as Error).message).toContain('claude-agent');
      expect(spy.calls).toBe(0);
      expect(existsSync(sessionsDir)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('acp: config throw, spawn untouched, no session store created', async () => {
    const { root, sessionsDir } = await scratch();
    try {
      const spy = seamSpy();
      const driver = new AcpDriver({ spawn: spy.fn, sessionsDir });
      const err = await driver
        .run(invocation({ provider: 'anthropic', model: 'claude-test' }))
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DispatchError);
      expect(errorClassOf(err)).toBe('config');
      expect((err as Error).message).toContain('strictTokenBudget');
      expect((err as Error).message).toContain('does not enforce a pre-request token ceiling');
      expect((err as Error).message).toContain('acp');
      expect(spy.calls).toBe(0);
      expect(existsSync(sessionsDir)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('maxUsd-only is NOT refused by the guard (advisory preserved)', async () => {
    const { root, sessionsDir } = await scratch();
    try {
      const spy = seamSpy();
      const driver = new SubprocessDriver({ spawn: spy.fn, sessionsDir });
      const err = await driver
        .run(invocation({ provider: 'anthropic', model: 'claude-test' }, { maxUsd: 1 }))
        .catch((e: unknown) => e);
      // The guard is a no-op for a non-strict budget: whatever happens next
      // (here a normal lane pre-dispatch route/env check) is NOT the
      // strict-budget refusal.
      expect(String((err as Error).message)).not.toContain(
        'does not enforce a pre-request token ceiling',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Factory resolved-driver guard — exact and wildcard bindings, all 3 lanes
// ---------------------------------------------------------------------------

describe('factory guard refuses a strict budget on unsupported lanes', () => {
  const lanes = ['subprocess', 'claude-agent', 'acp'] as const;

  for (const lane of lanes) {
    for (const binding of ['exact', 'wildcard'] as const) {
      test(`${lane} (${binding} binding): config throw before dispatch`, async () => {
        const { root, sessionsDir } = await scratch();
        try {
          const factory = createDriverFactory({
            sessionsDir,
            bindings: { fixer: binding === 'exact' ? { probe: lane } : { '*': lane } },
          });
          const resolved = factory.resolve({
            role: 'fixer',
            modelSpec: { provider: 'probe', model: 'claude-test' },
          });
          expect(resolved.lane).toBe(lane);
          const err = await resolved.driver
            .run(invocation({ provider: 'probe', model: 'claude-test' }))
            .catch((e: unknown) => e);
          expect(err).toBeInstanceOf(DispatchError);
          expect(errorClassOf(err)).toBe('config');
          expect((err as Error).message).toContain('strictTokenBudget');
          expect((err as Error).message).toContain(lane);
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      });
    }
  }

  test('a non-strict budget on an unsupported lane is NOT refused by the guard', async () => {
    const { root, sessionsDir } = await scratch();
    try {
      const factory = createDriverFactory({
        sessionsDir,
        bindings: { fixer: { probe: 'subprocess' } },
      });
      const resolved = factory.resolve({
        role: 'fixer',
        modelSpec: { provider: 'probe', model: 'claude-test' },
      });
      const err = await resolved.driver
        .run(invocation({ provider: 'probe', model: 'claude-test' }, { maxUsd: 2 }))
        .catch((e: unknown) => e);
      // Not the strict-budget refusal (the lane's own unknown-provider route
      // check is a different config failure, allowed to fire).
      expect(String((err as Error).message)).not.toContain(
        'does not enforce a pre-request token ceiling',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Supported lane (ai-sdk) unchanged
// ---------------------------------------------------------------------------

function textResult(): LanguageModelV4GenerateResult {
  return {
    content: [{ type: 'text', text: 'ok' }],
    finishReason: { unified: 'stop', raw: undefined },
    usage: {
      inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 2, text: 2, reasoning: 0 },
    },
    warnings: [],
  };
}

const FAKE_CAPABILITY = {
  provenance: 'test:guard',
  count: (serialized: string) => Buffer.byteLength(serialized, 'utf8'),
  withOutputCeiling: (
    params: LanguageModelV4CallOptions,
    reserveOutputTokens: number,
  ): LanguageModelV4CallOptions => ({ ...params, maxOutputTokens: reserveOutputTokens }),
};

describe('ai-sdk lane is unchanged by the guard', () => {
  test('ai-sdk lane with an injected capability keeps enforcing the strict budget', async () => {
    const { root, sessionsDir } = await scratch();
    try {
      const driver = new AiSdkDriver({
        sessionsDir,
        providers: {
          anthropic: () =>
            new MockLanguageModelV4({ modelId: 'claude-test', doGenerate: textResult() }),
        },
        strictTokenCapability: () => FAKE_CAPABILITY,
      });
      const result = await driver.run(invocation({ provider: 'anthropic', model: 'claude-test' }));
      expect(result.stopReason).toBe('complete');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('default factory (ai-sdk) without a capability still refuses with the ai-sdk message', async () => {
    const { root, sessionsDir } = await scratch();
    try {
      const factory = createDriverFactory({
        sessionsDir,
        lanes: {
          aiSdk: {
            providers: {
              anthropic: () =>
                new MockLanguageModelV4({ modelId: 'claude-test', doGenerate: textResult() }),
            },
          },
        },
      });
      const resolved = factory.resolve({
        role: 'fixer',
        modelSpec: { provider: 'anthropic', model: 'claude-test' },
      });
      expect(resolved.lane).toBe('ai-sdk');
      const err = await resolved.driver
        .run(invocation({ provider: 'anthropic', model: 'claude-test' }))
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DispatchError);
      expect(errorClassOf(err)).toBe('config');
      expect((err as Error).message).toContain('no trusted token capability');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Cancellation outranks the strict-budget gate (V1Gj)
// ---------------------------------------------------------------------------

describe('a pre-aborted signal settles aborted before the strict-budget gate', () => {
  const ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

  function preAborted(): AbortController {
    const controller = new AbortController();
    controller.abort();
    return controller;
  }

  test('direct subprocess: aborted, seam untouched, no session store', async () => {
    const { root, sessionsDir } = await scratch();
    try {
      const spy = seamSpy();
      const driver = new SubprocessDriver({ spawn: spy.fn, sessionsDir });
      const result = await driver.run(invocation({ provider: 'anthropic', model: 'claude-test' }), {
        signal: preAborted().signal,
      });
      expect(result.stopReason).toBe('aborted');
      expect(result.usage).toEqual(ZERO);
      expect(spy.calls).toBe(0);
      expect(existsSync(sessionsDir)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('direct claude-agent: aborted before endpoint/key/loadSdk, no session store', async () => {
    const { root, sessionsDir } = await scratch();
    try {
      const spy = seamSpy();
      const driver = new ClaudeAgentDriver({ sdkLoader: spy.fn, sessionsDir });
      const result = await driver.run(invocation({ provider: 'anthropic', model: 'claude-test' }), {
        signal: preAborted().signal,
      });
      expect(result.stopReason).toBe('aborted');
      expect(result.usage).toEqual(ZERO);
      expect(spy.calls).toBe(0);
      expect(existsSync(sessionsDir)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('direct acp: aborted before resolveAcpCommand, spawn untouched, no session store', async () => {
    const { root, sessionsDir } = await scratch();
    try {
      const spy = seamSpy();
      const driver = new AcpDriver({ spawn: spy.fn, sessionsDir });
      const result = await driver.run(invocation({ provider: 'anthropic', model: 'claude-test' }), {
        signal: preAborted().signal,
      });
      expect(result.stopReason).toBe('aborted');
      expect(result.usage).toEqual(ZERO);
      expect(spy.calls).toBe(0);
      expect(existsSync(sessionsDir)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('direct ai-sdk with a strict budget but NO capability: aborted, not a config throw', async () => {
    const { root, sessionsDir } = await scratch();
    try {
      const driver = new AiSdkDriver({
        sessionsDir,
        providers: {
          anthropic: () =>
            new MockLanguageModelV4({ modelId: 'claude-test', doGenerate: textResult() }),
        },
        // deliberately NO strictTokenCapability: a strict budget alone would
        // throw config, but the pre-aborted signal must win first.
      });
      const result = await driver.run(invocation({ provider: 'anthropic', model: 'claude-test' }), {
        signal: preAborted().signal,
      });
      expect(result.stopReason).toBe('aborted');
      expect(result.usage).toEqual(ZERO);
      expect(existsSync(sessionsDir)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('direct claude-agent: an abort DURING the async loadSdk still settles aborted (late recheck), no dispatch', async () => {
    const { root, sessionsDir } = await scratch();
    // The late recheck sits AFTER the awaited lane setup: reach loadSdk (a
    // non-strict budget, so the entry guard is a no-op), abort while it is
    // pending, then let it resolve to a valid module shape. The run must
    // settle aborted with zero usage and no session instead of dispatching.
    vi.stubEnv('ANTHROPIC_API_KEY', 'offline-fake-key');
    try {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const driver = new ClaudeAgentDriver({
        sdkLoader: async () => {
          await gate;
          return {
            query: () => {},
            tool: () => {},
            createSdkMcpServer: () => {},
          } as never;
        },
        sessionsDir,
      });
      const controller = new AbortController();
      const pending = driver.run(invocation({ provider: 'anthropic', model: 'claude-test' }, {}), {
        signal: controller.signal,
      });
      // The run has synchronously reached the pending `await loadSdk()`.
      await Promise.resolve();
      controller.abort();
      release();
      const result = await pending;
      expect(result.stopReason).toBe('aborted');
      expect(result.usage).toEqual(ZERO);
      expect(existsSync(sessionsDir)).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('factory guard on subprocess: aborted before the strict assert, no inner dispatch', async () => {
    const { root, sessionsDir } = await scratch();
    try {
      const factory = createDriverFactory({
        sessionsDir,
        bindings: { fixer: { probe: 'subprocess' } },
      });
      const resolved = factory.resolve({
        role: 'fixer',
        modelSpec: { provider: 'probe', model: 'claude-test' },
      });
      const result = await resolved.driver.run(
        invocation({ provider: 'probe', model: 'claude-test' }),
        { signal: preAborted().signal },
      );
      expect(result.stopReason).toBe('aborted');
      expect(result.usage).toEqual(ZERO);
      expect(result.sessionId).toBeUndefined();
      expect(existsSync(sessionsDir)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('factory guard on ai-sdk: aborted before the strict assert, not a config throw', async () => {
    const { root, sessionsDir } = await scratch();
    try {
      const factory = createDriverFactory({
        sessionsDir,
        lanes: {
          aiSdk: {
            providers: {
              anthropic: () =>
                new MockLanguageModelV4({ modelId: 'claude-test', doGenerate: textResult() }),
            },
          },
        },
      });
      const resolved = factory.resolve({
        role: 'fixer',
        modelSpec: { provider: 'anthropic', model: 'claude-test' },
      });
      expect(resolved.lane).toBe('ai-sdk');
      const result = await resolved.driver.run(
        invocation({ provider: 'anthropic', model: 'claude-test' }),
        { signal: preAborted().signal },
      );
      expect(result.stopReason).toBe('aborted');
      expect(result.usage).toEqual(ZERO);
      expect(existsSync(sessionsDir)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 6. ONE systematic entry-guard SUITE (owner 15:30): a 3-lane table for the
//    UNSUPPORTED lanes (subprocess / claude-agent / acp) x (direct + factory)
//    x (strict-capability refusal + pre-abort), PLUS explicit ai-sdk cases
//    (injected mock provider factory: direct + factory; the DEFAULT registry:
//    an honest key-guard pair) — not ai-sdk table rows. Every strict/pre-abort
//    leg uses a REAL recording setup seam or inner-lane prototype.run spy
//    proving ZERO setup side effect, asserts the SPECIFIC guard/capability
//    message, and pins no session store. Nonstrict controls pin each lane's own
//    setup fault/reach. Every leg pins ANTHROPIC_API_KEY to the empty string,
//    so a reached credential/env setup would surface its own key error rather
//    than the refusal phrase.
// ---------------------------------------------------------------------------

describe('entry guards precede every lane setup side effect (systematic suite)', () => {
  const ZERO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const STRICT_BUDGET: OpInvocation['budget'] = {
    strictTokenBudget: { maxInputTokens: 1000, reserveOutputTokens: 64 },
  };
  const GUARD_PHRASE = 'does not enforce a pre-request token ceiling';
  const CAPABILITY_PHRASE = 'no trusted token capability';

  /** A spy handle: only the call count is read (real spy, never vacuous). */
  type RunSpy = { mock: { calls: ReadonlyArray<unknown> } };

  interface SweepRow {
    readonly name: string;
    /** The distinctive refusal text this row MUST produce. */
    readonly refusalPhrase: string;
    /** A lane id the refusal text must also name. */
    readonly refusalLane: string;
    /** Direct driver whose setup seam RECORDS into `reached` then throws. */
    readonly direct: (reached: () => void, sessionsDir: string) => Driver;
    readonly directModelSpec: ModelSpec;
    readonly factoryModelSpec: ModelSpec;
    /** Role 'fixer' / provider 'probe' binding for THIS lane. */
    readonly bindings: NonNullable<DriverFactoryConfig['bindings']>;
    /**
     * Install a real spy on the inner lane's prototype.run. The factory's
     * outermost guard must invoke the lane ZERO times on refusal/pre-abort, so
     * a zero count here is a REAL setup-side-effect proof.
     */
    readonly spyInnerRun: () => RunSpy;
    /** The setup fault a NON-strict run of this lane must still hit. */
    readonly nonstrictMessage: string;
  }

  const rows: readonly SweepRow[] = [
    {
      name: 'subprocess',
      refusalPhrase: GUARD_PHRASE,
      refusalLane: 'subprocess',
      direct: (reached, sessionsDir) =>
        new SubprocessDriver({
          spawn: () => {
            reached();
            throw new Error('subprocess-setup-reached');
          },
          sessionsDir,
        }),
      directModelSpec: { provider: 'anthropic', model: 'claude-test' },
      factoryModelSpec: { provider: 'probe', model: 'claude-test' },
      bindings: { fixer: { probe: 'subprocess' } },
      spyInnerRun: () => vi.spyOn(SubprocessDriver.prototype, 'run'),
      nonstrictMessage: 'ANTHROPIC_API_KEY',
    },
    {
      name: 'claude-agent',
      refusalPhrase: GUARD_PHRASE,
      refusalLane: 'claude-agent',
      direct: (reached, sessionsDir) =>
        new ClaudeAgentDriver({
          sdkLoader: () => {
            reached();
            throw new Error('claude-agent-setup-reached');
          },
          sessionsDir,
        }),
      directModelSpec: { provider: 'anthropic', model: 'claude-test' },
      factoryModelSpec: { provider: 'probe', model: 'claude-test' },
      bindings: { fixer: { probe: 'claude-agent' } },
      spyInnerRun: () => vi.spyOn(ClaudeAgentDriver.prototype, 'run'),
      nonstrictMessage: 'ANTHROPIC_API_KEY',
    },
    {
      name: 'acp',
      refusalPhrase: GUARD_PHRASE,
      refusalLane: 'acp',
      direct: (reached, sessionsDir) =>
        new AcpDriver({
          spawn: () => {
            reached();
            throw new Error('acp-setup-reached');
          },
          // A definitely-missing explicit binary, so a NON-strict run hits the
          // deterministic missing-binary config instead of probing/PATH/spawn.
          command: ['/nonexistent/cq-acp-sweep-probe'],
          sessionsDir,
        }),
      directModelSpec: { provider: 'anthropic', model: 'claude-test' },
      factoryModelSpec: { provider: 'probe', model: 'claude-test' },
      bindings: { fixer: { probe: 'acp' } },
      spyInnerRun: () => vi.spyOn(AcpDriver.prototype, 'run'),
      nonstrictMessage: 'acp driver',
    },
  ];

  function setupCounter(): { bump: () => void; calls: () => number } {
    let n = 0;
    return {
      bump: () => {
        n += 1;
      },
      calls: () => n,
    };
  }

  function preAbortedSignal(): AbortSignal {
    const controller = new AbortController();
    controller.abort();
    return controller.signal;
  }

  for (const row of rows) {
    test(`${row.name} / direct: strict refusal precedes all setup (zero setup calls, no session)`, async () => {
      const { root, sessionsDir } = await scratch();
      const counter = setupCounter();
      vi.stubEnv('ANTHROPIC_API_KEY', '');
      try {
        const driver = row.direct(counter.bump, sessionsDir);
        const err = await driver
          .run(invocation(row.directModelSpec, STRICT_BUDGET))
          .catch((e: unknown) => e);
        expect(err).toBeInstanceOf(DispatchError);
        expect(errorClassOf(err)).toBe('config');
        expect((err as Error).message).toContain(row.refusalPhrase);
        expect((err as Error).message).toContain(row.refusalLane);
        expect(counter.calls()).toBe(0);
        expect(existsSync(sessionsDir)).toBe(false);
      } finally {
        vi.unstubAllEnvs();
        await rm(root, { recursive: true, force: true });
      }
    });

    test(`${row.name} / direct: pre-abort precedes all setup (zero setup calls, no session)`, async () => {
      const { root, sessionsDir } = await scratch();
      const counter = setupCounter();
      try {
        const driver = row.direct(counter.bump, sessionsDir);
        const result = await driver.run(invocation(row.directModelSpec, STRICT_BUDGET), {
          signal: preAbortedSignal(),
        });
        expect(result.stopReason).toBe('aborted');
        expect(result.usage).toEqual(ZERO_USAGE);
        expect(counter.calls()).toBe(0);
        expect(existsSync(sessionsDir)).toBe(false);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    test(`${row.name} / factory: strict refusal never invokes the lane (spy zero, no session)`, async () => {
      const { root, sessionsDir } = await scratch();
      const innerRun = row.spyInnerRun();
      vi.stubEnv('ANTHROPIC_API_KEY', '');
      try {
        const factory = createDriverFactory({ sessionsDir, bindings: row.bindings });
        const resolved = factory.resolve({ role: 'fixer', modelSpec: row.factoryModelSpec });
        expect(resolved.lane).toBe(row.refusalLane);
        const err = await resolved.driver
          .run(invocation(row.factoryModelSpec, STRICT_BUDGET))
          .catch((e: unknown) => e);
        expect(err).toBeInstanceOf(DispatchError);
        expect(errorClassOf(err)).toBe('config');
        expect((err as Error).message).toContain(row.refusalPhrase);
        expect((err as Error).message).toContain(row.refusalLane);
        expect(innerRun.mock.calls.length).toBe(0);
        expect(existsSync(sessionsDir)).toBe(false);
      } finally {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
        await rm(root, { recursive: true, force: true });
      }
    });

    test(`${row.name} / factory: pre-abort never invokes the lane (spy zero, no session)`, async () => {
      const { root, sessionsDir } = await scratch();
      const innerRun = row.spyInnerRun();
      try {
        const factory = createDriverFactory({ sessionsDir, bindings: row.bindings });
        const resolved = factory.resolve({ role: 'fixer', modelSpec: row.factoryModelSpec });
        const result = await resolved.driver.run(invocation(row.factoryModelSpec, STRICT_BUDGET), {
          signal: preAbortedSignal(),
        });
        expect(result.stopReason).toBe('aborted');
        expect(result.usage).toEqual(ZERO_USAGE);
        expect(innerRun.mock.calls.length).toBe(0);
        expect(existsSync(sessionsDir)).toBe(false);
      } finally {
        vi.restoreAllMocks();
        await rm(root, { recursive: true, force: true });
      }
    });

    test(`${row.name} / direct: a nonstrict budget hits the lane's OWN setup fault, not the strict refusal`, async () => {
      const { root, sessionsDir } = await scratch();
      const counter = setupCounter();
      vi.stubEnv('ANTHROPIC_API_KEY', '');
      try {
        const driver = row.direct(counter.bump, sessionsDir);
        const err = await driver
          .run(invocation(row.directModelSpec, { maxUsd: 1 }))
          .catch((e: unknown) => e);
        // The lane's own pre-dispatch fault (missing key / missing binary) is
        // pinned, and the seam is NOT reached; the strict refusal did not fire.
        expect((err as Error).message).toContain(row.nonstrictMessage);
        expect((err as Error).message).not.toContain(row.refusalPhrase);
        expect(counter.calls()).toBe(0);
      } finally {
        vi.unstubAllEnvs();
        await rm(root, { recursive: true, force: true });
      }
    });
  }

  // -------------------------------------------------------------------------
  // ai-sdk, direct + factory, with a REAL injected provider-factory spy (both
  // `AiSdkDriverOptions.providers` and `DriverFactoryConfig.lanes.aiSdk
  // .providers`). A zero count proves the capability refusal/pre-abort fired
  // BEFORE any provider-model resolution.
  // -------------------------------------------------------------------------

  function aiSdkMockDriver(reached: () => void, sessionsDir: string): AiSdkDriver {
    return new AiSdkDriver({
      providers: {
        anthropic: () => {
          reached();
          throw new Error('ai-sdk-provider-factory-reached');
        },
      },
      sessionsDir,
    });
  }

  const AI_SDK_SPEC: ModelSpec = { provider: 'anthropic', model: 'claude-test' };

  test('ai-sdk (mock providers) / direct: capability refusal precedes the provider factory (zero factory calls)', async () => {
    const { root, sessionsDir } = await scratch();
    const counter = setupCounter();
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    try {
      const err = await aiSdkMockDriver(counter.bump, sessionsDir)
        .run(invocation(AI_SDK_SPEC, STRICT_BUDGET))
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DispatchError);
      expect(errorClassOf(err)).toBe('config');
      expect((err as Error).message).toContain(CAPABILITY_PHRASE);
      expect(counter.calls()).toBe(0);
      expect(existsSync(sessionsDir)).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('ai-sdk (mock providers) / direct: pre-abort precedes the provider factory (zero factory calls)', async () => {
    const { root, sessionsDir } = await scratch();
    const counter = setupCounter();
    try {
      const result = await aiSdkMockDriver(counter.bump, sessionsDir).run(
        invocation(AI_SDK_SPEC, STRICT_BUDGET),
        { signal: preAbortedSignal() },
      );
      expect(result.stopReason).toBe('aborted');
      expect(result.usage).toEqual(ZERO_USAGE);
      expect(counter.calls()).toBe(0);
      expect(existsSync(sessionsDir)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  function aiSdkMockFactory(counter: { bump: () => void }, sessionsDir: string) {
    const factory = createDriverFactory({
      sessionsDir,
      lanes: {
        aiSdk: {
          providers: {
            anthropic: () => {
              counter.bump();
              throw new Error('ai-sdk-factory-setup-reached');
            },
          },
        },
      },
    });
    return factory.resolve({ role: 'fixer', modelSpec: AI_SDK_SPEC }).driver;
  }

  test('ai-sdk (mock providers) / factory: capability refusal precedes the injected factory (zero factory calls)', async () => {
    const { root, sessionsDir } = await scratch();
    const counter = setupCounter();
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    try {
      const err = await aiSdkMockFactory(counter, sessionsDir)
        .run(invocation(AI_SDK_SPEC, STRICT_BUDGET))
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DispatchError);
      expect(errorClassOf(err)).toBe('config');
      expect((err as Error).message).toContain(CAPABILITY_PHRASE);
      expect(counter.calls()).toBe(0);
      expect(existsSync(sessionsDir)).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('ai-sdk (mock providers) / factory: pre-abort precedes the injected factory (zero factory calls)', async () => {
    const { root, sessionsDir } = await scratch();
    const counter = setupCounter();
    try {
      const result = await aiSdkMockFactory(counter, sessionsDir).run(
        invocation(AI_SDK_SPEC, STRICT_BUDGET),
        { signal: preAbortedSignal() },
      );
      expect(result.stopReason).toBe('aborted');
      expect(result.usage).toEqual(ZERO_USAGE);
      expect(counter.calls()).toBe(0);
      expect(existsSync(sessionsDir)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('ai-sdk (mock providers) / direct: a nonstrict budget REACHES the provider factory (reach proof)', async () => {
    const { root, sessionsDir } = await scratch();
    const counter = setupCounter();
    try {
      const err = await aiSdkMockDriver(counter.bump, sessionsDir)
        .run(invocation(AI_SDK_SPEC, { maxUsd: 1 }))
        .catch((e: unknown) => e);
      expect(counter.calls()).toBe(1);
      expect((err as Error).message).toContain('ai-sdk-provider-factory-reached');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // ai-sdk DEFAULT provider registry: an honest KEY-GUARD pair. The default
  // registry has no injectable factory (no production seam is added for tests),
  // so the honest claim is: with ANTHROPIC_API_KEY pinned EMPTY, the capability
  // refusal fires INSTEAD OF the registry's own missing-key error — proving the
  // registry was never read.
  // -------------------------------------------------------------------------

  test('ai-sdk (default registry) / direct: capability refusal, NOT the registry missing-key error', async () => {
    const { root, sessionsDir } = await scratch();
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    try {
      const err = await new AiSdkDriver({ sessionsDir })
        .run(invocation(AI_SDK_SPEC, STRICT_BUDGET))
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DispatchError);
      expect(errorClassOf(err)).toBe('config');
      expect((err as Error).message).toContain(CAPABILITY_PHRASE);
      expect((err as Error).message).not.toContain('ANTHROPIC_API_KEY');
      expect(existsSync(sessionsDir)).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('ai-sdk (default registry) / factory: capability refusal, NOT the registry missing-key error', async () => {
    const { root, sessionsDir } = await scratch();
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    try {
      const factory = createDriverFactory({ sessionsDir });
      const resolved = factory.resolve({ role: 'fixer', modelSpec: AI_SDK_SPEC });
      expect(resolved.lane).toBe('ai-sdk');
      const err = await resolved.driver
        .run(invocation(AI_SDK_SPEC, STRICT_BUDGET))
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DispatchError);
      expect(errorClassOf(err)).toBe('config');
      expect((err as Error).message).toContain(CAPABILITY_PHRASE);
      expect((err as Error).message).not.toContain('ANTHROPIC_API_KEY');
      expect(existsSync(sessionsDir)).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  });
});
