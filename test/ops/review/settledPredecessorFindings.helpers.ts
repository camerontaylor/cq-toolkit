// Split provenance: test/ops/review/settledPredecessorFindings.test.ts was split into the
// settledPredecessorFindings.*.test.ts siblings in this directory; the shared
// fixtures and helpers live here.
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, vi } from 'vitest';
import type { DriverFactory } from '../../../src/driver/factory.js';
import {
  importQueueEvidence,
  type QueueEvidence,
} from '../../../src/ops/review/internal/queueEvidence.js';
import type {
  DeferredQueueClient,
  QueueReference,
  QueueStatus,
} from '../../../src/ops/review/internal/queueProtocol.js';
import { deferVendorReview } from '../../../src/ops/dev/internal/deferredReview.js';
import { readWorkState } from '../../../src/ops/dev/internal/workState.js';
import { cycleRecord } from '../dev/fakes.js';
import { makeTestRepo, repoEffects, type TestRepo } from '../dev/repo.js';

async function fixtureIn(repos: TestRepo[]) {
  const repo = await makeTestRepo();
  repos.push(repo);
  // Keep runtime evidence out of the changed-head source commit.
  await repo.write('.gitignore', '/.cq/\n');
  await repo.write('package.json', JSON.stringify({ name: 'settled-fixture' }));
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
    enqueue: async () => status,
    bind: async () => status,
    cancel: async () => ({ ...status, state: 'cancelled' }),
    status: async () => status,
  };
  const failure = {
    source: 'vendor' as const,
    category: 'vendor-rate-limited' as const,
    codes: ['rate_limited'],
  };
  const origin = cycleRecord({
    head: state.head,
    base: state.base,
    dirtySha256: 'clean-tree',
    cycleId: 'c001-origin',
    vendorFailure: failure,
    completion: { kind: 'blocked', reason: 'structured rate limit' },
  });
  const debt = await deferVendorReview(
    client,
    {
      requestId: 'predecessor',
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
    { id: 'predecessor', base: state.base, dirtySha256: 'clean-tree' },
    {
      cycleId: origin.cycleId,
      head: state.head,
      base: state.base,
      target: 'main',
      scope: 'full',
      dirtySha256: 'clean-tree',
      failure,
    },
  );
  effects.openLedger(state.branch).save({
    version: 2,
    branch: state.branch,
    records: [origin, { kind: 'vendor-debt', debt, at: effects.nowIso() }],
  });
  return { repo, effects, state, debt, client };
}

export type Fixture = Awaited<ReturnType<typeof fixtureIn>>;

/**
 * Per-test-file fixture binding: each caller gets its own repo registry, and
 * that file's own `afterEach` hook cleans the repos it created.
 */
export function fixtureFactory(): () => Promise<Fixture> {
  const repos: TestRepo[] = [];
  afterEach(async () => {
    for (const repo of repos.splice(0)) await repo.cleanup();
  });
  return () => fixtureIn(repos);
}

