import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import type { DriverFactory } from '../../../src/driver/factory.js';
import type { DevEffects } from '../../../src/ops/dev/effects.js';
import type { DevLedgerFile } from '../../../src/ops/dev/record.js';
import { prepareDeferredVendorReview } from '../../../src/ops/dev/internal/deferredLedger.js';
import { readWorkState } from '../../../src/ops/dev/internal/workState.js';
import { makeReviewRun } from '../../../src/ops/review/run.js';
import type { ReviewRunDeps } from '../../../src/ops/review/run.js';
import { makeQueueClient } from '../../../src/ops/review/internal/queueClient.js';
import { importQueueEvidence } from '../../../src/ops/review/internal/queueEvidence.js';
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

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => JSON.stringify(key) + ':' + canonical(item))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');

const drivers: DriverFactory = {
  resolve: (request) => ({
    lane: 'ai-sdk',
    modelSpec: request.modelSpec,
    driver: {
      run: async (input) => {
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
};

type Mode =
  | 'findings'
  | 'clean'
  | 'pending'
  | 'callback-fails'
  | 'callback-missing'
  | 'append-then-error'
  | 'report-fails'
  | 'foreign-source'
  | 'external-append'
  | 'external-completed';

async function fixture(mode: Mode) {
  const repo = await makeTestRepo();
  repos.push(repo);
  await repo.write('.gitignore', '/.cq/\n');
  await repo.write(
    'cq.json',
    JSON.stringify({
      schemaVersion: 2,
      checks: [{ adapter: 'tsc-lines', command: { command: 'tsc', args: [] } }],
      roles: { reviewer: { provider: 'mock', model: 'mock' } },
      budgets: { run: { maxTokens: 1000 } },
      review: { reviewers: ['agent', 'coderabbit'] },
    }),
  );
  repo.commitAll('configure final refresh fixture');
  const real = repoEffects(repo, (command, args) => {
    if (command === 'gh') return args[0] === 'api' ? 'author' : 'owner/repo';
    throw new Error('unexpected offline command: ' + command);
  });
  const read = await readWorkState(real, { target: 'merge-queue' });
  if (!read.ok) throw new Error(read.reason);
  const state = read.state;
  const pending: QueueStatus = {
    state: 'awaiting-pr',
    pr: null,
    mergeSha: null,
    itemId: null,
    receiptId: null,
    consumed: false,
    reviewed: false,
    fixed: false,
  };
  // report is an optional capability, deliberately absent from DeferredQueueClient.
  const client: DeferredQueueClient & Pick<ReturnType<typeof makeQueueClient>, 'report'> = {
    enqueue: async () => pending,
    bind: async () => pending,
    cancel: async () => {
      throw new Error('must not cancel debt');
    },
    status: async () => pending,
    report: async () => {
      throw new Error('receipt not yet available');
    },
  };
  const origin = cycleRecord({
    cycleId: 'genuine-outage',
    head: state.head,
    base: state.base,
    dirtySha256: 'clean-tree',
    vendorFailure: { source: 'vendor', category: 'vendor-rate-limited', codes: ['rate_limited'] },
    completion: { kind: 'blocked', reason: 'typed vendor rate limit' },
  });
  const store = real.openLedger(state.branch);
  store.save({ version: 2, branch: state.branch, records: [origin] });
  const debt = await prepareDeferredVendorReview(real, 'merge-queue', state, client);
  if (!debt) throw new Error('missing genuine persisted debt');
  const paths = [
    {
      source_path: 'src/a.ts',
      path: 'src/a.ts',
      resolution: 'same-path-current',
      disposition: 'included',
      blob: repo.git('rev-parse', 'HEAD:src/a.ts').trim(),
      mode: '100644',
      bytes: Buffer.byteLength(repo.git('show', 'HEAD:src/a.ts')),
    },
  ];
  const capture = {
    target: state.head,
    tree: repo.git('rev-parse', 'HEAD^{tree}').trim(),
    paths,
    scope_digest: digest(paths),
    policy: 'affected-current-additions-v1',
    projection: 'current-affected-files/full-file-addition-projection',
    reviewer: 'coderabbit-review-agent-committed-v1',
    reviewer_version: 'offline-v1',
  };
  const findings = mode === 'clean' ? [] : [{ severity: 'major', text: 'late retained finding' }];
  const document = {
    version: 1,
    item_id: 'current-final',
    request_id: debt.reference.requestId,
    source: {
      repo: mode === 'foreign-source' ? 'other/repo' : 'owner/repo',
      pr: 42,
      merge_sha: state.head,
      target_selector: 'promoted-main',
      policy: capture.policy,
    },
    capture: { ...capture, equivalence: digest(capture), captured_at: '2026-10-28T00:00:00Z' },
    outcome: findings.length ? 'terminal-with-findings' : 'terminal-clean',
    counted: true,
    classification: { counted: true, outcome: 'completed' },
    findings,
    run_id: 'offline-run',
    started_at: '2026-10-28T00:00:00Z',
    artifacts: {},
    remediation: 'disabled/deferred',
    independent_acceptance: false,
    cli_functional_acceptance: 'pending-D1',
  };
  const bytes = Buffer.from(JSON.stringify(document));
  const receiptId = createHash('sha256').update(bytes).digest('hex');
  let final = false;
  let consumed = false;
  let appendedExternal = false;
  const events: string[] = [];
  const terminal = (): QueueStatus => ({
    ...pending,
    state: findings.length ? 'terminal-with-findings' : 'terminal-clean',
    pr: 42,
    mergeSha: state.head,
    itemId: document.item_id,
    receiptId,
    reviewed: true,
    consumed,
  });
  client.status = async () => {
    if (!final || mode === 'pending') return pending;
    if (mode === 'external-append' && !appendedExternal) {
      appendedExternal = true;
      const latest = store.load();
      store.save({
        ...latest,
        records: [...latest.records, { ...origin, cycleId: 'external-write' }],
      });
    }
    return terminal();
  };
  client.report = async (reference, root, options) => {
    expect(final).toBe(true);
    expect(reference).toEqual(debt.reference);
    const evidence = await importQueueEvidence(root, receiptId, bytes);
    await options?.onEvidenceImported?.({ receiptId, path: join(root, receiptId + '.json') });
    if (mode === 'report-fails') throw new Error('ack outcome unknown');
    consumed = true;
    if (mode === 'external-completed') {
      const latest = store.load();
      store.save({
        ...latest,
        records: [
          ...latest.records,
          {
            kind: 'vendor-debt',
            at: real.nowIso(),
            debt: {
              ...debt,
              queue: terminal(),
              vendor: 'vendor-completed',
              vendorCompleted: true,
              completion: evidence,
            },
          },
        ],
      });
    }
    return evidence;
  };
  const effects: DevEffects = {
    ...real,
    openLedger: () => ({
      ...store,
      mutate: async <T>(fn: (ledger: DevLedgerFile) => { ledger: DevLedgerFile; value: T }) => {
        const value = await store.mutate(fn);
        if (final && mode === 'append-then-error') throw new Error('settlement reply lost');
        return value;
      },
    }),
  };
  const deps: ReviewRunDeps = {
    drivers,
    effectsFactory: () => effects,
    queueClient: client,
    scannerFactory: () => async (components) =>
      components.map((component) => ({
        component: component.component,
        hits: [],
      })),
    writeFindingsRecord: async (path, content) => {
      await writeFile(path, content, { flag: 'wx' });
      events.push('findings-written');
      final = true;
    },
    onEvidenceImported: async ({ path, receiptId: id }) => {
      expect(
        createHash('sha256')
          .update(await readFile(path))
          .digest('hex'),
      ).toBe(id);
      events.push('receipt-observed');
    },
    ...(mode === 'callback-missing'
      ? {}
      : {
          noteLedgerWrite: async (branch: string, root: string) => {
            expect(branch).toBe(state.branch);
            expect(root).toBe(repo.root);
            if (!final) return;
            expect(store.load().records.at(-1)).toMatchObject({
              kind: 'vendor-debt',
              debt: { vendorCompleted: true },
            });
            // It must finish before an unseen-findings/exceptional return can settle.
            await Promise.resolve();
            events.push('ledger-observed');
            if (mode === 'callback-fails') throw new Error('ownership notification refused');
          },
        }),
  };
  return {
    repo,
    store,
    state,
    debt,
    events,
    run: () => makeReviewRun(deps)({ repoRoot: repo.root }),
  };
}

test.each(['findings', 'clean', 'append-then-error'] as const)(
  'late verified final settlement notifies durable ledger ownership before exit: %s',
  async (mode) => {
    const f = await fixture(mode);
    const result = await f.run();
    expect(f.events).toEqual(['findings-written', 'receipt-observed', 'ledger-observed']);
    expect(f.store.load().records.at(-1)).toMatchObject({
      kind: 'vendor-debt',
      debt: { vendorCompleted: true },
    });
    if (mode === 'clean') expect(result.status, JSON.stringify(result)).toBe('ok');
    else {
      expect(result.status, JSON.stringify(result)).toBe('needs-human');
      if (result.status !== 'needs-human') throw new Error('expected visible debt/findings');
      expect(result.reason).toContain(
        mode === 'findings' ? 'newly consumed vendor findings' : 'settlement reply lost',
      );
      if (mode === 'findings')
        expect(result.report?.findings).toMatchObject([{ text: 'late retained finding' }]);
    }
  },
);

test.each(['callback-fails', 'callback-missing'] as const)(
  'failed or absent ownership callback prevents final settlement credit: %s',
  async (mode) => {
    const f = await fixture(mode);
    const result = await f.run();
    expect(result.status, JSON.stringify(result)).toBe('needs-human');
    expect(f.store.load().records.at(-1)).toMatchObject({
      kind: 'vendor-debt',
      debt: { vendorCompleted: true },
    });
    if (result.status !== 'needs-human') throw new Error('expected ownership refusal');
    expect(result.reason).toContain(
      mode === 'callback-fails'
        ? 'ownership notification refused'
        : 'requires ledger ownership notification',
    );
  },
);

test.each([
  'pending',
  'report-fails',
  'foreign-source',
  'external-append',
  'external-completed',
] as const)('no recognized settlement append grants no new ownership: %s', async (mode) => {
  const f = await fixture(mode);
  const result = await f.run();
  expect(result.status, JSON.stringify(result)).toBe('needs-human');
  expect(f.events).not.toContain('ledger-observed');
  expect(f.store.load().records.filter((row) => row.kind === 'vendor-debt')).toHaveLength(
    mode === 'external-completed' ? 2 : 1,
  );
  if (mode !== 'external-completed')
    expect(f.store.load().records.at(-1)).not.toMatchObject({ debt: { vendorCompleted: true } });
  if (['external-append', 'external-completed'].includes(mode) && result.status === 'needs-human')
    expect(result.reason).toContain('unrecognized ledger bytes');
});
