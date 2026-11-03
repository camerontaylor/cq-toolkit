// Seam v2 §2.3 (S3) — the §2.2 failure-classifier rows over the SDK
// transport: the structured rate_limit field, the CLI usage-limit quota
// windows (unified + weekly), retry-after rate-limits and bare-429
// provider-error parity, the funded-allowance spend cap, the classifyFailure
// cut order, resetAtFromLimitText parsing, and the errorClass producer rule.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { classifyFailure, resetAtFromLimitText } from '../../../src/driver/claude-code/failures.js';
import type { FailureClassInputs } from '../../../src/driver/claude-code/failures.js';
import { ClaudeCodeDriver } from '../../../src/driver/claude-code/index.js';
import { SESSIONS_DIR } from '../../../src/driver/conformance.js';
import { toOutputSchema } from '../../../src/driver/common/structured.js';
import { WorkerResultSchema } from '../../../src/kernel/schema.js';
import type { WorkerResult } from '../../../src/driver/types.js';
import {
  AGENT_USAGE,
  conformanceEndpointTable,
  conformanceHarnessConfig,
  initFrame,
  invocation,
  mockAdapters,
  mockSdkModule,
  streamDriver,
} from './sdk.helpers.js';

// ---------------------------------------------------------------------------
// Seam v2 §2.3 (S3) — invocation outputSchema, the uniform output-invalid
// verdict, the §2.2 classifier rows, and providerSignals
// ---------------------------------------------------------------------------

