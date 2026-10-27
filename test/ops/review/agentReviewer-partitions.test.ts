import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, expect, it } from 'vitest';
import {
  AiSdkDriver,
  RG_MINIMUM_VERSION,
  type AiSdkDriverOptions,
} from '../../../src/driver/ai-sdk/index.js';
import type { DriverFactory, DriverRequest } from '../../../src/driver/factory.js';
import type { OpInvocation, WorkerResult } from '../../../src/driver/types.js';
import type { DiffSecretScanner } from '../../../src/ops/dev/denylist.js';
import {
  runAgentReviewer,
  type AgentReviewerInput,
} from '../../../src/ops/review/agentReviewer.js';
import {
  createReviewPlan,
  REVIEW_PARTITION_STEPS,
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
  lane?: 'ai-sdk' | 'acp';
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
        lane: options.lane ?? 'ai-sdk',
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
  // Fixed partition tooling: every fallback session carries the same
  // read-only reference definitions and the bounded total step allowance.
  expect(
    fake.invocations.every(
      (invocation) =>
        invocation.toolPolicy.mode === 'allowlist' &&
        invocation.toolPolicy.allow.join(',') === 'read,grep,glob' &&
        invocation.budget.maxSteps === REVIEW_PARTITION_STEPS,
    ),
  ).toBe(true);
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
  // Completion order does not change the fixed per-session definitions: every
  // partition dispatch carries the identical read-only reference allowlist.
  expect(
    new Set(
      fake.invocations.map(
        (invocation) => `${invocation.toolPolicy.mode}:${invocation.toolPolicy.allow?.join(',')}`,
      ),
    ),
  ).toEqual(new Set(['allowlist:read,grep,glob']));
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
  // Concurrent sessions reserve disjoint shares: 400 -> 100 + 100 + 100 + 100.
  const first = fake.invocations.slice(0, 4).map((invocation) => invocation.budget.maxTokens!);
  expect(first.reduce((sum, value) => sum + value, 0)).toBeLessThanOrEqual(400);
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
  expect(session.requests).toHaveLength(2);
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

it.each(['lane', 'delivery'] as const)('halts after a deterministic %s refusal', async (cause) => {
  const fake = fakeDrivers(cause === 'lane' ? { lane: 'acp' } : { skipHook: true });
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
  if (outcome.status !== 'needs-human') throw new Error('expected needs-human');
  expect(outcome.report?.coverage.sessions).toHaveLength(1);
  expect(fake.calls()).toBe(cause === 'lane' ? 0 : 1);
  expect(outcome.report?.coverage.pieces[0]?.state).not.toBe('completed');
});

it('keeps successful sibling evidence complete when aggregate spend exceeds the guard', async () => {
  let releaseFirst!: () => void;
  const firstHeld = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let started = 0;
  const fake = fakeDrivers({
    onHook: async () => {
      if (++started === 1) await firstHeld;
      else releaseFirst();
    },
    result: () => result({ usage: { input: 60, output: 0, cacheRead: 0, cacheWrite: 0 } }),
  });
  const outcome = await runAgentReviewer(
    fake.drivers,
    baseInput({
      diff: large,
      components: [{ ...small, text: large }],
      maxTokens: 100,
      session: { concurrency: 2 },
    }),
  );
  expect(outcome.status).toBe('needs-human');
  if (outcome.status !== 'needs-human') throw new Error('expected needs-human');
  expect(outcome.reason).toContain('budget exhausted');
  expect(outcome.report?.usage).toBe(120);
  expect(outcome.report?.coverage.sessions.map((session) => session.status)).toEqual([
    'complete',
    'complete',
  ]);
  expect(outcome.report?.coverage.pieces[0]?.state).not.toBe('completed');
});

// ---------------------------------------------------------------------------
// Real ai-sdk wire: partition sessions exercise the actual tool loop, the
// injected rg probe and the fixed per-session definitions (#508).
// ---------------------------------------------------------------------------

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

interface WireStep {
  type: 'tool-call';
  toolName: string;
  input: unknown;
}

const mockUsage = () => ({
  inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 2, text: 2, reasoning: 0 },
});

const wireText = (text: string) => ({
  content: [{ type: 'text' as const, text }],
  finishReason: { unified: 'stop' as const, raw: undefined },
  usage: mockUsage(),
  warnings: [],
});

const wireToolCall = ({ toolName, input }: WireStep) => ({
  content: [
    {
      type: 'tool-call' as const,
      toolCallId: `partition-${toolName}`,
      toolName,
      input: JSON.stringify(input),
    },
  ],
  finishReason: { unified: 'tool-calls' as const, raw: undefined },
  usage: mockUsage(),
  warnings: [],
});

/**
 * A partitioned review whose fallback session runs through the real AiSdkDriver
 * against a scratch workspace: the scripted model plays the steps, the real
 * executors run (or deny) the calls, and the outcome's coverage evidence is
 * returned with the session id for transcript assertions.
 */
/** The reviewer's ok report plus the driver transcript id of its one session. */
type PartitionWireValue =
  ReturnType<typeof runAgentReviewer> extends Promise<infer T>
    ? T extends { status: 'ok'; value: infer V }
      ? V & { sessionId: string | undefined }
      : never
    : never;

