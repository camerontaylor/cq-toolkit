import { readSlotMetadata } from '../../../src/adapters/lock/slotLock.js';
import { join } from 'node:path';
// Split provenance: test/ops/review/address-pr.test.ts was split by subject;
// this file holds its pending-resolution recovery tests (the only
// top-level, non-describe suite the original declared). The shared
// phase-one orchestration world lives in address-pr.helpers.ts.
import { expect, test } from 'vitest';
import { fixed, initial, world } from './address-pr.helpers.js';

test.each([
  'valid',
  'missing-receipt',
  'forged-author',
  'stale-head',
  'changed-actor',
  'changed-target',
] as const)(
  'opaque predecessor refuses automatic resolution recovery: %s (D4(c)/D5.4)',
  async (mode) => {
    const w = await world(false, { recoverResolution: true });
    try {
      const first = await w.run();
      expect(first.status).toBe('needs-human');
      expect(w.actions).toContain('resolve-failed');
      expect(w.actions.filter((a) => a === 'reply')).toHaveLength(1);
      expect(w.resolved.has('T1')).toBe(false);
      const edits = w.prompts.length;
      const reviewerCalls = w.reviewerCalls();
      const actions = w.actions.length;
      const firstPath = first.report!.reportPath;
      expect(w.replies[0]?.body).toContain('resolve');
      if (mode === 'missing-receipt') await w.clearReceipts();
      if (mode === 'forged-author') w.replies[0]!.user.login = 'forger';
      if (mode === 'stale-head') w.replies[0]!.body = w.replies[0]!.body.replaceAll(fixed, initial);
      if (mode === 'changed-actor') w.changeLogin();
      const second = await w.run(true, mode === 'changed-target' ? 'another-target' : undefined);
      const report = second.status === 'ok' ? second.value : second.report!;
      expect(report.reportPath).not.toBe(firstPath);
      expect(report.fixesPerRun).toBe(0);
      // The first opaque invocation cannot prove its write set, regardless of
      // the stored reply's authentication. A fresh address run must not auto-reuse.
      expect(second.status).toBe('needs-human');
      expect(second.status === 'needs-human' && second.reason).toBe(
        `Slot busy: ${join(w.root, 'git/cq-review/slots/pr-7.lock')}`,
      );
      expect(
        (await readSlotMetadata(join(w.root, 'git/cq-review/slots/pr-7.json')))?.incomplete,
      ).toBe(true);
      expect(w.actions.slice(actions)).toEqual([]);
      expect(w.prompts).toHaveLength(edits);
      expect(w.reviewerCalls()).toBe(reviewerCalls);
      expect(w.resolved.has('T1')).toBe(false);
    } finally {
      await w.cleanup();
    }
  },
);
