import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AiSdkDriver,
  RG_MINIMUM_VERSION,
  serializeRequestForScan,
  type AiSdkDriverOptions,
} from '../../../src/driver/ai-sdk/index.js';
import type { DriverFactory } from '../../../src/driver/factory.js';
import type { WorkerResult } from '../../../src/driver/types.js';
import type { DiffSecretScanner, ScanComponentInput } from '../../../src/ops/dev/denylist.js';
import { runAgentReviewer } from '../../../src/ops/review/agentReviewer.js';
import { createReviewPlan } from '../../../src/ops/review/internal/reviewPlan.js';
import { runReviewSession } from '../../../src/ops/review/internal/reviewSession.js';
import type { ReviewCoverageV2 } from '../../../src/ops/review/internal/reviewCoverageV2.js';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const DIFF =
  'diff --git a/src/a.ts b/src/a.ts\n' +
  '--- a/src/a.ts\n' +
  '+++ b/src/a.ts\n' +
  '@@ -1 +1,2 @@\n' +
  '-old\n' +
  '+new\n' +
  '+added\n';
const COMPONENT = { component: 'tracked:src/a.ts', path: 'src/a.ts', text: DIFF };
const role = { provider: 'mock', model: 'mock-1' };
const severityMap = { high: 'major', medium: 'minor', low: 'trivial' };

type SessionPlan = Parameters<typeof runReviewSession>[1]['plan'];
type WireCall = {
  text: string;
  contents: { text: string; path?: string }[];
  kind?: 'model-request' | 'tool-output';
};

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cq-review-wire-'));
  roots.push(root);
  await mkdir(join(root, 'src'), { recursive: true });
  return root;
}

const mockUsage = () => ({
  inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 2, text: 2, reasoning: 0 },
});

function textResult(text: string) {
  return {
    content: [{ type: 'text' as const, text }],
    finishReason: { unified: 'stop' as const, raw: undefined },
    usage: mockUsage(),
    warnings: [],
  };
}

function toolCallResult(tool: string, input: unknown) {
  return {
    content: [
      {
        type: 'tool-call' as const,
        toolCallId: 'wire-call-1',
        toolName: tool,
        input: JSON.stringify(input),
      },
    ],
    finishReason: { unified: 'tool-calls' as const, raw: undefined },
    usage: mockUsage(),
    warnings: [],
  };
}

function recordingScanner(
  scanCalls: ScanComponentInput[][],
  hitsAt?: (component: ScanComponentInput) => boolean,
): DiffSecretScanner {
  return async (components) => {
    scanCalls.push(components.map((component) => ({ ...component })));
    return components.map((component) => ({
      component: component.component,
      hits: hitsAt?.(component) ? [{ ruleId: 'path-scoped', lines: [1] }] : [],
    }));
  };
}

function planFor(): SessionPlan {
  const plan = createReviewPlan({
    head: 'a'.repeat(40),
    base: 'b'.repeat(40),
    scope: 'full',
    branch: 'feature',
    components: [COMPONENT],
    session: { maxInputChars: 60_000, maxSteps: 5 },
  });
  const session = plan.sessions[0];
  if (session === undefined) throw new Error('expected a session plan');
  return session;
}

function evidenceFor(): ReviewCoverageV2['sessions'][number] {
  return {
    id: 'session-1',
    status: 'error',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    deliveries: [],
    requests: [],
  };
}

function expectUserPrompt(serialized: string, prompt: string): void {
  const request = JSON.parse(serialized) as {
    prompt?: { role?: string; content?: unknown }[];
  };
  const user = request.prompt?.find((message) => message.role === 'user');
  expect(user).toBeDefined();
  const content = user?.content;
  const texts =
    typeof content === 'string'
      ? [content]
      : Array.isArray(content)
        ? content.map((part) =>
            part !== null && typeof part === 'object' && 'text' in part
              ? (part as { text?: unknown }).text
              : undefined,
          )
        : [];
  expect(texts).toContain(prompt);
}

