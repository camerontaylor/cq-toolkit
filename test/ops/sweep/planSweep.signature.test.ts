// Split provenance: test/ops/sweep/planSweep.test.ts was split into
// planSweep.{selector,selection,ledger,jobs,legacy-scheme,signature,subprocess}.test.ts
// plus planSweep.helpers.ts (shared fixtures). This file carries the
// gates→ledger signature recipe and the scheme-1 legacy recipe.
import { describe, expect, test } from 'vitest';
import type { CheckFailure } from '../../../src/ops/gates/checkRunner.js';
import { fingerprintFailure, fnv1a32Hex } from '../../../src/ops/gates/fingerprint.js';
import { ledgerSignature, legacyLedgerSignature } from '../../../src/ops/sweep/planSweep.js';
import { A_FAILURE } from './planSweep.helpers.js';

// ---------------------------------------------------------------------------
// 5. ledgerSignature — THE gates→ledger signature recipe
// ---------------------------------------------------------------------------

describe('ledgerSignature (the gates→ledger signature recipe)', () => {
  test('deterministic, and the compact 8-hex FNV form', () => {
    const sig = ledgerSignature(A_FAILURE, 'eslint');
    expect(sig).toBe(ledgerSignature(A_FAILURE, 'eslint'));
    expect(sig).toMatch(/^[0-9a-f]{8}$/);
  });

  test('tool-namespaced: the same failure under different tools never collides', () => {
    expect(ledgerSignature(A_FAILURE, 'eslint')).not.toBe(ledgerSignature(A_FAILURE, 'vitest'));
  });

  test('pins the FNV-1a compact form over the exact canonical tuple', () => {
    // The canonical key of A_FAILURE under tool 'tool' is the JSON of its
    // component tuple [tool, file, ruleId, severity, 'position', line 0
    // bucket, column 0 bucket] — hand-written here so the pin is on the
    // recipe's hash INPUT, anchored (non-circularly) by fnv1a32Hex, which
    // fingerprint.test.ts pins against the published FNV-1a vectors.
    expect(ledgerSignature(A_FAILURE, 'tool')).toBe(
      fnv1a32Hex('["tool","src/a.ts","rule","error","position","0","0"]'),
    );
    // Location-less regime: identity by normalized message, offset bucket.
    const locationLess: CheckFailure = {
      ...A_FAILURE,
      line: null,
      column: null,
      message: 'suite > handles iso dates',
    };
    expect(ledgerSignature(locationLess, 'tool')).toBe(
      fnv1a32Hex('["tool","src/a.ts","rule","error","content","suite > handles iso dates","0"]'),
    );
  });

  test('wiring pin: exactly fingerprintFailure(failure, { tool }) — gates math, not new math', () => {
    expect(ledgerSignature(A_FAILURE, 'tool')).toBe(
      fingerprintFailure(A_FAILURE, { tool: 'tool' }),
    );
  });

  test('an empty tool is a RangeError — the fingerprint default would collide across tools', () => {
    expect(() => ledgerSignature(A_FAILURE, '')).toThrow(RangeError);
    expect(() => ledgerSignature(A_FAILURE, '')).toThrow(/tool is required/);
  });

  test('a non-string tool is a RangeError', () => {
    expect(() => ledgerSignature(A_FAILURE, 42 as unknown as string)).toThrow(RangeError);
  });
});

describe('legacyLedgerSignature (scheme-1 signatures for the escalation guard)', () => {
  test('null for tools whose signatures the scheme change left untouched', () => {
    expect(legacyLedgerSignature(A_FAILURE, 'eslint')).toBeNull();
    expect(legacyLedgerSignature({ ...A_FAILURE, line: null, column: null }, 'tsc')).toBeNull();
  });

  test('pins the scheme-1 tuple for a located Vitest assertion failure (position regime)', () => {
    expect(legacyLedgerSignature(A_FAILURE, 'vitest')).toBe(
      fnv1a32Hex('["vitest","src/a.ts","rule","error","position","0","0"]'),
    );
  });

  test('pins the scheme-1 tuple for an unlocated assertion failure (first-line content regime)', () => {
    const unlocated: CheckFailure = {
      ...A_FAILURE,
      line: null,
      column: null,
      ruleId: null,
      message: 'suite > handles iso dates',
    };
    expect(legacyLedgerSignature(unlocated, 'vitest')).toBe(
      fnv1a32Hex('["vitest","src/a.ts","","error","content","suite > handles iso dates","0"]'),
    );
  });

  test('a suite-level failure keys as its pre-discriminator null ruleId did', () => {
    const suite: CheckFailure = {
      ...A_FAILURE,
      line: null,
      column: null,
      ruleId: 'vitest-suite',
      message: 'boom\n    at stack',
    };
    expect(legacyLedgerSignature(suite, 'vitest')).toBe(
      fnv1a32Hex('["vitest","src/a.ts","","error","content","boom","0"]'),
    );
  });

  test('same tool precondition as ledgerSignature', () => {
    expect(() => legacyLedgerSignature(A_FAILURE, '')).toThrow(RangeError);
  });
});
