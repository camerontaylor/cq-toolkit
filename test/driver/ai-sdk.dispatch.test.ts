// Driver-specific dispatch surface (the head of the former ai-sdk.test.ts
// "2. Driver-specific unit tests"): pre-dispatch validation and provider
// resolution, the run-surface sandbox wiring, seam-v3 usage provenance, the
// stopReason and usage mapping tables, and pricing integration.
import { mkdtemp, mkdir, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import type { LanguageModelV4GenerateResult } from '@ai-sdk/provider';
import {
  conformanceHarnessConfig,
  bindGenerateTextCapture,
  generateTextCapture,
  invocation,
  lastGenerateTextArgs,
  mockUsage,
  modelFor,
  textResult,
  thrownBy,
  usageModel,
} from './ai-sdk.helpers.js';
import { AiSdkDriver, stopReasonOf, usageFromSdk } from '../../src/driver/ai-sdk/index.js';
import { DispatchError, errorClassOf } from '../../src/driver/errors.js';

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
// 2. Driver-specific unit tests
// ---------------------------------------------------------------------------

describe('ai-sdk driver specifics (mock model)', () => {
  test.each([0, -1, 2.5, NaN, Infinity])(
    'rejects invalid maxSteps=%s before provider resolution, with abort precedence',
    async (maxSteps) => {
      const provider = vi.fn(() => modelFor({ kind: 'reply', text: 'must never run' }));
      const driver = new AiSdkDriver({ providers: { mock: provider } });
      await expect(driver.run(invocation({ budget: { maxSteps } }))).rejects.toMatchObject({
        name: 'DispatchError',
        message: `ai-sdk driver: budget.maxSteps must be a positive integer, got ${String(maxSteps)}`,
      });
      expect(provider).not.toHaveBeenCalled();
      const controller = new AbortController();
      controller.abort();
      const aborted = await driver.run(invocation({ budget: { maxSteps } }), {
        signal: controller.signal,
      });
      expect(aborted.stopReason).toBe('aborted');
      expect(aborted.steps).toBe(0);
      expect(provider).not.toHaveBeenCalled();
    },
  );

  test('an uncompilable outputSchema is the LOCAL output-invalid verdict before any provider call (PR #238 review round 2)', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-preflight-'));
    try {
      const driver = new AiSdkDriver({
        providers: { mock: (modelId) => modelFor(undefined, modelId) },
        sessionsDir: join(scratchDir, 'sessions'),
        harnessConfig: conformanceHarnessConfig(scratchDir),
        sandboxConfig: {
          mode: 'off',
          backend: 'auto',
          network: 'model-only',
          runTool: 'on',
          envPassthrough: [],
        },
      });
      const result = await driver.run(
        invocation({
          outputSchema: { name: 'test.broken/v1', schema: { type: 'not-a-json-schema-type' } },
        }),
      );
      // The uniform schema-miss verdict, compiled locally — the settle-time
      // miss flow's shape, but produced BEFORE the provider dispatch: the
      // pre-dispatch preflight's objection names the COMPILER (a dispatched
      // run would carry the mock's reply-miss text and a fresh sessionId).
      expect(result.stopReason).toBe('error');
      expect(result.errorClass).toBe('output-invalid');
      expect(result.error).toContain('test.broken/v1');
      expect(result.error).toContain('could not be compiled');
      expect(result.usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
      expect(result.denials).toEqual([]);
      expect(result.sessionId).toBeUndefined();
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('I8 precedence: an already-aborted signal outranks an uncompilable outputSchema (PR #241)', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-i8-'));
    try {
      let modelCalls = 0;
      const driver = new AiSdkDriver({
        providers: {
          mock: () =>
            new MockLanguageModelV4({
              modelId: 'mock-1',
              doGenerate: async () => {
                modelCalls += 1;
                return textResult('must never run');
              },
            }),
        },
        sessionsDir: join(scratchDir, 'sessions'),
      });
      const controller = new AbortController();
      controller.abort();
      const result = await driver.run(
        invocation({
          outputSchema: { name: 'test.broken/v1', schema: { type: 'not-a-json-schema-type' } },
        }),
        { signal: controller.signal },
      );
      // The governed cancellation outranks the schema fault: the run settles
      // the plain abort verdict, never the LOCAL output-invalid one.
      expect(result.stopReason).toBe('aborted');
      expect(result.errorClass).toBeUndefined();
      expect(result.error).toBeUndefined();
      expect(modelCalls).toBe(0); // the scripted model was never called
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('omits run from the model surface when CQ policy withholds it', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-sandbox-'));
    try {
      const driver = new AiSdkDriver({
        providers: { mock: (modelId) => modelFor(undefined, modelId) },
        sessionsDir: join(scratchDir, 'sessions'),
        sandboxConfig: {
          mode: 'required',
          backend: 'auto',
          network: 'model-only',
          runTool: 'withheld',
          envPassthrough: [],
          configHint: 'CQ_SANDBOX=required needs a certified RS-13 backend',
        },
      });
      await driver.run(invocation());
      const tools = lastGenerateTextArgs().tools ?? {};
      expect(tools).not.toHaveProperty('run');
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('preserves the run surface when CQ policy resolves it on', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-sandbox-'));
    try {
      const driver = new AiSdkDriver({
        providers: { mock: (modelId) => modelFor(undefined, modelId) },
        sessionsDir: join(scratchDir, 'sessions'),
        sandboxConfig: {
          mode: 'off',
          backend: 'auto',
          network: 'model-only',
          runTool: 'on',
          envPassthrough: [],
        },
      });
      await driver.run(invocation());
      expect(lastGenerateTextArgs().tools).toHaveProperty('run');
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('preserves the pre-W1.11 run surface when no sandbox policy is expressed', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-sandbox-'));
    const policyNames = [
      'CQ_SANDBOX',
      'CQ_SANDBOX_BACKEND',
      'CQ_SANDBOX_NETWORK',
      'CQ_RUN_TOOL',
      'CQ_RUN_ENV_PASSTHROUGH',
    ] as const;
    const saved = policyNames.map((name) => [name, process.env[name]] as const);
    try {
      for (const name of policyNames) delete process.env[name];
      const driver = new AiSdkDriver({
        providers: { mock: (modelId) => modelFor(undefined, modelId) },
        sessionsDir: join(scratchDir, 'sessions'),
      });
      await driver.run(invocation());
      expect(lastGenerateTextArgs().tools).toHaveProperty('run');
    } finally {
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('unknown provider throws BEFORE dispatch — no session record is created', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-'));
    try {
      const sessionsDir = join(scratchDir, 'sessions');
      await mkdir(sessionsDir, { recursive: true });
      const driver = new AiSdkDriver({
        providers: { mock: () => modelFor(undefined) },
        sessionsDir,
      });
      const err = await thrownBy(
        driver.run(invocation({ modelSpec: { provider: 'nope', model: 'm' } })),
      );
      expect(err).toBeInstanceOf(DispatchError);
      expect((err as DispatchError).message).toContain("unknown provider 'nope'");
      // Seam v2: pre-dispatch misconfigurations carry their class (leg i-ii).
      expect(errorClassOf(err)).toBe('config');
      await expect(readdir(sessionsDir)).resolves.toEqual([]);
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('missing env key throws BEFORE dispatch (default registry, env manipulated only in-process)', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-'));
    const keyNames = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'ZAI_API_KEY', 'DEEPSEEK_API_KEY'];
    const saved = new Map(keyNames.map((name) => [name, process.env[name]]));
    try {
      for (const name of keyNames) delete process.env[name];
      const driver = new AiSdkDriver({ sessionsDir: join(scratchDir, 'sessions') });
      const err = await thrownBy(
        driver.run(invocation({ modelSpec: { provider: 'anthropic', model: 'claude-haiku-4-5' } })),
      );
      expect((err as DispatchError).message).toContain('ANTHROPIC_API_KEY');
      expect(errorClassOf(err)).toBe('config');
    } finally {
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('the ai-sdk provider handle is an alias for the zai factory (self-host driver-kind, review-debt #186)', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-'));
    const saved = process.env.ZAI_API_KEY;
    try {
      delete process.env.ZAI_API_KEY;
      const driver = new AiSdkDriver({ sessionsDir: join(scratchDir, 'sessions') });
      // The self-host config names provider 'ai-sdk' (src/selfhost/config.ts);
      // the default registry must resolve it to the zai factory rather than
      // throwing unknown-provider. Without the key, the factory's own
      // missing-key error is the proof the alias routed (no network call —
      // the key check is pre-dispatch), and it names the handle the caller
      // configured ('ai-sdk'), not the internal factory.
      const err = await thrownBy(
        driver.run(invocation({ modelSpec: { provider: 'ai-sdk', model: 'glm-5.3-flash' } })),
      );
      expect((err as DispatchError).message).toContain("provider 'ai-sdk' requires ZAI_API_KEY");
      expect(errorClassOf(err)).toBe('config');
    } finally {
      if (saved !== undefined) process.env.ZAI_API_KEY = saved;
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('seam v3: a completed step without provider usage is unmeasured; a reported zero is measured', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-'));
    try {
      const runWith = async (usage: unknown) => {
        const driver = new AiSdkDriver({
          providers: {
            mock: () => usageModel(usage as LanguageModelV4GenerateResult['usage']),
          },
          sessionsDir: join(scratchDir, 'sessions'),
        });
        return driver.run(invocation({ prompt: 'provenance' }));
      };
      // The provider reported NO numeric token field: ai@7 yields an
      // all-undefined LanguageModelUsage, normalization maps it to zeros, and
      // the placeholder must be declared unmeasured — a completed step alone
      // is not usage evidence.
      const missing = await runWith({});
      expect(missing.usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
      expect(missing.usageProvenance).toBe('unmeasured');
      // The provider reported explicit NUMERIC ZEROS: a genuine measured zero.
      const measuredZero = await runWith({
        inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 0, text: 0, reasoning: 0 },
      });
      expect(measuredZero.usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
      expect(measuredZero.usageProvenance).toBe('measured');
      // A normal measured run stays measured.
      const measured = await runWith(mockUsage());
      expect(measured.usageProvenance).toBe('measured');
      expect(measured.usage.input).toBeGreaterThan(0);
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('stopReason mapping table (checked in order: aborted → budget → error → complete)', () => {
    // 1. abort dominates every other condition.
    expect(
      stopReasonOf({ finishReason: 'length', aborted: true, tokenBudget: 10, totalTokens: 99 }),
    ).toBe('aborted');
    expect(
      stopReasonOf({
        finishReason: 'error',
        aborted: true,
        tokenBudget: undefined,
        totalTokens: 0,
      }),
    ).toBe('aborted');
    // 2. the token budget (totalTokens >= maxTokens) trips before finish reasons.
    expect(
      stopReasonOf({ finishReason: 'stop', aborted: false, tokenBudget: 10, totalTokens: 10 }),
    ).toBe('budget');
    expect(
      stopReasonOf({
        finishReason: 'tool-calls',
        aborted: false,
        tokenBudget: 10,
        totalTokens: 11,
      }),
    ).toBe('budget');
    // 3. SDK 'length' is a budget stop even without an explicit cap.
    expect(
      stopReasonOf({
        finishReason: 'length',
        aborted: false,
        tokenBudget: undefined,
        totalTokens: 5,
      }),
    ).toBe('budget');
    // 4. SDK error / content-filter are driver-level errors.
    expect(
      stopReasonOf({
        finishReason: 'error',
        aborted: false,
        tokenBudget: undefined,
        totalTokens: 0,
      }),
    ).toBe('error');
    expect(
      stopReasonOf({
        finishReason: 'content-filter',
        aborted: false,
        tokenBudget: undefined,
        totalTokens: 0,
      }),
    ).toBe('error');
    // 5. everything else is a normal completion.
    expect(
      stopReasonOf({
        finishReason: 'stop',
        aborted: false,
        tokenBudget: undefined,
        totalTokens: 0,
      }),
    ).toBe('complete');
    expect(
      stopReasonOf({
        finishReason: 'tool-calls',
        aborted: false,
        tokenBudget: undefined,
        totalTokens: 0,
      }),
    ).toBe('complete');
    expect(
      stopReasonOf({
        finishReason: 'other',
        aborted: false,
        tokenBudget: undefined,
        totalTokens: 0,
      }),
    ).toBe('complete');
  });

  test('usage mapping: details win over totals; no details → totals with cache at 0; reasoning NEVER set (subset of output)', () => {
    // The mock reports outputTokenDetails.reasoningTokens: 2 — realistic,
    // and deliberately so: reasoning is INSIDE outputTokens (the AI SDK's
    // totalTokens = inputTokens + outputTokens), so the fold must NOT lift
    // it into the separate frozen field (every summed total would diverge
    // from the SDK's totalTokens by exactly that amount).
    expect(
      usageFromSdk({
        inputTokens: 90,
        inputTokenDetails: { noCacheTokens: 70, cacheReadTokens: 15, cacheWriteTokens: 5 },
        outputTokens: 42,
        outputTokenDetails: { textTokens: 40, reasoningTokens: 2 },
        totalTokens: 132,
      }),
    ).toEqual({ input: 70, output: 42, cacheRead: 15, cacheWrite: 5 });
    expect(
      usageFromSdk({
        inputTokens: 90,
        inputTokenDetails: { noCacheTokens: 70, cacheReadTokens: 15, cacheWriteTokens: 5 },
        outputTokens: 42,
        outputTokenDetails: { textTokens: 40, reasoningTokens: 2 },
        totalTokens: 132,
      }),
    ).not.toHaveProperty('reasoning');
    expect(
      usageFromSdk({
        inputTokens: 10,
        inputTokenDetails: {
          noCacheTokens: undefined,
          cacheReadTokens: undefined,
          cacheWriteTokens: undefined,
        },
        outputTokens: 3,
        outputTokenDetails: { textTokens: 3, reasoningTokens: undefined },
        totalTokens: 13,
      }),
    ).toEqual({ input: 10, output: 3, cacheRead: 0, cacheWrite: 0 });
  });

  test('pricing integration: known model → derived costUSD number; unknown model → absent', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-'));
    try {
      const known = new AiSdkDriver({
        // The mock must serve the REQUESTED id: pricing keys on the OBSERVED
        // served model id now (issue #24), so a mock serving its default id
        // would be — correctly — unpriced for the requested model.
        providers: {
          anthropic: () => modelFor({ kind: 'reply', text: 'ok' }, 'claude-sonnet-4-5'),
        },
        sessionsDir: join(scratchDir, 'sessions'),
      });
      const knownResult = await known.run(
        invocation({ modelSpec: { provider: 'anthropic', model: 'claude-sonnet-4-5' } }),
      );
      // usage {input:100, output:12, cacheRead:15, cacheWrite:5} at
      // 3 / 15 / 0.3 / 3.75 per-million = (300 + 180 + 4.5 + 18.75) / 1e6.
      expect(knownResult.costUSD).toBeDefined();
      expect(knownResult.costUSD).toBeCloseTo(0.00050325, 10);

      const unknown = new AiSdkDriver({
        providers: { mock: () => modelFor({ kind: 'reply', text: 'ok' }) },
        sessionsDir: join(scratchDir, 'sessions'),
      });
      const unknownResult = await unknown.run(invocation());
      expect(unknownResult.costUSD).toBeUndefined(); // derived-only: never fabricated
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('sessionsDir at or under the bound workspace is a pre-dispatch config throw writing no session file (issue #1197)', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-sesscontain-'));
    try {
      const workspaceDir = join(scratchDir, 'workspace');
      await mkdir(workspaceDir);
      // A FRESH run with sessionsDir inside the workspace refuses before
      // any session state exists: the provider never runs, no file lands.
      const inside = join(workspaceDir, '.s');
      const provider = vi.fn(() => modelFor({ kind: 'reply', text: 'must never run' }));
      const driver = new AiSdkDriver({
        providers: { mock: provider },
        sessionsDir: inside,
      });
      const err = await thrownBy(driver.run(invocation({ workspace: { path: workspaceDir } })));
      expect(err).toMatchObject({ name: 'DispatchError' });
      expect(String((err as Error).message)).toContain('resolves inside the bound workspace');
      expect(errorClassOf(err)).toBe('config');
      // No model call was dispatched (the provider factory itself runs at
      // model resolution — pre-existing dispatch order, before workspace
      // binding too — but generateText never fired) and no file lands.
      const generatedBefore = generateTextCapture.generateTextArgs.length;
      await expect(driver.run(invocation({ workspace: { path: workspaceDir } }))).rejects.toThrow(
        'resolves inside the bound workspace',
      );
      expect(generateTextCapture.generateTextArgs.length).toBe(generatedBefore);
      await expect(readdir(inside)).rejects.toMatchObject({ code: 'ENOENT' });
      // The DEFAULT dir is covered the same way: CQ_SESSIONS_DIR under the
      // workspace refuses (XDG_STATE_HOME semantics untouched — blank
      // CQ_SESSIONS_DIR still falls through to the live foreign read).
      vi.stubEnv('CQ_SESSIONS_DIR', join(workspaceDir, '.s-default'));
      try {
        const defaulted = new AiSdkDriver({ providers: { mock: provider } });
        const generatedBeforeDefault = generateTextCapture.generateTextArgs.length;
        await expect(
          defaulted.run(invocation({ workspace: { path: workspaceDir } })),
        ).rejects.toMatchObject({ name: 'DispatchError' });
        expect(generateTextCapture.generateTextArgs.length).toBe(generatedBeforeDefault);
      } finally {
        vi.unstubAllEnvs();
      }
      // A RESUME through the same contained dir refuses too (no sidecar,
      // no record read past the refusal).
      await expect(
        driver.run(invocation({ workspace: { path: workspaceDir }, sessionRef: 'ses-absent' })),
      ).rejects.toThrow('resolves inside the bound workspace');
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });
});
