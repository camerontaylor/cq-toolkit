import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, expect, it } from 'vitest';
import { AiSdkDriver } from '../../../src/driver/ai-sdk/index.js';
import type { DriverFactory } from '../../../src/driver/factory.js';
import type { OpInvocation } from '../../../src/driver/types.js';
import {
  partitionReview,
  ReviewCoverageSchema,
} from '../../../src/ops/review/internal/reviewPartitions.js';
import { defaultHarnessConfig } from '../../../src/harness/config.js';
import type { DiffSecretScanner } from '../../../src/ops/dev/denylist.js';
import {
  runAgentReviewer,
  type AgentReviewerInput,
} from '../../../src/ops/review/agentReviewer.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const clean: DiffSecretScanner = (components) =>
  components.map(({ component }) => ({ component, hits: [] }));
const large =
  'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1,30000 @@\n' +
  '+ordinary 😀 line\n'.repeat(26_365);

async function fixture(
  options: {
    reply?: (prompt: string, call: number) => unknown;
    scanner?: DiffSecretScanner;
    cancel?: AbortController;
    hang?: boolean;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'cq-review-parts-'));
  roots.push(root);
  const prompts: string[] = [];
  const wire: string[] = [];
  let calls = 0;
  const factory = {
    resolve: (request: Parameters<DriverFactory['resolve']>[0]) => ({
      lane: 'ai-sdk',
      modelSpec: request.modelSpec,
      driver: new AiSdkDriver({
        sessionsDir: join(root, 'sessions'),
        ...(request.harness ? { harnessConfig: request.harness } : {}),
        beforeRequest: async (text, contents) => {
          wire.push(text);
          await request.beforeRequest?.(text, contents);
        },
        providers: {
          mock: () =>
            new MockLanguageModelV4({
              modelId: 'fixture',
              doGenerate: async (request) => {
                calls++;
                const prompt = JSON.stringify(request.prompt);
                const receipt = /receipt: ([a-f0-9]+)/.exec(prompt)?.[1];
                if (options.hang && calls > 1) return new Promise<never>(() => undefined);
                if (calls === 2) options.cancel?.abort();
                return {
                  content: [
                    {
                      type: 'text' as const,
                      text: JSON.stringify(
                        options.reply?.(prompt, calls) ?? {
                          receipt,
                          findings: [
                            {
                              file: 'src/a.ts',
                              line: 42,
                              rule: 'causal',
                              severity: 'high',
                              text: 'retained evidence',
                            },
                          ],
                        },
                      ),
                    },
                  ],
                  finishReason: { unified: 'stop' as const, raw: undefined },
                  usage: {
                    inputTokens: { total: 2, noCache: 2, cacheRead: 0, cacheWrite: 0 },
                    outputTokens: { total: 3, text: 3, reasoning: 0 },
                  },
                  warnings: [],
                };
              },
            }),
        },
      }),
    }),
  } as DriverFactory;
  // Capture the actual operation prompt, while retaining the real AiSdkDriver and wire guard.
  const drivers = {
    resolve: (request: Parameters<DriverFactory['resolve']>[0]) => {
      const resolved = factory.resolve(request);
      const run = resolved.driver.run.bind(resolved.driver);
      resolved.driver.run = (invocation, options) => {
        prompts.push(invocation.prompt);
        return run(invocation, options);
      };
      return resolved;
    },
  } as DriverFactory;
  const input: AgentReviewerInput = {
    repoRoot: root,
    branch: 'feature',
    head: 'a'.repeat(40),
    base: 'b'.repeat(40),
    scope: 'full',
    diff: large,
    components: [{ component: 'tracked:src/a.ts', path: 'src/a.ts', text: large }],
    role: { provider: 'mock', model: 'fixture' },
    maxTokens: 10000,
    wallMs: 10000,
    scanSecrets: options.scanner ?? clean,
    severityMap: { high: 'major', medium: 'minor' },
    ...(options.cancel ? { signal: options.cancel.signal } : {}),
  };
  return { drivers, input, prompts, wire, calls: () => calls };
}

