// Split provenance: test/ops/review/addressVerification.test.ts was split into
// addressVerification.*.test.ts subject files.
import { describe, expect, test } from 'vitest';
import { verifyClosureEvidence } from '../../../src/ops/review/internal/addressVerification.js';
import {
  AFTER,
  BEFORE,
  CHECK_ORDER,
  VALID_PATCH,
  expectLastCheck,
  makePacket,
  namesOf,
} from './addressVerification.helpers.js';

describe('review.address closure evidence verifier', () => {
  test('an unrelated patch cannot hide a surviving trigger by omitting it from after', () => {
    const before = "const obsolete = 1;\ndangerous('PARTIAL_MODE');";
    const patch = [
      '--- a/src/config.ts',
      '+++ b/src/config.ts',
      '@@ -1 +1 @@',
      '-const obsolete = 1;',
      '+// obsolete removed',
    ].join('\n');
    const result = verifyClosureEvidence(
      makePacket({ before, after: '// obsolete removed', patch }),
    );
    expect(result.verdict).toBe('uncertain');
    expect(result.reason).toBe('unavailable-evidence');
    expectLastCheck(result, { check: 'patch-coherent', outcome: 'unavailable' });
    expect(result.checks[2]?.detail).toContain('does not produce after snapshot');
  });

  test.each([
    [
      'context',
      VALID_PATCH.replace('   const parsed = JSON.parse(raw);', '   const parsed = wrong;'),
    ],
    ['count', VALID_PATCH.replace('@@ -1,5 +1,5 @@', '@@ -1,6 +1,5 @@')],
    ['old position', VALID_PATCH.replace('@@ -1,5 +1,5 @@', '@@ -2,5 +1,5 @@')],
    ['new position', VALID_PATCH.replace('@@ -1,5 +1,5 @@', '@@ -1,5 +2,5 @@')],
    ['malformed range', VALID_PATCH.replace('@@ -1,5 +1,5 @@', '@@ bad @@')],
    ['multiple files', `${VALID_PATCH}\n${VALID_PATCH}`],
    ['newline marker', `${VALID_PATCH}\n\\ No newline at end of file`],
  ])('unsupported or inconsistent %s fails closed', (_name, patch) => {
    const result = verifyClosureEvidence(makePacket({ patch }));
    expect(result.verdict).toBe('uncertain');
    expect(result.reason).toBe('unavailable-evidence');
    expectLastCheck(result, { check: 'patch-coherent', outcome: 'unavailable' });
  });

  test('ordered separated hunks preserve untouched lines and exact final newline', () => {
    const before = "prefix\nuse('PARTIAL_MODE');\nuntouched\nversion = 1;\nsuffix\n";
    const after = 'prefix\nuse(true);\nuntouched\nversion = 2;\nsuffix\n';
    const patch = [
      '--- a/src/config.ts',
      '+++ b/src/config.ts',
      '@@ -2 +2 @@',
      "-use('PARTIAL_MODE');",
      '+use(true);',
      '@@ -4 +4 @@',
      '-version = 1;',
      '+version = 2;',
    ].join('\n');
    const packet = makePacket({
      before,
      after,
      patch,
    });
    expect(verifyClosureEvidence(packet).verdict).toBe('resolved');
    const omitted = verifyClosureEvidence({
      ...packet,
      after: packet.after.replace('untouched\n', ''),
    });
    expect(omitted.verdict).toBe('uncertain');
    const newline = verifyClosureEvidence({ ...packet, after: packet.after.slice(0, -1) });
    expect(newline.verdict).toBe('uncertain');
    expect(newline.checks[2]?.detail).toContain('final newline');
  });

  test('zero-count insertion and deletion ranges preserve exact positions', () => {
    const before = "use('PARTIAL_MODE');\nobsolete();\nend();";
    const after = 'use(true);\nend();\nappend();';
    const patch = [
      '--- a/src/config.ts',
      '+++ b/src/config.ts',
      '@@ -1 +1 @@',
      "-use('PARTIAL_MODE');",
      '+use(true);',
      '@@ -2 +1,0 @@',
      '-obsolete();',
      '@@ -3,0 +3 @@',
      '+append();',
    ].join('\n');
    expect(verifyClosureEvidence(makePacket({ before, after, patch })).verdict).toBe('resolved');
    const overlap = patch.replace('@@ -3,0 +3 @@', '@@ -1,0 +3 @@');
    expect(verifyClosureEvidence(makePacket({ before, after, patch: overlap })).verdict).toBe(
      'uncertain',
    );
  });

  test('rename and malformed patches are uncertain, not resolved', () => {
    const rename = verifyClosureEvidence(
      makePacket({
        patch: VALID_PATCH.replace('+++ b/src/config.ts', '+++ b/src/config.renamed.ts'),
      }),
    );
    expect(rename.verdict).toBe('uncertain');
    expect(rename.reason).toBe('unavailable-evidence');
    expect(namesOf(rename)).toEqual(CHECK_ORDER.slice(0, 3));

    const noHunks = verifyClosureEvidence(
      makePacket({ patch: 'diff --git a/src/config.ts b/src/config.ts\n' }),
    );
    expect(noHunks.verdict).toBe('uncertain');
    expect(namesOf(noHunks)).toEqual(CHECK_ORDER.slice(0, 3));
  });

  test('before/after and patch content must agree', () => {
    const identical = verifyClosureEvidence(makePacket({ before: AFTER }));
    expect(identical.verdict).toBe('uncertain');
    expect(namesOf(identical)).toEqual(CHECK_ORDER.slice(0, 3));

    const missingAdded = verifyClosureEvidence(
      makePacket({ after: AFTER.replace('  if (parsed.partial === true) enablePartial();\n', '') }),
    );
    expect(missingAdded.verdict).toBe('uncertain');
    expect(missingAdded.checks[2]?.detail).toContain('does not produce after snapshot');

    const missingRemoved = verifyClosureEvidence(
      makePacket({
        before: BEFORE.replace(
          "  if (parsed.partialMode === 'PARTIAL_MODE') enablePartial();\n",
          '',
        ),
      }),
    );
    expect(missingRemoved.verdict).toBe('uncertain');
    expect(missingRemoved.checks[2]?.detail).toContain('does not match before snapshot');

    const wrongFile = verifyClosureEvidence(
      makePacket({ finding: { id: 'F1', text: 'x', file: 'src/other.ts' } }),
    );
    expect(wrongFile.verdict).toBe('uncertain');
    expect(wrongFile.checks[2]?.detail).toContain('finding cites src/other.ts');
  });
});
