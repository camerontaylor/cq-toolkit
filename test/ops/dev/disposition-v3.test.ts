// ADR-0008 T38 — dev-ledger version 3: disposition persistence. Dual-read
// of ledger versions 2 and 3, the v3 disposition provenance fields
// (owner/evidence/reviewTrigger/fingerprint/acceptedRisk), the legacy
// v2 fields as explicitly UNKNOWN (never fabricated), and the preserved
// v1 target-proof refusal. Fake/local inputs only — parse/serialize are
// pure, so nothing spawns and no network is touched.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  DEV_LEDGER_VERSION,
  encodeBranchForFilename,
  parseDevLedger,
  pathDevLedgerStore,
  serializeDevLedger,
} from '../../../src/ops/dev/record.js';
import type { DevDispositionRecord, DevLedgerFile } from '../../../src/ops/dev/record.js';
import type { FindingFingerprint } from '../../../src/kernel/types.js';
import { BRANCH, HEAD, dispositionRecord, makeFakeEffects } from './fakes.js';
import { makeDevDisposition } from '../../../src/ops/dev/disposition.js';

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

/**
 * A scripted effects fixture for the input-surface tests: the branch/head
 * git commands the op resolves, plus a seeded cycle carrying one finding.
 */
function inputEffects() {
  const effects = makeFakeEffects((command, args) => {
    if (command === 'git' && args[0] === 'symbolic-ref') return 'refs/heads/test/branch\n';
    if (command === 'git' && args[0] === 'rev-parse') return `${HEAD}\n`;
    return undefined;
  });
  effects.store.save({
    version: DEV_LEDGER_VERSION,
    branch: BRANCH,
    records: [
      {
        kind: 'cycle',
        cycleId: 'c001-aaaaaaaa',
        reviewer: 'coderabbit',
        scope: 'full',
        target: 'main',
        base: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        head: HEAD,
        dirtySha256: 'dirty',
        completion: { kind: 'terminal' },
        findings: [{ id: 'c001-aaaaaaaa#f1', severity: 'major' }],
        logPath: '/tmp/log',
        untracked: [],
        at: '2026-11-03T00:00:00.000Z',
      },
    ],
  });
  return effects;
}

function ledger(version: number, records: DevLedgerFile['records']): DevLedgerFile {
  return { version: version as DevLedgerFile['version'], branch: BRANCH, records };
}

