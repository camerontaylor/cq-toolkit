// Analyze lane G3 — test evidence for the quarantine lane: the pure
// fail-closed state machine (quarantine on a verifier failure, consult
// before dispatch, EXPLICIT unquarantine that nothing calls automatically),
// its determinism (records sorted by playbook id; no timestamps — the
// record shape is exactly { playbookId, phase, reason }), and the
// latest-reason-wins upsert.
import { describe, expect, test } from 'vitest';
import {
  QUARANTINE_PHASE,
  makeQuarantineLedger,
} from '../../../../src/ops/analyze/playbooks/quarantine.js';

describe('makeQuarantineLedger (the pure quarantine state machine)', () => {
  test('quarantine records the phase-tagged reason; consults see it', () => {
    const ledger = makeQuarantineLedger();
    expect(ledger.isQuarantined('pb')).toBe(false);
    expect(ledger.reasonOf('pb')).toBeUndefined();
    ledger.quarantine('pb', 'playbook verifier: exited 1 — the applied remediation did not hold');
    expect(ledger.isQuarantined('pb')).toBe(true);
    expect(ledger.reasonOf('pb')).toContain('exited 1');
    expect(ledger.records()).toEqual([
      {
        playbookId: 'pb',
        phase: QUARANTINE_PHASE,
        reason: 'playbook verifier: exited 1 — the applied remediation did not hold',
      },
    ]);
    expect(QUARANTINE_PHASE).toBe('verifier-failed');
  });

  test('records are sorted by playbook id regardless of quarantine order (determinism)', () => {
    const ledger = makeQuarantineLedger();
    ledger.quarantine('zeta', 'r3');
    ledger.quarantine('alpha', 'r1');
    ledger.quarantine('mid', 'r2');
    expect(ledger.records().map((record) => record.playbookId)).toEqual(['alpha', 'mid', 'zeta']);
  });

  test('a record carries EXACTLY the three fields — no timestamps in v1 (the documented cut)', () => {
    const ledger = makeQuarantineLedger();
    ledger.quarantine('pb', 'r');
    expect(Object.keys(ledger.records()[0] as object).sort()).toEqual([
      'phase',
      'playbookId',
      'reason',
    ]);
  });

  test('a re-quarantine upserts (latest reason wins); ids stay unique', () => {
    const ledger = makeQuarantineLedger();
    ledger.quarantine('pb', 'first reason');
    ledger.quarantine('pb', 'second reason');
    expect(ledger.records()).toHaveLength(1);
    expect(ledger.reasonOf('pb')).toBe('second reason');
  });

  test('SNAPSHOT discipline: mutating a retained record (returned or listed) cannot mutate the ledger evidence', () => {
    const ledger = makeQuarantineLedger();
    const retained = ledger.quarantine('pb', 'the evidence');
    // Mutate the retained handle — the stored record is a disjoint copy.
    retained.reason = 'tampered';
    retained.playbookId = 'other';
    expect(ledger.reasonOf('pb')).toBe('the evidence');
    expect(ledger.isQuarantined('pb')).toBe(true);
    expect(ledger.isQuarantined('other')).toBe(false);
    // Same for the records() view: copies, never the stored objects.
    const listed = ledger.records();
    (listed[0] as { reason: string }).reason = 'tampered too';
    expect(ledger.records()[0]?.reason).toBe('the evidence');
  });

  test('unquarantine is explicit: it removes the record; nothing else does', () => {
    const ledger = makeQuarantineLedger();
    ledger.quarantine('pb', 'r');
    expect(ledger.unquarantine('pb')).toBe(true);
    expect(ledger.isQuarantined('pb')).toBe(false);
    expect(ledger.records()).toEqual([]);
    // Unquarantining an unquarantined playbook is a no-op returning false.
    expect(ledger.unquarantine('pb')).toBe(false);
  });

  test('a quarantine without evidence (empty id or reason) throws', () => {
    const ledger = makeQuarantineLedger();
    expect(() => ledger.quarantine('', 'r')).toThrow(RangeError);
    expect(() => ledger.quarantine('pb', '')).toThrow(RangeError);
    expect(ledger.records()).toEqual([]);
  });

  test('seeds upsert in order (last wins) and are subject to the same validation', () => {
    const ledger = makeQuarantineLedger([
      { playbookId: 'pb', phase: 'verifier-failed', reason: 'old' },
      { playbookId: 'pb', phase: 'verifier-failed', reason: 'new' },
      { playbookId: 'other', phase: 'verifier-failed', reason: 'r' },
    ]);
    expect(ledger.records().map((record) => record.playbookId)).toEqual(['other', 'pb']);
    expect(ledger.reasonOf('pb')).toBe('new');
    expect(() =>
      makeQuarantineLedger([{ playbookId: '', phase: 'verifier-failed', reason: 'r' }]),
    ).toThrow(RangeError);
  });
});