function wireFactory(
  root: string,
  model: MockLanguageModelV4,
  calls: WireCall[],
  options: { resolveRg?: AiSdkDriverOptions['resolveRg'] } = {},
): DriverFactory {
  return {
    resolve: (request) => {
      const driver = new AiSdkDriver({
        sessionsDir: join(root, 'sessions'),
        ...(request.harness === undefined ? {} : { harnessConfig: request.harness }),
        // Deterministic probe default; tests inject their own when they need
        // a specific capability outcome.
        resolveRg: options.resolveRg ?? (async () => ({ ok: true, version: RG_MINIMUM_VERSION })),
        beforeRequest: async (text, contents = [], context) => {
          calls.push({
            text,
            contents: contents.map((content) => ({ ...content })),
            ...(context === undefined ? {} : { kind: context.kind }),
          });
          await request.beforeRequest?.(text, contents, context);
        },
        providers: { mock: () => model },
      });
      return { lane: 'ai-sdk', modelSpec: request.modelSpec, driver };
    },
  };
}

function runInput(root: string, plan: SessionPlan, evidence: ReviewCoverageV2['sessions'][number]) {
  return {
    repoRoot: root,
    role,
    severityMap,
    maxTokens: 1000,
    maxSteps: 5,
    maxPromptChars: 60_000,
    signal: new AbortController().signal,
    components: [COMPONENT],
    plan,
    evidence,
    searchTools: false,
  } satisfies Omit<Parameters<typeof runReviewSession>[1], 'scanSecrets' | 'onUsage'> & {
    scanSecrets?: never;
    onUsage?: never;
  };
}

