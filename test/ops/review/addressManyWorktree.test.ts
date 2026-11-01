import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  link,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { makeGhRunner } from '../../../src/adapters/forge-github/gh.js';
import { fileWorktreeRegistry, resolvePrWorktree } from '../../../src/adapters/git/prWorktree.js';
import { makeTestRepo, type TestRepo } from '../dev/repo.js';
import * as addressModule from '../../../src/ops/review/address.js';
import { runReviewLoop, type ReviewLoopOpts } from '../../../src/plans/review-loop.js';
import type { OpRegistryEntry } from '../../../src/kernel/types.js';
import { FixReviewItemInputSchema } from '../../../src/ops/review/registry.js';
import {
  makeAddressOwnership,
  runAddressReviewLoop,
  withAddressOwnership,
} from '../../../src/ops/review/internal/addressOwnership.js';

import type { ReviewAddressReport } from '../../../src/ops/review/address.js';
import * as ownershipModule from '../../../src/ops/review/internal/addressOwnership.js';
import { OpResultArtifactSchema } from '../../../src/kernel/schema.js';
import { exitCodeForOpResult } from '../../../src/cli/exit.js';
import type { CqConfig } from '../../../src/ops/analyze/cqConfig.js';
import { createEscalationState } from '../../../src/ops/fix/escalation.js';

// Only fixed fixture Node programs replace the private terminal spawn. Ordinary
// Git and the existing offline harness keep their actual implementations.
const terminalProcessFaults = vi.hoisted(() => ({
  spawn: undefined as
    | undefined
    | ((
        command: string,
        args: readonly string[],
        options: SpawnOptions,
      ) => ChildProcess | undefined),
}));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (command: string, args: readonly string[], options: SpawnOptions) =>
      terminalProcessFaults.spawn?.(command, args, options) ?? actual.spawn(command, args, options),
  };
});

// Match this fixture's canonical executable/root and the complete private
// hardened prefix BEFORE consuming a fault. No ordinary runner matches it.
async function terminalFixtureSelector(repo: TestRepo) {
  const root = await realpath(repo.root),
    common = await realpath(join(root, '.git'));
  let executable: string | undefined;
  for (const entry of (process.env['PATH'] ?? '').split(':')) {
    if (!entry.startsWith('/')) continue;
    try {
      const candidate = await realpath(join(entry, 'git'));
      const stat = await lstat(candidate);
      if (!candidate.startsWith(root + '/') && stat.isFile() && stat.mode & 0o111) {
        executable = candidate;
        break;
      }
    } catch {
      /* Missing entries confer no fixture match. */
    }
  }
  if (!executable) throw new Error('fixture canonical Git unavailable');
  let config: string | undefined;
  const stages = { selected: 0, handled: 0, closes: 0, stdout: 0, stderr: 0 };
  const select = (command: string, args: readonly string[], options: SpawnOptions) => {
    const observed = options.env?.['GIT_CONFIG_GLOBAL'];
    if (
      command !== executable ||
      options.cwd !== root ||
      typeof observed !== 'string' ||
      dirname(dirname(observed)) !== common ||
      !dirname(observed).startsWith(join(common, 'cq-address-terminal-')) ||
      observed !== join(dirname(observed), 'empty-config') ||
      options.env?.['GIT_CONFIG_SYSTEM'] !== observed ||
      options.env?.['HOME'] !== dirname(observed) ||
      options.env?.['GIT_CONFIG_NOSYSTEM'] !== '1'
    )
      return;
    const prefix = [
      '--no-pager',
      '--literal-pathspecs',
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.quotePath=true',
      ...[
        'core.hooksPath=' + join(dirname(observed), 'empty-hooks'),
        'core.attributesFile=' + observed,
        'core.untrackedCache=false',
        'credential.helper=',
        'core.askPass=',
        'gc.auto=0',
        'maintenance.auto=false',
        'protocol.allow=never',
        'commit.gpgSign=false',
        'tag.gpgSign=false',
      ].flatMap((value) => ['-c', value]),
    ];
    if (
      JSON.stringify(args.slice(0, prefix.length)) !== JSON.stringify(prefix) ||
      (config && config !== observed)
    )
      return;
    config ??= observed;
    stages.selected++;
    return args.slice(prefix.length);
  };
  return { select, stages };
}

// Only immutable readonly Git outputs from THIS actual repo may be replayed in
// the count fixtures. All filesystem/path/hash/authority checks remain real.
function terminalReadonlyResponses(repo: TestRepo) {
  const head = repo.git('rev-parse', 'HEAD').trim();
  const entry = repo.git('ls-files', '--stage', '-z', '--', 'src/a.ts');
  const blob = /^(?:100644|100755) ([a-f0-9]{40,64}) 0\t/.exec(entry)?.[1];
  if (!blob) throw new Error('fixture actual baseline index unavailable');
  const commands = [
    ['rev-parse', '--absolute-git-dir'],
    ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    ['rev-parse', 'HEAD'],
    ['symbolic-ref', 'HEAD'],
    ['ls-files', '--stage', '-z', '--', 'src/a.ts'],
    ['cat-file', 'blob', `${head}:src/a.ts`],
    ['cat-file', 'blob', blob],
  ];
  return new Map(commands.map((args) => [JSON.stringify(args), repo.git(...args)]));
}

// Filesystem fault gates are test-only. Every unaffected operation is real.
const fsFaults = vi.hoisted(() => ({
  effect: undefined as undefined | (() => void),
  link: undefined as
    | undefined
    | ((phase: 'before' | 'after', source: string, destination: string) => Promise<void>),
  open: undefined as
    | undefined
    | ((path: string, flags: string | number | undefined) => Promise<void>),
  sync: undefined as undefined | ((path: string) => Promise<void>),
  write: undefined as undefined | ((path: string) => Promise<void>),
  close: undefined as undefined | ((path: string) => Promise<void>),
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    mkdir: async (...args: Parameters<typeof actual.mkdir>) => {
      fsFaults.effect?.();
      return actual.mkdir(...args);
    },
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      fsFaults.effect?.();
      return actual.writeFile(...args);
    },
    link: async (...args: Parameters<typeof actual.link>) => {
      fsFaults.effect?.();
      await fsFaults.link?.('before', String(args[0]), String(args[1]));
      await actual.link(...args);
      await fsFaults.link?.('after', String(args[0]), String(args[1]));
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      fsFaults.effect?.();
      await fsFaults.open?.(String(args[0]), args[1]);
      const file = await actual.open(...args);
      const write = file.writeFile.bind(file),
        close = file.close.bind(file);
      file.writeFile = async (...input: Parameters<typeof file.writeFile>) => {
        await write(...input);
        await fsFaults.write?.(String(args[0]));
      };
      file.close = async () => {
        await close();
        await fsFaults.close?.(String(args[0]));
      };
      const sync = file.sync.bind(file);
      file.sync = async () => {
        fsFaults.effect?.();
        await fsFaults.sync?.(String(args[0]));
        await sync();
      };
      return file;
    },
  };
});

const mutexFaults = vi.hoisted(() => ({
  afterRelease: undefined as undefined | (() => Promise<void>),
  compromise: false,
  releaseFailed: undefined as undefined | (() => void),
}));
vi.mock('proper-lockfile', async (importOriginal) => {
  const actual = await importOriginal<typeof import('proper-lockfile')>();
  return {
    ...actual,
    lock: async (...args: Parameters<typeof actual.lock>) => {
      const release = await actual.lock(...args);
      return async () => {
        const governed = args[0].endsWith('/cq-review-address-ownership');
        try {
          await release();
        } catch (error) {
          if (governed) mutexFaults.releaseFailed?.();
          throw error;
        }
        if (!governed) return;
        if (mutexFaults.compromise)
          args[1]?.onCompromised?.(new Error('observed compromise fixture'));
        await mutexFaults.afterRelease?.();
      };
    },
  };
});

const authorityStore = (guardPath: string) =>
  join(dirname(guardPath), 'cq-review-address-ownership.store');
async function authorityState(guardPath: string): Promise<{ state: string; epoch: string }> {
  const anchor = JSON.parse(await readFile(guardPath, 'utf8')) as {
    version: number;
    state: string;
    epoch: string;
  };
  if (anchor.version !== 3) return anchor; // Deliberately foreign damage fixture.
  const store = authorityStore(guardPath);
  const names = (await readdir(store)).filter((name) => /^[0-9]{6}\.json$/.test(name)).sort();
  return JSON.parse(await readFile(join(store, names.at(-1)!), 'utf8')) as {
    state: string;
    epoch: string;
  };
}

const NOW = 1_793_145_600_000;

async function fixture() {
  const repo = await makeTestRepo();
  try {
    const first = repo.git('rev-parse', 'HEAD').trim();
    await repo.write('src/sibling.ts', 'export const sibling = 2;\n');
    const second = repo.commitAll('second PR head');
    repo.git('push', '-q', 'origin', `${first}:refs/pull/7/head`, `${second}:refs/pull/9/head`);
    const root = dirname(repo.root);
    const registryPath = join(root, 'worktrees.json');
    const worktreeRoot = join(root, 'review');
    const run = makeGhRunner({
      bin: 'git',
      cwd: repo.root,
      env: { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_ALLOW_PROTOCOL: 'file' },
    });
    // Scripted forge metadata only; the local bare origin supplies actual Git truth.
    const prs = [
      { number: 7, headRefName: 'feature/x', headRefOid: first },
      { number: 9, headRefName: 'feature/x', headRefOid: second },
    ] as const;
    const resolve = (pr: (typeof prs)[number]) =>
      resolvePrWorktree({
        repoRoot: repo.root,
        pr: pr.number,
        headRefName: pr.headRefName,
        run,
        // Separate handles share the real file lock and persistence boundary.
        registry: fileWorktreeRegistry(registryPath),
        worktreeRoot,
        nowMs: NOW + pr.number,
      });
    return { repo, prs, resolve, registryPath, root, run, worktreeRoot };
  } catch (error) {
    await repo.cleanup();
    throw error;
  }
}

async function checkoutSnapshot(repo: TestRepo, path: string) {
  return {
    head: repo.git('-C', path, 'rev-parse', 'HEAD'),
    branch: repo.git('-C', path, 'symbolic-ref', 'HEAD'),
    status: repo.git('-C', path, 'status', '--porcelain=v1', '--untracked-files=all'),
    staged: repo.git('-C', path, 'diff', '--cached', '--binary'),
    unstaged: repo.git('-C', path, 'diff', '--binary'),
    untracked: await readFile(join(path, 'private-note.txt'), 'utf8'),
  };
}

test('concurrent PRs sharing a head ref retain distinct exact-head worktrees and both registry entries', async () => {
  const f = await fixture();
  try {
    const results = await Promise.all(f.prs.map(f.resolve));
    expect(new Set(await Promise.all(results.map((result) => realpath(result.path)))).size).toBe(2);
    expect(new Set(results.map((result) => result.branch)).size).toBe(2);
    const entries = await fileWorktreeRegistry(f.registryPath).load();
    expect(Object.keys(entries).sort()).toEqual(['7', '9']);
    for (const [index, pr] of f.prs.entries()) {
      const result = results[index]!;
      expect(result.reused).toBe(false);
      expect(f.repo.git('-C', result.path, 'rev-parse', 'HEAD').trim()).toBe(pr.headRefOid);
      expect(f.repo.git('-C', result.path, 'symbolic-ref', 'HEAD').trim()).toBe(
        `refs/heads/${result.branch}`,
      );
      expect(entries[String(pr.number)]).toEqual({
        path: result.path,
        branch: result.branch,
        createdAt: NOW + pr.number,
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

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('direct loop owns lifetime; only a live private bridge reenters and inherited callbacks cannot replay', async () => {
  for (const viaAddress of [false, true]) {
    const f = await fixture();
    try {
      const owner = await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run });
      let stale: (() => Promise<unknown>) | undefined;
      let visited = false;
      const opts: ReviewLoopOpts = {
        owner: 'fixture',
        repo: 'base',
        pr: 7,
        headRefName: 'feature/x',
        repoRoot: f.repo.root,
        git: f.run,
        gh: async () => {
          throw new Error('forge must not dispatch');
        },
        registry: fileWorktreeRegistry(f.registryPath),
        driver: { provider: 'test', model: 'test' },
        nowMs: NOW,
        dispatchLogPath: join(f.root, 'dispatch.jsonl'),
        beforeWorktreeResolve: async () => {
          visited = true;
          await expect(runReviewLoop(opts)).rejects.toThrow(/consumed|active or quarantined/);
          await expect(
            withAddressOwnership(
              { repoRoot: f.repo.root, git: f.run, source: 'local', production: false },
              async () => undefined,
            ),
          ).rejects.toThrow('active or quarantined');
          throw new Error('stop before mutable resolution');
        },
      };
      if (viaAddress) {
        await expect(
          owner.withLock(async () => {
            const lease = owner.lease();
            stale = () => runAddressReviewLoop(lease, opts);
            await expect(runAddressReviewLoop({ ...lease }, opts)).rejects.toThrow(
              'forged loop lease',
            );
            await expect(runReviewLoop(opts)).rejects.toThrow('active or quarantined');
            return runAddressReviewLoop(lease, opts);
          }),
        ).rejects.toThrow('stop before mutable resolution');
        await expect(stale!()).rejects.toThrow(/owner inactive|admissions closed/);
        await expect(owner.withLock(async () => undefined)).rejects.toThrow(
          'lifetime already consumed',
        );
      } else {
        await expect(runReviewLoop(opts)).rejects.toThrow('stop before mutable resolution');
      }
      expect(visited).toBe(true);
      expect((await authorityState(owner.guardPath)).state).toBe('quarantined');
    } finally {
      await f.repo.cleanup();
    }
  }
});

test.each(['detach', 'parent-abort', 'parent-and-owner-loss'] as const)(
  'actual registry fixer lifetime: %s',
  async (mode) => {
    const f = await fixture();
    const release = deferred(),
      finished = deferred(),
      entered = deferred();
    const parent = new AbortController();
    let postAbortCommands = 0;
    let started = false;
    let checkout = '';
    const head = f.prs[0].headRefOid;
    const opts: ReviewLoopOpts = {
      owner: 'fixture',
      repo: 'base',
      pr: 7,
      headRefName: 'feature/x',
      repoRoot: f.repo.root,
      git: (args) => {
        if (parent.signal.aborted) postAbortCommands++;
        return f.run(args);
      },
      gh: async (args) => {
        if (parent.signal.aborted) postAbortCommands++;
        const json = (value: unknown) => ({ code: 0, stdout: JSON.stringify(value), stderr: '' });
        if (args.includes('graphql')) {
          const snapshot = args.some(
            (arg) => arg.startsWith('query=') && arg.includes('threadsCursor'),
          );
          const pageInfo = { hasNextPage: false, endCursor: null };
          return json({
            data: {
              repository: {
                pullRequest: {
                  author: { login: 'author' },
                  headRefName: 'feature/x',
                  headRefOid: head,
                  reviewThreads: {
                    pageInfo,
                    nodes: snapshot
                      ? []
                      : [
                          {
                            id: 'T1',
                            isResolved: false,
                            isOutdated: false,
                            path: 'src/a.ts',
                            line: 1,
                            comments: {
                              nodes: [
                                {
                                  databaseId: 101,
                                  author: { login: 'reviewer' },
                                  body: 'Fix src/a.ts.',
                                  createdAt: new Date(NOW - 60_000).toISOString(),
                                },
                              ],
                            },
                          },
                        ],
                  },
                  reviews: { pageInfo, nodes: [] },
                },
              },
            },
          });
        }
        if (args.includes('repos/fixture/base/pulls/7')) return json({ head: { sha: head } });
        if (args.some((arg) => arg.startsWith('repos/fixture/base/'))) return json([]);
        throw new Error('unexpected scripted forge call');
      },
      registry: fileWorktreeRegistry(f.registryPath),
      driver: { provider: 'test', model: 'test' },
      driverRegistryView: {
        get: (name) =>
          name === 'review.fixItem'
            ? ({
                name,
                inputSchema: FixReviewItemInputSchema,
                importer: async () => async () => {
                  started = true;
                  entered.resolve();
                  try {
                    await release.promise;
                    // Deliberately uncooperative in-process implementation: the outer
                    // killed report cannot prove this actual promise stopped writing.
                    if (mode === 'detach')
                      await writeFile(join(checkout, 'late-write.txt'), 'survivor edit\n');
                    return { status: 'needs-human', reason: 'late actual operation settled' };
                  } finally {
                    finished.resolve();
                  }
                },
              } as unknown as OpRegistryEntry<never, never>)
            : undefined,
      },
      ...(mode === 'detach' ? { limits: { perJobWallClockMs: 1 } } : {}),
      signal: parent.signal,
      allowAdvisoryBudget: true,
      publish: false,
      nowMs: NOW,
      dispatchLogPath: join(f.root, 'dispatch-detached.jsonl'),
      worktreeRoot: f.worktreeRoot,
      onWorktreeResolved: async (info) => {
        checkout = info.path;
      },
    };
    try {
      const pending = runReviewLoop(opts);
      if (mode !== 'detach') {
        await entered.promise;
        if (mode === 'parent-and-owner-loss') {
          const owner = await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run });
          await writeFile(
            owner.guardPath,
            JSON.stringify({ version: 1, epoch: 'foreign', state: 'active', resources: [] }),
          );
        }
        parent.abort();
        release.resolve();
        if (mode === 'parent-and-owner-loss') {
          await expect(pending).rejects.toThrow(/lost owner|owner inactive/);
          await expect(
            runReviewLoop({ ...opts, git: f.run, signal: new AbortController().signal }),
          ).rejects.toThrow('active or quarantined');
        } else {
          const outcome = await pending;
          expect(outcome.status).toBe('needs-human');
          expect(outcome.reasons.join(' ')).toContain('parent cancelled');
          expect(outcome.fixReport).toBeDefined();
          expect(outcome.actionsPosted).toBe(0);
          expect(outcome.verify).toBeUndefined();
          expect(outcome.reply).toBeUndefined();
          await withAddressOwnership(
            { repoRoot: f.repo.root, git: f.run, source: 'local', production: false },
            async (lease) => lease.assertOwned(),
          );
        }
        expect(postAbortCommands).toBe(0);
        return;
      }
      await expect(pending).rejects.toThrow('detached work requires quarantine');
      expect(started).toBe(true);
      await expect(runReviewLoop(opts)).rejects.toThrow('active or quarantined');
      release.resolve();
      await finished.promise;
      expect(await readFile(join(checkout, 'late-write.txt'), 'utf8')).toBe('survivor edit\n');
      await expect(runReviewLoop(opts)).rejects.toThrow('active or quarantined');
    } finally {
      release.resolve();
      if (started) await finished.promise;
      await f.repo.cleanup();
    }
  },
);

test('concurrent production child reentry consumes its private permit before identity awaits', async () => {
  const f = await fixture();
  let admitted = 0;
  const factory = vi
    .spyOn(addressModule, 'makeReviewAddress')
    .mockImplementation(() => async (input) => {
      const options = {
        repoRoot: input.repoRoot,
        git: f.run,
        source: input.source,
        production: true,
      };
      const first = withAddressOwnership(options, async () => {
        admitted++;
        return { status: 'needs-human' as const, reason: 'private permit fixture' };
      });
      await expect(
        withAddressOwnership(options, async () => {
          admitted++;
          throw new Error('replayed child entered');
        }),
      ).rejects.toThrow('invalid production child permit');
      return first;
    });
  try {
    const owner = await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run });
    await owner.withLock(async () =>
      owner.address(
        { pr: 7, head: f.prs[0].headRefOid, headRepo: 'fixture/base', headRefName: 'feature/x' },
        { repoRoot: f.repo.root, source: 'pr:7' },
      ),
    );
    expect(admitted).toBe(1);
  } finally {
    factory.mockRestore();
    await f.repo.cleanup();
  }
});