describe('T38: the dev-ledger v3 disposition format', () => {
  const tmpDirs: string[] = [];
  afterEach(async () => {
    for (const dir of tmpDirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });
  test('T38 record round-trip: a v3 disposition serializes as version 3 and parses back verbatim', () => {
    const file = ledger(DEV_LEDGER_VERSION, [dispositionV3()]);
    const text = serializeDevLedger(file);
    expect(JSON.parse(text)).toHaveProperty('version', 3);
    expect(parseDevLedger(text)).toEqual(file);
  });

  test('T38 record round-trip: a v2 ledger and its v2 disposition still parse (dual-read)', () => {
    const file = ledger(2, [dispositionRecord()]);
    // Reads dual-read 2, but the WRITER is 3-only (new writes as 3).
    expect(() => serializeDevLedger(file)).toThrow(/writes 3 only/);
    expect(parseDevLedger(JSON.stringify(file))).toEqual(file);
  });

  test('T38 record round-trip: the store upgrades a v2 ledger to version 3 on any append (records unchanged)', async () => {
    const record = dispositionV3();
    const root = await mkdtemp(join(tmpdir(), 'cq-dev-disp-v3-'));
    tmpDirs.push(root);
    const store = pathDevLedgerStore(root, BRANCH);
    store.save({ version: 2, branch: BRANCH, records: [record] });
    // A save of an explicitly v2 file is a write: it lands as 3.
    expect(store.load()).toEqual({ version: 3, branch: BRANCH, records: [record] });
    // And a v2 ledger left on disk by an older writer is upgraded by the next
    // mutate append (the spread sites in deferredLedger.ts inherit this via
    // the same publish path).
    await writeFile(
      join(root, '.cq', 'dev', encodeBranchForFilename(BRANCH) + '.json'),
      JSON.stringify({ version: 2, branch: BRANCH, records: [record] }),
    );
    await store.mutate((latest) => ({
      ledger: { ...latest, records: [...latest.records, record] },
      value: undefined,
    }));
    const loaded = store.load();
    expect(loaded).toHaveProperty('version', 3);
    expect(loaded.records).toHaveLength(2);
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
    // The dual-read keeps legacy v2-shaped records parseable: their
    // provenance fields are absent on read (unknown), never fabricated.
    const file = ledger(DEV_LEDGER_VERSION, [dispositionRecord()]);
    expect(parseDevLedger(serializeDevLedger(file))).toEqual(file);
  });

  test('T38 record failure boundary: ledger versions 1 and 4 refuse to parse, and the writer writes 3 only', () => {
    expect(() => parseDevLedger(JSON.stringify(ledger(1, [])))).toThrow(
      /schema violation|dev-record/,
    );
    expect(() => parseDevLedger(JSON.stringify(ledger(4, [])))).toThrow(/schema violation/);
    expect(() => serializeDevLedger(ledger(2, []))).toThrow(/writes 3 only/);
    expect(() => serializeDevLedger(ledger(4, []))).toThrow(/writes 3 only/);
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

describe('T38: the dev.disposition input surface', () => {
  test('T38 input round-trip: owner/evidence/reviewTrigger/acceptedRisk land in the written v3 disposition verbatim', async () => {
    const effects = inputEffects();
    const result = await makeDevDisposition(effects)({
      repoRoot: '/repo',
      findingId: 'c001-aaaaaaaa#f1',
      action: 'deferred',
      why: 'tracked as TODO-1',
      owner: 'implementor',
      evidence: ['receipt-1', 'commit:abcd'],
      reviewTrigger: 're-check at next head',
      fingerprint: FINGERPRINT,
      acceptedRisk: 'cosmetic only',
    });
    expect(result.status).toBe('ok');
    const stored = effects.store
      .file()
      .records.find((r): r is DevDispositionRecord => r.kind === 'disposition');
    expect(stored).toMatchObject({
      findingId: 'c001-aaaaaaaa#f1',
      action: 'deferred',
      owner: 'implementor',
      evidence: ['receipt-1', 'commit:abcd'],
      reviewTrigger: 're-check at next head',
      fingerprint: FINGERPRINT,
      acceptedRisk: 'cosmetic only',
    });
    // The persisted file parses back verbatim (round-trip through the store).
    expect(parseDevLedger(JSON.stringify(effects.store.file()))).toEqual(effects.store.file());
  });

  test('T38 input unknown evidence: a disposition without a fingerprint records fingerprint as an EXPLICIT null (unknown, never omitted, never manufactured)', async () => {
    const effects = inputEffects();
    // The finding is known from the cycle; the disposition names no
    // fingerprint and the record still parses — unknown identity is a
    // null key, not a manufactured F1 identity.
    const result = await makeDevDisposition(effects)({
      repoRoot: '/repo',
      findingId: 'c001-aaaaaaaa#f1',
      action: 'fixed',
      why: 'addressed in the diff',
      owner: 'implementor',
      evidence: [],
    });
    expect(result.status).toBe('ok');
    const stored = effects.store
      .file()
      .records.find((r): r is DevDispositionRecord => r.kind === 'disposition');
    expect(stored).toHaveProperty('fingerprint', null);
    expect(stored?.owner).toBe('implementor');
    expect(stored?.reviewTrigger).toBeNull();
  });

  test('T38 input unknown evidence: a v3 disposition record missing the fingerprint key is rejected (unknown is null, not absent)', () => {
    const withoutFingerprint: Partial<DevDispositionRecord> = dispositionV3();
    delete withoutFingerprint.fingerprint;
    expect(() =>
      parseDevLedger(
        JSON.stringify({
          version: DEV_LEDGER_VERSION,
          branch: BRANCH,
          records: [withoutFingerprint],
        }),
      ),
    ).toThrow(/schema violation/);
  });

  test('T38 input failure boundary: an invalid input fails without writing a disposition', async () => {
    const effects = inputEffects();
    // The schema guard (registry mirror) rejects a deferred disposition
    // without a reviewTrigger BEFORE any ledger lookup or write happens.
    const guarded = await makeDevDisposition(effects)({
      repoRoot: '/repo',
      findingId: 'c001-aaaaaaaa#f1',
      action: 'deferred',
      why: 'tracked as TODO-1',
      owner: 'implementor',
      evidence: [],
    });
    expect(guarded.status).toBe('failed');
    expect(guarded.status === 'failed' && guarded.error).toMatch(/reviewTrigger/);
    // A blank reviewTrigger, a blank owner and an empty-string evidence
    // entry each fail the same guard; nothing is written in any case.
    // (The undefined reviewTrigger case is the guarded call above.)
    for (const bad of [
      { reviewTrigger: '' },
      { reviewTrigger: '  ' },
      { owner: '' },
      { owner: '  ' },
      { evidence: ['ok', ''] as string[] },
    ]) {
      const result = await makeDevDisposition(effects)({
        repoRoot: '/repo',
        findingId: 'c001-aaaaaaaa#f1',
        action: 'deferred',
        why: 'tracked as TODO-1',
        owner: 'implementor',
        evidence: [],
        reviewTrigger: 're-check at next head',
        ...bad,
      });
      expect(result.status).toBe('failed');
    }
    // An unknown finding id fails at the op boundary and writes nothing.
    const unknown = await makeDevDisposition(effects)({
      repoRoot: '/repo',
      findingId: 'c999-zzzzzzzz#f1',
      action: 'fixed',
      why: 'addressed',
      owner: 'implementor',
      evidence: [],
    });
    expect(unknown.status).toBe('failed');
    // In every failure case the ledger still holds only the seeded cycle.
    expect(effects.store.file().records).toHaveLength(1);
    expect(effects.store.file().records[0]?.kind).toBe('cycle');
  });
});