describe('review session wire hook', () => {
  it('delivers on the model-request hook that carries the exact prompt', async () => {
    const root = await scratch();
    const calls: WireCall[] = [];
    const scanCalls: ScanComponentInput[][] = [];
    const plan = planFor();
    const model = new MockLanguageModelV4({
      modelId: 'mock-1',
      doGenerate: async () =>
        textResult(
          JSON.stringify({
            findings: [
              { file: 'src/a.ts', line: 2, rule: 'wire', severity: 'high', text: 'grounded' },
            ],
          }),
        ),
    });
    const evidence = evidenceFor();
    let used = 0;
    const result = await runReviewSession(wireFactory(root, model, calls), {
      ...runInput(root, plan, evidence),
      scanSecrets: recordingScanner(scanCalls),
      onUsage: (usage) => {
        used +=
          usage.input + usage.output + usage.cacheRead + usage.cacheWrite + (usage.reasoning ?? 0);
      },
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(calls).toHaveLength(1);
    expect(calls[0]!.kind).toBe('model-request');
    expect(calls[0]!.contents.some((content) => content.text === plan.prompt)).toBe(true);
    expectUserPrompt(calls[0]!.text, plan.prompt);
    expect(scanCalls).toHaveLength(1);
    expect(evidence.requests).toHaveLength(1);
    expect(evidence.deliveries).toEqual([
      { component: 'tracked:src/a.ts', start: 0, end: DIFF.length, sha256: sha(DIFF) },
    ]);
    expect(evidence.status).toBe('complete');
    expect(evidence.denials).toBe(0);
    expect(typeof evidence.driverSessionId).toBe('string');
    expect(evidence.driverSessionId).not.toBe('');
    expect(used).toBeGreaterThan(0);
    expect(result.value[0]).toMatchObject({
      id: 'session-1-1',
      file: 'src/a.ts',
      line: 2,
      rule: 'wire',
      severity: 'major',
      text: 'grounded',
      status: 'open',
    });
  });

  it('never delivers from a tool-output hook even when its text is the exact serialized prompt', async () => {
    const root = await scratch();
    const calls: WireCall[] = [];
    const scanCalls: ScanComponentInput[][] = [];
    const plan = planFor();
    let firstSerialized = '';
    let generated = 0;
    const model = new MockLanguageModelV4({
      modelId: 'mock-1',
      doGenerate: async (options) => {
        generated += 1;
        if (generated === 1) {
          firstSerialized = serializeRequestForScan(options);
          await writeFile(join(root, 'src/a.ts'), firstSerialized, 'utf8');
          return toolCallResult('read', { path: 'src/a.ts' });
        }
        return textResult(JSON.stringify({ findings: [] }));
      },
    });
    const evidence = evidenceFor();
    const result = await runReviewSession(wireFactory(root, model, calls), {
      ...runInput(root, plan, evidence),
      scanSecrets: recordingScanner(scanCalls),
      onUsage: () => undefined,
    });
    expect(result.status).toBe('ok');
    expect(generated).toBe(2);
    expect(calls.map((call) => call.kind)).toEqual([
      'model-request',
      'tool-output',
      'model-request',
    ]);
    expect(calls[1]!.text).not.toBe(calls[0]!.text);
    expect(calls[1]!.text.startsWith('--- src/a.ts ---\n')).toBe(true);
    expect(calls[1]!.text).toContain('     1: ');
    expect(calls[1]!.text).toContain(calls[0]!.text.slice(0, 1_000));
    expect(calls[1]!.text).toContain('… [line truncated at 2000 chars]');
    expect(firstSerialized).toBe(calls[0]!.text);
    expect(calls[1]!.contents.some((content) => content.text === plan.prompt)).toBe(false);
    expect(scanCalls).toHaveLength(3);
    // The model sees the numbered display; the guard also receives the raw
    // selected lines with path provenance.
    expect(scanCalls[1]!.some((component) => component.text === calls[1]!.text)).toBe(true);
    expect(
      scanCalls[1]!.some(
        (component) => component.path === 'src/a.ts' && component.text === firstSerialized,
      ),
    ).toBe(true);
    expect(evidence.requests).toHaveLength(2);
    expect(evidence.deliveries).toHaveLength(1);
    expect(evidence.status).toBe('complete');
    expect(evidence.denials).toBe(0);
    expect(typeof evidence.driverSessionId).toBe('string');
    expect(evidence.driverSessionId).not.toBe('');
  });

  it('a fake tool-output hook with the exact request and prompt is scanned but blocked', async () => {
    const root = await scratch();
    const scanCalls: ScanComponentInput[][] = [];
    const plan = planFor();
    const evidence = evidenceFor();
    const exactRequest = serializeRequestForScan({
      prompt: [{ role: 'user', content: [{ type: 'text', text: plan.prompt }] }],
    });
    expectUserPrompt(exactRequest, plan.prompt);
    const worker: WorkerResult = {
      stopReason: 'complete',
      structuredOutput: { findings: [] },
      usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0 },
      steps: 1,
      denials: [],
    };
    // Clearly fake: the only hook is a tool-output guard carrying the exact
    // serialized request and the exact decoded prompt. No model send exists.
    const factory: DriverFactory = {
      resolve: (request) => ({
        lane: 'ai-sdk',
        modelSpec: request.modelSpec,
        driver: {
          run: async () => {
            await request.beforeRequest?.(exactRequest, [{ text: plan.prompt }], {
              kind: 'tool-output',
            });
            return worker;
          },
        },
      }),
    };
    const result = await runReviewSession(factory, {
      ...runInput(root, plan, evidence),
      scanSecrets: recordingScanner(scanCalls),
      onUsage: () => undefined,
    });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human')
      expect(result.reason).toContain('without scanned content delivery');
    expect(scanCalls).toHaveLength(1);
    expect(scanCalls[0]!.some((component) => component.text === exactRequest)).toBe(true);
    expect(scanCalls[0]!.some((component) => component.text === plan.prompt)).toBe(true);
    expect(evidence.requests).toHaveLength(0);
    expect(evidence.deliveries).toHaveLength(0);
    expect(evidence.status).toBe('error');
  });

  it('records a recoverable denial and truncation without poisoning coverage', async () => {
    const root = await scratch();
    await writeFile(join(root, 'src/big.txt'), 'x'.repeat(210_000), 'utf8');
    const calls: WireCall[] = [];
    const scanCalls: ScanComponentInput[][] = [];
    const plan = planFor();
    let generated = 0;
    const model = new MockLanguageModelV4({
      modelId: 'mock-1',
      doGenerate: async () => {
        generated += 1;
        if (generated === 1) return toolCallResult('read', { path: '../outside.txt' });
        if (generated === 2) return toolCallResult('read', { path: 'src/big.txt' });
        return textResult(JSON.stringify({ findings: [] }));
      },
    });
    const evidence = evidenceFor();
    const result = await runReviewSession(wireFactory(root, model, calls), {
      ...runInput(root, plan, evidence),
      scanSecrets: recordingScanner(scanCalls),
      onUsage: () => undefined,
    });
    expect(result.status).toBe('ok');
    expect(generated).toBe(3);
    expect(calls.map((call) => call.kind)).toEqual([
      'model-request',
      'model-request',
      'tool-output',
      'model-request',
    ]);
    expect(evidence.status).toBe('complete');
    expect(evidence.denials).toBe(1);
    expect(evidence.requests).toHaveLength(3);
    expect(evidence.deliveries).toHaveLength(1);
    expect(typeof evidence.driverSessionId).toBe('string');
    expect(evidence.driverSessionId).not.toBe('');
    const transcript = await readFile(
      join(root, 'sessions', `${evidence.driverSessionId}.jsonl`),
      'utf8',
    );
    expect(transcript).toContain('"toolName":"read"');
    expect(transcript).toContain('\\"ok\\":false');
    expect(transcript).toContain('\\"truncated\\":true');
  });

  it.each([undefined, 'unknown'] as const)(
    'scans a hook with kind %s and never delivers',
    async (kind) => {
      const root = await scratch();
      const scanCalls: ScanComponentInput[][] = [];
      const plan = planFor();
      const evidence = evidenceFor();
      const worker: WorkerResult = {
        stopReason: 'complete',
        structuredOutput: { findings: [] },
        usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0 },
        steps: 1,
        denials: [],
      };
      const factory: DriverFactory = {
        resolve: (request) => ({
          lane: 'ai-sdk',
          modelSpec: request.modelSpec,
          driver: {
            run: async (invocation) => {
              const contents = [{ text: invocation.prompt }];
              if (kind === undefined) await request.beforeRequest?.(invocation.prompt, contents);
              else
                await request.beforeRequest?.(invocation.prompt, contents, {
                  kind: 'unknown',
                } as never);
              return worker;
            },
          },
        }),
      };
      const result = await runReviewSession(factory, {
        ...runInput(root, plan, evidence),
        scanSecrets: recordingScanner(scanCalls),
        onUsage: () => undefined,
      });
      expect(result.status).toBe('needs-human');
      if (result.status === 'needs-human')
        expect(result.reason).toContain('without scanned content delivery');
      expect(scanCalls).toHaveLength(1);
      expect(scanCalls[0]!.some((component) => component.text === plan.prompt)).toBe(true);
      expect(evidence.requests).toHaveLength(0);
      expect(evidence.deliveries).toHaveLength(0);
      expect(evidence.status).toBe('error');
    },
  );

  it('records a clean model-request with a non-matching prompt but never delivers', async () => {
    const root = await scratch();
    const scanCalls: ScanComponentInput[][] = [];
    const plan = planFor();
    const evidence = evidenceFor();
    const worker: WorkerResult = {
      stopReason: 'complete',
      structuredOutput: { findings: [] },
      usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0 },
      steps: 1,
      denials: [],
    };
    const factory: DriverFactory = {
      resolve: (request) => ({
        lane: 'ai-sdk',
        modelSpec: request.modelSpec,
        driver: {
          run: async () => {
            const other = 'a different user turn';
            await request.beforeRequest?.(other, [{ text: other }], {
              kind: 'model-request',
            });
            return worker;
          },
        },
      }),
    };
    const result = await runReviewSession(factory, {
      ...runInput(root, plan, evidence),
      scanSecrets: recordingScanner(scanCalls),
      onUsage: () => undefined,
    });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human')
      expect(result.reason).toContain('without scanned content delivery');
    expect(scanCalls).toHaveLength(1);
    expect(evidence.requests).toHaveLength(1);
    expect(evidence.deliveries).toHaveLength(0);
    expect(evidence.status).toBe('error');
  });

  it('offers the fixed read-only reference surface and records the rg capability when search is allowed', async () => {
    const root = await scratch();
    await writeFile(join(root, 'src/dep.ts'), 'export const dep = 1;\n', 'utf8');
    const calls: WireCall[] = [];
    const scanCalls: ScanComponentInput[][] = [];
    const plan = planFor();
    let generated = 0;
    const model = new MockLanguageModelV4({
      modelId: 'mock-1',
      doGenerate: async () => {
        generated += 1;
        if (generated === 1) return toolCallResult('read', { path: 'src/dep.ts' });
        return textResult(JSON.stringify({ findings: [] }));
      },
    });
    const evidence = evidenceFor();
    const result = await runReviewSession(wireFactory(root, model, calls), {
      ...runInput(root, plan, evidence),
      searchTools: true,
      scanSecrets: recordingScanner(scanCalls),
      onUsage: () => undefined,
    });
    expect(result.status).toBe('ok');
    expect(generated).toBe(2);
    expect(evidence.status).toBe('complete');
    expect(evidence.deliveries).toHaveLength(1);
    // The injected probe's outcome rides the session evidence: search tools
    // were offered and the capability was observed.
    expect(evidence.capabilities).toEqual({
      rg: {
        available: true,
        version: RG_MINIMUM_VERSION,
        minimum: RG_MINIMUM_VERSION,
        probe: 'ok',
      },
    });
  });

  it('keeps a read-only file-only surface and no capability record when searchTools is false', async () => {
    const root = await scratch();
    const calls: WireCall[] = [];
    const scanCalls: ScanComponentInput[][] = [];
    const plan = planFor();
    const model = new MockLanguageModelV4({
      modelId: 'mock-1',
      doGenerate: async () => textResult(JSON.stringify({ findings: [] })),
    });
    const evidence = evidenceFor();
    const result = await runReviewSession(wireFactory(root, model, calls), {
      ...runInput(root, plan, evidence),
      searchTools: false,
      scanSecrets: recordingScanner(scanCalls),
      onUsage: () => undefined,
    });
    expect(result.status).toBe('ok');
    expect(evidence.status).toBe('complete');
    // A session without any search tool never probes: no capability record.
    expect(evidence.capabilities).toBeUndefined();
  });

  it('refuses a path-scoped component before dispatch through the outer reviewer', async () => {
    const root = await scratch();
    let resolveCalls = 0;
    const result = await runAgentReviewer(
      {
        resolve: () => {
          resolveCalls += 1;
          throw new Error('must not dispatch');
        },
      },
      {
        repoRoot: root,
        head: 'a'.repeat(40),
        branch: 'feature',
        base: 'b'.repeat(40),
        scope: 'full',
        diff: DIFF,
        components: [COMPONENT],
        scanSecrets: recordingScanner([], (component) => component.path === 'src/a.ts'),
        role,
        maxTokens: 1000,
        wallMs: 1000,
        severityMap,
      },
    );
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') expect(result.reason).toContain('protected content');
    expect(resolveCalls).toBe(0);
  });
});
