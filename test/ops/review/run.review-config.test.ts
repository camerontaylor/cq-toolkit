import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { makeReviewRun } from '../../../src/ops/review/run.js';
import { repoEffects, makeTestRepo } from '../dev/repo.js';
import { configureAgentRepo, scriptedDrivers } from './run.helpers.js';

it('forwards prior findings only when reReview.includePriorFindings is enabled', async () => {
  const repo = await makeTestRepo();
  try {
    await configureAgentRepo(repo);
    const writeConfig = async (includePriorFindings: boolean) => {
      await repo.write(
        'cq.json',
        JSON.stringify({
          schemaVersion: 2,
          checks: [{ adapter: 'tsc-lines', command: { command: 'tsc', args: [] } }],
          roles: { reviewer: { provider: 'mock', model: 'mock' } },
          budgets: { run: { maxTokens: 500 } },
          review: { reviewers: ['agent'], reReview: { includePriorFindings } },
        }),
      );
      repo.commitAll(`review.reReview.includePriorFindings=${String(includePriorFindings)}`);
    };
    const priorFindings = [
      {
        id: 'c001#f1',
        source: 'agent',
        file: 'src/a.ts',
        line: 1,
        rule: 'fixture',
        severity: 'major',
        text: 'PRIOR_FINDING_MARKER',
        status: 'fixed' as const,
        reason: 'addressed in the previous round',
      },
    ];
    const prompts: string[] = [];
    await writeConfig(true);
    const included = await makeReviewRun({
      drivers: scriptedDrivers((input) => prompts.push(input.prompt)),
      effectsFactory: () => repoEffects(repo),
      scannerFactory: () => async (components) =>
        components.map((component) => ({ component: component.component, hits: [] })),
    })({ repoRoot: repo.root, priorFindings });
    expect(included.status).toBe('ok');
    expect(prompts.join('\n')).toContain('PRIOR_FINDING_MARKER');
    expect(prompts.join('\n')).toContain('addressed in the previous round');

    prompts.length = 0;
    await writeConfig(false);
    const excluded = await makeReviewRun({
      drivers: scriptedDrivers((input) => prompts.push(input.prompt)),
      effectsFactory: () => repoEffects(repo),
      scannerFactory: () => async (components) =>
        components.map((component) => ({ component: component.component, hits: [] })),
    })({ repoRoot: repo.root, priorFindings });
    expect(excluded.status).toBe('ok');
    expect(prompts.join('\n')).not.toContain('PRIOR_FINDING_MARKER');
  } finally {
    await repo.cleanup();
  }
});

it('threads review.size and review.exclude, persisting advisories outside findings', async () => {
  const repo = await makeTestRepo();
  try {
    await configureAgentRepo(repo);
    await repo.write(
      'cq.json',
      JSON.stringify({
        schemaVersion: 2,
        checks: [{ adapter: 'tsc-lines', command: { command: 'tsc', args: [] } }],
        roles: { reviewer: { provider: 'mock', model: 'mock' } },
        budgets: { run: { maxTokens: 500 } },
        review: {
          reviewers: ['agent'],
          size: {
            small: { maxChangedLines: 0, maxFiles: 0 },
            medium: { maxChangedLines: 1000, maxFiles: 100 },
          },
          exclude: [{ pattern: '**' }],
        },
      }),
    );
    repo.commitAll('configure review size and exclusions');
    const effects = repoEffects(repo);
    const drivers = scriptedDrivers();
    const result = await makeReviewRun({
      drivers,
      effectsFactory: () => effects,
      scannerFactory: () => async (components) =>
        components.map((component) => ({ component: component.component, hits: [] })),
    })({ repoRoot: repo.root });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.value.findings).toEqual([]);
    expect(result.value.advisories).toEqual([
      'agent review covered no content: all components excluded',
    ]);
    expect(result.value.sources[0]?.coverage).toMatchObject({
      version: 2,
      mode: 'session',
      pieces: expect.arrayContaining([
        expect.objectContaining({
          state: 'excluded',
          exclusion: expect.objectContaining({
            rule: '**',
            limitation: expect.any(String) as unknown,
          }) as unknown,
        }),
      ]) as unknown,
    });
    expect(drivers.resolve).not.toHaveBeenCalled();
    const cycle = effects
      .openLedger('feature/x')
      .load()
      .records.find((entry) => entry.kind === 'cycle' && entry.reviewer === 'agent:reviewer');
    expect(cycle).toMatchObject({
      advisories: ['agent review covered no content: all components excluded'],
    });
    expect(effects.logs[0]).toContain('mode=session');
    expect(effects.logs[0]).toContain('limitation=');
    expect(effects.logs[0]).toContain(
      'advisories: agent review covered no content: all components excluded',
    );
  } finally {
    await repo.cleanup();
  }
});

