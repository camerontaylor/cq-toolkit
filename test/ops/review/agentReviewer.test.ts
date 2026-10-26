import { describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import type { DriverFactory } from '../../../src/driver/factory.js';
import { runAgentReviewer as runReview } from '../../../src/ops/review/agentReviewer.js';
import { runLadder } from '../../../src/kernel/governor.js';

// Existing policy fixtures emulate a compliant structured reviewer; receipt failure
// and real wire behavior are exercised separately in agentReviewer-partitions.test.ts.
const runAgentReviewer: typeof runReview = (drivers, input) =>
  runReview(
    {
      resolve: (request) => {
        const resolved = drivers.resolve(request);
        return {
          ...resolved,
          driver: {
            ...resolved.driver,
            run: async (invocation, options) => {
              const result = await resolved.driver.run(invocation, options);
              if (
                result.structuredOutput &&
                typeof result.structuredOutput === 'object' &&
                'findings' in result.structuredOutput
              )
                return {
                  ...result,
                  structuredOutput: {
                    ...result.structuredOutput,
                    receipt: /receipt: ([a-f0-9]+)/.exec(invocation.prompt)?.[1],
                  },
                };
              return result;
            },
          },
        };
      },
    } as DriverFactory,
    input,
  );
const cleanScan = (components: readonly { component: string }[]) =>
  components.map(({ component }) => ({ component, hits: [] }));

describe('runAgentReviewer', () => {
  it('uses a read-only structured invocation and applies cq.json severity mapping', async () => {
    const run = vi.fn(
      async (invocation: {
        toolPolicy: { mode?: string };
        sandboxPolicy: { level: string };
        workspace: { path: string };
        outputSchema?: unknown;
      }) => {
        expect(invocation.toolPolicy).toEqual({ mode: 'none', allow: [] });
        expect(invocation.sandboxPolicy.level).toBe('read-only');
        expect(invocation.workspace.path).toBe(resolve('.'));
        expect(invocation.outputSchema).toBeDefined();
        return {
          stopReason: 'complete' as const,
          structuredOutput: {
            findings: [
              { file: 'src/a.ts', line: 2, rule: 'bug', severity: 'high', text: 'Evidence' },
            ],
          },
          usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0 },
          denials: [],
        };
      },
    );
    const drivers = {
      resolve: vi.fn(() => ({
        driver: { run },
        lane: 'ai-sdk',
        modelSpec: { provider: 'mock', model: 'mock' },
      })),
    } as unknown as DriverFactory;
    const result = await runAgentReviewer(drivers, {
      repoRoot: '.',
      branch: 'review-fixture',
      head: 'abc123',
      scanSecrets: cleanScan,
      diff: 'diff',
      role: { provider: 'mock', model: 'mock' },
      maxTokens: 500,
      wallMs: 1000,
      severityMap: { high: 'major', medium: 'minor' },
    });
    expect(result.status).toBe('ok');
    if (result.status === 'ok') expect(result.value.findings[0]?.severity).toBe('major');
  });

  it('uses the minor fallback for unmapped severities and omits absent location fields', async () => {
    const drivers = {
      resolve: vi.fn(() => ({
        driver: {
          run: vi.fn(async () => ({
            stopReason: 'complete' as const,
            structuredOutput: {
              findings: [{ severity: 'low', text: 'Evidence without a location' }],
            },
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
            denials: [],
          })),
        },
        lane: 'ai-sdk',
        modelSpec: { provider: 'mock', model: 'mock' },
      })),
    } as unknown as DriverFactory;
    const result = await runAgentReviewer(drivers, {
      repoRoot: '/fixture',
      branch: 'review-fixture',
      head: 'abc123',
      scanSecrets: cleanScan,
      diff: '',
      role: { provider: 'mock', model: 'mock' },
      maxTokens: 500,
      wallMs: 1000,
      severityMap: { high: 'major', medium: 'minor' },
    });
    expect(result).toMatchObject({
      status: 'ok',
      value: {
        findings: [
          {
            severity: 'minor',
            text: 'Evidence without a location',
            status: 'open',
          },
        ],
      },
    });
    if (result.status === 'ok') {
      expect(result.value.findings[0]).not.toHaveProperty('file');
      expect(result.value.findings[0]).not.toHaveProperty('line');
      expect(result.value.findings[0]).not.toHaveProperty('rule');
    }
  });

  it('reports driver usage and cost to the active governor before mapping the result', async () => {
    const drivers = {
      resolve: vi.fn(() => ({
        driver: {
          run: vi.fn(async () => ({
            stopReason: 'complete' as const,
            structuredOutput: { findings: [] },
            usage: { input: 7, output: 3, cacheRead: 1, cacheWrite: 0 },
            costUSD: 0.012,
            denials: [],
          })),
        },
        lane: 'ai-sdk',
        modelSpec: { provider: 'mock', model: 'mock' },
      })),
    } as unknown as DriverFactory;
    const reports: { usage?: unknown; costUSD?: number }[] = [];
    await runLadder(
      () =>
        runAgentReviewer(drivers, {
          repoRoot: '/fixture',
          branch: 'review-fixture',
          head: 'abc123',
          scanSecrets: cleanScan,
          diff: '',
          role: { provider: 'mock', model: 'mock' },
          maxTokens: 500,
          wallMs: 1000,
          severityMap: { high: 'major', medium: 'minor' },
        }),
      { wallClockMs: 1000 },
      { op: 'review.run', jobKey: 'review-spend', attempt: 1 },
      { onResult: (value) => reports.push(value) },
    );
    expect(reports).toEqual([
      {
        usage: { input: 7, output: 3, cacheRead: 1, cacheWrite: 0 },
        costUSD: 0.012,
      },
    ]);
  });

  it('maps a reviewer dispatch error to needs-human', async () => {
    const drivers = {
      resolve: vi.fn(() => {
        throw new Error('no reviewer role');
      }),
    } as unknown as DriverFactory;
    const result = await runAgentReviewer(drivers, {
      repoRoot: '/fixture',
      branch: 'review-fixture',
      head: 'abc123',
      scanSecrets: cleanScan,
      diff: '',
      role: { provider: 'mock', model: 'mock' },
      maxTokens: 500,
      wallMs: 1000,
      severityMap: { high: 'major', medium: 'minor' },
    });
    expect(result).toMatchObject({
      status: 'needs-human',
      reason: 'agent review could not dispatch: no reviewer role [partition 1/1: review.diff]',
    });
  });

  it('maps driver rejection to needs-human', async () => {
    const drivers = {
      resolve: vi.fn(() => ({
        driver: {
          run: vi.fn(async () => {
            throw new Error('provider unavailable');
          }),
        },
        lane: 'ai-sdk',
        modelSpec: { provider: 'mock', model: 'mock' },
      })),
    } as unknown as DriverFactory;
    const result = await runAgentReviewer(drivers, {
      repoRoot: '/fixture',
      branch: 'review-fixture',
      head: 'abc123',
      scanSecrets: cleanScan,
      diff: '',
      role: { provider: 'mock', model: 'mock' },
      maxTokens: 500,
      wallMs: 1000,
      severityMap: { high: 'major', medium: 'minor' },
    });
    expect(result).toMatchObject({
      status: 'needs-human',
      reason: 'agent review did not run: provider unavailable [partition 1/1: review.diff]',
    });
  });

  it('normalizes a non-Error driver rejection', async () => {
    const drivers = {
      resolve: vi.fn(() => ({
        driver: {
          run: vi.fn(async () => Promise.reject('scripted rejection')),
        },
        lane: 'ai-sdk',
        modelSpec: { provider: 'mock', model: 'mock' },
      })),
    } as unknown as DriverFactory;
    const result = await runAgentReviewer(drivers, {
      repoRoot: '/fixture',
      branch: 'review-fixture',
      head: 'abc123',
      scanSecrets: cleanScan,
      diff: '',
      role: { provider: 'mock', model: 'mock' },
      maxTokens: 500,
      wallMs: 1000,
      severityMap: { high: 'major', medium: 'minor' },
    });
    expect(result).toMatchObject({
      status: 'needs-human',
      reason: 'agent review did not run: scripted rejection [partition 1/1: review.diff]',
    });
  });

  it.each([
    ['budget', 'budget-exhausted'],
    ['aborted', 'needs-human'],
    ['error', 'needs-human'],
  ] as const)('maps stop reason %s', async (stopReason, expected) => {
    const drivers = {
      resolve: vi.fn(() => ({
        driver: {
          run: vi.fn(async () => ({
            stopReason,
            structuredOutput: {},
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            denials: [],
          })),
        },
        lane: 'ai-sdk',
        modelSpec: { provider: 'mock', model: 'mock' },
      })),
    } as unknown as DriverFactory;
    const result = await runAgentReviewer(drivers, {
      repoRoot: '/fixture',
      branch: 'review-fixture',
      head: 'abc123',
      scanSecrets: cleanScan,
      diff: '',
      role: { provider: 'mock', model: 'mock' },
      maxTokens: 500,
      wallMs: 1000,
      severityMap: { high: 'major', medium: 'minor' },
    });
    expect(result.status).toBe(expected);
  });

  it('rejects invalid structured output', async () => {
    const drivers = {
      resolve: vi.fn(() => ({
        driver: {
          run: vi.fn(async () => ({
            stopReason: 'complete',
            structuredOutput: { unexpected: true },
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            denials: [],
          })),
        },
        lane: 'ai-sdk',
        modelSpec: { provider: 'mock', model: 'mock' },
      })),
    } as unknown as DriverFactory;
    const result = await runAgentReviewer(drivers, {
      repoRoot: '/fixture',
      branch: 'review-fixture',
      head: 'abc123',
      scanSecrets: cleanScan,
      diff: '',
      role: { provider: 'mock', model: 'mock' },
      maxTokens: 500,
      wallMs: 1000,
      severityMap: { high: 'major', medium: 'minor' },
    });
    expect(result).toMatchObject({
      status: 'failed',
      error: 'agent review returned invalid structured output [partition 1/1: review.diff]',
    });
  });

  it('aborts the driver and returns needs-human at the configured wall deadline', async () => {
    let signal: AbortSignal | undefined;
    const drivers = {
      resolve: vi.fn(() => ({
        driver: {
          run: vi.fn(async (_invocation: unknown, options: { signal: AbortSignal }) => {
            signal = options.signal;
            return new Promise<never>(() => undefined);
          }),
        },
        lane: 'ai-sdk',
        modelSpec: { provider: 'mock', model: 'mock' },
      })),
    } as unknown as DriverFactory;
    const result = await runAgentReviewer(drivers, {
      repoRoot: '/fixture',
      branch: 'review-fixture',
      head: 'abc123',
      scanSecrets: cleanScan,
      diff: '',
      role: { provider: 'mock', model: 'mock' },
      maxTokens: 500,
      wallMs: 5,
      severityMap: { high: 'major', medium: 'minor' },
    });
    expect(result.status).toBe('needs-human');
    expect(signal?.aborted).toBe(true);
  });

  it('relays parent job cancellation to the driver and settles needs-human', async () => {
    let signal: AbortSignal | undefined;
    const drivers = {
      resolve: vi.fn(() => ({
        driver: {
          run: vi.fn(async (_invocation: unknown, options: { signal: AbortSignal }) => {
            signal = options.signal;
            return new Promise<never>(() => undefined);
          }),
        },
        lane: 'ai-sdk',
        modelSpec: { provider: 'mock', model: 'mock' },
      })),
    } as unknown as DriverFactory;
    const outcome = await runLadder(
      () =>
        runAgentReviewer(drivers, {
          repoRoot: '/fixture',
          branch: 'review-fixture',
          head: 'abc123',
          scanSecrets: cleanScan,
          diff: '',
          role: { provider: 'mock', model: 'mock' },
          maxTokens: 500,
          wallMs: 10_000,
          severityMap: { high: 'major', medium: 'minor' },
        }),
      { wallClockMs: 5, abortGraceMs: 50, killGraceMs: 50 },
      { op: 'review.run', jobKey: 'review-cancel', attempt: 1 },
    );
    expect(outcome.outcome).toBe('completed');
    if (outcome.outcome === 'completed') expect(outcome.value.status).toBe('needs-human');
    expect(signal?.aborted).toBe(true);
  });
});

