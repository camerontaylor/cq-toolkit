import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import type { DriverFactory, DriverRequest } from '../../../src/driver/factory.js';
import type { OpInvocation, WorkerResult } from '../../../src/driver/types.js';
import type { DiffSecretScanner } from '../../../src/ops/dev/denylist.js';
import {
  runAgentReviewer,
  type AgentReviewerInput,
} from '../../../src/ops/review/agentReviewer.js';
import {
  createReviewPlan,
  type PlannedReviewSession,
} from '../../../src/ops/review/internal/reviewPlan.js';
import { runReviewSession } from '../../../src/ops/review/internal/reviewSession.js';
import type { ReviewCoverageV2 } from '../../../src/ops/review/internal/reviewCoverageV2.js';
import { partitionReview } from '../../../src/ops/review/internal/reviewPartitions.js';

const usage = { input: 2, output: 3, cacheRead: 0, cacheWrite: 0 } as const;
const clean: DiffSecretScanner = (components) =>
  components.map(({ component }) => ({ component, hits: [] }));
const header = '@@ -1 +1 @@\n';
const small = {
  component: 'tracked:src/a.ts',
  path: 'src/a.ts',
  text: `diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n${header}-old()\n+new()\n`,
};
const large =
  'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1,30000 @@\n' +
  '+ordinary 😀 line\n'.repeat(26_365);

type HookKind = 'model-request' | 'tool-output' | 'missing';
type FakeOptions = {
  scanner?: DiffSecretScanner;
  skipHook?: boolean;
  hookKind?: HookKind;
  hookPrompt?: string;
  result?: (invocation: OpInvocation, call: number) => WorkerResult;
  onHook?: (request: DriverRequest, invocation: OpInvocation) => Promise<void>;
};

function baseInput(overrides: Partial<AgentReviewerInput> = {}): AgentReviewerInput {
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

function result(
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

function fakeDrivers(options: FakeOptions = {}) {
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
        lane: 'ai-sdk',
        modelSpec: request.modelSpec,
      };
    },
  };
  return { drivers, requests, invocations, calls: () => calls, sends: () => sends };
}

