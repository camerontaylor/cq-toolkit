import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import type { DriverFactory } from '../../../src/driver/factory.js';
import type { CqConfig } from '../../../src/ops/analyze/cqConfig.js';
import { makeDevDisposition } from '../../../src/ops/dev/disposition.js';
import { readWorkState } from '../../../src/ops/dev/internal/workState.js';
import { deferVendorReview } from '../../../src/ops/dev/internal/deferredReview.js';
import { makeReviewRun } from '../../../src/ops/review/run.js';
import { makeReviewAddress } from '../../../src/ops/review/address.js';
import type { Finding, FindingsRecord } from '../../../src/ops/review/findings.js';
import type {
  DeferredQueueClient,
  QueueStatus,
} from '../../../src/ops/review/internal/queueProtocol.js';
import {
  restoreDurableDisposition,
  sameFindingContent,
} from '../../../src/ops/review/internal/durableDisposition.js';
import { cycleRecord, dispositionRecord, ledgerWith } from '../dev/fakes.js';
import { makeTestRepo, repoEffects } from '../dev/repo.js';

const finding: Finding = {
  id: 'c001-original#f1',
  source: 'coderabbit',
  text: 'original finding',
  file: 'src/a.ts',
  severity: 'major',
  status: 'open',
};
const raw = {
  id: finding.id,
  excerpt: finding.text,
  fileName: finding.file!,
  severity: finding.severity,
};
const original = () => cycleRecord({ cycleId: 'c001-original', findings: [raw] });
const config: CqConfig = {
  schemaVersion: 2,
  checks: [{ adapter: 'tsc-lines', command: { command: process.execPath, args: [] } }],
  roles: { worker: { provider: 'mock', model: 'mock' } },
  budgets: { run: { maxTokens: 1000 } },
  review: { reviewers: ['coderabbit'] },
};
const drivers = () =>
  ({
    resolve: vi.fn(() => {
      throw new Error('no model call authorized');
    }),
  }) as unknown as DriverFactory;

test.each(['fixed', 'rejected'] as const)(
  'unchanged real-ledger %s survives ordinary terminal reuse',
  async (action) => {
    const repo = await makeTestRepo();
    try {
      await repo.write('.gitignore', '/.cq/\n');
      await repo.write('cq.json', JSON.stringify(config));
      repo.commitAll('configure offline reuse');
      const effects = repoEffects(repo);
      const read = await readWorkState(effects, { target: 'merge-queue' });
      if (!read.ok) throw new Error(read.reason);
      const { state } = read;
      const cycle = cycleRecord({
        cycleId: 'c001-original',
        base: state.base,
        head: state.head,
        dirtySha256: state.dirtySha256,
        findings: [raw],
      });
      const store = effects.openLedger(state.branch);
      store.save({ version: 2, branch: state.branch, records: [cycle] });
      const adjudicated = await makeDevDisposition(effects)({
        repoRoot: repo.root,
        findingId: finding.id,
        action,
        why: 'genuine durable adjudication',
      });
      expect(adjudicated.status).toBe('ok');
      const immutable = store.load().records;
      const result = await makeReviewRun({
        drivers: drivers(),
        effectsFactory: () => effects,
        scannerFactory: () => async (components) =>
          components.map((component) => ({ component: component.component, hits: [] })),
      })({ repoRoot: repo.root });
      expect(result.status, JSON.stringify(result)).toBe('ok');
      if (result.status !== 'ok') return;
      expect(result.value.findings).toEqual([
        { ...finding, status: action, reason: 'genuine durable adjudication' },
      ]);
      expect(result.value.head).toBe(state.head);
      expect(result.value.sources).toEqual([
        { kind: 'coderabbit', status: 'terminal', cycleId: cycle.cycleId },
      ]);
      expect(effects.calls.some((call) => call.command === 'coderabbit')).toBe(false);
      expect(store.load().records.slice(0, immutable.length)).toEqual(immutable);
      expect(store.load().records.filter((record) => record.kind === 'cycle')).toEqual([cycle]);
      expect(store.load().records.some((record) => record.kind === 'reuse')).toBe(true);
    } finally {
      await repo.cleanup();
    }
  },
);

test('missing durable disposition stays open despite cached status/reason', () => {
  expect(
    restoreDurableDisposition(
      { ...finding, status: 'fixed', reason: 'cached' },
      ledgerWith([original()]),
    ),
  ).toEqual(finding);
});

test('latest genuine disposition wins in append order without rewriting evidence', () => {
  const ledger = ledgerWith([
    original(),
    dispositionRecord({ findingId: finding.id, action: 'fixed', why: 'first' }),
    dispositionRecord({ findingId: finding.id, action: 'rejected', why: 'latest' }),
  ]);
  const bytes = JSON.stringify(ledger);
  expect(restoreDurableDisposition(finding, ledger)).toEqual({
    ...finding,
    status: 'rejected',
    reason: 'latest',
  });
  expect(JSON.stringify(ledger)).toBe(bytes);
});

test('original evidence must precede disposition; import-only evidence cannot authenticate content', () => {
  const disposition = dispositionRecord({ findingId: finding.id });
  expect(restoreDurableDisposition(finding, ledgerWith([disposition, original()]))).toEqual(
    finding,
  );
  expect(
    restoreDurableDisposition(
      finding,
      ledgerWith([{ ...original(), reviewer: 'review.address:import' }, disposition]),
    ),
  ).toEqual(finding);
});

test.each([
  { text: 'different text' },
  { file: 'src/other.ts' },
  { severity: 'critical' },
  { source: 'agent' },
  { line: 7 },
  { rule: 'new-rule' },
])('changed normalized content %j cannot inherit a disposition', (change) => {
  const incoming = { ...finding, ...change };
  const ledger = ledgerWith([original(), dispositionRecord({ findingId: finding.id })]);
  expect(sameFindingContent(incoming, finding)).toBe(false);
  expect(restoreDurableDisposition(incoming, ledger)).toEqual(incoming);
});

