// `coverage.new_ledger` / `record_opportunity` and the tick's `q["coverage"]`
// update, replayed against the Python oracle (apps/crq-python/coverage.py).
//
// Classification: `process` in test/suite-classes.json, because the oracle
// test runs python3.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  coverageIso,
  newCoverageLedger,
  recordOpportunity,
  recordTickOpportunity,
  type OpportunityObservation,
} from '../../../src/policy/crq/coverageOpportunity.js';
import { JsonObject, parseJsonValue, type JsonValue } from '../../../src/policy/crq/jsonValue.js';
import { pythonJsonText } from '../../../src/policy/crq/pythonJson.js';

const PYTHON_ROOT = join(import.meta.dirname, '../../../apps/crq-python');
const text = (value: JsonValue): string =>
  pythonJsonText(value, { asciiOnly: true, sortKeys: false, spacedSeparators: true });
const doc = (value: unknown): JsonValue => parseJsonValue(JSON.stringify(value));

const OBSERVATIONS: OpportunityObservation[] = [
  {
    at: '2026-11-20T01:02:03Z',
    started: true,
    pending: false,
    candidateExists: true,
    blockedReason: 'slots',
  },
  // Same timestamp: replaces the entry in place (idempotent key).
  {
    at: '2026-11-20T01:02:03Z',
    started: false,
    pending: true,
    candidateExists: false,
    blockedReason: null,
  },
  {
    at: '2026-11-20T01:14:00Z',
    started: true,
    pending: true,
    candidateExists: false,
    blockedReason: 'only',
  },
];

/** Python's ledger after replaying OBSERVATIONS onto `start` (null = new_ledger()). */
function oracle(start: unknown): string {
  const script = `
import json, sys
sys.path.insert(0, ${JSON.stringify(PYTHON_ROOT)})
import coverage
start, observations = json.loads(sys.stdin.read())
ledger = start if start else coverage.new_ledger()
for o in observations:
    ledger = coverage.record_opportunity(ledger, at=o["at"], started=o["started"],
        pending=o["pending"], candidate_exists=o["candidateExists"],
        blocked_reason=o["blockedReason"])
print(json.dumps(ledger))
`;
  return execFileSync('python3', ['-I', '-c', script], {
    input: JSON.stringify([start, OBSERVATIONS]),
    encoding: 'utf8',
  }).trimEnd();
}

describe('coverage opportunity record', () => {
  it('matches Python from a new ledger, including a repeated timestamp', () => {
    let ledger: JsonValue = newCoverageLedger();
    for (const observation of OBSERVATIONS) ledger = recordOpportunity(ledger, observation);
    expect(text(ledger)).toBe(oracle(null));
  });

  it('matches Python on an existing ledger, keeping its other fields and key order', () => {
    const start = {
      runs: { r1: { done: true } },
      schema_version: 1,
      observations: { '2026-11-19T00:00:00Z': { started: true } },
      paths: { 'a.ts': 1 },
    };
    let ledger = doc(start);
    for (const observation of OBSERVATIONS) ledger = recordOpportunity(ledger, observation);
    expect(text(ledger)).toBe(oracle(start));
  });

  it('never mutates the ledger it is given', () => {
    const ledger = newCoverageLedger();
    const before = text(ledger);
    recordOpportunity(ledger, OBSERVATIONS[0]!);
    expect(text(ledger)).toBe(before);
  });

  it('starts a fresh ledger for a missing, null or empty queue coverage (`or new_ledger()`)', () => {
    for (const coverage of [undefined, null, {}]) {
      const queue = doc(coverage === undefined ? { items: [] } : { items: [], coverage });
      const out = recordTickOpportunity(queue as JsonObject, OBSERVATIONS[0]!);
      expect(text(out.get('coverage')!)).toBe(
        text(recordOpportunity(newCoverageLedger(), OBSERVATIONS[0]!)),
      );
    }
  });

  it('raises, like Python, on a truthy ledger without object observations', () => {
    for (const coverage of [[1], { paths: {} }, { observations: [] }, 'x']) {
      const queue = doc({ items: [], coverage }) as JsonObject;
      expect(() => recordTickOpportunity(queue, OBSERVATIONS[0]!)).toThrow();
    }
  });

  it('accepts only the second-precision UTC form the tick passes', () => {
    expect(coverageIso('2026-11-20T01:02:03Z')).toBe('2026-11-20T01:02:03Z');
    for (const bad of ['2026-11-20T01:02:03.5Z', '2026-11-20 01:02:03Z', '2026-02-30T00:00:00Z']) {
      expect(() => coverageIso(bad)).toThrow();
    }
  });
});
