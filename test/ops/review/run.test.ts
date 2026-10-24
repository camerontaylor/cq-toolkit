import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { DriverFactory } from '../../../src/driver/factory.js';
import { makeReviewRun } from '../../../src/ops/review/run.js';
import { repoEffects, makeTestRepo } from '../dev/repo.js';

describe('review.run', () => {
  it('persists agent findings and records unauthenticated CodeRabbit as blocked', async () => {
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
          review: { reviewers: ['coderabbit', 'agent'] },
        }),
      );
      repo.commitAll('fixture review setup');
      const effects = repoEffects(repo, (command) =>
        command === 'coderabbit'
          ? { exitCode: 1, stdout: '', stderr: 'not authenticated', timedOut: false }
          : undefined,
      );
      const drivers = {
        resolve: vi.fn(() => ({
          lane: 'ai-sdk',
          modelSpec: { provider: 'mock', model: 'mock' },
          driver: {
            run: async (invocation: { toolPolicy: { mode?: string }; outputSchema?: unknown }) => {
              expect(invocation.toolPolicy.mode).toBe('none');
              expect(invocation.outputSchema).toBeDefined();
              return {
                stopReason: 'complete' as const,
                structuredOutput: {
                  findings: [
                    {
                      file: 'src/a.ts',
                      line: 1,
                      rule: 'fixture',
                      severity: 'high',
                      text: 'Seeded fixture finding',
                    },
                  ],
                },
                usage: { input: 10, output: 4, cacheRead: 0, cacheWrite: 0 },
                denials: [],
              };
            },
          },
        })),
      } as unknown as DriverFactory;
      const result = await makeReviewRun({
        drivers,
        effectsFactory: () => effects,
        scannerFactory: () => async (components) =>
          components.map((component) => ({ component: component.component, hits: [] })),
      })({ repoRoot: repo.root });
      expect(result.status).toBe('ok');
      if (result.status !== 'ok') return;
      expect(result.value.sources).toContainEqual(
        expect.objectContaining({ kind: 'coderabbit', status: 'blocked' }),
      );
      expect(result.value.findings).toContainEqual(
        expect.objectContaining({
          source: 'agent',
          severity: 'major',
          text: 'Seeded fixture finding',
        }),
      );
      const folder = join(repo.root, '.cq', 'review', 'feature%2Fx');
      const [recordFile] = await readdir(folder);
      const persisted = JSON.parse(await readFile(join(folder, recordFile ?? ''), 'utf8')) as {
        findings: unknown[];
      };
      expect(persisted.findings).toHaveLength(1);
    } finally {
      await repo.cleanup();
    }
  });
});
