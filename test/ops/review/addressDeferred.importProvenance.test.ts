// Split provenance: test/ops/review/addressDeferred.test.ts was split into
// addressDeferred.{admission,fixLoop,cachedFindings,realEngine,queueOwnership,
// importProvenance,emptyFileAdmission}.test.ts. This file holds the
// imported-cycle disposition provenance tests.
import { expect, test } from 'vitest';
import { cycleRecord } from '../dev/fakes.js';
import { fixture } from './addressDeferred.helpers.js';

test('P1: an imported-cycle disposition cannot lend status to a later original finding (same content)', async () => {
  const f = await fixture();
  try {
    const finding = {
      id: 'c009-aaaaaaaa#f1',
      severity: 'major',
      fileName: 'src/a.ts',
      excerpt: 'const x = 1;',
      line: 1,
      rule: 'no-x',
      evidence: 'receipt-9',
    };
    await f.effects.openLedger(f.state.branch).mutate((ledger) => ({
      ledger: {
        ...ledger,
        records: [
          ...ledger.records,
          cycleRecord({
            head: f.state.head,
            base: f.state.base,
            dirtySha256: 'clean-tree',
            cycleId: 'c009-aaaaaaaa',
            reviewer: 'review.address:import',
            findings: [finding],
          }),
          {
            kind: 'disposition',
            findingId: finding.id,
            action: 'rejected',
            why: 'imported repeat',
            head: f.state.head,
            at: '2026-10-17T00:00:00.000Z',
          },
          cycleRecord({
            head: f.state.head,
            base: f.state.base,
            dirtySha256: 'clean-tree',
            cycleId: 'c010-aaaaaaaa',
            findings: [finding],
          }),
        ],
      },
      value: undefined,
    }));
    const context = await f.resolver({
      repoRoot: f.repo.root,
      target: 'main',
      base: f.state.base,
      record: f.record(),
    });
    const row = context?.findings.find((item) => item.id === finding.id);
    // The import cycle is repeat transport: no eligible witness precedes the
    // disposition, so the later original finding stays OPEN.
    expect(row).toMatchObject({ status: 'open' });
    expect(row?.reason).toBeUndefined();
  } finally {
    await f.cleanup();
  }
});

test('P1: the same imported-cycle sequence with CHANGED later content also stays open', async () => {
  const f = await fixture();
  try {
    const imported = {
      id: 'c009-aaaaaaaa#f1',
      severity: 'major',
      fileName: 'src/a.ts',
      excerpt: 'imported repeat text',
      line: 1,
      rule: 'no-x',
    };
    const original = { ...imported, excerpt: 'genuine original text' };
    await f.effects.openLedger(f.state.branch).mutate((ledger) => ({
      ledger: {
        ...ledger,
        records: [
          ...ledger.records,
          cycleRecord({
            head: f.state.head,
            base: f.state.base,
            dirtySha256: 'clean-tree',
            cycleId: 'c009-aaaaaaaa',
            reviewer: 'review.address:import',
            findings: [imported],
          }),
          {
            kind: 'disposition',
            findingId: imported.id,
            action: 'fixed',
            why: 'imported repeat',
            head: f.state.head,
            at: '2026-10-17T00:00:00.000Z',
          },
          cycleRecord({
            head: f.state.head,
            base: f.state.base,
            dirtySha256: 'clean-tree',
            cycleId: 'c010-aaaaaaaa',
            findings: [original],
          }),
        ],
      },
      value: undefined,
    }));
    const context = await f.resolver({
      repoRoot: f.repo.root,
      target: 'main',
      base: f.state.base,
      record: f.record(),
    });
    const row = context?.findings.find((item) => item.id === imported.id);
    expect(row).toMatchObject({ status: 'open', text: 'genuine original text' });
    expect(row?.reason).toBeUndefined();
  } finally {
    await f.cleanup();
  }
});
