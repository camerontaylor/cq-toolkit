import { expect, test } from 'vitest';
import { cycleRecord } from './fakes.js';
import { loadCurrentDeferredVendorDebt } from '../../../src/ops/dev/internal/deferredLedger.js';
import { renderReadinessSection } from '../../../src/ops/pr/open.js';
import {
  assembleReadiness,
  findReusableCycle,
  parseDevLedger,
  serializeDevLedger,
} from '../../../src/ops/dev/record.js';
import { fixture } from './deferredLedgerHelpers.js';

test('strict additive ledger round-trips at the current version and refuses forged failure classes/reuse', async () => {
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
      target: 'main',
      scope: 'full',
    }),
  ).toBeNull();
});
test('verified current debt permits fresh full agent readiness, reports debt, and retains findings', async () => {
  const f = await fixture();
  const debt = await loadCurrentDeferredVendorDebt(f.effects, 'main', f.state, f.ledger, f.client);
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
test('missing fresh engine proof blocks otherwise authorized debt readiness', async () => {
  const f = await fixture();
  expect(f.assemble().ready).toBe(true);
  delete f.agent.agentCoverage;
  const missingProof = f.assemble();
  expect(missingProof.ready).toBe(false);
  if (!missingProof.ready)
    expect(missingProof.gaps.map((gap) => gap.field)).toEqual(['agent-coverage']);
});
test('reuse dispatches a fresh agent when a matching debt candidate lacks coverage', async () => {
  const f = await fixture();
  const request = {
    ...f.identity,
    reviewer: 'agent:reviewer',
    target: 'main',
    scope: 'full' as const,
  };
  expect(findReusableCycle(f.ledger.records, request)?.cycle.cycleId).toBe(f.agent.cycleId);
  delete f.agent.agentCoverage;
  expect(findReusableCycle(f.ledger.records, request)).toBeNull();
  expect(findReusableCycle([f.agent], request)?.cycle.cycleId).toBe(f.agent.cycleId);
});
test('a retained debt candidate cannot hide a later vendor cycle at a different head', async () => {
  const f = await fixture();
  f.ledger.records.push(
    cycleRecord({ ...f.identity, cycleId: 'c003-vendor', head: 'd'.repeat(40) }),
  );
  const request = {
    ...f.identity,
    reviewer: 'agent:reviewer',
    target: 'main',
    scope: 'full' as const,
  };
  expect(findReusableCycle(f.ledger.records, request)).toBeNull();
  expect(findReusableCycle(f.ledger.records, { ...request, debtValid: true })?.cycle.cycleId).toBe(
    f.agent.cycleId,
  );
});
test('fresh engine proof cannot replace authorized current vendor debt', async () => {
  const f = await fixture();
  expect(f.assemble().ready).toBe(true);
  const noDebt = assembleReadiness({
    branch: f.state.branch,
    target: 'main',
    identity: f.identity,
    ledger: f.ledger,
    untracked: [],
    nowIso: f.effects.nowIso(),
  });
  expect(noDebt.ready).toBe(false);
  if (!noDebt.ready) expect(noDebt.gaps.some((gap) => gap.field === 'vendor-debt')).toBe(true);
});
test('an unrelated later vendor blocker blocks debt readiness despite valid agent coverage', async () => {
  const f = await fixture();
  expect(f.assemble().ready).toBe(true);
  f.ledger.records.push({ ...f.origin, cycleId: 'new-blocker' });
  const blocked = f.assemble();
  expect(blocked.ready).toBe(false);
  if (!blocked.ready) {
    expect(blocked.gaps.every((gap) => gap.field === 'latest-review-blocked')).toBe(true);
    expect(blocked.gaps.some((gap) => gap.detail.includes('persisted outage origin'))).toBe(true);
  }
});
