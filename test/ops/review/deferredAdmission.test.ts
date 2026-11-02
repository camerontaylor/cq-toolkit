import { afterEach, expect, test, vi } from 'vitest';
import { writeFile } from 'node:fs/promises';
import type { DriverFactory } from '../../../src/driver/factory.js';
import { makeReviewRun } from '../../../src/ops/review/run.js';
import { prepareDeferredVendorReview } from '../../../src/ops/dev/internal/deferredLedger.js';
import { deferVendorReview } from '../../../src/ops/dev/internal/deferredReview.js';
import { readWorkState } from '../../../src/ops/dev/internal/workState.js';
import { devLedgerPath, type DevCycleRecord } from '../../../src/ops/dev/record.js';
import type {
  DeferredQueueClient,
  QueueStatus,
} from '../../../src/ops/review/internal/queueProtocol.js';
import { cycleRecord } from '../dev/fakes.js';
import { makeTestRepo, repoEffects, type TestRepo } from '../dev/repo.js';

const repos: TestRepo[] = [];
afterEach(async () => {
  for (const repo of repos.splice(0)) await repo.cleanup();
});

async function fixture() {
  const repo = await makeTestRepo();
  repos.push(repo);
  await repo.write('.gitignore', '/.cq/\n');
  await repo.write('package.json', JSON.stringify({ name: 'admission-fixture' }));
  await repo.write(
    'cq.json',
    JSON.stringify({
      schemaVersion: 2,
      checks: [{ adapter: 'tsc-lines', command: { command: 'tsc', args: [] } }],
      roles: { reviewer: { provider: 'mock', model: 'mock' } },
      budgets: { run: { maxTokens: 500 } },
      review: { reviewers: ['agent', 'coderabbit'] },
    }),
  );
  repo.commitAll('configure review');
  const effects = repoEffects(repo, (command, args) => {
    if (command === 'gh') return args[0] === 'api' ? 'author' : 'owner/repo';
    if (command === 'coderabbit')
      return {
        exitCode: 0,
        stdout: JSON.stringify({ type: 'complete', status: 'review_completed' }),
        stderr: '',
        timedOut: false,
      };
    return undefined;
  });
  const read = await readWorkState(effects, { target: 'main' });
  if (!read.ok) throw Error(read.reason);
  const state = read.state;
  const status: QueueStatus = {
    state: 'awaiting-pr',
    pr: null,
    mergeSha: null,
    itemId: null,
    receiptId: null,
    consumed: false,
    reviewed: false,
    fixed: false,
  };
  const client: DeferredQueueClient = {
    enqueue: vi.fn(async () => status),
    bind: vi.fn(async () => status),
    cancel: vi.fn(async () => ({ ...status, state: 'cancelled' as const })),
    status: vi.fn(async () => status),
  };
  const origin = cycleRecord({
    head: state.head,
    base: state.base,
    dirtySha256: 'clean-tree',
    cycleId: 'c001-origin',
    vendorFailure: { source: 'vendor', category: 'vendor-rate-limited', codes: ['rate_limited'] },
    completion: { kind: 'blocked', reason: 'structured rate limit' },
  });
  const save = (
    ...records: Parameters<ReturnType<typeof effects.openLedger>['save']>[0]['records']
  ) => effects.openLedger(state.branch).save({ version: 2, branch: state.branch, records });
  save(origin);
  const run = () =>
    makeReviewRun({
      drivers: cleanDrivers(),
      effectsFactory: () => effects,
      queueClient: client,
      scannerFactory: () => async (components) =>
        components.map((component) => ({ component: component.component, hits: [] })),
    })({ repoRoot: repo.root });
  const enroll = async () => {
    const debt = await deferVendorReview(
      client,
      {
        requestId: 'retained',
        binding: {
          kind: 'deferred-author',
          repo: 'owner/repo',
          producer: 'author',
          head: state.head,
          target: 'main',
          targetSelector: 'promoted-main',
        },
      },
      'rate-limited',
      { id: 'retained', base: state.base, dirtySha256: 'clean-tree' },
      {
        cycleId: origin.cycleId,
        head: state.head,
        base: state.base,
        target: 'main',
        scope: 'full',
        dirtySha256: 'clean-tree',
        failure: origin.vendorFailure!,
      },
    );
    save(origin, { kind: 'vendor-debt', debt, at: effects.nowIso() });
    return debt;
  };
  return { repo, effects, state, client, origin, save, run, enroll };
}

function cleanDrivers() {
  return {
    resolve: vi.fn(
      (request: {
        beforeRequest?: (
          text: string,
          contents?: readonly { text: string }[],
          context?: { kind: 'model-request' | 'tool-output' },
        ) => void | Promise<void>;
      }) => ({
        lane: 'ai-sdk',
        modelSpec: { provider: 'mock', model: 'mock' },
        driver: {
          run: async (input: { prompt: string }) => {
            await request.beforeRequest?.(
              JSON.stringify({ prompt: [{ role: 'user', content: input.prompt }] }),
              [{ text: input.prompt }],
              { kind: 'model-request' },
            );
            return {
              stopReason: 'complete',
              structuredOutput: { findings: [] },
              usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
              denials: [],
              toolFailures: 0,
            };
          },
        },
      }),
    ),
  } as unknown as DriverFactory;
}

