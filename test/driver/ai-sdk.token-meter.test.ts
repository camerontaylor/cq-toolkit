// Budget.maxOutputTokens (output-only cap) and Budget.maxContextTokens
// (per-request context ceiling) on the ai-sdk lane: the pure verdict, the
// stop-reason mapping, and a mock tool loop that must stop on each cap and
// record a `budget-stop` session line.
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { toOutputSchema } from '../../src/driver/common/structured.js';
import { MockLanguageModelV4 } from 'ai/test';
import type { LanguageModelV4GenerateResult } from '@ai-sdk/provider';
import { AiSdkDriver, stopReasonOf, tokenMeterVerdict } from '../../src/driver/ai-sdk/index.js';
import { DispatchError, errorClassOf } from '../../src/driver/errors.js';
import type { Budget, Usage } from '../../src/driver/types.js';
import { conformanceHarnessConfig, invocation } from './ai-sdk.helpers.js';

const step = (input: number, output: number, cacheRead = 0): Usage => ({
  input,
  output,
  cacheRead,
  cacheWrite: 0,
});

describe('tokenMeterVerdict', () => {
  test('output cap sums output only, ignoring input and cache reads', () => {
    const budget = { maxOutputTokens: 1000 };
    expect(
      tokenMeterVerdict(budget, [step(90_000, 400, 300_000), step(95_000, 500, 400_000)]),
    ).toBe(undefined);
    expect(tokenMeterVerdict(budget, [step(1, 400), step(1, 600)])).toEqual({
      cause: 'output-tokens',
      detail: 'output budget: 1000 output tokens over 2 steps (cap 1000)',
    });
  });

  test('context ceiling reads the LAST step input including cache', () => {
    const budget = { maxContextTokens: 200_000 };
    expect(tokenMeterVerdict(budget, [step(150_000, 10), step(10_000, 10, 150_000)])).toBe(
      undefined,
    );
    expect(tokenMeterVerdict(budget, [step(10_000, 10, 190_000)])).toEqual({
      cause: 'context',
      detail: 'context ceiling: step 1 carried 200000 input tokens (ceiling 200000)',
    });
  });

  test('output cap takes priority when both limits trip', () => {
    expect(
      tokenMeterVerdict({ maxOutputTokens: 10, maxContextTokens: 100 }, [step(100, 10)])?.cause,
    ).toBe('output-tokens');
  });

  test('no caps, no verdict', () => {
    expect(tokenMeterVerdict({}, [step(10_000_000, 10_000_000)])).toBe(undefined);
  });

  test('stopReasonOf maps a tripped meter to budget, after abort', () => {
    const base = { finishReason: 'tool-calls' as const, tokenBudget: undefined, totalTokens: 0 };
    expect(stopReasonOf({ ...base, aborted: false, meterStopped: true })).toBe('budget');
    expect(stopReasonOf({ ...base, aborted: true, meterStopped: true })).toBe('aborted');
    expect(
      stopReasonOf({ ...base, finishReason: 'stop', aborted: false, meterStopped: false }),
    ).toBe('complete');
  });
});

/** A model that calls `read` every step with the given per-step usage, then answers. */
function loopModel(usages: Array<{ input: number; cacheRead: number; output: number }>) {
  let calls = 0;
  const model = new MockLanguageModelV4({
    modelId: 'mock-1',
    doGenerate: async (): Promise<LanguageModelV4GenerateResult> => {
      const usage = usages[Math.min(calls, usages.length - 1)] ?? {
        input: 1,
        cacheRead: 0,
        output: 1,
      };
      calls += 1;
      const tokens = {
        inputTokens: {
          total: usage.input + usage.cacheRead,
          noCache: usage.input,
          cacheRead: usage.cacheRead,
          cacheWrite: 0,
        },
        outputTokens: { total: usage.output, text: usage.output, reasoning: 0 },
      };
      if (calls > usages.length) {
        return {
          content: [{ type: 'text', text: 'done' }],
          finishReason: { unified: 'stop', raw: undefined },
          usage: tokens,
          warnings: [],
        };
      }
      return {
        content: [
          {
            type: 'tool-call',
            toolCallId: `call-${String(calls)}`,
            toolName: 'read',
            input: JSON.stringify({ file_path: 'missing.txt' }),
          },
        ],
        finishReason: { unified: 'tool-calls', raw: undefined },
        usage: tokens,
        warnings: [],
      };
    },
  });
  return { model, calls: () => calls };
}

