import { createHash } from 'node:crypto';
import { expect, test } from 'vitest';
import { join } from 'node:path';
import { readFile, writeFile, lstat, realpath } from 'node:fs/promises';
import { runReviewLoop } from '../../../src/plans/review-loop.js';
import {
  withAddressOwnership,
  runAddressReviewLoop,
} from '../../../src/ops/review/internal/addressCheckoutOwnership.js';
import { makeReviewAddress } from '../../../src/ops/review/address.js';
import type { DriverFactory } from '../../../src/driver/factory.js';
import { readSlotMetadata } from '../../../src/adapters/lock/slotLock.js';
import { fixture as localFixture, useGitleaksPath } from './address-local.helpers.js';
import { deferred, pausedLoop, reached, slotFixture } from './slotOwnership.helpers.js';

useGitleaksPath();
test('different PR checkouts progress while one writer is paused (mutation: select old common-dir owner)', async () => {
  const f = await slotFixture();
  const first = await pausedLoop(f.opts(7));
  try {
    const outcome = await runReviewLoop(f.opts(9)).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    expect('value' in outcome, 'independent PR must progress').toBe(true);
    if (!('value' in outcome)) return;
    const second = outcome.value;
    expect(second.status).toBe('ok');
    expect(second.worktree.path).not.toBe(first.path);
    expect((await readSlotMetadata(join(f.common, 'cq-review/slots/pr-7.json')))?.incomplete).toBe(
      true,
    );
    expect((await readSlotMetadata(join(f.common, 'cq-review/slots/pr-9.json')))?.incomplete).toBe(
      false,
    );
    first.release();
    expect((await first.pending).status).toBe('ok');
  } finally {
    first.release();
    await first.pending.catch(() => undefined);
    await f.repo.cleanup();
  }
});

test('local and direct PR address share actual checkout exclusion (mutation: bypass actual checkout slot)', async () => {
  const f = await localFixture();
  const gate = deferred(),
    entered = deferred();
  let pending: Promise<unknown> | undefined;
  try {
    const head = f.repo.git('rev-parse', 'HEAD').trim();
    f.repo.git('push', '-q', 'origin', `${head}:refs/pull/7/head`);
    f.repo.git('branch', '-m', 'cq-review/pr-7');
    const drivers: DriverFactory = {
      resolve(request) {
        const resolved = f.drivers.resolve(request);
        return {
          ...resolved,
          driver: {
            ...resolved.driver,
            run: async (input) => {
              if (
                input.outputSchema?.name === 'review.address.outcome/v1' &&
                !input.prompt.startsWith('related-check feedback')
              ) {
                entered.resolve();
                await gate.promise;
              }
              return resolved.driver.run(input);
            },
          },
        };
      },
    };
    pending = makeReviewAddress({
      drivers,
      initialRecord: { ...f.record, branch: 'cq-review/pr-7' },
    })({
      repoRoot: f.repo.root,
      source: 'local',
      journalDir: f.journalDir,
    });
    await reached(entered.promise, pending);
    const { makeGhRunner } = await import('../../../src/adapters/forge-github/gh.js');
    const { slotWorktreeRegistry } =
      await import('../../../src/adapters/git/slotWorktreeRegistry.js');
    const common = f.repo.git('rev-parse', '--path-format=absolute', '--git-common-dir').trim();
    const bookkeeping = new Map(
      await Promise.all(
        f.repo
          .git('ls-files', '--others', '-z')
          .split('\0')
          .filter(Boolean)
          .map(async (path) => [path, await readFile(join(f.repo.root, path), 'base64')] as const),
      ),
    );
    let resolved = false;
    const outcome = await runReviewLoop({
      owner: 'octo',
      repo: 'widget',
      pr: 7,
      headRefName: 'x',
      repoRoot: f.repo.root,
      worktreeRoot: join(f.repo.root, '..'),
      git: makeGhRunner({ bin: 'git' }),
      gh: async () => {
        throw new Error('forge must not dispatch');
      },
      registry: slotWorktreeRegistry(common),
      isBookkeepingPath: async (path) =>
        bookkeeping.has(path) &&
        bookkeeping.get(path) === (await readFile(join(f.repo.root, path), 'base64')),
      driver: { provider: 'mock', model: 'offline' },
      nowMs: 1,
      dispatchLogPath: join(f.journalDir, 'dispatch.jsonl'),
      onWorktreeResolved: async () => {
        resolved = true;
        throw new Error('overlap reached target');
      },
    }).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    expect(resolved, 'second invocation reached the owned checkout').toBe(false);
    expect('value' in outcome, 'settled checkout contention must return needs-human').toBe(true);
    if (!('value' in outcome)) return;
    expect(outcome.value.status).toBe('needs-human');
    const gitDir = await realpath(f.repo.git('rev-parse', '--absolute-git-dir').trim());
    const lock = join(
      common,
      'cq-review/slots',
      `checkout-${createHash('sha256').update(gitDir).digest('hex')}.lock`,
    );
    expect(outcome.value.reasons).toEqual([`Slot busy: ${lock}`]);
    expect((await readSlotMetadata(join(common, 'cq-review/slots/pr-7.json')))?.incomplete).toBe(
      false,
    );
    expect(await readFile(join(f.repo.root, 'src/a.ts'), 'utf8')).toContain('BAD');
  } finally {
    gate.resolve();
    await pending;
    await f.cleanup();
  }
});