test('unawaited admission is registered before asynchronous ownership validation', async () => {
  const f = await fixture();
  let task: Promise<unknown> | undefined;
  try {
    const owner = await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run });
    await expect(
      owner.withLock(async () => {
        task = owner.lease().track(async () => undefined);
      }),
    ).rejects.toThrow('detached work requires quarantine');
    await task?.catch(() => undefined);
    expect((await authorityState(owner.guardPath)).state).toBe('quarantined');
    await expect(
      (await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run })).withLock(
        async () => undefined,
      ),
    ).rejects.toThrow('active or quarantined');
  } finally {
    await f.repo.cleanup();
  }
});

test('lifetime owner excludes linked, symlinked and injected callers through edits and commit', async () => {
  const f = await fixture();
  try {
    const linked = await f.resolve(f.prs[0]);
    const alias = join(f.root, 'checkout-alias');
    await symlink(linked.path, alias, 'dir');
    const owner = await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run });
    await owner.withLock(async () => {
      for (const repoRoot of [f.repo.root, linked.path, alias]) {
        let entered = false;
        await expect(
          withAddressOwnership(
            {
              repoRoot,
              git: f.run,
              source: 'local',
              production: false,
            },
            async () => {
              entered = true;
            },
          ),
        ).rejects.toThrow(/active|quarantined/);
        expect(entered).toBe(false);
      }
      await writeFile(join(linked.path, 'README.md'), 'owned edit\n');
      f.repo.git('-C', linked.path, 'add', '--', 'README.md');
      f.repo.git('-C', linked.path, 'commit', '-q', '-m', 'owned commit');
      await owner.assertOwned();
    });
    // A clean settle permits a fresh owner, including through an alias.
    await withAddressOwnership(
      {
        repoRoot: alias,
        git: f.run,
        source: 'local',
        production: false,
      },
      async (lease) => {
        await lease.assertOwned();
      },
    );
  } finally {
    await f.repo.cleanup();
  }
});

test('expected fetched-head fence preserves dirty stale checkout and registry byte for byte', async () => {
  const f = await fixture();
  try {
    const checkout = await f.resolve(f.prs[0]);
    await writeFile(join(checkout.path, 'README.md'), 'private stale edit\n');
    const before = await readFile(f.registryPath, 'utf8');
    f.repo.git('push', '-q', 'origin', `${f.prs[1].headRefOid}:refs/pull/7/head`);
    await expect(
      resolvePrWorktree({
        repoRoot: f.repo.root,
        pr: 7,
        headRefName: 'feature/x',
        expectedHead: f.prs[0].headRefOid,
        run: f.run,
        registry: fileWorktreeRegistry(f.registryPath),
        worktreeRoot: f.worktreeRoot,
        nowMs: NOW,
      }),
    ).rejects.toThrow('changed since admission');
    expect(await readFile(f.registryPath, 'utf8')).toBe(before);
    expect(await readFile(join(checkout.path, 'README.md'), 'utf8')).toBe('private stale edit\n');
    expect(f.repo.git('-C', checkout.path, 'rev-parse', 'HEAD').trim()).toBe(f.prs[0].headRefOid);
  } finally {
    await f.repo.cleanup();
  }
});

test('private production child harness overlaps distinct lanes and refuses remote and branch aliases', async () => {
  const f = await fixture();
  const entered = deferred(),
    release = deferred();
  let active = 0,
    maximum = 0,
    started = 0;
  // Explicit contract harness replaces ONLY the production factory. No runtime
  // caller dependency, skipLock flag or serialized permit is accepted.
  const factory = vi.spyOn(addressModule, 'makeReviewAddress').mockImplementation(
    () => async (input) =>
      withAddressOwnership(
        {
          repoRoot: input.repoRoot,
          git: f.run,
          source: input.source,
          production: true,
        },
        async (lease) => {
          const pr = f.prs.find((item) => input.source === `pr:${item.number}`)!;
          await expect(
            withAddressOwnership(
              {
                repoRoot: input.repoRoot,
                git: f.run,
                source: input.source,
                production: false,
              },
              async () => undefined,
            ),
          ).rejects.toThrow('invalid production child permit');
          await lease.assertSelection({
            pr: pr.number,
            headRepo: `fixture/fork${pr.number}`,
            headRefName: 'feature/x',
          });
          const worktree = await resolvePrWorktree({
            repoRoot: input.repoRoot,
            pr: pr.number,
            headRefName: 'feature/x',
            expectedHead: lease.expectedHead!,
            run: f.run,
            registry: lease.registry!,
            nowMs: NOW,
            worktreeRoot: f.worktreeRoot,
          });
          await lease.claimCheckout({ ...worktree, head: pr.headRefOid });
          return lease.track(async () => {
            active++;
            started++;
            maximum = Math.max(maximum, active);
            if (started === 2) entered.resolve();
            await release.promise;
            await lease.assertOwned();
            await writeFile(join(worktree.path, 'README.md'), `PR ${pr.number} owned edit\n`);
            f.repo.git('-C', worktree.path, 'add', '--', 'README.md');
            f.repo.git('-C', worktree.path, 'commit', '-q', '-m', `PR ${pr.number} owned commit`);
            active--;
            return { status: 'needs-human', reason: 'contract harness settled' };
          });
        },
      ),
  );
  try {
    const owner = await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run });
    await owner.withLock(async () => {
      const selections = f.prs.map((pr) => ({
        pr: pr.number,
        head: pr.headRefOid,
        headRepo: `fixture/fork${pr.number}`,
        headRefName: 'feature/x',
      }));
      const work = selections.map((selection) =>
        owner.address(selection, {
          repoRoot: f.repo.root,
          source: `pr:${selection.pr}`,
        }),
      );
      await entered.promise;
      expect(maximum).toBe(2);
      await expect(
        owner.address(
          { ...selections[0]!, pr: 11 },
          {
            repoRoot: f.repo.root,
            source: 'pr:11',
          },
        ),
      ).rejects.toThrow('conflicting child resource');
      await expect(
        owner.address(
          { ...selections[0]!, headRepo: 'fixture/other', headRefName: 'other' },
          {
            repoRoot: f.repo.root,
            source: 'pr:7',
          },
        ),
      ).rejects.toThrow('conflicting child resource');
      expect(factory).toHaveBeenCalledTimes(2);
      release.resolve();
      await Promise.all(work);
    });
    expect(active).toBe(0);
  } finally {
    release.resolve();
    factory.mockRestore();
    await f.repo.cleanup();
  }
});

test('abandoned inner work quarantines immediately and later settlement cannot reclaim ownership', async () => {
  const f = await fixture();
  const started = deferred(),
    release = deferred();
  let inner!: Promise<void>;
  try {
    const owner = await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run });
    await expect(
      owner.withLock(async () => {
        inner = owner.lease().track(async () => {
          started.resolve();
          await release.promise;
          // Models an uncooperative survivor making a late direct filesystem edit.
          await f.repo.write('late.txt', 'late survivor\n');
        });
        await started.promise;
        // Models the governor returning while the actual implementation survives.
      }),
    ).rejects.toThrow('detached work requires quarantine');
    expect((await authorityState(owner.guardPath)).state).toBe('quarantined');
    const contender = await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run });
    await expect(contender.withLock(async () => undefined)).rejects.toThrow('attended recovery');
    release.resolve();
    await inner;
    expect(await readFile(join(f.repo.root, 'late.txt'), 'utf8')).toBe('late survivor\n');
    await expect(contender.withLock(async () => undefined)).rejects.toThrow('attended recovery');
  } finally {
    release.resolve();
    await inner;
    await f.repo.cleanup();
  }
});

test.each(['abort', 'guard', 'guard-abort'] as const)(
  'parent abort and replaced ownership guard refuse subsequent tracked mutations: %s',
  async (fault) => {
    const f = await fixture();
    try {
      const parent = new AbortController();
      const owner = await makeAddressOwnership({
        repoRoot: f.repo.root,
        git: f.run,
        signal: parent.signal,
      });
      let mutations = 0;
      await expect(
        owner.withLock(async () => {
          if (fault === 'abort') parent.abort(new Error('parent fixture cancelled'));
          else
            await writeFile(
              owner.guardPath,
              JSON.stringify({ version: 1, epoch: 'foreign', state: 'active', resources: [] }),
            );
          if (fault === 'guard-abort') parent.abort(new Error('parent fixture cancelled'));
          await owner.lease().track(async () => {
            mutations++;
          });
        }),
      ).rejects.toThrow(/parent fixture cancelled|lost owner/);
      expect(mutations).toBe(0);
      const guard = await authorityState(owner.guardPath);
      expect(guard.state).toBe(fault === 'abort' ? 'quarantined' : 'active');
      if (fault !== 'abort') expect(guard.epoch).toBe('foreign');
      const contender = await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run });
      await expect(contender.withLock(async () => undefined)).rejects.toThrow('attended recovery');
    } finally {
      await f.repo.cleanup();
    }
  },
);

const FOREIGN_GUARD = '{"version":1,"epoch":"foreign","state":"active","resources":[]}\n';
async function damageGuard(guardPath: string, damage: 'replace' | 'remove' | 'rewrite') {
  if (damage === 'remove') await unlink(guardPath);
  else if (damage === 'rewrite') await writeFile(guardPath, FOREIGN_GUARD);
  else {
    const foreign = `${guardPath}.foreign`;
    await writeFile(foreign, FOREIGN_GUARD);
    await rename(foreign, guardPath);
  }
}
async function preservedDamage(guardPath: string, damage: 'replace' | 'remove' | 'rewrite') {
  if (damage === 'remove') await expect(lstat(guardPath)).rejects.toMatchObject({ code: 'ENOENT' });
  else expect(await readFile(guardPath, 'utf8')).toBe(FOREIGN_GUARD);
}
function errorChain(error: unknown): string {
  const messages: string[] = [];
  for (let current = error; current instanceof Error; current = current.cause)
    messages.push(current.message);
  return messages.join(' / ');
}

for (const transition of ['activation', 'child', 'checkout', 'settlement', 'quarantine'] as const) {
  for (const phase of ['before', 'after'] as const) {
    test.each(['replace', 'remove', 'rewrite'] as const)(
      `immutable ${transition} ${phase}-link damage: %s`,
      async (damage) => {
        const f = await fixture();
        const reached = deferred(),
          release = deferred();
        let damaged = false,
          dispatchAfterDamage = 0,
          completed = false,
          rootEntered = false;
        const owner = await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run });
        const checkout = await f.resolve(f.prs[0]);
        const sequence = { activation: 1, child: 2, checkout: 3, settlement: 4, quarantine: 4 }[
          transition
        ];
        const target = join(
          authorityStore(owner.guardPath),
          `${String(sequence).padStart(6, '0')}.json`,
        );
        const factory = vi.spyOn(addressModule, 'makeReviewAddress').mockImplementation(
          () => async (input) =>
            withAddressOwnership(
              { repoRoot: input.repoRoot, git: f.run, source: input.source, production: true },
              async (lease) => {
                await lease.claimCheckout({ ...checkout, head: f.prs[0].headRefOid });
                return lease.track(async () => {
                  if (damaged) dispatchAfterDamage++;
                  return { status: 'needs-human', reason: 'immutable transition fixture' };
                });
              },
            ),
        );
        fsFaults.link = async (when, _source, destination) => {
          if (when === phase && destination === target) {
            reached.resolve();
            await release.promise;
          }
        };
        let pending: Promise<unknown> | undefined;
        try {
          pending = owner
            .withLock(async () => {
              rootEntered = true;
              await owner.address(
                {
                  pr: 7,
                  head: f.prs[0].headRefOid,
                  headRepo: 'fixture/base',
                  headRefName: 'feature/x',
                },
                { repoRoot: f.repo.root, source: 'pr:7' },
              );
              if (transition === 'quarantine') throw new Error('quarantine fixture failure');
            })
            .then(() => {
              completed = true;
            });
          void pending.catch(() => undefined);
          await reached.promise;
          await damageGuard(owner.guardPath, damage);
          damaged = true;
          release.resolve();
          await expect(pending).rejects.toThrow(
            transition === 'quarantine'
              ? 'quarantine fixture failure'
              : /lost owner|active or quarantined|completion staging changed/,
          );
          expect(completed).toBe(false);
          expect(dispatchAfterDamage).toBe(0);
          if (transition === 'activation') expect(rootEntered).toBe(false);
          await preservedDamage(owner.guardPath, damage);
          await expect(async () =>
            owner.lease().track(async () => {
              dispatchAfterDamage++;
            }),
          ).rejects.toThrow(/inactive|lost owner/);
          const contender = await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run });
          await expect(
            contender.withLock(async () => {
              dispatchAfterDamage++;
            }),
          ).rejects.toThrow('attended recovery');
          expect(dispatchAfterDamage).toBe(0);
          await preservedDamage(owner.guardPath, damage);
        } finally {
          release.resolve();
          await pending?.catch(() => undefined);
          fsFaults.link = undefined;
          factory.mockRestore();
          await f.repo.cleanup();
        }
      },
    );
  }
}

