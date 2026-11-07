// Split provenance: test/ops/review/agentReviewer-partitions.test.ts was split
// into agentReviewer-partitions.{session,coverage,scan,cancellation,preflight,
// budget,concurrency,failures,retries,exclusions,wire}.test.ts. This file holds
// the upload-scan and scanned-delivery evidence decisions.
import { expect, it } from 'vitest';
import type { DiffSecretScanner } from '../../../src/ops/dev/denylist.js';
import { runAgentReviewer } from '../../../src/ops/review/agentReviewer.js';
import { baseInput, fakeDrivers, result, small } from './agentReviewer-partitions.helpers.js';

it('blocks a valid JSON answer when its scanned request was not an actual model request', async () => {
  for (const kind of ['tool-output', 'missing'] as const) {
    const fake = fakeDrivers({ hookKind: kind, result: () => result() });
    const outcome = await runAgentReviewer(fake.drivers, baseInput());
    expect(outcome).toMatchObject({
      status: 'needs-human',
      reason: expect.stringContaining(
        'agent review completed without scanned content delivery',
      ) as unknown,
      report: { coverage: { pieces: [{ state: 'planned' }], sessions: [{ deliveries: [] }] } },
    });
  }
});

it('fails closed when any original, prompt, serialized request, or decoded request scan is incomplete/protected', async () => {
  for (const mode of [
    'original-hit',
    'missing',
    'duplicate',
    'request-hit',
    'decoded-hit',
    'fault',
  ]) {
    let requestScans = 0;
    const scanner: DiffSecretScanner = (components) => {
      requestScans++;
      if (mode === 'fault' && components.some(({ component }) => component === 'request'))
        throw new Error('scanner unavailable');
      if (mode === 'missing' && components.some(({ component }) => component === 'review-prompt'))
        return [];
      const verdicts = components.map(({ component, path }) => ({
        component,
        hits:
          (mode === 'original-hit' && component === small.component) ||
          (mode === 'request-hit' && component === 'request') ||
          (mode === 'decoded-hit' && component.startsWith('request-content-'))
            ? [{ ruleId: 'fixture-secret', lines: [1] }]
            : [],
        ...(path ? { path } : {}),
      }));
      if (mode === 'duplicate' && components.some(({ component }) => component === 'review-prompt'))
        return [...verdicts, verdicts[0]!];
      return verdicts;
    };
    const fake = fakeDrivers({ scanner });
    const outcome = await runAgentReviewer(fake.drivers, baseInput({ scanSecrets: scanner }));
    expect(outcome.status).toBe('needs-human');
    expect(fake.sends()).toBe(0);
    expect(requestScans).toBeGreaterThan(0);
  }
});

it('does not count a tool-output JSON spoof or a wrong prompt as delivery', async () => {
  const spoof = fakeDrivers({
    onHook: async (request) => {
      await request.beforeRequest?.(
        '{"toolOutput":"{\\"findings\\":[]}"}',
        [{ text: '{"findings":[]}' }],
        { kind: 'tool-output' },
      );
    },
    skipHook: true,
  });
  const spoofed = await runAgentReviewer(spoof.drivers, baseInput());
  expect(spoofed).toMatchObject({
    status: 'needs-human',
    reason: expect.stringContaining('without scanned content delivery') as unknown,
  });

  const wrong = fakeDrivers({ hookPrompt: 'not the planned review prompt' });
  const wrongPrompt = await runAgentReviewer(wrong.drivers, baseInput());
  expect(wrongPrompt).toMatchObject({
    status: 'needs-human',
    reason: expect.stringContaining('without scanned content delivery') as unknown,
  });
});