test('later same-ID raw content collision invalidates earlier disposition', () => {
  const ledger = ledgerWith([
    original(),
    dispositionRecord({ findingId: finding.id }),
    cycleRecord({ findings: [{ ...raw, excerpt: 'colliding later content' }] }),
  ]);
  expect(restoreDurableDisposition(finding, ledger)).toEqual(finding);
});

test('changed head cannot gain current review coverage from settled old findings', async () => {
  const repo = await makeTestRepo();
  try {
    await repo.write('.gitignore', '/.cq/\n');
    await repo.write('cq.json', JSON.stringify(config));
    repo.commitAll('configure offline stale head');
    const effects = repoEffects(repo, (command) =>
      command === 'coderabbit'
        ? {
            exitCode: 1,
            stdout: JSON.stringify({ type: 'error', errorType: 'auth', recoverable: false }) + '\n',
            stderr: '',
            timedOut: false,
          }
        : undefined,
    );
    const read = await readWorkState(effects, { target: 'merge-queue' });
    if (!read.ok) throw new Error(read.reason);
    const { state } = read;
    const store = effects.openLedger(state.branch);
    const cycle = cycleRecord({
      base: state.base,
      head: state.head,
      dirtySha256: state.dirtySha256,
      findings: [raw],
    });
    store.save({ version: 2, branch: state.branch, records: [cycle] });
    expect(
      (
        await makeDevDisposition(effects)({
          repoRoot: repo.root,
          findingId: finding.id,
          action: 'rejected',
          why: 'old evidence',
        })
      ).status,
    ).toBe('ok');
    await repo.write('src/a.ts', 'export const a = 2;\n');
    repo.commitAll('new head');
    const result = await makeReviewRun({
      drivers: drivers(),
      effectsFactory: () => effects,
      scannerFactory: () => async (components) =>
        components.map((component) => ({ component: component.component, hits: [] })),
    })({ repoRoot: repo.root });
    expect(result.status).toBe('needs-human');
    expect(
      result.report?.sources.some(
        (source) => source.kind === 'coderabbit' && source.status === 'terminal',
      ),
    ).toBe(false);
    expect(store.load().records.some((record) => record.kind === 'reuse')).toBe(false);
    expect(store.load().records[0]).toEqual(cycle);
  } finally {
    await repo.cleanup();
  }
});

test.each([{}, { text: 'new text' }, { file: 'src/other.ts' }, { severity: 'critical' }])(
  'address overlays only unchanged original content: %j',
  async (change) => {
    const repo = await makeTestRepo();
    const journalDir = await mkdtemp(join(tmpdir(), 'cq-content-collision-'));
    try {
      await repo.write('.gitignore', '/.cq/\n');
      await repo.write('cq.json', JSON.stringify(config));
      repo.commitAll('configure collision');
      const effects = repoEffects(repo);
      const read = await readWorkState(effects, { target: 'merge-queue' });
      if (!read.ok) throw new Error(read.reason);
      const { state } = read;
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
      const queue: DeferredQueueClient = {
        enqueue: async () => status,
        bind: async () => status,
        status: async () => status,
        cancel: async () => {
          throw new Error('no cancellation');
        },
      };
      const debt = await deferVendorReview(
        queue,
        {
          requestId: 'original-intent',
          binding: {
            kind: 'deferred-author',
            repo: 'owner/repo',
            producer: 'author',
            head: state.head,
            target: 'merge-queue',
            targetSelector: 'promoted-main',
          },
        },
        'unavailable',
        { id: 'original-intent', base: state.base, dirtySha256: 'clean-tree' },
        {
          cycleId: 'outage',
          head: state.head,
          base: state.base,
          target: 'merge-queue',
          scope: 'full',
          dirtySha256: 'clean-tree',
          failure: { source: 'vendor', category: 'vendor-unavailable', codes: ['con_err'] },
        },
      );
      const incoming = { ...finding, ...change };
      const record: FindingsRecord = {
        schemaVersion: 1,
        branch: state.branch,
        head: state.head,
        reviewed: { base: state.base, scope: 'full' },
        sources: [{ kind: 'coderabbit', status: 'terminal', cycleId: 'c001-original' }],
        findings: [incoming],
      };
      const workerFactory = vi.fn(() => {
        throw new Error('changed content must not dispatch');
      });
      const result = await makeReviewAddress({
        config,
        initialRecord: record,
        workerFactory,
        resolveDeferredVendorContext: async () => ({
          debt,
          identity: {
            repo: 'owner/repo',
            producer: 'author',
            target: 'merge-queue',
            head: state.head,
            base: state.base,
            dirtySha256: state.dirtySha256,
            deferralId: debt.deferral.id,
          },
          findings: [{ ...finding, status: 'fixed', reason: 'retained old content fixed' }],
        }),
      })({ repoRoot: repo.root, source: 'local', journalDir });
      if (Object.keys(change).length === 0) {
        expect(result.status, JSON.stringify(result)).toBe('ok');
        if (result.status === 'ok')
          expect(result.value.findings).toEqual([
            { ...finding, status: 'fixed', reason: 'retained old content fixed' },
          ]);
      } else {
        expect(result.status, JSON.stringify(result)).toBe('needs-human');
        if (result.status === 'needs-human')
          expect(result.reason).toContain('conflicting retained finding identity');
        expect(record.findings).toEqual([incoming]);
      }
      expect(workerFactory).not.toHaveBeenCalled();
    } finally {
      await repo.cleanup();
      await rm(journalDir, { recursive: true, force: true });
    }
  },
);
