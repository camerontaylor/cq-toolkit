// Split provenance: test/ops/review/agentReviewer.test.ts was split into the
// agentReviewer.*.test.ts siblings in this directory; this file keeps the
// finding-severity mapping test.
import { describe, expect, it } from 'vitest';
import { runAgentReviewer } from '../../../src/ops/review/agentReviewer.js';
import { fakeDrivers, reviewerInput, workerResult } from './agentReviewer.helpers.js';

describe('runAgentReviewer v3 session engine', () => {
  it('maps unmapped low severity to minor and omits missing location fields', async () => {
    const fake = fakeDrivers({
      result: workerResult({
        structuredOutput: { findings: [{ severity: 'low', text: 'Evidence without a location' }] },
      }),
    });
    const result = await runAgentReviewer(fake.drivers, reviewerInput());
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.value.findings[0]).toMatchObject({
      severity: 'minor',
      text: 'Evidence without a location',
      status: 'open',
    });
    expect(result.value.findings[0]).not.toHaveProperty('file');
    expect(result.value.findings[0]).not.toHaveProperty('line');
    expect(result.value.findings[0]).not.toHaveProperty('rule');
  });
});
