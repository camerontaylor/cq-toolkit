// CONTRACT FIXTURE — consumed by phase-3 lane D goal D1 (planSweep
// integration test); changes here are breaking changes for lane D.
//
// This file pins the exact ledger semantics WS-D's planSweep consumes at
// dispatch (UC §1 row 8 — the ledger prevents re-fixing known noise). The
// end-to-end integration itself (planSweep consulting view.knownNoise and
// routing view.needsHuman) lands with D1 — the deferred test below marks
// that handoff — while everything D1 relies on is asserted HERE:
//   (a) `view.knownNoise` is exactly the list dispatch must skip
//       re-fixing: signatures whose count reached suppressAt, canonically
//       sorted, derived from the same store state record wrote;
//   (b) `view.needsHuman` entries must route to a human: each count
//       reached escalateAt, and the record op itself emitted a
//       `needs-human` result whose reason names signature, count, and
//       threshold;
//   (c) the view shape is plain JSON-serializable — a JSON round trip is
//       deep-equal — so it can cross the planner boundary as data;
//   (d) the registry input schemas accept the plain JSON a planner would
//       send: { storePath, signature } for record, { storePath } for query.
import { describe, expect, test } from 'vitest';
import type { LedgerEntry, LedgerFile } from '../../../src/ops/ledger/store.js';
import type { LedgerStore } from '../../../src/ops/ledger/ledger.js';
import { makeLedgerQuery, makeLedgerRecord } from '../../../src/ops/ledger/ledger.js';
import { LedgerQueryInputSchema, LedgerRecordInputSchema } from '../../../src/ops/ledger/registry.js';

/** In-memory store over a deep-cloned file — the same fake the decision table uses. */
function memoryStore(entries: LedgerEntry[]): LedgerStore {
  let file: LedgerFile = { version: 1, entries };
  return {
    load: () => structuredClone(file),
    save: (next) => {
      file = structuredClone(next);
    },
  };
}

describe('planSweep consumption contract (WS-D / lane D)', () => {
  test('(a) knownNoise is exactly the skip-list: signatures at suppressAt, sorted, from the recorded store state', async () => {
    const store = memoryStore([
      { signature: 'sig-fresh', count: 1 }, // below suppressAt → dispatch still fixes
      { signature: 'sig-noise', count: 2 }, // at suppressAt → known noise
      { signature: 'sig-human', count: 4 }, // escalated → known noise AND needsHuman
    ]);
    const query = await makeLedgerQuery(() => store)({ storePath: 'unused-by-the-fake' });
    if (query.status !== 'ok') {
      throw new Error(`query failed: ${query.status === 'failed' ? query.error : query.status}`);
    }
    expect(query.value.knownNoise).toEqual(['sig-human', 'sig-noise']);
    expect(query.value.knownNoise).not.toContain('sig-fresh');
  });

  test('(b) needsHuman entries must route to a human: the record op emitted needs-human with the naming reason', async () => {
    const store = memoryStore([]);
    const record = makeLedgerRecord(() => store);
    await record({ storePath: 'unused-by-the-fake', signature: 'sig-human' });
    await record({ storePath: 'unused-by-the-fake', signature: 'sig-human' });
    const escalated = await record({ storePath: 'unused-by-the-fake', signature: 'sig-human' });
    // The escalation IS the needs-human emission — this result shape is what
    // dispatch observes, and the reason is what the human reads.
    expect(escalated).toEqual({
      status: 'needs-human',
      reason: 'error signature exceeded escalation threshold: sig-human (count 3 ≥ 3)',
    });
    const query = await makeLedgerQuery(() => store)({ storePath: 'unused-by-the-fake' });
    expect(query.status === 'ok' && query.value.needsHuman).toEqual(['sig-human']);
    // (a) holds for escalated signatures too: needsHuman ⊆ knownNoise.
    expect(query.status === 'ok' && query.value.knownNoise).toContain('sig-human');
  });

  test('(c) the view is plain JSON-serializable: a JSON round trip is deep-equal', async () => {
    const store = memoryStore([
      { signature: 'sig-noise', count: 2, component: 'core' },
      { signature: 'sig-human', count: 5, note: 'gh thread 12' },
      { signature: 'sig-fresh', count: 1 },
    ]);
    const query = await makeLedgerQuery(() => store)({ storePath: 'unused-by-the-fake' });
    if (query.status !== 'ok') {
      throw new Error(`query failed: ${query.status === 'failed' ? query.error : query.status}`);
    }
    expect(JSON.parse(JSON.stringify(query.value))).toEqual(query.value);
  });

  test('(d) the registry schemas accept the plain JSON a planner would send', () => {
    expect(LedgerRecordInputSchema.safeParse({ storePath: '.cq/ledger.json', signature: 'sig-a' }).success).toBe(
      true,
    );
    expect(LedgerQueryInputSchema.safeParse({ storePath: '.cq/ledger.json' }).success).toBe(true);
    // …including the optional fields a planner may attach.
    expect(
      LedgerRecordInputSchema.safeParse({
        storePath: '.cq/ledger.json',
        signature: 'sig-a',
        component: 'core',
        note: 'recurring flake',
        thresholds: { suppressAt: 1, escalateAt: 2 },
      }).success,
    ).toBe(true);
  });
});

// DEFERRED to lane D goal D1: the planSweep integration test — dispatch
// consults view.knownNoise to skip re-fixing and routes every
// view.needsHuman entry to a human. The contract above is the fixture D1
// builds on; nothing here needs to change when D1 lands.
test.todo('planSweep consults the ledger view at dispatch (lands with lane D goal D1)');