describe('claude-code sdk transport seam v2 §2.3 (S3): invocation outputSchema + output-invalid + classifier', () => {
  test('an assistant frame with the structured error rate_limit classifies quota', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'agtdrv-s3-'));
    try {
      const driver = streamDriver(scratchDir, () => [
        {
          type: 'assistant',
          session_id: 'agent-cli-s3',
          // The SDK's structured per-frame error field — no prose needed.
          error: 'rate_limit',
          message: {
            model: 'conformance-1',
            content: [{ type: 'text', text: 'slow down' }],
            usage: AGENT_USAGE,
          },
        },
        {
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          session_id: 'agent-cli-s3',
          usage: AGENT_USAGE,
        },
      ]);
      const result = await driver.run(invocation({ toolPolicy: { allow: [], mode: 'none' } }));
      expect(result.stopReason).toBe('error');
      // RS-14 §4 rule 3: the structured rate_limit field is quota, ahead of
      // the retry-after rule.
      expect(result.errorClass).toBe('quota');
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('the CLI usage-limit result classifies quota WITH the unified window reset', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'agtdrv-s3-'));
    try {
      const driver = streamDriver(scratchDir, () => [
        {
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          session_id: 'agent-cli-s3',
          result: "You've hit your use limit · resets 3pm (Asia/Singapore)",
          usage: AGENT_USAGE,
        },
      ]);
      const result = await driver.run(invocation({ toolPolicy: { allow: [], mode: 'none' } }));
      expect(result.stopReason).toBe('error');
      expect(result.errorClass).toBe('quota');
      // The quota producer rule: the reset instant rides providerSignals —
      // the next 15:00 Asia/Singapore (the vendor's wall-clock form).
      const resetAt = result.providerSignals?.windows?.[0]?.resetAt;
      expect(resetAt).toBeDefined();
      const instant = Date.parse(resetAt as string);
      expect(instant).toBeGreaterThan(Date.now() - 60_000);
      expect(instant).toBeLessThan(Date.now() + 36 * 3_600_000);
      expect(result.providerSignals?.windows?.[0]?.id).toBe('5h');

      // The weekly window is named too ('7d'), from an absolute date+clock.
      const weekly = streamDriver(scratchDir, () => [
        {
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          session_id: 'agent-cli-s3',
          result: "You've hit your weekly limit · resets 2026-12-31 3pm (Asia/Singapore)",
          usage: AGENT_USAGE,
        },
      ]);
      const weeklyResult = await weekly.run(
        invocation({ toolPolicy: { allow: [], mode: 'none' } }),
      );
      expect(weeklyResult.errorClass).toBe('quota');
      expect(weeklyResult.providerSignals?.windows?.[0]?.id).toBe('7d');
      expect(weeklyResult.providerSignals?.windows?.[0]?.resetAt).toBeDefined();
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('rate_limit_error with a retry-after classifies rate-limit with retryAfterMs', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'agtdrv-s3-'));
    try {
      const driver = streamDriver(scratchDir, () => [
        {
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          session_id: 'agent-cli-s3',
          errors: ['rate_limit_error: Rate limit exceeded. Try again in 25 seconds.'],
          usage: AGENT_USAGE,
        },
      ]);
      const result = await driver.run(invocation({ toolPolicy: { allow: [], mode: 'none' } }));
      expect(result.stopReason).toBe('error');
      expect(result.errorClass).toBe('rate-limit');
      expect(result.providerSignals).toEqual({ retryAfterMs: 25_000 });
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('a bare rate_limit_error (no stated retry-after) is provider-error, never rate-limit', async () => {
    // The 'rate-limit' class MEANS "429 WITH retry-after" (types.ts; the
    // ai-sdk lane's bare-429 row): without a backoff to honor the same
    // vendor condition is a permanent provider failure — the two lanes
    // must not classify one condition differently.
    const scratchDir = await mkdtemp(join(tmpdir(), 'agtdrv-s3-'));
    try {
      const driver = streamDriver(scratchDir, () => [
        {
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          session_id: 'agent-cli-s3',
          errors: ['rate_limit_error: Rate limit exceeded.'],
          usage: AGENT_USAGE,
        },
      ]);
      const result = await driver.run(invocation({ toolPolicy: { allow: [], mode: 'none' } }));
      expect(result.stopReason).toBe('error');
      expect(result.errorClass).toBe('provider-error');
      expect(result.providerSignals).toBeUndefined();
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('enforced_spend_limit_reached classifies quota whatever the wrapper', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'agtdrv-s3-'));
    try {
      // The funded-allowance 429 surfaces as a DISPATCH THROW (the SDK's
      // stream dies on it): the code alone decides the class (ADR §2.2
      // rule 2 — whatever the status).
      const driver = new ClaudeCodeDriver({
        transport: 'sdk',
        sdkLoader: async () => ({
          ...mockAdapters,
          query: ({
            options,
          }: {
            prompt: string;
            options: Record<string, unknown>;
          }): AsyncGenerator<unknown, void> =>
            (async function* () {
              // The honest init, then a throw BEFORE the result frame — the
              // dispatch-throw surface (the funded-allowance 429 kills the
              // SDK stream).
              yield initFrame(options);
              throw new Error(
                '429 request failed: enforced_spend_limit_reached — this request would exceed your spend limit',
              );
            })(),
        }),
        routingTable: conformanceEndpointTable(),
        sessionsDir: join(scratchDir, SESSIONS_DIR),
        harnessConfig: conformanceHarnessConfig(scratchDir),
      });
      const result = await driver.run(invocation({ toolPolicy: { allow: [], mode: 'none' } }));
      expect(result.stopReason).toBe('error');
      expect(result.errorClass).toBe('quota');
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('classifyFailure: the §2.2 cut order over structured signals only', () => {
    const base: FailureClassInputs = {
      kind: 'result-frame',
      texts: [],
      assistantRateLimit: false,
    };
    // Cut 1: the funded-allowance code is quota whatever wrapped it.
    expect(
      classifyFailure({
        ...base,
        kind: 'dispatch-threw',
        texts: ['429 enforced_spend_limit_reached'],
      }).errorClass,
    ).toBe('quota');
    // Cut 2: the structured assistant field, then the CLI limit text.
    expect(classifyFailure({ ...base, assistantRateLimit: true }).errorClass).toBe('quota');
    const limit = classifyFailure({
      ...base,
      texts: ["You've hit your use limit · resets 3pm (Asia/Singapore)"],
    });
    expect(limit.errorClass).toBe('quota');
    expect(limit.providerSignals?.windows?.[0]?.id).toBe('5h');
    // Cut 3: rate_limit_error with a stated retry-after → rate-limit; a
    // bare 429 states no backoff, so it is provider-error (the class
    // contract "429 WITH retry-after"; ai-sdk bare-429 parity).
    const rate = classifyFailure({
      ...base,
      texts: ['rate_limit_error: Rate limit exceeded. Try again in 12 seconds.'],
    });
    expect(rate.errorClass).toBe('rate-limit');
    expect(rate.providerSignals?.retryAfterMs).toBe(12_000);
    const bare = classifyFailure({ ...base, texts: ['rate_limit_error'] });
    expect(bare.errorClass).toBe('provider-error');
    expect(bare.providerSignals).toBeUndefined(); // never invented
    // Cut 4: local failure surfaces are harness.
    expect(
      classifyFailure({ ...base, kind: 'dispatch-threw', texts: ['spawn failed'] }).errorClass,
    ).toBe('harness');
    expect(classifyFailure({ ...base, kind: 'no-result', texts: [] }).errorClass).toBe('harness');
    // Cut 5: a result frame that failed for its own reason.
    expect(classifyFailure({ ...base, texts: ['boom'] }).errorClass).toBe('provider-error');
  });

  test('resetAtFromLimitText: anchored forms only; ambiguous tails stay absent', () => {
    expect(resetAtFromLimitText('limit · resets 2026-09-28T12:00:00Z')).toBe(
      '2026-09-28T12:00:00.000Z',
    );
    const duration = resetAtFromLimitText('limit · resets 1h30m');
    expect(duration).toBeDefined();
    // The vendor's wall-clock form resolves against the named zone.
    const wall = resetAtFromLimitText('limit · resets 3pm (Asia/Singapore)');
    expect(wall).toBeDefined();
    const instant = Date.parse(wall as string);
    expect(instant).toBeGreaterThan(Date.now() - 60_000);
    expect(instant).toBeLessThan(Date.now() + 36 * 3_600_000);
    // Ambiguous — never invented.
    expect(resetAtFromLimitText('limit · resets 3741')).toBeUndefined();
    expect(resetAtFromLimitText('limit · resets 3pm')).toBeUndefined(); // no zone
    expect(resetAtFromLimitText('no limit text at all')).toBeUndefined();
  });

  test('producer rule: errorClass rides every error verdict and NO non-error verdict; the mirror still parses them', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'agtdrv-s3-'));
    let runCount = 0;
    const freshDir = (): string => join(scratchDir, `run-${(runCount += 1)}`);
    try {
      const runs: Array<{ label: string; result: WorkerResult }> = [];

      // 1. a scripted model failure (dispatch throw) → error/'harness'.
      const failDriver = streamDriver(freshDir(), () => {
        throw new Error('scripted model failure');
      });
      runs.push({ label: 'fail', result: await failDriver.run(invocation()) });

      // 2. a structured-output miss → error/'output-invalid'.
      const missDriver = new ClaudeCodeDriver({
        transport: 'sdk',
        sdkLoader: async () =>
          mockSdkModule({ directive: { kind: 'reply', text: '{"nope":1}' }, calls: [] }),
        routingTable: conformanceEndpointTable(),
        sessionsDir: join(freshDir(), SESSIONS_DIR),
        harnessConfig: conformanceHarnessConfig(freshDir()),
      });
      runs.push({
        label: 'output-invalid',
        result: await missDriver.run(
          invocation({
            outputSchema: toOutputSchema(
              'test/classifier-miss/v1',
              z.object({ answer: z.string() }).strict(),
            ),
          }),
        ),
      });

      // 3. the CLI usage-limit result → error/'quota' with the window.
      const quotaDriver = streamDriver(freshDir(), () => [
        {
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          session_id: 'agent-cli-s3',
          result: "You've hit your use limit · resets 3pm (Asia/Singapore)",
          usage: AGENT_USAGE,
        },
      ]);
      runs.push({ label: 'quota', result: await quotaDriver.run(invocation()) });

      // 4. complete → NO class.
      const okDriver = streamDriver(freshDir(), () => [
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          session_id: 'agent-cli-s3',
          result: 'ok',
          usage: AGENT_USAGE,
          permission_denials: [],
        },
      ]);
      runs.push({ label: 'complete', result: await okDriver.run(invocation()) });

      // 5. pre-aborted → 'aborted', NO class (a cancellation is not a failure).
      const dead = new AbortController();
      dead.abort();
      const abortedDriver = streamDriver(freshDir(), () => []);
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
