import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { ManagedReviewSubmit } from '../../../src/ops/dev/managedReview.js';
import type { ScanComponentInput } from '../../../src/ops/dev/denylist.js';
import { makeReviewRun } from '../../../src/ops/review/run.js';
import { repoEffects, makeTestRepo } from '../dev/repo.js';
import { scriptedDrivers } from './run.helpers.js';

/**
 * S2b-i: the CodeRabbit leg rides the managed queue route — queue-side
 * retries replace the CLI rate-limit retry loop, so #551's CLI backoff has
 * no managed equivalent (the D11 status wait in managedReview.ts is the
 * retry surface, covered in managedReview.test.ts). The empty-file-identity
 * preservation below keeps its intent through the scripted submit outcome.
 */
const runWithManaged = (managedSubmit: ManagedReviewSubmit) => ({
  drivers: scriptedDrivers(),
  scannerFactory: () => async (components: readonly ScanComponentInput[]) =>
    components.map((component) => ({ component: component.component, hits: [] })),
  managedSubmit,
});

it('S2b-i: review.run completes through the managed queue leg', async () => {
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
    const submit = (async () => ({
      status: 'completed',
      value: {
        receiptId: 'r'.repeat(64),
        completion: { kind: 'terminal' },
        findings: [],
        advisories: [],
      },
    })) as ManagedReviewSubmit;
    const effects = repoEffects(repo);
    const result = await makeReviewRun({
      ...runWithManaged(submit),
      effectsFactory: () => effects,
    })({ repoRoot: repo.root, wallMs: 60_000 });
    expect(result.status).toBe('ok');
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
      const effects = repoEffects(repo);
      const submit = (async () => ({
        status: 'completed',
        value: {
          receiptId: 'e'.repeat(64),
          completion:
            completion === 'terminal'
              ? { kind: 'terminal' }
              : { kind: 'blocked', reason: 'queue blocked' },
          findings: [{ severity: 'major', fileName: '', excerpt: 'empty identity' }],
          advisories: [],
        },
      })) as ManagedReviewSubmit;
      const result = await makeReviewRun({
        ...runWithManaged(submit),
        effectsFactory: () => effects,
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