for (const phase of ['before-head', 'after-head'] as const) {
  test.each(['replace', 'remove'] as const)(
    `last checkout identity ${phase}: %s`,
    async (damage) => {
      const f = await fixture();
      const checkout = await f.resolve(f.prs[0]);
      const reached = deferred(),
        release = deferred();
      let dispatched = 0;
      const git: typeof f.run = async (args) => {
        if (args[1] === checkout.path && args.slice(2).join(' ') === 'rev-parse HEAD') {
          const result = phase === 'after-head' ? await f.run(args) : undefined;
          reached.resolve();
          await release.promise;
          return result ?? f.run(args);
        }
        return f.run(args);
      };
      const owner = await makeAddressOwnership({ repoRoot: f.repo.root, git });
      const factory = vi.spyOn(addressModule, 'makeReviewAddress').mockImplementation(
        () => async (input) =>
          withAddressOwnership(
            { repoRoot: input.repoRoot, git, source: input.source, production: true },
            async (lease) => {
              await lease.claimCheckout({ ...checkout, head: f.prs[0].headRefOid });
              return lease.track(async () => {
                dispatched++;
                return { status: 'needs-human', reason: 'identity fixture' };
              });
            },
          ),
      );
      const pending = owner.withLock(async () =>
        owner.address(
          { pr: 7, head: f.prs[0].headRefOid, headRepo: 'fixture/base', headRefName: 'feature/x' },
          { repoRoot: f.repo.root, source: 'pr:7' },
        ),
      );
      void pending.catch(() => undefined);
      try {
        await reached.promise;
        await damageGuard(owner.guardPath, damage);
        release.resolve();
        await expect(pending).rejects.toThrow('lost owner');
        expect(dispatched).toBe(0);
        await preservedDamage(owner.guardPath, damage);
        await expect(
          (await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run })).withLock(
            async () => undefined,
          ),
        ).rejects.toThrow('attended recovery');
      } finally {
        release.resolve();
        await pending.catch(() => undefined);
        factory.mockRestore();
        await f.repo.cleanup();
      }
    },
  );
}

test.each(['foreground', 'timer', 'parent-abort'] as const)(
  'first physical compromise remains the same error: %s',
  async (mode) => {
    const f = await fixture(),
      parent = new AbortController();
    const owner = await makeAddressOwnership({
      repoRoot: f.repo.root,
      git: f.run,
      signal: parent.signal,
    });
    const actualInterval = globalThis.setInterval;
    let tick: (() => void) | undefined, first: unknown;
    const timer = vi.spyOn(globalThis, 'setInterval').mockImplementation(((
      callback: () => void,
      delay?: number,
    ) => {
      if (delay === 250) {
        tick = callback;
        return actualInterval(() => undefined, delay);
      }
      return actualInterval(callback, delay);
    }) as typeof setInterval);
    try {
      const pending = owner.withLock(async () => {
        await damageGuard(owner.guardPath, 'replace');
        if (mode !== 'foreground') tick!();
        first = await owner.assertOwned().then(
          () => undefined,
          (error: unknown) => error,
        );
        expect(first).toBeInstanceOf(Error);
        expect((first as Error).message).toContain('lost owner');
        if (mode === 'parent-abort') parent.abort(new Error('ordinary parent cancellation'));
        await expect(owner.assertOwned()).rejects.toBe(first);
        expect(() => owner.lease()).toThrow(first as Error);
        throw first;
      });
      const refused = await pending.then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(refused).toBe(first);
      await preservedDamage(owner.guardPath, 'replace');
      await expect(
        (await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run })).withLock(
          async () => undefined,
        ),
      ).rejects.toThrow('attended recovery');
    } finally {
      timer.mockRestore();
      await f.repo.cleanup();
    }
  },
);

test('ordinary retired ownership remains inactive without a physical-loss diagnosis', async () => {
  const f = await fixture();
  const owner = await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run });
  try {
    await owner.withLock(async () => undefined);
    await expect(owner.assertOwned()).rejects.toThrow('owner inactive');
    expect(() => owner.lease()).toThrow('owner inactive');
  } finally {
    await f.repo.cleanup();
  }
});

test.each(['track', 'assertOwned', 'assertSelection', 'claimCheckout'] as const)(
  'capacity caught during queued normal check closes dispatch but drains actual sibling: %s',
  async (mode) => {
    const f = await fixture(),
      parent = new AbortController();
    const report = terminalReport(join(f.root, 'capacity-barrier.json'));
    const oversized = join(f.root, 'capacity-file.bin');
    await writeFile(oversized, Buffer.alloc(8 * 1024 * 1024 + 1));
    const common = await realpath(join(f.repo.root, '.git'));
    const checkHeld = deferred(),
      checkRelease = deferred(),
      siblingStarted = deferred(),
      siblingRelease = deferred();
    let armed = false,
      actualSiblingSettled = false,
      terminalSettled = false,
      capacity: unknown;
    let sibling: Promise<unknown> | undefined,
      queued: Promise<unknown> | undefined,
      terminal: Promise<unknown> | undefined,
      pending: Promise<unknown> | undefined;
    const original = ownershipModule.AddressOwnership.prototype.assertOwned;
    const spy = vi
      .spyOn(ownershipModule.AddressOwnership.prototype, 'assertOwned')
      .mockImplementation(async function (this: ownershipModule.AddressOwnership) {
        await original.call(this);
        if (armed && this.commonDir === common) {
          armed = false;
          checkHeld.resolve();
          await checkRelease.promise;
        }
      });
    try {
      pending = withAddressOwnership(
        {
          repoRoot: f.repo.root,
          git: f.run,
          source: 'local',
          production: false,
          signal: parent.signal,
        },
        async (lease) => {
          await ownershipModule.bindAddressTerminalReport(lease, report);
          sibling = lease.track(async () => {
            siblingStarted.resolve();
            await siblingRelease.promise;
            actualSiblingSettled = true;
          });
          await siblingStarted.promise;
          armed = true;
          queued =
            mode === 'track'
              ? lease.track(async () => {
                  throw new Error('queued normal callback dispatched');
                })
              : mode === 'assertOwned'
                ? lease.assertOwned()
                : mode === 'assertSelection'
                  ? lease.assertSelection({
                      pr: 7,
                      headRepo: 'fixture/base',
                      headRefName: 'feature/x',
                    })
                  : lease.claimCheckout({
                      path: f.repo.root,
                      branch: 'feature/x',
                      head: f.prs[0].headRefOid,
                    });
          void queued.catch(() => undefined);
          await checkHeld.promise;
          capacity = await ownershipModule
            .addressOwnedEvidence(lease, { kind: 'hash', path: oversized })
            .then(
              () => undefined,
              (error: unknown) => error,
            );
          expect((capacity as Error).message).toContain('address terminal capacity:');
          checkRelease.resolve();
          await expect(queued).rejects.toBe(capacity);
          parent.abort();
          terminal = ownershipModule.addressCancelledResult(lease);
          void terminal.then(
            () => {
              terminalSettled = true;
            },
            () => {
              terminalSettled = true;
            },
          );
          await new Promise<void>((done) => setImmediate(done));
          expect(terminalSettled).toBe(false);
          expect(actualSiblingSettled).toBe(false);
          await expect(lstat(report.reportPath)).rejects.toMatchObject({ code: 'ENOENT' });
          siblingRelease.resolve();
          await sibling;
          expect(actualSiblingSettled).toBe(true);
          await expect(terminal).rejects.toBe(capacity);
          throw capacity;
        },
      );
      const refused = await pending.then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(refused).toBe(capacity);
      await expect(
        (await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run })).withLock(
          async () => undefined,
        ),
      ).rejects.toThrow('active or quarantined');
    } finally {
      checkRelease.resolve();
      siblingRelease.resolve();
      await Promise.allSettled(
        [sibling, queued, terminal, pending].filter(
          (value): value is Promise<unknown> => value !== undefined,
        ),
      );
      spy.mockRestore();
      await f.repo.cleanup();
    }
  },
);

// These are real filesystem/identity gates. Only the production factory's
// control body is replaced, through its existing private child-context path.
test.each(['claim-transition', 'import-handoff', 'participant-entry', 'checkout-final'] as const)(
  'a latched private capacity refusal fences the child phase: %s',
  async (phase) => {
    const f = await fixture();
    const checkout = phase === 'checkout-final' ? await f.resolve(f.prs[0]) : undefined;
    const common = await realpath(join(f.repo.root, '.git'));
    const oversized = join(f.root, 'child-capacity-file.bin');
    await writeFile(oversized, Buffer.alloc(8 * 1024 * 1024 + 1));
    const held = deferred(),
      release = deferred(),
      hashHeld = deferred(),
      hashRelease = deferred();
    const observedOwner: { current?: ownershipModule.AddressOwnership } = {};
    let armed = false,
      normalChecks = 0,
      factoryCalls = 0,
      participantCalls = 0,
      callbacks = 0;
    let checkoutChecks = 0,
      checkoutArmed = false,
      commonGate = false;
    let pending: Promise<unknown> | undefined,
      child: Promise<unknown> | undefined,
      hash: Promise<unknown> | undefined;
    let capacity: unknown;
    const physical = ownershipModule.AddressOwnership.prototype.assertOwned;
    const spy = vi
      .spyOn(ownershipModule.AddressOwnership.prototype, 'assertOwned')
      .mockImplementation(async function (this: ownershipModule.AddressOwnership) {
        await physical.call(this);
        if (this.commonDir !== common) return;
        observedOwner.current = this;
        if (armed) {
          normalChecks++;
          if (phase === 'import-handoff' && normalChecks === 2) {
            held.resolve();
            await release.promise;
          }
        }
        if (phase === 'checkout-final' && checkoutArmed && ++checkoutChecks === 2) {
          checkoutArmed = false;
          held.resolve();
          await release.promise;
        }
      });
    const git: typeof f.run = async (args) => {
      const result = await f.run(args);
      if (commonGate && args.at(-1) === '--git-common-dir') {
        commonGate = false;
        held.resolve();
        await release.promise;
      }
      if (
        checkout &&
        args[0] === '-C' &&
        args[1] === checkout.path &&
        args.length === 4 &&
        args[2] === 'rev-parse' &&
        args[3] === 'HEAD'
      )
        checkoutArmed = true;
      return result;
    };
    const factory = vi
      .spyOn(addressModule, 'makeReviewAddress')
      .mockImplementation(() => async (input) => {
        factoryCalls++;
        if (phase === 'participant-entry') commonGate = true;
        return withAddressOwnership(
          { repoRoot: f.repo.root, git, source: input.source, production: true },
          async (lease) => {
            participantCalls++;
            if (checkout) await lease.claimCheckout({ ...checkout, head: f.prs[0].headRefOid });
            callbacks++;
            return { status: 'needs-human' as const, reason: 'unexpected child dispatch' };
          },
        );
      });
    try {
      pending = withAddressOwnership(
        { repoRoot: f.repo.root, git, source: 'local', production: false },
        async (lease) => {
          const report = terminalReport(join(f.root, 'child-capacity-report.json'));
          await ownershipModule.bindAddressTerminalReport(lease, report);
          expect(observedOwner.current).toBeDefined();
          if (phase === 'claim-transition') {
            fsFaults.open = async (path) => {
              if (path === oversized) {
                hashHeld.resolve();
                await hashRelease.promise;
              }
            };
            hash = ownershipModule.addressOwnedEvidence(lease, { kind: 'hash', path: oversized });
            void hash.catch(() => undefined);
            await hashHeld.promise;
            fsFaults.sync = async (path) => {
              if (
                path ===
                join(authorityStore(observedOwner.current!.guardPath), 'pending-000002.json')
              ) {
                held.resolve();
                await release.promise;
              }
            };
          }
          armed = true;
          child = observedOwner.current!.address(
            {
              pr: 7,
              head: f.prs[0].headRefOid,
              headRepo: 'fixture/base',
              headRefName: 'feature/x',
            },
            { repoRoot: f.repo.root, source: 'pr:7' },
          );
          void child.catch(() => undefined);
          await Promise.race([
            held.promise,
            child.then(
              () => {
                throw new Error('child completed before fixture gate');
              },
              (error: unknown) => {
                throw error;
              },
            ),
          ]);
          if (hash) hashRelease.resolve();
          else
            hash = ownershipModule.addressOwnedEvidence(lease, { kind: 'hash', path: oversized });
          capacity = await hash.then(
            () => undefined,
            (error: unknown) => error,
          );
          expect((capacity as Error).message).toContain('address terminal capacity:');
          release.resolve();
          await expect(child).rejects.toBe(capacity);
          expect(callbacks).toBe(0);
          if (phase === 'claim-transition') {
            // A durable ACTIVE claim receipt remains an actual conservative fact.
            expect(normalChecks).toBe(1);
            expect(factoryCalls).toBe(0);
            expect((await authorityState(observedOwner.current!.guardPath)).state).toBe('active');
          } else if (phase === 'import-handoff') expect(factoryCalls).toBe(0);
          else if (phase === 'participant-entry') {
            expect(factoryCalls).toBe(1);
            expect(participantCalls).toBe(0);
          } else {
            expect(participantCalls).toBe(1);
            expect(checkoutChecks).toBe(2);
          }
          await expect(lstat(report.reportPath)).rejects.toMatchObject({ code: 'ENOENT' });
          throw capacity;
        },
      );
      const refused = await pending.then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(refused).toBe(capacity);
      expect(capacity).toBeInstanceOf(Error);
      await expect(
        (await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run })).withLock(
          async () => undefined,
        ),
      ).rejects.toThrow('active or quarantined');
    } finally {
      release.resolve();
      hashRelease.resolve();
      await Promise.allSettled(
        [hash, child, pending].filter((value): value is Promise<unknown> => value !== undefined),
      );
      fsFaults.open = fsFaults.sync = undefined;
      spy.mockRestore();
      factory.mockRestore();
      await f.repo.cleanup();
    }
  },
);

test.each(['EXDEV', 'EPERM', 'ENOSYS', 'nofollow', 'fsync'] as const)(
  'unsupported authority primitive fails closed: %s',
  async (failure) => {
    const f = await fixture();
    const owner = await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run });
    let dispatched = false;
    const unavailable = () => {
      throw Object.assign(new Error('unsupported fixture'), { code: failure });
    };
    if (failure === 'nofollow')
      fsFaults.open = async (path) => {
        if (path.startsWith(authorityStore(owner.guardPath))) unavailable();
      };
    else if (failure === 'fsync')
      fsFaults.sync = async (path) => {
        if (path.startsWith(authorityStore(owner.guardPath))) unavailable();
      };
    else
      fsFaults.link = async (_phase, _source, destination) => {
        if (destination === owner.guardPath) unavailable();
      };
    try {
      await expect(
        owner.withLock(async () => {
          dispatched = true;
        }),
      ).rejects.toThrow();
      fsFaults.link = fsFaults.open = fsFaults.sync = undefined;
      await expect(
        (await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run })).withLock(async () => {
          dispatched = true;
        }),
      ).rejects.toThrow('attended recovery');
      expect(dispatched).toBe(false);
      await expect(lstat(owner.guardPath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      fsFaults.link = fsFaults.open = fsFaults.sync = undefined;
      await f.repo.cleanup();
    }
  },
);

test('bootstrap collision and partial history preserve evidence without repair', async () => {
  for (const partial of [false, true]) {
    const f = await fixture();
    const owner = await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run });
    try {
      if (partial) await mkdir(authorityStore(owner.guardPath));
      else await writeFile(owner.guardPath, FOREIGN_GUARD);
      await expect(
        owner.withLock(async () => {
          throw new Error('must not enter');
        }),
      ).rejects.toThrow('attended recovery');
      if (partial) await expect(lstat(owner.guardPath)).rejects.toMatchObject({ code: 'ENOENT' });
      else expect(await readFile(owner.guardPath, 'utf8')).toBe(FOREIGN_GUARD);
    } finally {
      await f.repo.cleanup();
    }
  }
});

test('atomic link collision preserves destination and never falls back to rename', async () => {
  const f = await fixture();
  const owner = await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run });
  const target = join(authorityStore(owner.guardPath), '000001.json');
  let calls = 0;
  fsFaults.link = async (phase, _source, destination) => {
    if (phase === 'before' && destination === target) {
      calls++;
      await writeFile(target, 'foreign slot bytes');
    }
  };
  try {
    await expect(
      owner.withLock(async () => {
        throw new Error('must not enter');
      }),
    ).rejects.toThrow('lost owner');
    expect(calls).toBe(1);
    expect(await readFile(target, 'utf8')).toBe('foreign slot bytes');
    fsFaults.link = undefined;
    await expect(
      (await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run })).withLock(
        async () => undefined,
      ),
    ).rejects.toThrow('attended recovery');
  } finally {
    fsFaults.link = undefined;
    await f.repo.cleanup();
  }
});

