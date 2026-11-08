// RD-B review debt (#18/#24) — usage evidence on failure, budget folds,
// config isolation, the always-on tool loop, resume dedupe, and served-id
// pricing (the former ai-sdk.test.ts review-fixes describe).
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import type { LanguageModelV4GenerateResult } from '@ai-sdk/provider';
import {
  bindGenerateTextCapture,
  invocation,
  lastGenerateTextArgs,
  mockUsage,
  modelFor,
  textResult,
  toolCallResult,
  usageModel,
} from './ai-sdk.helpers.js';
import { AiSdkDriver, DEFAULT_MAX_STEPS } from '../../src/driver/ai-sdk/index.js';
import { SessionBoundError, errorClassOf } from '../../src/driver/errors.js';
import { withReapOnSettle } from '../../src/driver/factory.js';
import { defaultHarnessConfig } from '../../src/harness/config.js';
import { SessionStore } from '../../src/harness/session.js';

// ---------------------------------------------------------------------------
// The transparent generateText spy (accessors live in ai-sdk.helpers.ts).
// Vitest hoists vi.mock per test file, so the registration is declared here,
// verbatim from the original file, and bound to the shared capture holder.
// ---------------------------------------------------------------------------

const captured = vi.hoisted(() => ({ generateTextArgs: [] as unknown[] }));

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return {
    ...actual,
    generateText: (args: Parameters<typeof actual.generateText>[0]) => {
      captured.generateTextArgs.push(args);
      return actual.generateText(args);
    },
  };
});

bindGenerateTextCapture(captured.generateTextArgs);

// ---------------------------------------------------------------------------
// RD-B review debt (#18/#24) — usage evidence on failure, budget folds,
// config isolation, the always-on tool loop, resume dedupe, served-id pricing
// ---------------------------------------------------------------------------

