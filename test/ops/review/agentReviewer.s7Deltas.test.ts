// Split provenance: test/ops/review/agentReviewer.test.ts was split into the
// agentReviewer.*.test.ts siblings in this directory; this file keeps the S7
// delta tests.
import { describe, expect, it } from 'vitest';
import { runAgentReviewer } from '../../../src/ops/review/agentReviewer.js';
import { fakeDrivers, reviewerInput, workerResult } from './agentReviewer.helpers.js';

describe('runAgentReviewer S7 deltas', () => {
  it('passes budgets.step.wallMs to the session driver as stepTimeoutMs, capped at the review wall', async () => {
    const wide = fakeDrivers();
    await runAgentReviewer(
      wide.drivers,
      reviewerInput({ stepWallMs: 3_600_000, wallMs: 14_400_000 }),
    );
    expect(wide.requests.map((request) => request.stepTimeoutMs)).toEqual([3_600_000]);

    const capped = fakeDrivers();
    await runAgentReviewer(
      capped.drivers,
      reviewerInput({ stepWallMs: 3_600_000, wallMs: 60_000 }),
    );
    const [bound] = capped.requests.map((request) => request.stepTimeoutMs);
    expect(bound).toBeGreaterThan(0);
    expect(bound).toBeLessThanOrEqual(60_000);

    const none = fakeDrivers();
    await runAgentReviewer(none.drivers, reviewerInput());
    expect(none.requests.map((request) => request.stepTimeoutMs)).toEqual([undefined]);
  });

  it('strips an extra finding key instead of blocking the review (attempts G/H)', async () => {
    const fake = fakeDrivers({
      result: workerResult({
        structuredOutput: {
          findings: [{ severity: 'high', text: 'kept', rule_id_hint: 'x' }],
        },
      }),
    });
    const result = await runAgentReviewer(fake.drivers, reviewerInput());
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.value.findings.map((finding) => finding.text)).toEqual(['kept']);
    expect(result.value.findings[0]).not.toHaveProperty('rule_id_hint');
  });

  it.each([
    ['a finding without text', { findings: [{ severity: 'high' }] }],
    ['a finding with an unknown severity', { findings: [{ severity: 'urgent', text: 't' }] }],
    ['an extra top-level key', { findings: [], summary: 'extra' }],
  ])('still rejects %s', async (_label, structuredOutput) => {
    const fake = fakeDrivers({ result: workerResult({ structuredOutput }) });
    const result = await runAgentReviewer(fake.drivers, reviewerInput());
    expect(result.status).not.toBe('ok');
  });
});