export function cleanDrivers() {
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
function canonicalReceipt(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalReceipt).join(',') + ']';
  if (value !== null && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => JSON.stringify(key) + ':' + canonicalReceipt(item))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
const digestReceipt = (value: unknown) =>
  createHash('sha256').update(canonicalReceipt(value)).digest('hex');

export function terminalReport(f: Fixture, findings: Record<string, unknown>[] = []) {
  const paths = [
    {
      source_path: 'src/a.ts',
      path: 'src/a.ts',
      resolution: 'same-path-current',
      disposition: 'included',
      blob: f.repo.git('rev-parse', 'HEAD:src/a.ts').trim(),
      mode: '100644',
      bytes: 20,
    },
  ];
  const captureIdentity = {
    target: f.state.head,
    tree: f.repo.git('rev-parse', 'HEAD^{tree}').trim(),
    paths,
    scope_digest: digestReceipt(paths),
    policy: 'affected-current-additions-v1',
    projection: 'current-affected-files/full-file-addition-projection',
    reviewer: 'coderabbit-review-agent-committed-v1',
    reviewer_version: 'fixture-v1',
  };
  const document = {
    version: 1,
    source: {
      repo: 'owner/repo',
      pr: 42,
      merge_sha: f.state.head,
      target_selector: 'promoted-main',
      policy: 'affected-current-additions-v1',
    },
    capture: {
      ...captureIdentity,
      equivalence: digestReceipt(captureIdentity),
      captured_at: '2026-10-28T00:00:00Z',
    },
    item_id: 'current-fixture',
    request_id: f.debt.reference.requestId,
    outcome: findings.length ? 'terminal-with-findings' : 'terminal-clean',
    counted: true,
    classification: { counted: true, outcome: 'completed', findings: findings.length },
    findings,
    run_id: 'genuine-run',
    started_at: '2026-10-28T00:00:00Z',
    artifacts: {},
    remediation: 'disabled/deferred',
    independent_acceptance: false,
    cli_functional_acceptance: 'pending-D1',
  };
  let receiptId = '';
  let consumed = false;
  let deliveries = 0;
  const client = {
    ...f.client,
    status: async (): Promise<QueueStatus> => ({
      ...f.debt.queue,
      state: findings.length ? 'terminal-with-findings' : 'terminal-clean',
      pr: 42,
      mergeSha: f.state.head,
      itemId: 'current-fixture',
      receiptId: receiptId || createHash('sha256').update(JSON.stringify(document)).digest('hex'),
      reviewed: true,
      consumed,
    }),
    report: async (_ref: QueueReference, root: string): Promise<QueueEvidence> => {
      deliveries++;
      const bytes = Buffer.from(JSON.stringify(document));
      receiptId = createHash('sha256').update(bytes).digest('hex');
      const evidence = await importQueueEvidence(root, receiptId, bytes);
      consumed = true;
      return evidence;
    },
  };
  return { client, document, deliveries: () => deliveries };
}

/** A verified successor receipt at `head`, imported the way the queue report path does. */
export async function successorReceipt(
  f: Fixture,
  requestId: string,
  head: string,
): Promise<QueueEvidence> {
  const paths = [
    {
      source_path: 'src/a.ts',
      path: 'src/a.ts',
      resolution: 'same-path-current',
      disposition: 'included',
      blob: f.repo.git('rev-parse', `${head}:src/a.ts`).trim(),
      mode: '100644',
      bytes: 20,
    },
  ];
  const captureIdentity = {
    target: head,
    tree: f.repo.git('rev-parse', `${head}^{tree}`).trim(),
    paths,
    scope_digest: digestReceipt(paths),
    policy: 'affected-current-additions-v1',
    projection: 'current-affected-files/full-file-addition-projection',
    reviewer: 'coderabbit-review-agent-committed-v1',
    reviewer_version: 'fixture-v1',
  };
  const document = {
    version: 1,
    source: {
      repo: 'owner/repo',
      pr: 42,
      merge_sha: head,
      target_selector: 'promoted-main',
      policy: 'affected-current-additions-v1',
    },
    capture: {
      ...captureIdentity,
      equivalence: digestReceipt(captureIdentity),
      captured_at: '2026-10-28T00:00:00Z',
    },
    item_id: 'successor-item',
    request_id: requestId,
    outcome: 'terminal-clean',
    counted: true,
    classification: { counted: true, outcome: 'completed', findings: 0 },
    findings: [],
    run_id: 'genuine-successor-run',
    started_at: '2026-10-28T00:00:00Z',
    artifacts: {},
    remediation: 'disabled/deferred',
    independent_acceptance: false,
    cli_functional_acceptance: 'pending-D1',
  };
  const bytes = Buffer.from(JSON.stringify(document));
  const receiptId = createHash('sha256').update(bytes).digest('hex');
  return importQueueEvidence(join(f.repo.root, '.cq', 'queue-evidence'), receiptId, bytes);
}
