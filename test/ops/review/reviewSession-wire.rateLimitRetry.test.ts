// Split provenance: test/ops/review/reviewSession-wire.test.ts was split into
// subject files sharing ./reviewSession-wire.helpers.ts. This file holds the
// bounded rate-limit retry suite (#551).
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

describe('agent bounded rate-limit retry (#551)', () => {
  it.each([
    ['retry-after then complete', 'rate-limit', 2000, 60_000, 1000, false, 2, 'ok'],
    ['zero retry-after then complete', 'rate-limit', 0, 60_000, 1000, false, 2, 'ok'],
    ['negative retry-after', 'rate-limit', -1, 60_000, 1000, false, 1, 'needs-human'],
    ['invalid retry-after', 'rate-limit', Number.NaN, 60_000, 1000, false, 1, 'needs-human'],
    ['fallback then complete', 'rate-limit', undefined, 60_000, 1000, false, 2, 'ok'],
    ['second rate limit', 'rate-limit', 2000, 60_000, 1000, true, 2, 'needs-human'],
    ['wait exceeds wall', 'rate-limit', 2000, 1000, 1000, false, 1, 'needs-human'],
    ['wait exceeds cap', 'rate-limit', 600_000, 900_000, 1000, false, 1, 'needs-human'],
    ['tokens spent', 'rate-limit', 2000, 60_000, 3, false, 1, 'needs-human'],
    ['auth refusal', 'auth', 2000, 60_000, 1000, false, 1, 'needs-human'],
    ['quota refusal', 'quota', 2000, 60_000, 1000, false, 1, 'needs-human'],
  ] as const)(
    '%s',
    async (_label, errorClass, retryAfterMs, wall, tokens, twice, attempts, status) => {
      const root = await scratch();
      const plan = planFor();
      const evidence = evidenceFor();
      let calls = 0;
      const waits: number[] = [];
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
                stopReason: calls === 1 || twice ? 'error' : 'complete',
                errorClass,
                structuredOutput: { findings: [] },
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
        sleep: async (ms) => {
          waits.push(ms);
        },
        onAdvisories: (items) => {
          advisories.push(...items);
        },
      });
      expect(result.status).toBe(status);
      expect(calls).toBe(attempts);
      expect(waits).toEqual(attempts === 2 ? [retryAfterMs ?? 30_000] : []);
      expect(evidence.usage.input).toBe(2 * attempts);
      expect(evidence.requests).toHaveLength(attempts);
      expect(evidence.deliveries).toHaveLength(1);
      if (attempts === 2) {
        expect(evidence.attempts).toBe(2);
        expect(advisories.join(' ')).toContain('rate-limit');
      }
    },
  );
});
