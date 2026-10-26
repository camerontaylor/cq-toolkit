import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { DriverFactory, DriverRequest, ResolvedDriver } from '../../../src/driver/factory.js';
import { runAgentReviewer } from '../../../src/ops/review/agentReviewer.js';
import type { AgentReviewerInput } from '../../../src/ops/review/agentReviewer.js';
import type { Driver, OpInvocation, RunOptions, WorkerResult } from '../../../src/driver/types.js';
import { runLadder } from '../../../src/kernel/governor.js';
import type { DiffSecretScanner } from '../../../src/ops/dev/denylist.js';

const usage = { input: 2, output: 3, cacheRead: 1, cacheWrite: 0 } as const;
const cleanScan: DiffSecretScanner = (components) =>
  components.map(({ component }) => ({ component, hits: [] }));
const smallComponent = {
  component: 'tracked:src/a.ts',
  path: 'src/a.ts',
  text: 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old()\n+new()\n',
};

function reviewerInput(overrides: Partial<AgentReviewerInput> = {}): AgentReviewerInput {
  return {
    repoRoot: '/fixture/repo',
    head: 'a'.repeat(40),
    base: 'b'.repeat(40),
    branch: 'review-fixture',
    scope: 'full',
    diff: smallComponent.text,
    components: [smallComponent],
    intent: 'The refactor preserves behavior.',
    fileList: 'src/a.ts',
    role: { provider: 'mock', model: 'review-model' },
    maxTokens: 500,
    wallMs: 10_000,
    scanSecrets: cleanScan,
    severityMap: { high: 'major', medium: 'minor' },
    ...overrides,
  };
}

function workerResult(overrides: Partial<WorkerResult> = {}): WorkerResult {
  return {
    stopReason: 'complete',
    structuredOutput: {
      findings: [{ file: 'src/a.ts', line: 2, rule: 'bug', severity: 'high', text: 'Evidence' }],
    },
    usage: { ...usage },
    steps: 1,
    denials: [],
    ...overrides,
  };
}

type FakeDriverOptions = {
  lane?: ResolvedDriver['lane'];
  result?: WorkerResult;
  /** Skip the pre-upload hook, to prove model output alone is not delivery evidence. */
  skipHook?: boolean;
  /** Override the serialized or decoded request sent to the captured hook. */
  hookPrompt?: string;
  run?: (invocation: OpInvocation, options?: RunOptions) => Promise<WorkerResult>;
};