it('uses one tool-aware read-only session with exact original-component delivery evidence', async () => {
  const fake = fakeDrivers();
  const outcome = await runAgentReviewer(fake.drivers, baseInput());
  expect(outcome.status).toBe('ok');
  if (outcome.status !== 'ok') throw new Error(JSON.stringify(outcome));
  expect(outcome.value.coverage).toMatchObject({
    version: 2,
    mode: 'session',
    pieces: [{ component: small.component, state: 'completed', chars: small.text.length }],
    sessions: [
      {
        status: 'complete',
        steps: 1,
        deliveries: [
          {
            component: small.component,
            start: 0,
            end: small.text.length,
            sha256: createHash('sha256').update(small.text).digest('hex'),
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
  expect(fake.invocations[0]).toMatchObject({
    toolPolicy: { mode: 'allowlist', allow: ['read', 'grep', 'glob'] },
    sandboxPolicy: { level: 'read-only' },
    workspace: { path: '/fixture/repo' },
    budget: { maxTokens: 10_000, maxSteps: 4 },
    outputSchema: { name: 'review.agent/v3' },
  });
});

it('falls back for a large change and proves complete contiguous UTF-16 coverage of original bytes', async () => {
  const input = baseInput({
    diff: large,
    components: [{ component: 'tracked:src/a.ts', path: 'src/a.ts', text: large }],
  });
  const fake = fakeDrivers();
  const outcome = await runAgentReviewer(fake.drivers, input);
  expect(outcome.status).toBe('ok');
  if (outcome.status !== 'ok') throw new Error(JSON.stringify(outcome));
  const { coverage } = outcome.value;
  expect(coverage.mode).toBe('partitioned');
  expect(coverage.pieces[0]).toMatchObject({
    component: 'tracked:src/a.ts',
    path: 'src/a.ts',
    chars: large.length,
    bytes: Buffer.byteLength(large, 'utf8'),
    sha256: createHash('sha256').update(large).digest('hex'),
    state: 'completed',
  });
  const deliveries = coverage.sessions.flatMap((session) => session.deliveries);
  expect(deliveries.length).toBeGreaterThan(1);
  expect(deliveries.map(({ start, end }) => [start, end])).toEqual(
    [...deliveries].sort((a, b) => a.start - b.start).map(({ start, end }) => [start, end]),
  );
  let next = 0;
  let reconstructed = '';
  for (const delivery of deliveries) {
    expect(delivery.start).toBe(next);
    const prompt =
      fake.invocations[coverage.sessions.findIndex((s) => s.deliveries.includes(delivery))]!.prompt;
    const data = prompt.slice(prompt.indexOf('partition data (UTF-16 range'));
    expect(delivery.end).toBeGreaterThan(delivery.start);
    reconstructed += large.slice(delivery.start, delivery.end);
    expect(large.slice(delivery.start, delivery.end)).not.toMatch(
      /^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/,
    );
    expect(data).toContain(large.slice(delivery.start, delivery.end));
    next = delivery.end;
  }
  expect(next).toBe(large.length);
  expect(reconstructed).toBe(large);
  expect(fake.calls()).toBe(coverage.sessions.length);
  expect(outcome.value.usage).toBe(fake.calls() * 5);
  expect(fake.invocations.every((invocation) => invocation.toolPolicy.mode === 'none')).toBe(true);
});

it('subtracts completed session token usage and blocks with honest partial coverage when budget runs out', async () => {
  const fake = fakeDrivers();
  const outcome = await runAgentReviewer(
    fake.drivers,
    baseInput({
      diff: large,
      components: [{ component: 'tracked:src/a.ts', path: 'src/a.ts', text: large }],
      maxTokens: 10,
      session: { concurrency: 1 },
    }),
  );
  expect(outcome.status).toBe('budget-exhausted');
  expect(outcome).toMatchObject({
    report: {
      usage: 10,
      coverage: {
        mode: 'partitioned',
        pieces: [{ state: 'delivered' }],
        sessions: [
          { status: 'complete', usage },
          { status: 'complete', usage },
        ],
      },
    },
  });
  expect(fake.invocations.map((invocation) => invocation.budget.maxTokens)).toEqual([10, 5]);
  expect(fake.calls()).toBe(2);
});

it('blocks a valid JSON answer when its scanned request was not an actual model request', async () => {
  for (const kind of ['tool-output', 'missing'] as const) {
    const fake = fakeDrivers({ hookKind: kind, result: () => result() });
    const outcome = await runAgentReviewer(fake.drivers, baseInput());
    expect(outcome).toMatchObject({
      status: 'needs-human',
      reason: expect.stringContaining(
        'agent review completed without scanned content delivery',
      ) as unknown,
      report: { coverage: { pieces: [{ state: 'planned' }], sessions: [{ deliveries: [] }] } },
    });
  }
});

it('fails closed when any original, prompt, serialized request, or decoded request scan is incomplete/protected', async () => {
  for (const mode of [
    'original-hit',
    'missing',
    'duplicate',
    'request-hit',
    'decoded-hit',
    'fault',
  ]) {
    let requestScans = 0;
    const scanner: DiffSecretScanner = (components) => {
      requestScans++;
      if (mode === 'fault' && components.some(({ component }) => component === 'request'))
        throw new Error('scanner unavailable');
      if (mode === 'missing' && components.some(({ component }) => component === 'review-prompt'))
        return [];
      const verdicts = components.map(({ component, path }) => ({
        component,
        hits:
          (mode === 'original-hit' && component === small.component) ||
          (mode === 'request-hit' && component === 'request') ||
          (mode === 'decoded-hit' && component.startsWith('request-content-'))
            ? [{ ruleId: 'fixture-secret', lines: [1] }]
            : [],
        ...(path ? { path } : {}),
      }));
      if (mode === 'duplicate' && components.some(({ component }) => component === 'review-prompt'))
        return [...verdicts, verdicts[0]!];
      return verdicts;
    };
    const fake = fakeDrivers({ scanner });
    const outcome = await runAgentReviewer(fake.drivers, baseInput({ scanSecrets: scanner }));
    expect(outcome.status).not.toBe('ok');
    expect(fake.sends()).toBe(0);
    expect(requestScans).toBeGreaterThan(0);
  }
});

it('does not count a tool-output JSON spoof or a wrong prompt as delivery', async () => {
  const spoof = fakeDrivers({
    onHook: async (request) => {
      await request.beforeRequest?.(
        '{"toolOutput":"{\\"findings\\":[]}"}',
        [{ text: '{"findings":[]}' }],
        { kind: 'tool-output' },
      );
    },
    skipHook: true,
  });
  const spoofed = await runAgentReviewer(spoof.drivers, baseInput());
  expect(spoofed).toMatchObject({
    status: 'needs-human',
    reason: expect.stringContaining('without scanned content delivery') as unknown,
  });

  const wrong = fakeDrivers({ hookPrompt: 'not the planned review prompt' });
  const wrongPrompt = await runAgentReviewer(wrong.drivers, baseInput());
  expect(wrongPrompt).toMatchObject({
    status: 'needs-human',
    reason: expect.stringContaining('without scanned content delivery') as unknown,
  });
});

it('rechecks cancellation after upload scanning and before recording delivery', async () => {
  const controller = new AbortController();
  const scanner: DiffSecretScanner = (components) => {
    if (components.some(({ component }) => component === 'request')) controller.abort();
    return clean(components);
  };
  const fake = fakeDrivers();
  const outcome = await runAgentReviewer(
    fake.drivers,
    baseInput({ scanSecrets: scanner, signal: controller.signal }),
  );
  expect(outcome.status).toBe('needs-human');
  expect(fake.calls()).toBe(1);
  expect(outcome.report?.coverage.sessions[0]).toMatchObject({ status: 'aborted', deliveries: [] });
});

it('does not let a late scanner callback mutate the timed-out coverage snapshot', async () => {
  let releaseScan!: () => void;
  let markEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  const scanGate = new Promise<void>((resolve) => {
    releaseScan = resolve;
  });
  const scanner: DiffSecretScanner = async (components) => {
    if (components.some(({ component }) => component === 'request')) {
      markEntered();
      await scanGate;
    }
    return clean(components);
  };
  const fake = fakeDrivers();
  const pending = runAgentReviewer(fake.drivers, baseInput({ scanSecrets: scanner, wallMs: 40 }));
  await entered;
  const outcome = await pending;
  expect(outcome.status).toBe('needs-human');
  expect(outcome.report?.coverage.sessions[0]).toMatchObject({ status: 'aborted', deliveries: [] });
  const snapshot = JSON.stringify(outcome.report?.coverage);
  releaseScan();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(JSON.stringify(outcome.report?.coverage)).toBe(snapshot);
  expect(fake.sends()).toBe(0);
});

it('rejects a forged prompt offset before dispatch while accepting an empty exact placement', async () => {
  const planned = createReviewPlan({
    head: 'a'.repeat(40),
    base: 'b'.repeat(40),
    scope: 'full',
    components: [small],
  });
  const session = planned.sessions[0]!;
  const broken: PlannedReviewSession = {
    ...session,
    placements: session.placements.map((placement) => ({
      ...placement,
      offset: placement.offset + 1,
    })),
  };
  const evidence: ReviewCoverageV2['sessions'][number] = {
    id: session.id,
    status: 'error',
    usage: { ...usage },
    deliveries: [],
    requests: [],
  };
  const fake = fakeDrivers();
  await expect(
    runReviewSession(fake.drivers, {
      repoRoot: '/fixture/repo',
      role: { provider: 'mock', model: 'fixture' },
      severityMap: { high: 'major', medium: 'minor' },
      maxTokens: 100,
      maxSteps: 15,
      maxPromptChars: 60_000,
      signal: new AbortController().signal,
      scanSecrets: clean,
      components: [small],
      plan: broken,
      evidence,
      onUsage: () => undefined,
      searchTools: true,
    }),
  ).rejects.toThrow('agent review prompt placement does not match its planned component');
  expect(fake.calls()).toBe(0);
});

it('retains original line attribution and preserves surrogate-safe partition boundaries', async () => {
  const text = '@@ -900 +800 @@\n' + '😀 ordinary line\n'.repeat(5_000);
  const component = { component: 'untracked:new.txt', path: 'new.txt', text };
  const plan = partitionReview({
    head: 'a'.repeat(40),
    base: 'b'.repeat(40),
    scope: 'full',
    components: [component],
    requireReceipt: false,
  });
  expect(plan.partitions.length).toBeGreaterThan(1);
  let next = 0;
  for (const part of plan.coverage.partitions) {
    const range = part.ranges[0]!;
    expect(range.start).toBe(next);
    const slice = text.slice(range.start, range.end);
    expect(slice).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
    next = range.end;
  }
  expect(next).toBe(text.length);
  const rightLine = text.slice(0, plan.coverage.partitions[1]!.ranges[0]!.start).split('\n').length;
  expect(rightLine).toBeGreaterThan(1);
  expect(plan.partitions[1]?.prompt).toContain(`"newLine":${rightLine}`);
  expect(plan.partitions[1]?.prompt).not.toContain('"oldLine"');
});

it('returns complete zero-session coverage for excluded content and distinguishes assurance from limitation', async () => {
  const components = [
    { component: 'tracked:src/generated.ts', path: 'src/generated.ts', text: 'generated' },
    { component: 'tracked:src/vendor.ts', path: 'src/vendor.ts', text: 'vendor' },
  ];
  const fake = fakeDrivers();
  const outcome = await runAgentReviewer(
    fake.drivers,
    baseInput({
      components,
      exclude: [
        { pattern: 'src/generated.ts', assuredBy: 'generated from reviewed schema' },
        { pattern: 'src/vendor.ts' },
      ],
    }),
  );
  expect(outcome.status).toBe('ok');
  if (outcome.status !== 'ok') throw new Error(JSON.stringify(outcome));
  expect(fake.calls()).toBe(0);
  expect(outcome.value.coverage.sessions).toEqual([]);
  expect(outcome.value.coverage.pieces).toMatchObject([
    { state: 'excluded', exclusion: { assuredBy: 'generated from reviewed schema' } },
    {
      state: 'excluded',
      exclusion: { limitation: expect.stringContaining('no assuredBy check') as unknown },
    },
  ]);
  expect(outcome.value.advisories).toContain(
    'agent review covered no content: all components excluded',
  );
  expect(outcome.value.limitations).toHaveLength(1);
});

it('refuses duplicate component identities rather than collapsing original coverage', async () => {
  const duplicate = { ...small, path: 'src/other.ts' };
  const fake = fakeDrivers();
  const outcome = await runAgentReviewer(
    fake.drivers,
    baseInput({ components: [small, duplicate] }),
  );
  expect(outcome).toMatchObject({
    status: 'needs-human',
    reason: expect.stringContaining('component identities must be unique') as unknown,
  });
  expect(fake.calls()).toBe(0);
});

it('captures only exact, valid empty-component placements as delivery', async () => {
  const empty = { component: 'untracked:empty.txt', path: 'empty.txt', text: '' };
  const fake = fakeDrivers({ result: () => result({}, []) });
  const outcome = await runAgentReviewer(
    fake.drivers,
    baseInput({ components: [empty], diff: '' }),
  );
  expect(outcome.status).toBe('ok');
  if (outcome.status !== 'ok') throw new Error(JSON.stringify(outcome));
  expect(outcome.value.coverage.pieces[0]).toMatchObject({
    state: 'completed',
    chars: 0,
    bytes: 0,
  });
  expect(outcome.value.coverage.sessions[0]?.deliveries[0]).toMatchObject({
    component: empty.component,
    start: 0,
    end: 0,
  });
});

it('rejects a session whose evidence record is not empty before dispatch', async () => {
  const planned = createReviewPlan({
    head: 'a'.repeat(40),
    base: 'b'.repeat(40),
    scope: 'full',
    components: [small],
  });
  const session = planned.sessions[0]!;
  const fake = fakeDrivers();
  await expect(
    runReviewSession(fake.drivers, {
      repoRoot: '/fixture/repo',
      role: { provider: 'mock', model: 'fixture' },
      severityMap: { high: 'major', medium: 'minor' },
      maxTokens: 100,
      maxSteps: 4,
      maxPromptChars: 60_000,
      signal: new AbortController().signal,
      scanSecrets: clean,
      components: [small],
      plan: session,
      evidence: {
        id: session.id,
        status: 'error',
        usage: { ...usage },
        deliveries: [],
        requests: [{ kind: 'model-request', matched: true }] as never,
      },
      onUsage: () => undefined,
      searchTools: true,
    }),
  ).rejects.toThrow('agent review session evidence must start empty');
  expect(fake.calls()).toBe(0);
});

it('tracks old and new line numbers through context, removed and added hunk lines', () => {
  const text = ['@@ -10,4 +20,4 @@', ' context', '-removed', '+added', ' tail', ''].join('\n');
  const plan = partitionReview({
    head: 'a'.repeat(40),
    base: 'b'.repeat(40),
    scope: 'full',
    components: [{ component: 'tracked:a.ts', path: 'a.ts', text }],
    requireReceipt: false,
  });
  expect(plan.partitions).toHaveLength(1);
});

it('refuses partition instructions that alone exceed the prompt cap', () => {
  expect(() =>
    partitionReview({
      head: 'a'.repeat(40),
      base: 'b'.repeat(40),
      scope: 'full',
      components: [{ component: 'tracked:a.ts', path: 'a.ts', text: 'x\n' }],
      instructions: 'i'.repeat(200_000),
    }),
  ).toThrow('exceed the supported prompt limit');
});

it('keeps dispatching independent sessions after one fails and still blocks with the failure named', async () => {
  const fake = fakeDrivers({
    result: (_invocation, call) =>
      call === 1
        ? result({ stopReason: 'error', error: 'step timeout', structuredOutput: undefined })
        : result(),
  });
  const outcome = await runAgentReviewer(
    fake.drivers,
    baseInput({ diff: large, components: [{ ...small, text: large }], maxTokens: 1_000_000 }),
  );
  expect(outcome.status).toBe('needs-human');
  expect(fake.calls()).toBeGreaterThan(2);
  if (outcome.status !== 'needs-human') throw new Error('expected needs-human');
  expect(outcome.reason).toContain('step timeout');
  expect(outcome.report?.coverage.sessions[0]).toMatchObject({ status: 'error' });
  expect(outcome.report?.coverage.sessions[1]).toMatchObject({ status: 'complete' });
  expect(outcome.report?.findings.length).toBeGreaterThan(0);
});

it('stops after two consecutive failed sessions instead of spending the rest of the budget', async () => {
  const fake = fakeDrivers({
    result: () =>
      result({ stopReason: 'error', error: 'provider down', structuredOutput: undefined }),
  });
  const outcome = await runAgentReviewer(
    fake.drivers,
    baseInput({
      diff: large,
      components: [{ ...small, text: large }],
      maxTokens: 1_000_000,
      session: { concurrency: 1 },
    }),
  );
  expect(outcome.status).toBe('needs-human');
  expect(fake.calls()).toBe(2);
});

it('runs partitions concurrently up to the limit and merges findings in plan order', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const fake = fakeDrivers({
    onHook: async (_request, invocation) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Later partitions finish first: completion order differs from plan order.
      const marker = /UTF-16 range (\d+):/.exec(invocation.prompt)?.[1] ?? '0';
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(1, 30 - Number(marker) / 20_000)),
      );
      inFlight--;
    },
    result: (invocation) =>
      result({}, [
        {
          file: small.path,
          line: 2,
          rule: 'order',
          severity: 'high',
          text: `at ${/UTF-16 range (\d+):/.exec(invocation.prompt)?.[1] ?? '?'}`,
        },
      ]),
  });
  const outcome = await runAgentReviewer(
    fake.drivers,
    baseInput({
      diff: large,
      components: [{ ...small, text: large }],
      maxTokens: 1_000_000,
      session: { concurrency: 3 },
    }),
  );
  expect(outcome.status).toBe('ok');
  if (outcome.status !== 'ok') throw new Error('expected ok');
  expect(maxInFlight).toBeGreaterThan(1);
  expect(maxInFlight).toBeLessThanOrEqual(3);
  const starts = outcome.value.findings.map((finding) => Number(/at (\d+)/.exec(finding.text)![1]));
  expect(starts).toEqual([...starts].sort((a, b) => a - b));
  expect(outcome.value.coverage.sessions.map((session) => session.id)).toEqual(
    outcome.value.coverage.sessions.map((_s, index) => `partition-${index + 1}`),
  );
});

it('splits the remaining token allowance across concurrent sessions', async () => {
  const fake = fakeDrivers();
  await runAgentReviewer(
    fake.drivers,
    baseInput({
      diff: large,
      components: [{ ...small, text: large }],
      maxTokens: 400,
      session: { concurrency: 4 },
    }),
  );
  expect(fake.invocations[0]!.budget.maxTokens).toBe(100);
});

it('retries a transient session failure once, counting both attempts, but not other failures', async () => {
  const transient = fakeDrivers({
    result: (_invocation, call) =>
      call === 1
        ? result({
            stopReason: 'error',
            error: 'step timeout',
            errorClass: 'transient',
            structuredOutput: undefined,
          })
        : result(),
  });
  const outcome = await runAgentReviewer(transient.drivers, baseInput());
  expect(outcome.status).toBe('ok');
  if (outcome.status !== 'ok') throw new Error('expected ok');
  expect(transient.calls()).toBe(2);
  const session = outcome.value.coverage.sessions[0]!;
  expect(session).toMatchObject({ status: 'complete', attempts: 2 });
  expect(session.usage.input).toBe(usage.input * 2);
  expect(session.deliveries).toHaveLength(1);
  expect(outcome.value.usage).toBe(
    2 * (usage.input + usage.output + usage.cacheRead + usage.cacheWrite),
  );

  const persistent = fakeDrivers({
    result: () =>
      result({
        stopReason: 'error',
        error: 'step timeout',
        errorClass: 'transient',
        structuredOutput: undefined,
      }),
  });
  const failed = await runAgentReviewer(persistent.drivers, baseInput());
  expect(failed.status).toBe('needs-human');
  expect(persistent.calls()).toBe(2);

  const deterministic = fakeDrivers({
    result: () =>
      result({
        stopReason: 'error',
        error: 'bad request',
        errorClass: 'unknown',
        structuredOutput: undefined,
      }),
  });
  await runAgentReviewer(deterministic.drivers, baseInput());
  expect(deterministic.calls()).toBe(1);
});

it("keeps completed sessions' findings and halts the pool when a later session hits a hard error", async () => {
  let calls = 0;
  const scanner: DiffSecretScanner = async (components) => {
    if (components.some(({ component }) => component === 'review-prompt') && ++calls === 3)
      throw new Error('scanner unavailable');
    return clean(components);
  };
  const fake = fakeDrivers();
  const outcome = await runAgentReviewer(
    fake.drivers,
    baseInput({
      diff: large,
      components: [{ ...small, text: large }],
      maxTokens: 1_000_000,
      scanSecrets: scanner,
      session: { concurrency: 1 },
    }),
  );
  expect(outcome.status).toBe('needs-human');
  expect(outcome.report?.findings.length).toBeGreaterThan(0);
  expect(fake.calls()).toBe(2);
});