test.each(['store', 'physical-lock'] as const)(
  'authority publication refuses replaced identity: %s',
  async (identity) => {
    const f = await fixture();
    const owner = await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run });
    const path =
      identity === 'store'
        ? authorityStore(owner.guardPath)
        : join(dirname(owner.guardPath), 'cq-review-address-ownership.lock');
    let replaced = false,
      dispatched = 0;
    fsFaults.link = async (phase, _source, destination) => {
      if (phase === 'before' && destination.endsWith('/000002.json') && !replaced) {
        replaced = true;
        await rename(path, `${path}.preserved`);
        await mkdir(path);
      }
    };
    const factory = vi
      .spyOn(addressModule, 'makeReviewAddress')
      .mockImplementation(() => async () => {
        dispatched++;
        return { status: 'needs-human', reason: 'identity fixture' };
      });
    try {
      await expect(
        owner.withLock(async () =>
          owner.address(
            {
              pr: 7,
              head: f.prs[0].headRefOid,
              headRepo: 'fixture/base',
              headRefName: 'feature/x',
            },
            { repoRoot: f.repo.root, source: 'pr:7' },
          ),
        ),
      ).rejects.toThrow('lost owner');
      expect(dispatched).toBe(0);
      fsFaults.link = undefined;
      await expect(
        (await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run })).withLock(
          async () => undefined,
        ),
      ).rejects.toThrow('attended recovery');
    } finally {
      fsFaults.link = undefined;
      factory.mockRestore();
      await f.repo.cleanup();
    }
  },
);

test('foreign bootstrap collision inside the hard-link window is never overwritten', async () => {
  const f = await fixture();
  const owner = await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run });
  fsFaults.link = async (phase, _source, destination) => {
    if (phase === 'before' && destination === owner.guardPath)
      await writeFile(owner.guardPath, FOREIGN_GUARD);
  };
  try {
    await expect(
      owner.withLock(async () => {
        throw new Error('must not enter');
      }),
    ).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(owner.guardPath, 'utf8')).toBe(FOREIGN_GUARD);
    fsFaults.link = undefined;
    await expect(
      (await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run })).withLock(
        async () => undefined,
      ),
    ).rejects.toThrow('attended recovery');
    expect(await readFile(owner.guardPath, 'utf8')).toBe(FOREIGN_GUARD);
  } finally {
    fsFaults.link = undefined;
    await f.repo.cleanup();
  }
});

test('settlement closes tracked admission before its awaited publication window', async () => {
  const f = await fixture();
  const owner = await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run });
  let dispatches = 0;
  let lease: ReturnType<typeof owner.lease> | undefined;
  const phases: string[] = [];
  const refuseClaim = async (phase: string) => {
    const owned = vi.spyOn(owner, 'assertOwned');
    try {
      await expect(
        lease!.claimCheckout({ path: f.repo.root, branch: 'unused', head: f.prs[0].headRefOid }),
      ).rejects.toThrow('admissions closed');
      expect(owned).not.toHaveBeenCalled();
      phases.push(phase);
    } finally {
      owned.mockRestore();
    }
  };
  fsFaults.open = async (path, flags) => {
    if (
      path.endsWith('/pending-000002.json') &&
      typeof flags === 'number' &&
      flags & constants.O_CREAT
    )
      await refuseClaim('closing');
  };
  mutexFaults.afterRelease = async () => refuseClaim('prepared');
  fsFaults.link = async (phase, _source, destination) => {
    if (phase === 'before' && destination.endsWith('/000002.json')) {
      await expect(
        lease!.track(async () => {
          dispatches++;
        }),
      ).rejects.toThrow(/admissions closed|owner inactive/);
    }
  };
  try {
    await owner.withLock(async () => {
      lease = owner.lease();
    });
    await refuseClaim('retired');
    expect(phases).toEqual(['closing', 'prepared', 'retired']);
    expect(dispatches).toBe(0);
    fsFaults.open = undefined;
    mutexFaults.afterRelease = undefined;
    fsFaults.link = undefined;
    await (
      await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run })
    ).withLock(async () => undefined);
  } finally {
    fsFaults.open = undefined;
    mutexFaults.afterRelease = undefined;
    fsFaults.link = undefined;
    await f.repo.cleanup();
  }
});

test('post-certificate fsync failure with no further writes fails old result but permits only durable fresh activation', async () => {
  const f = await fixture();
  const owner = await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run });
  let linked = false,
    dispatched = 0;
  const unavailable = () =>
    Object.assign(new Error('all further writes unavailable'), { code: 'EIO' });
  fsFaults.link = async (phase, _source, destination) => {
    if (linked && phase === 'before') throw unavailable();
    if (phase === 'after' && destination.endsWith('/000002.json')) linked = true;
  };
  fsFaults.open = async (_path, flags) => {
    if (
      linked &&
      typeof flags === 'number' &&
      flags & (constants.O_WRONLY | constants.O_RDWR | constants.O_CREAT)
    )
      throw unavailable();
  };
  fsFaults.sync = async () => {
    if (linked) throw unavailable();
  };
  try {
    await expect(owner.withLock(async () => 'provisional')).rejects.toThrow(
      'all further writes unavailable',
    );
    expect((await authorityState(owner.guardPath)).state).toBe('quiescent');
    expect(
      (await readdir(authorityStore(owner.guardPath))).some((name) =>
        name.startsWith('quarantined-'),
      ),
    ).toBe(false);
    await expect(
      (await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run })).withLock(async () => {
        dispatched++;
      }),
    ).rejects.toThrow('all further writes unavailable');
    expect(dispatched).toBe(0);
    fsFaults.link = fsFaults.open = fsFaults.sync = undefined;
    await (
      await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run })
    ).withLock(async (fresh) => {
      expect((await authorityState(fresh.guardPath)).state).toBe('active');
      dispatched++;
    });
    expect(dispatched).toBe(1);
    await expect(
      owner.withLock(async () => {
        dispatched++;
      }),
    ).rejects.toThrow('lifetime already consumed');
  } finally {
    fsFaults.link = fsFaults.open = fsFaults.sync = undefined;
    await f.repo.cleanup();
  }
});

test.each(['release-rejection', 'observed-compromise', 'real-rmdir-rejection'] as const)(
  'entire real mutex completion must succeed before certificate: %s',
  async (mode) => {
    const f = await fixture();
    const owner = await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run });
    let storageFailed = false,
      callbacks = 0;
    mutexFaults.compromise = mode === 'observed-compromise';
    mutexFaults.releaseFailed = () => {
      storageFailed = true;
    };
    mutexFaults.afterRelease = async () => {
      storageFailed = true;
      if (mode === 'release-rejection') throw new Error('real release boundary rejection');
    };
    fsFaults.open = async (_path, flags) => {
      if (storageFailed && typeof flags === 'number' && flags & constants.O_CREAT)
        throw new Error('no further writes');
    };
    fsFaults.link = async (phase) => {
      if (storageFailed && phase === 'before') throw new Error('no further writes');
    };
    fsFaults.sync = async () => {
      if (storageFailed) throw new Error('no further writes');
    };
    try {
      await expect(
        owner.withLock(async () => {
          callbacks++;
          if (mode === 'real-rmdir-rejection')
            await writeFile(
              join(dirname(owner.guardPath), 'cq-review-address-ownership.lock', 'prevent-rmdir'),
              'real cleanup failure fixture',
            );
        }),
      ).rejects.toThrow(/release.*failed|was compromised/);
      expect(callbacks).toBe(1);
      expect((await authorityState(owner.guardPath)).state).toBe('active');
      expect(await readdir(authorityStore(owner.guardPath))).toContain('pending-000002.json');
      expect(await readdir(authorityStore(owner.guardPath))).not.toContain('000002.json');
      const physical = join(dirname(owner.guardPath), 'cq-review-address-ownership.lock');
      if (mode === 'real-rmdir-rejection') {
        expect((await lstat(physical)).isDirectory()).toBe(true);
        expect(await readFile(join(physical, 'prevent-rmdir'), 'utf8')).toBe(
          'real cleanup failure fixture',
        );
        expect(storageFailed).toBe(true);
      } else await expect(lstat(physical)).rejects.toMatchObject({ code: 'ENOENT' });
      mutexFaults.afterRelease = undefined;
      mutexFaults.releaseFailed = undefined;
      mutexFaults.compromise = false;
      await expect(
        (await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run })).withLock(async () => {
          callbacks++;
        }),
      ).rejects.toThrow('attended recovery');
      expect(callbacks).toBe(1);
    } finally {
      mutexFaults.afterRelease = undefined;
      mutexFaults.releaseFailed = undefined;
      mutexFaults.compromise = false;
      fsFaults.open = fsFaults.link = fsFaults.sync = undefined;
      await f.repo.cleanup();
    }
  },
);

test.each(['success', 'old-sync-fails'] as const)(
  'retired publisher validates exact certificate prefix under a real live successor: %s',
  async (mode) => {
    const f = await fixture();
    const old = await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run });
    const certificate = deferred(),
      resume = deferred(),
      entered = deferred(),
      release = deferred();
    let next: Promise<unknown> | undefined, prior: Promise<unknown> | undefined;
    let staleLease: ReturnType<typeof old.lease> | undefined;
    let oldFailed = false;
    fsFaults.link = async (phase, _source, destination) => {
      if (phase === 'after' && destination.endsWith('/000002.json')) {
        certificate.resolve();
        await resume.promise;
        if (mode === 'old-sync-fails') oldFailed = true;
      }
    };
    fsFaults.sync = async (path) => {
      if (oldFailed && path === authorityStore(old.guardPath))
        throw new Error('old postlink sync failure');
    };
    try {
      prior = old.withLock(async () => {
        staleLease = old.lease();
        return 'old observed result';
      });
      void prior.catch(() => undefined);
      await certificate.promise;
      await expect(
        staleLease!.track(async () => {
          throw new Error('old dispatch');
        }),
      ).rejects.toThrow('admissions closed');
      await expect(staleLease!.assertOwned()).rejects.toThrow('admissions closed');
      const successor = await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run });
      next = successor.withLock(async () =>
        successor.lease().track(async () => {
          entered.resolve();
          await release.promise;
          return 'new actual work';
        }),
      );
      void next.catch(() => undefined);
      await entered.promise;
      const active = await authorityState(old.guardPath);
      expect(active.state).toBe('active');
      resume.resolve();
      if (mode === 'success') await expect(prior).resolves.toBe('old observed result');
      else await expect(prior).rejects.toThrow('old postlink sync failure');
      expect(await authorityState(old.guardPath)).toEqual(active);
      expect(
        (await readdir(authorityStore(old.guardPath))).some((name) =>
          name.startsWith('quarantined-'),
        ),
      ).toBe(false);
      fsFaults.sync = undefined;
      release.resolve();
      await next;
    } finally {
      resume.resolve();
      release.resolve();
      oldFailed = false;
      await Promise.allSettled([prior, next]);
      fsFaults.link = fsFaults.sync = undefined;
      await f.repo.cleanup();
    }
  },
);

test.each(['anchor', 'certificate', 'foreign-epoch', 'missing-certificate', 'store'] as const)(
  'postlink prefix corruption is never adopted or repaired: %s',
  async (damage) => {
    const f = await fixture();
    const owner = await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run });
    const store = authorityStore(owner.guardPath);
    let evidence: string | undefined;
    fsFaults.link = async (phase, _source, destination) => {
      if (phase !== 'after' || !destination.endsWith('/000002.json')) return;
      if (damage === 'anchor') await damageGuard(owner.guardPath, 'replace');
      else if (damage === 'missing-certificate') await unlink(destination);
      else if (damage === 'store') await rename(store, `${store}.foreign-preserved`);
      else {
        const data = JSON.parse(await readFile(destination, 'utf8')) as {
          epoch: string;
          resources: string[];
        };
        if (damage === 'foreign-epoch') data.epoch = randomUUID();
        else data.resources = ['forged-terminal-extra-resource'];
        evidence = JSON.stringify(data);
        await writeFile(destination, evidence);
      }
    };
    try {
      await expect(owner.withLock(async () => 'unconfirmed')).rejects.toThrow(
        /lost owner|attended recovery|ENOENT/,
      );
      fsFaults.link = undefined;
      let dispatched = 0;
      await expect(
        (await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run })).withLock(async () => {
          dispatched++;
        }),
      ).rejects.toThrow('attended recovery');
      expect(dispatched).toBe(0);
      if (evidence) expect(await readFile(join(store, '000002.json'), 'utf8')).toBe(evidence);
      if (damage === 'anchor') expect(await readFile(owner.guardPath, 'utf8')).toBe(FOREIGN_GUARD);
      if (damage === 'missing-certificate')
        await expect(lstat(join(store, '000002.json'))).rejects.toMatchObject({ code: 'ENOENT' });
      if (damage === 'store') await expect(lstat(store)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      fsFaults.link = undefined;
      await f.repo.cleanup();
    }
  },
);

test.each([
  'certificate-sync',
  'adoption-store-sync',
  'prepare-sync',
  'before-link',
  'after-link',
  'active-store-sync',
] as const)('fresh adoption/activation failure dispatches zero work: %s', async (fault) => {
  const f = await fixture();
  const owner = await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run });
  const store = authorityStore(owner.guardPath);
  let activeLinked = false,
    dispatched = 0;
  try {
    await owner.withLock(async () => undefined);
    fsFaults.link = async (phase, _source, destination) => {
      if (!destination.endsWith('/000003.json')) return;
      if (phase === 'after') activeLinked = true;
      if (
        (fault === 'before-link' && phase === 'before') ||
        (fault === 'after-link' && phase === 'after')
      )
        throw new Error('fresh activation fault');
    };
    fsFaults.sync = async (path) => {
      if (
        (fault === 'certificate-sync' && path === join(store, '000002.json')) ||
        (fault === 'adoption-store-sync' && path === store) ||
        (fault === 'prepare-sync' && path === join(store, 'pending-000003.json')) ||
        (fault === 'active-store-sync' && activeLinked && path === store)
      )
        throw new Error('fresh activation fault');
    };
    await expect(
      (await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run })).withLock(async () => {
        dispatched++;
      }),
    ).rejects.toThrow(/fresh activation fault|lost owner/);
    expect(dispatched).toBe(0);
    fsFaults.link = fsFaults.sync = undefined;
    const retry = await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run });
    if (fault === 'certificate-sync' || fault === 'adoption-store-sync')
      await retry.withLock(async () => {
        dispatched++;
      });
    else
      await expect(
        retry.withLock(async () => {
          dispatched++;
        }),
      ).rejects.toThrow('attended recovery');
    expect(dispatched).toBe(
      fault === 'certificate-sync' || fault === 'adoption-store-sync' ? 1 : 0,
    );
  } finally {
    fsFaults.link = fsFaults.sync = undefined;
    await f.repo.cleanup();
  }
});

test('v2 authority requires attended migration and is never automatically reused', async () => {
  const f = await fixture();
  const owner = await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run });
  try {
    await owner.withLock(async () => undefined);
    const anchor = JSON.parse(await readFile(owner.guardPath, 'utf8')) as { version: number };
    anchor.version = 2;
    const evidence = JSON.stringify(anchor);
    await writeFile(owner.guardPath, evidence);
    let failure: unknown,
      dispatched = 0;
    try {
      await (
        await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run })
      ).withLock(async () => {
        dispatched++;
      });
    } catch (error) {
      failure = error;
    }
    expect(errorChain(failure)).toContain('v2 requires attended migration');
    expect(dispatched).toBe(0);
    expect(await readFile(owner.guardPath, 'utf8')).toBe(evidence);
  } finally {
    await f.repo.cleanup();
  }
});

test('callback values cannot forge completion and retired lease/proof replay cannot reopen admission', async () => {
  const f = await fixture();
  const owner = await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run });
  // Private methods are deliberately reached only here to test runtime brands,
  // not exposed to callers as a production certificate or bypass API.
  const publisher = owner as unknown as { publishCompletion(proof: object): Promise<void> };
  const fake = { owner, sequence: 2, state: 'quiescent' };
  let lease: ReturnType<typeof owner.lease> | undefined;
  let consumed: object | undefined;
  const publish = publisher.publishCompletion.bind(owner);
  const observed = vi.spyOn(publisher, 'publishCompletion').mockImplementation(async (proof) => {
    consumed = proof;
    await publish(proof);
  });
  try {
    await expect(publish(fake)).rejects.toThrow('forged or consumed');
    expect(
      await owner.withLock(async () => {
        lease = owner.lease();
        return fake;
      }),
    ).toBe(fake);
    observed.mockRestore();
    expect(consumed).toBeDefined();
    await expect(publish(consumed!)).rejects.toThrow('forged or consumed');
    await expect(publish(consumed!)).rejects.toThrow('forged or consumed');
    await expect(publish(fake)).rejects.toThrow('forged or consumed');
    await expect(
      lease!.track(async () => {
        throw new Error('stale dispatch');
      }),
    ).rejects.toThrow('admissions closed');
    await expect(owner.withLock(async () => undefined)).rejects.toThrow(
      'lifetime already consumed',
    );
    expect((await authorityState(owner.guardPath)).state).toBe('quiescent');
  } finally {
    observed.mockRestore();
    await f.repo.cleanup();
  }
});

