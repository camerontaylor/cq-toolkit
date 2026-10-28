import { afterEach, expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import { makeQueueClient } from '../../../src/ops/review/queue.js';
import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeDevDisposition } from '../../../src/ops/dev/disposition.js';
import {
  importQueueEvidence,
  type QueueEvidence,
} from '../../../src/ops/review/internal/queueEvidence.js';
import { deferredReceiptFindings } from '../../../src/ops/dev/internal/deferredReview.js';
import { makeTestRepo, repoEffects, type TestRepo } from './repo.js';
import { checkRecord, cycleRecord } from './fakes.js';
import { readWorkState } from '../../../src/ops/dev/internal/workState.js';
import {
  currentLedgerDebt,
  loadCurrentDeferredVendorDebt,
  bindPublishedDeferredDebt,
  prepareDeferredVendorReview,
  readCurrentEnrollment,
} from '../../../src/ops/dev/internal/deferredLedger.js';
import { renderReadinessSection } from '../../../src/ops/pr/open.js';
import {
  assembleReadiness,
  findReusableCycle,
  parseDevLedger,
  serializeDevLedger,
  type DevLedgerFile,
} from '../../../src/ops/dev/record.js';
import { deferVendorReview } from '../../../src/ops/dev/internal/deferredReview.js';
import type { DeferredVendorDebt } from '../../../src/ops/dev/internal/deferredReview.js';
import type {
  DeferredQueueClient,
  QueueReference,
  QueueStatus,
} from '../../../src/ops/review/internal/queueProtocol.js';
import { ReviewCoverageV2Schema } from '../../../src/ops/review/internal/reviewCoverageV2.js';

const repos: TestRepo[] = [];
afterEach(async () => {
  for (const repo of repos.splice(0)) await repo.cleanup();
});

async function fixture() {
  const repo = await makeTestRepo();
  repos.push(repo);
  const effects = repoEffects(repo, (command, args) =>
    command === 'gh' ? (args[0] === 'api' ? 'author' : 'owner/repo') : undefined,
  );
  const read = await readWorkState(effects, { target: 'merge-queue' });
  if (!read.ok) throw new Error(read.reason);
  const state = read.state;
  const identity = { head: state.head, base: state.base, dirtySha256: state.dirtySha256 };
  const reference: QueueReference = {
    requestId: 'intent-1',
    binding: {
      kind: 'deferred-author',
      repo: 'owner/repo',
      producer: 'author',
      head: state.head,
      target: 'merge-queue',
      targetSelector: 'promoted-main',
    },
  };
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
  const vendorFailure = {
    source: 'vendor' as const,
    category: 'vendor-unavailable' as const,
    codes: ['con_err'],
  };
  const origin = cycleRecord({
    ...identity,
    cycleId: 'c001-outage',
    completion: { kind: 'blocked', reason: 'local CLI outage' },
    vendorFailure,
  });
  const debt = await deferVendorReview(
    client,
    reference,
    'unavailable',
    {
      id: reference.requestId,
      base: state.base,
      dirtySha256: 'clean-tree',
    },
    {
      cycleId: origin.cycleId,
      head: state.head,
      base: state.base,
      target: 'merge-queue',
      scope: 'full',
      dirtySha256: 'clean-tree',
      failure: vendorFailure,
    },
  );
  const coverage = ReviewCoverageV2Schema.parse({
    version: 2,
    head: state.head,
    base: state.base,
    scope: 'full',
    mode: 'session',
    modeReason: 'fixture',
    pieces: [
      {
        component: 'tracked:fixture',
        path: 'fixture',
        sha256: createHash('sha256').update('').digest('hex'),
        chars: 0,
        bytes: 0,
        state: 'excluded',
        exclusion: { rule: 'fixture/**', limitation: 'empty fixture' },
      },
    ],
    sessions: [],
  });
  const agent = cycleRecord({
    ...identity,
    cycleId: 'c002-agent',
    reviewer: 'agent:reviewer',
    agentCoverage: coverage,
  });
  const ledger: DevLedgerFile = {
    version: 2,
    branch: state.branch,
    records: [
      origin,
      { kind: 'vendor-debt', debt, at: effects.nowIso() },
      agent,
      checkRecord(identity),
    ],
  };
  effects.openLedger(state.branch).save(ledger);
  const assemble = (file = ledger, value = debt) =>
    assembleReadiness({
      branch: state.branch,
      target: 'merge-queue',
      identity,
      ledger: file,
      untracked: [],
      configuredReviewers: ['agent', 'coderabbit'],
      deferredVendorDebt: value,
      nowIso: effects.nowIso(),
    });
  return { repo, effects, state, client, ledger, debt, origin, agent, assemble, identity };
}

test('strict additive ledger keeps old v2 readable and refuses forged failure classes/reuse', async () => {
  const f = await fixture();
  expect(parseDevLedger(serializeDevLedger(f.ledger))).toEqual(f.ledger);
  const legacy = { ...f.ledger, records: [cycleRecord()] };
  expect(parseDevLedger(serializeDevLedger(legacy))).toEqual(legacy);
  const malformed = structuredClone(f.ledger);
  const first = malformed.records[0];
  if (first?.kind !== 'cycle' || first.vendorFailure === undefined)
    throw new Error('missing fixture origin');
  first.vendorFailure.codes = ['scan'];
  expect(() => parseDevLedger(JSON.stringify(malformed))).toThrow('schema violation');
  expect(
    findReusableCycle([{ ...f.origin, completion: { kind: 'terminal' } }], {
      ...f.identity,
      reviewer: 'coderabbit',
      target: 'merge-queue',
      scope: 'full',
    }),
  ).toBeNull();
});

test('verified current debt permits fresh full agent readiness, reports debt, and retains findings', async () => {
  const f = await fixture();
  const debt = await loadCurrentDeferredVendorDebt(
    f.effects,
    'merge-queue',
    f.state,
    f.ledger,
    f.client,
  );
  expect(debt).toEqual(f.debt);
  const ready = f.assemble();
  expect(ready.ready).toBe(true);
  if (ready.ready)
    expect(ready.record).toMatchObject({
      reviewer: 'agent:reviewer',
      vendorDebt: { vendorCompleted: false },
    });
  if (ready.ready) {
    const body = renderReadinessSection(ready.record, f.ledger, []);
    expect(body).toContain('Deferred vendor review debt');
    expect(body).toContain('vendorCompleted: false');
    expect(body).toContain(f.debt.reference.requestId);
  }
  f.origin.findings.push({ id: 'retained-major', severity: 'major', excerpt: 'must adjudicate' });
  const blocked = f.assemble();
  expect(blocked.ready).toBe(false);
  if (!blocked.ready)
    expect(blocked.gaps.some((gap) => gap.field === 'open-blocking-findings')).toBe(true);
  expect(f.origin.completion.kind).toBe('blocked');
});

