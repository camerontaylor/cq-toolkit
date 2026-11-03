// Split provenance: test/ops/review/agentReviewer-partitions.test.ts was split
// into agentReviewer-partitions.{session,coverage,scan,cancellation,preflight,
// budget,concurrency,failures,retries,exclusions,wire}.test.ts. This module
// carries the shared fixture surface verbatim from the original file; it
// declares no tests.
import type { DriverFactory, DriverRequest } from '../../../src/driver/factory.js';
import type { OpInvocation, WorkerResult } from '../../../src/driver/types.js';
import type { DiffSecretScanner } from '../../../src/ops/dev/denylist.js';
import type { AgentReviewerInput } from '../../../src/ops/review/agentReviewer.js';

export const usage = { input: 2, output: 3, cacheRead: 0, cacheWrite: 0 } as const;
export const clean: DiffSecretScanner = (components) =>
  components.map(({ component }) => ({ component, hits: [] }));
const header = '@@ -1 +1 @@\n';
export const small = {
  component: 'tracked:src/a.ts',
  path: 'src/a.ts',
  text: `diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n${header}-old()\n+new()\n`,
};
export const large =
  'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1,30000 @@\n' +
  '+ordinary 😀 line\n'.repeat(26_365);

type HookKind = 'model-request' | 'tool-output' | 'missing';
type FakeOptions = {
  scanner?: DiffSecretScanner;
  lane?: 'ai-sdk' | 'acp';
  skipHook?: boolean;
  hookKind?: HookKind;
  hookPrompt?: string;
  result?: (invocation: OpInvocation, call: number) => WorkerResult;
  onHook?: (request: DriverRequest, invocation: OpInvocation) => Promise<void>;
};

export function baseInput(overrides: Partial<AgentReviewerInput> = {}): AgentReviewerInput {
  return {
    repoRoot: '/fixture/repo',
    branch: 'feature',
    head: 'a'.repeat(40),
    base: 'b'.repeat(40),
    scope: 'full',
    diff: small.text,
    components: [small],
    intent: 'Preserve behavior.',
    fileList: small.path,
    role: { provider: 'mock', model: 'fixture' },
    maxTokens: 10_000,
    wallMs: 10_000,
    scanSecrets: clean,
    severityMap: { high: 'major', medium: 'minor' },
    ...overrides,
  };
}

export function result(
  overrides: Partial<WorkerResult> = {},
  findings: unknown[] = [
    { file: small.path, line: 2, rule: 'causal', severity: 'high', text: 'evidence' },
  ],
): WorkerResult {
  return {
    stopReason: 'complete',
    structuredOutput: { findings },
    usage: { ...usage },
    steps: 1,
    denials: [],
    ...overrides,
  };
}

export function fakeDrivers(options: FakeOptions = {}) {
  const requests: DriverRequest[] = [];
  const invocations: OpInvocation[] = [];
  let calls = 0;
  let sends = 0;
  const run = async (invocation: OpInvocation): Promise<WorkerResult> => {
    const call = ++calls;
    invocations.push(invocation);
    const request = requests.at(-1)!;
    if (options.onHook) await options.onHook(request, invocation);
    if (!options.skipHook) {
      const prompt = options.hookPrompt ?? invocation.prompt;
      const serialized = JSON.stringify({
        prompt: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      });
      if (options.hookKind === 'missing')
        await request.beforeRequest?.(serialized, [{ text: prompt }]);
      else
        await request.beforeRequest?.(serialized, [{ text: prompt }], {
          kind: options.hookKind ?? 'model-request',
        });
      sends++;
    }
    return options.result?.(invocation, call) ?? result();
  };
  const drivers: DriverFactory = {
    resolve: (request) => {
      requests.push(request);
      return {
        driver: { run },
        lane: options.lane ?? 'ai-sdk',
        modelSpec: request.modelSpec,
      };
    },
  };
  return { drivers, requests, invocations, calls: () => calls, sends: () => sends };
}