function fakeDrivers(options: FakeDriverOptions = {}) {
  const requests: DriverRequest[] = [];
  const invocations: OpInvocation[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  const run: Driver['run'] = vi.fn(async (invocation: OpInvocation, runOptions?: RunOptions) => {
    invocations.push(invocation);
    signals.push(runOptions?.signal);
    const request = requests.at(-1)!;
    const hookPrompt = options.hookPrompt ?? invocation.prompt;
    if (!options.skipHook) {
      const serialized = JSON.stringify({
        prompt: [{ role: 'user', content: [{ type: 'text', text: hookPrompt }] }],
      });
      await request.beforeRequest?.(serialized, [{ text: hookPrompt }], { kind: 'model-request' });
    }
    return options.run ? options.run(invocation, runOptions) : (options.result ?? workerResult());
  });
  const resolveDriver = vi.fn((request: DriverRequest): ResolvedDriver => {
    requests.push(request);
    return {
      driver: { run },
      lane: options.lane ?? 'ai-sdk',
      modelSpec: request.modelSpec,
    };
  });
  const drivers: DriverFactory = { resolve: resolveDriver };
  return { drivers, requests, invocations, signals, run, resolveDriver };
}

describe('runAgentReviewer v3 session engine', () => {
  it('runs one read-only, tool-aware session with prompt-hook delivery evidence and v3 output', async () => {
    const fake = fakeDrivers();
    const result = await runAgentReviewer(fake.drivers, reviewerInput());

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error(JSON.stringify(result));
    expect(result.value.findings).toMatchObject([
      { source: 'agent', severity: 'major', file: 'src/a.ts', line: 2, rule: 'bug' },
    ]);
    expect(result.value.coverage).toMatchObject({
      version: 2,
      mode: 'session',
      pieces: [
        {
          component: smallComponent.component,
          state: 'completed',
          chars: smallComponent.text.length,
        },
      ],
      sessions: [
        {
          status: 'complete',
          steps: 1,
          deliveries: [
            {
              component: smallComponent.component,
              start: 0,
              end: smallComponent.text.length,
            },
          ],
          requests: [
            {
              serializedChars: expect.any(Number) as unknown,
              decodedChars: expect.any(Number) as unknown,
            },
          ],
        },
      ],
    });
    expect(fake.invocations).toHaveLength(1);
    const invocation = fake.invocations[0]!;
    expect(invocation.toolPolicy).toEqual({
      mode: 'allowlist',
      allow: ['read', 'grep', 'glob'],
    });
    expect(invocation.sandboxPolicy).toEqual({ level: 'read-only' });
    expect(invocation.workspace).toEqual({ path: resolve('/fixture/repo') });
    expect(invocation.budget).toEqual({ maxTokens: 500, maxSteps: 15 });
    expect(invocation.outputSchema).toMatchObject({ name: 'review.agent/v3' });
    expect(invocation.prompt).toContain(smallComponent.text);
    expect(invocation.prompt).not.toContain('receipt:');
    expect(fake.requests[0]?.role).toBe('reviewer');
    expect(fake.requests[0]?.beforeRequest).toBeTypeOf('function');
  });

  it('keeps read available when search is disabled and disables mutation descriptors', async () => {
    const fake = fakeDrivers();
    const result = await runAgentReviewer(fake.drivers, reviewerInput({ searchTools: false }));
    expect(result.status).toBe('ok');
    expect(fake.invocations[0]?.toolPolicy).toEqual({ mode: 'allowlist', allow: ['read'] });
    expect(fake.requests[0]?.harness?.tools).toMatchObject({
      read: { enabled: true },
      edit: { enabled: false },
      write: { enabled: false },
      bash: { enabled: false },
    });
  });

  it('maps unmapped low severity to minor and omits missing location fields', async () => {
    const fake = fakeDrivers({
      result: workerResult({
        structuredOutput: { findings: [{ severity: 'low', text: 'Evidence without a location' }] },
      }),
    });
    const result = await runAgentReviewer(fake.drivers, reviewerInput());
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.value.findings[0]).toMatchObject({
      severity: 'minor',
      text: 'Evidence without a location',
      status: 'open',
    });
    expect(result.value.findings[0]).not.toHaveProperty('file');
    expect(result.value.findings[0]).not.toHaveProperty('line');
    expect(result.value.findings[0]).not.toHaveProperty('rule');
  });

  it('reports actual driver usage and cost to the active governor', async () => {
    const fake = fakeDrivers({ result: workerResult({ costUSD: 0.012 }) });
    const reports: { usage?: unknown; costUSD?: number }[] = [];
    await runLadder(
      () => runAgentReviewer(fake.drivers, reviewerInput()),
      { wallClockMs: 1_000 },
      { op: 'review.run', jobKey: 'review-spend', attempt: 1 },
      { onResult: (value) => reports.push(value) },
    );
    expect(reports).toEqual([{ usage, costUSD: 0.012 }]);
  });

  it('refuses a non-ai-sdk lane because it cannot attest pre-upload scanning', async () => {
    const fake = fakeDrivers({ lane: 'acp' });
    const result = await runAgentReviewer(fake.drivers, reviewerInput());
    expect(result).toMatchObject({
      status: 'needs-human',
      reason: expect.stringContaining(
        'agent review requires the ai-sdk pre-upload scan lane',
      ) as unknown,
    });
    expect(fake.run).not.toHaveBeenCalled();
  });

  it('maps dispatch and driver errors to needs-human with bounded detail (#484)', async () => {
    const noRole: DriverFactory = {
      resolve: () => {
        throw new Error('no reviewer role');
      },
    };
    expect(await runAgentReviewer(noRole, reviewerInput())).toMatchObject({
      status: 'needs-human',
      reason: expect.stringContaining('agent review did not run: no reviewer role') as unknown,
    });

    const detail =
      'ai-sdk driver: structured output invalid after repair: model emitted tool-call markup instead of JSON';
    const fake = fakeDrivers({ result: workerResult({ stopReason: 'error', error: detail }) });
    const failed = await runAgentReviewer(fake.drivers, reviewerInput());
    expect(failed).toMatchObject({
      status: 'needs-human',
      reason: expect.stringContaining(
        `agent review did not complete (error): ${detail}`,
      ) as unknown,
      report: {
        coverage: {
          pieces: [{ state: 'delivered' }],
          sessions: [{ status: 'error' }],
        },
      },
    });
  });

  it('secret-redacts and bounds driver error details in the blocked reason (#484)', async () => {
    vi.stubEnv('CQ_REVIEW_FIXTURE_TOKEN', 'review-token-value');
    try {
      const fake = fakeDrivers({
        result: workerResult({
          stopReason: 'error',
          error: `upstream echoed review-token-value then ${'x'.repeat(600)}`,
        }),
      });
      const result = await runAgentReviewer(fake.drivers, reviewerInput());
      expect(result.status).toBe('needs-human');
      if (result.status !== 'needs-human') return;
      expect(result.reason).toContain('[redacted]');
      expect(result.reason).not.toContain('review-token-value');
      expect(result.reason).toContain('… [truncated]');
      expect(result.reason.length).toBeLessThan(800);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('blocks complete-looking output when structured output is malformed', async () => {
    const fake = fakeDrivers({
      result: workerResult({ structuredOutput: { unexpected: true } }),
    });
    const result = await runAgentReviewer(fake.drivers, reviewerInput());
    expect(result).toMatchObject({
      status: 'needs-human',
      reason: expect.stringContaining('agent review returned invalid structured output') as unknown,
      report: {
        coverage: {
          pieces: [{ state: 'delivered' }],
          sessions: [{ status: 'error' }],
        },
      },
    });
  });

  it('does not accept valid JSON without the beforeRequest delivery hook', async () => {
    const fake = fakeDrivers({ skipHook: true });
    const result = await runAgentReviewer(fake.drivers, reviewerInput());
    expect(result).toMatchObject({
      status: 'needs-human',
      reason: expect.stringContaining(
        'agent review completed without scanned content delivery',
      ) as unknown,
      report: {
        coverage: {
          pieces: [{ state: 'planned' }],
          sessions: [{ status: 'error', deliveries: [] }],
        },
      },
    });
  });

  it('does not count a hook request containing the wrong prompt as delivery', async () => {
    const fake = fakeDrivers({ hookPrompt: 'not the planned review request' });
    const result = await runAgentReviewer(fake.drivers, reviewerInput());
    expect(result).toMatchObject({
      status: 'needs-human',
      reason: expect.stringContaining(
        'agent review completed without scanned content delivery',
      ) as unknown,
      report: { coverage: { pieces: [{ state: 'planned' }] } },
    });
  });

  it('returns budget-exhausted before planning or driver resolution for zero allowance', async () => {
    const fake = fakeDrivers();
    expect((await runAgentReviewer(fake.drivers, reviewerInput({ maxTokens: 0 }))).status).toBe(
      'budget-exhausted',
    );
    expect(fake.resolveDriver).not.toHaveBeenCalled();
    expect(fake.run).not.toHaveBeenCalled();
  });

  it('does not dispatch when already cancelled', async () => {
    const controller = new AbortController();
    controller.abort(new Error('already cancelled'));
    const fake = fakeDrivers();
    const result = await runAgentReviewer(
      fake.drivers,
      reviewerInput({ signal: controller.signal }),
    );
    expect(result).toMatchObject({
      status: 'needs-human',
      reason: 'agent review cancelled before dispatch',
    });
    expect(fake.resolveDriver).not.toHaveBeenCalled();
    expect(fake.run).not.toHaveBeenCalled();
  });

  it('cancels an active driver at the wall deadline and keeps an immutable no-delivery snapshot', async () => {
    let receivedSignal: AbortSignal | undefined;
    const fake = fakeDrivers({
      skipHook: true,
      run: async (_invocation, options) => {
        receivedSignal = options?.signal;
        return new Promise<WorkerResult>(() => undefined);
      },
    });
    const result = await runAgentReviewer(fake.drivers, reviewerInput({ wallMs: 20 }));
    expect(result.status).toBe('needs-human');
    expect(receivedSignal?.aborted).toBe(true);
    expect(result).toMatchObject({
      report: { coverage: { pieces: [{ state: 'planned' }], sessions: [{ status: 'aborted' }] } },
    });
  });

  it('relays parent job cancellation to the active driver', async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const fake = fakeDrivers({
      skipHook: true,
      run: async (_invocation, options) => {
        receivedSignal = options?.signal;
        controller.abort(new Error('parent cancelled'));
        return new Promise<WorkerResult>(() => undefined);
      },
    });
    const outcome = await runLadder(
      () => runAgentReviewer(fake.drivers, reviewerInput({ signal: controller.signal })),
      { wallClockMs: 1_000, abortGraceMs: 50, killGraceMs: 50 },
      { op: 'review.run', jobKey: 'review-cancel', attempt: 1 },
    );
    expect(outcome.outcome).toBe('completed');
    if (outcome.outcome === 'completed') expect(outcome.value.status).toBe('needs-human');
    expect(receivedSignal?.aborted).toBe(true);
  });
});
