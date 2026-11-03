import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { makeReviewRun } from '../../../src/ops/review/run.js';
import { repoEffects, makeTestRepo } from '../dev/repo.js';
import { configureAgentRepo, scriptedDrivers } from './run.helpers.js';

it.each([false, true])(
  'persists immutable reviewed base and scope for uncommitted=%s',
  async (uncommitted) => {
    const repo = await makeTestRepo();
    try {
      await configureAgentRepo(repo);
      await repo.write('src/a.ts', 'export const a = 2;\n');
      repo.commitAll('reviewed clean candidate');
      const result = await makeReviewRun({
        drivers: scriptedDrivers(),
        effectsFactory: () => repoEffects(repo),
        scannerFactory: () => async (components) =>
          components.map((component) => ({ component: component.component, hits: [] })),
      })({ repoRoot: repo.root, uncommitted });
      expect(result.status).toBe('ok');
      if (result.status !== 'ok') return;
      const reviewed = {
        base: uncommitted
          ? repo.git('rev-parse', 'HEAD').trim()
          : repo.git('merge-base', 'origin/main', 'HEAD').trim(),
        scope: uncommitted ? 'uncommitted' : 'full',
      };
      expect(result.value.reviewed).toEqual(reviewed);
      const folder = join(repo.root, '.cq', 'review', 'feature%2Fx');
      const [file] = await readdir(folder);
      expect(JSON.parse(await readFile(join(folder, file!), 'utf8')) as unknown).toMatchObject({
        reviewed,
      });
    } finally {
      await repo.cleanup();
    }
  },
);

it('persists completed findings as blocked when the source changes during the agent review', async () => {
  const repo = await makeTestRepo();
  try {
    await configureAgentRepo(repo);
    await repo.write('src/a.ts', 'export const a = 2;\n');
    const drivers = scriptedDrivers(() => {
      repo.git('checkout', '--', 'src/a.ts');
    });
    let persisted: unknown;
    const result = await makeReviewRun({
      drivers,
      effectsFactory: () => repoEffects(repo),
      scannerFactory: () => async (components) =>
        components.map(({ component }) => ({ component, hits: [] })),
      writeFindingsRecord: async (_path, content) => {
        persisted = JSON.parse(content);
      },
    })({ repoRoot: repo.root });
    expect(result.status).toBe('needs-human');
    expect(persisted).toMatchObject({
      sources: [
        expect.objectContaining({
          kind: 'agent',
          status: 'blocked',
          reason: 'repository state changed during agent review',
        }),
      ],
      findings: [expect.objectContaining({ text: 'seeded' })],
    });
    expect(persisted).not.toHaveProperty('reviewed');
  } finally {
    await repo.cleanup();
  }
});

it('sends commit intent and the numstat file list through the scanned session prompt', async () => {
  const repo = await makeTestRepo();
  try {
    await configureAgentRepo(repo);
    await repo.write('src/intent.ts', 'export const intent = 1;\n');
    repo.commitAll('feat: capture INTENT_MARKER\n\nexplains the change');
    const prompts: string[] = [];
    const scanned: { component: string; text: string }[] = [];
    const result = await makeReviewRun({
      drivers: scriptedDrivers((input) => prompts.push(input.prompt)),
      effectsFactory: () => repoEffects(repo),
      scannerFactory: () => async (components) => {
        scanned.push(...components.map(({ component, text }) => ({ component, text })));
        return components.map((component) => ({ component: component.component, hits: [] }));
      },
    })({ repoRoot: repo.root });
    expect(result.status).toBe('ok');
    const prompt = prompts.join('\n');
    expect(prompt).toContain('INTENT_MARKER');
    expect(prompt).toContain('explains the change');
    expect(prompt).toContain('## Changed files');
    expect(prompt).toMatch(/\d+\t\d+\tsrc\/intent\.ts/);
    expect(scanned).toContainEqual(
      expect.objectContaining({
        component: 'review-prompt',
        text: expect.stringContaining('INTENT_MARKER') as unknown,
      }),
    );
  } finally {
    await repo.cleanup();
  }
});

it.each(['full', 'uncommitted'] as const)(
  'collects bounded %s context at the reviewed comparison',
  async (scope) => {
    const repo = await makeTestRepo();
    try {
      await configureAgentRepo(repo);
      await repo.write('src/committed-context.ts', 'export const committed = 1;\n');
      repo.commitAll('RUN_CONTEXT_COMMITTED\n\n' + 'x'.repeat(5000));
      await repo.write('src/dirty-context.ts', 'export const dirty = 1;\n');
      repo.git('add', 'src/dirty-context.ts');
      await repo.write('src/untracked-context.ts', 'export const untracked = true;');
      const review = vi.fn<
        typeof import('../../../src/ops/review/agentReviewer.js').runAgentReviewer
      >(async () => ({ status: 'needs-human' as const, reason: 'fixture context captured' }));
      await makeReviewRun({
        drivers: scriptedDrivers(),
        runAgentReviewer: review,
        effectsFactory: () => repoEffects(repo),
        scannerFactory: () => async (components) =>
          components.map((component) => ({ component: component.component, hits: [] })),
      })({ repoRoot: repo.root, ...(scope === 'uncommitted' ? { uncommitted: true } : {}) });
      expect(review).toHaveBeenCalledOnce();
      const input = review.mock.calls[0]!;
      expect(input[1].scope).toBe(scope);
      expect(input[1].intent!.length).toBeLessThanOrEqual(4000);
      expect(input[1].fileList!.length).toBeLessThanOrEqual(4000);
      expect(input[1].fileList).toContain('src/dirty-context.ts');
      expect(input[1].fileList).toContain('(untracked)\t"src/untracked-context.ts"');
      if (scope === 'full') {
        expect(input[1].intent).toContain('RUN_CONTEXT_COMMITTED');
        expect(input[1].intent).toContain('[truncated:');
        expect(input[1].fileList).toContain('src/committed-context.ts');
      } else {
        expect(input[1].intent).toBe('');
        expect(input[1].fileList).not.toContain('src/committed-context.ts');
        expect(input[1].base).toBe(repo.git('rev-parse', 'HEAD').trim());
      }
    } finally {
      await repo.cleanup();
    }
  },
);
