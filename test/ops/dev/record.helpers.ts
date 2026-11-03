// Shared fixtures for the record.*.test.ts files split out of the former
// test/ops/dev/record.test.ts: the affirmative no-fresh reason, a reuse record
// naming the fixture cycle, and the readiness wrapper over the shared identity.
import { assembleReadiness, DEV_LEDGER_VERSION } from '../../../src/ops/dev/record.js';
import type {
  DevCycleRecord,
  DevCheckRecord,
  DevDispositionRecord,
  DevReuseRecord,
} from '../../../src/ops/dev/record.js';
import { BASE, BRANCH, HEAD } from './fakes.js';

/** The affirmative no-fresh blocked reason exactly as decideCompletion records it. */
export const NO_FRESH_REASON =
  "reviewer completed 'review_completed' with an AFFIRMATIVE no-fresh/skipped notice " +
  '("No fresh detailed file review was performed in this run.") — a fresh detailed review never ran';

/** A reuse record naming the fixture cycle (fakes.ts c001-aaaaaaaa at the fixture identity). */
export function reuseRecord(overrides: Partial<DevReuseRecord> = {}): DevReuseRecord {
  const base: DevReuseRecord = {
    kind: 'reuse',
    reuseId: 'r001-aaaaaaaa',
    cycleId: 'c001-aaaaaaaa',
    basis: 'exact-terminal',
    target: 'main',
    base: BASE,
    head: HEAD,
    dirtySha256: 'dirty',
    scope: 'full',
    reviewer: 'coderabbit',
    logPath: '/tmp/reuse-log',
    at: '2026-10-17T00:30:00.000Z',
  };
  return { ...base, ...overrides } as DevReuseRecord;
}

export function assemble(
  ledgerRecords: (DevCycleRecord | DevCheckRecord | DevDispositionRecord | DevReuseRecord)[],
  untracked: string[] = [],
) {
  return assembleReadiness({
    branch: BRANCH,
    target: 'main',
    identity: { base: BASE, head: HEAD, dirtySha256: 'dirty' },
    ledger: { version: DEV_LEDGER_VERSION, branch: BRANCH, records: ledgerRecords },
    untracked,
    nowIso: '2026-10-17T01:00:00.000Z',
  });
}
