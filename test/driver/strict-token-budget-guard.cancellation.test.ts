// Split provenance: test/driver/strict-token-budget-guard.test.ts was split by subject;
// this file keeps the cancellation precedence rule (V1Gj): a pre-aborted signal
// settles aborted before the strict-budget gate and before any lane setup.
// Shared fixtures live in ./strict-token-budget-guard.helpers.ts.
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { describe, expect, test, vi } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import { AcpDriver } from '../../src/driver/acp/index.js';
import { AiSdkDriver } from '../../src/driver/ai-sdk/index.js';
import { ClaudeCodeDriver } from '../../src/driver/claude-code/index.js';
import { createDriverFactory } from '../../src/driver/factory.js';
import { invocation, scratch, seamSpy, textResult } from './strict-token-budget-guard.helpers.js';

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
      const driver = new ClaudeCodeDriver({ spawn: spy.fn, sessionsDir });
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
      const driver = new ClaudeCodeDriver({ transport: 'sdk', sdkLoader: spy.fn, sessionsDir });
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
      const driver = new ClaudeCodeDriver({
        transport: 'sdk',
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
        bindings: { fixer: { probe: 'claude-code' } },
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
