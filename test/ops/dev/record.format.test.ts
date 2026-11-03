// record.ts unit tests — the dev-record format: deterministic serialize and
// strict parse of every record kind, including the reuse linkage and the
// fail-closed parse refusals. The finding-metadata schema tests live in
// record.finding-schema.test.ts.
// Split provenance: test/ops/dev/record.test.ts was split into record.format.test.ts,
// record.finding-schema.test.ts, record.branch-path.test.ts, record.store.test.ts,
// record.readiness.test.ts, record.reuse-selector.test.ts and
// record.readiness-reuse.test.ts.
import { describe, expect, test } from 'vitest';
import {
  DEV_LEDGER_VERSION,
  parseDevLedger,
  serializeDevLedger,
} from '../../../src/ops/dev/record.js';
import type { DevLedgerFile } from '../../../src/ops/dev/record.js';
import { BRANCH, checkRecord, cycleRecord, dispositionRecord } from './fakes.js';
import { reuseRecord } from './record.helpers.js';

describe('the dev-record format', () => {
  test('serialize is deterministic: schema key order, 2-space indent, one trailing newline', () => {
    const file: DevLedgerFile = {
      version: DEV_LEDGER_VERSION,
      branch: BRANCH,
      records: [dispositionRecord()],
    };
    const once = serializeDevLedger(file);
    const twice = serializeDevLedger({
      version: DEV_LEDGER_VERSION,
      branch: BRANCH,
      records: [dispositionRecord()],
    });
    expect(once).toBe(twice);
    expect(once.endsWith('\n')).toBe(true);
    expect(once.endsWith('\n\n')).toBe(false);
    expect(JSON.parse(once)).toHaveProperty('version', DEV_LEDGER_VERSION);
  });

  test('serialize refuses duplicate record ids (the store never collapses)', () => {
    const file: DevLedgerFile = {
      version: DEV_LEDGER_VERSION,
      branch: BRANCH,
      records: [cycleRecord(), cycleRecord()],
    };
    expect(() => serializeDevLedger(file)).toThrow(/duplicate record id/);
  });

  test('parse round-trips a serialized file', () => {
    const file: DevLedgerFile = {
      version: DEV_LEDGER_VERSION,
      branch: BRANCH,
      records: [cycleRecord(), checkRecord(), dispositionRecord(), reuseRecord()],
    };
    expect(parseDevLedger(serializeDevLedger(file))).toEqual(file);
  });

  test('a reuse record round-trips with the resolvesCycleId linkage kept verbatim', () => {
    const record = reuseRecord({
      basis: 'no-fresh-tail',
      resolvesCycleId: 'c002-aaaaaaaa',
    });
    const file: DevLedgerFile = {
      version: DEV_LEDGER_VERSION,
      branch: BRANCH,
      records: [record],
    };
    expect(parseDevLedger(serializeDevLedger(file))).toEqual(file);
  });

  test('a reuse record id collides in the ONE shared id space', () => {
    const file: DevLedgerFile = {
      version: DEV_LEDGER_VERSION,
      branch: BRANCH,
      records: [cycleRecord({ cycleId: 'r001-aaaaaaaa' }), reuseRecord()],
    };
    expect(() => serializeDevLedger(file)).toThrow(/duplicate record id 'r001-aaaaaaaa'/);
    expect(() =>
      parseDevLedger(serializeDevLedger({ ...file, records: [reuseRecord(), reuseRecord()] })),
    ).toThrow(/duplicate record id/);
  });

  test('a hand-edited reuse record with an unknown basis or extra key refuses to parse', () => {
    expect(() =>
      parseDevLedger(
        JSON.stringify({
          version: DEV_LEDGER_VERSION,
          branch: BRANCH,
          records: [reuseRecord({ basis: 'something-else' as never })],
        }),
      ),
    ).toThrow(/schema violation/);
    expect(() =>
      parseDevLedger(
        JSON.stringify({
          version: DEV_LEDGER_VERSION,
          branch: BRANCH,
          records: [{ ...reuseRecord(), mystery: true }],
        }),
      ),
    ).toThrow(/schema violation/);
    expect(() =>
      parseDevLedger(
        JSON.stringify({
          version: DEV_LEDGER_VERSION,
          branch: BRANCH,
          records: [
            // exact-terminal with a resolvesCycleId linkage is a contradiction
            { ...reuseRecord(), resolvesCycleId: 'c002-aaaaaaaa' },
          ],
        }),
      ),
    ).toThrow(/schema violation/);
  });

  test('parse fails closed: bad JSON, wrong version, unknown kind', () => {
    expect(() => parseDevLedger('not json')).toThrow(/not valid JSON/);
    // READER scope: anything above the dual-read ceiling (2 | 3) refuses —
    // including a FUTURE version, whatever the constant is at this HEAD.
    expect(() =>
      parseDevLedger(JSON.stringify({ version: DEV_LEDGER_VERSION + 1, branch: 'b', records: [] })),
    ).toThrow(/schema violation/);
    // Since ADR-0008 T38 the reader dual-reads 2 and 3, so the oldest
    // refused version is 1 (= DEV_LEDGER_VERSION - 2): v1's cycles cannot
    // prove their target and are never re-labelled.
    expect(() =>
      parseDevLedger(JSON.stringify({ version: DEV_LEDGER_VERSION - 2, branch: 'b', records: [] })),
    ).toThrow(/schema violation/);
    expect(() =>
      parseDevLedger(
        JSON.stringify({
          version: DEV_LEDGER_VERSION,
          branch: 'b',
          records: [{ kind: 'mystery' }],
        }),
      ),
    ).toThrow(/schema violation/);
    expect(() =>
      parseDevLedger(
        JSON.stringify({
          version: DEV_LEDGER_VERSION,
          branch: 'b',
          records: [cycleRecord(), cycleRecord()],
        }),
      ),
    ).toThrow(/duplicate record id/);
  });

  test('parse rejects a disposition with an empty why', () => {
    const text = JSON.stringify({
      version: DEV_LEDGER_VERSION,
      branch: BRANCH,
      records: [dispositionRecord({ why: '  ' })],
    });
    expect(() => parseDevLedger(text)).toThrow(/schema violation/);
  });
});
