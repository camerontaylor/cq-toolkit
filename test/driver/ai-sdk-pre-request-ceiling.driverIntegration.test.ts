// Split provenance: test/driver/ai-sdk-pre-request-ceiling.test.ts was split
// into ai-sdk-pre-request-ceiling.helpers.ts (shared fixtures) and seven
// subject files; this file carries the driver-integration subject (§4).
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import { AiSdkDriver } from '../../src/driver/ai-sdk/index.js';
import { toOutputSchema } from '../../src/driver/common/structured.js';
import { createDriverFactory } from '../../src/driver/factory.js';
import { DispatchError, errorClassOf } from '../../src/driver/errors.js';
import type { WireReservation } from '../../src/driver/ai-sdk/pre-request-ceiling.js';
import { fakeCapability, invocation, textResult } from './ai-sdk-pre-request-ceiling.helpers.js';

// ---------------------------------------------------------------------------
// 4. Driver integration — injected capability, no built-in
// ---------------------------------------------------------------------------

describe('ai-sdk driver strictTokenBudget', () => {
  test('refuses pre-dispatch when no capability is injected — no session is created', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'aidrv-strict-none-'));
    try {
      const driver = new AiSdkDriver({
        providers: {
          mock: () => new MockLanguageModelV4({ modelId: 'mock-1', doGenerate: textResult('ok') }),
        },
        sessionsDir: join(scratch, 'sessions'),
      });
      let caught: unknown;
      try {
        await driver.run(
          invocation({
            modelSpec: { provider: 'mock', model: 'mock-1' },
            budget: { strictTokenBudget: { maxInputTokens: 1000, reserveOutputTokens: 64 } },
          }),
        );
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(DispatchError);
      expect(errorClassOf(caught)).toBe('config');
      expect((caught as Error).message).toContain('no trusted token capability');
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test('applies the output wire ceiling and completes when the request fits', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'aidrv-strict-apply-'));
    try {
      let seenMaxOutputTokens: number | undefined;
      const driver = new AiSdkDriver({
        providers: {
          anthropic: () =>
            new MockLanguageModelV4({
              modelId: 'claude-test',
              doGenerate: async (options) => {
                seenMaxOutputTokens = options.maxOutputTokens;
                return textResult('ok');
              },
            }),
        },
        sessionsDir: join(scratch, 'sessions'),
        strictTokenCapability: () => fakeCapability(),
      });
      const result = await driver.run(
        invocation({
          budget: { strictTokenBudget: { maxInputTokens: 1_000_000, reserveOutputTokens: 64 } },
        }),
      );
      expect(result.stopReason).toBe('complete');
      expect(seenMaxOutputTokens).toBe(64);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test('a request over the input ceiling settles stopReason budget and never calls the model', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'aidrv-strict-cap-'));
    try {
      let calls = 0;
      const driver = new AiSdkDriver({
        providers: {
          anthropic: () =>
            new MockLanguageModelV4({
              modelId: 'claude-test',
              doGenerate: async () => {
                calls += 1;
                return textResult('ok');
              },
            }),
        },
        sessionsDir: join(scratch, 'sessions'),
        strictTokenCapability: () => fakeCapability(),
      });
      const result = await driver.run(
        invocation({
          budget: { strictTokenBudget: { maxInputTokens: 8, reserveOutputTokens: 64 } },
        }),
      );
      expect(result.stopReason).toBe('budget');
      expect(calls).toBe(0);
      expect(result.usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test('a request that exceeds the shared whole-job reservation settles budget', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'aidrv-strict-shared-'));
    try {
      const driver = new AiSdkDriver({
        providers: {
          anthropic: () =>
            new MockLanguageModelV4({ modelId: 'claude-test', doGenerate: textResult('ok') }),
        },
        sessionsDir: join(scratch, 'sessions'),
        strictTokenCapability: () => fakeCapability(),
      });
      const result = await driver.run(
        invocation({
          budget: { strictTokenBudget: { maxInputTokens: 1_000_000, reserveOutputTokens: 64 } },
        }),
        { reservation: { id: 'r1', tokens: 1, overshootUsd: 0, class: 'hard' } },
      );
      expect(result.stopReason).toBe('budget');
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test('soft maxTokens is unchanged when strictTokenBudget is absent (no redefinition)', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'aidrv-soft-'));
    try {
      let calls = 0;
      const driver = new AiSdkDriver({
        providers: {
          anthropic: () =>
            new MockLanguageModelV4({
              modelId: 'claude-test',
              doGenerate: async () => {
                calls += 1;
                return textResult('ok');
              },
            }),
        },
        sessionsDir: join(scratch, 'sessions'),
      });
      // A soft cap with no strict budget still dispatches and lets the
      // completed-step fold classify the run — the old semantics.
      const result = await driver.run(invocation({ budget: { maxTokens: 1 } }));
      expect(calls).toBe(1);
      expect(result.stopReason).toBe('budget');
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test('the driver passes model identity and a request digest to the durable hook', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'aidrv-strict-hook-'));
    try {
      let seen: WireReservation | undefined;
      const driver = new AiSdkDriver({
        providers: {
          anthropic: () =>
            new MockLanguageModelV4({ modelId: 'claude-test', doGenerate: textResult('ok') }),
        },
        sessionsDir: join(scratch, 'sessions'),
        strictTokenCapability: () => fakeCapability(),
        strictTokenReservationHook: (receipt) => {
          seen = receipt;
        },
      });
      const result = await driver.run(
        invocation({
          budget: { strictTokenBudget: { maxInputTokens: 1_000_000, reserveOutputTokens: 64 } },
        }),
      );
      expect(result.stopReason).toBe('complete');
      expect(seen?.provider).toBe('anthropic');
      expect(seen?.model).toBe('claude-test');
      expect(seen?.reserveOutputTokens).toBe(64);
      expect(seen?.countableProjectionDigest).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test('the factory lane config plumbs the capability and durable hook to the driver', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'aidrv-strict-factory-'));
    try {
      let seen: WireReservation | undefined;
      const factory = createDriverFactory({
        sessionsDir: join(scratch, 'sessions'),
        lanes: {
          aiSdk: {
            providers: {
              anthropic: () =>
                new MockLanguageModelV4({ modelId: 'claude-test', doGenerate: textResult('ok') }),
            },
            strictTokenCapability: () => fakeCapability(),
            strictTokenReservationHook: (receipt) => {
              seen = receipt;
            },
          },
        },
      });
      const { driver } = factory.resolve({
        role: 'fixer',
        modelSpec: { provider: 'anthropic', model: 'claude-test' },
      });
      const result = await driver.run(
        invocation({
          budget: { strictTokenBudget: { maxInputTokens: 1_000_000, reserveOutputTokens: 64 } },
        }),
      );
      expect(result.stopReason).toBe('complete');
      expect(seen?.countableProjectionDigest).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test('a governed abort during a hung durable reservation hook settles aborted, not budget', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'aidrv-strict-hung-hook-'));
    try {
      const driver = new AiSdkDriver({
        providers: {
          anthropic: () =>
            new MockLanguageModelV4({ modelId: 'claude-test', doGenerate: textResult('ok') }),
        },
        sessionsDir: join(scratch, 'sessions'),
        strictTokenCapability: () => fakeCapability(),
        // A hook that NEVER settles: without abort-awareness the run hangs here.
        strictTokenReservationHook: () => new Promise<void>(() => {}),
      });
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 20);
      const result = await driver.run(
        invocation({
          budget: { strictTokenBudget: { maxInputTokens: 1_000_000, reserveOutputTokens: 64 } },
        }),
        { signal: controller.signal },
      );
      expect(result.stopReason).toBe('aborted');
      expect(result.error).toBeUndefined();
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test('a mid-run governed abort with a NON-abort Error reason settles aborted, not error', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'aidrv-strict-abort-reason-'));
    try {
      const driver = new AiSdkDriver({
        providers: {
          anthropic: () =>
            new MockLanguageModelV4({ modelId: 'claude-test', doGenerate: textResult('ok') }),
        },
        sessionsDir: join(scratch, 'sessions'),
        strictTokenCapability: () => fakeCapability(),
        strictTokenReservationHook: () => new Promise<void>(() => {}),
      });
      const controller = new AbortController();
      // A generic Error reason (not an AbortError): the ceiling must still
      // normalize the cancellation and the run must settle 'aborted'.
      setTimeout(() => controller.abort(new Error('governor stopped the run')), 20);
      const result = await driver.run(
        invocation({
          budget: { strictTokenBudget: { maxInputTokens: 1_000_000, reserveOutputTokens: 64 } },
        }),
        { signal: controller.signal },
      );
      expect(result.stopReason).toBe('aborted');
      expect(result.error).toBeUndefined();
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test('a capability that cannot count the request settles a diagnostic error, not budget', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'aidrv-strict-infra-count-'));
    try {
      const driver = new AiSdkDriver({
        providers: {
          anthropic: () =>
            new MockLanguageModelV4({ modelId: 'claude-test', doGenerate: textResult('ok') }),
        },
        sessionsDir: join(scratch, 'sessions'),
        resolveRg: async () => ({ ok: false, reason: 'absent' }),
        strictTokenCapability: () =>
          fakeCapability({
            count: () => {
              throw new Error('unbounded multimodal input');
            },
          }),
      });
      const result = await driver.run(
        invocation({
          toolPolicy: { allow: ['grep'], mode: 'allowlist' },
          sandboxPolicy: { level: 'read-only' },
          budget: { strictTokenBudget: { maxInputTokens: 1_000_000, reserveOutputTokens: 64 } },
        }),
      );
      expect(result.stopReason).toBe('error');
      expect(result.errorClass).toBeDefined();
      expect(result.error).toContain('infrastructure');
      expect(result.capabilities?.rg).toMatchObject({ available: false, probe: 'absent' });
      expect(result.advisories).toContain('search tools unavailable: ripgrep not found');
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test('a durable hook failure settles a diagnostic error, not budget', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'aidrv-strict-infra-hook-'));
    try {
      const driver = new AiSdkDriver({
        providers: {
          anthropic: () =>
            new MockLanguageModelV4({ modelId: 'claude-test', doGenerate: textResult('ok') }),
        },
        sessionsDir: join(scratch, 'sessions'),
        strictTokenCapability: () => fakeCapability(),
        strictTokenReservationHook: () => {
          throw new Error('ledger unavailable');
        },
      });
      const result = await driver.run(
        invocation({
          budget: { strictTokenBudget: { maxInputTokens: 1_000_000, reserveOutputTokens: 64 } },
        }),
      );
      expect(result.stopReason).toBe('error');
      expect(result.errorClass).toBeDefined();
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test('an infrastructure refusal on the REPAIR request settles error, not budget', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'aidrv-strict-repair-infra-'));
    try {
      let countCalls = 0;
      const driver = new AiSdkDriver({
        providers: {
          anthropic: () =>
            // Both the main call and the repair reply with non-JSON text, so the
            // main call settles a structured miss and the repair is attempted.
            new MockLanguageModelV4({ modelId: 'claude-test', doGenerate: textResult('not json') }),
        },
        sessionsDir: join(scratch, 'sessions'),
        strictTokenCapability: () =>
          fakeCapability({
            count: (serialized) => {
              countCalls += 1;
              if (countCalls === 1) return Buffer.byteLength(serialized, 'utf8');
              throw new Error('repair count unavailable');
            },
          }),
      });
      const result = await driver.run(
        invocation({
          outputSchema: toOutputSchema(
            'conformance/repair-infra/v1',
            z.object({ answer: z.string() }).strict(),
          ),
          budget: { strictTokenBudget: { maxInputTokens: 1_000_000, reserveOutputTokens: 64 } },
        }),
      );
      expect(countCalls).toBeGreaterThanOrEqual(2);
      expect(result.stopReason).toBe('error');
      expect(result.errorClass).toBeDefined();
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test('a provider factory that SYNCHRONOUSLY aborts mid-setup settles aborted (late recheck), no dispatch', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'aidrv-strict-midsetup-abort-'));
    try {
      const controller = new AbortController();
      let factoryCalls = 0;
      let generateCalls = 0;
      const driver = new AiSdkDriver({
        providers: {
          anthropic: () => {
            factoryCalls += 1;
            // A SYNCHRONOUS provider-factory abort: the ENTRY check already
            // passed, so only the LATE live recheck can catch this before the
            // wire. The factory still resolves a model instance.
            controller.abort();
            return new MockLanguageModelV4({
              modelId: 'claude-test',
              doGenerate: async () => {
                generateCalls += 1;
                return textResult('ok');
              },
            });
          },
        },
        sessionsDir: join(scratch, 'sessions'),
        strictTokenCapability: () => fakeCapability(),
      });
      const result = await driver.run(
        invocation({
          budget: { strictTokenBudget: { maxInputTokens: 1_000_000, reserveOutputTokens: 64 } },
        }),
        { signal: controller.signal },
      );
      expect(factoryCalls).toBe(1);
      expect(generateCalls).toBe(0);
      expect(result.stopReason).toBe('aborted');
      expect(result.usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
      expect(result.error).toBeUndefined();
      expect(existsSync(join(scratch, 'sessions'))).toBe(false);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});