it('threads review.session maxInputChars and forces the recorded partitioned fallback', async () => {
  const repo = await makeTestRepo();
  try {
    await configureAgentRepo(repo);
    await repo.write(
      'cq.json',
      JSON.stringify({
        schemaVersion: 2,
        checks: [{ adapter: 'tsc-lines', command: { command: 'tsc', args: [] } }],
        roles: { reviewer: { provider: 'mock', model: 'mock' } },
        budgets: { run: { maxTokens: 500 } },
        review: { reviewers: ['agent'], session: { maxInputChars: 1 } },
      }),
    );
    repo.commitAll('configure a tiny session budget');
    const effects = repoEffects(repo);
    const result = await makeReviewRun({
      drivers: scriptedDrivers(),
      effectsFactory: () => effects,
      scannerFactory: () => async (components) =>
        components.map((component) => ({ component: component.component, hits: [] })),
    })({ repoRoot: repo.root });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.value.sources[0]?.coverage).toMatchObject({
      version: 2,
      mode: 'partitioned',
      modeReason: 'over session input budget',
    });
    expect(result.value.advisories).toContainEqual(expect.stringContaining('partitioned fallback'));
    expect(effects.logs[0]).toContain('mode=partitioned');
  } finally {
    await repo.cleanup();
  }
});

it('threads review.size thresholds into the reviewer instructions', async () => {
  const repo = await makeTestRepo();
  try {
    await configureAgentRepo(repo);
    await repo.write(
      'cq.json',
      JSON.stringify({
        schemaVersion: 2,
        checks: [{ adapter: 'tsc-lines', command: { command: 'tsc', args: [] } }],
        roles: { reviewer: { provider: 'mock', model: 'mock' } },
        budgets: { run: { maxTokens: 500 } },
        review: {
          reviewers: ['agent'],
          size: {
            small: { maxChangedLines: 0, maxFiles: 0 },
            medium: { maxChangedLines: 1000, maxFiles: 100 },
          },
        },
      }),
    );
    repo.commitAll('configure review size thresholds');
    const prompts: string[] = [];
    const result = await makeReviewRun({
      drivers: scriptedDrivers((input) => prompts.push(input.prompt)),
      effectsFactory: () => repoEffects(repo),
      scannerFactory: () => async (components) =>
        components.map((component) => ({ component: component.component, hits: [] })),
    })({ repoRoot: repo.root });
    expect(result.status).toBe('ok');
    expect(prompts.join('\n')).toContain('Prioritise contracts other code depends on');
  } finally {
    await repo.cleanup();
  }
});

it('forwards cq.json failure logging and sums driver failures into the review log', async () => {
  const repo = await makeTestRepo();
  try {
    await configureAgentRepo(repo);
    const config = JSON.parse(await readFile(join(repo.root, 'cq.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    await repo.write('cq.json', JSON.stringify({ ...config, harness: { logToolFailures: true } }));
    repo.commitAll('enable diagnostic logging');
    const drivers = scriptedDrivers(undefined, 3);
    const effects = repoEffects(repo);
    const result = await makeReviewRun({
      drivers,
      effectsFactory: () => effects,
      scannerFactory: () => async (components) =>
        components.map((component) => ({ component: component.component, hits: [] })),
    })({ repoRoot: repo.root });
    expect(result.status).toBe('ok');
    expect(drivers.resolve).toHaveBeenCalledWith(
      expect.objectContaining({
        harness: expect.objectContaining({ logToolFailures: true }) as unknown,
      }),
    );
    expect(effects.logs[0]).toContain('tool failures: 3');
  } finally {
    await repo.cleanup();
  }
});
