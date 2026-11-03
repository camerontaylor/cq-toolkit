// Split provenance: test/ops/review/addressVerification.test.ts was split into
// addressVerification.*.test.ts subject files.
import { describe, expect, test } from 'vitest';
import {
  verifyClosureEvidence,
  type CitedDependency,
} from '../../../src/ops/review/internal/addressVerification.js';
import { makePacket, replacementPatch } from './addressVerification.helpers.js';

describe('review.address closure evidence verifier', () => {
  test('a removed declaration re-declared in after is unresolved', () => {
    const finding = {
      id: 'F2',
      text: 'loader declares a duplicate normalize helper instead of the shared one',
    };
    const before = [
      'export function load(raw: string): Config {',
      '  function normalize(x: string) {',
      '    return x.trim();',
      '  }',
      "  if (mode === 'legacy') {",
      '    function normalize(x: string) {',
      '      return x;',
      '    }',
      '  }',
      '  return sharedNormalize(JSON.parse(raw));',
      '}',
    ].join('\n');
    const after = [
      'export function load(raw: string): Config {',
      "  if (mode === 'legacy') {",
      '    function normalize(x: string) {',
      '      return x;',
      '    }',
      '  }',
      '  return sharedNormalize(JSON.parse(raw));',
      '}',
    ].join('\n');
    const patch = [
      'diff --git a/src/config.ts b/src/config.ts',
      '--- a/src/config.ts',
      '+++ b/src/config.ts',
      '@@ -1,11 +1,8 @@',
      ' export function load(raw: string): Config {',
      '-  function normalize(x: string) {',
      '-    return x.trim();',
      '-  }',
      "   if (mode === 'legacy') {",
      '     function normalize(x: string) {',
      '       return x;',
      '     }',
      '   }',
      '   return sharedNormalize(JSON.parse(raw));',
      ' }',
    ].join('\n');
    const result = verifyClosureEvidence(makePacket({ finding, before, after, patch }));
    expect(result.verdict).toBe('unresolved');
    expect(result.reason).toBe('deleted-trigger-survives');
    expect(result.checks[3]?.detail).toContain('re-declared');
  });

  test('a removed declaration still declared in a cited consumer is unresolved', () => {
    const before = [
      'export const RETIRED_FLAG = 1;',
      'export function load(raw: string): Config {',
      '  return normalize(JSON.parse(raw));',
      '}',
    ].join('\n');
    const after = [
      'export function load(raw: string): Config {',
      '  return normalize(JSON.parse(raw));',
      '}',
    ].join('\n');
    const patch = [
      'diff --git a/src/config.ts b/src/config.ts',
      '--- a/src/config.ts',
      '+++ b/src/config.ts',
      '@@ -1,4 +1,3 @@',
      '-export const RETIRED_FLAG = 1;',
      ' export function load(raw: string): Config {',
      '   return normalize(JSON.parse(raw));',
      ' }',
    ].join('\n');
    const dependencies = [
      {
        path: 'src/index.ts',
        role: 'consumer' as const,
        text: 'export const RETIRED_FLAG = 1;\nconsole.log(RETIRED_FLAG);\n',
      },
    ];
    const result = verifyClosureEvidence(makePacket({ before, after, patch, dependencies }));
    expect(result.verdict).toBe('unresolved');
    expect(result.reason).toBe('deleted-trigger-survives');
    expect(result.checks[3]?.detail).toContain('src/index.ts');
  });

  test.each(['after', 'consumer', 'dependency'] as const)(
    'a dollar-ending declaration surviving in %s is unresolved',
    (location) => {
      const before = "const retired$ = 1;\nconsume('PARTIAL_MODE');";
      const after = location === 'after' ? 'const retired$ = 2;\nconsume(true);' : 'consume(true);';
      const dependencies: CitedDependency[] =
        location === 'after'
          ? []
          : [
              {
                path: 'src/legacy.ts',
                role: location,
                text: 'const retired$ = 2;',
              },
            ];
      const result = verifyClosureEvidence(
        makePacket({
          before,
          after,
          dependencies,
          patch: replacementPatch(before, after),
        }),
      );
      expect(result.verdict).toBe('unresolved');
      expect(result.reason).toBe('deleted-trigger-survives');
      expect(result.checks[3]?.detail).toContain('retired$');
    },
  );

  test('a longer dollar identifier is not the removed declaration', () => {
    const before = "const retired$ = 1;\nconsume('PARTIAL_MODE');";
    const after = 'const retired$extra = 2;\nconsume(true);';
    expect(
      verifyClosureEvidence(
        makePacket({
          before,
          after,
          patch: replacementPatch(before, after),
        }),
      ).verdict,
    ).toBe('resolved');
  });
});
