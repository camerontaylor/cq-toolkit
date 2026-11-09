import { expect, test } from 'vitest';
import { readSlotMetadata } from '../../src/adapters/lock/slotLock.js';
import * as checkoutOwner from '../../src/ops/review/internal/addressCheckoutOwnership.js';
import { symlink, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { runReviewLoop } from '../../src/plans/review-loop.js';
import {
  withAddressOwnership,
  runAddressReviewLoop,
} from '../../src/ops/review/internal/addressCheckoutOwnership.js';
import { completeWorker, defaultWorld, fixLine, runLoop } from './review-loop.helpers.js';
import { slotFixture, pausedLoop, deferred, reached } from '../ops/review/slotOwnership.helpers.js';

test('standalone loop holds target checkout through final report (mutation: release checkout after worker close)', async () => {
  const entered = deferred(),
    release = deferred();
  let snapshots = 0,
    workerClosed = false;
  const gitLog: string[][] = [];
  const pending = runLoop(defaultWorld(), {
    gitLog,
    driverResults: [completeWorker(fixLine(false, 'needs human', []))],
    onSpend: () => {
      workerClosed = true;
    },
    ghHook: async (args, run) => {
      if (args[1] === 'repos/octo/widget/pulls/7' && ++snapshots === 2) {
        entered.resolve();
        await release.promise;
      }
      return run(args);
    },
  });
  try {
    await reached(entered.promise, pending);
    expect(workerClosed).toBe(true);
    const path = gitLog.find((args) => args[1]?.endsWith('pr-7-pr-7-fix'))![1]!;
    await expect(
      withAddressOwnership(
        {
          repoRoot: path,
          source: 'local',
          production: true,
          git: async (args) => ({
            code: 0,
            stderr: '',
            stdout: args.includes('--git-common-dir') ? dirname(path) : join(path, '.git'),
          }),
        },
        async () => {},
      ),
    ).rejects.toThrow(/busy/i);
  } finally {
    release.resolve();
    await pending;
  }
});

test.each(['alias', 'changed root and head'] as const)(
  'same PR %s refuses before fetch (mutation: key slot by raw root or headRefName)',
  async (kind) => {
    const f = await slotFixture();
    const first = await pausedLoop(f.opts());
    try {
      const alias = join(f.root, 'source-alias'),
        trees = join(f.root, 'tree-alias');
      await symlink(f.repo.root, alias, 'dir');
      await symlink(f.worktreeRoot, trees, 'dir');
      let fetch = false;
      await expect(
        runReviewLoop({
          ...f.opts(),
          repoRoot: alias,
          worktreeRoot: kind === 'alias' ? trees : join(f.root, 'changed-root'),
          headRefName: kind === 'alias' ? 'feature/x' : 'renamed',
          git: async (args) => {
            if (args.includes('fetch')) fetch = true;
            return f.run(args);
          },
        }),
      ).rejects.toThrow(/busy/i);
      expect(fetch).toBe(false);
    } finally {
      first.release();
      await first.pending;
      await f.repo.cleanup();
    }
  },
);

test('nested loop does not reacquire its live slot (regression)', async () => {
  const f = await slotFixture();
  let resolved = false;
  try {
    await withAddressOwnership(
      { repoRoot: f.repo.root, source: 'pr:7', git: f.run, production: true },
      async (lease) => {
        const opts = {
          ...f.opts(),
          onWorktreeResolved: async () => {
            resolved = true;
            await expect(runReviewLoop(f.opts())).rejects.toThrow('invalid loop permit');
          },
        };
        expect((await runAddressReviewLoop(lease, opts)).status).toBe('ok');
      },
    );
    expect(resolved).toBe(true);
  } finally {
    await f.repo.cleanup();
  }
});

test('head refusal preserves complete bound metadata and permits the next run (mutation: omit admission binding capture)', async () => {
  const f = await slotFixture();
  try {
    const first = await runReviewLoop(f.opts());
    expect(first.status).toBe('ok');
    const refusal = await runReviewLoop({ ...f.opts(), expectedHead: 'f'.repeat(40) }).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    expect('value' in refusal, 'early head refusal must retain needs-human result').toBe(true);
    if (!('value' in refusal)) return;
    expect(refusal.value.status).toBe('needs-human');
    expect(refusal.value.headRefused).toBe(true);
    expect(await readSlotMetadata(join(f.common, 'cq-review/slots/pr-7.json'))).toMatchObject({
      state: 'bound',
      checkoutPath: first.worktree.path,
      incomplete: false,
    });
    expect((await runReviewLoop(f.opts())).status).toBe('ok');
  } finally {
    await f.repo.cleanup();
  }
});

test('owner API removes the obsolete child-signal stub (mutation: restore undefined child-signal export)', () => {
  expect(checkoutOwner).not.toHaveProperty('addressChildSignal');
});

test.each(['fetch', 'identity', 'dirty'] as const)(
  'settled %s refusal is needs-human and leaves reusable slots (mutation: skip refusal classification)',
  async (kind) => {
    const f = await slotFixture();
    try {
      const first = kind === 'fetch' ? undefined : await runReviewLoop(f.opts());
      const source = first ? await readFile(join(first.worktree.path, 'README.md')) : undefined;
      if (kind === 'dirty') await writeFile(join(first!.worktree.path, 'README.md'), 'dirty bytes');
      const outcome = await runReviewLoop({
        ...f.opts(),
        git: (args) => {
          if (kind === 'fetch' && args.includes('fetch'))
            return f.run(['-C', f.repo.root, 'fetch', 'missing-fixture-remote']);
          if (kind === 'identity' && args.includes('--absolute-git-dir'))
            return f.run(['-C', f.repo.root, 'rev-parse', '--verify', 'missing-fixture-ref']);
          return f.run(args);
        },
      }).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      expect('value' in outcome, 'settled refusal must use needs-human surface').toBe(true);
      if (!('value' in outcome)) return;
      expect(outcome.value.status).toBe('needs-human');
      expect(
        (await readSlotMetadata(join(f.common, 'cq-review/slots/pr-7.json')))?.incomplete,
      ).toBe(false);
      if (kind === 'dirty') await writeFile(join(first!.worktree.path, 'README.md'), source!);
      expect((await runReviewLoop(f.opts())).status).toBe('ok');
    } finally {
      await f.repo.cleanup();
    }
  },
);
