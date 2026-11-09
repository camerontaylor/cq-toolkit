import { AsyncLocalStorage } from 'node:async_hooks';
import { fstatSync, lstatSync } from 'node:fs';
import { realpath, lstat } from 'node:fs/promises';
import type { ChildProcess } from 'node:child_process';
import type { acquireSlot, SlotMetadata } from '../adapters/lock/slotLock.js';

type Slot = Awaited<ReturnType<typeof acquireSlot>>;
type SlotFactory = typeof acquireSlot;
type Hooks = {
  admit(terminal: boolean): void;
  track(close: Promise<void>): void;
  removed?(path: string): Promise<void>;
  canSettleAdmission?(): boolean;
};
type Entry = {
  slot: Slot;
  metadata: SlotMetadata;
  absentPath?: string;
  binding?: {
    path: string;
    gitDir: string;
    dev: number;
    ino: number;
    gitDev: number;
    gitIno: number;
  };
};
const storage = new AsyncLocalStorage<CheckoutWriterContext>();
const authentic = new WeakSet<CheckoutWriterContext>();

/** Private run context: descriptors can only enter through actual slot acquisition. */
export class CheckoutWriterContext {
  private readonly slots = new Map<string, Entry>();
  readonly #children = new Set<Promise<void>>();
  private retired = false;
  private mutated = false;
  private checkoutMutated = false;
  private readonly begun = new Set<Slot>();
  private readonly acquireSlot: SlotFactory;
  private readonly parent: CheckoutWriterContext | undefined;
  private readonly hooks: Hooks | undefined;
  constructor(acquireSlot: SlotFactory, parent?: CheckoutWriterContext, hooks?: Hooks) {
    this.acquireSlot = acquireSlot;
    this.parent = parent;
    this.hooks = hooks;
    parent?.assertLive();
    authentic.add(this);
  }
  get pendingChildren(): number {
    return this.#children.size;
  }
  run<T>(action: () => T): T {
    this.assertLive();
    return storage.run(this, action);
  }
  private assertLive(): void {
    if (!authentic.has(this) || this.retired)
      throw new Error('checkout writer context expired or forged');
  }
  async acquire(
    commonDir: string,
    // The owner supplies a checkout only after verifying its Git identity/content.
    key: number | { checkoutGitDir: string; checkoutPath: string },
  ): Promise<Omit<Slot, 'fd' | 'close'>> {
    this.assertLive();
    commonDir = await realpath(commonDir);
    if (typeof key !== 'number')
      key = {
        checkoutGitDir: await realpath(key.checkoutGitDir),
        checkoutPath: await realpath(key.checkoutPath),
      };
    const name = `${commonDir}:${typeof key === 'number' ? key : key.checkoutGitDir}`;
    const existing = this.find(name);
    if (existing) {
      await existing.slot.assertIdentity();
      return this.methods(existing);
    }
    const slot = await this.acquireSlot(commonDir, key);
    try {
      await slot.assertReusable();
      const metadata: SlotMetadata =
        (await slot.readMetadata()) ??
        (typeof key === 'number'
          ? { version: 1, state: 'unbound', incomplete: false }
          : { version: 1, state: 'bound', incomplete: false, ...key });
      this.assertLive();
      const entry: Entry = { slot, metadata };
      if (metadata.state === 'bound') {
        // lstat distinguishes a removed checkout from a dangling/repointed alias.
        const info = await lstat(metadata.checkoutPath).catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          return undefined;
        });
        if (!info) {
          entry.absentPath = metadata.checkoutPath;
          entry.metadata = { version: 1, state: 'unbound', incomplete: false };
        } else {
          if (info.isSymbolicLink()) throw new Error('bound checkout alias refused');
          const gitInfo = await lstat(metadata.checkoutGitDir).catch((error: unknown) => {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            throw new Error(
              `bound checkout Git directory missing: ${metadata.checkoutGitDir}; checkout preserved: ${metadata.checkoutPath}`,
              { cause: error },
            );
          });
          if (gitInfo.isSymbolicLink()) throw new Error('bound checkout alias refused');
          entry.binding = await this.captureBinding(metadata);
        }
      }
      this.slots.set(name, entry);
      return this.methods(entry);
    } catch (error) {
      await slot.close();
      throw error;
    }
  }
  private find(key: string): Entry | undefined {
    this.assertLive();
    return this.slots.get(key) ?? this.parent?.find(key);
  }
  private get hasMutated(): boolean {
    return this.mutated || this.checkoutMutated || Boolean(this.parent?.hasMutated);
  }
  private async captureBinding(metadata: Extract<SlotMetadata, { state: 'bound' }>) {
    const [path, gitDir] = await Promise.all([
      realpath(metadata.checkoutPath),
      realpath(metadata.checkoutGitDir),
    ]);
    if (path !== metadata.checkoutPath || gitDir !== metadata.checkoutGitDir)
      throw new Error('bound checkout alias refused');
    const [tree, git] = await Promise.all([lstat(path), lstat(gitDir)]);
    if (!tree.isDirectory() || !git.isDirectory())
      throw new Error('bound checkout identity unavailable');
    return { path, gitDir, dev: tree.dev, ino: tree.ino, gitDev: git.dev, gitIno: git.ino };
  }
  private async assertAbsent(path: string | undefined): Promise<void> {
    if (!path) return; // Fresh unbound slots have never named a checkout.
    try {
      await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    throw new Error(`unbound checkout still exists: ${path}`);
  }
  markCheckoutMutation(): void {
    this.assertLive();
    this.checkoutMutated = true;
    this.parent?.markCheckoutMutation();
  }
  /** Captured before resolver commands; used only for its non-writing refusals. */
  admissionSettlement(): () => boolean {
    const eligible =
      !this.parent &&
      !this.checkoutMutated &&
      !this.#children.size &&
      (this.hooks?.canSettleAdmission?.() ?? !this.mutated);
    return () =>
      eligible &&
      !this.checkoutMutated &&
      !this.#children.size &&
      (this.hooks?.canSettleAdmission?.() ?? true);
  }
  private methods(entry: Entry): Omit<Slot, 'fd' | 'close'> {
    const { fd: _fd, close: _close, ...methods } = entry.slot;
    return {
      ...methods,
      writeMetadata: async (metadata) => {
        this.assertLive();
        if (metadata.state === 'bound') {
          entry.binding = await this.captureBinding(metadata);
          delete entry.absentPath;
        } else {
          const path = entry.binding?.path ?? entry.absentPath;
          await this.assertAbsent(path);
          if (path) entry.absentPath = path;
          delete entry.binding;
        }
        await entry.slot.writeMetadata(metadata);
      },
    };
  }
  async bindCoordinates(metadata: SlotMetadata): Promise<void> {
    await this.parent?.bindCoordinates(metadata);
    for (const entry of this.slots.values())
      if (/\/pr-[0-9]+\.lock$/.test(entry.slot.path))
        await this.methods(entry).writeMetadata(metadata);
  }
  /** Call only after the owned targeted Git removal has succeeded. */
  async removed(path: string): Promise<void> {
    try {
      await lstat(path);
      throw new Error('removed checkout still exists');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    for (const entry of this.slots.values()) {
      const metadata = await entry.slot.readMetadata();
      if (metadata?.state === 'bound' && metadata.checkoutPath === path) {
        await this.methods(entry).writeMetadata({ version: 1, state: 'unbound', incomplete: true });
      }
    }
    await this.hooks?.removed?.(path);
  }
  async isComplete(): Promise<boolean> {
    this.assertLive();
    if (this.#children.size) return false;
    for (const { slot } of this.slots.values())
      if ((await slot.readMetadata())?.incomplete !== false) return false;
    return true;
  }
  /** The owning lifecycle supplies task/participant/report proof before calling this. */
  async complete(): Promise<void> {
    await this.assertIdentity();
    if (this.#children.size) throw new Error('checkout writers not drained');
    for (const entry of [...this.slots.values()].reverse()) {
      const metadata = await entry.slot.readMetadata();
      if (!metadata) throw new Error(`missing live slot metadata: ${entry.slot.metadataPath}`);
      if (metadata.state === 'bound') {
        const expected = entry.binding;
        const [tree, git] = await Promise.all([
          lstat(metadata.checkoutPath),
          lstat(metadata.checkoutGitDir),
        ]);
        if (
          !expected ||
          expected.path !== (await realpath(metadata.checkoutPath)) ||
          expected.gitDir !== (await realpath(metadata.checkoutGitDir)) ||
          expected.dev !== tree.dev ||
          expected.ino !== tree.ino ||
          expected.gitDev !== git.dev ||
          expected.gitIno !== git.ino
        )
          throw new Error(`checkout identity changed: ${entry.slot.metadataPath}`);
      }
      if (metadata.state === 'unbound') await this.assertAbsent(entry.absentPath);
      await entry.slot.writeMetadata({ ...metadata, incomplete: false });
    }
  }
  async assertIdentity(): Promise<void> {
    this.assertLive();
    await this.parent?.assertIdentity();
    for (const { slot } of this.slots.values()) await slot.assertIdentity();
  }
  /** Persist every admission before the first domain mutator; compensate only this phase. */
  async begin(): Promise<void> {
    this.assertLive();
    await this.parent?.begin();
    const written: Array<{ slot: Slot; metadata: SlotMetadata }> = [];
    try {
      for (const entry of this.slots.values()) {
        const current = await entry.slot.readMetadata();
        if (current?.incomplete && this.begun.has(entry.slot)) continue; // our admitted slot, already begun
        const admission =
          entry.absentPath && !entry.binding ? entry.metadata : (current ?? entry.metadata);
        if (admission.state === 'unbound') await this.assertAbsent(entry.absentPath);
        written.push(entry);
        await entry.slot.writeMetadata({ ...admission, incomplete: true });
        this.begun.add(entry.slot);
      }
    } catch (error) {
      if (this.hasMutated) throw error;
      const failures: Error[] = [];
      for (const entry of written.reverse()) {
        this.begun.delete(entry.slot);
        try {
          await entry.slot.writeMetadata(entry.metadata);
        } catch (cause) {
          failures.push(
            new Error(`Incomplete slot restoration failed: ${entry.slot.metadataPath}`, { cause }),
          );
        }
      }
      if (failures.length)
        throw new AggregateError(
          [error, ...failures],
          failures.map((failure) => failure.message).join('; '),
        );
      throw error;
    }
  }
  snapshot(terminal = false): number[] {
    this.assertLive();
    this.hooks?.admit(terminal);
    if (!this.slots.size && !this.parent) throw new Error('checkout context has no held slots');
    const fds = new Set<number>(this.parent?.snapshot(terminal));
    for (const { slot } of this.slots.values()) {
      if (!this.begun.has(slot)) throw new Error('checkout incomplete state not yet durable');
      // Synchronous validation and spawn happen in one JS frame; close cannot reuse the fd between them.
      const held = fstatSync(slot.fd),
        named = lstatSync(slot.path);
      if (!named.isFile() || held.nlink !== 1 || held.dev !== named.dev || held.ino !== named.ino)
        throw new Error(`Slot lock inode replaced: ${slot.path}`);
      fds.add(slot.fd);
    }
    this.mutated = true;
    return [...fds];
  }
  track(child: ChildProcess): void {
    this.assertLive();
    const close = new Promise<void>((done) => child.once('close', () => done()));
    this.hooks?.track(close);
    this.parent?.track(child);
    this.#children.add(close);
    void close.then(
      () => this.#children.delete(close),
      () => this.#children.delete(close),
    );
  }
  async close(): Promise<void> {
    this.assertLive();
    if (this.#children.size) throw new Error('checkout writer children have not closed');
    this.retired = true;
    for (const { slot } of [...this.slots.values()].reverse()) await slot.close();
  }
}

export function checkoutWriterContext(): CheckoutWriterContext | undefined {
  return storage.getStore();
}
export function checkoutWriterStdio<
  A extends 'pipe' | 'ignore' | 'inherit',
  B extends 'pipe' | 'ignore' | 'inherit',
  C extends 'pipe' | 'ignore' | 'inherit',
>(base: [A, B, C]): [A, B, C, ...number[]] {
  return [...base, ...(storage.getStore()?.snapshot() ?? [])];
}
export function trackCheckoutWriter(child: ChildProcess): void {
  storage.getStore()?.track(child);
}

/** Called only by terminalGit after its private terminal authority validation. */
export function checkoutTerminalWriterStdio(
  base: ['pipe', 'pipe', 'pipe'],
): ['pipe', 'pipe', 'pipe', ...number[]] {
  return [...base, ...(storage.getStore()?.snapshot(true) ?? [])];
}
