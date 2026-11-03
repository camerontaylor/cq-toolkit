// Split provenance: test/ops/review/agentReviewer.test.ts was split into the
// agentReviewer.*.test.ts siblings in this directory; this file keeps the
// lane-refusal and driver-error mapping tests.
import { describe, expect, it, vi } from 'vitest';
import type { DriverFactory } from '../../../src/driver/factory.js';
import { runAgentReviewer } from '../../../src/ops/review/agentReviewer.js';
import { fakeDrivers, reviewerInput, workerResult } from './agentReviewer.helpers.js';

describe('runAgentReviewer v3 session engine', () => {
  it('refuses a non-ai-sdk lane because it cannot attest pre-upload scanning', async () => {
    const fake = fakeDrivers({ lane: 'acp' });
    const result = await runAgentReviewer(fake.drivers, reviewerInput());
    expect(result).toMatchObject({
      status: 'needs-human',
      reason: expect.stringContaining(
        'agent review requires the ai-sdk pre-upload scan lane',
      ) as unknown,
    });
    expect(fake.run).not.toHaveBeenCalled();
  });

  it('maps dispatch and driver errors to needs-human with bounded detail (#484)', async () => {
    const noRole: DriverFactory = {
      resolve: () => {
        throw new Error('no reviewer role');
      },
    };
    expect(await runAgentReviewer(noRole, reviewerInput())).toMatchObject({
      status: 'needs-human',
      reason: expect.stringContaining('agent review did not run: no reviewer role') as unknown,
    });

    const detail =
      'ai-sdk driver: structured output invalid after repair: model emitted tool-call markup instead of JSON';
    const fake = fakeDrivers({ result: workerResult({ stopReason: 'error', error: detail }) });
    const failed = await runAgentReviewer(fake.drivers, reviewerInput());
    expect(failed).toMatchObject({
      status: 'needs-human',
      reason: expect.stringContaining(
        `agent review did not complete (error): ${detail}`,
      ) as unknown,
      report: {
        coverage: {
          pieces: [{ state: 'delivered' }],
          sessions: [{ status: 'error' }],
        },
      },
    });
  });

  it('secret-redacts and bounds driver error details in the blocked reason (#484)', async () => {
    vi.stubEnv('CQ_REVIEW_FIXTURE_TOKEN', 'review-token-value');
    try {
      const fake = fakeDrivers({
        result: workerResult({
          stopReason: 'error',
          error: `upstream echoed review-token-value then ${'x'.repeat(600)}`,
        }),
      });
      const result = await runAgentReviewer(fake.drivers, reviewerInput());
      expect(result.status).toBe('needs-human');
      if (result.status !== 'needs-human') return;
      expect(result.reason).toContain('[redacted]');
      expect(result.reason).not.toContain('review-token-value');
      expect(result.reason).toContain('… [truncated]');
      expect(result.reason.length).toBeLessThan(800);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
