import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeReviewRun } from '../../../src/ops/review/run.js';
import { repoEffects, makeTestRepo } from '../dev/repo.js';
import { configureAgentRepo, scriptedDrivers } from './run.helpers.js';

describe('review.run', () => {
  it('maps a denylist scanner rejection to needs-human and refuses the upload', async () => {
    const repo = await makeTestRepo();
    try {
      await configureAgentRepo(repo);
      const result = await makeReviewRun({
        drivers: scriptedDrivers(),
        effectsFactory: () => repoEffects(repo),
        scannerFactory: () => async () => {
          throw new Error('scanner unavailable');
        },
      })({ repoRoot: repo.root });
      expect(result.status).toBe('needs-human');
      if (result.status === 'needs-human')
        expect(result.reason).toContain('denylist scan failed closed');
    } finally {
      await repo.cleanup();
    }
  });

  it('refuses reviewer dispatch when the denylist scan finds protected content', async () => {
    const repo = await makeTestRepo();
    try {
      await configureAgentRepo(repo);
      const drivers = scriptedDrivers();
      const result = await makeReviewRun({
        drivers,
        effectsFactory: () => repoEffects(repo),
        scannerFactory: () => async (components) =>
          components.map((component) => ({
            component: component.component,
            hits: [{ ruleId: 'fixture-secret', lines: [1] }],
          })),
      })({ repoRoot: repo.root });
      expect(result.status).toBe('needs-human');
      if (result.status === 'needs-human') expect(result.reason).toContain('protected content');
      expect(drivers.resolve).not.toHaveBeenCalled();
    } finally {
      await repo.cleanup();
    }
  });

  it('records a blocked source when cq.json requests an agent without a reviewer role', async () => {
    const repo = await makeTestRepo();
    try {
      await repo.write('package.json', JSON.stringify({ name: 'fixture-review' }));
      await repo.write(
        'cq.json',
        JSON.stringify({
          schemaVersion: 2,
          checks: [{ adapter: 'tsc-lines', command: { command: 'tsc', args: [] } }],
          budgets: { run: { maxTokens: 500 } },
          review: { reviewers: ['agent'] },
        }),
      );
      repo.commitAll('configure agent review without a role');
      const drivers = scriptedDrivers();
      const result = await makeReviewRun({
        drivers,
        effectsFactory: () => repoEffects(repo),
        scannerFactory: () => async (components) =>
          components.map((component) => ({ component: component.component, hits: [] })),
      })({ repoRoot: repo.root });
      expect(result.status).toBe('needs-human');
      if (result.status === 'needs-human')
        expect(result.reason).toContain('not every configured reviewer');
      expect(drivers.resolve).not.toHaveBeenCalled();
      const folder = join(repo.root, '.cq', 'review', 'feature%2Fx');
      const [recordFile] = await readdir(folder);
      const stored = JSON.parse(await readFile(join(folder, recordFile ?? ''), 'utf8')) as {
        sources: { kind: string; status: string; reason?: string }[];
      };
      expect(stored.sources).toContainEqual({
        kind: 'agent',
        status: 'blocked',
        reason: 'cq.json roles.reviewer is required for an agent review',
      });
    } finally {
      await repo.cleanup();
    }
  });

  it('persists an agent source blocked by the required token budget', async () => {
    const repo = await makeTestRepo();
    try {
      await repo.write('package.json', JSON.stringify({ name: 'fixture-review' }));
      await repo.write(
        'cq.json',
        JSON.stringify({
          schemaVersion: 2,
          checks: [{ adapter: 'tsc-lines', command: { command: 'tsc', args: [] } }],
          roles: { reviewer: { provider: 'mock', model: 'mock' } },
          review: { reviewers: ['agent'] },
        }),
      );
      repo.commitAll('configure agent review without a token budget');
      const drivers = scriptedDrivers();
      const result = await makeReviewRun({
        drivers,
        effectsFactory: () => repoEffects(repo),
        scannerFactory: () => async (components) =>
          components.map((component) => ({ component: component.component, hits: [] })),
      })({ repoRoot: repo.root });
      expect(result.status).toBe('needs-human');
      if (result.status === 'needs-human')
        expect(result.reason).toContain('not every configured reviewer');
      expect(drivers.resolve).not.toHaveBeenCalled();
      const folder = join(repo.root, '.cq', 'review', 'feature%2Fx');
      const [recordFile] = await readdir(folder);
      const stored = JSON.parse(await readFile(join(folder, recordFile ?? ''), 'utf8')) as {
        sources: { kind: string; status: string; reason?: string }[];
      };
      const agent = stored.sources.find((source) => source.kind === 'agent');
      expect(agent?.status).toBe('blocked');
      expect(agent?.reason).toContain('Agentic runs require budgets.run.maxTokens');
    } finally {
      await repo.cleanup();
    }
  });

  it('records a blocked agent source when git cannot list the review diff', async () => {
    const repo = await makeTestRepo();
    try {
      await configureAgentRepo(repo);
      const effects = repoEffects(repo, (command, args) =>
        command === 'git' && args[0] === 'diff' && args.includes('--name-only')
          ? { exitCode: 2, stdout: '', stderr: 'diff unavailable', timedOut: false }
          : undefined,
      );
      const drivers = scriptedDrivers();
      const result = await makeReviewRun({
        drivers,
        effectsFactory: () => effects,
        scannerFactory: () => async (components) =>
          components.map((component) => ({ component: component.component, hits: [] })),
      })({ repoRoot: repo.root });
      expect(result.status).toBe('needs-human');
      if (result.status === 'needs-human')
        expect(result.reason).toContain('not every configured reviewer');
      expect(drivers.resolve).not.toHaveBeenCalled();
      const folder = join(repo.root, '.cq', 'review', 'feature%2Fx');
      const [recordFile] = await readdir(folder);
      const stored = JSON.parse(await readFile(join(folder, recordFile ?? ''), 'utf8')) as {
        sources: { kind: string; status: string; reason?: string }[];
      };
      expect(stored.sources).toContainEqual(
        expect.objectContaining({
          kind: 'agent',
          status: 'blocked',
          reason: 'could not list review diff paths (exit 2)',
        }),
      );
    } finally {
      await repo.cleanup();
    }
  });

  it('scans and reviews the full content of untracked files', async () => {
    const repo = await makeTestRepo();
    try {
      await configureAgentRepo(repo);
      await repo.write('src/untracked.ts', 'export const pending = true;\n');
      const scanned: { path: string; text: string }[] = [];
      let prompt = '';
      const result = await makeReviewRun({
        drivers: scriptedDrivers((input) => {
          prompt += input.prompt;
        }),
        effectsFactory: () => repoEffects(repo),
        scannerFactory: () => async (components) => {
          scanned.push(...components.map(({ path, text }) => ({ path, text })));
          return components.map((component) => ({ component: component.component, hits: [] }));
        },
      })({ repoRoot: repo.root });
      expect(result.status).toBe('ok');
      expect(scanned).toContainEqual({
        path: 'src/untracked.ts',
        text: 'export const pending = true;\n',
      });
      expect(prompt).toContain('src/untracked.ts');
      expect(prompt).toContain('export const pending = true;');
    } finally {
      await repo.cleanup();
    }
  });

  it('refuses to scan when an untracked file cannot be read safely', async () => {
    const repo = await makeTestRepo();
    try {
      await configureAgentRepo(repo);
      await repo.write('src/untracked.ts', 'export const pending = true;\n');
      const effects = repoEffects(repo);
      effects.readWorktreeFile = async () => ({ ok: false, reason: 'fixture symlink refusal' });
      const drivers = scriptedDrivers();
      const result = await makeReviewRun({
        drivers,
        effectsFactory: () => effects,
        scannerFactory: () => async (components) =>
          components.map((component) => ({ component: component.component, hits: [] })),
      })({ repoRoot: repo.root });
      expect(result.status).toBe('needs-human');
      if (result.status === 'needs-human')
        expect(result.reason).toContain('fixture symlink refusal');
      expect(drivers.resolve).not.toHaveBeenCalled();
    } finally {
      await repo.cleanup();
    }
  });

  it('records a blocked agent source when a per-file diff command fails', async () => {
    const repo = await makeTestRepo();
    try {
      await configureAgentRepo(repo);
      const effects = repoEffects(repo, (command, args) =>
        command === 'git' &&
        args[0] === 'diff' &&
        args.includes('--text') &&
        args.at(-1) === 'src/a.ts'
          ? { exitCode: 2, stdout: '', stderr: 'patch unavailable', timedOut: false }
          : undefined,
      );
      const drivers = scriptedDrivers();
      const result = await makeReviewRun({
        drivers,
        effectsFactory: () => effects,
        scannerFactory: () => async (components) =>
          components.map((component) => ({ component: component.component, hits: [] })),
      })({ repoRoot: repo.root });
      expect(result.status).toBe('needs-human');
      if (result.status === 'needs-human')
        expect(result.reason).toContain('not every configured reviewer');
      expect(drivers.resolve).not.toHaveBeenCalled();
      const folder = join(repo.root, '.cq', 'review', 'feature%2Fx');
      const [recordFile] = await readdir(folder);
      const stored = JSON.parse(await readFile(join(folder, recordFile ?? ''), 'utf8')) as {
        sources: { kind: string; status: string; reason?: string }[];
      };
      expect(stored.sources).toContainEqual(
        expect.objectContaining({
          kind: 'agent',
          status: 'blocked',
          reason: "could not collect diff for 'src/a.ts' (exit 2)",
        }),
      );
    } finally {
      await repo.cleanup();
    }
  });

  it('refuses reviewer dispatch when repository state changes during the scan', async () => {
    const repo = await makeTestRepo();
    try {
      await configureAgentRepo(repo);
      const drivers = scriptedDrivers();
      const result = await makeReviewRun({
        drivers,
        effectsFactory: () => repoEffects(repo),
        scannerFactory: () => async (components) => {
          await repo.write('src/a.ts', 'export const a = 99;\n');
          return components.map((component) => ({ component: component.component, hits: [] }));
        },
      })({ repoRoot: repo.root });
      expect(result.status).toBe('needs-human');
      if (result.status === 'needs-human')
        expect(result.reason).toContain('state changed after the scan');
      expect(drivers.resolve).not.toHaveBeenCalled();
    } finally {
      await repo.cleanup();
    }
  });
});
