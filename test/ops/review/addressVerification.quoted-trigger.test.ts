// Split provenance: test/ops/review/addressVerification.test.ts was split into
// addressVerification.*.test.ts subject files.
import { describe, expect, test } from 'vitest';
import { verifyClosureEvidence } from '../../../src/ops/review/internal/addressVerification.js';
import {
  CHECK_ORDER,
  expectLastCheck,
  makePacket,
  namesOf,
  replacementPatch,
} from './addressVerification.helpers.js';

describe('review.address closure evidence verifier', () => {
  test('a surviving quoted function name is ambiguous after the cited literal is removed', () => {
    const packet = makePacket();
    packet.finding.text = '"load" accepts retired switch "PARTIAL_MODE"';
    const result = verifyClosureEvidence(packet);
    expect(result.verdict).toBe('uncertain');
    expectLastCheck(result, { check: 'trigger-removed', outcome: 'unavailable' });
  });

  test('a surviving cited trigger takes precedence over an ambiguous name', () => {
    const packet = makePacket({
      dependencies: [{ path: 'src/legacy.ts', role: 'consumer', text: "load('PARTIAL_MODE');" }],
    });
    packet.finding.text = '"load" accepts retired switch "PARTIAL_MODE"';
    const result = verifyClosureEvidence(packet);
    expect(result.verdict).toBe('unresolved');
    expect(result.reason).toBe('deleted-trigger-survives');
  });
  test('a quoted trigger surviving only in a cited consumer is unresolved', () => {
    // The changed file no longer passes PARTIAL_MODE, but the cited consumer
    // still does: closure evidence must sweep every cited dependency.
    const dependencies = [
      {
        path: 'src/legacy.ts',
        role: 'consumer' as const,
        text: "import { load } from './config.js';\nif (mode === 'PARTIAL_MODE') load(raw);\n",
      },
    ];
    const result = verifyClosureEvidence(makePacket({ dependencies }));
    expect(result.verdict).toBe('unresolved');
    expect(result.reason).toBe('deleted-trigger-survives');
    expect(namesOf(result)).toEqual(CHECK_ORDER.slice(0, 4));
    expectLastCheck(result, { check: 'trigger-removed', outcome: 'fail' });
    expect(result.checks[3]?.detail).toContain('PARTIAL_MODE');
    expect(result.checks[3]?.detail).toContain('src/legacy.ts');
  });

  test('a quoted trigger surviving in a cited dependency is unresolved', () => {
    const dependencies = [
      {
        path: 'src/flags.ts',
        role: 'dependency' as const,
        text: "export const RETIRED = 'PARTIAL_MODE';\n",
      },
    ];
    const result = verifyClosureEvidence(makePacket({ dependencies }));
    expect(result.verdict).toBe('unresolved');
    expect(result.reason).toBe('deleted-trigger-survives');
    expect(namesOf(result)).toEqual(CHECK_ORDER.slice(0, 4));
    expectLastCheck(result, { check: 'trigger-removed', outcome: 'fail' });
    expect(result.checks[3]?.detail).toContain('src/flags.ts');
  });

  test('a surviving quoted trigger is unresolved counter-evidence', () => {
    const survivingAfter = [
      'export function load(raw: string): Config {',
      '  const parsed = JSON.parse(raw);',
      '  // partial handling left as-is below',
      "  if (parsed.partialMode === 'PARTIAL_MODE') enablePartial();",
      '  return normalize(parsed);',
      '}',
    ].join('\n');
    const patch = [
      'diff --git a/src/config.ts b/src/config.ts',
      '--- a/src/config.ts',
      '+++ b/src/config.ts',
      '@@ -1,5 +1,6 @@',
      ' export function load(raw: string): Config {',
      '   const parsed = JSON.parse(raw);',
      '+  // partial handling left as-is below',
      "   if (parsed.partialMode === 'PARTIAL_MODE') enablePartial();",
      '   return normalize(parsed);',
      ' }',
    ].join('\n');
    const result = verifyClosureEvidence(makePacket({ patch, after: survivingAfter }));
    expect(result.verdict).toBe('unresolved');
    expect(result.reason).toBe('deleted-trigger-survives');
    expect(namesOf(result)).toEqual(CHECK_ORDER.slice(0, 4));
    expectLastCheck(result, { check: 'trigger-removed', outcome: 'fail' });
    expect(result.checks[3]?.detail).toContain('PARTIAL_MODE');
  });

  test.each([false, true])('modified declaration with surviving trigger=%s', (survives) => {
    const before = 'export function add(a, b) { return a - b; }';
    const after = survives
      ? 'export function add(a, b) { return a - b; /* still broken */ }'
      : 'export function add(a, b) { return a + b; }';
    const result = verifyClosureEvidence(
      makePacket({
        finding: {
          id: 'arithmetic',
          text: '"a - b" subtracts rather than adds',
          file: 'src/config.ts',
          line: 1,
        },
        before,
        after,
        patch: replacementPatch(before, after),
      }),
    );
    expect(result.verdict).toBe(survives ? 'unresolved' : 'resolved');
    if (survives) expect(result.reason).toBe('deleted-trigger-survives');
  });

  test('a contraction does not hide a surviving single-quoted trigger', () => {
    const before = "const OLD_FLAG = 1;\nif (m === 'LEGACY') run();";
    const after = "if (m === 'LEGACY') run();";
    const result = verifyClosureEvidence(
      makePacket({
        finding: {
          id: 'contraction',
          text: `Replace "OLD_FLAG"; don't keep 'LEGACY' anywhere`,
          file: 'src/config.ts',
          line: 1,
        },
        before,
        after,
        patch: replacementPatch(before, after),
      }),
    );
    expect(result.verdict).toBe('unresolved');
    expect(result.reason).toBe('deleted-trigger-survives');
  });

  test('a suggested replacement absent from before is not a surviving trigger', () => {
    const before = 'const v = a - b;';
    const after = 'const v = a + b;';
    const result = verifyClosureEvidence(
      makePacket({
        finding: {
          id: 'replacement',
          text: 'Replace `a - b` with `a + b`',
          file: 'src/config.ts',
          line: 1,
        },
        before,
        after,
        patch: replacementPatch(before, after),
      }),
    );
    expect(result.reason).not.toBe('deleted-trigger-survives');
  });
});
