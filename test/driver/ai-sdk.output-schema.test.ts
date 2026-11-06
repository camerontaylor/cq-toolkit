// Seam v2 §2.3 (S3) — the invocation outputSchema, the uniform
// output-invalid verdict, the W3.4 bounded repair, and providerSignals on
// any verdict (the former ai-sdk.test.ts seam-v2 §2.3 describe).
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import {
  bindGenerateTextCapture,
  generateTextArgsFromEnd,
  invocation,
  modelFor,
  quota429Error,
  textResult,
  textResultWithHeaders,
} from './ai-sdk.helpers.js';
import { AiSdkDriver } from '../../src/driver/ai-sdk/index.js';
import { WorkerResultSchema } from '../../src/kernel/schema.js';
import type { OutputSchema, WorkerResult } from '../../src/driver/types.js';

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
// Seam v2 §2.3 (S3) — invocation outputSchema, the uniform output-invalid
// verdict, the W3.4 bounded repair, and providerSignals on any verdict
// ---------------------------------------------------------------------------

/** The invocation schema the §2.3 tests carry: `{answer: string}`, closed. */
const ANSWER_OUTPUT_SCHEMA: OutputSchema = {
  name: 'test.answer/v1',
  schema: {
    type: 'object',
    properties: { answer: { type: 'string' } },
    required: ['answer'],
    additionalProperties: false,
  },
};

