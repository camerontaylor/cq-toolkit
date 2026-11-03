// Split provenance: test/ops/review/reviewSession-wire.test.ts was split into
// subject files sharing ./reviewSession-wire.helpers.ts. This file holds the
// unclassified-kind hook suite: such hooks are scanned but never deliver.
import { describe, expect, it } from 'vitest';
import type { DriverFactory } from '../../../src/driver/factory.js';
import type { WorkerResult } from '../../../src/driver/types.js';
import type { ScanComponentInput } from '../../../src/ops/dev/denylist.js';
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

describe('review session wire hook', () => {
  it.each([undefined, 'unknown'] as const)(
    'scans a hook with kind %s and never delivers',
    async (kind) => {
      const root = await scratch();
      const scanCalls: ScanComponentInput[][] = [];
      const plan = planFor();
      const evidence = evidenceFor();
      const worker: WorkerResult = {
        stopReason: 'complete',
        structuredOutput: { findings: [] },
        usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0 },
        steps: 1,
        denials: [],
      };
      const factory: DriverFactory = {
        resolve: (request) => ({
          lane: 'ai-sdk',
          modelSpec: request.modelSpec,
          driver: {
            run: async (invocation) => {
              const contents = [{ text: invocation.prompt }];
              if (kind === undefined) await request.beforeRequest?.(invocation.prompt, contents);
              else
                await request.beforeRequest?.(invocation.prompt, contents, {
                  kind: 'unknown',
                } as never);
              return worker;
            },
          },
        }),
      };
      const result = await runReviewSession(factory, {
        ...runInput(root, plan, evidence),
        scanSecrets: recordingScanner(scanCalls),
        onUsage: () => undefined,
      });
      expect(result.status).toBe('needs-human');
      if (result.status === 'needs-human')
        expect(result.reason).toContain('without scanned content delivery');
      expect(scanCalls).toHaveLength(1);
      expect(scanCalls[0]!.some((component) => component.text === plan.prompt)).toBe(true);
      expect(evidence.requests).toHaveLength(0);
      expect(evidence.deliveries).toHaveLength(0);
      expect(evidence.status).toBe('error');
    },
  );
});