const staleCases: [string, Partial<DevCycleRecord>][] = [
  ['uncommitted scope', { scope: 'uncommitted' }],
  ['dirty origin', { dirtySha256: 'dirty' }],
  ['old head', { head: 'a'.repeat(40) }],
  ['old base', { base: 'b'.repeat(40) }],
  ['old target', { target: 'other-target' }],
  ['nonblocked attempt', { completion: { kind: 'terminal' } }],
];
for (const [name, patch] of staleCases)
  test(`no debt: ${name} admits a genuine fresh vendor review`, async () => {
    const f = await fixture();
    f.save({ ...f.origin, ...patch });
    const result = await f.run();
    expect(result.status, JSON.stringify(result)).toBe('ok');
    if (result.status !== 'ok') throw Error(JSON.stringify(result));
    expect(result.value.sources.find((source) => source.kind === 'coderabbit')?.status).toBe(
      'terminal',
    );
    expect(result.report?.deferredVendorDebt).toBeUndefined();
    expect(f.effects.calls.filter((call) => call.command === 'coderabbit')).toHaveLength(1);
    expect(f.client.enqueue).not.toHaveBeenCalled();
    expect(
      f.effects
        .openLedger(f.state.branch)
        .load()
        .records.filter((row) => row.kind === 'vendor-debt'),
    ).toHaveLength(0);
  });

test('no debt: dirty current state falls back without claiming debt', async () => {
  const f = await fixture();
  await f.repo.write('src/a.ts', 'export const a = 2;\n');
  const read = await readWorkState(f.effects, { target: 'main' });
  if (!read.ok) throw Error(read.reason);
  expect(
    await prepareDeferredVendorReview(f.effects, 'main', read.state, f.client),
  ).toBeUndefined();
  const result = await f.run();
  expect(f.effects.calls.filter((call) => call.command === 'coderabbit')).toHaveLength(1);
  expect(result.report?.deferredVendorDebt).toBeUndefined();
  expect(f.client.enqueue).not.toHaveBeenCalled();
});

test('persisted debt with dirty current state refuses fresh dispatch and retains evidence', async () => {
  const f = await fixture();
  await f.enroll();
  const before = f.effects.openLedger(f.state.branch).load();
  await f.repo.write('src/a.ts', 'export const a = 2;\n');
  const result = await f.run();
  expect(result.status).toBe('indeterminate');
  expect(f.effects.calls.some((call) => call.command === 'coderabbit')).toBe(false);
  expect(f.effects.openLedger(f.state.branch).load()).toEqual(before);
});

test('persisted queue read uncertainty does not admit fresh review', async () => {
  const f = await fixture();
  await f.enroll();
  const before = f.effects.openLedger(f.state.branch).load();
  f.client.status = async () => {
    throw Error('queue read unavailable');
  };
  const result = await f.run();
  expect(result.status).toBe('indeterminate');
  expect(f.effects.calls.some((call) => call.command === 'coderabbit')).toBe(false);
  expect(f.effects.openLedger(f.state.branch).load()).toEqual(before);
});

test('current eligible attempt with failed durable enrollment stays blocking', async () => {
  const f = await fixture();
  f.client.enqueue = async () => {
    throw Error('persistence unknown');
  };
  const result = await f.run();
  expect(result.status).toBe('indeterminate');
  expect(f.effects.calls.some((call) => call.command === 'coderabbit')).toBe(false);
});

test('duplicate origin identity is trust uncertainty even when the attempt is stale', async () => {
  const f = await fixture();
  const stale = { ...f.origin, head: 'a'.repeat(40) };
  expect(() => f.save(stale, stale)).toThrow(/duplicate record id/);
  // Model a hand-merged corrupt ledger that bypassed the guarded writer.
  await writeFile(
    devLedgerPath(f.repo.root, f.state.branch),
    JSON.stringify({ version: 2, branch: f.state.branch, records: [stale, stale] }),
  );
  const result = await f.run();
  expect(result.status).toBe('indeterminate');
  expect(f.effects.calls.some((call) => call.command === 'coderabbit')).toBe(false);
});

test('malformed persisted failure never becomes a stale-attempt fallback', async () => {
  const f = await fixture();
  const malformed = {
    ...f.origin,
    head: 'a'.repeat(40),
    vendorFailure: { ...f.origin.vendorFailure!, codes: ['scan'] },
  };
  f.save(malformed);
  const result = await f.run();
  expect(result.status).toBe('indeterminate');
  expect(f.effects.calls.some((call) => call.command === 'coderabbit')).toBe(false);
  expect(f.client.enqueue).not.toHaveBeenCalled();
});