it.each(['entry', 'running'] as const)(
  'composition cancellation reaches read-only reviewer: %s',
  async (mode) => {
    const controller = new AbortController();
    let signal: AbortSignal | undefined;
    const run = vi.fn(async (_invocation: unknown, options: { signal: AbortSignal }) => {
      signal = options.signal;
      controller.abort(new Error('composition parent stopped'));
      return new Promise<never>(() => undefined);
    });
    const resolveDriver = vi.fn(() => ({
      driver: { run },
      lane: 'ai-sdk',
      modelSpec: { provider: 'mock', model: 'mock' },
    }));
    if (mode === 'entry') controller.abort(new Error('already cancelled'));
    const result = await runAgentReviewer({ resolve: resolveDriver } as unknown as DriverFactory, {
      repoRoot: '/fixture',
      branch: 'fixture',
      head: 'a'.repeat(40),
      scanSecrets: cleanScan,
      diff: '',
      role: { provider: 'mock', model: 'mock' },
      maxTokens: 500,
      wallMs: 10000,
      severityMap: { high: 'major', medium: 'minor' },
      signal: controller.signal,
    });
    expect(result.status).toBe('needs-human');
    expect(run).toHaveBeenCalledTimes(mode === 'entry' ? 0 : 1);
    if (mode === 'entry') expect(resolveDriver).not.toHaveBeenCalled();
    else expect(signal?.aborted).toBe(true);
  },
);

