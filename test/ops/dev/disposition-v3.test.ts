// ADR-0008 T38 — dev-ledger version 3: disposition persistence. Dual-read
// of ledger versions 2 and 3, the v3 disposition provenance fields
// (owner/evidence/reviewTrigger/fingerprint/acceptedRisk), the legacy
// v2 fields as explicitly UNKNOWN (never fabricated), and the preserved
// v1 target-proof refusal. Fake/local inputs only — parse/serialize are
// pure, so nothing spawns and no network is touched.
import { describe, expect, test } from 'vitest';
import {
  DEV_LEDGER_VERSION,
  parseDevLedger,
  serializeDevLedger,
} from '../../../src/ops/dev/record.js';
import type { DevDispositionRecord, DevLedgerFile } from '../../../src/ops/dev/record.js';
import type { FindingFingerprint } from '../../../src/kernel/types.js';
import { BRANCH, HEAD, dispositionRecord } from './fakes.js';

const FINGERPRINT: FindingFingerprint = {
  version: 1,
  checkId: 'lint',
  rule: 'no-unused-vars',
  path: 'src/x.ts',
  spanContentHash: null,
};

/** The fixture v2 disposition enriched to the full v3 provenance shape. */
function dispositionV3(overrides: Partial<DevDispositionRecord> = {}): DevDispositionRecord {
  return {
    ...dispositionRecord(),
    owner: 'implementor',
    evidence: ['receipt-1'],
    reviewTrigger: null,
    fingerprint: FINGERPRINT,
    acceptedRisk: null,
    ...overrides,
  };
}

function ledger(version: number, records: DevLedgerFile['records']): DevLedgerFile {
  return { version: version as DevLedgerFile['version'], branch: BRANCH, records };
}

describe('T38: the dev-ledger v3 disposition format', () => {
  test('T38 record round-trip: a v3 disposition serializes as version 3 and parses back verbatim', () => {
    const file = ledger(DEV_LEDGER_VERSION, [dispositionV3()]);
    const text = serializeDevLedger(file);
    expect(JSON.parse(text)).toHaveProperty('version', 3);
    expect(parseDevLedger(text)).toEqual(file);
  });

  test('T38 record round-trip: a v2 ledger and its v2 disposition still parse (dual-read)', () => {
    const file = ledger(2, [dispositionRecord()]);
    const text = serializeDevLedger(file);
    expect(JSON.parse(text)).toHaveProperty('version', 2);
    expect(parseDevLedger(text)).toEqual(file);
  });

  test('T38 record round-trip: a deferred v3 disposition requires a nonempty reviewTrigger', () => {
    const file = ledger(DEV_LEDGER_VERSION, [
      dispositionV3({ action: 'deferred', reviewTrigger: 're-check at next head' }),
    ]);
    expect(parseDevLedger(serializeDevLedger(file))).toEqual(file);
    expect(() =>
      parseDevLedger(
        serializeDevLedger({
          ...file,
          records: [dispositionV3({ action: 'deferred', reviewTrigger: null })],
        }),
      ),
    ).toThrow(/schema violation|records\.0/);
  });

  test('T38 record unknown evidence: a legacy v2 disposition in a v3 ledger parses with its provenance fields ABSENT (unknown, never fabricated)', () => {
    // The legacy disposition arrives as RAW hand-written v3-ledger text:
    // serializeDevLedger refuses to author one (no in-place upgrade), but
    // parseDevLedger must still read what an older writer left behind.
    const text = JSON.stringify({
      version: DEV_LEDGER_VERSION,
      branch: BRANCH,
      records: [dispositionRecord()],
    });
    const parsed = parseDevLedger(text);
    const record = parsed.records[0] as DevDispositionRecord;
    expect(record.owner).toBeUndefined();
    expect(record.evidence).toBeUndefined();
    expect(record.reviewTrigger).toBeUndefined();
    expect(record.fingerprint).toBeUndefined();
    expect(record.acceptedRisk).toBeUndefined();
    expect(record.action).toBe('fixed');
    expect(record.why).toBe('addressed in the diff');
    expect(record.head).toBe(HEAD);
  });

  test('T38 record unknown evidence: the v3 provenance fields are strictly shaped (a fabricated value never parses)', () => {
    const badOwner = { ...dispositionV3() } as unknown as Record<string, unknown>;
    delete badOwner.owner;
    expect(() =>
      parseDevLedger(
        JSON.stringify({
          version: DEV_LEDGER_VERSION,
          branch: BRANCH,
          records: [badOwner],
        }),
      ),
    ).toThrow(/schema violation/);
    expect(() =>
      parseDevLedger(
        serializeDevLedger(
          ledger(DEV_LEDGER_VERSION, [
            dispositionV3({
              fingerprint: { ...FINGERPRINT, version: 2 as unknown as 1 },
            }),
          ]),
        ),
      ),
    ).toThrow(/schema violation/);
  });

  test('T38 record failure boundary: a legacy v2 disposition authored by the CURRENT writer serializes and re-parses (dual-read, never fabricated values)', () => {
    // The current producer still records the v2 carrier shape; the dual-read
    // means its records stay parseable until the disposition-input ticket
    // adds the provenance fields. Nothing fabricates owner/evidence here.
    const file = ledger(DEV_LEDGER_VERSION, [dispositionRecord()]);
    expect(parseDevLedger(serializeDevLedger(file))).toEqual(file);
  });

  test('T38 record failure boundary: ledger versions 1 and 4 refuse to parse, and the writer rejects any other version', () => {
    expect(() => parseDevLedger(JSON.stringify(ledger(1, [])))).toThrow(
      /schema violation|dev-record/,
    );
    expect(() => parseDevLedger(JSON.stringify(ledger(4, [])))).toThrow(/schema violation/);
    expect(() => serializeDevLedger(ledger(4, []))).toThrow(/understands 2 and 3/);
    expect(() => serializeDevLedger(ledger(1, []))).toThrow(/understands 2 and 3/);
  });

  test('T38 record failure boundary: the v1 target-proof refusal is preserved (a v1 cycle shape cannot sneak into a v2/v3 ledger)', () => {
    // The v1→v2 bump bound cycle evidence to its intended PR target; that
    // refusal is unchanged: a cycle record without `target` is a schema
    // violation at any accepted ledger version.
    const cycleWithoutTarget = {
      kind: 'cycle',
      cycleId: 'c001-aaaaaaaa',
      reviewer: 'coderabbit',
      scope: 'full',
      base: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      head: HEAD,
      dirtySha256: 'dirty',
      completion: { kind: 'terminal' },
      findings: [],
      logPath: '/tmp/log',
      untracked: [],
      at: '2026-11-03T00:00:00.000Z',
    };
    expect(() =>
      parseDevLedger(
        JSON.stringify({ ...ledger(DEV_LEDGER_VERSION, []), records: [cycleWithoutTarget] }),
      ),
    ).toThrow(/schema violation/);
    expect(() =>
      parseDevLedger(JSON.stringify({ ...ledger(2, []), records: [cycleWithoutTarget] })),
    ).toThrow(/schema violation/);
  });
});