describe('ai-sdk driver seam v2 §2.3: invocation outputSchema + repair + providerSignals', () => {
  test('round-trip: a schema-valid reply completes with the validated plain JSON', async () => {
    let modelCalls = 0;
    const mock = new MockLanguageModelV4({
      modelId: 'mock-1',
      doGenerate: async () => {
        modelCalls += 1;
        return textResult('{"answer":"ok"}');
      },
    });
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-s3-'));
    try {
      const driver = new AiSdkDriver({
        providers: { mock: () => mock },
        sessionsDir: join(scratchDir, 'sessions'),
      });
      const result = await driver.run(invocation({ outputSchema: ANSWER_OUTPUT_SCHEMA }));
      expect(result.stopReason).toBe('complete');
      expect(result.structuredOutput).toEqual({ answer: 'ok' });
      // PRODUCER RULE: no class (and no error) on a non-error verdict.
      expect(result.errorClass).toBeUndefined();
      expect(result.error).toBeUndefined();
      // A valid object means NO repair: exactly one model call.
      expect(modelCalls).toBe(1);
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('W3.4 repair: ONE tool-free repair call with the schema restated, then complete; usage covers BOTH calls', async () => {
    let modelCalls = 0;
    const mock = new MockLanguageModelV4({
      modelId: 'mock-1',
      doGenerate: async () => {
        modelCalls += 1;
        return modelCalls === 1
          ? textResult('I wrote prose instead of the JSON object, sorry')
          : textResult('{"answer":"repaired"}');
      },
    });
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-s3-'));
    try {
      const driver = new AiSdkDriver({
        providers: { mock: () => mock },
        sessionsDir: join(scratchDir, 'sessions'),
      });
      const result = await driver.run(
        invocation({ outputSchema: ANSWER_OUTPUT_SCHEMA, toolPolicy: { allow: [], mode: 'none' } }),
      );
      expect(modelCalls).toBe(2); // the main call + exactly ONE repair
      expect(result.stopReason).toBe('complete');
      expect(result.structuredOutput).toEqual({ answer: 'repaired' });
      expect(result.errorClass).toBeUndefined();
      // The repair is a REAL extra model call: both calls' usage lands in
      // the verdict (2 × {100 in, 12 out, 15 cacheRead, 5 cacheWrite}).
      expect(result.usage).toEqual({ input: 200, output: 24, cacheRead: 30, cacheWrite: 10 });
      // The REPAIR call is the most recent generateText: tool-free, one
      // attempt, one step, the schema restated, over the transcript.
      const repairArgs = generateTextArgsFromEnd(0);
      expect(repairArgs.tools).toBeUndefined();
      expect(repairArgs.maxRetries).toBe(0);
      expect(repairArgs.stopWhen).toHaveLength(1); // stepCountIs(1): no budget set
      const repairTurns = repairArgs.messages ?? [];
      const repairTurn = repairTurns[repairTurns.length - 1];
      expect(repairTurn?.role).toBe('user');
      expect(repairTurn?.content).toContain('JSON Schema (draft 2020-12)');
      expect(repairTurn?.content).toContain('"answer"'); // the schema restated
      // The model sees what it produced: the transcript + its own reply ride.
      expect(
        repairTurns.some(
          (m) =>
            m.role === 'assistant' &&
            JSON.stringify(m.content).includes('prose instead of the JSON'),
        ),
      ).toBe(true);
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test.each([
    ['provider', 'unknown'],
    ['abort', 'transient'],
  ] as const)(
    'failed repair keeps observed usage unpriced: %s → error/%s',
    async (failure, errorClass) => {
      let modelCalls = 0;
      const mock = new MockLanguageModelV4({
        modelId: 'mock-1',
        doGenerate: async () => {
          modelCalls += 1;
          if (modelCalls === 1) return textResult('{"wrong":true}');
          const error = new Error('repair failed');
          if (failure === 'abort') error.name = 'AbortError';
          throw error;
        },
      });
      const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-repair-failed-'));
      try {
        const driver = new AiSdkDriver({
          providers: { mock: () => mock },
          sessionsDir: join(scratchDir, 'sessions'),
          pricing: () => ({ input: 3, output: 15 }),
        });
        const result = await driver.run(invocation({ outputSchema: ANSWER_OUTPUT_SCHEMA }));
        expect(modelCalls).toBe(2);
        // Only the GOVERNED signal is cancellation (I8): a bare AbortError
        // here (no RunOptions.signal fired) is a run failure. The SDK step
        // timeout during retry backoff surfaces exactly this way, so it
        // classifies as the transient failure it is.
        expect(result.stopReason).toBe('error');
        expect(result.errorClass).toBe(errorClass);
        expect(result.usage).toEqual({ input: 100, output: 12, cacheRead: 15, cacheWrite: 5 });
        expect(result.costUSD).toBeUndefined();
        expect(result.costBasis).toBeUndefined();
      } finally {
        await rm(scratchDir, { recursive: true, force: true });
      }
    },
  );

  test('W3.4 repair exhausted: still invalid → error/output-invalid, usage and derived cost over BOTH calls', async () => {
    let modelCalls = 0;
    const mock = new MockLanguageModelV4({
      modelId: 'mock-1',
      doGenerate: async () => {
        modelCalls += 1;
        // PARSEABLE but schema-invalid — both the main call and the repair.
        return textResult('{"wrong":true}');
      },
    });
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-s3-'));
    try {
      const driver = new AiSdkDriver({
        providers: { mock: () => mock },
        sessionsDir: join(scratchDir, 'sessions'),
        pricing: () => ({ input: 3, output: 15 }),
      });
      const result = await driver.run(invocation({ outputSchema: ANSWER_OUTPUT_SCHEMA }));
      expect(modelCalls).toBe(2); // one repair attempt, exactly
      expect(result.stopReason).toBe('error');
      expect(result.errorClass).toBe('output-invalid');
      expect(result.structuredOutput).toBeUndefined();
      // The verdict keeps the spend evidence of BOTH calls, and the derived
      // cost is computed over the folded usage.
      expect(result.usage).toEqual({ input: 200, output: 24, cacheRead: 30, cacheWrite: 10 });
      expect(typeof result.costUSD).toBe('number');
      expect(result.costBasis).toBe('modeled');
      // The rejection is recorded in the bounded text: main miss + repair miss.
      expect(result.error).toContain("does not validate against schema 'test.answer/v1'");
      expect(result.error).toContain('repair:');
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('no schema requested: structuredOutput is ABSENT even when the reply is JSON', async () => {
    let modelCalls = 0;
    const mock = new MockLanguageModelV4({
      modelId: 'mock-1',
      doGenerate: async () => {
        modelCalls += 1;
        return textResult('{"answer":"ok"}');
      },
    });
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-s3-'));
    try {
      const driver = new AiSdkDriver({
        providers: { mock: () => mock },
        sessionsDir: join(scratchDir, 'sessions'),
      });
      const result = await driver.run(invocation());
      expect(result.stopReason).toBe('complete');
      expect(result.structuredOutput).toBeUndefined();
      expect(result.errorClass).toBeUndefined();
      expect(modelCalls).toBe(1); // no schema → no repair machinery at all
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('providerSignals ride ANY verdict: response-metadata headers on success, error headers on a quota 429', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-s3-'));
    try {
      // SUCCESS: the response metadata headers the SDK exposes.
      const okMock = new MockLanguageModelV4({
        modelId: 'mock-1',
        doGenerate: async () =>
          textResultWithHeaders('ok', {
            'retry-after': '30',
            'x-ratelimit-limit-requests': '100',
            'x-ratelimit-remaining-requests': '50',
          }),
      });
      const okDriver = new AiSdkDriver({
        providers: { mock: () => okMock },
        sessionsDir: join(scratchDir, 'sessions'),
      });
      const okResult = await okDriver.run(invocation());
      expect(okResult.stopReason).toBe('complete');
      expect(okResult.providerSignals).toEqual({
        retryAfterMs: 30_000,
        windows: [{ id: 'requests', utilization: 0.5, remaining: { requests: 50 } }],
      });
      expect(okResult.errorClass).toBeUndefined();

      // FAILURE: a quota 429 whose headers carry the claude unified window —
      // quota class WITH the window's resetAt (the §2.2 rule-5 producer rule).
      const quotaMock = new MockLanguageModelV4({
        modelId: 'mock-1',
        doGenerate: async () => {
          throw quota429Error();
        },
      });
      const quotaDriver = new AiSdkDriver({
        providers: { mock: () => quotaMock },
        sessionsDir: join(scratchDir, 'sessions'),
      });
      const quotaResult = await quotaDriver.run(invocation());
      expect(quotaResult.stopReason).toBe('error');
      expect(quotaResult.errorClass).toBe('quota');
      expect(quotaResult.providerSignals).toEqual({
        windows: [{ id: '5h', utilization: 1, resetAt: '2026-09-28T12:00:00.000Z' }],
      });
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('producer rule: errorClass rides every error verdict and NO non-error verdict; the mirror still parses them', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-s3-'));
    let sessionsDirCounter = 0;
    const freshDir = (): string => join(scratchDir, `run-${(sessionsDirCounter += 1)}`);
    try {
      const runs: Array<{ label: string; result: WorkerResult }> = [];

      // 1. provider failure → error (class from the structured cuts).
      const failDriver = new AiSdkDriver({
        providers: { mock: () => modelFor({ kind: 'fail' }) },
        sessionsDir: freshDir(),
      });
      runs.push({ label: 'fail', result: await failDriver.run(invocation()) });

      // 2. output-invalid → error/'output-invalid'.
      const invalidMock = new MockLanguageModelV4({
        modelId: 'mock-1',
        doGenerate: async () => textResult('{"wrong":true}'),
      });
      const invalidDriver = new AiSdkDriver({
        providers: { mock: () => invalidMock },
        sessionsDir: freshDir(),
      });
      runs.push({
        label: 'output-invalid',
        result: await invalidDriver.run(invocation({ outputSchema: ANSWER_OUTPUT_SCHEMA })),
      });

      // 3. a quota 429 → error/'quota' with providerSignals.
      const quotaDriver = new AiSdkDriver({
        providers: {
          mock: () =>
            new MockLanguageModelV4({
              modelId: 'mock-1',
              doGenerate: async () => {
                throw quota429Error();
              },
            }),
        },
        sessionsDir: freshDir(),
      });
      runs.push({ label: 'quota', result: await quotaDriver.run(invocation()) });

      // 4. complete → NO class.
      const okDriver = new AiSdkDriver({
        providers: { mock: () => modelFor({ kind: 'reply', text: 'plain prose' }) },
        sessionsDir: freshDir(),
      });
      runs.push({ label: 'complete', result: await okDriver.run(invocation()) });

      // 5. pre-aborted → 'aborted', NO class (a cancellation is not a failure).
      const dead = new AbortController();
      dead.abort();
      const abortedDriver = new AiSdkDriver({
        providers: { mock: () => modelFor({ kind: 'reply', text: 'never runs' }) },
        sessionsDir: freshDir(),
      });
      runs.push({
        label: 'aborted',
        result: await abortedDriver.run(invocation(), { signal: dead.signal }),
      });

      for (const { label, result } of runs) {
        if (result.stopReason === 'error') {
          expect(result.errorClass, `${label}: error verdicts carry a class`).toBeDefined();
        } else {
          expect(result.errorClass, `${label}: non-error verdicts carry none`).toBeUndefined();
        }
        // The strict v2 mirror parses every verdict (errorClass is
        // one-directional: present ⇒ error).
        const reparsed = WorkerResultSchema.parse(JSON.parse(JSON.stringify(result)));
        expect(reparsed.stopReason).toBe(result.stopReason);
      }
      expect(runs.map((r) => r.result.stopReason)).toEqual([
        'error',
        'error',
        'error',
        'complete',
        'aborted',
      ]);
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });
});