async function runLoop(
  budget: Budget,
  usages: Array<{ input: number; cacheRead: number; output: number }>,
) {
  const scratch = await mkdtemp(join(tmpdir(), 'aidrv-meter-'));
  const { model, calls } = loopModel(usages);
  const driver = new AiSdkDriver({
    providers: { mock: () => model },
    sessionsDir: join(scratch, 'sessions'),
    harnessConfig: conformanceHarnessConfig(scratch),
  });
  try {
    const result = await driver.run(invocation({ budget }));
    const files = await readdir(join(scratch, 'sessions'));
    const lines = (
      await Promise.all(files.map((f) => readFile(join(scratch, 'sessions', f), 'utf8')))
    )
      .join('')
      .split('\n')
      .filter((l) => l !== '')
      .map(
        (l) => JSON.parse(l) as { type: string; cause?: string; detail?: string; step?: number },
      );
    return { result, calls: calls(), stops: lines.filter((l) => l.type === 'budget-stop') };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

describe('ai-sdk driver token meter', () => {
  test.each([
    [{ maxContextTokens: 100 }, 'complete'],
    [{ maxContextTokens: 100, maxOutputTokens: 10 }, 'budget'],
    [{ maxContextTokens: 100, maxTokens: 110 }, 'budget'],
  ] as const)('terminal structured answer respects consumed caps: %o', async (budget, expected) => {
    const scratch = await mkdtemp(join(tmpdir(), 'aidrv-final-meter-'));
    const model = new MockLanguageModelV4({
      modelId: 'mock-1',
      doGenerate: async () => ({
        content: [{ type: 'text', text: '{"answer":"ok"}' }],
        finishReason: { unified: 'stop', raw: undefined },
        usage: {
          inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 10, text: 10, reasoning: 0 },
        },
        warnings: [],
      }),
    });
    try {
      const driver = new AiSdkDriver({
        providers: { mock: () => model },
        sessionsDir: join(scratch, 'sessions'),
        harnessConfig: conformanceHarnessConfig(scratch),
      });
      const result = await driver.run(
        invocation({
          budget,
          outputSchema: toOutputSchema('answer', z.object({ answer: z.string() })),
        }),
      );
      expect(result.stopReason).toBe(expected);
      const files = await readdir(join(scratch, 'sessions'));
      const log = (
        await Promise.all(files.map((f) => readFile(join(scratch, 'sessions', f), 'utf8')))
      ).join('');
      if (expected === 'complete') expect(log).not.toContain('budget-stop');
      expect(result.structuredOutput).toEqual(
        expected === 'complete' ? { answer: 'ok' } : undefined,
      );
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test.each(['{"answer":3}', 'not-json'])(
    'invalid terminal output at context ceiling is output-invalid without repair: %s',
    async (text) => {
      const scratch = await mkdtemp(join(tmpdir(), 'aidrv-invalid-meter-'));
      let calls = 0;
      const model = new MockLanguageModelV4({
        modelId: 'mock-1',
        doGenerate: async () => {
          calls++;
          return {
            content: [{ type: 'text', text }],
            finishReason: { unified: 'stop', raw: undefined },
            usage: {
              inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 10, text: 10, reasoning: 0 },
            },
            warnings: [],
          };
        },
      });
      try {
        const driver = new AiSdkDriver({
          providers: { mock: () => model },
          sessionsDir: join(scratch, 'sessions'),
          harnessConfig: conformanceHarnessConfig(scratch),
        });
        const result = await driver.run(
          invocation({
            budget: { maxContextTokens: 100 },
            outputSchema: toOutputSchema('answer', z.object({ answer: z.string() })),
          }),
        );
        expect(result).toMatchObject({ stopReason: 'error', errorClass: 'output-invalid' });
        expect(calls).toBe(1);
        const files = await readdir(join(scratch, 'sessions'));
        const log = (
          await Promise.all(files.map((f) => readFile(join(scratch, 'sessions', f), 'utf8')))
        ).join('');
        expect(log).not.toContain('budget-stop');
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    },
  );

  test('context ceiling stops the loop before the next request and records why', async () => {
    const { result, calls, stops } = await runLoop({ maxContextTokens: 200_000 }, [
      { input: 50_000, cacheRead: 0, output: 100 },
      { input: 20_000, cacheRead: 185_000, output: 100 },
      { input: 1, cacheRead: 0, output: 1 },
    ]);
    expect(result.stopReason).toBe('budget');
    expect(calls).toBe(2);
    expect(stops.map((s) => s.cause)).toEqual(['context']);
    expect(stops[0]?.detail).toContain('205000 input tokens');
    // The line's step and the detail's step number are the same count.
    expect(stops[0]?.step).toBe(2);
    expect(stops[0]?.detail).toContain('step 2 ');
  });

  test('output cap ignores large cached context and stops on output alone', async () => {
    const { result, calls, stops } = await runLoop({ maxOutputTokens: 1000 }, [
      { input: 5_000, cacheRead: 150_000, output: 400 },
      { input: 5_000, cacheRead: 160_000, output: 400 },
      { input: 5_000, cacheRead: 170_000, output: 400 },
      { input: 1, cacheRead: 0, output: 1 },
    ]);
    expect(result.stopReason).toBe('budget');
    expect(calls).toBe(3);
    expect(stops).toEqual([expect.objectContaining({ cause: 'output-tokens' })]);
  });

  test('under both caps the loop runs to its answer with no budget-stop line', async () => {
    const { result, calls, stops } = await runLoop(
      { maxOutputTokens: 10_000, maxContextTokens: 200_000 },
      [{ input: 5_000, cacheRead: 150_000, output: 400 }],
    );
    expect(result.stopReason).toBe('complete');
    expect(calls).toBe(2);
    expect(stops).toEqual([]);
  });

  test('non-positive caps are a config error before dispatch', async () => {
    const driver = new AiSdkDriver({ providers: { mock: () => loopModel([]).model } });
    for (const budget of [{ maxOutputTokens: 0 }, { maxContextTokens: 1.5 }]) {
      let caught: unknown;
      try {
        await driver.run(invocation({ budget }));
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(DispatchError);
      expect(errorClassOf(caught)).toBe('config');
    }
  });
});
