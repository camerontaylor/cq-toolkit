// Split provenance: test/ops/review/reviewSession-wire.test.ts was split into
// reviewSession-wire.modelRequest.test.ts, reviewSession-wire.toolOutput.test.ts,
// reviewSession-wire.unknownHook.test.ts, reviewSession-wire.denials.test.ts,
// reviewSession-wire.capabilities.test.ts, reviewSession-wire.outerReviewer.test.ts,
// reviewSession-wire.rateLimitRetry.test.ts and
// reviewSession-wire.rateLimitRefusal.test.ts. The wire fixtures below are
// shared by all of them.
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, expect } from 'vitest';
import {
  AiSdkDriver,
  RG_MINIMUM_VERSION,
  type AiSdkDriverOptions,
} from '../../../src/driver/ai-sdk/index.js';
import type { DriverFactory } from '../../../src/driver/factory.js';
import type { DiffSecretScanner, ScanComponentInput } from '../../../src/ops/dev/denylist.js';
import { createReviewPlan } from '../../../src/ops/review/internal/reviewPlan.js';
import { runReviewSession } from '../../../src/ops/review/internal/reviewSession.js';
import type { ReviewCoverageV2 } from '../../../src/ops/review/internal/reviewCoverageV2.js';

export const sha = (text: string) => createHash('sha256').update(text).digest('hex');
export const DIFF =
  'diff --git a/src/a.ts b/src/a.ts\n' +
  '--- a/src/a.ts\n' +
  '+++ b/src/a.ts\n' +
  '@@ -1 +1,2 @@\n' +
  '-old\n' +
  '+new\n' +
  '+added\n';
export const COMPONENT = { component: 'tracked:src/a.ts', path: 'src/a.ts', text: DIFF };
export const role = { provider: 'mock', model: 'mock-1' };
export const severityMap = { high: 'major', medium: 'minor', low: 'trivial' };

export type SessionPlan = Parameters<typeof runReviewSession>[1]['plan'];
export type WireCall = {
  text: string;
  contents: { text: string; path?: string }[];
  kind?: 'model-request' | 'tool-output';
};

const roots: string[] = [];

/**
 * Registers the per-test scratch-root cleanup the wire suites share. Call once
 * at module scope in every test file that needs it.
 */
export function useScratchRoots(): void {
  afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  });
}

export async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cq-review-wire-'));
  roots.push(root);
  await mkdir(join(root, 'src'), { recursive: true });
  return root;
}

/**
 * A sessions dir OUTSIDE the bound repo root (Annex A, issue #1197: the
 * session binding file must live outside the model-editable tree).
 * Registered in the shared roots cleanup alongside the repo root.
 */
export async function scratchSessions(root: string): Promise<string> {
  const dir = `${root}-sessions`;
  roots.push(dir);
  await mkdir(dir, { recursive: true });
  return dir;
}

const mockUsage = () => ({
  inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 2, text: 2, reasoning: 0 },
});

export function textResult(text: string) {
  return {
    content: [{ type: 'text' as const, text }],
    finishReason: { unified: 'stop' as const, raw: undefined },
    usage: mockUsage(),
    warnings: [],
  };
}

export function toolCallResult(tool: string, input: unknown) {
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

export function recordingScanner(
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

export function planFor(): SessionPlan {
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

export function evidenceFor(): ReviewCoverageV2['sessions'][number] {
  return {
    id: 'session-1',
    status: 'error',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    deliveries: [],
    requests: [],
  };
}

export function expectUserPrompt(serialized: string, prompt: string): void {
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

export function wireFactory(
  root: string,
  model: MockLanguageModelV4,
  calls: WireCall[],
  options: { resolveRg?: AiSdkDriverOptions['resolveRg']; sessionsDir?: string } = {},
): DriverFactory {
  // The default sibling is registered for the shared afterEach cleanup
  // here (the store creates it at first write; rm with force tolerates a
  // run that never reaches it).
  const sessionsDir = options.sessionsDir ?? `${root}-sessions`;
  if (options.sessionsDir === undefined && !roots.includes(sessionsDir)) roots.push(sessionsDir);
  return {
    resolve: (request) => {
      const driver = new AiSdkDriver({
        // The session binding file lives OUTSIDE the model-editable repo
        // root (Annex A, issue #1197).
        sessionsDir,
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

export function runInput(
  root: string,
  plan: SessionPlan,
  evidence: ReviewCoverageV2['sessions'][number],
) {
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