test('missing fresh engine proof, stale enrollment and unrelated later blockers cannot continue', async () => {
  const f = await fixture();
  delete f.agent.agentCoverage;
  expect(f.assemble().ready).toBe(false);
  const noDebt = assembleReadiness({
    branch: f.state.branch,
    target: 'merge-queue',
    identity: f.identity,
    ledger: f.ledger,
    untracked: [],
    nowIso: f.effects.nowIso(),
  });
  expect(noDebt.ready).toBe(false);
  f.ledger.records.push({ ...f.origin, cycleId: 'new-blocker' });
  expect(f.assemble().ready).toBe(false);
  f.debt.reference.binding = {
    ...f.debt.reference.binding,
    kind: 'deferred-author',
    repo: 'owner/repo',
    producer: 'author',
    target: 'merge-queue',
    head: 'c'.repeat(40),
  };
  expect(currentLedgerDebt(f.ledger, 'merge-queue', f.state)).toBeUndefined();
});

test('queue auth/read uncertainty retains debt and never grants snapshot continuation', async () => {
  const f = await fixture();
  const before = serializeDevLedger(f.effects.openLedger(f.state.branch).load());
  f.client.status = async () => {
    throw new Error('queue auth failed');
  };
  await expect(
    loadCurrentDeferredVendorDebt(f.effects, 'merge-queue', f.state, f.ledger, f.client),
  ).rejects.toThrow('queue auth failed');
  expect(serializeDevLedger(f.effects.openLedger(f.state.branch).load())).toBe(before);
});

test('typed vendor blockage continues, queue identity blockage and changed ledger refuse', async () => {
  const f = await fixture();
  f.client.status = async () => ({
    ...f.debt.queue,
    state: 'blocked',
    enqueued: true,
    reason: { source: 'vendor', category: 'vendor-needs-action', code: 'auth' },
  });
  expect(
    await loadCurrentDeferredVendorDebt(f.effects, 'merge-queue', f.state, f.ledger, f.client),
  ).toMatchObject({ queue: { state: 'blocked' } });
  f.client.status = async () => ({
    ...f.debt.queue,
    state: 'blocked',
    enqueued: true,
    reason: { source: 'queue', category: 'identity', code: 'forge-identity' },
  });
  await expect(
    loadCurrentDeferredVendorDebt(f.effects, 'merge-queue', f.state, f.ledger, f.client),
  ).rejects.toThrow('does not authorize');
  f.client.status = async () => {
    f.effects.openLedger(f.state.branch).save({
      ...f.ledger,
      records: [...f.ledger.records, checkRecord({ ...f.identity, checkId: 'new-check' })],
    });
    return f.debt.queue;
  };
  await expect(
    loadCurrentDeferredVendorDebt(f.effects, 'merge-queue', f.state, f.ledger, f.client),
  ).rejects.toThrow('changed while verifying');
});

test('repository mismatch, missing persisted origin and cancellation refuse before continuation', async () => {
  const f = await fixture();
  const other = {
    ...f.effects,
    runCommand: async () => ({ exitCode: 0, stdout: 'other/repo', stderr: '', timedOut: false }),
  };
  await expect(
    loadCurrentDeferredVendorDebt(other, 'merge-queue', f.state, f.ledger, f.client),
  ).rejects.toThrow('repository');
  const abort = new AbortController();
  abort.abort();
  await expect(
    loadCurrentDeferredVendorDebt(
      f.effects,
      'merge-queue',
      f.state,
      f.ledger,
      f.client,
      abort.signal,
    ),
  ).rejects.toThrow();
  delete f.origin.vendorFailure;
  expect(() => currentLedgerDebt(f.ledger, 'merge-queue', f.state)).toThrow('origin');
});

test('initial blocked CLI enrollment is durable and replayed before invoking any fresh reviewer', async () => {
  const f = await fixture();
  f.ledger.records = [f.origin];
  f.effects.openLedger(f.state.branch).save(f.ledger);
  let enqueues = 0;
  f.client.enqueue = async () => {
    enqueues++;
    return f.debt.queue;
  };
  const debt = await prepareDeferredVendorReview(f.effects, 'merge-queue', f.state, f.client);
  expect(debt?.reference.binding).toMatchObject({ producer: 'author', head: f.state.head });
  expect(debt?.reference.requestId).toMatch(/^defer-[a-f0-9]{64}$/);
  const ledger = f.effects.openLedger(f.state.branch).load();
  expect(ledger.records).toHaveLength(2);
  expect(ledger.records[0]).toEqual(f.origin);
  expect(ledger.records[1]).toMatchObject({
    kind: 'vendor-debt',
    debt: { vendorCompleted: false },
  });
  expect(await prepareDeferredVendorReview(f.effects, 'merge-queue', f.state, f.client)).toEqual(
    debt,
  );
  expect(enqueues).toBe(1);
  expect(f.effects.calls.some((call) => call.command === 'coderabbit')).toBe(false);
});