it('causally replaces an oversized refused request with lossless complete review at the real wire seam', async () => {
  const f = await fixture();
  const old = f.drivers.resolve({ role: 'reviewer', modelSpec: f.input.role });
  await expect(
    old.driver.run({
      prompt: large,
      modelSpec: f.input.role,
      toolPolicy: { mode: 'none', allow: [] },
      sandboxPolicy: { level: 'read-only' },
      workspace: { path: f.input.repoRoot },
      budget: { maxTokens: 10000 },
    } as OpInvocation),
  ).rejects.toThrow('over the harness prompt budget');
  expect(f.calls()).toBe(0);
  f.prompts.splice(0);
  const result = await runAgentReviewer(f.drivers, f.input);
  expect(result.status).toBe('ok');
  if (result.status !== 'ok') throw new Error(JSON.stringify(result));
  const { coverage } = result.value;
  expect(coverage).toMatchObject({ head: f.input.head, base: f.input.base, scope: 'full' });
  expect(coverage.components[0]?.sha256).toBe(createHash('sha256').update(large).digest('hex'));
  let next = 0;
  let reconstructed = '';
  for (const [index, part] of coverage.partitions.entries()) {
    expect(part.complete).toBe(true);
    const range = part.ranges[0]!;
    expect(range.start).toBe(next);
    const prompt = f.prompts[index]!;
    expect(prompt.length).toBeLessThanOrEqual(
      defaultHarnessConfig.promptBudget.maxSystemPromptChars,
    );
    const data = prompt.split(/partition data \(UTF-16 range \d+:\d+\):\n/)[1]!;
    expect(data).toBe(large.slice(range.start, range.end));
    expect(data).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
    expect(part.requests.length).toBe(1);
    expect(part.requests[0]!.serializedChars).toBeGreaterThan(prompt.length);
    reconstructed += data;
    next = range.end;
  }
  expect(reconstructed).toBe(large);
  expect(f.calls()).toBe(coverage.partitions.length);
  expect(f.calls()).toBeGreaterThan(20);
  expect(result.value.usage).toBe(f.calls() * 5);
  console.info(
    'hermetic review coverage',
    JSON.stringify({
      originalChars: large.length,
      originalBytes: coverage.components[0]!.bytes,
      partitions: f.calls(),
      usage: result.value.usage,
      maxPromptChars: Math.max(...f.prompts.map((p) => p.length)),
      maxWireChars: Math.max(
        ...coverage.partitions.flatMap((p) => p.requests.map((r) => r.serializedChars)),
      ),
    }),
  );
  expect(new Set(coverage.partitions.map((part) => part.receipt)).size).toBe(f.calls());
});

it('finds boundary-spanning evidence with original path/line attribution using repeated context', async () => {
  let rightLine = 0;
  const f = await fixture({
    reply: (prompt) => ({
      receipt: /receipt: ([a-f0-9]+)/.exec(prompt)?.[1],
      findings:
        prompt.includes('boundary-left') && prompt.includes('boundary-right')
          ? [
              {
                file: 'src/a.ts',
                line: rightLine,
                rule: 'pair',
                severity: 'high',
                text: 'paired evidence',
              },
            ]
          : [],
    }),
  });
  const header = '@@ -100 +200,10000 @@\n';
  const lines = Array.from({ length: 1500 }, () => '+'.padEnd(40, 'x') + '\n');
  const component = {
    component: 'tracked:src/a.ts',
    path: 'src/a.ts',
    text: header + lines.join(''),
  };
  const plan = partitionReview({
    head: f.input.head,
    base: f.input.base!,
    scope: 'full',
    components: [component],
  });
  const boundary = plan.coverage.partitions[0]!.ranges[0]!.end;
  const right = (boundary - header.length) / lines[0]!.length;
  expect(Number.isInteger(right)).toBe(true);
  lines[right - 1] = '+boundary-left'.padEnd(40, 'x') + '\n';
  lines[right] = '+boundary-right'.padEnd(40, 'x') + '\n';
  rightLine = 200 + right;
  component.text = header + lines.join('');
  const result = await runAgentReviewer(f.drivers, { ...f.input, components: [component] });
  expect(result.status).toBe('ok');
  if (result.status !== 'ok') throw new Error('review failed');
  expect(f.prompts[0]).not.toContain('boundary-right');
  expect(f.prompts[1]).toContain('boundary-left');
  expect(f.prompts[1]).toContain('boundary-right');
  expect(f.prompts[1]).toContain(`"newLine":${rightLine}`);
  expect(result.value.findings).toHaveLength(1);
  expect(result.value.findings[0]).toMatchObject({
    file: 'src/a.ts',
    line: rightLine,
    text: 'paired evidence',
  });
  const second = result.value.coverage.partitions[1]!;
  expect(second.context!.end).toBe(second.ranges[0]!.start);
});

it.each(['missing', 'replayed', 'malformed'] as const)(
  'blocks %s receipts and retains prior completed findings',
  async (mode) => {
    let first: string | undefined;
    const f = await fixture({
      reply: (prompt, call) => {
        const receipt = /receipt: ([a-f0-9]+)/.exec(prompt)?.[1];
        if (call === 1) {
          first = receipt;
          return { receipt, findings: [{ severity: 'high', text: 'first finding' }] };
        }
        return mode === 'malformed'
          ? { invalid: true }
          : { ...(mode === 'missing' ? {} : { receipt: first }), findings: [] };
      },
    });
    const result = await runAgentReviewer(f.drivers, f.input);
    expect(result.status).not.toBe('ok');
    expect(result.report?.findings).toHaveLength(1);
    expect(result.report?.coverage.partitions.filter((p) => p.complete)).toHaveLength(1);
  },
);

