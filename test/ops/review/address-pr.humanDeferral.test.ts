// Split provenance: test/ops/review/address-pr.test.ts was split by subject;
// this file holds its human-deferral settlement tests. The shared phase-one
// orchestration world lives in address-pr.helpers.ts.
import { describe, expect, test } from 'vitest';
import { world } from './address-pr.helpers.js';

describe('review.address PR phase-one orchestration', () => {
  test.each(['same-file', 'fileless-first', 'fileless-last'] as const)(
    'human settlement preserves successful sibling dispatch and publication: %s',
    async (kind) => {
      const w = await world(
        true,
        kind === 'same-file'
          ? { sameFile: true }
          : { fileless: kind === 'fileless-first' ? 'first' : 'last' },
      );
      try {
        const result = await w.run();
        expect(result.status, JSON.stringify(result)).toBe('needs-human');
        expect(result.report?.fixesPerRun).toBe(1);
        expect(result.report?.fixes.map((fix) => fix.finding.id)).toEqual(
          kind === 'fileless-last' ? ['T1', 'T2'] : ['T2', 'T1'],
        );
        expect(result.report?.fixes.some((fix) => fix.finding.id === 'T1' && fix.commit)).toBe(
          true,
        );
        expect(w.resolved.has('T1')).toBe(true);
        expect(w.resolved.has('T2')).toBe(false);
        expect(w.actions.indexOf('push')).toBeLessThan(w.actions.indexOf('resolve:T1'));
        expect(result.report?.openBlocking).toMatchObject([
          {
            id: 'T2',
            status: 'deferred',
            reason: kind === 'same-file' ? 'human' : 'unanchored finding needs human scope',
          },
        ]);
        expect(
          result.report?.rounds[0]?.runs.every((run) =>
            run.jobs.every((row) => row.result.status !== 'failed'),
          ),
        ).toBe(true);
      } finally {
        await w.cleanup();
      }
    },
  );

  test('a human sibling stays open while the verified sibling publishes and resolves', async () => {
    const w = await world(true);
    try {
      const result = await w.run();
      expect(result.status, JSON.stringify(result)).toBe('needs-human');
      expect(w.resolved.has('T1')).toBe(true);
      expect(w.resolved.has('T2')).toBe(false);
      expect(w.actions).not.toContain('rerequest');
      expect(result.report?.fixesPerRun).toBe(1);
      expect(result.report?.openBlocking).toMatchObject([{ id: 'T2', status: 'deferred' }]);
    } finally {
      await w.cleanup();
    }
  });
});
