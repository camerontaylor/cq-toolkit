// Q17b: retained disposition restoration is content-bound and identity-complete.
// These cases exercise the REAL ledger schema (serialize -> parse) and the real
// comparator/restorer, so a field that cannot be persisted fails here first.
import { describe, expect, test } from 'vitest';
import {
  DEV_LEDGER_VERSION,
  parseDevLedger,
  serializeDevLedger,
  type DevCycleRecord,
  type DevDispositionRecord,
  type DevLedgerFile,
} from '../../../src/ops/dev/record.js';
import type { Finding, FindingEvidenceV1 } from '../../../src/ops/review/findings.js';
import {
  restoreDurableDisposition,
  retainedFindings,
  sameFindingContent,
} from '../../../src/ops/review/internal/durableDisposition.js';

const HEAD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const BASE = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const BRANCH = 'test/branch';
const AT = '2026-10-17T00:00:00.000Z';

const EVIDENCE_V1: FindingEvidenceV1 = {
  version: 1,
  failureScenario: 'a rejected finding is re-dispatched on an unchanged head',
  primary: { file: 'src/x.ts', side: 'head', start: 3, end: 3, quote: 'const x = 1;' },
  supporting: [],
};

function cycle(over: Partial<DevCycleRecord> = {}): DevCycleRecord {
  return {
    kind: 'cycle',
    cycleId: 'c001-aaaaaaaa',
    reviewer: 'coderabbit',
    scope: 'full',
    target: 'merge-queue',
    base: BASE,
    head: HEAD,
    dirtySha256: 'dirty',
    completion: { kind: 'terminal' },
    findings: [
      {
        id: 'c001-aaaaaaaa#f1',
        severity: 'major',
        fileName: 'src/x.ts',
        excerpt: 'const x = 1;',
        line: 3,
        rule: 'no-x',
        evidence: 'receipt-1',
        evidenceV1: EVIDENCE_V1,
      },
    ],
    logPath: '/tmp/log',
    untracked: [],
    at: AT,
    ...over,
  };
}

function disposition(over: Partial<DevDispositionRecord> = {}): DevDispositionRecord {
  return {
    kind: 'disposition',
    findingId: 'c001-aaaaaaaa#f1',
    action: 'rejected',
    why: 'not a real defect',
    head: HEAD,
    at: AT,
    ...over,
  };
}

/** Round-trip through the strict ledger schema: what cannot be persisted cannot witness. */
function ledger(records: DevLedgerFile['records']): DevLedgerFile {
  return parseDevLedger(
    serializeDevLedger({ version: DEV_LEDGER_VERSION, branch: BRANCH, records }),
  );
}

function incoming(over: Partial<Finding> = {}): Finding {
  return {
    id: 'c001-aaaaaaaa#f1',
    source: 'coderabbit',
    severity: 'major',
    text: 'const x = 1;',
    status: 'open',
    file: 'src/x.ts',
    line: 3,
    rule: 'no-x',
    evidence: 'receipt-1',
    evidenceV1: EVIDENCE_V1,
    ...over,
  };
}

