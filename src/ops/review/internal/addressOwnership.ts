import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { lstat, open, readFile, realpath, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { GhFn } from '../../../adapters/forge-github/gh.js';
import { fileWorktreeRegistry, reviewBranchFor } from '../../../adapters/git/prWorktree.js';
import { makeGitMutex } from '../../../shared/gitMutex.js';
import type { ReviewAddressInput, ReviewAddressResult } from '../address.js';
import type { ReviewLoopOpts, ReviewLoopOutcome } from '../../../plans/review-loop.js';

/** No capability is serialized or accepted from an op input or dependency object. */
const childContext = new AsyncLocalStorage<Child>();
const liveLeases = new WeakMap<AddressLease, AddressOwnership>();
const loopContext = new AsyncLocalStorage<{ lease: AddressLease; consumed: boolean }>();

export interface AddressSelection {
  pr: number;
  head: string;
  headRepo: string;
  headRefName: string;
}

interface Guard {
  version: 1;
  epoch: string;
  state: 'active' | 'settled' | 'quarantined';
  resources: string[];
}

interface Child {
  owner: AddressOwnership;
  selection: AddressSelection;
  consumed: boolean;
  keys: Set<string>;
  tasks: Set<Promise<unknown>>;
}

export interface AddressLease {
  signal: AbortSignal;
  expectedHead?: string;
  registry?: ReturnType<typeof fileWorktreeRegistry>;
  assertOwned(): Promise<void>;
  /** Track actual work even when an outer governor abandons its promise. */
  track<T>(action: () => Promise<T>): Promise<T>;
  /** Called before resolution, including before stale checkout removal. */
  assertSelection(selection: Omit<AddressSelection, 'head'>): Promise<void>;
  /** Confirms canonical checkout and administrative git-dir before driver work. */
  claimCheckout(info: { path: string; branch: string; head: string }): Promise<void>;
}

interface OwnershipOptions {
  repoRoot: string;
  git: GhFn;
  controller?: AbortController;
  signal?: AbortSignal;
}

async function gitText(git: GhFn, root: string, args: string[]): Promise<string> {
  const result = await git(['-C', root, ...args]);
  if (result.code !== 0 || !result.stdout.trim())
    throw new Error('address ownership: Git identity unavailable');
  return result.stdout.trim();
}

/** Canonical bootstrap is read-only and precedes admission. */
async function commonDirectory(opts: OwnershipOptions): Promise<string> {
  return realpath(
    resolve(
      opts.repoRoot,
      await gitText(opts.git, opts.repoRoot, [
        'rev-parse',
        '--path-format=absolute',
        '--git-common-dir',
      ]),
    ),
  );
}

function resourceKeys(selection: AddressSelection): string[] {
  if (
    !Number.isSafeInteger(selection.pr) ||
    selection.pr < 1 ||
    !/^[a-f0-9]{40,64}$/.test(selection.head) ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(selection.headRepo) ||
    !selection.headRefName ||
    selection.headRefName.startsWith('-') ||
    /[\s~^:?*\[\\]/.test(selection.headRefName) ||
    [...selection.headRefName].some(
      (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
    ) ||
    selection.headRefName.includes('..') ||
    selection.headRefName.includes('@{')
  )
    throw new Error('address ownership: invalid selection identity');
  return [
    `branch:refs/heads/${reviewBranchFor(selection.pr)}`,
    `remote:${selection.headRepo.toLowerCase()}:refs/heads/${selection.headRefName}`,
  ].sort();
}

/**
 * One common-dir lifetime owner. Lock order: owner -> resource set -> registry.
 * Active guard files are NEVER reclaimed using time or process liveness. Recovery
 * requires attended positive quiescence evidence, outside this API. Old binaries
 * which ignore the guard must not overlap deployment of this coordinator.
 */
export class AddressOwnership {
  readonly registry;
  readonly signal: AbortSignal;
  readonly guardPath: string;
  private readonly controller: AbortController;
  private readonly epoch = randomUUID();
  private readonly claims = new Map<string, Child>();
  private readonly children = new Set<Promise<unknown>>();
  private readonly tasks = new Set<Promise<unknown>>();
  private readonly recorded = new Set<string>();
  private active = false;
  private used = false;
  private admitting = false;
  private compromised = false;
  private writeTail: Promise<void> = Promise.resolve();
  private artifact?: { ino: number; dev: number };

  constructor(
    private readonly opts: OwnershipOptions,
    readonly commonDir: string,
  ) {
    this.controller = opts.controller ?? new AbortController();
    this.signal = opts.signal
      ? AbortSignal.any([opts.signal, this.controller.signal])
      : this.controller.signal;
    this.guardPath = resolve(commonDir, 'cq-review-address-ownership.owner.json');
    this.registry = fileWorktreeRegistry(resolve(commonDir, 'cq-review-address-worktrees.json'));
  }

  private async guard(): Promise<Guard | undefined> {
    try {
      const stat = await lstat(this.guardPath);
      if (!stat.isFile() || stat.nlink !== 1) throw new Error('unsafe guard file');
      const value = JSON.parse(await readFile(this.guardPath, 'utf8')) as Guard;
      if (
        value.version !== 1 ||
        typeof value.epoch !== 'string' ||
        !['active', 'settled', 'quarantined'].includes(value.state) ||
        !Array.isArray(value.resources) ||
        value.resources.some((key) => typeof key !== 'string')
      )
        throw new Error('invalid guard');
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new Error('address ownership: unreadable guard; quarantined', { cause: error });
    }
  }

  private persist(state: Guard['state']): Promise<void> {
    const write = this.writeTail.then(async () => {
      const temporary = `${this.guardPath}.${this.epoch}.${randomUUID()}.tmp`;
      const file = await open(temporary, 'wx', 0o600);
      try {
        await file.writeFile(
          JSON.stringify({
            version: 1,
            epoch: this.epoch,
            state,
            resources: [...this.recorded].sort(),
          } satisfies Guard),
        );
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, this.guardPath);
      const directory = await open(this.commonDir, 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    });
    this.writeTail = write;
    return write;
  }

  private lose(error: unknown): never {
    this.compromised = true;
    this.admitting = false;
    this.controller.abort(error);
    throw new Error('address ownership: lost owner; quarantined', { cause: error });
  }

  private async assertIdentity(): Promise<void> {
    if (!this.active || this.compromised) throw new Error('address ownership: owner inactive');
    try {
      const [guard, artifact] = await Promise.all([
        this.guard(),
        lstat(resolve(this.commonDir, 'cq-review-address-ownership.lock')),
      ]);
      if (
        guard?.epoch !== this.epoch ||
        guard.state !== 'active' ||
        artifact.ino !== this.artifact?.ino ||
        artifact.dev !== this.artifact.dev
      )
        throw new Error('ownership guard or lock changed');
      if (!this.active || this.compromised) throw new Error('owner no longer active');
    } catch (error) {
      this.lose(error);
    }
  }

  async assertOwned(): Promise<void> {
    if (!this.active || this.compromised) throw new Error('address ownership: owner inactive');
    this.signal.throwIfAborted();
    await this.assertIdentity();
    this.signal.throwIfAborted();
  }

  async withLock<T>(fn: (owner: AddressOwnership) => Promise<T>): Promise<T> {
    if (this.used) throw new Error('address ownership: owner lifetime already consumed');
    const before = await this.guard();
    if (before && before.state !== 'settled')
      throw new Error('address ownership: active or quarantined guard; attended recovery required');
    return makeGitMutex({
      lockPath: resolve(this.commonDir, 'cq-review-address-ownership'),
      failFast: true,
    }).withLock(async () => {
      const previous = await this.guard();
      if (previous && previous.state !== 'settled')
        throw new Error(
          'address ownership: active or quarantined guard; attended recovery required',
        );
      this.signal.throwIfAborted();
      if (this.used) throw new Error('address ownership: owner lifetime already consumed');
      this.used = true;
      this.artifact = await lstat(resolve(this.commonDir, 'cq-review-address-ownership.lock'));
      // Must be durable BEFORE a driver, worktree mutation, or child can start.
      await this.persist('active');
      this.active = this.admitting = true;
      let checking: Promise<void> | undefined;
      const timer = setInterval(() => {
        if (checking) return;
        checking = this.assertOwned()
          .catch(() => undefined)
          .finally(() => {
            checking = undefined;
          });
      }, 250);
      timer.unref();
      try {
        const result = await fn(this);
        this.admitting = false;
        if (this.children.size || this.tasks.size)
          throw new Error('address ownership: detached work requires quarantine');
        clearInterval(timer);
        await checking;
        // Parent cancellation stops dispatch, never the physical exclusion.
        // Only true quiescence plus intact ownership allows a clean release.
        await this.assertIdentity();
        this.controller.signal.throwIfAborted();
        await this.persist('settled');
        return result;
      } catch (error) {
        this.admitting = false;
        this.controller.abort(error);
        // The durable quarantine keeps the exclusion even if a driver ignores
        // cancellation indefinitely. Later settlement never clears this marker.
        // Preserve a replaced/corrupt guard as evidence. Never overwrite a
        // different epoch while handling ownership loss.
        if ((await this.guard().catch(() => undefined))?.epoch === this.epoch)
          await this.persist('quarantined').catch(() => undefined);
        throw error;
      } finally {
        clearInterval(timer);
        this.active = false;
      }
    }, this.signal);
  }

  /**
   * Complete sorted claims are taken without waiting. A conflict refuses before
   * driver dispatch; the bulk executor may requeue after the conflicting child.
   * No caller-provided implementation receives a permit.
   */
  address(selection: AddressSelection, input: ReviewAddressInput): Promise<ReviewAddressResult> {
    selection = Object.freeze({ ...selection });
    input = Object.freeze({ ...input });
    const child: Child = {
      owner: this,
      selection,
      consumed: false,
      keys: new Set(),
      tasks: new Set(),
    };
    const work = (async () => {
      if (!this.admitting) throw new Error('address ownership: admissions closed');
      if (input.source !== `pr:${selection.pr}`)
        throw new Error('address ownership: child source mismatch');
      await this.assertOwned();
      const keys = resourceKeys(selection);
      this.claim(child, keys);
      try {
        await this.persist('active');
        await this.assertOwned();
        return await childContext.run(child, async () => {
          const { makeReviewAddress } = await import('../address.js');
          return makeReviewAddress()(input);
        });
      } finally {
        while (child.tasks.size) await Promise.allSettled([...child.tasks]);
        for (const key of child.keys) this.claims.delete(key);
      }
    })();
    this.children.add(work);
    // Observe both outcomes even if the caller neglects to await a child.
    void work.then(
      () => this.children.delete(work),
      () => this.children.delete(work),
    );
    return work;
  }

  private claim(child: Child, keys: string[]): void {
    const complete = [...new Set([...child.keys, ...keys])].sort();
    if (complete.some((key) => this.claims.has(key) && this.claims.get(key) !== child))
      throw new Error('address ownership: conflicting child resource');
    // Replace the COMPLETE set in one synchronous section. No lower-order
    // discovered key is awaited while holding a later provisional key.
    for (const key of child.keys) this.claims.delete(key);
    for (const key of complete) {
      this.claims.set(key, child);
      child.keys.add(key);
      this.recorded.add(key);
    }
  }

  lease(child?: Child): AddressLease {
    if (!this.active || this.compromised) throw new Error('address ownership: owner inactive');
    const lease: AddressLease = {
      signal: this.signal,
      ...(child ? { expectedHead: child.selection.head, registry: this.registry } : {}),
      assertOwned: () => this.assertOwned(),
      track: (action) => {
        // Register synchronously, before asynchronous ownership checks: an
        // unawaited caller cannot finish the owner during this admission gap.
        const task = (async () => {
          await this.assertOwned();
          return action();
        })();
        this.tasks.add(task);
        child?.tasks.add(task);
        const settled = () => {
          this.tasks.delete(task);
          child?.tasks.delete(task);
        };
        void task.then(settled, settled);
        return task;
      },
      assertSelection: async (selection) => {
        await this.assertOwned();
        if (
          child &&
          (selection.pr !== child.selection.pr ||
            selection.headRepo.toLowerCase() !== child.selection.headRepo.toLowerCase() ||
            selection.headRefName !== child.selection.headRefName)
        )
          throw new Error('address ownership: forge selection changed');
      },
      claimCheckout: async (info) => {
        await this.assertOwned();
        if (!child) return;
        if (
          info.branch !== reviewBranchFor(child.selection.pr) ||
          info.head !== child.selection.head
        )
          throw new Error('address ownership: resolved identity changed');
        const root = await realpath(info.path);
        const common = await commonDirectory({ repoRoot: root, git: this.opts.git });
        const gitDir = await realpath(
          resolve(
            root,
            await gitText(this.opts.git, root, [
              'rev-parse',
              '--path-format=absolute',
              '--git-dir',
            ]),
          ),
        );
        const branch = await gitText(this.opts.git, root, ['symbolic-ref', 'HEAD']);
        if (
          common !== this.commonDir ||
          branch !== `refs/heads/${info.branch}` ||
          (await gitText(this.opts.git, root, ['rev-parse', 'HEAD'])) !== info.head
        )
          throw new Error('address ownership: checkout identity changed');
        this.claim(child, [`checkout:${root}`, `git-dir:${gitDir}`]);
        await this.persist('active');
      },
    };
    liveLeases.set(lease, this);
    return lease;
  }
}

/** Only an authentic live address lease can mint a single-use loop invocation. */
export async function runAddressReviewLoop(
  lease: AddressLease,
  opts: ReviewLoopOpts,
): Promise<ReviewLoopOutcome> {
  const owner = liveLeases.get(lease);
  if (!owner) throw new Error('address ownership: forged loop lease');
  await lease.assertOwned();
  if ((await commonDirectory(opts)) !== owner.commonDir)
    throw new Error('address ownership: loop identity changed');
  return loopContext.run({ lease, consumed: false }, async () => {
    const { runReviewLoop } = await import('../../../plans/review-loop.js');
    return runReviewLoop(opts);
  });
}

export async function withReviewLoopOwnership<T>(
  opts: OwnershipOptions,
  fn: (lease: AddressLease) => Promise<T>,
): Promise<T> {
  const context = loopContext.getStore();
  if (context) {
    // Consume before ANY await: simultaneous or nested exported calls cannot
    // borrow an invocation, including callbacks running in inherited ALS.
    if (context.consumed) throw new Error('address ownership: loop permit already consumed');
    context.consumed = true;
    const owner = liveLeases.get(context.lease);
    if (!owner || (await commonDirectory(opts)) !== owner.commonDir)
      throw new Error('address ownership: invalid loop permit');
    await context.lease.assertOwned();
    return fn(context.lease);
  }
  return withAddressOwnership({ ...opts, source: 'local', production: false }, fn);
}

export async function makeAddressOwnership(opts: OwnershipOptions): Promise<AddressOwnership> {
  return new AddressOwnership(opts, await commonDirectory(opts));
}

/** Signal is available BEFORE the address factory constructs workers/reviewers. */
export function addressChildSignal(): AbortSignal | undefined {
  return childContext.getStore()?.owner.signal;
}

export async function withAddressOwnership<T>(
  opts: OwnershipOptions & { source: string; production: boolean },
  fn: (lease: AddressLease) => Promise<T>,
): Promise<T> {
  const child = childContext.getStore();
  if (child) {
    if (!opts.production || child.consumed || opts.source !== `pr:${child.selection.pr}`)
      throw new Error('address ownership: invalid production child permit');
    child.consumed = true;
    if ((await commonDirectory(opts)) !== child.owner.commonDir)
      throw new Error('address ownership: invalid production child identity');
    await child.owner.assertOwned();
    return fn(child.owner.lease(child));
  }
  const owner = await makeAddressOwnership(opts);
  return owner.withLock(async () => fn(owner.lease()));
}
