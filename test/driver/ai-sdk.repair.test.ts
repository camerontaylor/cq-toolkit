// The structured-output repair cycle (part of the former ai-sdk.test.ts
// "ai-sdk driver specifics (mock model)"): the ONE bounded repair (#203,
// W3.4), a successful repair still judged by the token cap, and the
// served-model identity rules on every repair path (PR #238 rounds 2-3).
import { mkdtempSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import { invocation, offeredToolCount, textResult, toolCallResult } from './ai-sdk.helpers.js';
import { AiSdkDriver, DEFAULT_MAX_STEPS } from '../../src/driver/ai-sdk/index.js';
import { toOutputSchema } from '../../src/driver/common/structured.js';

describe('ai-sdk driver specifics (mock model)', () => {
  test('a missing structured object is repaired ONCE, then settles error/output-invalid (#203, W3.4)', async () => {
    let calls = 0;
    const alwaysToolCalls = new MockLanguageModelV4({
      modelId: 'mock-1',
      doGenerate: async (options) => {
        calls += 1;
        // The repair is TOOL-FREE: the mock answers it with another tool
        // call, so the repair's own parse misses too — the give-up path.
        if (offeredToolCount(options) > 0) {
          return toolCallResult('read', { path: 'absent.txt' });
        }
        return textResult('still not an object');
      },
    });
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-'));
    try {
      const driver = new AiSdkDriver({
        providers: { mock: () => alwaysToolCalls },
        sessionsDir: join(scratchDir, 'sessions'),
      });
      const result = await driver.run(
        invocation({
          toolPolicy: { allow: ['read'], mode: 'allowlist' },
          outputSchema: toOutputSchema(
            'test/repair-once/v1',
            z.object({ fixed: z.boolean(), notes: z.string() }).strict(),
          ),
        }),
      );
      // ONE bounded repair attempt after the miss: DEFAULT_MAX_STEPS
      // tool-loop steps + the single repair step.
      expect(calls).toBe(DEFAULT_MAX_STEPS + 1);
      expect(result.stopReason).toBe('error');
      // ADR-0002 §2.3: the uniform miss verdict — output-invalid, rejection
      // recorded in the bounded error text (both the miss and the repair).
      expect(result.errorClass).toBe('output-invalid');
      expect(result.steps).toBe(DEFAULT_MAX_STEPS + 1); // includes the failed repair step
      expect(
        result.error?.startsWith(
          'ai-sdk driver: structured output invalid after the repair attempt',
        ),
      ).toBe(true);
      expect(result.error).toContain('repair');
      // never a model score: no fabricated structuredOutput on an error verdict.
      expect(result.structuredOutput).toBeUndefined();
      // The usage covers BOTH calls: DEFAULT_MAX_STEPS tool-loop steps +
      // 1 repair step, each folding {100 in, 12 out, 15 cacheRead, 5 cacheWrite}.
      expect(result.usage).toEqual({
        input: 100 * (DEFAULT_MAX_STEPS + 1),
        output: 12 * (DEFAULT_MAX_STEPS + 1),
        cacheRead: 15 * (DEFAULT_MAX_STEPS + 1),
        cacheWrite: 5 * (DEFAULT_MAX_STEPS + 1),
      });
      expect(result.costUSD).toBeUndefined(); // never fabricated on a non-complete run
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('a SUCCESSFUL repair is still judged by the token cap: the accumulated fold trips budget (cycle-2)', async () => {
    let calls = 0;
    let toolFreeCalls = 0;
    const repairSucceeds = new MockLanguageModelV4({
      modelId: 'mock-1',
      doGenerate: async (options) => {
        calls += 1;
        // Main loop tool-calls. The lane's FINAL LOOP STEP (and
        // then the REPAIR) is distinguished by counting: the
        // FIRST tool-free call must ALSO miss (else the loop's final step
        // completes the run and no repair fires); the SECOND — the repair —
        // answers with the valid object.
        if (offeredToolCount(options) > 0) {
          return toolCallResult('read', { path: 'absent.txt' });
        }
        toolFreeCalls += 1;
        return toolFreeCalls === 1
          ? textResult('prose with no json at all')
          : textResult('{\"fixed\":true,\"notes\":\"ok\"}');
      },
    });
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-'));
    try {
      const driver = new AiSdkDriver({
        providers: { mock: () => repairSucceeds },
        sessionsDir: join(scratchDir, 'sessions'),
      });
      const schema = toOutputSchema(
        'test/repair-budget/v1',
        z.object({ fixed: z.boolean(), notes: z.string() }).strict(),
      );
      // DEFAULT_MAX_STEPS main steps end on the step cap (each 132 total
      // tokens incl. cache, under the cap — the loop ends on max-steps, so
      // the REPAIR fires), then the repair pushes the accumulated fold one
      // step past the cap: the repair's success is an honest 'budget'
      // verdict — the payload does not ride it, the spend evidence does.
      const budgeted = await driver.run(
        invocation({
          toolPolicy: { allow: ['read'], mode: 'allowlist' },
          budget: { maxTokens: 132 * DEFAULT_MAX_STEPS + 66 },
          outputSchema: schema,
        }),
      );
      expect(calls).toBe(DEFAULT_MAX_STEPS + 1);
      expect(budgeted.stopReason).toBe('budget');
      expect(budgeted.structuredOutput).toBeUndefined();
      expect(budgeted.errorClass).toBeUndefined(); // a cap is not a failure
      expect(budgeted.usage).toEqual({
        input: 100 * (DEFAULT_MAX_STEPS + 1),
        output: 12 * (DEFAULT_MAX_STEPS + 1),
        cacheRead: 15 * (DEFAULT_MAX_STEPS + 1),
        cacheWrite: 5 * (DEFAULT_MAX_STEPS + 1),
      });
      // CONTROL: the same successful repair under a cap it never reaches →
      // complete WITH the payload. toolFreeCalls resets too — the control
      // must follow the SAME invalid-final-step path (miss → repair →
      // object), not complete on the loop's final step.
      calls = 0;
      toolFreeCalls = 0;
      const free = new AiSdkDriver({
        providers: { mock: () => repairSucceeds },
        sessionsDir: join(scratchDir, 'sessions'),
      });
      const completed = await free.run(
        invocation({
          toolPolicy: { allow: ['read'], mode: 'allowlist' },
          budget: { maxTokens: 132 * (DEFAULT_MAX_STEPS + 1) * 4 },
          outputSchema: schema,
        }),
      );
      expect(completed.stopReason).toBe('complete');
      expect(completed.structuredOutput).toEqual({ fixed: true, notes: 'ok' });
      // The repair really fired: DEFAULT_MAX_STEPS loop steps + 1 repair step.
      expect(calls).toBe(DEFAULT_MAX_STEPS + 1);
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('a repair with an UNOBSERVED model id fails closed; its fresher limit headers win (PR #238 review round 2)', async () => {
    let calls = 0;
    let toolFreeCalls = 0;
    const repairShadow = new MockLanguageModelV4({
      modelId: 'mock-1',
      doGenerate: async (options) => {
        calls += 1;
        if (offeredToolCount(options) > 0) {
          return toolCallResult('read', { path: 'absent.txt' });
        }
        toolFreeCalls += 1;
        if (toolFreeCalls === 1) return textResult('prose with no json at all');
        // The REPAIR: a valid object, but the provider metadata reports an
        // EMPTY model id (unobserved) and a FRESH retry-after header — the
        // second request consumed capacity after the first.
        return {
          ...textResult('{\"fixed\":true,\"notes\":\"ok\"}'),
          response: { modelId: '', headers: { 'retry-after': '99' } },
        };
      },
    });
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-'));
    try {
      const driver = new AiSdkDriver({
        providers: { mock: () => repairShadow },
        sessionsDir: join(scratchDir, 'sessions'),
      });
      const result = await driver.run(
        invocation({
          toolPolicy: { allow: ['read'], mode: 'allowlist' },
          outputSchema: toOutputSchema(
            'test/repair-shadow/v1',
            z.object({ fixed: z.boolean(), notes: z.string() }).strict(),
          ),
        }),
      );
      // The main call observed 'mock-1'; the payload's producer reported NO
      // id — the intra-run guard fails closed exactly like the wrapper's
      // default requireObserved would.
      expect(result.stopReason).toBe('error');
      expect(result.errorClass).toBe('served-model-mismatch');
      expect(result.error).toContain('reported no model id');
      // Spend evidence kept; the mixed-identity fold is unpriced.
      expect(result.structuredOutput).toBeUndefined();
      expect(result.usage.input).toBeGreaterThan(0);
      // The REPAIR's fresher limit header, not the main response's absence.
      expect(result.providerSignals).toEqual({ retryAfterMs: 99_000 });
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('repair identity judgment: repair-only observation is REPORTED for the wrapper; a mixed identity is unpriced on every repair path (PR #238 round 3)', async () => {
    const schema = z.object({ fixed: z.boolean(), notes: z.string() }).strict();
    // 1. REPAIR-ONLY: the main call never observes an id (empty provider
    //    metadata on every main step); the repair reports 'repair-served-1'.
    //    The verdict reports the repair's id — the outer wrapper's default
    //    requireObserved then judges THAT id (here: a bare lane, so the
    //    propagation itself is the assertion).
    let toolFree1 = 0;
    const d1 = new AiSdkDriver({
      providers: {
        mock: () =>
          new MockLanguageModelV4({
            modelId: 'mock-1',
            doGenerate: async (options: { tools?: unknown[] }) => {
              if (offeredToolCount(options) > 0) {
                return {
                  ...toolCallResult('read', { path: 'absent.txt' }),
                  response: { modelId: '' },
                };
              }
              toolFree1 += 1;
              if (toolFree1 === 1) {
                return { ...textResult('prose, no json'), response: { modelId: '' } };
              }
              return {
                ...textResult('{\"fixed\":true,\"notes\":\"ok\"}'),
                response: { modelId: 'repair-served-1' },
              };
            },
          }),
      },
      sessionsDir: join(mkdtempSync(join(tmpdir(), 'aidrv-id1-')), 'sessions'),
    });
    const r1 = await d1.run(
      invocation({
        outputSchema: toOutputSchema('test/identity-1/v1', schema),
        toolPolicy: { allow: ['read'], mode: 'allowlist' },
      }),
    );
    expect(r1.stopReason).toBe('complete');
    expect(r1.model).toBe('repair-served-1'); // the payload's producer, for the wrapper to judge
    expect(r1.structuredOutput).toEqual({ fixed: true, notes: 'ok' });

    // 2. MIXED on the INVALID-repair path: the main observed 'mock-1', the
    //    repair reports 'other-id' and its object misses: the output-invalid
    //    verdict keeps the usage but the PRICED fold is suppressed — pricing
    //    under the main id would attribute the repair's tokens to it.
    let toolFree2 = 0;
    const priced = new AiSdkDriver({
      providers: {
        mock: () =>
          new MockLanguageModelV4({
            modelId: 'mock-1',
            doGenerate: async (options: { tools?: unknown[] }) => {
              if (offeredToolCount(options) > 0) {
                return toolCallResult('read', { path: 'absent.txt' });
              }
              toolFree2 += 1;
              if (toolFree2 === 1) return textResult('prose, no json');
              return { ...textResult('still no object'), response: { modelId: 'other-id' } };
            },
          }),
      },
      pricing: () => ({ input: 3, output: 15 }),
      sessionsDir: join(mkdtempSync(join(tmpdir(), 'aidrv-id2-')), 'sessions'),
    });
    const r2 = await priced.run(
      invocation({
        outputSchema: toOutputSchema('test/identity-2/v1', schema),
        toolPolicy: { allow: ['read'], mode: 'allowlist' },
      }),
    );
    expect(r2.stopReason).toBe('error');
    expect(r2.errorClass).toBe('output-invalid');
    expect(r2.model).toBe('mock-1'); // the main observation, as evidence
    expect(r2.usage.input).toBeGreaterThan(0);
    expect(r2.costUSD).toBeUndefined(); // a mixed-identity fold is NEVER priced
  });
});