describe('sameFindingContent — identity complete, absence is not a wildcard', () => {
  test('identical original content matches', () => {
    expect(sameFindingContent(incoming(), incoming())).toBe(true);
  });

  test('every identity-bearing field must agree', () => {
    const cases: [string, Finding][] = [
      ['source', incoming({ source: 'agent' })],
      ['text', incoming({ text: 'const x = 2;' })],
      ['file', incoming({ file: 'src/y.ts' })],
      ['severity', incoming({ severity: 'critical' })],
      ['line', incoming({ line: 4 })],
      ['rule', incoming({ rule: 'no-y' })],
      ['evidence', incoming({ evidence: 'receipt-2' })],
      ['evidenceV1', incoming({ evidenceV1: { ...EVIDENCE_V1, failureScenario: 'other' } })],
    ];
    for (const [field, row] of cases)
      expect(sameFindingContent(row, incoming()), field).toBe(false);
  });

  test('one-sided metadata never matches (legacy absence is unknown)', () => {
    const { line: _line, ...withoutLine } = incoming();
    const { rule: _rule, ...withoutRule } = incoming();
    const { evidence: _evidence, ...withoutEvidence } = incoming();
    const { evidenceV1: _evidenceV1, ...withoutEvidenceV1 } = incoming();
    expect(sameFindingContent(incoming(), withoutLine)).toBe(false);
    expect(sameFindingContent(withoutLine, incoming())).toBe(false);
    expect(sameFindingContent(incoming(), withoutRule)).toBe(false);
    expect(sameFindingContent(incoming(), withoutEvidence)).toBe(false);
    expect(sameFindingContent(incoming(), withoutEvidenceV1)).toBe(false);
    expect(sameFindingContent(withoutEvidenceV1, incoming())).toBe(false);
    expect(sameFindingContent(withoutLine, withoutLine)).toBe(true);
  });

  test('evidenceV1 compares structurally: nested and array order differences refuse', () => {
    const withSupporting = {
      ...EVIDENCE_V1,
      supporting: [
        {
          file: 'src/y.ts',
          side: 'base' as const,
          start: 1,
          end: 1,
          quote: 'y',
          relevance: 'caller',
        },
      ],
    };
    expect(sameFindingContent(incoming({ evidenceV1: withSupporting }), incoming())).toBe(false);
    // A persisted INVALID payload is carried evidence, not a verdict: it matches only
    // its own structural twin.
    const invalid = { ...EVIDENCE_V1, validation: { status: 'invalid' as const, reasons: ['x'] } };
    expect(
      sameFindingContent(incoming({ evidenceV1: invalid }), incoming({ evidenceV1: invalid })),
    ).toBe(true);
    expect(sameFindingContent(incoming({ evidenceV1: invalid }), incoming())).toBe(false);
  });

  test('an empty identity string is data, not absence: it matches only itself', () => {
    expect(sameFindingContent(incoming({ rule: '' }), incoming({ rule: '' }))).toBe(true);
    expect(sameFindingContent(incoming({ rule: '' }), incoming())).toBe(false);
    expect(sameFindingContent(incoming(), incoming({ rule: '' }))).toBe(false);
    expect(sameFindingContent(incoming({ evidence: '' }), incoming({ evidence: '' }))).toBe(true);
    expect(sameFindingContent(incoming({ evidence: '' }), incoming())).toBe(false);
    expect(
      sameFindingContent(incoming({ evidenceV1: undefined }), incoming({ evidenceV1: undefined })),
    ).toBe(true);
  });

  test.each([
    ['', '', 'rejected'],
    ['', undefined, 'open'],
    [undefined, '', 'open'],
    [undefined, undefined, 'rejected'],
  ] as const)('persisted file identity %j restores only against %j', (witness, file, status) => {
    const { fileName: _fileName, ...original } = cycle().findings[0]!;
    const { file: _file, ...row } = incoming();
    const finding = { ...row, ...(file === undefined ? {} : { file }) };
    const stored = ledger([
      cycle({
        findings: [{ ...original, ...(witness === undefined ? {} : { fileName: witness }) }],
      }),
      disposition(),
    ]);
    const restored = restoreDurableDisposition(finding, stored);
    expect(restored.status).toBe(status);
    if (status === 'open') expect(restored).not.toHaveProperty('reason');
    if (file === undefined) expect(restored).not.toHaveProperty('file');
    else expect(restored).toHaveProperty('file', '');
  });

  test.each([
    ['', '', 'rejected'],
    ['', undefined, 'open'],
    [undefined, '', 'open'],
    [undefined, undefined, 'rejected'],
  ] as const)('persisted rule identity %j restores only against %j', (witness, rule, status) => {
    const { rule: _originalRule, ...original } = cycle().findings[0]!;
    const { rule: _incomingRule, ...row } = incoming();
    const finding = { ...row, ...(rule === undefined ? {} : { rule }) };
    const stored = ledger([
      cycle({
        findings: [{ ...original, ...(witness === undefined ? {} : { rule: witness }) }],
      }),
      disposition(),
    ]);
    const restored = restoreDurableDisposition(finding, stored);
    expect(restored.status).toBe(status);
    if (status === 'open') expect(restored).not.toHaveProperty('reason');
    if (rule === undefined) expect(restored).not.toHaveProperty('rule');
    else expect(restored).toHaveProperty('rule', '');
  });

  test('the only source normalization is agent:reviewer -> agent', () => {
    expect(
      sameFindingContent(incoming({ source: 'agent:reviewer' }), incoming({ source: 'agent' })),
    ).toBe(true);
    expect(
      sameFindingContent(incoming({ source: 'agent:fixer' }), incoming({ source: 'agent' })),
    ).toBe(false);
  });
});

