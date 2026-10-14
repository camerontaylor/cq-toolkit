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
import { describe, expect, test } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import type { LanguageModelV4CallOptions, LanguageModelV4GenerateResult } from '@ai-sdk/provider';
import { assertStrictTokenBudgetSupported } from '../../src/driver/common/strict-budget.js';
import { DispatchError, errorClassOf } from '../../src/driver/errors.js';
import { AcpDriver } from '../../src/driver/acp/index.js';
import { AiSdkDriver } from '../../src/driver/ai-sdk/index.js';
import { ClaudeAgentDriver } from '../../src/driver/claude-agent/index.js';
import { createDriverFactory } from '../../src/driver/factory.js';
import { SubprocessDriver } from '../../src/driver/subprocess/index.js';
import type { ModelSpec, OpInvocation } from '../../src/driver/types.js';

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