test('a genuine active-guard refusal preserves the owner and returns without report IO', async () => {
  const f = await fixture();
  const role = { provider: 'mock', model: 'mock' };
  const journalDir = join(f.root, 'admission-refusal-journal');
  let dispatches = 0;
  try {
    const owner = await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run });
    await owner.withLock(async () => {
      const before = await authorityState(owner.guardPath);
      const result = await addressModule.makeReviewAddress({
        config: {
          schemaVersion: 2,
          checks: [{ adapter: 'tsc-lines', command: { command: process.execPath, args: [] } }],
          roles: { worker: role, reviewer: role },
          budgets: { run: { maxTokens: 1000 } },
          review: { reviewers: ['agent'] },
        },
        git: f.run,
        review: async () => {
          dispatches++;
          throw new Error('no review expected');
        },
      })({ repoRoot: f.repo.root, source: 'local', journalDir, push: true });
      expect(result.status).toBe('needs-human');
      if (result.status !== 'needs-human') throw new Error('admission was not refused');
      expect(result.reason).toContain('could not acquire');
      expect(result.report?.stop).toBeUndefined();
      expect(dispatches).toBe(0);
      await expect(lstat(journalDir)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await authorityState(owner.guardPath)).toEqual(before);
    });
    expect((await authorityState(owner.guardPath)).state).toBe('quiescent');
  } finally {
    await f.repo.cleanup();
  }
});

test.each([
  'sync',
  'deferred',
  'unprintable',
  'unprintable-message',
  'forged-admission',
  'nested-admission',
  'late-cleanup',
  'late-budget-facts',
] as const)('address lifetime catch is pure and preserves observed report: %s', async (mode) => {
  const f = await fixture();
  const role = { provider: 'mock', model: 'mock' };
  const config: CqConfig = {
    schemaVersion: 2,
    checks: [{ adapter: 'tsc-lines', command: { command: process.execPath, args: [] } }],
    roles: { worker: role, reviewer: role },
    budgets: { run: { maxTokens: 1000 } },
    review: { reviewers: ['agent'] },
  };
  const journalDir = join(f.root, 'pure-adapter-journal');
  let closed = false,
    effectsAfterClose = 0;
  const effect = () => {
    if (closed) effectsAfterClose++;
  };
  fsFaults.effect = effect;
  const cause =
    mode === 'unprintable'
      ? {
          toString: () => {
            throw new Error('cannot render');
          },
        }
      : new Error('ownership finalization fixture');
  if (mode === 'forged-admission')
    Object.assign(cause, {
      message: 'could not acquire address ownership: active or quarantined guard',
      admissionRefusal: true,
    });
  if (mode === 'unprintable-message')
    Object.defineProperty(cause, 'message', {
      get: () => {
        throw new Error('cannot read message');
      },
    });
  const late =
    mode === 'late-cleanup' || mode === 'late-budget-facts' || mode === 'nested-admission';
  const facts = mode === 'late-budget-facts';
  const original = ownershipModule.withAddressOwnership;
  const spy = vi.spyOn(ownershipModule, 'withAddressOwnership');
  if (
    mode === 'sync' ||
    mode === 'unprintable' ||
    mode === 'unprintable-message' ||
    mode === 'forged-admission'
  )
    spy.mockImplementation(() => {
      closed = true;
      throw cause;
    });
  else if (mode === 'deferred')
    spy.mockImplementation(async () => {
      await Promise.resolve();
      closed = true;
      throw cause;
    });
  else if (mode === 'nested-admission')
    spy.mockImplementation((opts, action) =>
      original(opts, async (lease) => {
        const contender = await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run });
        let refusal: unknown;
        try {
          await contender.withLock(async () => undefined);
        } catch (error) {
          refusal = error;
        }
        expect(ownershipModule.isAddressOwnershipAdmissionRefusal(refusal)).toBe(true);
        await action(lease);
        throw refusal;
      }).catch((error: unknown) => {
        closed = true;
        throw error;
      }),
    );
  else {
    spy.mockImplementation(original);
    mutexFaults.afterRelease = async () => {
      closed = true;
      throw cause;
    };
  }
  try {
    const result = await addressModule.makeReviewAddress({
      config,
      git: async (args) => {
        effect();
        return f.run(args);
      },
      gh: async () => {
        effect();
        throw new Error('no forge expected');
      },
      initialRecord: {
        schemaVersion: 1,
        branch: 'feature/x',
        reviewed: {
          base: f.repo.git('merge-base', 'origin/merge-queue', 'HEAD').trim(),
          scope: 'full',
        },
        head: f.repo.git('rev-parse', 'HEAD').trim(),
        sources: [{ kind: 'agent', status: 'terminal' }],
        findings: facts
          ? ['a', 'b'].map((id) => ({
              id,
              file: `src/${id}.ts`,
              source: 'agent' as const,
              severity: 'major' as const,
              status: 'open' as const,
              text: `fix ${id}`,
            }))
          : [],
        advisories: ['retained review advisory'],
      },
      ...(facts
        ? {
            disposition: async () => {
              effect();
              return { status: 'ok' as const, value: {} };
            },
          }
        : {}),
      workerFactory: (deps) => {
        effect();
        if (!facts) throw new Error('no worker expected');
        return {
          escalation: () => {
            effect();
            return createEscalationState();
          },
          fix: async (item) => {
            effect();
            deps.account({
              stopReason: 'complete',
              usage: { input: 5, output: 3, cacheRead: 0, cacheWrite: 0, reasoning: 2 },
              costUSD: 0.25,
              denials: [],
            });
            return {
              finding: { ...item, status: 'deferred' as const, reason: 'needs owner' },
              observedHead: f.repo.git('rev-parse', 'HEAD').trim(),
              reason: 'needs owner',
              validation: [],
            };
          },
        };
      },
      review: async () => {
        effect();
        throw new Error('no review expected');
      },
    })({
      repoRoot: f.repo.root,
      source: 'local',
      journalDir,
      ...(facts ? { maxTokens: 10, concurrency: 1 } : {}),
    });
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('failed surface required');
    expect(result.error).toContain('finalization failed; durability unconfirmed');
    if (mode === 'unprintable' || mode === 'unprintable-message')
      expect(result.error).toContain('unprintable ownership error');
    expect(result.report?.stop).toBeUndefined();
    expect(result.report?.reasons.filter((reason) => reason === result.error)).toHaveLength(1);
    expect(OpResultArtifactSchema.safeParse(result).success).toBe(true);
    expect(exitCodeForOpResult(result)).toBe(1);
    expect(effectsAfterClose).toBe(0);
    if (late) {
      if (!facts) expect(result.report?.admissionHead).toBe(f.repo.git('rev-parse', 'HEAD').trim());
      const persisted = JSON.parse(
        await readFile(join(journalDir, 'review-address-report.json'), 'utf8'),
      ) as addressModule.ReviewAddressReport;
      expect(persisted.reasons).not.toContain(result.error);
      const { stop: _stop, ...retained } = persisted;
      expect(result.report).toEqual({ ...retained, reasons: [...persisted.reasons, result.error] });
      if (facts) {
        expect(persisted.stop).toBe('budget');
        expect(result.report?.usage).toEqual({
          input: 5,
          output: 3,
          cacheRead: 0,
          cacheWrite: 0,
          reasoning: 2,
        });
        expect(result.report?.costUSD).toBe(0.25);
        expect(result.report?.fixes).toHaveLength(1);
        expect(result.report?.fixes[0]?.finding.status).toBe('deferred');
        expect(result.report?.rounds[0]?.runs).toHaveLength(1);
        expect(result.report?.advisories).toEqual(['retained review advisory']);
      }
    } else await expect(lstat(journalDir)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    spy.mockRestore();
    mutexFaults.afterRelease = undefined;
    fsFaults.effect = undefined;
    await f.repo.cleanup();
  }
});

test('immutable write loss with detached work refuses again after late settlement', async () => {
  const f = await fixture();
  const owner = await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run });
  const entered = deferred(),
    release = deferred();
  let actual: Promise<unknown> | undefined;
  fsFaults.link = async (phase, _source, destination) => {
    if (phase === 'after' && destination.endsWith('/000002.json'))
      await damageGuard(owner.guardPath, 'replace');
  };
  try {
    await expect(
      owner.withLock(async () => {
        actual = owner.lease().track(async () => {
          entered.resolve();
          await release.promise;
          await f.repo.write('survivor.txt', 'late survivor');
        });
        await entered.promise;
        throw new Error('force error-path quarantine while actual work remains');
      }),
    ).rejects.toThrow('force error-path');
    await preservedDamage(owner.guardPath, 'replace');
    fsFaults.link = undefined;
    const contender = await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run });
    await expect(contender.withLock(async () => undefined)).rejects.toThrow('attended recovery');
    release.resolve();
    await actual;
    await expect(contender.withLock(async () => undefined)).rejects.toThrow('attended recovery');
    await preservedDamage(owner.guardPath, 'replace');
  } finally {
    release.resolve();
    await actual;
    fsFaults.link = undefined;
    await f.repo.cleanup();
  }
});

test.each(['records', 'per-record', 'total-bytes', 'resource-count', 'resource-bytes'] as const)(
  'authority writer bound requires attended compaction: %s',
  async (bound) => {
    const f = await fixture();
    const owner = await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run });
    let dispatched = 0,
      failure: unknown;
    const factory = vi
      .spyOn(addressModule, 'makeReviewAddress')
      .mockImplementation(() => async () => {
        dispatched++;
        return { status: 'needs-human', reason: 'bound fixture' };
      });
    try {
      try {
        await owner.withLock(async () => {
          for (let index = 0; index < 65; index++) {
            const unique = bound === 'resource-count' || bound === 'per-record';
            const length =
              bound === 'per-record' || bound === 'total-bytes'
                ? 1900
                : bound === 'resource-bytes'
                  ? 2100
                  : 10;
            await owner.address(
              {
                pr: unique ? index + 1 : 7,
                head: f.prs[0].headRefOid,
                headRepo: 'fixture/base',
                headRefName: `${'x'.repeat(length)}${unique ? index : ''}`,
              },
              { repoRoot: f.repo.root, source: `pr:${unique ? index + 1 : 7}` },
            );
          }
        });
      } catch (error) {
        failure = error;
      }
      expect(errorChain(failure)).toContain('bound reached; attended compaction required');
      const names = (await readdir(authorityStore(owner.guardPath)))
        .filter((name) => /^[0-9]{6}\.json$/.test(name))
        .sort();
      const records = await Promise.all(
        names.map((name) => readFile(join(authorityStore(owner.guardPath), name))),
      );
      expect(names.length).toBeLessThanOrEqual(64);
      expect(records.every((record) => record.length <= 16_384)).toBe(true);
      expect(records.reduce((sum, record) => sum + record.length, 0)).toBeLessThanOrEqual(131_072);
      const last = JSON.parse(records.at(-1)!.toString()) as { resources: string[] };
      expect(last.resources.length).toBeLessThanOrEqual(64);
      expect(last.resources.every((key) => Buffer.byteLength(key) <= 2048)).toBe(true);
      if (bound === 'records') expect(names.length).toBe(64);
      if (bound === 'resource-count') expect(last.resources.length).toBe(64);
      if (bound === 'resource-bytes') expect(dispatched).toBe(0);
      if (bound === 'per-record') {
        expect(last.resources.length).toBe(16);
        expect(records.reduce((sum, record) => sum + record.length, 0)).toBeLessThan(131_072);
      }
      if (bound === 'total-bytes') {
        const total =
          records.reduce((sum, record) => sum + record.length, 0) +
          (await readFile(owner.guardPath)).length;
        expect(total).toBeLessThanOrEqual(131_072);
        expect(total + records.at(-1)!.length).toBeGreaterThan(131_072);
      }
      expect(dispatched).toBeLessThan(65);
      await expect(
        (await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run })).withLock(
          async () => undefined,
        ),
      ).rejects.toThrow('attended recovery');
    } finally {
      factory.mockRestore();
      await f.repo.cleanup();
    }
  },
  120_000, // Bounded 64-record real-filesystem history; do not leave timed-out work running.
);

test.each(['anchor-bytes', 'record-bytes', 'total-bytes', 'enumeration'] as const)(
  'authority reader bounds allocation before parsing: %s',
  async (bound) => {
    const f = await fixture();
    const owner = await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run });
    try {
      await owner.withLock(async () => undefined);
      if (bound === 'anchor-bytes') await writeFile(owner.guardPath, '!'.repeat(257));
      else if (bound === 'record-bytes')
        await writeFile(join(authorityStore(owner.guardPath), '000001.json'), '!'.repeat(16_385));
      else if (bound === 'total-bytes') {
        const store = authorityStore(owner.guardPath);
        const anchor = JSON.parse(await readFile(owner.guardPath, 'utf8')) as { anchor: string };
        let previous = createHash('sha256')
          .update(await readFile(join(store, '000002.json')))
          .digest('hex');
        const epoch = randomUUID();
        for (let sequence = 3; sequence <= 63; sequence++) {
          const bytes = JSON.stringify({
            version: 3,
            anchor: anchor.anchor,
            sequence,
            previous,
            epoch,
            state: 'active',
            resources: sequence === 3 ? [] : ['x'.repeat(2048)],
          });
          const name = `${String(sequence).padStart(6, '0')}.json`;
          await writeFile(join(store, `pending-${name}`), bytes);
          await link(join(store, `pending-${name}`), join(store, name));
          previous = createHash('sha256').update(bytes).digest('hex');
        }
      } else
        for (let sequence = 3; sequence <= 65; sequence++) {
          const pending = join(
            authorityStore(owner.guardPath),
            `pending-${String(sequence).padStart(6, '0')}.json`,
          );
          await writeFile(pending, '!');
          await link(
            pending,
            join(authorityStore(owner.guardPath), `${String(sequence).padStart(6, '0')}.json`),
          );
        }
      let failure: unknown;
      try {
        await (
          await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run })
        ).withLock(async () => undefined);
      } catch (error) {
        failure = error;
      }
      expect(errorChain(failure)).toContain('bound reached; attended compaction required');
      expect(errorChain(failure)).not.toContain('SyntaxError');
    } finally {
      await f.repo.cleanup();
    }
  },
);

test('a dirty stale PR refuses while its sibling resolves without changing caller or foreign worktrees', async () => {
  const f = await fixture();
  try {
    const stale = await f.resolve(f.prs[0]);
    await writeFile(join(stale.path, 'README.md'), 'unpublished PR 7 work\n');
    const entriesBefore = await fileWorktreeRegistry(f.registryPath).load();
    // The PR advances after its first checkout; refreshing must preserve dirty work.
    f.repo.git('push', '-q', 'origin', `${f.prs[1].headRefOid}:refs/pull/7/head`);
    const foreign = join(f.root, 'foreign');
    f.repo.git('worktree', 'add', '-q', '-b', 'foreign-fixture', foreign, f.prs[0].headRefOid);
    for (const path of [f.repo.root, foreign]) {
      await writeFile(join(path, 'src/a.ts'), 'export const staged = 3;\n');
      f.repo.git('-C', path, 'add', '--', 'src/a.ts');
      await writeFile(join(path, 'README.md'), 'unstaged caller-owned work\n');
      await writeFile(join(path, 'private-note.txt'), `untracked content in ${path}\n`);
    }
    const callerBefore = await checkoutSnapshot(f.repo, f.repo.root);
    const foreignBefore = await checkoutSnapshot(f.repo, foreign);
    const [refused, sibling] = await Promise.allSettled([f.resolve(f.prs[0]), f.resolve(f.prs[1])]);
    expect(refused.status).toBe('rejected');
    if (refused.status !== 'rejected') throw new Error('dirty stale PR unexpectedly resolved');
    expect(refused.reason).toBeInstanceOf(Error);
    expect((refused.reason as Error).message).toMatch(/modified|untracked|dirty/i);
    expect(sibling.status).toBe('fulfilled');
    if (sibling.status !== 'fulfilled') throw sibling.reason;
    expect(sibling.value.path).not.toBe(stale.path);
    expect(sibling.value.branch).not.toBe(stale.branch);
    expect(f.repo.git('-C', sibling.value.path, 'rev-parse', 'HEAD').trim()).toBe(
      f.prs[1].headRefOid,
    );
    const entries = await fileWorktreeRegistry(f.registryPath).load();
    expect(entries['7']).toEqual(entriesBefore['7']);
    expect(entries['9']).toEqual({
      path: sibling.value.path,
      branch: sibling.value.branch,
      createdAt: NOW + 9,
    });
    expect(f.repo.git('-C', stale.path, 'rev-parse', 'HEAD').trim()).toBe(f.prs[0].headRefOid);
    expect(await readFile(join(stale.path, 'README.md'), 'utf8')).toBe('unpublished PR 7 work\n');
    expect(await checkoutSnapshot(f.repo, f.repo.root)).toEqual(callerBefore);
    expect(await checkoutSnapshot(f.repo, foreign)).toEqual(foreignBefore);
  } finally {
    await f.repo.cleanup();
  }
});