describe('runAgentReviewer per-request step bound', () => {
  const reviewWith = async (input: { stepWallMs?: number; wallMs: number }) => {
    const resolveDriver = vi.fn((_request: { stepTimeoutMs?: number }) => ({
      driver: {
        run: vi.fn(async () => ({
          stopReason: 'complete' as const,
          structuredOutput: { findings: [] },
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
          denials: [],
        })),
      },
      lane: 'ai-sdk',
      modelSpec: { provider: 'mock', model: 'mock' },
    }));
    const result = await runAgentReviewer({ resolve: resolveDriver } as unknown as DriverFactory, {
      repoRoot: '.',
      branch: 'review-fixture',
      head: 'abc123',
      scanSecrets: cleanScan,
      diff: 'diff',
      role: { provider: 'mock', model: 'mock' },
      maxTokens: 500,
      severityMap: { high: 'major', medium: 'minor' },
      ...input,
    });
    expect(result.status).toBe('ok');
    return resolveDriver.mock.calls.map(([request]) => request.stepTimeoutMs);
  };

  it('passes budgets.step.wallMs to the driver as stepTimeoutMs', async () => {
    expect(await reviewWith({ stepWallMs: 1_200_000, wallMs: 14_400_000 })).toEqual([1_200_000]);
  });

  it('caps the step bound at the remaining review wall time', async () => {
    const [stepTimeoutMs] = await reviewWith({ stepWallMs: 1_200_000, wallMs: 60_000 });
    expect(stepTimeoutMs).toBeGreaterThan(0);
    expect(stepTimeoutMs).toBeLessThanOrEqual(60_000);
  });

  it('leaves the driver default when no step budget is given', async () => {
    expect(await reviewWith({ wallMs: 60_000 })).toEqual([undefined]);
  });
});

