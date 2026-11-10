import { expect, test, vi } from 'vitest';
import { chmod, mkdir, readFile, readdir, writeFile, symlink, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  makeReviewAddressMany,
  type ReviewAddressManyInput,
} from '../../../src/ops/review/addressMany.js';
import { makeGhRunner } from '../../../src/adapters/forge-github/gh.js';
import { readSlotMetadata } from '../../../src/adapters/lock/slotLock.js';
import {
  withAddressOwnership,
  runAddressReviewLoop,
  noteAddressOpaqueInvocation,
  bindAddressTerminalReport,
  addressOrdinaryReport,
} from '../../../src/ops/review/internal/addressCheckoutOwnership.js';
import { slotWorktreeRegistry } from '../../../src/adapters/git/slotWorktreeRegistry.js';
import type { ReviewAddressInput } from '../../../src/ops/review/address.js';
import { terminalReport } from './addressManyWorktree.helpers.js';
import { slotFixture, deferred, reached } from './slotOwnership.helpers.js';

async function bulkFixture() {
  const f = await slotFixture();
  const bin = join(f.root, 'bin');
  await mkdir(bin);
  const ghPath = join(bin, 'gh');
  await writeFile(
    ghPath,
    `#!${process.execPath}\nconsole.log(JSON.stringify({nameWithOwner:'octo/widget'}));`,
  );
  await chmod(ghPath, 0o755);
  vi.stubEnv('PATH', bin + ':' + process.env.PATH);
  const input: ReviewAddressManyInput = {
    repoRoot: f.repo.root,
    repo: 'octo/widget',
    owner: 'octo',
    pulls: [7],
    maxTokens: 100,
    tokensPerPr: 50,
  };
  const roots: string[] = [];
  const gh = async (args: string[]) => ({
    code: 0,
    stderr: '',
    stdout: JSON.stringify(
      args[0] === 'repo'
        ? { nameWithOwner: 'octo/widget' }
        : {
            number: 7,
            state: 'open',
            merged: false,
            draft: false,
            base: { ref: 'main' },
            user: { login: 'octo', type: 'User' },
            head: {
              sha: f.prs[0].headRefOid,
              ref: 'feature/x',
              repo: { full_name: 'octo/widget' },
            },
          },
    ),
  });
  const child = async (input: ReviewAddressInput, pause?: () => Promise<void>, opaque = false) => {
    roots.push(input.repoRoot);
    const git = makeGhRunner({ bin: 'git' });
    const common = f.repo
      .git('-C', input.repoRoot, 'rev-parse', '--path-format=absolute', '--git-common-dir')
      .trim();
    const report = terminalReport(join(input.journalDir!, 'review-address-report.json'));
    report.source = 'pr:7';
    report.admissionHead = f.prs[0].headRefOid;
    try {
      await withAddressOwnership(
        {
          repoRoot: input.repoRoot,
          git,
          source: 'pr:7',
          production: true,
          coordinationRoot: f.common,
        },
        async (lease) => {
          await runAddressReviewLoop(lease, {
            ...f.opts(),
            repoRoot: input.repoRoot,
            git,
            registry: slotWorktreeRegistry(common),
            worktreeRoot: join(common, 'cq-review-worktrees'),
            dispatchLogPath: join(input.journalDir!, 'dispatch.jsonl'),
            onWorktreeResolved: async () => {
              await pause?.();
            },
          });
          if (opaque) noteAddressOpaqueInvocation(lease);
          await bindAddressTerminalReport(lease, report);
          await mkdir(input.journalDir!, { recursive: true });
          const bytes = JSON.stringify(report) + '\n';
          await writeFile(report.reportPath, bytes);
          await addressOrdinaryReport(lease, report.reportPath, bytes);
        },
      );
    } catch (error) {
      if (!opaque) throw error;
    }
    // A false clean result must never override the child's actual incomplete state.
    return { status: 'ok' as const, value: report };
  };
  return {
    ...f,
    input,
    roots,
    gh,
    child,
    async cleanup() {
      vi.unstubAllEnvs();
      await f.repo.cleanup();
    },
  };
}

test('same original PR refuses before second clone creation (mutation: install only clone slots)', async () => {
  const f = await bulkFixture(),
    entered = deferred(),
    release = deferred();
  const first = makeReviewAddressMany({
    gh: f.gh,
    address: (input) =>
      f.child(input, async () => {
        entered.resolve();
        await release.promise;
      }),
  })(f.input);
  try {
    await reached(entered.promise, first);
    const clones = await readdir(join(f.common, 'cq-address-many-clones'));
    const second = await makeReviewAddressMany({ gh: f.gh, address: (input) => f.child(input) })(
      f.input,
    );
    expect(second.status).toBe('failed');
    expect(JSON.stringify(second)).toContain('Slot busy');
    expect(await readdir(join(f.common, 'cq-address-many-clones'))).toEqual(clones);
    expect(f.roots).toHaveLength(1);
  } finally {
    release.resolve();
    await first;
    await f.cleanup();
  }
});