function terminalReport(path: string): ReviewAddressReport {
  return {
    source: 'local',
    reportPath: path,
    rounds: [],
    findings: [],
    openBlocking: [],
    fixes: [],
    attempts: [],
    failed: [],
    fixesPerRun: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    wallMs: 0,
    reasons: [],
  };
}
function terminalInput(repo: TestRepo) {
  const parent = repo.git('rev-parse', 'HEAD').trim();
  return {
    root: repo.root,
    file: 'src/a.ts',
    parent,
    executionHead: parent,
    runPrefix: 'terminal-fixture',
    finding: 'terminal-a',
    slug: 'fixture',
    ordinal: 1,
    tier: 'worker' as const,
    model: { provider: 'mock', model: 'offline' },
  };
}

test.each(['success', 'report-failure', 'owner-loss', 'alias', 'alias-caught', 'opaque'] as const)(
  'cancelled bulk participants drain every actual writer before shared reports: %s',
  async (mode) => {
    const f = await fixture();
    const parent = new AbortController();
    const started = [deferred(), deferred()],
      arrive = deferred(),
      releaseWriter = deferred(),
      aliasDetected = deferred(),
      firstWriterReady = deferred();
    const alias = mode === 'alias' || mode === 'alias-caught';
    const writers: Promise<unknown>[] = [];
    const reports = [
      terminalReport(join(f.root, 'terminal-seven.json')),
      terminalReport(join(f.root, 'terminal-nine.json')),
    ];
    if (alias) reports[1]!.reportPath = reports[0]!.reportPath;
    let owner: Awaited<ReturnType<typeof makeAddressOwnership>>;
    let reportWrites = 0;
    let terminalReturns = 0;
    const reportOrder: string[] = [];
    const factory = vi
      .spyOn(addressModule, 'makeReviewAddress')
      .mockImplementation(() => async (input) => {
        const index = input.source === 'pr:7' ? 0 : 1;
        if (index === 1 && (mode === 'report-failure' || alias)) await firstWriterReady.promise;
        return withAddressOwnership(
          { repoRoot: f.repo.root, git: f.run, source: input.source, production: true },
          async (lease) => {
            try {
              await ownershipModule.bindAddressTerminalReport(lease, reports[index]!);
            } catch (error) {
              aliasDetected.resolve();
              if (mode === 'alias-caught')
                return { status: 'needs-human' as const, reason: 'caught alias fixture' };
              throw error;
            }
            writers.push(
              lease.track(async () => {
                if (mode === 'opaque' && index === 0)
                  ownershipModule.noteAddressOpaqueInvocation(lease);
                started[index]!.resolve();
                if (index === 0) firstWriterReady.resolve();
                try {
                  await releaseWriter.promise;
                } finally {
                  await writeFile(
                    join(f.root, `actual-finally-${index}`),
                    'writer finally settled',
                  );
                }
              }),
            );
            await arrive.promise;
            return ownershipModule.addressCancelledResult(lease).finally(() => {
              terminalReturns++;
            });
          },
        );
      });
    let pending: Promise<unknown> | undefined;
    try {
      owner = await makeAddressOwnership({
        repoRoot: f.repo.root,
        git: f.run,
        signal: parent.signal,
      });
      fsFaults.open = async (path, flags) => {
        if (
          (path === reports[0]!.reportPath || path === reports[1]!.reportPath) &&
          typeof flags === 'number' &&
          flags & constants.O_CREAT
        ) {
          reportWrites++;
          reportOrder.push(path);
          if (mode === 'report-failure' && path === reports[1]!.reportPath)
            throw new Error('terminal report persistence fault');
        }
      };
      pending = owner.withLock(async () => {
        const children = [7, 9].map((pr, index) =>
          owner.address(
            {
              pr,
              head: f.prs[index]!.headRefOid,
              headRepo: 'fixture/base',
              headRefName: `fixture-distinct-${pr}`,
            },
            { repoRoot: f.repo.root, source: `pr:${pr}` },
          ),
        );
        // Observe rejection immediately; alias refusal can precede cancellation.
        const outcomes = Promise.allSettled(children);
        if (alias) {
          await aliasDetected.promise;
          parent.abort();
          arrive.resolve();
          return outcomes.then((rows) => {
            if (mode === 'alias-caught') return;
            if (rows.some((row) => row.status === 'rejected'))
              throw new Error('terminal report target alias');
          });
        }
        await Promise.all(started.map((entry) => entry.promise));
        parent.abort();
        arrive.resolve();
        return Promise.all(children);
      });
      const observed = pending.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      if (alias) await aliasDetected.promise;
      else await Promise.all(started.map((entry) => entry.promise));
      await arrive.promise;
      // Child control arrivals alone cannot settle an actual writer/finally.
      expect(reportWrites).toBe(0);
      expect(terminalReturns).toBe(0);
      await expect(lstat(reports[0]!.reportPath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await authorityState(owner.guardPath)).state).toBe('active');
      if (mode === 'owner-loss') await damageGuard(owner.guardPath, 'replace');
      releaseWriter.resolve();
      const outcome = await observed;
      await Promise.allSettled(writers);
      expect(await readFile(join(f.root, 'actual-finally-0'), 'utf8')).toContain('settled');
      if (mode === 'success') {
        expect(outcome).toHaveProperty('value');
        for (let index = 0; index < 2; index++) {
          expect(await readFile(join(f.root, `actual-finally-${index}`), 'utf8')).toContain(
            'settled',
          );
          const report = JSON.parse(
            await readFile(reports[index]!.reportPath, 'utf8'),
          ) as ReviewAddressReport;
          expect(report.reasons).toEqual(['parent cancelled']);
          expect(report.failed).toEqual([]);
        }
        expect((await authorityState(owner.guardPath)).state).toBe('quiescent');
      } else {
        expect(outcome).toHaveProperty('error');
        if (mode === 'report-failure') {
          if ('error' in outcome)
            expect(String(outcome.error)).toContain('terminal report persistence fault');
          expect(reportOrder).toEqual(reports.map((report) => report.reportPath));
          expect(
            (JSON.parse(await readFile(reports[0]!.reportPath, 'utf8')) as ReviewAddressReport)
              .reasons,
          ).toEqual(['parent cancelled']);
          await expect(lstat(reports[1]!.reportPath)).rejects.toMatchObject({ code: 'ENOENT' });
          expect((await authorityState(owner.guardPath)).state).not.toBe('quiescent');
        } else {
          expect(reportWrites).toBe(0);
          expect(reportOrder).toEqual([]);
          expect((await authorityState(owner.guardPath)).state).not.toBe('quiescent');
          if (alias && 'error' in outcome) expect(String(outcome.error)).toContain('alias');
        }
      }
    } finally {
      releaseWriter.resolve();
      arrive.resolve();
      firstWriterReady.resolve();
      await Promise.allSettled([...writers, ...(pending ? [pending] : [])]);
      fsFaults.open = undefined;
      factory.mockRestore();
      await f.repo.cleanup();
    }
  },
);

test('terminal binding rejects structural, replayed and retired capabilities without dispatch', async () => {
  const f = await fixture();
  let binding: object | undefined, attempt: object | undefined;
  try {
    expect(() => ownershipModule.recordAddressTerminalAttempt({}, terminalInput(f.repo))).toThrow(
      'forged worker',
    );
    await withAddressOwnership(
      { repoRoot: f.repo.root, git: f.run, source: 'local', production: false },
      async (lease) => {
        binding = ownershipModule.addressTerminalWorkerBinding(lease);
        attempt = await ownershipModule.recordAddressTerminalAttempt(
          binding,
          terminalInput(f.repo),
        );
        expect(() => ownershipModule.deferAddressTerminalAttempt({}, attempt!)).toThrow(
          'forged worker',
        );
        expect(ownershipModule.deferAddressTerminalAttempt(binding, attempt)).toBe(false);
      },
    );
    await expect(
      ownershipModule.recordAddressTerminalAttempt(binding!, terminalInput(f.repo)),
    ).rejects.toThrow('after close');
    expect(() =>
      ownershipModule.addressTerminalWorkerBinding(
        {} as Parameters<typeof ownershipModule.addressTerminalWorkerBinding>[0],
      ),
    ).toThrow('forged worker lease');
    expect(f.repo.git('for-each-ref', '--format=%(refname)', 'refs/heads/cq-address/')).toBe('');
  } finally {
    await f.repo.cleanup();
  }
});

test.each(['snapshot', 'total', 'receipts', 'report'] as const)(
  'terminal bounds refuse before retaining excess evidence or writing a report: %s',
  async (mode) => {
    const f = await fixture();
    const parent = new AbortController();
    const report = terminalReport(join(f.root, 'terminal-bound-report.json'));
    const selector = await terminalFixtureSelector(f.repo);
    const responses = mode === 'receipts' ? terminalReadonlyResponses(f.repo) : undefined;
    let hook: typeof terminalProcessFaults.spawn, pending: Promise<unknown> | undefined;
    const progress = { completed: 0, attempted: 0 };
    try {
      if (mode === 'snapshot' || mode === 'total') {
        await f.repo.write(
          'src/a.ts',
          Buffer.alloc(4 * 1024 * 1024 + (mode === 'snapshot' ? 1 : 0), 65),
        );
        f.repo.commitAll('bounded raw baseline');
      }
      pending = withAddressOwnership(
        {
          repoRoot: f.repo.root,
          git: f.run,
          source: 'local',
          production: false,
          signal: parent.signal,
        },
        async (lease) => {
          await ownershipModule.bindAddressTerminalReport(lease, report);
          const binding = ownershipModule.addressTerminalWorkerBinding(lease);
          if (mode === 'report') {
            report.reasons.push('x'.repeat(16 * 1024 * 1024 + 1));
            parent.abort();
            return ownershipModule.addressCancelledResult(lease);
          }
          const count = mode === 'receipts' ? 65 : mode === 'total' ? 9 : 1;
          for (let index = 0; index < count; index++) {
            progress.attempted++;
            await ownershipModule.recordAddressTerminalAttempt(binding, terminalInput(f.repo));
            progress.completed++;
            if (index === 0 && responses) {
              hook = (command, args, options) => {
                const fixed = selector.select(command, args, options);
                if (!fixed) return;
                const output = responses.get(JSON.stringify(fixed));
                if (output === undefined) return;
                selector.stages.handled++;
                return boundedFixtureProcess(output);
              };
              terminalProcessFaults.spawn = hook;
            }
          }
          throw new Error('bound failed to refuse');
        },
      );
      await expect(pending, JSON.stringify({ progress, stages: selector.stages })).rejects.toThrow(
        /bound/,
      );
      if (mode === 'receipts') {
        expect(progress).toEqual({ attempted: 65, completed: 64 });
        expect(selector.stages.handled).toBe(63 * 7);
      }
      await expect(lstat(report.reportPath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(f.repo.git('for-each-ref', '--format=%(refname)', 'refs/heads/cq-address/')).toBe('');
    } finally {
      await Promise.allSettled(pending ? [pending] : []);
      if (terminalProcessFaults.spawn === hook) terminalProcessFaults.spawn = undefined;
      await f.repo.cleanup();
    }
  },
);

test.each([
  'stdout',
  'stderr',
  'post-spawn-error',
  'spawn-failure',
  'timeout',
  'no-close',
] as const)(
  'terminal subprocess refusal retains registration until actual close: %s',
  async (mode) => {
    const f = await fixture();
    const parent = new AbortController();
    const report = terminalReport(join(f.root, 'terminal-process-report.json'));
    const selector = await terminalFixtureSelector(f.repo);
    let hook: typeof terminalProcessFaults.spawn;
    const closeHeld = deferred(),
      releaseClose = deferred();
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    let child: ChildProcess | undefined,
      used = false,
      resultSettled = false;
    const longTimers: Array<() => void> = [];
    let timerSpy: { mockRestore(): void } | undefined;
    const actualSetTimeout = globalThis.setTimeout;
    const baseline = await readFile(join(f.repo.root, 'src/a.ts'));
    let pending: Promise<unknown> | undefined;
    try {
      pending = withAddressOwnership(
        {
          repoRoot: f.repo.root,
          git: f.run,
          source: 'local',
          production: false,
          signal: parent.signal,
        },
        async (lease) => {
          await ownershipModule.bindAddressTerminalReport(lease, report);
          const binding = ownershipModule.addressTerminalWorkerBinding(lease);
          const attempt = await ownershipModule.recordAddressTerminalAttempt(
            binding,
            terminalInput(f.repo),
          );
          await writeFile(join(f.repo.root, 'src/a.ts'), 'CANCELLED partial bytes\n');
          if (mode === 'timeout' || mode === 'no-close')
            timerSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
              handler: (...args: unknown[]) => void,
              delay?: number,
              ...args: unknown[]
            ) => {
              if (typeof handler === 'function' && delay && delay > 59_000)
                longTimers.push(() => handler(...args));
              return actualSetTimeout(handler, delay, ...args);
            }) as unknown as typeof setTimeout);
          hook = (command, args, options) => {
            const fixed = selector.select(command, args, options);
            if (
              !fixed ||
              JSON.stringify(fixed) !== JSON.stringify(['symbolic-ref', 'HEAD']) ||
              used
            )
              return undefined;
            used = true;
            selector.stages.handled++;
            if (mode === 'spawn-failure') {
              closeHeld.resolve();
              throw new Error('fixed fixture synchronous spawn failure');
            }
            // These constant programs cannot access a provider or network. The
            // parent test delays observed close, never treats exit as settlement.
            const script =
              mode === 'stdout'
                ? 'process.stdout.end(Buffer.alloc(8*1024*1024+1,65));'
                : mode === 'stderr'
                  ? 'process.stderr.end(Buffer.alloc(64*1024+1,66));'
                  : 'setTimeout(()=>{},10000);';
            child = actual.spawn(process.execPath, ['-e', script], options);
            child.stdout!.on('data', (bytes: Buffer) => {
              selector.stages.stdout += bytes.length;
            });
            child.stderr!.on('data', (bytes: Buffer) => {
              selector.stages.stderr += bytes.length;
            });
            const emit = child.emit;
            child.emit = function (event: string | symbol, ...args: unknown[]): boolean {
              if (event === 'close') {
                selector.stages.closes++;
                closeHeld.resolve();
                void releaseClose.promise.then(
                  () => {
                    Reflect.apply(emit, this, [event, ...args]) as boolean;
                  },
                  () => undefined,
                );
                return true;
              }
              return Reflect.apply(emit, this, [event, ...args]) as boolean;
            };
            if (mode === 'timeout' || mode === 'no-close')
              queueMicrotask(() => longTimers.at(-1)!());
            if (mode === 'post-spawn-error')
              child.once('spawn', () => {
                child!.emit('error', new Error('fixed fixture post-spawn error'));
                child!.kill('SIGKILL');
              });
            return child;
          };
          terminalProcessFaults.spawn = hook;
          parent.abort();
          expect(ownershipModule.deferAddressTerminalAttempt(binding, attempt)).toBe(true);
          return ownershipModule.addressCancelledResult(lease);
        },
      );
      const outcome = pending.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      void outcome.then(
        () => {
          resultSettled = true;
        },
        () => {
          resultSettled = true;
        },
      );
      await closeHeld.promise;
      if (mode === 'no-close') {
        longTimers[0]!(); // Availability failure is not process settlement.
        expect(await outcome).toHaveProperty('error');
        const retry = await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run });
        await expect(retry.withLock(async () => undefined)).rejects.toThrow(
          'active or quarantined',
        );
      }
      if (mode !== 'spawn-failure') {
        if (mode !== 'no-close') expect(resultSettled).toBe(false);
        expect(await readFile(join(f.repo.root, 'src/a.ts'), 'utf8')).toBe(
          'CANCELLED partial bytes\n',
        );
        await expect(lstat(report.reportPath)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(f.repo.git('for-each-ref', '--format=%(refname)', 'refs/heads/cq-address/')).toBe(
          '',
        );
      }
      expect(used, JSON.stringify(selector.stages)).toBe(true);
      expect(selector.stages.handled).toBe(1);
      if (mode === 'stdout') expect(selector.stages.stdout).toBeGreaterThan(8 * 1024 * 1024);
      if (mode === 'stderr') expect(selector.stages.stderr).toBeGreaterThan(64 * 1024);
      releaseClose.resolve();
      const result = await outcome;
      expect(result).toHaveProperty('error');
      expect(
        (await authorityState(join(f.repo.root, '.git', 'cq-review-address-ownership.owner.json')))
          .state,
      ).not.toBe('quiescent');
      expect(await readFile(join(f.repo.root, 'src/a.ts'))).not.toEqual(baseline);
    } finally {
      releaseClose.resolve();
      timerSpy?.mockRestore();
      child?.kill('SIGKILL');
      await Promise.allSettled(pending ? [pending] : []);
      if (terminalProcessFaults.spawn === hook) terminalProcessFaults.spawn = undefined;
      await new Promise<void>((done) => setImmediate(done));
      await f.repo.cleanup();
    }
  },
);