describe('restoreDurableDisposition — content-bound authority over the raw ledger', () => {
  test('an identical earlier witness restores the latest disposition', () => {
    const restored = restoreDurableDisposition(incoming(), ledger([cycle(), disposition()]));
    expect(restored).toMatchObject({ status: 'rejected', reason: 'not a real defect' });
    // The raw ledger is untouched and the projection grants no coverage.
    expect(restored.evidenceV1).toEqual(EVIDENCE_V1);
  });

  test('the LAST disposition for the finding wins', () => {
    const restored = restoreDurableDisposition(
      incoming(),
      ledger([cycle(), disposition(), disposition({ action: 'fixed', why: 'fixed in 1234abc' })]),
    );
    expect(restored).toMatchObject({ status: 'fixed', reason: 'fixed in 1234abc' });
  });

  test('a same-id row with changed content stays open', () => {
    const restored = restoreDurableDisposition(
      incoming({ text: 'different text' }),
      ledger([cycle(), disposition()]),
    );
    expect(restored.status).toBe('open');
    expect(restored.reason).toBeUndefined();
  });

  test('legacy witnesses without metadata cannot authenticate a metadata-bearing row', () => {
    const legacyCycle = cycle({
      findings: [{ id: 'c001-aaaaaaaa#f1', severity: 'major', excerpt: 'const x = 1;' }],
    });
    const restored = restoreDurableDisposition(incoming(), ledger([legacyCycle, disposition()]));
    expect(restored.status).toBe('open');
  });

  test('review.address:import cycles are repeat transport, never authority', () => {
    const imported = cycle({ reviewer: 'review.address:import' });
    const restored = restoreDurableDisposition(incoming(), ledger([imported, disposition()]));
    expect(restored.status).toBe('open');
  });

  test('two disagreeing original witnesses are ambiguous and stay open', () => {
    const conflicting = cycle({
      cycleId: 'c002-aaaaaaaa',
      findings: [
        {
          id: 'c001-aaaaaaaa#f1',
          severity: 'major',
          fileName: 'src/x.ts',
          excerpt: 'const x = 9;',
          line: 3,
          rule: 'no-x',
          evidence: 'receipt-1',
          evidenceV1: EVIDENCE_V1,
        },
      ],
    });
    const restored = restoreDurableDisposition(
      incoming(),
      ledger([cycle(), conflicting, disposition()]),
    );
    expect(restored.status).toBe('open');
  });

  test('a disposition with no witness is never applied', () => {
    const restored = restoreDurableDisposition(incoming(), ledger([disposition()]));
    expect(restored.status).toBe('open');
  });

  test('an incoming receipt reference cannot inherit a cycle witness without it', () => {
    const noEvidenceV1Cycle = cycle({
      findings: [
        {
          id: 'c001-aaaaaaaa#f1',
          severity: 'major',
          fileName: 'src/x.ts',
          excerpt: 'const x = 1;',
          line: 3,
          rule: 'no-x',
        },
      ],
    });
    const restored = restoreDurableDisposition(
      incoming({ evidenceV1: undefined, evidence: undefined }),
      ledger([noEvidenceV1Cycle, disposition()]),
    );
    expect(restored.status).toBe('rejected');
    // The receipt-bearing row above (evidence + evidenceV1) is refused by the same
    // ledger because the witness lacks both fields.
    expect(
      restoreDurableDisposition(incoming(), ledger([noEvidenceV1Cycle, disposition()])).status,
    ).toBe('open');
  });
});

type LedgerFinding = DevCycleRecord['findings'][number];

function ledgerFinding(over: Partial<LedgerFinding> = {}): LedgerFinding {
  return {
    id: 'c001-aaaaaaaa#f1',
    severity: 'major',
    fileName: 'src/x.ts',
    excerpt: 'const x = 1;',
    line: 3,
    rule: 'no-x',
    evidence: 'receipt-1',
    evidenceV1: EVIDENCE_V1,
    ...over,
  };
}

describe('retainedFindings — ONE ledger-ordered projection for every restoration path', () => {
  test('import cycle, then disposition, then a later genuine cycle stays OPEN (P1)', () => {
    const imported = cycle({ cycleId: 'c009-aaaaaaaa', reviewer: 'review.address:import' });
    const restored = retainedFindings(ledger([imported, disposition(), cycle()]));
    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({ id: 'c001-aaaaaaaa#f1', status: 'open' });
  });

  test('the same sequence with CHANGED later content also stays open', () => {
    const imported = cycle({ cycleId: 'c009-aaaaaaaa', reviewer: 'review.address:import' });
    const changed = cycle({ findings: [ledgerFinding({ excerpt: 'different text' })] });
    const restored = retainedFindings(ledger([imported, disposition(), changed]));
    expect(restored[0]?.status).toBe('open');
  });

  test('an eligible original witness BEFORE its disposition still restores (positive control)', () => {
    const restored = retainedFindings(ledger([cycle(), disposition()]));
    expect(restored[0]).toMatchObject({ status: 'rejected', reason: 'not a real defect' });
  });

  test('a disposition BEFORE any eligible witness never applies (ledger order)', () => {
    const restored = retainedFindings(ledger([disposition(), cycle()]));
    expect(restored[0]?.status).toBe('open');
  });

  test('an import repeat with different content neither conflicts nor witnesses', () => {
    const importedDifferent = cycle({
      cycleId: 'c009-aaaaaaaa',
      reviewer: 'review.address:import',
      findings: [ledgerFinding({ excerpt: 'imported repeat text' })],
    });
    // Only the genuine cycle is retained; the import repeat contributes nothing.
    const restored = retainedFindings(ledger([importedDifferent, disposition(), cycle()]));
    expect(restored).toHaveLength(1);
    expect(restored[0]?.status).toBe('open');
  });

  test('conflicting original witnesses still fail closed', () => {
    const conflicting = cycle({
      cycleId: 'c002-aaaaaaaa',
      findings: [ledgerFinding({ excerpt: 'other text' })],
    });
    expect(() => retainedFindings(ledger([cycle(), conflicting]))).toThrow(
      /conflicting retained finding identity/,
    );
  });

  test('the projection is content-bound: a metadata-only mismatch fails closed as a conflict', () => {
    const changedEvidence = cycle({
      cycleId: 'c009-aaaaaaaa',
      findings: [ledgerFinding({ evidence: 'receipt-2' })],
    });
    expect(() => retainedFindings(ledger([changedEvidence, cycle()]))).toThrow(
      /conflicting retained finding identity/,
    );
  });
});