test('bulk admission preserves a legacy hint for direct reconciliation before dispatch', async () => {
  const f = await bulkFixture();
  try {
    const path = join(f.worktreeRoot, 'legacy-pr-7');
    f.repo.git('worktree', 'add', '-b', 'cq-review/pr-7', path, 'HEAD');
    const source = join(f.common, 'cq-review-address-worktrees.json');
    const bytes = JSON.stringify({ 7: { path, branch: 'cq-review/pr-7' } });
    await writeFile(source, bytes);
    const result = await makeReviewAddressMany({ gh: f.gh, address: (input) => f.child(input) })(
      f.input,
    );
    expect(result.status, JSON.stringify(result)).toBe('needs-human');
    expect(JSON.stringify(result)).toContain(
      'legacy review checkout requires direct reconciliation',
    );
    expect(f.roots).toEqual([]);
    expect(await readSlotMetadata(join(f.common, 'cq-review/slots/pr-7.json'))).toBeUndefined();
    expect(await readFile(source, 'utf8')).toBe(bytes);
    expect((await lstat(path)).isDirectory()).toBe(true);
    const { resolvePrWorktree } = await import('../../../src/adapters/git/prWorktree.js');
    const opts = f.opts();
    await expect(
      resolvePrWorktree({
        repoRoot: opts.repoRoot,
        pr: 7,
        headRefName: opts.headRefName,
        worktreeRoot: f.worktreeRoot,
        nowMs: 1,
        run: opts.git,
        registry: slotWorktreeRegistry(f.common, { legacySources: [source] }),
      }),
    ).rejects.toThrow(/identity or head mismatch/);
    expect((await lstat(path)).isDirectory()).toBe(true);
    expect(await readSlotMetadata(join(f.common, 'cq-review/slots/pr-7.json'))).toMatchObject({
      incomplete: true,
    });
    expect(await readFile(source, 'utf8')).toBe(bytes);
  } finally {
    await f.cleanup();
  }
});

test('incomplete no-fix clone is retained (mutation: drop incomplete cleanup guard)', async () => {
  const f = await bulkFixture();
  try {
    const result = await makeReviewAddressMany({
      gh: f.gh,
      address: (input) => f.child(input, undefined, true),
    })(f.input);
    expect(JSON.stringify(result)).toContain('incomplete clone retained');
    expect(await readFile(join(f.roots[0]!, 'README.md'), 'utf8')).toContain('fixture');
    expect((await readSlotMetadata(join(f.common, 'cq-review/slots/pr-7.json')))?.incomplete).toBe(
      true,
    );
  } finally {
    await f.cleanup();
  }
});

test('clean deleted clone leaves unbound complete slot (mutation: omit final unbound update)', async () => {
  const f = await bulkFixture();
  try {
    for (let round = 0; round < 2; round++) {
      const result = await makeReviewAddressMany({ gh: f.gh, address: (input) => f.child(input) })(
        f.input,
      );
      expect(await readSlotMetadata(join(f.common, 'cq-review/slots/pr-7.json'))).toEqual({
        version: 1,
        state: 'unbound',
        incomplete: false,
      });
      expect(result.status, JSON.stringify(result)).toBe('ok');
      expect(await readdir(join(f.common, 'cq-address-many-clones'))).toEqual([]);
    }
    expect(new Set(f.roots).size).toBe(2);
  } finally {
    await f.cleanup();
  }
});

test('bulk alias clone root cleanup leaves a reusable original slot (mutation: notify cleanup with raw alias)', async () => {
  const f = await bulkFixture();
  try {
    const directory = join(f.root, 'physical-clones'),
      alias = join(f.root, 'clone-alias');
    await mkdir(directory);
    await symlink(directory, alias, 'dir');
    for (let round = 0; round < 2; round++) {
      const result = await makeReviewAddressMany({ gh: f.gh, address: (input) => f.child(input) })({
        ...f.input,
        cloneRoot: alias,
      });
      expect(await readSlotMetadata(join(f.common, 'cq-review/slots/pr-7.json'))).toEqual({
        version: 1,
        state: 'unbound',
        incomplete: false,
      });
      expect(result.status, JSON.stringify(result)).toBe('ok');
      expect(await readdir(directory)).toEqual([]);
      await expect(lstat(f.roots[round]!)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  } finally {
    await f.cleanup();
  }
});
