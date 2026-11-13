import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { makeReviewAddress } from '../../../src/ops/review/address.js';
import { makeGhRunner } from '../../../src/adapters/forge-github/gh.js';
import { resolvePrWorktree } from '../../../src/adapters/git/prWorktree.js';
import { slotWorktreeRegistry } from '../../../src/adapters/git/slotWorktreeRegistry.js';
import { readSlotMetadata } from '../../../src/adapters/lock/slotLock.js';
import { config } from './address.helpers.js';
import { identityRepo } from './addressManyWorktree.helpers.js';

// Exercise the public address finalization using the real ownership and resolver
// while injecting the resolver at the owned-action boundary.
const injection = vi.hoisted(() => ({ action: undefined as undefined | (() => Promise<unknown>) }));
vi.mock('../../../src/ops/review/internal/addressCheckoutOwnership.js', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../../src/ops/review/internal/addressCheckoutOwnership.js')
    >();
  return {
    ...actual,
    withAddressOwnership: (...args: Parameters<typeof actual.withAddressOwnership>) =>
      actual.withAddressOwnership(args[0], (lease) =>
        injection.action ? injection.action() : args[1](lease),
      ),
  };
});

test.each(['propagated', 'caught', 'fetch'] as const)(
  'address reports legacy refusal as needs-human and retains the slot: %s',
  async (mode) => {
    const repo = await identityRepo();
    try {
      repo.git('push', '-q', 'origin', 'HEAD:refs/pull/7/head');
      const common = repo.git('rev-parse', '--path-format=absolute', '--git-common-dir').trim();
      const root = join(common, 'cq-review-worktrees');
      await mkdir(root, { recursive: true });
      const path = join(root, 'pr-7-feature');
      repo.git('worktree', 'add', '-b', 'cq-review/pr-7', path, 'HEAD');
      const source = join(common, 'cq-review-address-worktrees.json');
      const bytes = JSON.stringify({ 7: { path, branch: 'cq-review/pr-7' } });
      await writeFile(source, bytes);
      await writeFile(join(repo.root, 'advance'), 'new head');
      repo.git('add', 'advance');
      repo.git('commit', '-m', 'advance head');
      repo.git('push', '-q', 'origin', 'HEAD:refs/pull/7/head');
      const git = makeGhRunner({ bin: 'git', cwd: repo.root });
      const registry = slotWorktreeRegistry(common);
      injection.action = async () => {
        try {
          await resolvePrWorktree({
            repoRoot: repo.root,
            pr: 7,
            headRefName: 'feature',
            worktreeRoot: root,
            nowMs: 1,
            registry,
            run: async (args) =>
              mode === 'fetch' && args.includes('fetch')
                ? { code: 1, stdout: '', stderr: 'injected fetch failure' }
                : git(args),
          });
        } catch (error) {
          if (mode !== 'caught') throw error;
        }
        return { status: 'needs-human', reason: 'caught resolver refusal' };
      };
      const result = await makeReviewAddress({ config, git })({
        repoRoot: repo.root,
        source: 'pr:7',
        journalDir: join(repo.root, 'journal'),
      });
      expect(result.status, JSON.stringify(result)).toBe('needs-human');
      if (result.status === 'needs-human')
        expect(result.reason).toMatch(
          mode === 'caught'
            ? /requires reconciliation/
            : mode === 'fetch'
              ? /fetch/i
              : /identity or head mismatch/,
        );
      expect(await readSlotMetadata(join(common, 'cq-review/slots/pr-7.json'))).toMatchObject({
        incomplete: true,
      });
      expect(await readFile(source, 'utf8')).toBe(bytes);
      expect(repo.git('-C', path, 'rev-parse', 'HEAD').trim()).not.toBe(
        repo.git('rev-parse', 'HEAD').trim(),
      );
    } finally {
      injection.action = undefined;
      await repo.cleanup();
    }
  },
);
