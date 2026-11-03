// Split provenance: test/ops/review/agentReviewer.test.ts was split into the
// agentReviewer.*.test.ts siblings in this directory; this file keeps the
// cross-area session tests.
import { describe, expect, it } from 'vitest';
import { runAgentReviewer } from '../../../src/ops/review/agentReviewer.js';
import { fakeDrivers, reviewerInput, workerResult } from './agentReviewer.helpers.js';

describe('runAgentReviewer v3 session engine', () => {
  it('requires fresh cross-area prompt delivery after a transient retry', async () => {
    let crossAttempts = 0;
    const fake = fakeDrivers({
      skipHook: true,
      run: async (invocation) => {
        const cross = invocation.prompt.includes('Review cross-area contracts');
        if (!cross || crossAttempts++ === 0) {
          await fake.requests
            .at(-1)!
            .beforeRequest?.(
              JSON.stringify({ prompt: [{ role: 'user', content: invocation.prompt }] }),
              [{ text: invocation.prompt }],
              { kind: 'model-request' },
            );
        }
        return cross && crossAttempts === 1
          ? workerResult({ stopReason: 'error', errorClass: 'transient' })
          : workerResult();
      },
    });
    const result = await runAgentReviewer(
      fake.drivers,
      reviewerInput({
        areas: true,
        components: [{ component: 'diff:a', path: 'a.ts', text: 'export const a = 1;' }],
      }),
    );
    expect(result.status).not.toBe('ok');
    const cross = result.report?.coverage.sessions.find((session) => session.id === 'cross-area');
    expect(cross?.attempts).toBe(2);
    expect(cross?.status).toBe('error');
    expect(cross?.contextSha256).toBeUndefined();
  });

  it('executes opt-in areas and a scanned cross-area pass without double-counting bytes', async () => {
    const fake = fakeDrivers();
    const components = [
      { component: 'diff:a', path: 'a/a.ts', text: 'const a = 1;' },
      { component: 'diff:b', path: 'b/b.ts', text: 'const b = 2;' },
    ];
    const result = await runAgentReviewer(
      fake.drivers,
      reviewerInput({ areas: true, components, session: { maxSteps: 1 } }),
    );
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(fake.invocations).toHaveLength(3);
    expect(result.value.coverage.pieces.map((piece) => piece.state)).toEqual([
      'completed',
      'completed',
    ]);
    const cross = result.value.coverage.sessions.find((session) => session.id === 'cross-area')!;
    const crossPrompt = fake.invocations.find((invocation) =>
      invocation.prompt.includes('Review cross-area contracts'),
    )!.prompt;
    for (const component of components) expect(crossPrompt).toContain(component.text);
    expect(cross.status).toBe('complete');
    expect(cross.deliveries).toEqual([]);
    expect(cross.contextSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(cross.requests.length).toBeGreaterThan(0);
  });

  it('keeps a failed required cross-area pass incomplete after primary areas succeed', async () => {
    const fake = fakeDrivers({
      run: async (invocation) =>
        invocation.prompt.includes('Review cross-area contracts')
          ? workerResult({ stopReason: 'error', error: 'cross-area failure' })
          : workerResult(),
    });
    const result = await runAgentReviewer(
      fake.drivers,
      reviewerInput({
        areas: true,
        components: [{ component: 'diff:a', path: 'a.ts', text: 'export const a = 1;' }],
      }),
    );
    expect(result.status).not.toBe('ok');
    expect(result.report?.coverage.pieces[0]?.state).toBe('completed');
    expect(
      result.report?.coverage.sessions.find((session) => session.id === 'cross-area')?.status,
    ).not.toBe('complete');
  });
});