async function partitionSessionOnWire(options: {
  steps: (WireStep | 'answer')[];
  resolveRg: AiSdkDriverOptions['resolveRg'];
  file?: { path: string; body: string };
}): Promise<PartitionWireValue> {
  const root = await mkdtemp(join(tmpdir(), 'cq-review-partition-wire-'));
  roots.push(root);
  const resolveRg = options.resolveRg;
  if (options.file !== undefined) {
    await mkdir(join(root, dirname(options.file.path)), { recursive: true });
    await writeFile(join(root, options.file.path), options.file.body, 'utf8');
  }
  const model = new MockLanguageModelV4({
    modelId: 'mock-1',
    doGenerate: async () => {
      const step = options.steps.shift();
      if (step === undefined || step === 'answer')
        return wireText(
          JSON.stringify({
            findings: [
              { file: small.path, line: 2, rule: 'wire', severity: 'high', text: 'grounded' },
            ],
          }),
        );
      return wireToolCall(step);
    },
  });
  const factory: DriverFactory = {
    resolve: (request) => {
      const driver = new AiSdkDriver({
        sessionsDir: join(root, 'sessions'),
        ...(request.harness === undefined ? {} : { harnessConfig: request.harness }),
        ...(resolveRg === undefined ? {} : { resolveRg }),
        ...(request.beforeRequest === undefined ? {} : { beforeRequest: request.beforeRequest }),
        providers: { mock: () => model },
      });
      return { lane: 'ai-sdk', modelSpec: request.modelSpec, driver };
    },
  };
  const outcome = await runAgentReviewer(
    factory,
    baseInput({
      repoRoot: root,
      diff: large,
      components: [{ component: 'tracked:src/a.ts', path: 'src/a.ts', text: large }],
      maxTokens: 1_000_000,
      session: { concurrency: 1 },
    }),
  );
  if (outcome.status !== 'ok') throw new Error(JSON.stringify(outcome));
  const session = outcome.value.coverage.sessions[0];
  return Object.assign(outcome.value, { sessionId: session?.driverSessionId });
}

const readDep: WireStep = { type: 'tool-call', toolName: 'read', input: { path: 'src/dep.ts' } };

it('executes a bounded partition read against the real workspace and answers on the final step', async () => {
  const value = await partitionSessionOnWire({
    file: { path: 'src/dep.ts', body: 'export const dep = 1;\n' },
    resolveRg: async () => ({ ok: true, version: RG_MINIMUM_VERSION }),
    steps: [readDep, 'answer'],
  });
  const session = value.coverage.sessions[0]!;
  expect(session.status).toBe('complete');
  expect(session.steps).toBe(2);
  expect(session.deliveries).toHaveLength(1);
  expect(session.denials).toBe(0);
  expect(value.findings.map((finding) => finding.text)).toEqual(['grounded']);
});

it('reports the missing-rg capability and still completes the partition session', async () => {
  const value = await partitionSessionOnWire({
    resolveRg: async () => ({ ok: false, reason: 'absent' }),
    steps: ['answer'],
  });
  const session = value.coverage.sessions[0]!;
  expect(session.status).toBe('complete');
  // The once-per-run probe outcome is the capability evidence: search was
  // withheld, the partition still completed, and coverage is unchanged.
  expect(session.capabilities).toEqual({
    rg: { available: false, minimum: RG_MINIMUM_VERSION, probe: 'absent' },
  });
  expect(value.coverage.pieces[0]).toMatchObject({ state: 'completed' });
});

it('reports the too-old-rg capability with its found version', async () => {
  const value = await partitionSessionOnWire({
    resolveRg: async () => ({ ok: false, reason: 'old', found: '10.5.0' }),
    steps: ['answer'],
  });
  const session = value.coverage.sessions[0]!;
  expect(session.capabilities).toEqual({
    rg: { available: false, found: '10.5.0', minimum: RG_MINIMUM_VERSION, probe: 'old' },
  });
});

it('records a denied final-step call without manufacturing a clean source beyond coverage', async () => {
  const value = await partitionSessionOnWire({
    file: { path: 'src/dep.ts', body: 'export const dep = 1;\n' },
    resolveRg: async () => ({ ok: true, version: RG_MINIMUM_VERSION }),
    // Two greps run inside the budget; the third lands on the bounded
    // budget's final step and the executor denies it; the one-step repair
    // then carries the JSON answer.
    steps: [
      { type: 'tool-call', toolName: 'grep', input: { pattern: 'dep', path: 'src' } },
      { type: 'tool-call', toolName: 'grep', input: { pattern: 'dep', path: 'src' } },
      { type: 'tool-call', toolName: 'grep', input: { pattern: 'dep', path: 'src' } },
    ],
  });
  const session = value.coverage.sessions[0]!;
  expect(session.status).toBe('complete');
  // The final-step denial stays explicit in the evidence: the session shows
  // its denials and failed tool calls next to its delivered bytes.
  expect(session.denials).toBe(1);
  expect(session.toolFailures).toBe(1);
  expect(session.deliveries).toHaveLength(1);
  expect(value.coverage.pieces[0]).toMatchObject({ state: 'completed' });
  const transcript = await readFile(
    join(roots.at(-1)!, 'sessions', `${value.sessionId}.jsonl`),
    'utf8',
  );
  expect(transcript).toContain('FINAL_STEP');
});

it('records clean capability evidence when ripgrep meets the minimum', async () => {
  const value = await partitionSessionOnWire({
    resolveRg: async () => ({ ok: true, version: RG_MINIMUM_VERSION }),
    steps: ['answer'],
  });
  const session = value.coverage.sessions[0]!;
  expect(session.capabilities).toEqual({
    rg: { available: true, version: RG_MINIMUM_VERSION, minimum: RG_MINIMUM_VERSION, probe: 'ok' },
  });
});
