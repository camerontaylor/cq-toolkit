// Split provenance: test/ops/review/reviewSession-wire.test.ts was split into
// subject files sharing ./reviewSession-wire.helpers.ts. This file holds the
// rate-limit refusal statement suite (#578).
import { describe, expect, it } from 'vitest';
import type { DriverFactory } from '../../../src/driver/factory.js';
import { runReviewSession } from '../../../src/ops/review/internal/reviewSession.js';
import {
  evidenceFor,
  planFor,
  recordingScanner,
  runInput,
  scratch,
  useScratchRoots,
} from './reviewSession-wire.helpers.js';

useScratchRoots();

describe('agent rate-limit refusal states the wait and cause (#578)', () => {
  it.each([
    ['cap', 600_000, 900_000, 1000, 'rate-limit wait 600000ms not retried (cap)'],
    ['wall', 2000, 1000, 1000, 'rate-limit wait 2000ms not retried (wall)'],
    ['tokens', 2000, 60_000, 3, 'rate-limit wait 2000ms not retried (tokens)'],
    ['invalid', -1, 60_000, 1000, 'rate-limit wait -1ms not retried (invalid)'],
    ['default wait', undefined, 1000, 1000, 'rate-limit wait 30000ms not retried (wall)'],
  ] as const)('%s', async (_label, retryAfterMs, wall, tokens, stated) => {
    const root = await scratch();
    const plan = planFor();
    const evidence = evidenceFor();
    let calls = 0;
    const advisories: string[] = [];
    const factory: DriverFactory = {
      resolve: (request) => ({
        lane: 'ai-sdk',
        modelSpec: request.modelSpec,
        driver: {
          run: async (invocation) => {
            calls++;
            await request.beforeRequest?.(
              JSON.stringify({ prompt: [{ role: 'user', content: invocation.prompt }] }),
              [{ text: invocation.prompt }],
              { kind: 'model-request' },
            );
            return {
              stopReason: 'error',
              errorClass: 'rate-limit',
              error: 'Rate limit reached for requests',
              usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0 },
              denials: [],
              ...(retryAfterMs === undefined ? {} : { providerSignals: { retryAfterMs } }),
            };
          },
        },
      }),
    };
    const result = await runReviewSession(factory, {
      ...runInput(root, plan, evidence),
      maxTokens: tokens,
      scanSecrets: recordingScanner([]),
      onUsage: () => undefined,
      remainingWallMs: () => wall,
      sleep: async () => {
        throw new Error('a refused rate limit must not wait');
      },
      onAdvisories: (items) => {
        advisories.push(...items);
      },
    });
    expect(calls).toBe(1);
    expect(result).toMatchObject({ status: 'needs-human', errorClass: 'rate-limit' });
    if (result.status === 'needs-human') {
      expect(result.reason).toContain(stated);
      expect(result.reason).toContain('Rate limit reached for requests');
    }
    expect(advisories).toEqual([`session ${plan.id}: ${stated}`]);
  });

  it('names the wall when it runs out during the wait', async () => {
    const root = await scratch();
    const plan = planFor();
    const evidence = evidenceFor();
    let calls = 0;
    let wall = 60_000;
    const advisories: string[] = [];
    const factory: DriverFactory = {
      resolve: (request) => ({
        lane: 'ai-sdk',
        modelSpec: request.modelSpec,
        driver: {
          run: async (invocation) => {
            calls++;
            await request.beforeRequest?.(
              JSON.stringify({ prompt: [{ role: 'user', content: invocation.prompt }] }),
              [{ text: invocation.prompt }],
              { kind: 'model-request' },
            );
            return {
              stopReason: 'error',
              errorClass: 'rate-limit',
              usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0 },
              denials: [],
              providerSignals: { retryAfterMs: 2000 },
            };
          },
        },
      }),
    };
    const result = await runReviewSession(factory, {
      ...runInput(root, plan, evidence),
      maxTokens: 1000,
      scanSecrets: recordingScanner([]),
      onUsage: () => undefined,
      remainingWallMs: () => wall,
      sleep: async () => {
        wall = 0;
      },
      onAdvisories: (items) => {
        advisories.push(...items);
      },
    });
    expect(calls).toBe(1);
    expect(result).toMatchObject({ status: 'needs-human', errorClass: 'rate-limit' });
    if (result.status === 'needs-human')
      expect(result.reason).toContain('rate-limit wait 2000ms not retried (wall)');
    expect(advisories).toEqual([
      `session ${plan.id}: rate-limit wait 2000ms before retry 1`,
      `session ${plan.id}: rate-limit wait 2000ms not retried (wall)`,
    ]);
  });
});
