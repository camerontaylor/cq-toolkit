// Machine-classifiable driver failure classes (#210): the step-timeout and
// retry wiring, the structured ADR §2.2 classification cuts
// (classifyRunFailure), and the providerSignals header/error extraction.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import { APICallError } from '@ai-sdk/provider';
import { z } from 'zod';
import {
  bindGenerateTextCapture,
  finishResult,
  invocation,
  lastGenerateTextArgs,
  modelFor,
  toolCallResult,
} from './ai-sdk.helpers.js';
import {
  AiSdkDriver,
  DEFAULT_STEP_TIMEOUT_MS,
  classifyRunFailure,
  providerSignalsFromError,
  providerSignalsFromHeaders,
} from '../../src/driver/ai-sdk/index.js';
import { runLadder } from '../../src/kernel/governor.js';
import type { Clock } from '../../src/kernel/governor.js';
import { toOutputSchema } from '../../src/driver/common/structured.js';

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
// #210 — one retry per step request + per-request step timeout +
// machine-classifiable failure classes (`WorkerResult.error` tokens)
// ---------------------------------------------------------------------------

describe('ai-sdk driver failure classes (#210)', () => {
  test.each([0, -1, 0.5, NaN, Infinity, -Infinity, 2_147_483_648, Number.MAX_SAFE_INTEGER])(
    'rejects unsupported stepTimeoutMs %s before constructing a timer',
    (stepTimeoutMs) => {
      expect(() => new AiSdkDriver({ stepTimeoutMs })).toThrow(
        /stepTimeoutMs must be a positive integer <= 2147483647/,
      );
    },
  );

  test.each([1, 1_200_000, 86_400_000, 2_147_483_647])(
    'accepts supported stepTimeoutMs %s, including long-running steps',
    (stepTimeoutMs) => {
      expect(() => new AiSdkDriver({ stepTimeoutMs })).not.toThrow();
    },
  );

  test('the SDK call runs one retry per step request and a per-request step timeout', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-'));
    try {
      const driver = new AiSdkDriver({
        providers: { mock: () => modelFor({ kind: 'reply', text: 'ok' }) },
        sessionsDir: join(scratchDir, 'sessions'),
      });
      await driver.run(invocation());
      const args = lastGenerateTextArgs();
      // ONE retry per step request for the SDK-retryable transient class —
      // the exhausted-retry error still names the attempt count and last
      // error (and the bound is per step, so ≤ DEFAULT_MAX_STEPS per run).
      expect(args.maxRetries).toBe(1);
      // Bound for EACH step of the tool loop.
      expect(args.timeout).toEqual({ stepMs: DEFAULT_STEP_TIMEOUT_MS });
      expect(DEFAULT_STEP_TIMEOUT_MS).toBe(1_200_000);
      // The bound is configurable per driver and validated.
      const tuned = new AiSdkDriver({
        providers: { mock: () => modelFor({ kind: 'reply', text: 'ok' }) },
        sessionsDir: join(scratchDir, 'sessions'),
        stepTimeoutMs: 900_000,
      });
      await tuned.run(invocation());
      expect(lastGenerateTextArgs().timeout).toEqual({ stepMs: 900_000 });
      expect(() => new AiSdkDriver({ stepTimeoutMs: 0 })).toThrow(/stepTimeoutMs/);
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('an SDK-retryable endpoint failure is classified transient with providerSignals from the error headers', async () => {
    const transient = new APICallError({
      message: 'Cannot connect to API: Headers Timeout Error',
      url: 'https://example.test',
      requestBodyValues: {},
      isRetryable: true,
    });
    const timeoutModel = new MockLanguageModelV4({
      modelId: 'mock-1',
      // The exact transient class #210 observed (glm-5.3-flash 3/5): the
      // SDK-retryable class. After maxRetries: 1 is exhausted the SDK
      // rethrows a RetryError naming the attempts; the classifier digs the
      // wrapped APICallError out of the chain — a STRUCTURED signal.
      doGenerate: async () => {
        throw transient;
      },
    });
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-'));
    try {
      const driver = new AiSdkDriver({
        providers: { mock: () => timeoutModel },
        sessionsDir: join(scratchDir, 'sessions'),
      });
      const result = await driver.run(invocation());
      expect(result.stopReason).toBe('error');
      // ADR-0002 §2.2: errorClass on every error verdict; the error text is
      // bounded human diagnostics (the [token] prefix contract is retired).
      expect(result.errorClass).toBe('transient');
      expect(result.error?.startsWith('ai-sdk driver: run failed —')).toBe(true);
      expect(result.error).toContain('Cannot connect to API: Headers Timeout Error');
      expect(result.structuredOutput).toBeUndefined();
      expect(result.providerSignals).toBeUndefined(); // no headers on this error
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('an UNSTRUCTURED endpoint failure classifies unknown — never a guessed transient', async () => {
    const timeoutModel = new MockLanguageModelV4({
      modelId: 'mock-1',
      doGenerate: async () => {
        throw new Error('Cannot connect to API: Headers Timeout Error');
      },
    });
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-'));
    try {
      const driver = new AiSdkDriver({
        providers: { mock: () => timeoutModel },
        sessionsDir: join(scratchDir, 'sessions'),
      });
      const result = await driver.run(invocation());
      expect(result.stopReason).toBe('error');
      // A plain Error carries no status, no provider code, no SDK class:
      // the structured-only rule leaves it 'unknown' (ADR §2.2 — anything
      // unresolved is unknown, never guessed into 'transient').
      expect(result.errorClass).toBe('unknown');
      expect(result.error?.startsWith('ai-sdk driver: run failed —')).toBe(true);
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('a RETRYABLE endpoint timeout is retried once, then classified transient (#210)', async () => {
    // The SDK's own retry machinery classifies this APICallError retryable:
    // attempt 1 fails, the SDK backs off, attempt 2 fails, and the exhausted
    // retry throws a RetryError naming the attempt count and the last error.
    const retryable = new APICallError({
      message: 'Cannot connect to API: Headers Timeout Error',
      url: 'https://example.test',
      requestBodyValues: {},
      isRetryable: true,
    });
    let calls = 0;
    const retryableModel = new MockLanguageModelV4({
      modelId: 'mock-1',
      doGenerate: async () => {
        calls += 1;
        throw retryable;
      },
    });
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-'));
    try {
      const driver = new AiSdkDriver({
        providers: { mock: () => retryableModel },
        sessionsDir: join(scratchDir, 'sessions'),
      });
      const result = await driver.run(invocation());
      expect(calls).toBe(2); // maxRetries: 1 really retried the transient class
      expect(result.stopReason).toBe('error');
      expect(result.errorClass).toBe('transient');
      expect(result.error).toContain('Failed after 2 attempts');
      expect(result.error).toContain('Headers Timeout Error');
      expect(result.structuredOutput).toBeUndefined();
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  }, 15_000);

  test('a governed abort that leaves the final step on tool-calls settles aborted, not a miss (#210)', async () => {
    // Deterministic governed-context mechanics: an injected clock CAPTURES the
    // ladder's rung-1 callback WITHOUT arming a real timer, so the mock model
    // fires the abort synchronously on its single step. The token cap then ends
    // the loop on that tool-call step (no next iteration re-checks the signal),
    // generateText resolves, result.output throws, and stopReasonOf sees
    // `aborted` FIRST — the INNER miss catch's carve-out, not the outer catch
    // (which the conformance abort test already covers).
    let fireGovernedSignal: (() => void) | undefined;
    const manualClock: Clock = {
      now: () => 0,
      setTimeout: (fn) => {
        fireGovernedSignal ??= fn; // rung 1 only; rungs 2/3 never arm
        return 0;
      },
      clearTimeout: () => {},
    };
    const toolCallThenAbort = new MockLanguageModelV4({
      modelId: 'mock-1',
      doGenerate: async () => {
        fireGovernedSignal?.();
        return toolCallResult('read', { path: 'absent.txt' });
      },
    });
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-'));
    try {
      const driver = new AiSdkDriver({
        providers: { mock: () => toolCallThenAbort },
        sessionsDir: join(scratchDir, 'sessions'),
        // A priced model DISCRIMINATES the inner carve-out (full-result usage +
        // derived cost) from the outer catch (partial fold, never fabricated
        // cost) — so the test proves the branch, not just the verdict.
        pricing: () => ({ input: 3, output: 15 }),
      });
      const outcome = await runLadder(
        async (ctx) =>
          driver.run(
            invocation({
              toolPolicy: { allow: ['read'], mode: 'allowlist' },
              budget: { maxTokens: 1 },
              outputSchema: toOutputSchema(
                'test/abort-priced/v1',
                z.object({ fixed: z.boolean(), notes: z.string() }).strict(),
              ),
            }),
            { signal: ctx.signal },
          ),
        { wallClockMs: 1_000 },
        { op: 'ai-sdk-failure-class', jobKey: 'ai-sdk-failure-class', attempt: 1 },
        { clock: manualClock },
      );
      expect(outcome.outcome).toBe('completed');
      if (outcome.outcome !== 'completed') return; // narrow for TS
      expect(fireGovernedSignal).toBeDefined(); // the rung really was captured
      expect(outcome.value.stopReason).toBe('aborted');
      expect(outcome.value.steps).toBe(1); // the completed tool-call step is retained on abort
      expect(outcome.value.error).toBeUndefined();
      expect(outcome.value.structuredOutput).toBeUndefined();
      // The inner carve-out priced the FULL result usage — the outer catch
      // would have no costUSD (and no served model).
      expect(typeof outcome.value.costUSD).toBe('number');
      expect(outcome.value.costBasis).toBe('modeled');
      expect(outcome.value.model).toBe('mock-1');
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('an unstructured scripted failure classifies unknown (no structured signal — never guessed)', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-'));
    try {
      // An inline PLAIN Error (the conformance mock's fail now scripts the
      // vendor quota shape — this row pins the UNCLASSIFIED path): a plain
      // Error has no status/code/class, so the verdict stays 'unknown'.
      const driver = new AiSdkDriver({
        providers: {
          mock: () =>
            new MockLanguageModelV4({
              modelId: 'mock-1',
              doGenerate: async () => {
                throw new Error('scripted model failure');
              },
            }),
        },
        sessionsDir: join(scratchDir, 'sessions'),
      });
      const result = await driver.run(invocation());
      expect(result.stopReason).toBe('error');
      // PRODUCER RULE: the error verdict carries a class — an honest
      // 'unknown' (a plain scripted Error has no status/code/class).
      expect(result.errorClass).toBe('unknown');
      expect(result.error?.startsWith('ai-sdk driver: run failed —')).toBe(true);
      expect(result.error).toContain('scripted model failure');
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('a resolved run ending on finishReason error/content-filter carries a class too', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-'));
    try {
      const driver = new AiSdkDriver({
        providers: {
          mock: () =>
            new MockLanguageModelV4({
              modelId: 'mock-1',
              doGenerate: finishResult('error'),
            }),
        },
        sessionsDir: join(scratchDir, 'sessions'),
      });
      const result = await driver.run(invocation());
      expect(result.stopReason).toBe('error');
      expect(result.errorClass).toBe('unknown'); // no structured cause — never guessed
      expect(result.error).toContain("finishReason 'error'");

      // A content filter is a provider-reported permanent refusal.
      const filtered = new AiSdkDriver({
        providers: {
          mock: () =>
            new MockLanguageModelV4({
              modelId: 'mock-1',
              doGenerate: finishResult('content-filter'),
            }),
        },
        sessionsDir: join(scratchDir, 'sessions'),
      });
      const filteredResult = await filtered.run(invocation());
      expect(filteredResult.stopReason).toBe('error');
      expect(filteredResult.errorClass).toBe('provider-error');
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  /** An APICallError fixture with only the structured fields a case needs. */
  function apiError(opts: {
    statusCode?: number;
    url?: string;
    headers?: Record<string, string>;
    data?: unknown;
    responseBody?: string;
    isRetryable?: boolean;
    message?: string;
  }): APICallError {
    return new APICallError({
      message: opts.message ?? 'provider error',
      url: opts.url ?? 'https://provider.test/v1/messages',
      requestBodyValues: {},
      ...(opts.statusCode !== undefined ? { statusCode: opts.statusCode } : {}),
      ...(opts.headers !== undefined ? { responseHeaders: opts.headers } : {}),
      ...(opts.data !== undefined ? { data: opts.data } : {}),
      ...(opts.responseBody !== undefined ? { responseBody: opts.responseBody } : {}),
      isRetryable: opts.isRetryable ?? false,
    });
  }

  test('classifyRunFailure: the ADR §2.2 limit cuts, structured signals only', () => {
    // ---- cut 3: 401/403 → auth.
    expect(classifyRunFailure(apiError({ statusCode: 401 }))).toBe('auth');
    expect(classifyRunFailure(apiError({ statusCode: 403 }))).toBe('auth');

    // ---- cut 2: funded-allowance codes are quota WHATEVER the status —
    // even on a 429 that also carries a retry-after (code outranks).
    expect(
      classifyRunFailure(
        apiError({
          statusCode: 429,
          data: { error: { code: 'insufficient_quota' } },
          headers: { 'retry-after': '10' },
        }),
      ),
    ).toBe('quota');
    expect(
      classifyRunFailure(
        apiError({ statusCode: 429, data: { error: { code: 'credit_balance_exhausted' } } }),
      ),
    ).toBe('quota');
    expect(
      classifyRunFailure(
        apiError({ statusCode: 429, data: { code: 'enforced_spend_limit_reached' } }),
      ),
    ).toBe('quota');
    expect(
      classifyRunFailure(
        apiError({ statusCode: 429, data: { error: { code: 'deepseek_spend_limit_exceeded' } } }),
      ),
    ).toBe('quota');
    // The code also wins when it only rides the JSON response body.
    expect(
      classifyRunFailure(
        apiError({ statusCode: 429, responseBody: '{"error":{"code":"insufficient_quota"}}' }),
      ),
    ).toBe('quota');
    // HTTP 402 → quota (DeepSeek / OpenCode Zen funded balance).
    expect(classifyRunFailure(apiError({ statusCode: 402 }))).toBe('quota');
    // The Z.AI coding wire's 429 is the plan-funded quota wall (URL signal).
    expect(
      classifyRunFailure(
        apiError({ statusCode: 429, url: 'https://api.z.ai/api/coding/paas/v4/chat/completions' }),
      ),
    ).toBe('quota');

    // ---- cut 4: the 429 discrimination — quota vs rate-limit.
    // Another 429 WITH retry-after → rate-limit.
    expect(
      classifyRunFailure(apiError({ statusCode: 429, headers: { 'Retry-After': '3741' } })),
    ).toBe('rate-limit');
    // A 429 whose retry-after exists ELSEWHERE in the wrapped chain.
    const inner429 = apiError({ statusCode: 429, headers: { 'retry-after': '5' } });
    const retryWrapper = Object.assign(new Error('Failed after 2 attempts. Last error: 429'), {
      cause: inner429,
    });
    expect(classifyRunFailure(retryWrapper)).toBe('rate-limit');
    // A bare 429 with NO retry-after anywhere and no funded code: not a
    // throttle claim — 'provider-error'.
    expect(classifyRunFailure(apiError({ statusCode: 429 }))).toBe('provider-error');

    // ---- cut 5: 408/5xx → transient.
    expect(classifyRunFailure(apiError({ statusCode: 408 }))).toBe('transient');
    expect(classifyRunFailure(apiError({ statusCode: 500 }))).toBe('transient');
    expect(classifyRunFailure(apiError({ statusCode: 503 }))).toBe('transient');
    expect(classifyRunFailure(apiError({ statusCode: 529 }))).toBe('transient');

    // ---- cut 6: SDK class signals without a status.
    // The SDK's retryable class (network / endpoint header timeout).
    expect(classifyRunFailure(apiError({ isRetryable: true }))).toBe('transient');
    // The step-timeout DOMException.
    expect(
      classifyRunFailure(
        Object.assign(new Error('Step timeout of 120000ms exceeded'), { name: 'TimeoutError' }),
      ),
    ).toBe('transient');

    // ---- permanent provider failures.
    expect(classifyRunFailure(apiError({ statusCode: 400 }))).toBe('provider-error');
    expect(classifyRunFailure(apiError({ statusCode: 404 }))).toBe('provider-error');
    expect(classifyRunFailure(apiError({}))).toBe('provider-error');

    // ---- anything unresolved → 'unknown', NEVER a guessed 'transient'.
    // (The old unanchored \b(408|409|429|5\d\d)\b message regex is deleted:
    // a status number embedded in prose is not a status code.)
    expect(classifyRunFailure(new Error('request failed with 429 somewhere'))).toBe('unknown');
    expect(classifyRunFailure(new Error('connect ETIMEDOUT 1.2.3.4:443'))).toBe('unknown');
    expect(classifyRunFailure(new Error('read ECONNRESET'))).toBe('unknown');
    expect(classifyRunFailure(new Error('socket hang up'))).toBe('unknown');
    expect(classifyRunFailure(new Error('fetch failed'))).toBe('unknown');
    expect(classifyRunFailure(new Error('Step timeout of 120000ms exceeded'))).toBe('unknown');
    expect(classifyRunFailure(new Error('op prompt is over budget'))).toBe('unknown');
    expect(classifyRunFailure('a plain string failure')).toBe('unknown');
    // A bare abort never reaches this classifier (the catch short-circuits
    // to 'aborted'), so it stays unresolved here — 'unknown'.
    expect(classifyRunFailure(new Error('Request was aborted'))).toBe('unknown');
  });

  test('providerSignalsFromHeaders maps the recognized limit-header families, only what is present', () => {
    // The claude unified plan windows: percent-REMAINING → used fraction.
    const unified = providerSignalsFromHeaders({
      'anthropic-ratelimit-unified-5h-percent-remaining': '12.5',
      'anthropic-ratelimit-unified-5h-reset': '2026-09-28T12:00:00Z',
      'anthropic-ratelimit-unified-7d-percent-remaining': '80',
    });
    expect(unified?.windows).toHaveLength(2);
    const fiveHour = unified?.windows?.find((w) => w.id === '5h');
    expect(fiveHour?.utilization).toBeCloseTo(0.875, 12);
    expect(fiveHour?.resetAt).toBe('2026-09-28T12:00:00.000Z');
    const sevenDay = unified?.windows?.find((w) => w.id === '7d');
    expect(sevenDay?.utilization).toBeCloseTo(0.2, 12);
    expect(sevenDay?.resetAt).toBeUndefined();
    // The per-minute API family: remaining/limit counts → utilization.
    const perMinute = providerSignalsFromHeaders({
      'x-ratelimit-limit-requests': '100',
      'x-ratelimit-remaining-requests': '45',
      'x-ratelimit-reset-requests': '6m0s',
      'x-ratelimit-limit-tokens': '10000',
      'x-ratelimit-remaining-tokens': '9000',
      'x-ratelimit-reset-tokens': '1s',
    });
    const perMinuteWindows = perMinute?.windows ?? [];
    expect(perMinuteWindows).toHaveLength(2);
    const requestsWindow = perMinuteWindows.find((w) => w.id === 'requests');
    expect(requestsWindow?.utilization).toBeCloseTo(0.55, 12);
    expect(requestsWindow?.remaining).toEqual({ requests: 45 });
    expect(requestsWindow?.resetAt).toBeDefined(); // derived from the 6m0s duration
    expect(typeof requestsWindow?.resetAt).toBe('string');
    const tokensWindow = perMinuteWindows.find((w) => w.id === 'tokens');
    expect(tokensWindow?.utilization).toBeCloseTo(0.1, 12);
    expect(tokensWindow?.remaining).toEqual({ tokens: 9000 });
    // retry-after (delay-seconds form) joins the windows.
    const withRetry = providerSignalsFromHeaders({
      'retry-after': '3741',
      'x-ratelimit-remaining-tokens': '1',
    });
    expect(withRetry?.retryAfterMs).toBe(3_741_000);
    // A remaining COUNT is a nonnegative integer: malformed header values
    // are dropped, never recorded as fabricated quota evidence (PR #238
    // review round 2 — the mirror now rejects fractional/negative counts).
    const malformed = providerSignalsFromHeaders({
      'x-ratelimit-remaining-requests': '45.5',
      'x-ratelimit-remaining-tokens': '-3',
    });
    expect(malformed?.windows).toBeUndefined();
    const zeroCount = providerSignalsFromHeaders({ 'x-ratelimit-remaining-requests': '0' });
    expect(zeroCount?.windows?.[0]?.remaining).toEqual({ requests: 0 });
    // Case-insensitive header names.
    expect(providerSignalsFromHeaders({ 'RETRY-AFTER': '2' })?.retryAfterMs).toBe(2000);
    // HTTP-date form parses against the current clock.
    const httpDate = providerSignalsFromHeaders({
      'retry-after': new Date(Date.now() + 60_000).toUTCString(),
    });
    expect(httpDate?.retryAfterMs).toBeGreaterThan(0);
    expect(httpDate?.retryAfterMs).toBeLessThanOrEqual(60_000);
    // Nothing recognized → absent; never invented.
    expect(providerSignalsFromHeaders({ 'x-request-id': 'abc' })).toBeUndefined();
    expect(providerSignalsFromHeaders(undefined)).toBeUndefined();
    // An ambiguous bare-digit reset value is NOT guessed into a resetAt.
    const ambiguous = providerSignalsFromHeaders({
      'anthropic-ratelimit-unified-5h-reset': '3741',
    });
    expect(ambiguous?.windows?.[0]?.resetAt).toBeUndefined();
  });

  test('providerSignalsFromError digs the APICallError headers out of a wrapped chain', () => {
    const inner = new APICallError({
      message: 'Too Many Requests',
      url: 'https://provider.test/v1/messages',
      requestBodyValues: {},
      statusCode: 429,
      responseHeaders: {
        'retry-after': '30',
        'anthropic-ratelimit-unified-5h-percent-remaining': '0',
        'anthropic-ratelimit-unified-5h-reset': '2026-09-28T12:00:00Z',
      },
    });
    const wrapped = Object.assign(new Error('Failed after 2 attempts. Last error: 429'), {
      cause: inner,
    });
    expect(providerSignalsFromError(wrapped)).toEqual({
      retryAfterMs: 30_000,
      windows: [{ id: '5h', utilization: 1, resetAt: '2026-09-28T12:00:00.000Z' }],
    });
    expect(providerSignalsFromError(new Error('no structure'))).toBeUndefined();
  });
});
