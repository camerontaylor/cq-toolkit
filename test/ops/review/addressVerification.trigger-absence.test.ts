// Split provenance: test/ops/review/addressVerification.test.ts was split into
// addressVerification.*.test.ts subject files.
import { describe, expect, test } from 'vitest';
import { verifyClosureEvidence } from '../../../src/ops/review/internal/addressVerification.js';
import {
  CHECK_ORDER,
  expectLastCheck,
  makePacket,
  namesOf,
  outcomesOf,
} from './addressVerification.helpers.js';

describe('review.address closure evidence verifier', () => {
  test('a deletion-only patch can never close even with complete attestation', () => {
    const after = [
      'export function load(raw: string): Config {',
      '  const parsed = JSON.parse(raw);',
      '  return normalize(parsed);',
      '}',
    ].join('\n');
    const patch = [
      'diff --git a/src/config.ts b/src/config.ts',
      '--- a/src/config.ts',
      '+++ b/src/config.ts',
      '@@ -1,5 +1,4 @@',
      ' export function load(raw: string): Config {',
      '   const parsed = JSON.parse(raw);',
      "-  if (parsed.partialMode === 'PARTIAL_MODE') enablePartial();",
      '   return normalize(parsed);',
      ' }',
    ].join('\n');
    const result = verifyClosureEvidence(makePacket({ patch, after }));
    expect(result.verdict).toBe('uncertain');
    expect(result.reason).toBe('deleted-line-alone');
    expect(namesOf(result)).toEqual([...CHECK_ORDER]);
    expect(result.checks[3]?.outcome).toBe('pass');
    expectLastCheck(result, { check: 'dependencies-covered', outcome: 'unavailable' });
  });

  test('no citable trigger yields uncertain without demanding an edit', () => {
    const finding = {
      id: 'F3',
      text: 'loader keeps calling enablePartial for retired switches',
    };
    const before = [
      'export function load(raw: string): Config {',
      '  const parsed = JSON.parse(raw);',
      '  enablePartial();',
      '  return normalize(parsed);',
      '}',
    ].join('\n');
    const after = [
      'export function load(raw: string): Config {',
      '  const parsed = JSON.parse(raw);',
      '  return normalize(parsed);',
      '}',
    ].join('\n');
    const patch = [
      'diff --git a/src/config.ts b/src/config.ts',
      '--- a/src/config.ts',
      '+++ b/src/config.ts',
      '@@ -1,5 +1,4 @@',
      ' export function load(raw: string): Config {',
      '   const parsed = JSON.parse(raw);',
      '-  enablePartial();',
      '   return normalize(parsed);',
      ' }',
    ].join('\n');
    const result = verifyClosureEvidence(makePacket({ finding, patch, before, after }));
    expect(result.verdict).toBe('uncertain');
    expect(result.reason).toBe('no-citable-trigger');
    expect(namesOf(result)).toEqual(CHECK_ORDER.slice(0, 4));
    expectLastCheck(result, { check: 'trigger-removed', outcome: 'unavailable' });
  });

  test('an unrelated removed declaration cannot close an unquoted dangerous finding', () => {
    const finding = {
      id: 'unvalidated-dangerous-call',
      text: 'dangerous receives unvalidated input and must validate it before execution',
      file: 'src/config.ts',
      line: 2,
    };
    const before = 'const obsolete = 1;\ndangerous(input);\n';
    const after = '// obsolete declaration removed\ndangerous(input);\n';
    const patch = [
      'diff --git a/src/config.ts b/src/config.ts',
      '--- a/src/config.ts',
      '+++ b/src/config.ts',
      '@@ -1,2 +1,2 @@',
      '-const obsolete = 1;',
      '+// obsolete declaration removed',
      ' dangerous(input);',
    ].join('\n');
    const result = verifyClosureEvidence(makePacket({ finding, before, after, patch }));
    expect(result.verdict).toBe('uncertain');
    expect(result.reason).toBe('no-citable-trigger');
    expect(namesOf(result)).toEqual(CHECK_ORDER.slice(0, 4));
    expect(result.checks.slice(0, 3).every((check) => check.outcome === 'pass')).toBe(true);
    expectLastCheck(result, { check: 'trigger-removed', outcome: 'unavailable' });
    expect(result.checks[3]?.detail).toContain(
      'removed declarations alone do not establish finding-linked trigger evidence',
    );
  });

  test('an absent quoted suggestion cannot close a finding after an unrelated comment edit', () => {
    const finding = {
      id: 'missing-validation',
      text: 'Call `validate(input)` before executing dangerous(input)',
      file: 'src/config.ts',
    };
    const before = '// old comment\ndangerous(input);';
    const after = '// updated comment\ndangerous(input);';
    const patch = [
      '--- a/src/config.ts',
      '+++ b/src/config.ts',
      '@@ -1 +1 @@',
      '-// old comment',
      '+// updated comment',
    ].join('\n');
    const result = verifyClosureEvidence(makePacket({ finding, before, after, patch }));
    expect(result.verdict).toBe('uncertain');
    expect(result.reason).toBe('no-citable-trigger');
    expect(result.checks.slice(0, 3).every((check) => check.outcome === 'pass')).toBe(true);
    expectLastCheck(result, { check: 'trigger-removed', outcome: 'unavailable' });
    expect(result.checks[3]?.detail).toContain(
      'no finding-quoted trigger occurs in before and a validated removed line',
    );
  });

  test('supported quoted removal remains positive evidence alongside an absent suggestion', () => {
    const result = verifyClosureEvidence(
      makePacket({
        finding: {
          id: 'supported-removal',
          text: 'Replace "PARTIAL_MODE" with a boolean; consider `validate(input)` too',
          file: 'src/config.ts',
        },
      }),
    );
    expect(result.verdict).toBe('resolved');
    expect(outcomesOf(result)).toEqual(CHECK_ORDER.map(() => 'pass'));
  });
});