describe('runAgentReviewer failure detail (#484)', () => {
  const reviewFailingSecond = async (failure: { errorClass?: string; error?: string }) => {
    let calls = 0;
    const drivers = {
      resolve: vi.fn(() => ({
        driver: {
          run: vi.fn(async () => {
            calls += 1;
            if (calls === 1)
              return {
                stopReason: 'complete' as const,
                structuredOutput: { findings: [] },
                usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
                denials: [],
              };
            return {
              stopReason: 'error' as const,
              ...failure,
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              denials: [],
            };
          }),
        },
        lane: 'ai-sdk',
        modelSpec: { provider: 'mock', model: 'mock' },
      })),
    } as unknown as DriverFactory;
    return runAgentReviewer(drivers, {
      repoRoot: '.',
      branch: 'review-fixture',
      head: 'abc123',
      scanSecrets: cleanScan,
      diff: 'diff',
      components: [
        { component: 'tracked:src/a.ts', path: 'src/a.ts', text: 'a change' },
        { component: 'tracked:test/b.test.ts', path: 'test/b.test.ts', text: 'b change' },
      ],
      role: { provider: 'mock', model: 'mock' },
      maxTokens: 500,
      wallMs: 60_000,
      severityMap: { high: 'major', medium: 'minor' },
    });
  };

  it('carries the driver errorClass, error text and failing partition into the reason', async () => {
    const result = await reviewFailingSecond({
      errorClass: 'transient',
      error: 'Step timeout of 1200000ms exceeded\n  at the provider',
    });
    expect(result.status).toBe('needs-human');
    if (result.status !== 'needs-human') return;
    expect(result.reason).toContain(
      'agent review did not complete (error: transient — Step timeout of 1200000ms exceeded at the provider)',
    );
    expect(result.reason).toContain('partition 2/2: test/b.test.ts');
    // The completed partition stays recorded; only the failing one is open.
    expect(result.report?.coverage.partitions.map((part) => part.complete)).toEqual([true, false]);
  });

  it('keeps the bare stop reason when the driver supplies no detail', async () => {
    const result = await reviewFailingSecond({});
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human')
      expect(result.reason).toBe(
        'agent review did not complete (error) [partition 2/2: test/b.test.ts]',
      );
  });

  it('names the partition in flight when the wall deadline stops the review', async () => {
    let calls = 0;
    const drivers = {
      resolve: vi.fn(() => ({
        driver: {
          run: vi.fn(async () => {
            calls += 1;
            if (calls > 1) return new Promise<never>(() => undefined);
            return {
              stopReason: 'complete' as const,
              structuredOutput: { findings: [] },
              usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
              denials: [],
            };
          }),
        },
        lane: 'ai-sdk',
        modelSpec: { provider: 'mock', model: 'mock' },
      })),
    } as unknown as DriverFactory;
    const result = await runAgentReviewer(drivers, {
      repoRoot: '.',
      branch: 'review-fixture',
      head: 'abc123',
      scanSecrets: cleanScan,
      diff: 'diff',
      components: [
        { component: 'tracked:src/a.ts', path: 'src/a.ts', text: 'a change' },
        { component: 'tracked:test/b.test.ts', path: 'test/b.test.ts', text: 'b change' },
      ],
      role: { provider: 'mock', model: 'mock' },
      maxTokens: 500,
      wallMs: 200,
      severityMap: { high: 'major', medium: 'minor' },
    });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') {
      expect(result.reason).toContain('wall');
      expect(result.reason).toMatch(/\[partition 2\/2: test\/b\.test\.ts\]$/);
    }
  });

  it('bounds an oversized driver error in the reason', async () => {
    const result = await reviewFailingSecond({ errorClass: 'unknown', error: 'x'.repeat(5_000) });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') expect(result.reason.length).toBeLessThan(800);
  });
});
