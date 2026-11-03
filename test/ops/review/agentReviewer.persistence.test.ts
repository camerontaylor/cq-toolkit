// Split provenance: test/ops/review/agentReviewer.test.ts was split into the
// agentReviewer.*.test.ts siblings in this directory; this file keeps the
// review.run persistence test.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FindingsRecordSchema } from '../../../src/ops/review/findings.js';
import { makeReviewRun } from '../../../src/ops/review/run.js';
import { makeTestRepo, repoEffects } from '../dev/repo.js';
import { cleanScan, fakeDrivers, workerResult } from './agentReviewer.helpers.js';

describe('runAgentReviewer v3 session engine', () => {
  it('persists an error-stop driver detail through review.run into the record, ledger and log', async () => {
    const repo = await makeTestRepo();
    try {
      await repo.write('package.json', JSON.stringify({ name: 'fixture-review' }));
      await repo.write(
        'cq.json',
        JSON.stringify({
          schemaVersion: 2,
          checks: [{ adapter: 'tsc-lines', command: { command: 'tsc', args: [] } }],
          roles: { reviewer: { provider: 'mock', model: 'mock' } },
          budgets: { run: { maxTokens: 500 } },
          review: { reviewers: ['agent'] },
        }),
      );
      repo.commitAll('configure error-stop persistence fixture');
      const detail = 'distinctive error-stop persistence failure: fixture-486';
      const fake = fakeDrivers({
        result: workerResult({ stopReason: 'error', error: detail }),
      });
      const effects = repoEffects(repo);
      const result = await makeReviewRun({
        drivers: fake.drivers,
        effectsFactory: () => effects,
        scannerFactory: () => cleanScan,
      })({ repoRoot: repo.root });

      expect(result.status).toBe('needs-human');
      expect(fake.run).toHaveBeenCalledTimes(1);
      const stored = FindingsRecordSchema.parse(
        JSON.parse(await readFile(join(repo.root, '.cq/review/feature%2Fx/1.json'), 'utf8')),
      );
      expect(stored.sources).toHaveLength(1);
      expect(stored.sources[0]).toMatchObject({
        kind: 'agent',
        status: 'blocked',
        reason: expect.stringContaining(detail) as unknown,
      });
      const cycle = effects
        .openLedger('feature/x')
        .load()
        .records.find((entry) => entry.kind === 'cycle');
      expect(cycle).toMatchObject({
        kind: 'cycle',
        cycleId: stored.sources[0]?.cycleId,
        reviewer: 'agent:reviewer',
        completion: {
          kind: 'blocked',
          reason: expect.stringContaining(detail) as unknown,
        },
      });
      expect(effects.logs).toHaveLength(1);
      expect(effects.logs[0]).toContain(detail);
    } finally {
      await repo.cleanup();
    }
  });
});