test('changed head enrolls a successor before selection and never cancels published predecessor debt', async () => {
  const f = await fixture();
  f.debt.queue.pr = 12;
  f.debt.queue.state = 'awaiting-merge';
  f.effects.openLedger(f.state.branch).save(f.ledger);
  await f.repo.write('src/a.ts', 'export const a = 2;\n');
  f.repo.git('add', 'src/a.ts');
  f.repo.git('commit', '-qm', 'fix finding');
  const read = await readWorkState(f.effects, { target: 'merge-queue' });
  if (!read.ok) throw new Error(read.reason);
  const ids: string[] = [];
  f.client.enqueue = async (ref) => {
    ids.push(ref.requestId);
    return { ...f.debt.queue, state: 'awaiting-pr', pr: null };
  };
  f.client.status = async (ref) =>
    ref.requestId === f.debt.reference.requestId
      ? f.debt.queue
      : { ...f.debt.queue, state: 'awaiting-pr', pr: null };
  f.client.cancel = async () => {
    throw new Error('must not cancel predecessor');
  };
  const store = f.effects.openLedger(f.state.branch);
  const mutate = store.mutate;
  let failWrite = true;
  const faulty = {
    ...f.effects,
    openLedger: () => ({
      ...store,
      mutate: async <T>(fn: Parameters<typeof store.mutate<T>>[0]) => {
        if (failWrite) throw new Error('disk unavailable');
        return mutate(fn);
      },
    }),
  };
  await expect(
    prepareDeferredVendorReview(faulty, 'merge-queue', read.state, f.client),
  ).rejects.toThrow('disk unavailable');
  expect(store.load().records).toEqual(f.ledger.records);
  failWrite = false;
  const successor = await prepareDeferredVendorReview(faulty, 'merge-queue', read.state, f.client);
  expect(ids).toHaveLength(2);
  expect(ids[0]).toBe(ids[1]);
  expect(successor?.predecessor).toEqual(f.debt.reference);
  expect(successor?.originAttempt).toEqual(f.debt.originAttempt);
  expect(f.debt.queue.pr).toBe(12);
});

test('publication bind persists only verified PR identity and supports crash replay', async () => {
  const f = await fixture();
  let binds = 0;
  f.client.bind = async (ref) => {
    binds++;
    return { ...f.debt.queue, state: 'awaiting-merge', pr: ref.pr };
  };
  await bindPublishedDeferredDebt(f.effects, 'merge-queue', f.state, f.ledger, 42, f.client);
  const latest = f.effects.openLedger(f.state.branch).load();
  expect(latest.records.at(-1)).toMatchObject({
    kind: 'vendor-debt',
    debt: { queue: { pr: 42 }, vendorCompleted: false },
  });
  await bindPublishedDeferredDebt(f.effects, 'merge-queue', f.state, latest, 42, f.client);
  expect(f.effects.openLedger(f.state.branch).load().records).toHaveLength(latest.records.length);
  expect(binds).toBe(2);
  f.client.bind = async () => {
    throw new Error('lost queue reply');
  };
  await expect(
    bindPublishedDeferredDebt(f.effects, 'merge-queue', f.state, latest, 42, f.client),
  ).rejects.toThrow('lost queue reply');
  expect(f.effects.openLedger(f.state.branch).load()).toEqual(latest);
});

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

test('terminal status alone cannot settle; verified report clean settlement is durable, scoped and replayable', async () => {
  const f = await fixture();
  const terminal = terminalReport(f);
  await expect(
    loadCurrentDeferredVendorDebt(f.effects, 'merge-queue', f.state, f.ledger, {
      ...f.client,
      status: terminal.client.status,
    }),
  ).rejects.toThrow('report capability');
  expect(f.effects.openLedger(f.state.branch).load()).toEqual(f.ledger);
  const completed = await loadCurrentDeferredVendorDebt(
    f.effects,
    'merge-queue',
    f.state,
    f.ledger,
    terminal.client,
  );
  expect(completed).toMatchObject({
    vendor: 'vendor-completed',
    vendorCompleted: true,
    completion: { fullBranchReadiness: false, independentAcceptance: false, fixed: false },
  });
  if (!completed?.vendorCompleted) throw new Error('missing completion');
  expect(completed.completion.document.capture.target).toBe(f.state.head);
  const retained = f.effects.openLedger(f.state.branch).load();
  expect(retained.records).toHaveLength(f.ledger.records.length + 1);
  expect(retained.records[1]).toEqual(f.ledger.records[1]); // immutable pending history
  expect(f.assemble(retained, completed).ready).toBe(true);
  await loadCurrentDeferredVendorDebt(f.effects, 'merge-queue', f.state, retained, terminal.client);
  expect(f.effects.openLedger(f.state.branch).load()).toEqual(retained);
  expect(terminal.deliveries()).toBe(2);
  const noAgent = {
    ...retained,
    records: retained.records.filter(
      (row) => row.kind !== 'cycle' || row.reviewer === 'coderabbit',
    ),
  };
  expect(f.assemble(noAgent, completed).ready).toBe(false);
});

test('verified findings retain provenance, block readiness, and require explicit existing receipt dispositions', async () => {
  const f = await fixture();
  const terminal = terminalReport(f, [
    { type: 'finding', severity: 'major', fileName: 'src/a.ts', excerpt: 'substantive defect' },
  ]);
  const completed = await loadCurrentDeferredVendorDebt(
    f.effects,
    'merge-queue',
    f.state,
    f.ledger,
    terminal.client,
  );
  if (!completed?.vendorCompleted) throw new Error('missing completion');
  let retained = f.effects.openLedger(f.state.branch).load();
  expect(f.assemble(retained, completed).ready).toBe(false);
  const finding = deferredReceiptFindings([completed])[0]!;
  expect(finding.text).toBe('substantive defect');
  expect(completed.completion.document.findings).toEqual(terminal.document.findings);
  const disposition = makeDevDisposition(f.effects);
  expect(
    (
      await disposition({
        repoRoot: f.repo.root,
        findingId: 'receipt-unknown#f1',
        action: 'fixed',
        why: 'typo',
      })
    ).status,
  ).toBe('failed');
  expect(
    (
      await disposition({
        repoRoot: f.repo.root,
        findingId: finding.id,
        action: 'deferred',
        why: 'tracked elsewhere',
      })
    ).status,
  ).toBe('ok');
  retained = f.effects.openLedger(f.state.branch).load();
  expect(f.assemble(retained, completed).ready).toBe(false);
  expect(
    (
      await disposition({
        repoRoot: f.repo.root,
        findingId: finding.id,
        action: 'fixed',
        why: 'concrete fix independently recorded',
      })
    ).status,
  ).toBe('ok');
  retained = f.effects.openLedger(f.state.branch).load();
  expect(f.assemble(retained, completed).ready).toBe(true);
});

