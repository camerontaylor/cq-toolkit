// record.ts unit tests — the finding-metadata schema (Q17b): optional evidence
// round-trips, empty identity strings stay data, and id/severity/line keep the
// review schema's strictness. The rest of the dev-record format lives in
// record.format.test.ts.
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
import { BRANCH, cycleRecord } from './fakes.js';

describe('the dev-record format', () => {
  test('Q17b: optional finding metadata round-trips and legacy absence still parses', () => {
    const evidenceV1 = {
      version: 1 as const,
      failureScenario: 'reuse keeps every identity-bearing field',
      primary: { file: 'src/x.ts', side: 'head' as const, start: 1, end: 1, quote: 'x' },
      supporting: [],
    };
    const enriched = cycleRecord({
      findings: [
        {
          id: 'c001-aaaaaaaa#f1',
          severity: 'major',
          fileName: 'src/x.ts',
          excerpt: 'x',
          line: 1,
          rule: 'no-x',
          evidence: 'receipt-1',
          evidenceV1,
        },
      ],
    });
    const file: DevLedgerFile = {
      version: DEV_LEDGER_VERSION,
      branch: BRANCH,
      records: [enriched],
    };
    expect(parseDevLedger(serializeDevLedger(file))).toEqual(file);
    // Legacy findings (no metadata at all) still parse: absence is not a schema error.
    const legacy: DevLedgerFile = {
      version: DEV_LEDGER_VERSION,
      branch: BRANCH,
      records: [cycleRecord()],
    };
    expect(parseDevLedger(serializeDevLedger(legacy))).toEqual(legacy);
  });

  test('Q17b: empty identity strings the review record accepts are stored verbatim', () => {
    const withEmpties = cycleRecord({
      findings: [
        {
          id: 'c001-aaaaaaaa#f1',
          severity: 'major',
          fileName: '',
          excerpt: '',
          rule: '',
          evidence: '',
        },
      ],
    });
    const file: DevLedgerFile = {
      version: DEV_LEDGER_VERSION,
      branch: BRANCH,
      records: [withEmpties],
    };
    // The ledger mirrors FindingSchema's acceptance: an empty value is DATA (stored
    // verbatim), never dropped and never a reason to reject the record.
    expect(parseDevLedger(serializeDevLedger(file))).toEqual(file);
  });

  test('Q17b: id, severity and line keep the review schema strictness', () => {
    for (const bad of [{ id: '' }, { severity: '' }, { line: 0 }]) {
      expect(() =>
        parseDevLedger(
          JSON.stringify({
            version: DEV_LEDGER_VERSION,
            branch: BRANCH,
            records: [
              cycleRecord({
                findings: [{ id: 'f1', severity: 'major', ...bad }] as never,
              }),
            ],
          }),
        ),
      ).toThrow(/schema violation/);
    }
  });

  test('Q17b: a cycle finding refuses unknown keys and out-of-band status/reason', () => {
    const base = { version: DEV_LEDGER_VERSION, branch: BRANCH };
    expect(() =>
      parseDevLedger(
        JSON.stringify({
          ...base,
          records: [
            cycleRecord({
              findings: [{ id: 'f1', severity: 'major', mystery: true }] as never,
            }),
          ],
        }),
      ),
    ).toThrow(/schema violation/);
    expect(() =>
      parseDevLedger(
        JSON.stringify({
          ...base,
          records: [
            cycleRecord({
              findings: [{ id: 'f1', severity: 'major', status: 'rejected' }] as never,
            }),
          ],
        }),
      ),
    ).toThrow(/schema violation/);
  });
});
