// Split provenance: test/ops/review/addressVerification.test.ts was split into
// addressVerification.*.test.ts subject files.
import { describe, expect, test } from 'vitest';
import { verifyClosureEvidence } from '../../../src/ops/review/internal/addressVerification.js';
import { expectLastCheck, makePacket, replacementPatch } from './addressVerification.helpers.js';

describe('review.address closure evidence verifier', () => {
  test.each([8, 9])(
    '%i quoted spans respect the exact scan cap without silent truncation',
    (count) => {
      const spans = Array.from({ length: count }, (_, index) => `trigger-${index}`);
      const before = spans.map((span) => `consume('${span}');`).join('\n');
      const after = count === 9 ? `consume('${spans[8]}');` : 'consume(true);';
      const finding = { id: 'span-limit', text: spans.map((span) => `"${span}"`).join(' ') };
      const result = verifyClosureEvidence(
        makePacket({
          finding,
          before,
          after,
          patch: replacementPatch(before, after),
        }),
      );
      expect(result.verdict).toBe(count === 8 ? 'resolved' : 'uncertain');
      if (count === 9) {
        expect(result.reason).toBe('unavailable-evidence');
        expectLastCheck(result, { check: 'trigger-removed', outcome: 'unavailable' });
        expect(result.checks[3]?.detail).toContain('exceeds scan limits');
      }
    },
  );

  test.each([16, 17])('%i removed declarations respect the exact scan cap', (count) => {
    const declarations = Array.from({ length: count }, (_, index) => `const retired${index} = 1;`);
    const before = [...declarations, "consume('PARTIAL_MODE');"].join('\n');
    const after = count === 17 ? `${declarations[16]}\nconsume(true);` : 'consume(true);';
    const result = verifyClosureEvidence(
      makePacket({
        before,
        after,
        patch: replacementPatch(before, after),
      }),
    );
    expect(result.verdict).toBe(count === 16 ? 'resolved' : 'uncertain');
    if (count === 17) {
      expect(result.reason).toBe('unavailable-evidence');
      expectLastCheck(result, { check: 'trigger-removed', outcome: 'unavailable' });
      expect(result.checks[3]?.detail).toContain('exceeds scan limits');
    }
  });
});