test.each([
  'partial',
  'unknown',
  'uncounted',
  'source',
  'request',
  'tree',
  'equivalence',
  'mixed-clean',
])('terminal report %s cannot manufacture completion', async (fault) => {
  const f = await fixture();
  const terminal = terminalReport(f);
  switch (fault) {
    case 'partial':
      terminal.document.capture.paths[0]!.disposition = 'unsupported';
      break;
    case 'unknown':
      terminal.document.outcome = 'unknown';
      break;
    case 'uncounted':
      terminal.document.classification.counted = false;
      break;
    case 'source':
      terminal.document.source.merge_sha = 'f'.repeat(40);
      break;
    case 'request':
      terminal.document.request_id = 'other-request';
      break;
    case 'tree':
      terminal.document.capture.tree = 'f'.repeat(40);
      break;
    case 'equivalence':
      terminal.document.capture.equivalence = 'f'.repeat(64);
      break;
    case 'mixed-clean':
      terminal.document.findings.push({ severity: 'major', excerpt: 'hidden defect' });
      break;
  }
  await expect(
    loadCurrentDeferredVendorDebt(f.effects, 'merge-queue', f.state, f.ledger, terminal.client),
  ).rejects.toThrow();
  expect(f.effects.openLedger(f.state.branch).load()).toEqual(f.ledger);
});

test('report delivery failure, digest tamper and changed identity retain pending debt without credit', async () => {
  const f = await fixture();
  const terminal = terminalReport(f);
  const unavailable = {
    ...terminal.client,
    report: async () => {
      throw new Error('queue authorization');
    },
  };
  await expect(
    loadCurrentDeferredVendorDebt(f.effects, 'merge-queue', f.state, f.ledger, unavailable),
  ).rejects.toThrow('queue authorization');
  const tampered = {
    ...terminal.client,
    report: async (ref: QueueReference, root: string) => {
      const evidence = await terminal.client.report(ref, root);
      await writeFile(join(root, evidence.receiptId + '.json'), '{}');
      return evidence;
    },
  };
  await expect(
    loadCurrentDeferredVendorDebt(f.effects, 'merge-queue', f.state, f.ledger, tampered),
  ).rejects.toThrow('digest');
  expect(f.effects.openLedger(f.state.branch).load()).toEqual(f.ledger);
  const g = await fixture();
  const terminalDrift = terminalReport(g);
  const drifted = {
    ...terminalDrift.client,
    report: async (ref: QueueReference, root: string) => {
      const evidence = await terminalDrift.client.report(ref, root);
      await g.repo.write('src/a.ts', 'changed after report');
      return evidence;
    },
  };
  await expect(
    loadCurrentDeferredVendorDebt(g.effects, 'merge-queue', g.state, g.ledger, drifted),
  ).rejects.toThrow('identity changed');
  expect(g.effects.openLedger(g.state.branch).load()).toEqual(g.ledger);
});

test('acknowledged report plus local settlement write failure replays the same receipt without new enrollment', async () => {
  const f = await fixture();
  const terminal = terminalReport(f, [{ severity: 'major', excerpt: 'retained through crash' }]);
  let enrollments = 0;
  const client = {
    ...terminal.client,
    enqueue: async () => {
      enrollments++;
      return f.debt.queue;
    },
  };
  const store = f.effects.openLedger(f.state.branch);
  const failedEffects = {
    ...f.effects,
    openLedger: () => ({
      ...store,
      mutate: async () => {
        throw new Error('disk full after acknowledgement');
      },
    }),
  };
  await expect(
    loadCurrentDeferredVendorDebt(failedEffects, 'merge-queue', f.state, f.ledger, client),
  ).rejects.toThrow('disk full');
  expect(store.load()).toEqual(f.ledger);
  const completed = await loadCurrentDeferredVendorDebt(
    f.effects,
    'merge-queue',
    f.state,
    f.ledger,
    client,
  );
  if (!completed?.vendorCompleted) throw new Error('missing completion');
  const retained = store.load();
  await loadCurrentDeferredVendorDebt(f.effects, 'merge-queue', f.state, retained, client);
  expect(store.load()).toEqual(retained);
  expect(
    deferredReceiptFindings(
      retained.records.filter((row) => row.kind === 'vendor-debt').map((row) => row.debt),
    ),
  ).toHaveLength(1);
  expect(enrollments).toBe(0);
});

test('late old-head completion settles that obligation without manufacturing successor coverage or enrollment', async () => {
  const f = await fixture();
  const terminal = terminalReport(f);
  await f.repo.write('src/a.ts', 'export const a = 2;\n');
  f.repo.git('add', 'src/a.ts');
  f.repo.git('commit', '-q', '-m', 'new head');
  const read = await readWorkState(f.effects, { target: 'merge-queue' });
  if (!read.ok) throw new Error(read.reason);
  let enrollments = 0;
  const client = {
    ...terminal.client,
    enqueue: async () => {
      enrollments++;
      return f.debt.queue;
    },
  };
  expect(
    await prepareDeferredVendorReview(f.effects, 'merge-queue', read.state, client),
  ).toBeUndefined();
  const retained = f.effects.openLedger(f.state.branch).load();
  const completed = retained.records.at(-1);
  expect(completed).toMatchObject({
    kind: 'vendor-debt',
    debt: { vendorCompleted: true, reference: f.debt.reference },
  });
  expect(currentLedgerDebt(retained, 'merge-queue', read.state)).toBeUndefined();
  expect(
    await prepareDeferredVendorReview(f.effects, 'merge-queue', read.state, client),
  ).toBeUndefined();
  expect(enrollments).toBe(0);
  expect(retained.records[1]).toEqual(f.ledger.records[1]);
});

test('missing report or post-report queue identity refusal retains pending debt', async () => {
  const f = await fixture();
  const terminal = terminalReport(f);
  const missing = { ...terminal.client, report: async () => null };
  await expect(
    loadCurrentDeferredVendorDebt(f.effects, 'merge-queue', f.state, f.ledger, missing),
  ).rejects.toThrow('no verified report');
  let reads = 0;
  const invalid = {
    ...terminal.client,
    status: async (): Promise<QueueStatus> => ({
      ...(await terminal.client.status()),
      ...(reads++ > 0
        ? {
            state: 'blocked',
            reason: { source: 'queue', category: 'identity', code: 'forge-identity' },
          }
        : {}),
    }),
  };
  await expect(
    loadCurrentDeferredVendorDebt(f.effects, 'merge-queue', f.state, f.ledger, invalid),
  ).rejects.toThrow('genuine complete');
  expect(f.effects.openLedger(f.state.branch).load()).toEqual(f.ledger);
});

