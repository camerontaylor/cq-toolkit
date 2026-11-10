import { acquireSlot } from '../../../adapters/lock/slotLock.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { lstat, realpath, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  AddressRunLifecycle,
  addressRunLeaseAuthority,
  type AddressLease,
  type AddressSelection,
} from './addressRunLifecycle.js';
import { CheckoutWriterContext } from '../../../shared/checkoutWriterContext.js';
import { slotWorktreeRegistry } from '../../../adapters/git/slotWorktreeRegistry.js';
import { readLegacyReviewHint } from '../../../adapters/git/legacyReviewRegistry.js';
import { isPrWorktreeIncompleteRefusal } from '../../../adapters/git/prWorktree.js';
import type { GhFn } from '../../../adapters/forge-github/gh.js';
import type { ReviewLoopOpts, ReviewLoopOutcome } from '../../../plans/review-loop.js';
export * from './addressRunLifecycle.js';

interface Options {
  repoRoot: string;
  git: GhFn;
  signal?: AbortSignal;
  controller?: AbortController;
  coordinationRoot?: string;
  legacySources?: readonly string[];
  expectedHead?: string;
  bootstrapGitDir?: string;
}
const loopContext = new AsyncLocalStorage<{ lease: AddressLease; consumed: boolean }>();
const refusals = new WeakSet<object>();
const incompleteRefusals = new WeakSet<object>();
const bulkContext = new AsyncLocalStorage<{
  context: CheckoutWriterContext;
  pr: number;
  consumed: boolean;
  settled: boolean;
  retained: CheckoutWriterContext[];
}>();
export function isAddressCheckoutIncomplete(value: unknown): boolean {
  return (
    (typeof value === 'object' && value !== null && incompleteRefusals.has(value)) ||
    isPrWorktreeIncompleteRefusal(value)
  );
}
export function isAddressOwnershipAdmissionRefusal(value: unknown): boolean {
  return typeof value === 'object' && value !== null && refusals.has(value);
}
async function gitText(opts: Options, root: string, args: string[]): Promise<string> {
  const result = await opts.git(['-C', root, ...args]);
  if (result.code !== 0 || !result.stdout.trim())
    throw new Error('checkout ownership Git identity unavailable');
  return result.stdout.trim();
}
async function commonDirectory(opts: Options, root = opts.repoRoot): Promise<string> {
  return realpath(
    resolve(
      root,
      await gitText(opts, root, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
    ),
  );
}

async function coordinationDirectory(path: string): Promise<string> {
  await mkdir(path, { recursive: true });
  return realpath(path);
}

export class AddressCheckoutOwnership extends AddressRunLifecycle {
  private readonly bulkParent = bulkContext.getStore();
  private checkout?: {
    path: string;
    gitDir: string;
    common: string;
    identity: Awaited<ReturnType<typeof lstat>>;
    gitIdentity: Awaited<ReturnType<typeof lstat>>;
  };
  private coordinating = false;
  private selection?: Omit<AddressSelection, 'head'>;
  private readonly pendingReports = new Map<string, string>();
  protected override async ordinaryReport(path: string, bytes: string): Promise<void> {
    if (!this.active) {
      this.pendingReports.set(path, bytes);
      return;
    }
    await super.ordinaryReport(path, bytes);
  }
  private readonly pendingBookkeeping = new Map<string, ReadonlyMap<string, string>>();
  protected override async terminalBookkeeping(
    root: string,
    entries: ReadonlyMap<string, string>,
  ): Promise<void> {
    if (!this.active) {
      this.pendingBookkeeping.set(root, new Map(entries));
      return;
    }
    await super.terminalBookkeeping(root, entries);
  }
  readonly context: CheckoutWriterContext;
  readonly registry;
  private readonly opts: Options;
  private readonly resolverCommon: string;
  constructor(opts: Options, resolverCommon: string, parent?: CheckoutWriterContext) {
    super(opts);
    this.opts = opts;
    this.resolverCommon = resolverCommon;
    this.context = new CheckoutWriterContext(acquireSlot, parent, {
      admit: (terminal) => {
        if (this.active) this.context.markCheckoutMutation();
        if (terminal) {
          if (!this.active || this.compromised || this.terminalFailure)
            throw new Error('terminal writer after retirement');
          this.controller.signal.throwIfAborted();
        } else {
          if ((!this.admitting && !this.coordinating) || this.stopping)
            throw new Error('checkout writer after admissions closed');
          this.signal.throwIfAborted();
        }
      },
      track: (close) => {
        if (this.active) this.registerTerminalProcess(close);
        else {
          this.tasks.add(close);
          void close.then(
            () => this.tasks.delete(close),
            () => this.tasks.delete(close),
          );
        }
      },
      canSettleAdmission: () =>
        !this.active &&
        !this.stopping &&
        !this.signal.aborted &&
        !this.compromised &&
        !this.terminalFailure &&
        !this.terminalAdmissionRefusal &&
        !this.tasks.size &&
        !this.terminalProcesses.size &&
        !this.terminalOperations.size &&
        ![...this.participants].some((p) => p.opaqueDispatched),
      removed: async (path) => {
        if (this.checkout?.path !== path) return;
        await this.disposeTerminalSession();
        this.runContext.deactivate();
        this.active = this.admitting = false;
        this.coordinating = true;
        delete this.checkout;
      },
    });
    if (parent) this.bulkParent!.retained.push(this.context);
    this.registry = slotWorktreeRegistry(resolverCommon, {
      legacySources: [
        resolve(opts.coordinationRoot ?? resolverCommon, 'cq-review-address-worktrees.json'),
        resolve(resolverCommon, 'cq-review-address-worktrees.json'),
        ...(opts.legacySources ?? []),
      ],
    });
  }
  get commonDir(): string {
    if (!this.checkout) throw new Error('checkout terminal authority not activated');
    return this.checkout.common;
  }
  protected async assertIdentity(): Promise<void> {
    await this.context.assertIdentity();
    if (this.checkout) {
      const current = await lstat(this.checkout.path);
      const git = await lstat(this.checkout.gitDir);
      if (
        current.dev !== this.checkout.identity.dev ||
        current.ino !== this.checkout.identity.ino ||
        git.dev !== this.checkout.gitIdentity.dev ||
        git.ino !== this.checkout.gitIdentity.ino ||
        (await realpath(this.checkout.path)) !== this.checkout.path ||
        (await realpath(this.checkout.gitDir)) !== this.checkout.gitDir
      )
        throw new Error('checkout identity replaced');
    }
  }
  async assertOwned(): Promise<void> {
    this.signal.throwIfAborted();
    if ((!this.admitting && !this.coordinating) || this.compromised || this.stopping)
      throw new Error('checkout ownership inactive');
    await this.assertIdentity();
    this.signal.throwIfAborted();
  }
  async activateCheckout(info: { path: string; gitDir: string }): Promise<void> {
    const path = await realpath(info.path),
      gitDir = await realpath(info.gitDir);

    if (this.checkout && (this.checkout.path !== path || this.checkout.gitDir !== gitDir))
      throw new Error('checkout authority cannot be rebound');
    const slot = await this.context.acquire(this.resolverCommon, {
      checkoutGitDir: gitDir,
      checkoutPath: path,
    });
    await this.context.begin();
    this.coordinating = true;
    const common = await commonDirectory(this.opts, path);
    if (common !== this.resolverCommon)
      throw new Error('checkout resolver common directory changed');
    const metadata = {
      version: 1 as const,
      state: 'bound' as const,
      incomplete: true,
      checkoutPath: path,
      checkoutGitDir: gitDir,
    };
    await slot.writeMetadata(metadata);
    await this.context.bindCoordinates(metadata);
    this.checkout = {
      path,
      gitDir,
      common,
      identity: await lstat(path),
      gitIdentity: await lstat(gitDir),
    };
    this.active = this.admitting = true;
    this.runContext.activate();
    for (const [root, entries] of this.pendingBookkeeping)
      await super.terminalBookkeeping(root, entries);
    this.pendingBookkeeping.clear();
    for (const [path, bytes] of this.pendingReports) await super.ordinaryReport(path, bytes);
    this.pendingReports.clear();
  }
  async beginCoordination(source: string): Promise<void> {
    if (source === 'local') {
      if (!this.opts.bootstrapGitDir) throw new Error('local checkout bootstrap missing');
      await this.activateCheckout({ path: this.opts.repoRoot, gitDir: this.opts.bootstrapGitDir });
    } else {
      const pr = Number(source.slice(3));
      const original = await coordinationDirectory(
        this.opts.coordinationRoot ?? this.resolverCommon,
      );
      await this.context.acquire(original, pr);
      await this.context.acquire(this.resolverCommon, pr);
      // Legacy refusal must precede the first new metadata write.
      await this.registry.withPrLock(pr, async () => {});
      await this.context.begin();
    }
    this.coordinating = true;
  }
  lease(): AddressLease {
    const lease: AddressLease = {
      signal: this.signal,
      registry: this.registry,
      incompleteReason: () =>
        [...this.participants].some((p) => p.opaqueDispatched)
          ? 'opaque invocation write-set unconfirmed; checkout retained incomplete'
          : undefined,
      ...(this.opts.expectedHead ? { expectedHead: this.opts.expectedHead } : {}),
      assertOwned: () => this.assertOwned(),
      track: (action) => {
        if (this.stopping || (!this.admitting && !this.coordinating))
          return Promise.reject(new Error('checkout admissions closed'));
        const task = (async () => {
          await this.assertOwned();
          return action();
        })();
        this.tasks.add(task);
        void task.then(
          () => this.tasks.delete(task),
          () => this.tasks.delete(task),
        );
        return task;
      },
      assertSelection: async (selection) => {
        await this.assertOwned();
        if (
          this.selection &&
          (selection.pr !== this.selection.pr ||
            selection.headRepo.toLowerCase() !== this.selection.headRepo.toLowerCase() ||
            selection.headRefName !== this.selection.headRefName)
        )
          throw new Error('forge selection changed');
        this.selection ??= { ...selection };
      },
      claimCheckout: async (info) => {
        await this.assertOwned();
        if (!this.checkout && this.opts.expectedHead && info.head !== this.opts.expectedHead)
          throw new Error('checkout selected head changed');
        const gitDir = await gitText(this.opts, info.path, ['rev-parse', '--absolute-git-dir']);
        const branch = await gitText(this.opts, info.path, ['symbolic-ref', 'HEAD']);
        if (
          branch !== `refs/heads/${info.branch}` ||
          (await gitText(this.opts, info.path, ['rev-parse', 'HEAD'])) !== info.head
        )
          throw new Error('resolved checkout identity changed');
        await this.activateCheckout({ path: info.path, gitDir });
      },
    };
    this.runContext.registerLease(lease);
    return lease;
  }
  private closeAfterActualDrain(): void {
    // Keep this lifecycle (and its FileHandles) alive after a public refusal.
    // Late settlement only releases descriptors; it never clears recovery state.
    const pending = [...this.tasks, ...this.terminalProcesses, ...this.terminalOperations];
    void Promise.allSettled(pending)
      .then(async () => {
        if (this.tasks.size || this.terminalProcesses.size || this.terminalOperations.size)
          this.closeAfterActualDrain();
        else await this.context.close();
      })
      .catch(() => undefined);
  }
  async withLock<T>(source: string, action: (lease: AddressLease) => Promise<T>): Promise<T> {
    return this.context.run(async () => {
      try {
        await this.beginCoordination(source);
      } catch (error) {
        if (error instanceof Error && !(this.signal.aborted && error === this.signal.reason))
          refusals.add(error);
        await this.context.close();
        throw error;
      }
      this.signal.addEventListener('abort', this.stopAdmissions, { once: true });
      const lease = this.lease();
      try {
        const result = await this.runContext.runParticipant(lease, () => action(lease));
        this.admitting = this.coordinating = false;
        if (
          this.tasks.size ||
          this.terminalProcesses.size ||
          this.terminalOperations.size ||
          this.context.pendingChildren
        )
          throw new Error('checkout actual writer drain unresolved');
        if (this.terminalFailure || this.terminalAdmissionRefusal)
          throw this.terminalFailure ?? this.terminalAdmissionRefusal;
        if ([...this.participants].some((p) => p.opaqueDispatched)) {
          // finish() already classifies opaque work as needs-human. Preserve a
          // later publication/terminal failure while retaining incomplete state.
          if (
            result &&
            typeof result === 'object' &&
            'status' in result &&
            result.status === 'needs-human'
          )
            return result;
          const error = new Error(
            'opaque invocation write-set unconfirmed; checkout retained incomplete',
          );
          incompleteRefusals.add(error);
          throw error;
        }
        if (source.startsWith('pr:') && this.registry.legacyHint?.(Number(source.slice(3)))) {
          const error = new Error('legacy review checkout requires reconciliation');
          incompleteRefusals.add(error);
          throw error;
        }
        await this.assertIdentity();
        await this.disposeTerminalSession();
        await this.context.complete();
        return result;
      } finally {
        this.stopping = true;
        this.admitting = this.active = this.coordinating = false;
        this.signal.removeEventListener('abort', this.stopAdmissions);
        if (!this.bulkParent && ![...this.participants].some((p) => p.opaqueDispatched)) {
          if (
            !this.tasks.size &&
            !this.terminalProcesses.size &&
            !this.terminalOperations.size &&
            !this.context.pendingChildren
          )
            await this.context.close();
          else this.closeAfterActualDrain();
        }
      }
    });
  }
}
export async function withAddressOwnership<T>(
  opts: Options & { source: string; production: boolean },
  action: (lease: AddressLease) => Promise<T>,
): Promise<T> {
  opts.controller?.signal.throwIfAborted();
  opts.signal?.throwIfAborted();
  const parent = bulkContext.getStore();
  if (parent) {
    if (parent.consumed || opts.source !== `pr:${parent.pr}`)
      throw new Error('invalid bulk checkout permit');
    parent.consumed = true;
  }
  const common = await commonDirectory(opts);
  const bootstrapGitDir =
    opts.source === 'local'
      ? await gitText(opts, opts.repoRoot, ['rev-parse', '--absolute-git-dir'])
      : undefined;
  const owner = new AddressCheckoutOwnership(
    { ...opts, ...(bootstrapGitDir ? { bootstrapGitDir } : {}) },
    common,
    parent?.context,
  );
  const result = await owner.withLock(opts.source, action);
  if (parent) parent.settled = await owner.context.isComplete();
  return result;
}
export async function runAddressReviewLoop(
  lease: AddressLease,
  opts: ReviewLoopOpts,
): Promise<ReviewLoopOutcome> {
  if (!(addressRunLeaseAuthority(lease) instanceof AddressCheckoutOwnership))
    throw new Error('forged loop lease');
  await lease.assertOwned();
  return loopContext.run({ lease, consumed: false }, async () =>
    (await import('../../../plans/review-loop.js')).runReviewLoop(opts),
  );
}
export async function withReviewLoopOwnership<T>(
  opts: ReviewLoopOpts,
  action: (lease: AddressLease) => Promise<T>,
): Promise<T> {
  const context = loopContext.getStore();
  if (context) {
    if (
      context.consumed ||
      !(addressRunLeaseAuthority(context.lease) instanceof AddressCheckoutOwnership)
    )
      throw new Error('invalid loop permit');
    context.consumed = true;
    await context.lease.assertOwned();
    return action(context.lease);
  }
  return withAddressOwnership({ ...opts, source: `pr:${opts.pr}`, production: true }, action);
}

/** Original PR exclusion spans clone creation, child drain and cleanup; no A token is minted here. */
export async function withAddressManyCheckout<T>(
  opts: { commonDir: string; pr: number },
  action: (handle: {
    metadata(): Promise<import('../../../adapters/lock/slotLock.js').SlotMetadata | undefined>;
    retainIncomplete(): void;
    canRemove(): Promise<boolean>;
    beforeRemove(): Promise<void>;
    removed(path: string): Promise<void>;
  }) => Promise<T>,
): Promise<T> {
  const context = new CheckoutWriterContext(acquireSlot);
  const state = {
    context,
    pr: opts.pr,
    consumed: false,
    settled: false,
    uncertain: false,
    retained: [] as CheckoutWriterContext[],
  };
  return context.run(async () => {
    const slot = await context.acquire(await coordinationDirectory(opts.commonDir), opts.pr);
    try {
      if (!(await slot.readMetadata())) {
        const path = resolve(opts.commonDir, 'cq-review-address-worktrees.json');
        await readLegacyReviewHint([path], opts.pr);
      }
      await context.begin();
      const result = await bulkContext.run(state, () =>
        action({
          metadata: () => slot.readMetadata(),
          retainIncomplete() {
            state.uncertain = true;
          },
          async canRemove() {
            if ((state.consumed && !state.settled) || context.pendingChildren) return false;
            for (const held of state.retained) {
              await held.assertIdentity();
              if (!(await held.isComplete())) return false;
            }
            return true;
          },
          async beforeRemove() {
            for (const held of state.retained) await held.begin();
          },
          async removed(path) {
            const metadata = await slot.readMetadata();
            if (
              metadata?.state === 'bound' &&
              (metadata.checkoutPath === path || metadata.checkoutPath.startsWith(`${path}/`))
            )
              await context.removed(metadata.checkoutPath);
          },
        }),
      );
      if (!state.uncertain && (!state.consumed || state.settled)) await context.complete();
      return result;
    } finally {
      if (!state.uncertain && (!state.consumed || state.settled) && !context.pendingChildren) {
        for (const held of state.retained.reverse()) await held.close();
        await context.close();
      }
    }
  });
}
