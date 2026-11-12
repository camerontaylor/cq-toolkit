// Split provenance: test/ops/review/agentReviewer-partitions.test.ts was split
// into agentReviewer-partitions.{session,coverage,scan,cancellation,preflight,
// budget,concurrency,failures,retries,exclusions,wire}.test.ts. This file holds
// the real wire-level partition session tests and their fixtures.
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
import type { DriverFactory } from '../../../src/driver/factory.js';
import { runAgentReviewer } from '../../../src/ops/review/agentReviewer.js';
import { baseInput, large, small } from './agentReviewer-partitions.helpers.js';

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
  // The session binding file lives OUTSIDE the model-editable repo root
  // (Annex A, issue #1197); the sibling is cleaned with the root.
  const sessionsDir = `${root}-sessions`;
  roots.push(sessionsDir);
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
        sessionsDir,
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
    // roots.at(-1) is the sessions sibling pushed after the repo root.
    join(roots.at(-1)!, `${value.sessionId}.jsonl`),
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