describe('ai-sdk driver review fixes (#18/#24)', () => {
  test('a mid-run failure keeps the COMPLETED steps usage — not zeros (#18-1)', async () => {
    // Step 1 completes (tool call); step 2's model call throws. The
    // always-on stopWhen follows the tool call up into step 2 — exactly the
    // multi-step shape whose usage the old zeroUsage return discarded.
    let calls = 0;
    const stepThenFail = new MockLanguageModelV4({
      modelId: 'mock-1',
      doGenerate: async () => {
        calls += 1;
        if (calls === 1) return toolCallResult('read', { path: 'absent-step-one.txt' });
        throw new Error('scripted step-two failure');
      },
    });
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-'));
    try {
      const driver = new AiSdkDriver({
        providers: { mock: () => stepThenFail },
        sessionsDir: join(scratchDir, 'sessions'),
      });
      const result = await driver.run(invocation({ prompt: 'fails on step two' }));
      expect(calls).toBe(2); // step 1 completed, step 2 threw
      expect(result.stopReason).toBe('error');
      expect(result.error).toContain('scripted step-two failure');
      // step 1's usage (folded through onStepFinish → usageFromSdk), NOT zeros.
      // reasoning is absent by design (merge-queue 11ea275): it is a subset of
      // outputTokens, so the frozen field stays unset on this lane.
      expect(result.usage).toEqual({ input: 100, output: 12, cacheRead: 15, cacheWrite: 5 });
      expect(result.steps).toBe(1); // the completed first step is counted before the next request fails
      // cost stays UNFABRICATED on the error path — no figure, no basis
      expect(result.costUSD).toBeUndefined();
      expect(result.costBasis).toBeUndefined();
      // the step-1 tool call really ran (its denial is the evidence)
      expect(result.denials.some((d) => d.tool === 'read')).toBe(true);
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('the token cap folds reasoning ONCE, via output: cap 35 trips, cap 40 does not (#18-2)', async () => {
    // mapped Usage {input:10, output:20, cacheRead:5, cacheWrite:0, reasoning:8}
    // → fold 35 (10+20+5+0). The old fold added reasoning ON TOP (43).
    const reasoningUsage: LanguageModelV4GenerateResult['usage'] = {
      inputTokens: { total: 15, noCache: 10, cacheRead: 5, cacheWrite: 0 },
      outputTokens: { total: 20, text: 12, reasoning: 8 },
    };
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-'));
    try {
      const driver = new AiSdkDriver({
        providers: { mock: () => usageModel(reasoningUsage) },
        sessionsDir: join(scratchDir, 'sessions'),
      });
      // AT the cap: the fold (35) >= 35 trips exactly.
      expect((await driver.run(invocation({ budget: { maxTokens: 35 } }))).stopReason).toBe(
        'budget',
      );
      // Headroom: 35 < 40 — the old 43-fold would have tripped here too.
      expect((await driver.run(invocation({ budget: { maxTokens: 40 } }))).stopReason).toBe(
        'complete',
      );
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('provider cancellation outranks an oversized prompt without creating a session', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-abort-prompt-'));
    const controller = new AbortController();
    let calls = 0;
    try {
      const driver = new AiSdkDriver({
        providers: {
          mock: () => {
            controller.abort();
            return new MockLanguageModelV4({
              modelId: 'mock-1',
              doGenerate: async () => {
                calls += 1;
                return textResult('must never run');
              },
            });
          },
        },
        sessionsDir: join(scratchDir, 'sessions'),
        harnessConfig: {
          ...defaultHarnessConfig,
          promptBudget: { ...defaultHarnessConfig.promptBudget, maxSystemPromptChars: 50 },
        },
      });
      const result = await driver.run(invocation({ prompt: 'p'.repeat(51) }), {
        signal: controller.signal,
      });
      expect(result.stopReason).toBe('aborted');
      expect(result.sessionId).toBeUndefined();
      expect(result.usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
      expect(calls).toBe(0);
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('prompt budget applies to the user turn and leaves the system preamble intact (#18-3)', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-'));
    try {
      const prompt = 'p'.repeat(50); // prompt.length === maxSystemPromptChars
      const driver = new AiSdkDriver({
        providers: { mock: () => modelFor({ kind: 'reply', text: 'ok' }) },
        sessionsDir: join(scratchDir, 'sessions'),
        harnessConfig: {
          ...defaultHarnessConfig,
          promptBudget: { ...defaultHarnessConfig.promptBudget, maxSystemPromptChars: 50 },
        },
      });
      await driver.run(invocation({ prompt, toolPolicy: { mode: 'none', allow: [] } }));
      const args = lastGenerateTextArgs();
      expect(args.system).toBe(
        'You are a cq-toolkit worker executing one task. You have no tools: everything you need is in the messages below. Answer directly.',
      );
      expect(
        args.messages?.filter((message) => message.role === 'user' && message.content === prompt),
      ).toHaveLength(1);
      // The over-budget refusal is pre-dispatch CALLER-DATA validation: it
      // carries the structured 'config' class like every other pre-dispatch
      // throw on this lane.
      const overBudget = await driver
        .run(invocation({ prompt: 'p'.repeat(51), toolPolicy: { mode: 'none', allow: [] } }))
        .catch((err: unknown) => err);
      expect(errorClassOf(overBudget)).toBe('config');
      expect((overBudget as Error).message).toContain(
        '51 chars, over the harness prompt budget of 50',
      );
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('triage-sized prompt capacity is supported without truncation and stays finite', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-triage-'));
    try {
      const driver = new AiSdkDriver({
        providers: { mock: () => modelFor({ kind: 'reply', text: 'ok' }) },
        sessionsDir: join(scratchDir, 'sessions'),
        harnessConfig: {
          ...defaultHarnessConfig,
          promptBudget: { ...defaultHarnessConfig.promptBudget, maxSystemPromptChars: 128000 },
        },
      });
      const prompt = 'current contract and source evidence '.repeat(1000);
      expect(prompt.length).toBeGreaterThan(20000);
      await driver.run(invocation({ prompt, toolPolicy: { mode: 'none', allow: [] } }));
      expect(lastGenerateTextArgs().messages).toContainEqual({ role: 'user', content: prompt });
      const calls = captured.generateTextArgs.length;
      const refused = await driver
        .run(invocation({ prompt: 'x'.repeat(128001), toolPolicy: { mode: 'none', allow: [] } }))
        .catch((err: unknown) => err);
      expect(errorClassOf(refused)).toBe('config');
      expect((refused as Error).message).toContain('over the harness prompt budget of 128000');
      expect(captured.generateTextArgs).toHaveLength(calls);
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('a throw after the record is created is bound to its session (reap-on-settle removes it)', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-session-bound-'));
    try {
      const sessionsDir = join(scratchDir, 'sessions');
      const driver = new AiSdkDriver({
        providers: { mock: () => modelFor({ kind: 'reply', text: 'never dispatched' }) },
        sessionsDir,
        // `buildTools` re-parses the harness config AFTER the fresh record
        // exists. maxTools 0 is invalid to the schema (so that parse throws
        // post-creation) and irrelevant to the driver's own prompt-length
        // check, which is what makes this a post-creation throw.
        harnessConfig: {
          ...defaultHarnessConfig,
          promptBudget: { ...defaultHarnessConfig.promptBudget, maxTools: 0 },
        },
      });
      const plainError = await driver.run(invocation()).catch((err: unknown) => err);
      expect(plainError).toBeInstanceOf(SessionBoundError);
      const plainId = (plainError as SessionBoundError).sessionId;
      // The rejection names the record that really exists on disk.
      await expect(new SessionStore(sessionsDir).load(plainId)).resolves.toBeDefined();
      expect((await readdir(sessionsDir)).filter((name) => name.endsWith('.jsonl'))).toHaveLength(
        1,
      );

      // The reap-on-settle wrapper (what CQ_SESSION_LOGS=off composes) sees
      // the same session-bound rejection and removes exactly that record.
      const reapedError = await withReapOnSettle(driver, sessionsDir)
        .run(invocation())
        .catch((err: unknown) => err);
      expect(reapedError).toBeInstanceOf(SessionBoundError);
      const reapedId = (reapedError as SessionBoundError).sessionId;
      expect(reapedId).not.toBe(plainId);
      await expect(new SessionStore(sessionsDir).load(reapedId)).resolves.toBeUndefined();
      expect((await readdir(sessionsDir)).filter((name) => name.endsWith('.jsonl'))).toHaveLength(
        1,
      );
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('defaultHarnessConfig is deeply frozen; the driver holds an isolated deep-frozen clone (#18-4)', async () => {
    // The shared default is frozen all the way down: a nested write throws
    // in strict mode instead of poisoning every later consumer.
    expect(Object.isFrozen(defaultHarnessConfig)).toBe(true);
    expect(Object.isFrozen(defaultHarnessConfig.promptBudget)).toBe(true);
    expect(Object.isFrozen(defaultHarnessConfig.tools.bash)).toBe(true);
    const chars = defaultHarnessConfig.promptBudget.maxSystemPromptChars;
    expect(() => {
      (defaultHarnessConfig.promptBudget as { maxSystemPromptChars: number }).maxSystemPromptChars =
        1;
    }).toThrow(TypeError);
    expect(defaultHarnessConfig.promptBudget.maxSystemPromptChars).toBe(chars);

    // The driver CLONED its effective config at construction: mutating the
    // CALLER's object afterwards cannot reach the run.
    const callerConfig = {
      ...defaultHarnessConfig,
      promptBudget: { ...defaultHarnessConfig.promptBudget, maxSystemPromptChars: 60 },
    };
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-'));
    try {
      const driver = new AiSdkDriver({
        providers: { mock: () => modelFor({ kind: 'reply', text: 'ok' }) },
        sessionsDir: join(scratchDir, 'sessions'),
        harnessConfig: callerConfig,
      });
      callerConfig.promptBudget.maxSystemPromptChars = 5; // post-construction mutation
      await driver.run(invocation({ prompt: 'p' }));
      const args = lastGenerateTextArgs();
      expect(args.system).toBe(
        'You are a cq-toolkit worker executing one task. Work inside the provided workspace directory; use the available tools to read, edit, and run. Tool refusals arrive as denial text — adapt instead of retrying the same call.',
      );
      expect(
        args.messages?.filter((message) => message.role === 'user' && message.content === 'p'),
      ).toHaveLength(1);
      await expect(driver.run(invocation({ prompt: 'p'.repeat(61) }))).rejects.toThrow(
        /61 chars, over the harness prompt budget of 60/,
      );
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('stopWhen is ALWAYS passed: the tool loop is bounded even without maxTokens (#18-5)', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-'));
    try {
      const driver = new AiSdkDriver({
        providers: { mock: () => modelFor({ kind: 'reply', text: 'ok' }) },
        sessionsDir: join(scratchDir, 'sessions'),
      });
      // No maxTokens: the SDK's own default is stepCountIs(1) — a single
      // step, under which tool calls are never followed up. The driver must
      // pass its own bound.
      await driver.run(invocation());
      let stopWhen = lastGenerateTextArgs().stopWhen;
      expect(Array.isArray(stopWhen)).toBe(true);
      expect(stopWhen as unknown[]).toHaveLength(1); // the step-count bound alone
      // With maxTokens: the token condition AND the step-count bound (the
      // SDK accepts an array — any condition met stops).
      await driver.run(invocation({ budget: { maxTokens: 500 } }));
      stopWhen = lastGenerateTextArgs().stopWhen;
      expect(stopWhen as unknown[]).toHaveLength(2);
      expect(DEFAULT_MAX_STEPS).toBe(40); // the documented tool-loop default
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('a failed prompt already persisted is NOT re-appended on the resumed retry (#18-6)', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-'));
    try {
      const store = new SessionStore(join(scratchDir, 'sessions'));
      // Run 1 fails mid-model-call: the record ends with the bare user
      // prompt (no assistant turn followed the failure).
      const failDriver = new AiSdkDriver({
        providers: { mock: () => modelFor({ kind: 'fail' }) },
        sessionsDir: join(scratchDir, 'sessions'),
      });
      const failed = await failDriver.run(invocation({ prompt: 'retry-me-once' }));
      expect(failed.stopReason).toBe('error');
      const failedArgs = lastGenerateTextArgs();
      expect(failedArgs.system).not.toContain('retry-me-once');
      expect(
        failedArgs.messages?.filter(
          (message) => message.role === 'user' && message.content === 'retry-me-once',
        ),
      ).toHaveLength(1);
      const before = await store.load(failed.sessionId as string);
      expect(before?.messages.at(-1)).toMatchObject({ role: 'user', content: 'retry-me-once' });

      // Run 2 resumes with the SAME prompt: the trailing turn is REUSED —
      // one store append skipped, one prompt message skipped.
      const retryDriver = new AiSdkDriver({
        providers: { mock: () => modelFor({ kind: 'reply', text: 'recovered' }) },
        sessionsDir: join(scratchDir, 'sessions'),
      });
      await retryDriver.run(
        invocation({ prompt: 'retry-me-once', sessionRef: failed.sessionId as string }),
      );
      const messages = lastGenerateTextArgs().messages ?? [];
      expect(
        messages.filter((m) => m.role === 'user' && m.content === 'retry-me-once'),
      ).toHaveLength(1);
      expect(lastGenerateTextArgs().system).not.toContain('retry-me-once');
      const after = await store.load(failed.sessionId as string);
      expect(
        after?.messages.filter((m) => m.role === 'user' && m.content === 'retry-me-once'),
      ).toHaveLength(1);
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('costUSD is priced off the SERVED model id; the provider handle stays modelSpec.provider (#24-7)', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-'));
    try {
      const pricingKeys: Array<{ provider: string; model: string }> = [];
      const driver = new AiSdkDriver({
        // The factory IGNORES the requested id and serves 'deepseek-flash' —
        // the silent-remap shape (modelSpec.model is 'deepseek-chat').
        providers: { mock: () => usageModel(mockUsage(), 'deepseek-flash') },
        sessionsDir: join(scratchDir, 'sessions'),
        pricing: (modelSpec) => {
          pricingKeys.push({ provider: modelSpec.provider, model: modelSpec.model });
          return { input: 1, output: 2 };
        },
      });
      const result = await driver.run(
        invocation({ modelSpec: { provider: 'mock', model: 'deepseek-chat' } }),
      );
      expect(result.model).toBe('deepseek-flash'); // WorkerResult.model keeps the served id
      // The price lookup got the SERVED id with the REQUESTED provider.
      expect(pricingKeys).toEqual([{ provider: 'mock', model: 'deepseek-flash' }]);
      // usage {input:100, output:12, cacheRead:15, cacheWrite:5} at 1/2 per
      // million (no cache rates → zero terms) = 124/1e6.
      expect(result.costUSD).toBeCloseTo(124 / 1_000_000, 12);
      expect(result.costBasis).toBe('modeled');
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });
});