test('pending actual writer exceeds drain bound without terminal IO and late settle cannot reopen authority', async () => {
  const f = await fixture();
  const parent = new AbortController(),
    release = deferred(),
    entered = deferred();
  const report = terminalReport(join(f.root, 'pending-terminal-report.json'));
  let writer: Promise<unknown> | undefined,
    elapsed = 0;
  const actualNow = Date.now.bind(Date);
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => actualNow() + elapsed);
  try {
    await expect(
      withAddressOwnership(
        {
          repoRoot: f.repo.root,
          git: f.run,
          source: 'local',
          production: false,
          signal: parent.signal,
        },
        async (lease) => {
          await ownershipModule.bindAddressTerminalReport(lease, report);
          writer = lease.track(async () => {
            entered.resolve();
            await release.promise;
            await writeFile(join(f.root, 'late-finally'), 'settled');
          });
          await entered.promise;
          parent.abort();
          const cancelled = ownershipModule.addressCancelledResult(lease);
          elapsed = 60_001;
          return cancelled;
        },
      ),
    ).rejects.toThrow('actual writers/control arrivals unresolved');
    await expect(lstat(report.reportPath)).rejects.toMatchObject({ code: 'ENOENT' });
    const retry = await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run });
    await expect(retry.withLock(async () => undefined)).rejects.toThrow('active or quarantined');
    release.resolve();
    await writer;
    await expect(retry.withLock(async () => undefined)).rejects.toThrow('active or quarantined');
    expect(f.repo.git('for-each-ref', '--format=%(refname)', 'refs/heads/cq-address/')).toBe('');
  } finally {
    release.resolve();
    await writer;
    clock.mockRestore();
    await f.repo.cleanup();
  }
});

test.each([false, true])(
  'closed participant stays immutable; late receipt cannot be reclaimed: %s',
  async (late) => {
    const f = await fixture();
    const parent = new AbortController();
    const closed = deferred(),
      entered = deferred(),
      arrive = deferred(),
      release = deferred(),
      secondReady = deferred();
    const reports = [
      terminalReport(join(f.root, 'closed-terminal.json')),
      terminalReport(join(f.root, 'open-terminal.json')),
    ];
    reports[0]!.reasons.push('already returned before cancellation');
    let actual: Promise<unknown> | undefined;
    const factory = vi
      .spyOn(addressModule, 'makeReviewAddress')
      .mockImplementation(() => async (input) => {
        const index = input.source === 'pr:7' ? 0 : 1;
        const result = await withAddressOwnership(
          { repoRoot: f.repo.root, git: f.run, source: input.source, production: true },
          async (lease) => {
            await ownershipModule.bindAddressTerminalReport(lease, reports[index]!);
            if (index === 0) {
              if (late) {
                const binding = ownershipModule.addressTerminalWorkerBinding(lease);
                const attempt = await ownershipModule.recordAddressTerminalAttempt(
                  binding,
                  terminalInput(f.repo),
                );
                actual = lease.track(async () => {
                  entered.resolve();
                  await release.promise;
                  ownershipModule.deferAddressTerminalAttempt(binding, attempt);
                });
                void actual.catch(() => undefined);
                await entered.promise;
              }
              await writeFile(reports[0]!.reportPath, 'immutable closed participant report');
              return {
                status: 'needs-human' as const,
                reason: 'already closed',
                report: reports[0]!,
              };
            }
            secondReady.resolve();
            await arrive.promise;
            return ownershipModule.addressCancelledResult(lease);
          },
        );
        if (index === 0) closed.resolve();
        return result;
      });
    let pending: Promise<unknown> | undefined;
    try {
      const owner = await makeAddressOwnership({
        repoRoot: f.repo.root,
        git: f.run,
        signal: parent.signal,
      });
      pending = owner.withLock(async () => {
        const first = owner.address(
          {
            pr: 7,
            head: f.prs[0].headRefOid,
            headRepo: 'fixture/base',
            headRefName: 'closed-seven',
          },
          { repoRoot: f.repo.root, source: 'pr:7' },
        );
        void first.catch(() => undefined);
        await closed.promise;
        const second = owner.address(
          { pr: 9, head: f.prs[1].headRefOid, headRepo: 'fixture/base', headRefName: 'open-nine' },
          { repoRoot: f.repo.root, source: 'pr:9' },
        );
        const outcomes = Promise.allSettled([first, second]);
        await secondReady.promise;
        parent.abort();
        arrive.resolve();
        release.resolve();
        const rows = await outcomes;
        const rejected = rows.find((row) => row.status === 'rejected');
        if (rejected?.status === 'rejected') throw rejected.reason;
        return rows;
      });
      const outcome = await pending.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      expect(await readFile(reports[0]!.reportPath, 'utf8')).toBe(
        'immutable closed participant report',
      );
      expect(reports[0]!.reasons).toEqual(['already returned before cancellation']);
      if (late) {
        expect(outcome).toHaveProperty('error');
        await expect(lstat(reports[1]!.reportPath)).rejects.toMatchObject({ code: 'ENOENT' });
        expect((await authorityState(owner.guardPath)).state).not.toBe('quiescent');
      } else {
        expect(outcome).toHaveProperty('value');
        expect(
          (JSON.parse(await readFile(reports[1]!.reportPath, 'utf8')) as ReviewAddressReport)
            .reasons,
        ).toEqual(['parent cancelled']);
      }
    } finally {
      arrive.resolve();
      release.resolve();
      await Promise.allSettled([...(actual ? [actual] : []), ...(pending ? [pending] : [])]);
      factory.mockRestore();
      await f.repo.cleanup();
    }
  },
);

test.each([
  'head',
  'index',
  'foreign-file',
  'path',
  'mode',
  'cancel-again',
  'restore-io',
  'cleanup-owner-loss',
] as const)(
  'terminal evidence guards preserve changed caller state or honest prior ref effects: %s',
  async (mode) => {
    const f = await fixture();
    const parent = new AbortController();
    const report = terminalReport(join(f.root, 'terminal-identity-report.json'));
    const before = f.repo.git('rev-parse', 'HEAD').trim();
    let expectedHead = before;
    try {
      const pending = withAddressOwnership(
        {
          repoRoot: f.repo.root,
          git: f.run,
          source: 'local',
          production: false,
          signal: parent.signal,
        },
        async (lease) => {
          await ownershipModule.bindAddressTerminalReport(lease, report);
          const binding = ownershipModule.addressTerminalWorkerBinding(lease);
          const attempt = await ownershipModule.recordAddressTerminalAttempt(
            binding,
            terminalInput(f.repo),
          );
          await writeFile(join(f.repo.root, 'src/a.ts'), 'RAW CANCELLED PARTIAL\n');
          if (mode === 'head') expectedHead = f.repo.commitAll('foreign head movement');
          if (mode === 'index') f.repo.git('add', '--', 'src/a.ts');
          if (mode === 'foreign-file')
            await writeFile(join(f.repo.root, 'README.md'), 'foreign bytes retained');
          if (mode === 'path') {
            await rename(join(f.repo.root, 'src/a.ts'), join(f.root, 'preserved-original-file'));
            await writeFile(join(f.repo.root, 'src/a.ts'), 'replacement bytes retained');
          }
          if (mode === 'mode') {
            const actual =
              await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
            await actual.chmod(join(f.repo.root, 'src/a.ts'), 0o755);
          }
          if (mode === 'restore-io')
            fsFaults.open = async (path, flags) => {
              if (
                path === join(f.repo.root, 'src/a.ts') &&
                typeof flags === 'number' &&
                flags & constants.O_WRONLY
              )
                throw new Error('terminal restore IO fault');
            };
          if (mode === 'cleanup-owner-loss')
            fsFaults.open = async (path, flags) => {
              if (
                path === join(f.repo.root, 'src/a.ts') &&
                typeof flags === 'number' &&
                flags & constants.O_WRONLY
              )
                await damageGuard(
                  join(f.repo.root, '.git', 'cq-review-address-ownership.owner.json'),
                  'replace',
                );
            };
          if (mode === 'cancel-again')
            fsFaults.open = async (path, flags) => {
              if (
                path === join(f.repo.root, 'src/a.ts') &&
                typeof flags === 'number' &&
                flags & constants.O_WRONLY
              )
                parent.abort();
            };
          parent.abort();
          expect(ownershipModule.deferAddressTerminalAttempt(binding, attempt)).toBe(true);
          return ownershipModule.addressCancelledResult(lease);
        },
      );
      if (mode === 'cancel-again') {
        const result = await pending;
        expect(result.status).toBe('needs-human');
        expect(report.failed).toHaveLength(1);
        expect(await readFile(join(f.repo.root, 'src/a.ts'), 'utf8')).toBe('export const a = 1;\n');
      } else {
        await expect(pending).rejects.toThrow(/terminal|owner|authority/);
        await expect(lstat(report.reportPath)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await readFile(join(f.repo.root, 'src/a.ts'), 'utf8')).toBe(
          mode === 'path' ? 'replacement bytes retained' : 'RAW CANCELLED PARTIAL\n',
        );
        if (mode === 'restore-io' || mode === 'cleanup-owner-loss') {
          expect(report.failed).toHaveLength(1);
          expect(f.repo.git('show', `${report.failed[0]!.sha}:src/a.ts`)).toBe(
            'RAW CANCELLED PARTIAL\n',
          );
        } else expect(report.failed).toEqual([]);
      }
      expect(f.repo.git('rev-parse', 'HEAD').trim()).toBe(expectedHead);
      expect(f.repo.git('ls-remote', '--heads', 'origin', 'terminal-fixture/*')).toBe('');
    } finally {
      fsFaults.open = undefined;
      await f.repo.cleanup();
    }
  },
);

test('RAW terminal plumbing never invokes configured clean/smudge filters or hooks', async () => {
  const f = await fixture();
  const parent = new AbortController();
  const report = terminalReport(join(f.root, 'raw-terminal-report.json'));
  const marker = join(f.root, 'forbidden-helper-marker');
  const helper = join(f.root, 'fixed-filter.cjs');
  try {
    await f.repo.write('.gitattributes', 'src/a.ts filter=terminalfixture\n');
    f.repo.commitAll('raw attribute fixture');
    await writeFile(
      helper,
      `require('node:fs').writeFileSync(${JSON.stringify(marker)},'helper invoked'); process.stdin.pipe(process.stdout);`,
    );
    f.repo.git('config', 'filter.terminalfixture.clean', `${process.execPath} ${helper}`);
    f.repo.git('config', 'filter.terminalfixture.smudge', `${process.execPath} ${helper}`);
    const hooks = join(f.root, 'configured-hooks');
    await mkdir(hooks);
    const hook = join(hooks, 'post-index-change');
    await writeFile(
      hook,
      `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)},'hook invoked');\n`,
    );
    const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    await actualFs.chmod(hook, 0o755);
    f.repo.git('config', 'core.hooksPath', hooks);
    const head = f.repo.git('rev-parse', 'HEAD').trim();
    const result = await withAddressOwnership(
      {
        repoRoot: f.repo.root,
        git: f.run,
        source: 'local',
        production: false,
        signal: parent.signal,
      },
      async (lease) => {
        await ownershipModule.bindAddressTerminalReport(lease, report);
        const binding = ownershipModule.addressTerminalWorkerBinding(lease);
        const attempt = await ownershipModule.recordAddressTerminalAttempt(
          binding,
          terminalInput(f.repo),
        );
        await writeFile(join(f.repo.root, 'src/a.ts'), 'RAW retained bytes\n');
        parent.abort();
        ownershipModule.deferAddressTerminalAttempt(binding, attempt);
        return ownershipModule.addressCancelledResult(lease);
      },
    );
    expect(result.status).toBe('needs-human');
    expect(report.failed).toHaveLength(1);
    expect(f.repo.git('cat-file', 'blob', `${report.failed[0]!.sha}:src/a.ts`)).toBe(
      'RAW retained bytes\n',
    );
    expect(await readFile(join(f.repo.root, 'src/a.ts'), 'utf8')).toBe('export const a = 1;\n');
    expect(f.repo.git('rev-parse', 'HEAD').trim()).toBe(head);
    await expect(lstat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await f.repo.cleanup();
  }
});

// Counter-bound fixtures use deterministic streams, not OS-child lifetime
// evidence. The separate fixed-Node cases above exercise real close/kill.
function boundedFixtureProcess(output: string, code = 0): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  const input = new PassThrough(),
    stdout = new PassThrough(),
    stderr = new PassThrough();
  Object.assign(child, { stdin: input, stdout, stderr, kill: () => true });
  input.resume();
  queueMicrotask(() => {
    child.emit('spawn');
    let ended = 0;
    const close = () => {
      if (++ended === 2) child.emit('close', code, null);
    };
    stdout.once('end', close);
    stderr.once('end', close);
    stdout.end(output);
    stderr.end();
  });
  return child;
}

test('late fixture finally cannot clear the next handler or consume an ordinary spawn', async () => {
  const f = await fixture(),
    oldRelease = deferred(),
    oldStarted = deferred();
  const selector = await terminalFixtureSelector(f.repo);
  const oldHook: NonNullable<typeof terminalProcessFaults.spawn> = (command, args, options) => {
    if (!selector.select(command, args, options)) return;
    throw new Error('old hook must not be dispatched');
  };
  const newHook: NonNullable<typeof terminalProcessFaults.spawn> = () => undefined;
  const old = (async () => {
    terminalProcessFaults.spawn = oldHook;
    oldStarted.resolve();
    try {
      await oldRelease.promise;
    } finally {
      if (terminalProcessFaults.spawn === oldHook) terminalProcessFaults.spawn = undefined;
    }
  })();
  try {
    await oldStarted.promise;
    expect(oldHook('git', ['rev-parse', 'HEAD'], { cwd: f.repo.root })).toBeUndefined();
    expect(oldHook('/unrelated/git', [], { cwd: '/unrelated' })).toBeUndefined();
    expect(selector.stages.selected).toBe(0);
    terminalProcessFaults.spawn = newHook;
    oldRelease.resolve();
    await old;
    expect(terminalProcessFaults.spawn).toBe(newHook);
  } finally {
    oldRelease.resolve();
    await old;
    if (terminalProcessFaults.spawn === newHook) terminalProcessFaults.spawn = undefined;
    await f.repo.cleanup();
  }
});