it('shares token allowance across partitions and retains partial findings', async () => {
  const f = await fixture();
  const result = await runAgentReviewer(f.drivers, { ...f.input, maxTokens: 10 });
  expect(result.status).toBe('budget-exhausted');
  expect(f.calls()).toBe(2);
  expect(result.report?.usage).toBe(10);
  expect(result.report?.findings).toHaveLength(1);
});

it.each(['cancel', 'wall'] as const)(
  'stops the remaining review on %s and retains completed coverage',
  async (mode) => {
    const cancel = new AbortController();
    const f = await fixture(mode === 'cancel' ? { cancel } : { hang: true });
    const result = await runAgentReviewer(f.drivers, {
      ...f.input,
      wallMs: mode === 'wall' ? 250 : 10000,
    });
    expect(result.status).toBe('needs-human');
    expect(result.report?.coverage.partitions[0]?.complete).toBe(true);
    expect(result.report?.findings).toHaveLength(1);
    expect(f.calls()).toBe(2);
  },
);

it.each(['hit', 'missing', 'duplicate', 'wire', 'decoded', 'fault'] as const)(
  'fails closed on %s scanner verdicts before provider send',
  async (mode) => {
    const scanner: DiffSecretScanner = (components) => {
      if (mode === 'fault') throw new Error('scanner unavailable');
      if (mode === 'missing') return [];
      if (mode === 'duplicate')
        return [
          ...(clean(components) as Awaited<ReturnType<DiffSecretScanner>>),
          { component: components[0]!.component, hits: [] },
        ];
      return components.map(({ component, path }) => ({
        component,
        hits:
          (mode === 'hit' && path === 'src/a.ts') ||
          (mode === 'wire' && component === 'request') ||
          (mode === 'decoded' && component.startsWith('request-content-'))
            ? [{ ruleId: 'test', lines: [1] }]
            : [],
      }));
    };
    const f = await fixture({ scanner });
    const result = await runAgentReviewer(f.drivers, f.input);
    expect(result.status).not.toBe('ok');
    expect(f.calls()).toBe(0);
  },
);

it('refuses oversized provenance without dispatch and splits an oversized single line losslessly', async () => {
  const f = await fixture();
  const blocked = await runAgentReviewer(f.drivers, { ...f.input, head: 'x'.repeat(21000) });
  expect(blocked.status).toBe('needs-human');
  expect(f.calls()).toBe(0);
  const text = '😀'.repeat(25000);
  const result = await runAgentReviewer(f.drivers, {
    ...f.input,
    components: [{ component: 'untracked:a', path: 'a', text }],
  });
  expect(result.status).toBe('ok');
  if (result.status === 'ok')
    expect(result.value.coverage.partitions.at(-1)?.ranges[0]?.end).toBe(text.length);
});

it.each(['gap', 'overlap', 'missing', 'duplicate', 'context'] as const)(
  'rejects forged %s coverage accounting',
  (mode) => {
    const { coverage } = partitionReview({
      head: 'a'.repeat(40),
      base: 'b'.repeat(40),
      scope: 'full',
      components: [{ component: 'tracked:a', path: 'a', text: large }],
    });
    if (mode === 'gap') coverage.partitions[1]!.ranges[0]!.start++;
    if (mode === 'overlap') coverage.partitions[1]!.ranges[0]!.start--;
    if (mode === 'missing') coverage.partitions.pop();
    if (mode === 'duplicate') coverage.partitions[1]!.receipt = coverage.partitions[0]!.receipt;
    if (mode === 'context') coverage.partitions[1]!.context!.end++;
    expect(ReviewCoverageSchema.safeParse(coverage).success).toBe(false);
  },
);

it('retains untracked original line attribution even for text resembling a diff hunk', async () => {
  const f = await fixture();
  const text = '@@ -900 +800 @@\n' + 'ordinary\n'.repeat(5000);
  const result = await runAgentReviewer(f.drivers, {
    ...f.input,
    components: [{ component: 'untracked:new.txt', path: 'new.txt', text }],
  });
  expect(result.status).toBe('ok');
  const prompt = f.prompts[1]!;
  const rangeStart =
    result.status === 'ok' ? result.value.coverage.partitions[1]!.ranges[0]!.start : 0;
  expect(prompt).toContain(`"newLine":${text.slice(0, rangeStart).split('\n').length}`);
  expect(prompt).not.toContain('"oldLine"');
});

it('refuses zero wall allowance before provider send and zero token allowance before resolving a driver', async () => {
  const f = await fixture();
  expect((await runAgentReviewer(f.drivers, { ...f.input, wallMs: 0 })).status).toBe('needs-human');
  expect((await runAgentReviewer(f.drivers, { ...f.input, maxTokens: 0 })).status).toBe(
    'budget-exhausted',
  );
  expect(f.prompts).toHaveLength(0);
  expect(f.calls()).toBe(0);
});