test('two distinct worktrees progress (mutation: add source-repo checkout slot)', async () => {
  const f = await slotFixture();
  const configured = await localFixture();
  await f.repo.write('cq.json', await readFile(join(configured.repo.root, 'cq.json'), 'utf8'));
  await f.repo.write('scripts/check.cjs', 'process.exitCode = 0;\n');
  await f.repo.write('src/a.ts', 'export const a = "BAD";\n');
  f.repo.commitAll('configure source checkout');
  f.repo.git('push', '-q', 'origin', 'HEAD:refs/pull/7/head');
  const first = await pausedLoop(f.opts());
  try {
    const local = await makeReviewAddress({
      drivers: configured.drivers,
      initialRecord: {
        ...configured.record,
        head: f.repo.git('rev-parse', 'HEAD').trim(),
      },
    })({ repoRoot: f.repo.root, source: 'local', journalDir: join(f.root, 'source-journal') });
    expect(local.status, JSON.stringify(local)).toBe('ok');
    first.release();
    expect((await first.pending).status).toBe('ok');
  } finally {
    first.release();
    await first.pending.catch(() => undefined);
    await f.repo.cleanup();
    await configured.cleanup();
  }
});

test('missing coordination namespace is created before slot admission without replacing files (mutation: omit coordination mkdir)', async () => {
  const f = await slotFixture();
  const coordinationRoot = join(f.root, 'not-created', 'coordination');
  try {
    await expect(lstat(coordinationRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    const result = await withAddressOwnership(
      { repoRoot: f.repo.root, git: f.run, source: 'pr:7', production: true, coordinationRoot },
      (lease) => runAddressReviewLoop(lease, f.opts()),
    ).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    expect('value' in result, 'fresh coordination namespace must admit the run').toBe(true);
    if (!('value' in result)) return;
    expect(result.value.status).toBe('ok');
    expect(
      await readSlotMetadata(join(coordinationRoot, 'cq-review/slots/pr-7.json')),
    ).toMatchObject({
      state: 'bound',
      incomplete: false,
      checkoutPath: result.value.worktree.path,
    });
    const file = join(f.root, 'not-a-directory');
    await writeFile(file, 'preserved namespace obstruction');
    await expect(
      withAddressOwnership(
        {
          repoRoot: f.repo.root,
          git: f.run,
          source: 'pr:7',
          production: true,
          coordinationRoot: file,
        },
        async () => {},
      ),
    ).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(file, 'utf8')).toBe('preserved namespace obstruction');
  } finally {
    await f.repo.cleanup();
  }
});