test('raw Q1 finding events survive Q3 paged delivery, settlement, findings and explicit disposition', async () => {
  const f = await fixture();
  const terminal = terminalReport(f, [
    {
      type: 'finding',
      severity: 'major',
      fileName: 'src/a.ts',
      comment: 'original raw comment is retained',
      codegenInstructions: 'genuine untruncated CodeRabbit instructions '.repeat(300),
      lineNumber: 7,
      metadata: { original: true },
    },
    { type: 'finding', severity: 'trivial', comment: 'original trivial comment' },
    { type: 'finding', severity: 'none', codegenInstructions: 'original informational event' },
  ]);
  const bytes = Buffer.from(JSON.stringify(terminal.document));
  const receiptId = createHash('sha256').update(bytes).digest('hex');
  const chunks = Math.ceil(bytes.length / 3072);
  let consumed = false;
  const delivered = new Set<number>();
  const common = {
    version: 1,
    receipt_id: receiptId,
    sha256: receiptId,
    bytes: bytes.length,
    chunks,
    encoding: 'base64-utf8-json',
  };
  const client = makeQueueClient(async (raw) => {
    const request = JSON.parse(raw) as Record<string, unknown>;
    let result: unknown;
    if (request['op'] === 'status')
      result = { ...(await terminal.client.status()), receiptId, consumed };
    else if (request['op'] === 'report' && request['cursor'] === null)
      result = { page: { ...common, kind: 'manifest', cursor: receiptId + ':0' } };
    else if (request['op'] === 'report' && typeof request['cursor'] === 'string') {
      const index = Number(request['cursor'].slice(receiptId.length + 1));
      if (index !== delivered.size) throw new Error('out of order fixture delivery');
      const part = bytes.subarray(index * 3072, (index + 1) * 3072);
      delivered.add(index);
      result = {
        page: {
          ...common,
          kind: 'chunk',
          index,
          chunk_sha256: createHash('sha256').update(part).digest('hex'),
          data: part.toString('base64'),
          next_cursor: index + 1 < chunks ? receiptId + ':' + String(index + 1) : null,
        },
      };
    } else if (request['op'] === 'ack' && delivered.size === chunks) {
      consumed = true;
      result = { ...(await terminal.client.status()), receiptId, consumed };
    } else
      throw new Error('unexpected queue operation; no enrollment or vendor dispatch permitted');
    return JSON.stringify({
      v: 1,
      requestId: request['requestId'],
      binding: request['binding'],
      result,
    });
  });
  const completed = await loadCurrentDeferredVendorDebt(
    f.effects,
    'merge-queue',
    f.state,
    f.ledger,
    client,
  );
  expect(consumed).toBe(true);
  expect(delivered.size).toBe(chunks);
  expect(chunks).toBeGreaterThan(1);
  if (!completed?.vendorCompleted) throw new Error('missing completion');
  expect(completed.completion.document.findings).toEqual(terminal.document.findings);
  const imported = deferredReceiptFindings([completed]);
  expect(imported.map((finding) => finding.severity)).toEqual(['major', 'trivial', 'none']);
  expect(imported[0]!.text).toBe(terminal.document.findings[0]!['codegenInstructions']);
  expect(imported[0]!.text.length).toBeGreaterThan(4000);
  expect(imported[1]!.text).toBe('original trivial comment');
  expect(imported[2]!.text).toBe('original informational event');
  expect(f.assemble(f.effects.openLedger(f.state.branch).load(), completed).ready).toBe(false);
  const disposition = await makeDevDisposition(f.effects)({
    repoRoot: f.repo.root,
    findingId: imported[0]!.id,
    action: 'fixed',
    why: 'explicit concrete fix for original raw vendor finding',
  });
  expect(disposition.status).toBe('ok');
  expect(f.assemble(f.effects.openLedger(f.state.branch).load(), completed).ready).toBe(true);
  expect(completed.completion.document.findings).toEqual(terminal.document.findings);
});

// Real Q1 current_document() preserves events verbatim, including aliases; unknown
// severity and malformed text cannot become a clean or silently dropped finding.
test.each([
  { severity: 'major', comment: 'actual raw comment' },
  { severity: 'minor', codegenInstructions: 'actual raw instructions' },
  { severity: 'trivial', comment: 'low severity raw finding' },
  { severity: 'info', codegenInstructions: '', comment: 'fallback raw comment' },
  { severity: 'none', comment: 'supported none severity' },
])(
  'settles supported raw finding without changing severity or original fields: %j',
  async (raw) => {
    const f = await fixture();
    const terminal = terminalReport(f, [{ type: 'finding', ...raw }]);
    const completed = await loadCurrentDeferredVendorDebt(
      f.effects,
      'merge-queue',
      f.state,
      f.ledger,
      terminal.client,
    );
    if (!completed?.vendorCompleted) throw new Error('missing raw event completion');
    expect(completed.completion.document.findings).toEqual([{ type: 'finding', ...raw }]);
    expect(deferredReceiptFindings([completed])[0]!.severity).toBe(raw.severity);
  },
);

test.each([
  { severity: 'unknown', comment: 'unknown severity must block' },
  { severity: 'major', comment: { malformed: true } },
  {
    severity: 'major',
    codegenInstructions: { malformed: true },
    comment: 'cannot hide malformed primary text',
  },
  { severity: 'major', comment: '' },
])('refuses unknown or malformed raw finding and retains pending debt: %j', async (raw) => {
  const f = await fixture();
  const terminal = terminalReport(f, [{ type: 'finding', ...raw }]);
  await expect(
    loadCurrentDeferredVendorDebt(f.effects, 'merge-queue', f.state, f.ledger, terminal.client),
  ).rejects.toThrow('genuine complete');
  expect(f.effects.openLedger(f.state.branch).load()).toEqual(f.ledger);
});

type PendingDebt = Extract<DeferredVendorDebt, { vendorCompleted: false }>;

/** A pending debt cloned onto a new request identity/head, keeping the template's origin. */
function syntheticDebt(
  template: PendingDebt,
  requestId: string,
  head: string,
  predecessor?: QueueReference,
): PendingDebt {
  const binding = template.reference.binding;
  if (binding.kind !== 'deferred-author') throw new Error('fixture debt must be deferred-author');
  return {
    ...template,
    reference: { requestId, binding: { ...binding, head } },
    deferral: { ...template.deferral, id: requestId },
    ...(predecessor === undefined ? {} : { predecessor }),
  };
}

function pendingTemplate(debt: DeferredVendorDebt): PendingDebt {
  if (debt.vendorCompleted) throw new Error('fixture debt must be pending');
  return debt;
}

