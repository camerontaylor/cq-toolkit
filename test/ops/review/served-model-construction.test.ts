import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { AiSdkDriver } from '../../../src/driver/ai-sdk/index.js';
import { SubprocessDriver } from '../../../src/driver/subprocess/index.js';
import type { Driver, OpInvocation, WorkerResult } from '../../../src/driver/types.js';
import { defaultHarnessConfig } from '../../../src/harness/config.js';
import { makeFixReviewItem, worktreeFixDriver } from '../../../src/ops/review/fixReviewItem.js';
import type { FixReviewItemInput } from '../../../src/ops/review/fixReviewItem.js';
import { registry } from '../../../src/ops/review/registry.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const inputFor = (path: string, provider = 'test-provider'): FixReviewItemInput => ({
  pr: 7,
  item: { id: 'thread-7', path: 'src/a.ts', line: 1, body: 'Check the result.', comments: [] },
  worktree: { path, branch: 'review/pr-7' },
  driver: { model: 'requested-model', provider },
});

// Control and treatment differ only in the observed model. Both inner
// results are complete and carry the same valid, successful fix contract.
const success = (invocation: OpInvocation, observed: boolean): WorkerResult => ({
  stopReason: 'complete',
  structuredOutput: { changed: false, summary: 'Already addressed.', commits: [] },
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  denials: [],
  ...(observed ? { model: invocation.modelSpec.model } : {}),
});

const cases = [
  { label: 'CONTROL observed model', observed: true },
  { label: 'TREATMENT missing model', observed: false },
];

describe('S4 worktreeFixDriver construction', () => {
  test.each(cases)('$label through makeInner', async ({ observed }) => {
    const root = await mkdtemp(join(tmpdir(), 'cq-review-s4-'));
    roots.push(root);
    const run = vi.fn(async (invocation: OpInvocation) => success(invocation, observed));
    const driver = worktreeFixDriver({
      harnessConfig: defaultHarnessConfig,
      worktreePath: root,
      sessionsDir: join(root, 'sessions'),
      makeInner: () => ({ run }),
    });
    const result = await driver.run({
      prompt: 'Fix the review item.',
      modelSpec: inputFor(root).driver,
      toolPolicy: { mode: 'allowlist', allow: [] },
      sandboxPolicy: { level: 'workspace-write' },
      budget: {},
    });
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]?.[0].sessionRef).toBeTypeOf('string');
    if (observed) {
      expect(result.stopReason).toBe('complete');
      expect(result.structuredOutput).toEqual({
        changed: false,
        summary: 'Already addressed.',
        commits: [],
      });
    } else {
      expect(result.stopReason).toBe('error');
      expect(result.error).toContain('served model assertion');
      expect(result.structuredOutput).toBeUndefined();
    }
  });

  // Replace only the concrete driver's transport. The registry importer,
  // perHarness provider selection and worktree adapter remain real.
  describe.each(['test-provider', 'ai-sdk'])('registry perHarness provider %s', (provider) => {
    test.each(cases)('$label through importer', async ({ observed }) => {
      const root = await mkdtemp(join(tmpdir(), 'cq-review-s4-registry-'));
      roots.push(root);
      const prototype = provider === 'ai-sdk' ? AiSdkDriver.prototype : SubprocessDriver.prototype;
      const run = vi
        .spyOn(prototype, 'run')
        .mockImplementation(async (invocation) => success(invocation, observed));
      const entry = registry.find((candidate) => candidate.name === 'review.fixItem');
      expect(entry).toBeDefined();
      const op = await entry!.importer();
      const result = await op(inputFor(root, provider));
      expect(run).toHaveBeenCalledOnce();
      expect(run.mock.calls[0]?.[0].sessionRef).toBeTypeOf('string');
      if (observed) {
        expect(result.status).toBe('ok');
      } else {
        expect(result.status).toBe('failed');
        if (result.status !== 'failed') throw new Error(`unexpected ${result.status}`);
        expect(result.error).toContain('served model assertion');
      }
    });
  });
});

describe('S5 makeFixReviewItem plain Driver construction', () => {
  test.each(cases)('$label through injected Driver', async ({ observed }) => {
    const run = vi.fn(async (invocation: OpInvocation) => success(invocation, observed));
    const driver: Driver = { run };
    const result = await makeFixReviewItem({ driver })(inputFor('/tmp/cq-review-s5'));
    expect(run).toHaveBeenCalledOnce();
    if (observed) {
      expect(result.status).toBe('ok');
    } else {
      expect(result.status).toBe('failed');
      if (result.status !== 'failed') throw new Error(`unexpected ${result.status}`);
      expect(result.error).toContain('served model assertion');
    }
  });
});
