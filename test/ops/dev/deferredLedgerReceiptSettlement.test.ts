import { expect, test } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeDevDisposition } from '../../../src/ops/dev/disposition.js';
import { deferredReceiptFindings } from '../../../src/ops/dev/internal/deferredReview.js';
import { readWorkState } from '../../../src/ops/dev/internal/workState.js';
import {
  currentLedgerDebt,
  loadCurrentDeferredVendorDebt,
  prepareDeferredVendorReview,
} from '../../../src/ops/dev/internal/deferredLedger.js';
import type {
  QueueReference,
  QueueStatus,
} from '../../../src/ops/review/internal/queueProtocol.js';
import { fixture, terminalReport } from './deferredLedgerHelpers.js';

test('fixed true does not block verified receipt settlement or grant local remediation authority', async () => {
  const f = await fixture();
  const terminal = terminalReport(
    f,
    [{ severity: 'major', comment: 'repair already merged', fileName: 'src/a.ts' }],
    true,
  );
  const completed = await loadCurrentDeferredVendorDebt(
    f.effects,
    'main',
    f.state,
    f.ledger,
    terminal.client,
  );
  expect(completed).toMatchObject({ vendorCompleted: true, completion: { fixed: false } });
});
test('terminal status alone cannot settle; verified report clean settlement is durable, scoped and replayable', async () => {
  const f = await fixture();
  const terminal = terminalReport(f);
  await expect(
    loadCurrentDeferredVendorDebt(f.effects, 'main', f.state, f.ledger, {
      ...f.client,
      status: terminal.client.status,
    }),
  ).rejects.toThrow('report capability');
  expect(f.effects.openLedger(f.state.branch).load()).toEqual(f.ledger);
  const completed = await loadCurrentDeferredVendorDebt(
    f.effects,
    'main',
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
  await loadCurrentDeferredVendorDebt(f.effects, 'main', f.state, retained, terminal.client);
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
    'main',
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
        owner: 'test',
        evidence: [],
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
        owner: 'test',
        evidence: [],
        reviewTrigger: 're-check at next head',
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
        owner: 'test',
        evidence: [],
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
    loadCurrentDeferredVendorDebt(f.effects, 'main', f.state, f.ledger, terminal.client),
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
    loadCurrentDeferredVendorDebt(f.effects, 'main', f.state, f.ledger, unavailable),
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
    loadCurrentDeferredVendorDebt(f.effects, 'main', f.state, f.ledger, tampered),
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
    loadCurrentDeferredVendorDebt(g.effects, 'main', g.state, g.ledger, drifted),
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
    loadCurrentDeferredVendorDebt(failedEffects, 'main', f.state, f.ledger, client),
  ).rejects.toThrow('disk full');
  expect(store.load()).toEqual(f.ledger);
  const completed = await loadCurrentDeferredVendorDebt(
    f.effects,
    'main',
    f.state,
    f.ledger,
    client,
  );
  if (!completed?.vendorCompleted) throw new Error('missing completion');
  const retained = store.load();
  await loadCurrentDeferredVendorDebt(f.effects, 'main', f.state, retained, client);
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
  const read = await readWorkState(f.effects, { target: 'main' });
  if (!read.ok) throw new Error(read.reason);
  let enrollments = 0;
  const client = {
    ...terminal.client,
    enqueue: async () => {
      enrollments++;
      return f.debt.queue;
    },
  };
  expect(await prepareDeferredVendorReview(f.effects, 'main', read.state, client)).toBeUndefined();
  const retained = f.effects.openLedger(f.state.branch).load();
  const completed = retained.records.at(-1);
  expect(completed).toMatchObject({
    kind: 'vendor-debt',
    debt: { vendorCompleted: true, reference: f.debt.reference },
  });
  expect(currentLedgerDebt(retained, 'main', read.state)).toBeUndefined();
  expect(await prepareDeferredVendorReview(f.effects, 'main', read.state, client)).toBeUndefined();
  expect(enrollments).toBe(0);
  expect(retained.records[1]).toEqual(f.ledger.records[1]);
});
test('missing report or post-report queue identity refusal retains pending debt', async () => {
  const f = await fixture();
  const terminal = terminalReport(f);
  const missing = { ...terminal.client, report: async () => null };
  await expect(
    loadCurrentDeferredVendorDebt(f.effects, 'main', f.state, f.ledger, missing),
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
    loadCurrentDeferredVendorDebt(f.effects, 'main', f.state, f.ledger, invalid),
  ).rejects.toThrow('genuine complete');
  expect(f.effects.openLedger(f.state.branch).load()).toEqual(f.ledger);
});