test('a completed predecessor appended after its successor never displaces the current enrollment', async () => {
  const f = await fixture();
  const predecessor = f.debt;
  // The predecessor's receipt is captured at its own head, before HEAD moves.
  const terminal = terminalReport(f);
  await f.repo.write('src/a.ts', 'export const a = 2;\n');
  f.repo.git('add', 'src/a.ts');
  f.repo.git('commit', '-qm', 'new head');
  const read = await readWorkState(f.effects, { target: 'merge-queue' });
  if (!read.ok) throw new Error(read.reason);
  const successorStatus: QueueStatus = { ...f.debt.queue, state: 'awaiting-pr', pr: null };
  const client: DeferredQueueClient = {
    ...f.client,
    enqueue: async () => successorStatus,
    status: async () => successorStatus,
    cancel: async () => {
      throw new Error('must not cancel a published predecessor');
    },
  };
  const successor = await prepareDeferredVendorReview(f.effects, 'merge-queue', read.state, client);
  if (!successor) throw new Error('missing successor');
  expect(successor.predecessor).toEqual(predecessor.reference);
  const terminalClient = {
    ...client,
    status: async (ref: QueueReference): Promise<QueueStatus> =>
      ref.requestId === predecessor.reference.requestId
        ? terminal.client.status()
        : successorStatus,
    report: terminal.client.report,
  };
  const ledger = f.effects.openLedger(f.state.branch).load();
  const refreshed = await loadCurrentDeferredVendorDebt(
    f.effects,
    'merge-queue',
    read.state,
    ledger,
    terminalClient,
  );
  // Only the current enrollment is returned; the settled predecessor is never authority.
  expect(refreshed?.reference.requestId).toBe(successor.reference.requestId);
  const after = f.effects.openLedger(f.state.branch).load();
  const appended = after.records.filter((entry) => entry.kind === 'vendor-debt').at(-1);
  if (appended?.kind !== 'vendor-debt') throw new Error('missing appended snapshot');
  expect(appended.debt.reference).toEqual(predecessor.reference);
  expect(appended.debt.vendorCompleted).toBe(true);
  expect(currentLedgerDebt(after, 'merge-queue', read.state)?.reference).toEqual(
    successor.reference,
  );
  const authority = readCurrentEnrollment(
    after,
    { head: read.state.head, base: read.state.base, dirtySha256: read.state.dirtySha256 },
    'merge-queue',
  );
  if (authority.kind !== 'enrollment') throw new Error('missing current authority');
  expect(authority.enrollment.debt.reference).toEqual(successor.reference);
  expect(authority.enrollment.pendingAncestry).toEqual([]);
  // Readiness for the successor identity sees no unsettled ancestry: the settled predecessor is
  // an imported obligation, never a lineage gap.
  const readiness = assembleReadiness({
    branch: f.state.branch,
    target: 'merge-queue',
    identity: { head: read.state.head, base: read.state.base, dirtySha256: read.state.dirtySha256 },
    ledger: after,
    untracked: [],
    configuredReviewers: ['agent', 'coderabbit'],
    deferredVendorDebt: successor,
    nowIso: f.effects.nowIso(),
  });
  expect(readiness.ready ? [] : readiness.gaps.map((gap) => gap.detail)).not.toContain(
    'authorized predecessor obligation(s) unsettled:',
  );

  // Replay is inert: no second snapshot, no re-acknowledgement.
  const replay = await loadCurrentDeferredVendorDebt(
    f.effects,
    'merge-queue',
    read.state,
    after,
    terminalClient,
  );
  expect(replay?.reference.requestId).toBe(successor.reference.requestId);
  expect(f.effects.openLedger(f.state.branch).load()).toEqual(after);
});

test('the authorized-predecessor pass stops nonfatally at the count backstop', async () => {
  const f = await fixture();
  const ancestors: PendingDebt[] = [];
  let link: QueueReference | undefined;
  for (let index = 0; index < 17; index += 1) {
    const ancestor = syntheticDebt(
      pendingTemplate(f.debt),
      `ancestor-${String(index).padStart(2, '0')}`,
      `${String(index).padStart(2, '0')}${'b'.repeat(38)}`,
      link,
    );
    ancestors.push(ancestor);
    link = ancestor.reference;
  }
  const current = syntheticDebt(
    pendingTemplate(f.debt),
    f.debt.reference.requestId,
    f.state.head,
    link,
  );
  const records = f.ledger.records.filter((entry) => entry.kind !== 'vendor-debt');
  f.effects.openLedger(f.state.branch).save({
    version: 2,
    branch: f.state.branch,
    records: [
      ...records,
      ...ancestors.map((debt) => ({ kind: 'vendor-debt' as const, debt, at: f.effects.nowIso() })),
      { kind: 'vendor-debt' as const, debt: current, at: f.effects.nowIso() },
    ],
  });
  const refreshed: string[] = [];
  const client: DeferredQueueClient = {
    ...f.client,
    status: async (ref) => {
      if (ref.requestId.startsWith('ancestor-')) refreshed.push(ref.requestId);
      return { ...f.debt.queue, state: 'awaiting-pr', pr: null };
    },
  };
  const ledger = f.effects.openLedger(f.state.branch).load();
  const debt = await loadCurrentDeferredVendorDebt(
    f.effects,
    'merge-queue',
    f.state,
    ledger,
    client,
  );
  // Truncation is nonfatal: the current enrollment is still returned...
  expect(debt?.reference.requestId).toBe(current.reference.requestId);
  // ...after exactly K refreshes, oldest first (FIFO), never renewing the budget...
  expect(refreshed).toHaveLength(16);
  expect(refreshed).toEqual(ancestors.slice(0, 16).map((ancestor) => ancestor.reference.requestId));
  expect(refreshed).not.toContain('ancestor-16');
  // ...and nothing is appended: an unsettled obligation stays visible to readiness.
  expect(f.effects.openLedger(f.state.branch).load()).toEqual(ledger);
  const authority = readCurrentEnrollment(
    ledger,
    { head: f.state.head, base: f.state.base, dirtySha256: f.state.dirtySha256 },
    'merge-queue',
  );
  if (authority.kind !== 'enrollment') throw new Error('missing current authority');
  expect(authority.enrollment.pendingAncestry).toHaveLength(17);
  const readiness = f.assemble(ledger, current);
  expect(readiness.ready).toBe(false);
  if (readiness.ready) throw new Error('unexpected readiness');
  expect(readiness.gaps.map((gap) => gap.detail).join(' ')).toContain(
    'authorized predecessor obligation(s) unsettled:',
  );
});

