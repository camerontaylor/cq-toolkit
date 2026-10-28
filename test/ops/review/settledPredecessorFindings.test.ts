import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import type { DriverFactory } from '../../../src/driver/factory.js';
import { makeReviewRun } from '../../../src/ops/review/run.js';
import {
  importQueueEvidence,
  type QueueEvidence,
} from '../../../src/ops/review/internal/queueEvidence.js';
import type {
  DeferredQueueClient,
  QueueReference,
  QueueStatus,
} from '../../../src/ops/review/internal/queueProtocol.js';
import {
  deferVendorReview,
  type DeferredVendorDebt,
} from '../../../src/ops/dev/internal/deferredReview.js';
import {
  retainedReceiptFindings,
  prepareDeferredVendorReview,
} from '../../../src/ops/dev/internal/deferredLedger.js';
import { readWorkState } from '../../../src/ops/dev/internal/workState.js';
import { assembleReadiness } from '../../../src/ops/dev/record.js';
import { cycleRecord, dispositionRecord } from '../dev/fakes.js';
import { makeTestRepo, repoEffects, type TestRepo } from '../dev/repo.js';

const repos: TestRepo[] = [];
afterEach(async () => {
  for (const repo of repos.splice(0)) await repo.cleanup();
});

async function fixture() {
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
  const read = await readWorkState(effects, { target: 'merge-queue' });
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
        target: 'merge-queue',
        targetSelector: 'promoted-main',
      },
    },
    'rate-limited',
    { id: 'predecessor', base: state.base, dirtySha256: 'clean-tree' },
    {
      cycleId: origin.cycleId,
      head: state.head,
      base: state.base,
      target: 'merge-queue',
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

function terminalReport(
  f: Awaited<ReturnType<typeof fixture>>,
  findings: Record<string, unknown>[] = [],
) {
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

test.each(['major', 'clean'] as const)(
  'newly settled %s predecessor survives fresh changed-head review without coverage credit',
  async (mode) => {
    const f = await fixture();
    const raw = {
      type: 'finding',
      severity: 'major',
      fileName: 'src/a.ts',
      comment: 'retained original comment',
      codegenInstructions: 'original repair guidance',
    };
    const terminal = terminalReport(f, mode === 'major' ? [raw] : []);
    await f.repo.write('src/a.ts', 'export const a = 2;\n');
    f.repo.commitAll('new head');
    const notifications: { settled: boolean; beforeVendor: boolean }[] = [];
    const note = vi.fn(async () => {
      const latest = f.effects.openLedger(f.state.branch).load();
      notifications.push({
        settled: latest.records.some(
          (entry) => entry.kind === 'vendor-debt' && entry.debt.vendorCompleted,
        ),
        beforeVendor: !f.effects.calls.some((call) => call.command === 'coderabbit'),
      });
    });
    const result = await makeReviewRun({
      drivers: cleanDrivers(),
      queueClient: terminal.client,
      effectsFactory: () => f.effects,
      noteLedgerWrite: note,
      scannerFactory: () => async (components) =>
        components.map((component) => ({ component: component.component, hits: [] })),
    })({ repoRoot: f.repo.root });
    expect(result.status, JSON.stringify(result)).toBe('ok');
    if (result.status !== 'ok') throw Error(JSON.stringify(result));
    const ledger = f.effects.openLedger(f.state.branch).load();
    const retained = retainedReceiptFindings(ledger);
    expect(result.report?.deferredVendorDebt).toBeUndefined();
    expect(result.value.head).toBe(f.repo.git('rev-parse', 'HEAD').trim());
    expect(result.value.sources.filter((s) => s.kind === 'coderabbit')).toHaveLength(1);
    expect(result.value.sources.find((s) => s.kind === 'coderabbit')).toMatchObject({
      status: 'terminal',
    });
    expect(f.effects.calls.filter((c) => c.command === 'coderabbit')).toHaveLength(1);
    expect(notifications).toContainEqual({ settled: true, beforeVendor: true });
    const completed = ledger.records.filter((r) => r.kind === 'vendor-debt').at(-1)!.debt;
    expect(completed.vendorCompleted).toBe(true);
    if (!completed.vendorCompleted) throw Error('not settled');
    expect(completed.reference).toEqual(f.debt.reference);
    expect(completed.completion.document.findings).toEqual(mode === 'major' ? [raw] : []);
    if (mode === 'major') {
      expect(retained).toHaveLength(1);
      expect(result.value.findings).toContainEqual(retained[0]);
      expect(retained[0]).toMatchObject({
        severity: 'major',
        status: 'open',
        text: 'original repair guidance',
        evidence: completed.completion.receiptId,
      });
      const ready = assembleReadiness({
        branch: f.state.branch,
        target: 'merge-queue',
        identity: { head: result.value.head, base: f.state.base, dirtySha256: 'clean-tree' },
        ledger,
        untracked: [],
        configuredReviewers: ['agent', 'coderabbit'],
        nowIso: f.effects.nowIso(),
      });
      expect(ready.ready).toBe(false);
      if (ready.ready) throw Error('unexpected readiness');
      expect(ready.gaps.map((g) => g.detail).join(' ')).toContain(retained[0]!.id);
    } else expect(retained).toEqual([]);
  },
);

test.each(['fixed', 'rejected'] as const)(
  'changed raw receipt cannot inherit %s from an older receipt ID',
  async (action) => {
    const f = await fixture();
    const terminal = terminalReport(f, [
      {
        type: 'finding',
        severity: 'major',
        fileName: 'src/a.ts',
        comment: 'same comment',
        codegenInstructions: 'original instruction',
      },
    ]);
    const oldId =
      'receipt-' +
      createHash('sha256').update(JSON.stringify(terminal.document)).digest('hex') +
      '#f1';
    terminal.document.findings[0]!['codegenInstructions'] = 'changed instruction';
    const ledger = f.effects.openLedger(f.state.branch).load();
    ledger.records.push(dispositionRecord({ findingId: oldId, action, head: f.state.head }));
    f.effects.openLedger(f.state.branch).save(ledger);
    await f.repo.write('src/a.ts', 'export const a = 2;\n');
    f.repo.commitAll('changed head');
    const result = await makeReviewRun({
      drivers: cleanDrivers(),
      queueClient: terminal.client,
      effectsFactory: () => f.effects,
      scannerFactory: () => async (components) =>
        components.map((component) => ({ component: component.component, hits: [] })),
    })({ repoRoot: f.repo.root });
    expect(result.status, JSON.stringify(result)).toBe('ok');
    if (result.status !== 'ok') throw Error(JSON.stringify(result));
    const finding = result.value.findings.find((item) => item.text === 'changed instruction');
    expect(finding).toMatchObject({ status: 'open', severity: 'major' });
    expect(finding?.id).not.toBe(oldId);
    expect(result.value.findings.some((item) => item.id === oldId)).toBe(false);
  },
);

test.each(['fixed', 'rejected'] as const)(
  'exact retained immutable receipt honors its later %s disposition',
  async (action) => {
    const f = await fixture();
    const terminal = terminalReport(f, [
      { type: 'finding', severity: 'major', comment: 'retained' },
    ]);
    await f.repo.write('src/a.ts', 'export const a = 2;\n');
    f.repo.commitAll('changed head');
    const current = await readWorkState(f.effects, { target: 'merge-queue' });
    if (!current.ok) throw Error(current.reason);
    expect(
      await prepareDeferredVendorReview(f.effects, 'merge-queue', current.state, terminal.client),
    ).toBeUndefined();
    const ledger = f.effects.openLedger(f.state.branch).load();
    const finding = retainedReceiptFindings(ledger)[0]!;
    ledger.records.push(
      dispositionRecord({ findingId: finding.id, action, head: current.state.head }),
    );
    f.effects.openLedger(f.state.branch).save(ledger);
    const result = await makeReviewRun({
      drivers: cleanDrivers(),
      queueClient: terminal.client,
      effectsFactory: () => f.effects,
      scannerFactory: () => async (components) =>
        components.map((component) => ({ component: component.component, hits: [] })),
    })({ repoRoot: f.repo.root });
    expect(result.status, JSON.stringify(result)).toBe('ok');
    if (result.status !== 'ok') throw Error(JSON.stringify(result));
    expect(result.value.findings).toContainEqual({
      ...finding,
      status: action,
      reason: 'addressed in the diff',
    });
    expect(result.report?.deferredVendorDebt).toBeUndefined();
  },
);

test('failing post-enrollment status read owns the durable append; replay stays fail-closed', async () => {
  const f = await fixture();
  // Fresh enrollment shape: keep the retained blocked origin cycle, drop the seeded debt.
  const seeded = f.effects.openLedger(f.state.branch).load();
  f.effects.openLedger(f.state.branch).save({
    ...seeded,
    records: seeded.records.filter((entry) => entry.kind !== 'vendor-debt'),
  });
  const awaiting: QueueStatus = {
    state: 'awaiting-pr',
    pr: null,
    mergeSha: null,
    itemId: null,
    receiptId: null,
    consumed: false,
    reviewed: false,
    fixed: false,
  };
  const notes: { enrolled: boolean; beforeVendor: boolean }[] = [];
  const note = vi.fn(async () => {
    const latest = f.effects.openLedger(f.state.branch).load();
    notes.push({
      enrolled: latest.records.some(
        (entry) => entry.kind === 'vendor-debt' && !entry.debt.vendorCompleted,
      ),
      beforeVendor: !f.effects.calls.some((call) => call.command === 'coderabbit'),
    });
  });
  const run = (client: DeferredQueueClient) =>
    makeReviewRun({
      drivers: cleanDrivers(),
      queueClient: client,
      effectsFactory: () => f.effects,
      noteLedgerWrite: note,
      scannerFactory: () => async (components) =>
        components.map((component) => ({ component: component.component, hits: [] })),
    })({ repoRoot: f.repo.root });

  // Enrollment persists through enqueue; the following current-debt status read fails.
  const failStatus: DeferredQueueClient = {
    ...f.client,
    status: async () => {
      throw new Error('status read failed after durable enrollment');
    },
  };
  const first = await run(failStatus);
  expect(first.status, JSON.stringify(first)).toBe('indeterminate');
  if (first.status !== 'indeterminate') throw Error(JSON.stringify(first));
  expect(first.detail).toContain('status read failed after durable enrollment');
  expect(note).toHaveBeenCalledTimes(1);
  expect(notes[0]!).toEqual({ enrolled: true, beforeVendor: true });
  expect(f.effects.calls.filter((c) => c.command === 'coderabbit')).toHaveLength(0);
  let ledger = f.effects.openLedger(f.state.branch).load();
  const enrolled = ledger.records.filter((r) => r.kind === 'vendor-debt');
  expect(enrolled).toHaveLength(1);
  expect(enrolled[0]!.debt.vendorCompleted).toBe(false);

  // Replay with no new mutation: the same failing read never notifies again.
  const second = await run(failStatus);
  expect(second.status, JSON.stringify(second)).toBe('indeterminate');
  expect(note).toHaveBeenCalledTimes(1);

  // Replay after unrelated external bytes refuses to persist successor debt.
  await f.repo.write('src/a.ts', 'export const a = 3;\n');
  f.repo.commitAll('moved head');
  const poisoned: DeferredQueueClient = {
    ...f.client,
    status: async () => {
      const latest = f.effects.openLedger(f.state.branch).load();
      if (
        !latest.records.some(
          (entry) => entry.kind === 'cycle' && entry.cycleId === 'c911-unrelated',
        )
      )
        f.effects.openLedger(f.state.branch).save({
          ...latest,
          records: [
            ...latest.records,
            cycleRecord({ head: f.state.head, base: f.state.base, cycleId: 'c911-unrelated' }),
          ],
        });
      return awaiting;
    },
  };
  const third = await run(poisoned);
  expect(third.status, JSON.stringify(third)).toBe('indeterminate');
  if (third.status !== 'indeterminate') throw Error(JSON.stringify(third));
  expect(third.detail).toContain('deferred ledger changed; replay the same successor');
  // The external bytes are not the engine-requested mutation, so even though
  // the ledger changed, no ownership notification may bless them.
  expect(note).toHaveBeenCalledTimes(1);
  ledger = f.effects.openLedger(f.state.branch).load();
  expect(ledger.records.filter((r) => r.kind === 'vendor-debt')).toHaveLength(1);
});

test('unrelated durable bytes appended during a failing status throw never own the attempt', async () => {
  const f = await fixture();
  // Fresh enrollment shape: keep the retained blocked origin cycle, drop the seeded debt.
  const seeded = f.effects.openLedger(f.state.branch).load();
  f.effects.openLedger(f.state.branch).save({
    ...seeded,
    records: seeded.records.filter((entry) => entry.kind !== 'vendor-debt'),
  });
  const note = vi.fn(async () => {});
  const client: DeferredQueueClient = {
    ...f.client,
    status: async () => {
      const latest = f.effects.openLedger(f.state.branch).load();
      f.effects.openLedger(f.state.branch).save({
        ...latest,
        records: [
          ...latest.records,
          cycleRecord({ head: f.state.head, base: f.state.base, cycleId: 'c913-external-append' }),
        ],
      });
      throw new Error('status read failed after external append');
    },
  };
  const result = await makeReviewRun({
    drivers: cleanDrivers(),
    queueClient: client,
    effectsFactory: () => f.effects,
    noteLedgerWrite: note,
    scannerFactory: () => async (components) =>
      components.map((component) => ({ component: component.component, hits: [] })),
  })({ repoRoot: f.repo.root });
  expect(result.status, JSON.stringify(result)).toBe('indeterminate');
  if (result.status !== 'indeterminate') throw Error(JSON.stringify(result));
  // The original status error survives, and the ownership callback is never
  // invoked for bytes the engine did not request, even though its own durable
  // enrollment resolved first.
  expect(result.detail).toContain('status read failed after external append');
  expect(note).not.toHaveBeenCalled();
  const ledger = f.effects.openLedger(f.state.branch).load();
  expect(ledger.records.filter((entry) => entry.kind === 'vendor-debt')).toHaveLength(1);
  expect(
    ledger.records.some(
      (entry) => entry.kind === 'cycle' && entry.cycleId === 'c913-external-append',
    ),
  ).toBe(true);
});

test('a rejected durable ledger write never owns the attempt', async () => {
  const f = await fixture();
  const seeded = f.effects.openLedger(f.state.branch).load();
  f.effects.openLedger(f.state.branch).save({
    ...seeded,
    records: seeded.records.filter((entry) => entry.kind !== 'vendor-debt'),
  });
  const before = f.effects.openLedger(f.state.branch).load();
  const note = vi.fn(async () => {});
  // The store rejects the engine's own requested mutation: nothing durable was
  // accepted, so no ownership notification may follow.
  const failing = {
    ...f.effects,
    openLedger: (branch: string): ReturnType<typeof f.effects.openLedger> => {
      const store = f.effects.openLedger(branch);
      return {
        load: () => store.load(),
        save: (file) => store.save(file),
        mutate: <T>() => Promise.reject<T>(new Error('durable ledger write failed')),
      };
    },
  };
  const result = await makeReviewRun({
    drivers: cleanDrivers(),
    queueClient: f.client,
    effectsFactory: () => failing,
    noteLedgerWrite: note,
    scannerFactory: () => async (components) =>
      components.map((component) => ({ component: component.component, hits: [] })),
  })({ repoRoot: f.repo.root });
  expect(result.status, JSON.stringify(result)).toBe('indeterminate');
  if (result.status !== 'indeterminate') throw Error(JSON.stringify(result));
  expect(result.detail).toContain('durable ledger write failed');
  expect(note).not.toHaveBeenCalled();
  expect(f.effects.openLedger(f.state.branch).load()).toEqual(before);
});

/** A verified successor receipt at `head`, imported the way the queue report path does. */
async function successorReceipt(
  f: Awaited<ReturnType<typeof fixture>>,
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

test('a superseded older-head predecessor permits a clean run and stays an outstanding obligation', async () => {
  const f = await fixture();
  const predecessor = f.debt;
  await f.repo.write('src/a.ts', 'export const a = 2;\n');
  f.repo.commitAll('new head');
  const read = await readWorkState(f.effects, { target: 'merge-queue' });
  if (!read.ok) throw new Error(read.reason);
  const head = read.state.head;
  const evidence = await successorReceipt(f, 'successor', head);
  const binding = predecessor.reference.binding;
  if (binding.kind !== 'deferred-author') throw new Error('fixture debt must be deferred-author');
  const successor: DeferredVendorDebt = {
    reference: {
      requestId: 'successor',
      binding: { ...binding, head },
    },
    originAttempt: predecessor.originAttempt,
    deferral: { id: 'successor', base: read.state.base, dirtySha256: 'clean-tree' },
    predecessor: predecessor.reference,
    queue: {
      ...predecessor.queue,
      state: 'terminal-clean',
      pr: 42,
      mergeSha: head,
      itemId: 'successor-item',
      receiptId: evidence.receiptId,
      consumed: true,
      reviewed: true,
    },
    vendor: 'vendor-completed',
    vendorCompleted: true,
    completion: evidence,
  };
  f.effects.openLedger(f.state.branch).save({
    version: 2,
    branch: f.state.branch,
    records: [
      ...f.effects.openLedger(f.state.branch).load().records,
      { kind: 'vendor-debt', debt: successor, at: f.effects.nowIso() },
    ],
  });
  const client = {
    ...f.client,
    status: async (ref: QueueReference): Promise<QueueStatus> =>
      ref.requestId === predecessor.reference.requestId
        ? { ...predecessor.queue, state: 'awaiting-pr', pr: null }
        : successor.queue,
    report: async (): Promise<QueueEvidence> => evidence,
  };
  const result = await makeReviewRun({
    drivers: cleanDrivers(),
    queueClient: client,
    effectsFactory: () => f.effects,
    scannerFactory: () => async (components) =>
      components.map((component) => ({ component: component.component, hits: [] })),
  })({ repoRoot: f.repo.root });
  // RUN acceptance: the completed successor at this head is the authority; the superseded
  // older-head predecessor does not refuse it (its obligation is carried, never credited).
  expect(result.status, JSON.stringify(result)).toBe('ok');
  // DURABLE readiness still reports the outstanding obligation.
  const readiness = assembleReadiness({
    branch: f.state.branch,
    target: 'merge-queue',
    identity: { head, base: read.state.base, dirtySha256: 'clean-tree' },
    ledger: f.effects.openLedger(f.state.branch).load(),
    untracked: [],
    configuredReviewers: ['agent', 'coderabbit'],
    deferredVendorDebt: successor,
    nowIso: f.effects.nowIso(),
  });
  expect(readiness.ready).toBe(false);
  if (readiness.ready) throw Error('unexpected readiness');
  expect(readiness.gaps.map((gap) => gap.detail).join(' ')).toContain(
    'authorized predecessor obligation(s) unsettled:',
  );
  const settled = f.effects.openLedger(f.state.branch).load();
  const pending = settled.records.filter(
    (entry) =>
      entry.kind === 'vendor-debt' &&
      entry.debt.reference.requestId === predecessor.reference.requestId,
  );
  expect(pending).toHaveLength(1);
  expect(pending[0]!.kind === 'vendor-debt' && pending[0]!.debt.vendorCompleted).toBe(false);
});
