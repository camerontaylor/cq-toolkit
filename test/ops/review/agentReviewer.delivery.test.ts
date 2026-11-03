// Split provenance: test/ops/review/agentReviewer.test.ts was split into the
// agentReviewer.*.test.ts siblings in this directory; this file keeps the
// structured-output and scanned-delivery evidence tests.
import { describe, expect, it } from 'vitest';
import { runAgentReviewer } from '../../../src/ops/review/agentReviewer.js';
import { fakeDrivers, reviewerInput, workerResult } from './agentReviewer.helpers.js';

describe('runAgentReviewer v3 session engine', () => {
  it('blocks complete-looking output when structured output is malformed', async () => {
    const fake = fakeDrivers({
      result: workerResult({ structuredOutput: { unexpected: true } }),
    });
    const result = await runAgentReviewer(fake.drivers, reviewerInput());
    expect(result).toMatchObject({
      status: 'needs-human',
      reason: expect.stringContaining('agent review returned invalid structured output') as unknown,
      report: {
        coverage: {
          pieces: [{ state: 'delivered' }],
          sessions: [{ status: 'error' }],
        },
      },
    });
  });

  it('does not accept valid JSON without the beforeRequest delivery hook', async () => {
    const fake = fakeDrivers({ skipHook: true });
    const result = await runAgentReviewer(fake.drivers, reviewerInput());
    expect(result).toMatchObject({
      status: 'needs-human',
      reason: expect.stringContaining(
        'agent review completed without scanned content delivery',
      ) as unknown,
      report: {
        coverage: {
          pieces: [{ state: 'planned' }],
          sessions: [{ status: 'error', deliveries: [] }],
        },
      },
    });
  });

  it('does not count a hook request containing the wrong prompt as delivery', async () => {
    const fake = fakeDrivers({ hookPrompt: 'not the planned review request' });
    const result = await runAgentReviewer(fake.drivers, reviewerInput());
    expect(result).toMatchObject({
      status: 'needs-human',
      reason: expect.stringContaining(
        'agent review completed without scanned content delivery',
      ) as unknown,
      report: { coverage: { pieces: [{ state: 'planned' }] } },
    });
  });
});