test('the invocation budget covers current work and fails closed before any predecessor refresh', async () => {
  const f = await fixture();
  let calls = 0;
  const remainingMs = () => {
    calls += 1;
    return calls === 1 ? 5_000 : 0;
  };
  const before = f.effects.openLedger(f.state.branch).load();
  const refreshed: string[] = [];
  const client: DeferredQueueClient = {
    ...f.client,
    status: async (ref) => {
      refreshed.push(ref.requestId);
      return f.debt.queue;
    },
  };
  await expect(
    loadCurrentDeferredVendorDebt(f.effects, 'merge-queue', f.state, before, client, undefined, {
      remainingMs,
    }),
  ).rejects.toThrow();
  expect(refreshed).toEqual([]);
  expect(f.effects.openLedger(f.state.branch).load()).toEqual(before);
});

test('a caller abort bounds each RPC and leaves a late terminal value inert', async () => {
  const f = await fixture();
  const predecessor = f.debt;
  const terminal = terminalReport(f);
  await f.repo.write('src/a.ts', 'export const a = 2;\n');
  f.repo.git('add', 'src/a.ts');
  f.repo.git('commit', '-qm', 'new head');
  const read = await readWorkState(f.effects, { target: 'merge-queue' });
  if (!read.ok) throw new Error(read.reason);
  const successorStatus: QueueStatus = { ...f.debt.queue, state: 'awaiting-pr', pr: null };
  const successor = await prepareDeferredVendorReview(f.effects, 'merge-queue', read.state, {
    ...f.client,
    enqueue: async () => successorStatus,
    status: async () => successorStatus,
  });
  if (!successor) throw new Error('missing successor');
  const controller = new AbortController();
  const client = {
    ...f.client,
    status: async (ref: QueueReference): Promise<QueueStatus> => {
      if (ref.requestId !== predecessor.reference.requestId) return successorStatus;
      controller.abort(new Error('caller cancelled'));
      await new Promise((resolve) => setTimeout(resolve, 5));
      return terminal.client.status();
    },
    report: terminal.client.report,
  };
  const before = f.effects.openLedger(f.state.branch).load();
  await expect(
    loadCurrentDeferredVendorDebt(
      f.effects,
      'merge-queue',
      read.state,
      before,
      client,
      controller.signal,
    ),
  ).rejects.toThrow(/caller cancelled/);
  // The late terminal value was never imported, acknowledged or persisted.
  expect(f.effects.openLedger(f.state.branch).load()).toEqual(before);
});

test('unrelated roots gain no authority and same-identity duplicates become gaps', async () => {
  const f = await fixture();
  const identity = { head: f.state.head, base: f.state.base, dirtySha256: f.state.dirtySha256 };
  const unrelated = syntheticDebt(pendingTemplate(f.debt), 'other-root', 'f'.repeat(40));
  const withUnrelated = {
    ...f.ledger,
    records: [
      ...f.ledger.records,
      { kind: 'vendor-debt' as const, debt: unrelated, at: f.effects.nowIso() },
    ],
  };
  const read = readCurrentEnrollment(withUnrelated, identity, 'merge-queue');
  if (read.kind !== 'enrollment') throw new Error('unrelated root displaced the enrollment');
  expect(read.enrollment.debt.reference).toEqual(f.debt.reference);
  expect(read.enrollment.ancestry).toEqual([]);
  expect(read.enrollment.pendingAncestry).toEqual([]);
  expect(currentLedgerDebt(withUnrelated, 'merge-queue', f.state)?.reference).toEqual(
    f.debt.reference,
  );

  const duplicate = syntheticDebt(pendingTemplate(f.debt), 'intent-2', f.state.head);
  const ambiguous = {
    ...f.ledger,
    records: [
      ...f.ledger.records,
      { kind: 'vendor-debt' as const, debt: duplicate, at: f.effects.nowIso() },
    ],
  };
  const ambiguousRead = readCurrentEnrollment(ambiguous, identity, 'merge-queue');
  expect(ambiguousRead.kind).toBe('ambiguous');
  if (ambiguousRead.kind !== 'ambiguous') throw new Error('unreachable');
  expect([...ambiguousRead.requestIds].sort()).toEqual(['intent-1', 'intent-2']);
  const readiness = f.assemble(ambiguous, f.debt);
  expect(readiness.ready).toBe(false);
  if (readiness.ready) throw new Error('unexpected readiness');
  expect(readiness.gaps.map((gap) => gap.detail).join(' ')).toContain(
    'ambiguous current enrollment',
  );
});

test('a caller abort before the next wrapped call never dispatches it', async () => {
  const f = await fixture();
  const terminal = terminalReport(f);
  const controller = new AbortController();
  const reason = new Error('caller cancelled before dispatch');
  let reported = 0;
  let statused = 0;
  const client = {
    ...terminal.client,
    status: async (): Promise<QueueStatus> => {
      statused += 1;
      return terminal.client.status();
    },
    report: async (ref: QueueReference, root: string): Promise<QueueEvidence> => {
      reported += 1;
      return terminal.client.report(ref, root);
    },
  };
  const before = f.effects.openLedger(f.state.branch).load();
  const evidenceDir = join(f.repo.root, '.cq', 'queue-evidence');
  const effects = {
    ...f.effects,
    runCommand: async (...call: Parameters<typeof f.effects.runCommand>) => {
      const result = await f.effects.runCommand(...call);
      const [command, args] = call;
      // Cancellation lands while the forge identity read is in flight, before any wrapped queue
      // call is attempted.
      if (command === 'gh' && args.includes('nameWithOwner')) controller.abort(reason);
      return result;
    },
  };
  await expect(
    loadCurrentDeferredVendorDebt(
      effects,
      'merge-queue',
      f.state,
      before,
      client,
      controller.signal,
    ),
  ).rejects.toThrow(reason);
  // The wrapper refuses BEFORE dispatch: no status, no report, no ack, no import, no append.
  expect(statused).toBe(0);
  expect(reported).toBe(0);
  expect(f.effects.openLedger(f.state.branch).load()).toEqual(before);
  await expect(readdir(evidenceDir)).rejects.toThrow();
});

