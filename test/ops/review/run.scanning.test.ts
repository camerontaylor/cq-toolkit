import { describe, expect, it } from 'vitest';
import { makeReviewRun } from '../../../src/ops/review/run.js';
import { repoEffects, makeTestRepo } from '../dev/repo.js';
import { configureAgentRepo, scriptedDrivers } from './run.helpers.js';

describe('review.run', () => {
  it('scans tracked paths separately and includes staged plus unstaged changes without textconv', async () => {
    const repo = await makeTestRepo();
    try {
      await configureAgentRepo(repo);
      await repo.write('src/staged.ts', 'export const staged = true;\n');
      repo.git('add', 'src/staged.ts');
      await repo.write('src/a.ts', 'export const a = 2;\n');
      const effects = repoEffects(repo);
      const scanned: string[] = [];
      let prompt = '';
      const result = await makeReviewRun({
        drivers: scriptedDrivers((input) => {
          prompt += input.prompt;
        }),
        effectsFactory: () => effects,
        scannerFactory: () => async (components) => {
          scanned.push(...components.map((component) => component.path));
          return components.map((component) => ({ component: component.component, hits: [] }));
        },
      })({ repoRoot: repo.root, uncommitted: true });
      expect(result.status).toBe('ok');
      expect(scanned).toContain('src/staged.ts');
      expect(scanned).toContain('src/a.ts');
      expect(prompt).toContain('src/staged.ts');
      expect(prompt).toContain('src/a.ts');
      const diffCalls = effects.calls.filter(
        (call) => call.command === 'git' && call.args[0] === 'diff',
      );
      expect(diffCalls.every((call) => call.args.includes('--no-textconv'))).toBe(true);
      const patchCalls = diffCalls.filter((call) =>
        ['src/staged.ts', 'src/a.ts'].includes(call.args.at(-1) ?? ''),
      );
      expect(patchCalls.every((call) => call.args.includes('--text'))).toBe(true);
      expect(patchCalls.every((call) => !call.args.includes('--binary'))).toBe(true);
      expect(diffCalls.some((call) => call.args.includes('HEAD'))).toBe(true);
    } finally {
      await repo.cleanup();
    }
  });

  it('exposes binary tracked file text to the fail-closed pre-upload scanner', async () => {
    const repo = await makeTestRepo();
    try {
      await configureAgentRepo(repo);
      await repo.write('src/payload.bin', 'baseline\0safe\n');
      repo.commitAll('add binary base content');
      const sentinel = ['port', 'key-secret-fixture'].join('');
      await repo.write('src/payload.bin', `changed\0${sentinel}\n`);
      const scanned: string[] = [];
      const result = await makeReviewRun({
        drivers: scriptedDrivers(),
        effectsFactory: () => repoEffects(repo),
        scannerFactory: () => async (components) => {
          scanned.push(...components.map((component) => component.text));
          return components.map((component) => ({ component: component.component, hits: [] }));
        },
      })({ repoRoot: repo.root });
      expect(result.status).toBe('ok');
      expect(scanned.some((text) => text.includes(sentinel))).toBe(true);
    } finally {
      await repo.cleanup();
    }
  });

  it('keeps protected rename provenance visible to the scanner and refuses reviewer upload', async () => {
    const repo = await makeTestRepo();
    try {
      await configureAgentRepo(repo);
      const syntheticPrivateBytes = ['synthetic', 'corpus', 'marker', '7f3'].join('-');
      await repo.write('.env.config', `${syntheticPrivateBytes}\n`);
      repo.commitAll('add synthetic private fixture');
      repo.git('push', '-q', 'origin', 'HEAD:main');
      repo.git('mv', '.env.config', 'config.txt');
      repo.commitAll('rename synthetic private fixture');

      const drivers = scriptedDrivers();
      const scanned: { path: string; text: string }[] = [];
      const effects = repoEffects(repo);
      const result = await makeReviewRun({
        drivers,
        effectsFactory: () => effects,
        scannerFactory: () => async (components) => {
          scanned.push(...components.map(({ path, text }) => ({ path, text })));
          return components.map((component) => ({
            component: component.component,
            hits:
              component.path === '.env.config' && component.text.includes(syntheticPrivateBytes)
                ? [{ ruleId: 'fixture-private-path', lines: [1] }]
                : [],
          }));
        },
      })({ repoRoot: repo.root });

      const oldPathComponent = scanned.find((component) => component.path === '.env.config');
      expect(oldPathComponent?.text).toContain(syntheticPrivateBytes);
      expect(scanned.some((component) => component.path === 'config.txt')).toBe(true);
      expect(result.status).toBe('needs-human');
      if (result.status === 'needs-human') expect(result.reason).toContain('protected content');
      expect(drivers.resolve).not.toHaveBeenCalled();
      const diffCalls = effects.calls.filter(
        (call) => call.command === 'git' && call.args[0] === 'diff',
      );
      expect(diffCalls.length).toBeGreaterThan(1);
      expect(diffCalls.every((call) => call.args.includes('--no-renames'))).toBe(true);
    } finally {
      await repo.cleanup();
    }
  });

  it('allows a public file rename after scanning both path sides', async () => {
    const repo = await makeTestRepo();
    try {
      await configureAgentRepo(repo);
      repo.git('rm', 'package.json');
      repo.commitAll('remove optional package metadata');
      await repo.write('src/public.txt', 'ordinary public fixture\n');
      repo.commitAll('add public fixture');
      repo.git('push', '-q', 'origin', 'HEAD:main');
      repo.git('mv', 'src/public.txt', 'src/public-renamed.txt');
      repo.commitAll('rename public fixture');

      const drivers = scriptedDrivers();
      const scanned = new Set<string>();
      const effects = repoEffects(repo);
      const result = await makeReviewRun({
        drivers,
        effectsFactory: () => effects,
        scannerFactory: () => async (components) => {
          components.forEach(({ path }) => scanned.add(path));
          return components.map((component) => ({ component: component.component, hits: [] }));
        },
      })({ repoRoot: repo.root });

      expect(scanned).toContain('src/public.txt');
      expect(scanned).toContain('src/public-renamed.txt');
      expect(result.status).toBe('ok');
      expect(drivers.resolve).toHaveBeenCalledTimes(1);
      const diffCalls = effects.calls.filter(
        (call) => call.command === 'git' && call.args[0] === 'diff',
      );
      expect(diffCalls.every((call) => call.args.includes('--no-renames'))).toBe(true);
    } finally {
      await repo.cleanup();
    }
  });

  it('maps a thrown per-path diff command to failed', async () => {
    const repo = await makeTestRepo();
    try {
      await configureAgentRepo(repo);
      const effects = repoEffects(repo, (command, args) => {
        if (
          command === 'git' &&
          args[0] === 'diff' &&
          args.includes('--text') &&
          args.at(-1) === 'src/a.ts'
        )
          throw new Error('diff process unavailable');
        return undefined;
      });
      const result = await makeReviewRun({
        drivers: scriptedDrivers(),
        effectsFactory: () => effects,
        scannerFactory: () => async (components) =>
          components.map((component) => ({ component: component.component, hits: [] })),
      })({ repoRoot: repo.root });

      expect(result.status).toBe('failed');
      if (result.status === 'failed') expect(result.error).toContain('diff process unavailable');
    } finally {
      await repo.cleanup();
    }
  });

  it('maps a thrown untracked-file read to failed', async () => {
    const repo = await makeTestRepo();
    try {
      await configureAgentRepo(repo);
      await repo.write('src/untracked.ts', 'export const pending = true;\n');
      const effects = repoEffects(repo);
      effects.readWorktreeFile = async () => {
        throw new Error('worktree read unavailable');
      };
      const result = await makeReviewRun({
        drivers: scriptedDrivers(),
        effectsFactory: () => effects,
        scannerFactory: () => async (components) =>
          components.map((component) => ({ component: component.component, hits: [] })),
      })({ repoRoot: repo.root });

      expect(result.status).toBe('failed');
      if (result.status === 'failed') expect(result.error).toContain('worktree read unavailable');
    } finally {
      await repo.cleanup();
    }
  });
});
