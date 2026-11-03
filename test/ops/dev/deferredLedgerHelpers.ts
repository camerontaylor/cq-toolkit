// Shared fixtures and adapters for the split deferredLedger.test.ts subject files.
import { afterEach, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  importQueueEvidence,
  type QueueEvidence,
} from '../../../src/ops/review/internal/queueEvidence.js';
import {
  deferVendorReview,
  type DeferredVendorDebt,
} from '../../../src/ops/dev/internal/deferredReview.js';
import { makeTestRepo, repoEffects, type TestRepo } from './repo.js';
import type { CommandResult } from '../../../src/ops/dev/effects.js';
import { checkRecord, cycleRecord } from './fakes.js';
import { readWorkState } from '../../../src/ops/dev/internal/workState.js';
import { prepareDeferredVendorReview } from '../../../src/ops/dev/internal/deferredLedger.js';
import {
  assembleReadiness,
  DEV_LEDGER_VERSION,
  devLedgerPath,
  type DevLedgerFile,
} from '../../../src/ops/dev/record.js';
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
export async function fixture() {
  const repo = await makeTestRepo();
  repos.push(repo);
  const effects = repoEffects(repo, (command, args) =>
    command === 'gh' ? (args[0] === 'api' ? 'author' : 'owner/repo') : undefined,
  );
  const read = await readWorkState(effects, { target: 'main' });
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
      target: 'main',
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
      target: 'main',
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
    version: DEV_LEDGER_VERSION,
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
      target: 'main',
      identity,
      ledger: file,
      untracked: [],
      configuredReviewers: ['agent', 'coderabbit'],
      deferredVendorDebt: value,
      nowIso: effects.nowIso(),
    });
  return { repo, effects, state, client, ledger, debt, origin, agent, assemble, identity };
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
export function terminalReport(
  f: Awaited<ReturnType<typeof fixture>>,
  findings: Record<string, unknown>[] = [],
  fixed = false,
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
      fixed,
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
export type PendingDebt = Extract<DeferredVendorDebt, { vendorCompleted: false }>;

/** A pending debt cloned onto a new request identity/head, keeping the template's origin. */
export function syntheticDebt(
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

export function pendingTemplate(debt: DeferredVendorDebt): PendingDebt {
  if (debt.vendorCompleted) throw new Error('fixture debt must be pending');
  return debt;
}
/** The fixture's effects, unchanged: a small helper keeps the call sites readable. */
export function effectsFor(f: Awaited<ReturnType<typeof fixture>>) {
  return f.effects;
}
/** A pending successor at a new head whose authorized ancestor is still pending at the older head. */
export async function successorWithPendingAncestor() {
  const f = await fixture();
  const predecessor = f.debt;
  const terminal = terminalReport(f);
  await f.repo.write('src/a.ts', 'export const a = 2;\n');
  f.repo.git('add', 'src/a.ts');
  f.repo.git('commit', '-qm', 'new head');
  const read = await readWorkState(f.effects, { target: 'main' });
  if (!read.ok) throw new Error(read.reason);
  const successorStatus: QueueStatus = { ...f.debt.queue, state: 'awaiting-pr', pr: null };
  const successor = await prepareDeferredVendorReview(f.effects, 'main', read.state, {
    ...f.client,
    enqueue: async () => successorStatus,
    status: async () => successorStatus,
  });
  if (!successor) throw new Error('missing successor');
  return { f, predecessor, terminal, successorStatus, successor, read };
}
/** Adapter-shaped failed results: the real subprocess seam resolves these instead of rejecting. */
export function adapterAborted(): CommandResult {
  return { exitCode: null, stdout: '', stderr: 'aborted', timedOut: false };
}
export function adapterTimedOut(): CommandResult {
  return { exitCode: null, stdout: '', stderr: 'timeout', timedOut: true };
}
/** Arm only the post-import identity read; capture-tree verification is a separate window. */
export async function ancestryIdentityFixture() {
  const setup = await successorWithPendingAncestor();
  const { f, predecessor, terminal, successorStatus } = setup;
  let imported = false;
  let readingIdentity = false;
  const seam = { run: f.effects.runCommand };
  const client = {
    ...terminal.client,
    status: async (ref: QueueReference): Promise<QueueStatus> =>
      ref.requestId === predecessor.reference.requestId
        ? terminal.client.status()
        : successorStatus,
    report: async (ref: QueueReference, root: string): Promise<QueueEvidence> => {
      const evidence = await terminal.client.report(ref, root);
      imported = true;
      return evidence;
    },
  };
  const effects = {
    ...f.effects,
    runCommand: async (...call: Parameters<typeof f.effects.runCommand>) => {
      if (imported && call[0] === 'git' && call[1].includes('symbolic-ref')) readingIdentity = true;
      return readingIdentity ? seam.run(...call) : f.effects.runCommand(...call);
    },
  };
  const before = f.effects.openLedger(f.state.branch).load();
  const path = devLedgerPath(f.repo.root, f.state.branch);
  const bytes = await readFile(path);
  const unchanged = async () => expect(await readFile(path)).toEqual(bytes);
  return { ...setup, client, effects, before, unchanged, seam };
}
/** Current pending enrollment with no ancestors: only the invocation's identity work is observed. */
export async function currentIdentityFixture() {
  const f = await fixture();
  const before = f.effects.openLedger(f.state.branch).load();
  const path = devLedgerPath(f.repo.root, f.state.branch);
  const bytes = await readFile(path);
  const unchanged = async () => expect(await readFile(path)).toEqual(bytes);
  return { f, before, unchanged };
}