test('a caller abort at the ancestry boundary outranks a zero budget and keeps its reason', async () => {
  const f = await fixture();
  const predecessor = f.debt;
  const terminal = terminalReport(f);
  await f.repo.write('src/a.ts', 'export const a = 2;\n');
  f.repo.git('add', 'src/a.ts');
  f.repo.git('commit', '-qm', 'new head');
  const read = await readWorkState(f.effects, { target: 'merge-queue' });
  if (!read.ok) throw new Error(read.reason);
  const successorStatus: QueueStatus = { ...f.debt.queue, state: 'awaiting-pr', pr: null };
  const successor = await prepareDeferredVendorReview(f.effects, 'merge-queue', read.state, {
    ...f.client,
    enqueue: async () => successorStatus,
    status: async () => successorStatus,
  });
  if (!successor) throw new Error('missing successor');
  const controller = new AbortController();
  const reason = new Error('caller cancelled at the ancestry boundary');
  let exhausted = false;
  const remainingMs = () => (exhausted ? 0 : 5_000);
  const store = f.effects.openLedger(f.state.branch);
  const before = store.load();
  const refreshedAncestors: string[] = [];
  const client = {
    ...terminal.client,
    status: async (ref: QueueReference): Promise<QueueStatus> => {
      if (ref.requestId === predecessor.reference.requestId) refreshedAncestors.push(ref.requestId);
      return successorStatus;
    },
  };
  let loads = 0;
  const effects = {
    ...f.effects,
    openLedger: () => ({
      ...store,
      // The final ledger read is the last local step before the ancestry boundary.
      load: () => {
        const ledger = store.load();
        loads += 1;
        if (loads === 1) {
          exhausted = true;
          controller.abort(reason);
        }
        return ledger;
      },
    }),
  };
  await expect(
    loadCurrentDeferredVendorDebt(
      effects,
      'merge-queue',
      read.state,
      before,
      client,
      controller.signal,
      {
        remainingMs,
      },
    ),
  ).rejects.toThrow(reason);
  // The caller's cancellation is the reason, never a silent nonfatal truncation.
  expect(refreshedAncestors).toEqual([]);
  expect(f.effects.openLedger(f.state.branch).load()).toEqual(before);
});

test('in-flight deadline expiry during an ancestor RPC truncates nonfatally', async () => {
  const f = await fixture();
  const predecessor = f.debt;
  const terminal = terminalReport(f);
  await f.repo.write('src/a.ts', 'export const a = 2;\n');
  f.repo.git('add', 'src/a.ts');
  f.repo.git('commit', '-qm', 'new head');
  const read = await readWorkState(f.effects, { target: 'merge-queue' });
  if (!read.ok) throw new Error(read.reason);
  const successorStatus: QueueStatus = { ...f.debt.queue, state: 'awaiting-pr', pr: null };
  const successor = await prepareDeferredVendorReview(f.effects, 'merge-queue', read.state, {
    ...f.client,
    enqueue: async () => successorStatus,
    status: async () => successorStatus,
  });
  if (!successor) throw new Error('missing successor');
  // A wide margin keeps this deterministic: the budget survives the current work and is exhausted
  // while the ancestor status is still in flight.
  const budget = 400;
  const remainingMs = () => budget;
  const before = f.effects.openLedger(f.state.branch).load();
  const client = {
    ...terminal.client,
    status: async (ref: QueueReference): Promise<QueueStatus> => {
      if (ref.requestId !== predecessor.reference.requestId) return successorStatus;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      return successorStatus;
    },
  };
  const debt = await loadCurrentDeferredVendorDebt(
    f.effects,
    'merge-queue',
    read.state,
    before,
    client,
    undefined,
    { remainingMs },
  );
  // Truncation is nonfatal: the verified current enrollment comes back...
  expect(debt?.reference.requestId).toBe(successor.reference.requestId);
  // ...nothing is appended, and the retained obligation stays a readiness gap.
  expect(f.effects.openLedger(f.state.branch).load()).toEqual(before);
  const readiness = assembleReadiness({
    branch: f.state.branch,
    target: 'merge-queue',
    identity: { head: read.state.head, base: read.state.base, dirtySha256: read.state.dirtySha256 },
    ledger: before,
    untracked: [],
    configuredReviewers: ['agent', 'coderabbit'],
    deferredVendorDebt: successor,
    nowIso: f.effects.nowIso(),
  });
  expect(readiness.ready).toBe(false);
  if (readiness.ready) throw new Error('unexpected readiness');
  expect(readiness.gaps.map((gap) => gap.detail).join(' ')).toContain(
    'authorized predecessor obligation(s) unsettled:',
  );
});

test('an unrelated trust failure coinciding with expiry still propagates', async () => {
  const f = await fixture();
  const predecessor = f.debt;
  await f.repo.write('src/a.ts', 'export const a = 2;\n');
  f.repo.git('add', 'src/a.ts');
  f.repo.git('commit', '-qm', 'new head');
  const read = await readWorkState(f.effects, { target: 'merge-queue' });
  if (!read.ok) throw new Error(read.reason);
  const successorStatus: QueueStatus = { ...f.debt.queue, state: 'awaiting-pr', pr: null };
  const successor = await prepareDeferredVendorReview(f.effects, 'merge-queue', read.state, {
    ...f.client,
    enqueue: async () => successorStatus,
    status: async () => successorStatus,
  });
  if (!successor) throw new Error('missing successor');
  let exhausted = false;
  const remainingMs = () => (exhausted ? 0 : 5_000);
  const client = {
    ...f.client,
    status: async (ref: QueueReference): Promise<QueueStatus> => {
      if (ref.requestId === predecessor.reference.requestId) {
        // The clock expires first, THEN an unrelated trust failure surfaces: the catch must
        // classify by the caught outcome, never by the clock.
        exhausted = true;
        throw new Error('queue alias status binding mismatch');
      }
      return successorStatus;
    },
  };
  const before = f.effects.openLedger(f.state.branch).load();
  await expect(
    loadCurrentDeferredVendorDebt(effectsFor(f), 'merge-queue', read.state, before, client, undefined, {
      remainingMs,
    }),
  ).rejects.toThrow(/queue alias status binding mismatch/);
  expect(f.effects.openLedger(f.state.branch).load()).toEqual(before);
});

/** The fixture's effects, unchanged: a small helper keeps the call sites readable. */
function effectsFor(f: Awaited<ReturnType<typeof fixture>>) {
  return f.effects;
}
