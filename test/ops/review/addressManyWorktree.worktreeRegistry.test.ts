import {
  slotWorktreeRegistry,
  discoverWorktreeSlots,
} from '../../../src/adapters/git/slotWorktreeRegistry.js';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { resolvePrWorktree } from '../../../src/adapters/git/prWorktree.js';
import { NOW, fixture } from './addressManyWorktree.helpers.js';

// The removed child-harness cases used the retired owner's fabricated child
// API. Real concurrent slots are exercised in addressMany.slotOwnership;
// leased publication and callback ordering are covered in review-loop.push-target.

test('concurrent PRs sharing a head ref retain distinct exact-head worktrees and both registry entries', async () => {
  const f = await fixture();
  try {
    const results = await Promise.all(f.prs.map(f.resolve));
    expect(new Set(await Promise.all(results.map((result) => realpath(result.path)))).size).toBe(2);
    expect(new Set(results.map((result) => result.branch)).size).toBe(2);
    const entries = await discoverWorktreeSlots(
      f.repo.git('rev-parse', '--path-format=absolute', '--git-common-dir').trim(),
    );
    expect([...entries.keys()].map(String).sort()).toEqual(['7', '9']);
    for (const [index, pr] of f.prs.entries()) {
      const result = results[index]!;
      expect(result.reused).toBe(false);
      expect(f.repo.git('-C', result.path, 'rev-parse', 'HEAD').trim()).toBe(pr.headRefOid);
      expect(f.repo.git('-C', result.path, 'symbolic-ref', 'HEAD').trim()).toBe(
        `refs/heads/${result.branch}`,
      );
      expect(entries.get(pr.number)).toMatchObject({
        version: 1,
        state: 'bound',
        incomplete: false,
        checkoutPath: result.path,
      });
    }
    expect(f.prs[0].headRefOid).not.toBe(f.prs[1].headRefOid);
    // Reopening both through fresh handles must preserve each PR's identity.
    const reused = await Promise.all(f.prs.map(f.resolve));
    // Git may canonicalize macOS /var paths to /private/var between creation and reuse.
    expect(
      await Promise.all(
        reused.map(async (result) => ({ ...result, path: await realpath(result.path) })),
      ),
    ).toEqual(
      await Promise.all(
        results.map(async (result) => ({
          ...result,
          path: await realpath(result.path),
          reused: true,
        })),
      ),
    );
  } finally {
    await f.repo.cleanup();
  }
});
test('settled fetched-head fence preserves dirty checkout and permits corrected retry (mutation: skip settled completion)', async () => {
  const f = await fixture();
  try {
    const checkout = await f.resolve(f.prs[0]);
    const original = await readFile(join(checkout.path, 'README.md'));
    await writeFile(join(checkout.path, 'README.md'), 'private stale edit\n');
    const before = await readFile(
      join(f.repo.root, '.git', 'cq-review', 'slots', 'pr-7.json'),
      'utf8',
    );
    f.repo.git('push', '-q', 'origin', `${f.prs[1].headRefOid}:refs/pull/7/head`);
    const options = {
      repoRoot: f.repo.root,
      pr: 7,
      headRefName: 'feature/x',
      expectedHead: f.prs[0].headRefOid,
      run: f.run,
      registry: slotWorktreeRegistry(
        f.repo.git('rev-parse', '--path-format=absolute', '--git-common-dir').trim(),
      ),
      worktreeRoot: f.worktreeRoot,
      nowMs: NOW,
    };
    for (let refusal = 0; refusal < 2; refusal++) {
      await expect(resolvePrWorktree(options)).rejects.toThrow('changed since admission');
      // The gate did not admit a checkout writer. Preserve both the exact
      // completed pointer and the user's bytes, without operator repair.
      expect(await readFile(join(f.repo.root, '.git/cq-review/slots/pr-7.json'), 'utf8')).toBe(
        before,
      );
    }
    expect(await readFile(join(checkout.path, 'README.md'), 'utf8')).toBe('private stale edit\n');
    expect(f.repo.git('-C', checkout.path, 'rev-parse', 'HEAD').trim()).toBe(f.prs[0].headRefOid);
    await writeFile(join(checkout.path, 'README.md'), original);
    const retry = await resolvePrWorktree({ ...options, expectedHead: f.prs[1].headRefOid });
    expect(retry).toMatchObject({ path: checkout.path, reused: false });
    expect(f.repo.git('-C', retry.path, 'rev-parse', 'HEAD').trim()).toBe(f.prs[1].headRefOid);
    const metadata = await discoverWorktreeSlots(
      f.repo.git('rev-parse', '--path-format=absolute', '--git-common-dir').trim(),
    );
    expect(metadata.get(7)).toMatchObject({
      state: 'bound',
      incomplete: false,
      checkoutPath: retry.path,
    });
  } finally {
    await f.repo.cleanup();
  }
});
