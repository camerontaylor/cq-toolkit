import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeReviewRun } from '../../../src/ops/review/run.js';
import { repoEffects, makeTestRepo } from '../dev/repo.js';
import { configureAgentRepo, scriptedDrivers } from './run.helpers.js';

describe('review.run', () => {
  it.each([
    [
      'a dropped connection (con_err) is marked blockedTransient',
      'Review failed: con_err: webSocket connection failed',
      true,
    ],
    ['any other CLI error is not', 'Review failed: auth_required', false],
    [
      'a dropped connection followed by an auth error is not',
      'Review failed: con_err: socket closed\nAUTH',
      false,
    ],
  ] as const)('#509: %s', async (_label, message, transient) => {
    const repo = await makeTestRepo();
    try {
      await repo.write('package.json', JSON.stringify({ name: 'fixture-review' }));
      await repo.write(
        'cq.json',
        JSON.stringify({
          schemaVersion: 2,
          checks: [{ adapter: 'tsc-lines', command: { command: 'tsc', args: [] } }],
          review: { reviewers: ['coderabbit'] },
        }),
      );
      repo.commitAll('configure CodeRabbit-only review');
      const effects = repoEffects(repo, (command) =>
        command === 'coderabbit'
          ? {
              exitCode: 1,
              stdout: message
                .split('\nAUTH')
                .map((text, index) =>
                  index === 0
                    ? `${JSON.stringify({ type: 'error', errorType: 'review', message: text, recoverable: false })}\n`
                    : `${JSON.stringify({ type: 'error', errorType: 'review', message: 'Review failed: auth_err: login required', recoverable: false })}\n`,
                )
                .join(''),
              stderr: 'Error: An unexpected error occurred.',
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
      expect(result.status).toBe('needs-human');
      expect(result.report?.blockedTransient).toBe(transient ? true : undefined);
    } finally {
      await repo.cleanup();
    }
  });

  it('normalizes a successful CodeRabbit-only cycle and persists its finding', async () => {
    const repo = await makeTestRepo();
    try {
      await repo.write('package.json', JSON.stringify({ name: 'fixture-review' }));
      await repo.write(
        'cq.json',
        JSON.stringify({
          schemaVersion: 2,
          checks: [{ adapter: 'tsc-lines', command: { command: 'tsc', args: [] } }],
          review: { reviewers: ['coderabbit'] },
        }),
      );
      repo.commitAll('configure CodeRabbit-only review');
      const effects = repoEffects(repo, (command) =>
        command === 'coderabbit'
          ? {
              exitCode: 0,
              stdout:
                `${JSON.stringify({ type: 'finding', severity: 'major', fileName: 'src/a.ts', comment: 'seeded CodeRabbit finding' })}\n` +
                `${JSON.stringify({ type: 'complete', status: 'review_completed' })}\n`,
              stderr: '',
              timedOut: false,
            }
          : undefined,
      );
      const drivers = scriptedDrivers();
      const result = await makeReviewRun({
        drivers,
        effectsFactory: () => effects,
        scannerFactory: () => async (components) =>
          components.map((component) => ({ component: component.component, hits: [] })),
      })({ repoRoot: repo.root });
      expect(result.status).toBe('ok');
      if (result.status !== 'ok') return;
      expect(result.value.sources).toEqual([
        expect.objectContaining({ kind: 'coderabbit', status: 'terminal' }),
      ]);
      expect(result.value.findings).toEqual([
        expect.objectContaining({
          source: 'coderabbit',
          severity: 'major',
          file: 'src/a.ts',
          text: 'seeded CodeRabbit finding',
          status: 'open',
        }),
      ]);
      expect(drivers.resolve).not.toHaveBeenCalled();
    } finally {
      await repo.cleanup();
    }
  });

  it('keeps findings from a blocked CodeRabbit cycle in the portable record', async () => {
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
      repo.commitAll('fixture blocked CodeRabbit review');
      const effects = repoEffects(repo, (command) =>
        command === 'coderabbit'
          ? {
              exitCode: 1,
              stdout: `${JSON.stringify({ type: 'finding', severity: 'critical', fileName: 'src/a.ts', comment: 'partial critical evidence' })}\n`,
              stderr: 'review interrupted',
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
      expect(result.status).toBe('needs-human');
      if (result.status !== 'needs-human') return;
      const folder = join(repo.root, '.cq', 'review', 'feature%2Fx');
      const [recordFile] = await readdir(folder);
      const persisted = JSON.parse(await readFile(join(folder, recordFile ?? ''), 'utf8')) as {
        sources: { kind: string; status: string; cycleId?: string }[];
        findings: { id: string; source: string; severity: string; file?: string; text: string }[];
      };
      const source = persisted.sources.find((item) => item.kind === 'coderabbit');
      expect(source).toMatchObject({ kind: 'coderabbit', status: 'blocked' });
      expect(source?.cycleId).toMatch(/^c001-/);
      expect(persisted.findings).toContainEqual(
        expect.objectContaining({
          id: `${source?.cycleId}#f1`,
          source: 'coderabbit',
          severity: 'critical',
          file: 'src/a.ts',
          text: 'partial critical evidence',
          status: 'open',
        }),
      );
    } finally {
      await repo.cleanup();
    }
  });

  it('reports uncertainty when a blocked cycle ledger cannot be read back', async () => {
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
      repo.commitAll('fixture blocked CodeRabbit review');
      const effects = repoEffects(repo, (command) =>
        command === 'coderabbit'
          ? { exitCode: 1, stdout: '', stderr: 'not authenticated', timedOut: false }
          : undefined,
      );
      const openLedger = effects.openLedger.bind(effects);
      effects.openLedger = (branch) => {
        const ledger = openLedger(branch);
        return {
          ...ledger,
          load: () => {
            throw new Error('ledger read fault');
          },
        };
      };
      const result = await makeReviewRun({
        drivers: scriptedDrivers(),
        effectsFactory: () => effects,
        scannerFactory: () => async (components) =>
          components.map((component) => ({ component: component.component, hits: [] })),
      })({ repoRoot: repo.root });
      expect(result.status).toBe('indeterminate');
      if (result.status === 'indeterminate') expect(result.detail).toContain('ledger read fault');
    } finally {
      await repo.cleanup();
    }
  });

  it('maps a diff command rejection to failed', async () => {
    const repo = await makeTestRepo();
    try {
      await configureAgentRepo(repo);
      const effects = repoEffects(repo);
      const run = effects.runCommand;
      effects.runCommand = async (command, args, options) => {
        if (
          command === 'git' &&
          args[0] === 'diff' &&
          args.includes('--no-textconv') &&
          args.includes('--name-only')
        )
          throw new Error('spawn failed');
        return run(command, args, options);
      };
      const result = await makeReviewRun({
        drivers: scriptedDrivers(),
        effectsFactory: () => effects,
        scannerFactory: () => async (components) =>
          components.map((component) => ({ component: component.component, hits: [] })),
      })({ repoRoot: repo.root });
      expect(result.status).toBe('failed');
      if (result.status === 'failed') expect(result.error).toContain('spawn failed');
    } finally {
      await repo.cleanup();
    }
  });
});
