import { afterEach, expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import { makeTestRepo, repoEffects, type TestRepo } from './repo.js';
import { checkRecord, cycleRecord } from './fakes.js';
import { readWorkState } from '../../../src/ops/dev/internal/workState.js';
import {
  currentLedgerDebt,
  loadCurrentDeferredVendorDebt,
  bindPublishedDeferredDebt,
  prepareDeferredVendorReview,
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
