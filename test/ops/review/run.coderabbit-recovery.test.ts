import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { makeReviewRun } from '../../../src/ops/review/run.js';
import { repoEffects, makeTestRepo } from '../dev/repo.js';
import { scriptedDrivers } from './run.helpers.js';

it('#551: review.run completes after the scripted CodeRabbit rate limit', async () => {
  const repo = await makeTestRepo();
  try {
    await repo.write(
      'cq.json',
      JSON.stringify({
        schemaVersion: 2,
        checks: [{ adapter: 'tsc-lines', command: { command: 'tsc', args: [] } }],
        review: { reviewers: ['coderabbit'] },
      }),
    );
    repo.commitAll('configure review');
    let calls = 0;
    const effects = repoEffects(repo, (command) =>
      command !== 'coderabbit'
        ? undefined
        : {
            exitCode: ++calls === 1 ? 1 : 0,
            stdout: JSON.stringify(
              calls === 1
                ? {
                    type: 'error',
                    errorType: 'rate_limit',
                    recoverable: true,
                    metadata: { waitTime: '1 second' },
                  }
                : { type: 'complete', status: 'review_completed' },
            ),
            stderr: '',
            timedOut: false,
          },
    );
    const sleep = vi.fn(async () => undefined);
    const result = await makeReviewRun({
      drivers: scriptedDrivers(),
      effectsFactory: () => effects,
      sleep,
      scannerFactory: () => async (components) =>
        components.map((c) => ({ component: c.component, hits: [] })),
    })({ repoRoot: repo.root, wallMs: 60_000 });
    expect(result.status).toBe('ok');
    expect(calls).toBe(2);
    expect(sleep).toHaveBeenCalledExactlyOnceWith(16_000, expect.any(AbortSignal));
    if (result.status === 'ok') expect(result.value.sources[0]?.status).toBe('terminal');
  } finally {
    await repo.cleanup();
  }
});

it.each(['terminal', 'blocked'] as const)(
  'CodeRabbit %s findings retain empty file identity in the ledger and persisted report',
  async (completion) => {
    const repo = await makeTestRepo();
    try {
      await repo.write(
        'cq.json',
        JSON.stringify({
          schemaVersion: 2,
          checks: [{ adapter: 'tsc-lines', command: { command: 'tsc', args: [] } }],
          review: { reviewers: ['coderabbit'] },
        }),
      );
      repo.commitAll('configure offline CodeRabbit stream');
      const effects = repoEffects(repo, (command) =>
        command === 'coderabbit'
          ? {
              exitCode: completion === 'terminal' ? 0 : 1,
              stdout: [
                { type: 'finding', severity: 'major', fileName: '', comment: 'empty identity' },
                ...(completion === 'terminal'
                  ? [{ type: 'complete', status: 'review_completed' }]
                  : []),
              ]
                .map((event) => JSON.stringify(event))
                .join('\n'),
              stderr: '',
              timedOut: false,
            }
          : undefined,
      );
      const result = await makeReviewRun({
        drivers: scriptedDrivers(),
        effectsFactory: () => effects,
        scannerFactory: () => async (components) =>
          components.map((component) => ({ component: component.component, hits: [] })),
      })({ repoRoot: repo.root });
      expect(result.status).toBe(completion === 'terminal' ? 'ok' : 'needs-human');
      const cycle = effects
        .openLedger('feature/x')
        .load()
        .records.find((entry) => entry.kind === 'cycle' && entry.reviewer === 'coderabbit');
      if (cycle?.kind !== 'cycle') throw new Error('missing vendor cycle');
      expect(cycle.findings[0]).toHaveProperty('fileName', '');
      const persisted = JSON.parse(
        await readFile(join(repo.root, '.cq/review/feature%2Fx/1.json'), 'utf8'),
      ) as { findings: Array<{ file?: string }> };
      expect(persisted.findings[0]).toHaveProperty('file', '');
      const report = result.status === 'ok' ? result.value : result.report;
      expect(report?.findings[0]).toHaveProperty('file', '');
    } finally {
      await repo.cleanup();
    }
  },
);
