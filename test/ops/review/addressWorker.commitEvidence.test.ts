import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import type { DriverFactory } from '../../../src/driver/factory.js';
import { finding, fixture, role } from './addressWorker.helpers.js';

// M6b: review commit evidence attribution. The verified review commit and the
// retained failed-attempt commit both render their Cq-* trailer block through
// the shared formatCqTrailers writer, matching the sweep evidence surfaces
describe('M6b review commit evidence attribution (addressWorker)', () => {
  // M6b nominal evidence: the verified review commit message carries the shared
  // Cq-* key set with the actual dispatch tier/model/attempt, through the real
  // gated commit path (no fixture objects). The driver resolves a DIFFERENT
  // model than the configured worker role, so Cq-Model must record what the
  // driver actually served, not what was configured.
  test('M6b nominal evidence', async () => {
    const f = await fixture(undefined, '', {
      runPrefix: 'run/x',
      configure: (config) => {
        config.roles = {
          worker: { provider: 'mock', model: 'configured' },
          rescue: { ...role, model: 'rescue' },
          reviewer: { ...role, model: 'reviewer' },
        };
      },
    });
    // The fixture factory resolves each request to a distinct served model.
    const drivers: DriverFactory = {
      resolve: (request) => ({
        lane: 'ai-sdk',
        modelSpec: {
          provider: request.modelSpec.provider,
          model: `served-${request.modelSpec.model}`,
        },
        driver: {
          run: async (input) => {
            if (input.outputSchema?.name === 'review.address.closure/v1')
              return {
                stopReason: 'complete',
                structuredOutput: { closed: true, reason: 'candidate fixed' },
                usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0 },
                denials: [],
              };
            await writeFile(join(input.workspace!.path, 'src/a.ts'), 'GOOD\n');
            return {
              stopReason: 'complete',
              structuredOutput: { disposition: 'fixed', reason: 'fixed', evidence: [] },
              usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0 },
              denials: [],
            };
          },
        },
      }),
    };
    f.engineDeps.drivers = drivers;
    try {
      const result = await f.engine.fix(finding(), 1);
      expect(result.finding.status).toBe('fixed');
      const commit = f.repo.git('rev-parse', 'HEAD').trim();
      expect(commit).not.toBe(f.initial);
      const message = f.repo.git('show', '-s', '--format=%B', commit);
      expect(message).toContain('Cq-Run: run/x');
      expect(message).toContain('Cq-Unit: review/fixture');
      expect(message).toContain('Cq-Task: src/a.ts');
      expect(message).toContain('Cq-Attempt: 1');
      expect(message).toContain('Cq-Tier: worker');
      expect(message).toContain('Cq-Model: mock/served-configured');
    } finally {
      await f.cleanup();
    }
  });

  // M6b missing evidence: a non-fix disposition commits nothing attributed —
  // the caller head is untouched and no Cq-trailered commit is created.
  test('M6b missing evidence', async () => {
    const f = await fixture(async (input) => {
      if (input.outputSchema?.name === 'review.address.closure/v1')
        return { closed: true, reason: 'candidate fixed' };
      return {
        disposition: 'deferred',
        reason: 'needs human scope',
        evidence: [{ path: 'src/a.ts', line: 1 }],
      };
    });
    try {
      const result = await f.engine.fix(finding(), 1);
      expect(result.finding.status).toBe('deferred');
      expect(f.repo.git('rev-parse', 'HEAD').trim()).toBe(f.initial);
      expect(f.repo.git('for-each-ref', '--format=%(refname)', 'refs/heads/')).not.toContain(
        '/failed/',
      );
    } finally {
      await f.cleanup();
    }
  });

  // M6b failure evidence: the retained failed-attempt commit carries the shared
  // Cq-* key set through the real pinAddressFailure path, and the retained
  // commit is evidence of failure, never a fix: the caller head stays put.
  // Like the nominal test, the driver resolves a DIFFERENT model than the
  // configured worker role, so the failed pin must record what the driver
  // actually served (mock/served-configured), not the configured role.
  test('M6b failure evidence', async () => {
    // The fixture driver below (set via engineDeps.drivers) writes PARTIAL and
    // throws; the default fixture handler is not used, so pass undefined like
    // the nominal test.
    const f = await fixture(undefined, '', {
      runPrefix: 'run/x',
      configure: (config) => {
        config.roles = {
          worker: { provider: 'mock', model: 'configured' },
          rescue: { ...role, model: 'rescue' },
          reviewer: { ...role, model: 'reviewer' },
        };
      },
    });
    // The fixture factory resolves each request to a distinct served model,
    // so the pin's model distinguishes the resolved value from configured.
    // The driver writes PARTIAL and throws: a real failed dispatch that the
    // engine retains as failed-attempt evidence.
    f.engineDeps.drivers = {
      resolve: (request) => ({
        lane: 'ai-sdk',
        modelSpec: {
          provider: request.modelSpec.provider,
          model: `served-${request.modelSpec.model}`,
        },
        driver: {
          run: async (input) => {
            await writeFile(join(input.workspace!.path, 'src/a.ts'), 'PARTIAL\n');
            throw new Error('worker failed');
          },
        },
      }),
    };
    try {
      const result = await f.engine.fix(finding(), 1);
      expect(result.finding.status).toBe('deferred');
      expect(f.repo.git('rev-parse', 'HEAD').trim()).toBe(f.initial);
      const retained = result.failedAttempts![0]!;
      const message = f.repo.git('show', '-s', '--format=%B', retained.sha);
      expect(message).toContain('Cq-Run: run/x');
      expect(message).toContain('Cq-Unit: review/fixture');
      expect(message).toContain('Cq-Task: src/a.ts');
      expect(message).toContain('Cq-Attempt: 1');
      expect(message).toContain('Cq-Tier: worker');
      expect(message).toContain('Cq-Model: mock/served-configured');
      expect(retained.model).toEqual({ provider: 'mock', model: 'served-configured' });
      expect(message).toContain('Cq-Outcome: unfixed');
    } finally {
      await f.cleanup();
    }
  });
});
