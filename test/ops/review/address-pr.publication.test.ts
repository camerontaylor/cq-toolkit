import { join } from 'node:path';
import { expectOpaqueIncomplete } from './slotOwnership.helpers.js';
// Split provenance: test/ops/review/address-pr.test.ts was split by subject;
// this file holds its publication-ordering and publication-opt-out tests.
// The shared phase-one orchestration world lives in address-pr.helpers.ts.
import { describe, expect, test } from 'vitest';
import { world } from './address-pr.helpers.js';

describe('review.address PR phase-one orchestration', () => {
  test('verified publication precedes reply/resolve; clean re-review re-requests once', async () => {
    const w = await world();
    try {
      const result = await w.run();
      await expectOpaqueIncomplete(result, join(w.root, 'git'));
      expect(w.actions[0]).toBe('push');
      expect(w.actions.filter((a) => a !== 'push')).toEqual(['reply', 'resolve:T1', 'rerequest']);
      const report = result.status === 'ok' ? result.value : result.report!;
      expect(report.fixesPerRun).toBe(1);
      expect(report.openBlocking).toEqual([]);
    } finally {
      await w.cleanup();
    }
  });

  test('publication opt-out keeps verified local work and makes no forge mutations', async () => {
    const w = await world();
    try {
      const result = await w.run(false);
      expect(result.status).toBe('needs-human');
      expect(w.actions).toEqual([]);
      expect(result.report?.fixesPerRun).toBe(1);
    } finally {
      await w.cleanup();
    }
  });
});