test.each(['commands', 'ref-creations'] as const)(
  'terminal helper work has a finite per-receipt bound: %s',
  async (bound) => {
    const f = await fixture();
    const parent = new AbortController();
    const report = terminalReport(join(f.root, 'terminal-command-bound.json'));
    const selector = await terminalFixtureSelector(f.repo);
    let hook: typeof terminalProcessFaults.spawn, pending: Promise<unknown> | undefined;
    let updates = 0,
      shows = 0;
    try {
      pending = withAddressOwnership(
        {
          repoRoot: f.repo.root,
          git: f.run,
          source: 'local',
          production: false,
          signal: parent.signal,
        },
        async (lease) => {
          await ownershipModule.bindAddressTerminalReport(lease, report);
          const binding = ownershipModule.addressTerminalWorkerBinding(lease);
          const input = terminalInput(f.repo);
          const attempt = await ownershipModule.recordAddressTerminalAttempt(binding, input);
          await writeFile(join(f.repo.root, 'src/a.ts'), 'BOUNDED PARTIAL\n');
          hook = (command, rawArgs, options) => {
            const args = selector.select(command, rawArgs, options);
            if (!args) return;
            if (bound === 'commands') {
              if (
                args.length === 3 &&
                args[0] === 'for-each-ref' &&
                args[1] === '--format=%(refname)' &&
                args[2]!.startsWith('refs/heads/terminal-fixture/failed/')
              ) {
                const base = args.at(-1)!;
                return boundedFixtureProcess(
                  Array.from({ length: 600 }, (_, index) => `${base}a${index + 1}`).join('\n'),
                );
              }
              if (
                args.length === 4 &&
                args[0] === 'show' &&
                args[1] === '-s' &&
                args[2] === '--format=%B' &&
                args[3]!.startsWith('refs/heads/terminal-fixture/failed/')
              ) {
                shows++;
                const identity = Buffer.from(
                  JSON.stringify(['review', input.slug, input.finding]),
                ).toString('base64url');
                return boundedFixtureProcess(`Cq-Ref-Identity: ${identity}\n`);
              }
            } else {
              if (
                args.length === 4 &&
                args[0] === 'update-ref' &&
                args[1]!.startsWith('refs/heads/terminal-fixture/failed/')
              ) {
                updates++;
                return boundedFixtureProcess('', 1);
              }
              if (
                args.length === 3 &&
                args[0] === 'rev-parse' &&
                args[1] === '--verify' &&
                args[2]!.startsWith('refs/heads/terminal-fixture/failed/')
              )
                return boundedFixtureProcess(`${input.parent}\n`);
            }
            return undefined;
          };
          terminalProcessFaults.spawn = hook;
          parent.abort();
          ownershipModule.deferAddressTerminalAttempt(binding, attempt);
          return ownershipModule.addressCancelledResult(lease);
        },
      );
      await expect(
        pending,
        JSON.stringify({ shows, updates, stages: selector.stages }),
      ).rejects.toThrow(bound === 'commands' ? 'command/time bound' : 'branch collision limit');
      if (bound === 'commands') {
        expect(shows).toBeGreaterThan(400);
        expect(shows).toBeLessThan(512);
        expect(selector.stages.selected).toBe(512);
      } else expect(updates).toBe(32);
      expect(report.failed).toEqual([]);
      expect(await readFile(join(f.repo.root, 'src/a.ts'), 'utf8')).toBe('BOUNDED PARTIAL\n');
      await expect(lstat(report.reportPath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(
        f.repo.git('for-each-ref', '--format=%(refname)', 'refs/heads/terminal-fixture/'),
      ).toBe('');
    } finally {
      await Promise.allSettled(pending ? [pending] : []);
      if (terminalProcessFaults.spawn === hook) terminalProcessFaults.spawn = undefined;
      await f.repo.cleanup();
    }
  },
);

// Real file writes/closes complete before these gates; parent cancellation
// cannot substitute an outer promise for the registered descriptor lifetime.
test.each(['write', 'close', 'close-failure', 'preexisting', 'tampered'] as const)(
  'ordinary report materialization and terminal adoption: %s',
  async (mode) => {
    const f = await fixture(),
      parent = new AbortController();
    const report = terminalReport(join(f.root, 'materialized-report.json'));
    const originalBytes = JSON.stringify(report, null, 2) + '\n';
    const reached = deferred(),
      release = deferred(),
      cancelled = deferred();
    parent.signal.addEventListener('abort', () => cancelled.resolve(), { once: true });
    let pending: Promise<unknown> | undefined,
      returned = false;
    try {
      if (mode === 'preexisting') await writeFile(report.reportPath, 'ordinary old report');
      pending = withAddressOwnership(
        {
          repoRoot: f.repo.root,
          git: f.run,
          source: 'local',
          production: false,
          signal: parent.signal,
        },
        async (lease) => {
          await ownershipModule.bindAddressTerminalReport(lease, report);
          if (mode === 'write' || mode === 'close' || mode === 'close-failure') {
            let used = false;
            const gate = async (path: string) => {
              if (path !== report.reportPath || used) return;
              used = true;
              reached.resolve();
              await release.promise;
              if (mode === 'close-failure') throw new Error('actual report close rejected');
            };
            if (mode === 'write') fsFaults.write = gate;
            else fsFaults.close = gate;
          }
          const normal = ownershipModule.addressOwnedEvidence(lease, {
            kind: 'report',
            path: report.reportPath,
            report,
          });
          void normal.catch(() => undefined);
          if (mode === 'preexisting' || mode === 'tampered') {
            await normal;
            if (mode === 'tampered') await writeFile(report.reportPath, 'foreign report bytes');
            reached.resolve();
            await release.promise;
          }
          // This control is deliberately outside the tracked normal writer.
          await cancelled.promise;
          const arrival = ownershipModule.addressCancelledResult(lease);
          await normal.catch(() => undefined);
          return arrival;
        },
      );
      void pending.then(
        () => {
          returned = true;
        },
        () => {
          returned = true;
        },
      );
      await reached.promise;
      parent.abort();
      await Promise.resolve();
      expect(returned).toBe(false);
      expect(f.repo.git('for-each-ref', '--format=%(refname)', 'refs/heads/cq-address/')).toBe('');
      release.resolve();
      if (mode === 'write' || mode === 'close') {
        const result = (await pending) as { status: string };
        expect(result.status).toBe('needs-human');
        const persistedReport: unknown = JSON.parse(await readFile(report.reportPath, 'utf8'));
        if (
          typeof persistedReport !== 'object' ||
          persistedReport === null ||
          !('reasons' in persistedReport)
        )
          throw new Error('persisted report missing reasons');
        expect(persistedReport.reasons).toContain('parent cancelled');
      } else {
        await expect(pending).rejects.toThrow(/report|terminal/);
        const bytes = await readFile(report.reportPath, 'utf8');
        expect(bytes).toBe(mode === 'tampered' ? 'foreign report bytes' : originalBytes);
      }
    } finally {
      release.resolve();
      await pending?.catch(() => undefined);
      fsFaults.write = undefined;
      fsFaults.close = undefined;
      await f.repo.cleanup();
    }
  },
);

test.each(['valid', 'tampered', 'unknown'] as const)(
  'unignored bookkeeping needs an exact authenticated revision before any restore: %s',
  async (mode) => {
    const f = await fixture(),
      parent = new AbortController();
    const report = terminalReport(join(f.root, 'bookkeeping-report.json'));
    const baseline = await readFile(join(f.repo.root, 'src/a.ts'));
    const artifact = join(f.repo.root, '.cq', 'receipt.json');
    let pending: Promise<unknown> | undefined;
    try {
      pending = withAddressOwnership(
        {
          repoRoot: f.repo.root,
          git: f.run,
          source: 'local',
          production: false,
          signal: parent.signal,
        },
        async (lease) => {
          await ownershipModule.bindAddressTerminalReport(lease, report);
          const binding = ownershipModule.addressTerminalWorkerBinding(lease);
          const attempt = await ownershipModule.recordAddressTerminalAttempt(
            binding,
            terminalInput(f.repo),
          );
          await mkdir(dirname(artifact), { recursive: true });
          await writeFile(artifact, 'trusted receipt');
          if (mode !== 'unknown') {
            const hash = (await ownershipModule.addressOwnedEvidence(lease, {
              kind: 'hash',
              path: artifact,
            })) as string;
            await ownershipModule.addressOwnedEvidence(lease, {
              kind: 'bookkeeping',
              root: f.repo.root,
              entries: [[artifact, hash]],
            });
          }
          if (mode === 'tampered') await writeFile(artifact, 'foreign later bytes');
          await writeFile(join(f.repo.root, 'src/a.ts'), 'CANCELLED raw edit\n');
          parent.abort();
          expect(ownershipModule.deferAddressTerminalAttempt(binding, attempt)).toBe(true);
          return ownershipModule.addressCancelledResult(lease);
        },
      );
      if (mode === 'valid') {
        const result = (await pending) as { status: string };
        expect(result.status).toBe('needs-human');
        expect(await readFile(join(f.repo.root, 'src/a.ts'))).toEqual(baseline);
        expect(report.failed).toHaveLength(1);
        expect(f.repo.git('show', `${report.failed[0]!.branch}:src/a.ts`)).toBe(
          'CANCELLED raw edit\n',
        );
      } else {
        await expect(pending).rejects.toThrow(/bookkeeping|untracked/);
        expect(await readFile(join(f.repo.root, 'src/a.ts'), 'utf8')).toBe('CANCELLED raw edit\n');
        expect(f.repo.git('for-each-ref', '--format=%(refname)', 'refs/heads/cq-address/')).toBe(
          '',
        );
        await expect(lstat(report.reportPath)).rejects.toMatchObject({ code: 'ENOENT' });
      }
      expect(await readFile(artifact, 'utf8')).toBe(
        mode === 'tampered' ? 'foreign later bytes' : 'trusted receipt',
      );
    } finally {
      await pending?.catch(() => undefined);
      await f.repo.cleanup();
    }
  },
);

test.each(['healthy', 'foreign'] as const)(
  'identity checks serialize with an awaited child claim and fence failed successors: %s',
  async (mode) => {
    const f = await fixture();
    const owner = await makeAddressOwnership({ repoRoot: f.repo.root, git: f.run });
    const reached = deferred(),
      release = deferred();
    let dispatched = 0;
    const factory = vi
      .spyOn(addressModule, 'makeReviewAddress')
      .mockImplementation(() => async () => {
        dispatched++;
        return { status: 'needs-human', reason: 'identity FIFO fixture' };
      });
    try {
      const work = owner.withLock(async () => {
        let used = false;
        fsFaults.open = async (path) => {
          if (path !== owner.guardPath || used) return;
          used = true;
          reached.resolve();
          await release.promise;
        };
        const checking = owner.assertOwned();
        void checking.catch(() => undefined);
        await reached.promise;
        const child = owner.address(
          { pr: 7, head: f.prs[0].headRefOid, headRepo: 'fixture/base', headRefName: 'seven' },
          { repoRoot: f.repo.root, source: 'pr:7' },
        );
        void child.catch(() => undefined);
        if (mode === 'foreign') {
          await rename(owner.guardPath, `${owner.guardPath}.preserved`);
          await writeFile(owner.guardPath, 'foreign exact bytes');
        }
        expect(dispatched).toBe(0);
        release.resolve();
        await checking;
        await child;
      });
      if (mode === 'healthy') {
        await work;
        expect(dispatched).toBe(1);
      } else {
        await expect(work).rejects.toThrow(/owner|quarantine/);
        expect(dispatched).toBe(0);
        expect(await readFile(owner.guardPath, 'utf8')).toBe('foreign exact bytes');
      }
    } finally {
      release.resolve();
      fsFaults.open = undefined;
      factory.mockRestore();
      await f.repo.cleanup();
    }
  },
);

test.each(['candidates', 'bookkeeping-count', 'bookkeeping-file', 'bookkeeping-stream'] as const)(
  'artifact capacity is cumulative and cannot authorize cleanup: %s',
  async (mode) => {
    const f = await fixture();
    const report = terminalReport(join(f.root, 'artifact-bound.json'));
    try {
      await expect(
        withAddressOwnership(
          { repoRoot: f.repo.root, git: f.run, source: 'local', production: false },
          async (lease) => {
            await ownershipModule.bindAddressTerminalReport(lease, report);
            if (mode === 'candidates') {
              const binding = ownershipModule.addressTerminalWorkerBinding(lease);
              const input = terminalInput(f.repo);
              await ownershipModule.recordAddressTerminalAttempt(binding, input);
              for (let index = 0; index < 129; index++)
                await ownershipModule.addressWorkerEvidence(binding, {
                  kind: 'candidate-intent',
                  root: f.repo.root,
                  path: join(f.root, `candidate-${randomUUID()}`),
                  parent: input.parent,
                  file: input.file,
                });
            } else if (mode === 'bookkeeping-count') {
              await ownershipModule.addressOwnedEvidence(lease, {
                kind: 'bookkeeping',
                root: f.repo.root,
                entries: Array.from(
                  { length: 257 },
                  (_, index) => [join(f.repo.root, `artifact-${index}`), 'unused'] as const,
                ),
              });
            } else {
              const path = join(f.root, 'streamed-bookkeeping');
              await writeFile(
                path,
                Buffer.alloc(mode === 'bookkeeping-file' ? 8 * 1024 * 1024 + 1 : 4 * 1024 * 1024),
              );
              // Repeated verification reserves bytes again: no revision refund.
              for (let index = 0; index < 5; index++)
                await ownershipModule.addressOwnedEvidence(lease, { kind: 'hash', path });
            }
            throw new Error('capacity failed to refuse');
          },
        ),
      ).rejects.toThrow(/capacity/);
      await expect(lstat(report.reportPath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(f.repo.git('for-each-ref', '--format=%(refname)', 'refs/heads/cq-address/')).toBe('');
      expect(f.repo.git('worktree', 'list', '--porcelain')).not.toContain('candidate-');
    } finally {
      await f.repo.cleanup();
    }
  },
);

test.each(['intact', 'changed-candidate'] as const)(
  'combined source/candidate/bookkeeping/report admission waits for every actual sibling: %s',
  async (mode) => {
    const f = await fixture(),
      parent = new AbortController();
    const report = terminalReport(join(f.root, 'combined-report.json'));
    const candidate = join(f.root, `candidate-${randomUUID()}`);
    const baseline = await readFile(join(f.repo.root, 'src/a.ts'));
    const ready = deferred(),
      release = deferred(),
      cancelled = deferred();
    parent.signal.addEventListener('abort', () => cancelled.resolve(), { once: true });
    let work: Promise<unknown> | undefined,
      writer: Promise<unknown> | undefined,
      returned = false;
    try {
      work = withAddressOwnership(
        {
          repoRoot: f.repo.root,
          git: f.run,
          source: 'local',
          production: false,
          signal: parent.signal,
        },
        async (lease) => {
          await ownershipModule.bindAddressTerminalReport(lease, report);
          await ownershipModule.addressOwnedEvidence(lease, {
            kind: 'report',
            path: report.reportPath,
            report,
          });
          const binding = ownershipModule.addressTerminalWorkerBinding(lease),
            input = terminalInput(f.repo);
          const attempt = await ownershipModule.recordAddressTerminalAttempt(binding, input);
          const handle = (await ownershipModule.addressWorkerEvidence(binding, {
            kind: 'candidate-intent',
            root: f.repo.root,
            path: candidate,
            parent: input.parent,
            file: input.file,
          })) as object;
          f.repo.git('worktree', 'add', '--detach', candidate, input.parent);
          await ownershipModule.addressWorkerEvidence(binding, {
            kind: 'candidate-created',
            handle,
          });
          await ownershipModule.addressWorkerEvidence(binding, {
            kind: 'candidate-baseline',
            handle,
          });
          const content = Buffer.from('combined cancelled bytes\n');
          await writeFile(join(candidate, input.file), content);
          f.repo.git('-C', candidate, 'add', '--', input.file);
          await ownershipModule.addressWorkerEvidence(binding, {
            kind: 'candidate-stage',
            handle,
            content,
          });
          await writeFile(join(f.repo.root, input.file), content);
          writer = lease.track(async () => {
            ready.resolve();
            try {
              await release.promise;
            } finally {
              // An actual sibling finally produces this engine-owned artifact.
              const path = join(f.repo.root, '.cq', 'actual-sibling.json');
              await mkdir(dirname(path), { recursive: true });
              await writeFile(path, 'actual sibling settled');
              const hash = (await ownershipModule.addressOwnedEvidence(lease, {
                kind: 'hash',
                path,
              })) as string;
              await ownershipModule.addressOwnedEvidence(lease, {
                kind: 'bookkeeping',
                root: f.repo.root,
                entries: [[path, hash]],
              });
            }
          });
          void writer.catch(() => undefined);
          await cancelled.promise;
          expect(ownershipModule.deferAddressTerminalAttempt(binding, attempt)).toBe(true);
          expect(ownershipModule.deferAddressCandidateCleanup(binding, handle)).toBe(true);
          return ownershipModule.addressCancelledResult(lease);
        },
      );
      void work.then(
        () => {
          returned = true;
        },
        () => {
          returned = true;
        },
      );
      await ready.promise;
      if (mode === 'changed-candidate')
        await writeFile(join(candidate, 'README.md'), 'foreign candidate bytes');
      parent.abort();
      await Promise.resolve();
      expect(returned).toBe(false);
      expect(await readFile(join(f.repo.root, 'src/a.ts'), 'utf8')).toBe(
        'combined cancelled bytes\n',
      );
      expect(f.repo.git('worktree', 'list', '--porcelain')).toContain(candidate);
      expect(f.repo.git('for-each-ref', '--format=%(refname)', 'refs/heads/cq-address/')).toBe('');
      expect(await readFile(report.reportPath, 'utf8')).not.toContain('parent cancelled');
      release.resolve();
      if (mode === 'intact') {
        expect(((await work) as { status: string }).status).toBe('needs-human');
        expect(await readFile(join(f.repo.root, 'src/a.ts'))).toEqual(baseline);
        expect(f.repo.git('worktree', 'list', '--porcelain')).not.toContain(candidate);
        expect(report.failed).toHaveLength(1);
      } else {
        await expect(work).rejects.toThrow(/candidate/);
        expect(await readFile(join(f.repo.root, 'src/a.ts'), 'utf8')).toBe(
          'combined cancelled bytes\n',
        );
        expect(await readFile(join(candidate, 'README.md'), 'utf8')).toBe(
          'foreign candidate bytes',
        );
        expect(f.repo.git('for-each-ref', '--format=%(refname)', 'refs/heads/cq-address/')).toBe(
          '',
        );
        expect(await readFile(report.reportPath, 'utf8')).not.toContain('parent cancelled');
      }
      expect(await readFile(join(f.repo.root, '.cq', 'actual-sibling.json'), 'utf8')).toBe(
        'actual sibling settled',
      );
    } finally {
      parent.abort();
      release.resolve();
      await writer?.catch(() => undefined);
      await work?.catch(() => undefined);
      await f.repo.cleanup();
    }
  },
);
