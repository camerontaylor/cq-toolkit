import { join } from 'node:path';
import { expectOpaqueIncomplete } from './slotOwnership.helpers.js';
// Split provenance: test/ops/review/address-pr.test.ts was split by subject;
// this file holds its review-thread source tests (follow-up discussion and
// bot advisory evidence). The shared phase-one orchestration world lives in
// address-pr.helpers.ts.
import { describe, expect, test } from 'vitest';
import { world } from './address-pr.helpers.js';

describe('review.address PR phase-one orchestration', () => {
  test('current follow-up discussion reaches edit, mandatory feedback and candidate closure', async () => {
    const w = await world(false, { discussion: true });
    try {
      const result = await w.run();
      await expectOpaqueIncomplete(result, join(w.root, 'git'));
      expect(w.prompts).toHaveLength(3);
      for (const prompt of w.prompts) {
        expect(prompt).toContain('FOLLOWUP-REQUIREMENT');
        expect(prompt).toContain('reviewer');
      }
      expect(w.resolved.has('T1')).toBe(true);
    } finally {
      await w.cleanup();
    }
  });

  test('resolved bot source retains advisory evidence without an unsupported API request', async () => {
    const w = await world(false, { bot: true });
    try {
      const result = await w.run();
      await expectOpaqueIncomplete(result, join(w.root, 'git'));
      expect(w.resolved.has('T1')).toBe(true);
      expect(w.actions).not.toContain('rerequest');
      const report = result.status === 'ok' ? result.value : result.report!;
      expect(report.reasons).toContainEqual(expect.stringContaining('no bot re-request performed'));
    } finally {
      await w.cleanup();
    }
  });
});
