// Split provenance: test/ops/review/agentReviewer.test.ts was split into the
// agentReviewer.*.test.ts siblings in this directory; this file keeps the
// single-session dispatch surface tests.
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runAgentReviewer } from '../../../src/ops/review/agentReviewer.js';
import { fakeDrivers, reviewerInput, smallComponent } from './agentReviewer.helpers.js';

describe('runAgentReviewer v3 session engine', () => {
  it('runs one read-only, tool-aware session with prompt-hook delivery evidence and v3 output', async () => {
    const fake = fakeDrivers();
    const result = await runAgentReviewer(fake.drivers, reviewerInput());

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error(JSON.stringify(result));
    expect(result.value.findings).toMatchObject([
      { source: 'agent', severity: 'major', file: 'src/a.ts', line: 2, rule: 'bug' },
    ]);
    expect(result.value.coverage).toMatchObject({
      version: 2,
      mode: 'session',
      pieces: [
        {
          component: smallComponent.component,
          state: 'completed',
          chars: smallComponent.text.length,
        },
      ],
      sessions: [
        {
          status: 'complete',
          steps: 1,
          deliveries: [
            {
              component: smallComponent.component,
              start: 0,
              end: smallComponent.text.length,
            },
          ],
          requests: [
            {
              serializedChars: expect.any(Number) as unknown,
              decodedChars: expect.any(Number) as unknown,
            },
          ],
        },
      ],
    });
    expect(fake.invocations).toHaveLength(1);
    const invocation = fake.invocations[0]!;
    expect(invocation.toolPolicy).toEqual({
      mode: 'allowlist',
      allow: ['read', 'grep', 'glob'],
    });
    expect(invocation.sandboxPolicy).toEqual({ level: 'read-only' });
    expect(invocation.workspace).toEqual({ path: resolve('/fixture/repo') });
    expect(invocation.budget).toEqual({ maxTokens: 500, maxSteps: 4 });
    expect(invocation.outputSchema).toMatchObject({ name: 'review.agent/v3' });
    expect(invocation.prompt).toContain(smallComponent.text);
    expect(invocation.prompt).not.toContain('receipt:');
    expect(fake.requests[0]?.role).toBe('reviewer');
    expect(fake.requests[0]?.beforeRequest).toBeTypeOf('function');
  });

  it('keeps read available when search is disabled and disables mutation descriptors', async () => {
    const fake = fakeDrivers();
    const result = await runAgentReviewer(fake.drivers, reviewerInput({ searchTools: false }));
    expect(result.status).toBe('ok');
    expect(fake.invocations[0]?.toolPolicy).toEqual({ mode: 'allowlist', allow: ['read'] });
    expect(fake.requests[0]?.harness?.tools).toMatchObject({
      read: { enabled: true },
      edit: { enabled: false },
      write: { enabled: false },
      bash: { enabled: false },
    });
  });
});
