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
] as const)('default PR rerun recovers only authenticated pending resolution: %s', async (mode) => {
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
    if (mode === 'valid') {
      expect(
        second.status,
        JSON.stringify({
          reasons: report.reasons,
          actions: w.actions.slice(actions),
          replies: w.replies,
        }),
      ).toBe('ok');
      expect(w.actions.slice(actions)).toEqual(['resolve:T1']);
      expect(w.prompts).toHaveLength(edits); // no editing/feedback/closure provider dispatch
      expect(w.reviewerCalls()).toBe(reviewerCalls + 1); // fresh mandatory terminal re-review
      expect(report.fixesPerRun).toBe(0);
    } else {
      expect(second.status).toBe('needs-human');
      expect(w.resolved.has('T1')).toBe(false);
      expect(w.prompts.length).toBeGreaterThan(edits);
      expect(w.actions.slice(actions)).not.toContain('resolve:T1');
    }
  } finally {
    await w.cleanup();
  }
});
