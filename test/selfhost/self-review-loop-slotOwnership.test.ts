import { expect, test } from 'vitest';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runSelfReviewLoop } from '../../src/selfhost/self-review-loop.js';
import { runReviewLoop } from '../../src/plans/review-loop.js';
import { slotFixture, deferred, reached } from '../ops/review/slotOwnership.helpers.js';
import { fakeGh, pullRow } from './self-review-loop-fakes.js';

test('selfhost and standalone share slot (mutation: leave selfhost on old owner)', async () => {
  const f = await slotFixture(),
    entered = deferred(),
    release = deferred();
  let pending: Promise<unknown> | undefined;
  try {
    pending = runSelfReviewLoop(
      {
        gh: fakeGh([pullRow(7)], { stateRoutes: true }),
        git: f.run,
        nowMs: () => 1,
        loop: (opts) =>
          runReviewLoop({
            ...opts,
            gh: f.opts().gh,
            onWorktreeResolved: async () => {
              entered.resolve();
              await release.promise;
            },
          }),
      },
      {
        owner: 'octo',
        repo: 'widget',
        responderLogin: null,
        repoRoot: f.repo.root,
        journalRoot: join(f.root, 'audit'),
      },
    );
    await reached(entered.promise, pending);
    await expect(
      runReviewLoop({ ...f.opts(), worktreeRoot: join(f.repo.root, '.selfhost/worktrees') }),
    ).rejects.toThrow(/busy/i);
  } finally {
    release.resolve();
    await pending;
    await f.repo.cleanup();
  }
});

test.each(['incomplete', 'malformed'] as const)(
  '%s PR retains all audit stamps (mutation: drop incomplete metadata pruning guard)',
  async (kind) => {
    const f = await slotFixture();
    try {
      const journalRoot = join(f.root, 'audit');
      for (const pr of [7, 9])
        for (let stamp = 1; stamp <= 7; stamp++)
          await mkdir(join(journalRoot, `${pr}-${stamp}`), { recursive: true });
      const slots = join(f.common, 'cq-review/slots');
      await mkdir(slots, { recursive: true });
      await writeFile(
        join(slots, 'pr-7.json'),
        kind === 'incomplete'
          ? JSON.stringify({ version: 1, state: 'unbound', incomplete: true })
          : 'broken metadata',
      );
      await writeFile(
        join(slots, 'pr-9.json'),
        JSON.stringify({ version: 1, state: 'unbound', incomplete: false }),
      );
      await runSelfReviewLoop(
        { gh: fakeGh([]), git: f.run, nowMs: () => 10 },
        {
          owner: 'octo',
          repo: 'widget',
          responderLogin: null,
          repoRoot: f.repo.root,
          journalRoot,
        },
      );
      const names = await readdir(journalRoot);
      expect(names.filter((n) => n.startsWith('7-')).sort()).toEqual(
        Array.from({ length: 7 }, (_, i) => `7-${i + 1}`),
      );
      expect(names.filter((n) => n.startsWith('9-')).sort()).toEqual([
        '9-3',
        '9-4',
        '9-5',
        '9-6',
        '9-7',
      ]);
    } finally {
      await f.repo.cleanup();
    }
  },
);

test('dry-run never creates slots or reads metadata (mutation: acquire or read slots in dry-run)', async () => {
  const f = await slotFixture();
  try {
    const slots = join(f.common, 'cq-review/slots');
    // A directory is invalid/unreadable metadata. Dry-run must not inspect it.
    await mkdir(join(slots, 'pr-7.json'), { recursive: true });
    const result = await runSelfReviewLoop(
      {
        gh: fakeGh([pullRow(7)], { stateRoutes: true }),
        git: async () => {
          throw new Error('dry-run touched checkout ownership');
        },
        nowMs: () => 1,
      },
      {
        owner: 'octo',
        repo: 'widget',
        responderLogin: null,
        repoRoot: f.repo.root,
        journalRoot: join(f.root, 'absent'),
        dryRun: true,
      },
    ).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    expect('value' in result, 'dry-run inspected unreadable ownership state').toBe(true);
    if (!('value' in result)) return;
    expect(result.value.wouldRun?.[0]).toContain('would-run');
    expect(await readdir(slots)).toEqual(['pr-7.json']);
    await expect(readdir(join(f.root, 'absent'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await f.repo.cleanup();
  }
});
