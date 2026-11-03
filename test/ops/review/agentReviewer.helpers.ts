// Split provenance: test/ops/review/agentReviewer.test.ts was split into the
// agentReviewer.*.test.ts siblings in this directory; the shared fixtures and
// fakes live here.
import { vi } from 'vitest';
import type { DriverFactory, DriverRequest, ResolvedDriver } from '../../../src/driver/factory.js';
import type { AgentReviewerInput } from '../../../src/ops/review/agentReviewer.js';
import type { Driver, OpInvocation, RunOptions, WorkerResult } from '../../../src/driver/types.js';
import type { DiffSecretScanner } from '../../../src/ops/dev/denylist.js';

export const usage = { input: 2, output: 3, cacheRead: 1, cacheWrite: 0 } as const;
export const cleanScan: DiffSecretScanner = (components) =>
  components.map(({ component }) => ({ component, hits: [] }));
export const smallComponent = {
  component: 'tracked:src/a.ts',
  path: 'src/a.ts',
  text: 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old()\n+new()\n',
};

export function reviewerInput(overrides: Partial<AgentReviewerInput> = {}): AgentReviewerInput {
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

export function workerResult(overrides: Partial<WorkerResult> = {}): WorkerResult {
  return {
    stopReason: 'complete',
    structuredOutput: {
      findings: [{ file: 'src/a.ts', line: 2, rule: 'bug', severity: 'high', text: 'Evidence' }],
    },
    usage: { ...usage },
    // Seam v3: the shared fixture models a provider MEASUREMENT; the provenance
    // tests override it to declare the placeholder/absent cases explicitly.
    usageProvenance: 'measured',
    steps: 1,
    denials: [],
    ...overrides,
  };
}

export type FakeDriverOptions = {
  lane?: ResolvedDriver['lane'];
  result?: WorkerResult;
  /** Skip the pre-upload hook, to prove model output alone is not delivery evidence. */
  skipHook?: boolean;
  /** Override the serialized or decoded request sent to the captured hook. */
  hookPrompt?: string;
  run?: (invocation: OpInvocation, options?: RunOptions) => Promise<WorkerResult>;
};

export function fakeDrivers(options: FakeDriverOptions = {}) {
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
