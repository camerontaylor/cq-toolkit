import { AsyncLocalStorage } from 'node:async_hooks';
import { fstatSync, lstatSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import type { ChildProcess } from 'node:child_process';
import type { acquireSlot, SlotMetadata } from '../adapters/lock/slotLock.js';

type Slot = Awaited<ReturnType<typeof acquireSlot>>;
type SlotFactory = typeof acquireSlot;
const storage = new AsyncLocalStorage<CheckoutWriterContext>();
const authentic = new WeakSet<CheckoutWriterContext>();

/** Private run context: descriptors can only enter through actual slot acquisition. */
export class CheckoutWriterContext {
  private readonly slots = new Map<string, { slot: Slot; metadata: SlotMetadata }>();
  readonly #children = new Set<Promise<void>>();
  private retired = false;
  private mutated = false;
  private readonly begun = new Set<Slot>();
  private readonly acquireSlot: SlotFactory;
  constructor(acquireSlot: SlotFactory) {
    this.acquireSlot = acquireSlot;
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
    const existing = this.slots.get(name);
    if (existing) {
      await existing.slot.assertIdentity();
      const { fd: _fd, close: _close, ...methods } = existing.slot;
      return methods;
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
      this.slots.set(name, { slot, metadata });
      const { fd: _fd, close: _close, ...methods } = slot;
      return methods;
    } catch (error) {
      await slot.close();
      throw error;
    }
  }
  async assertIdentity(): Promise<void> {
    this.assertLive();
    for (const { slot } of this.slots.values()) await slot.assertIdentity();
  }
  /** Persist every admission before the first domain mutator; compensate only this phase. */
  async begin(): Promise<void> {
    const written: Array<{ slot: Slot; metadata: SlotMetadata }> = [];
    try {
      for (const entry of this.slots.values()) {
        const current = await entry.slot.readMetadata();
        if (current?.incomplete && this.begun.has(entry.slot)) continue; // our admitted slot, already begun
        written.push(entry);
        await entry.slot.writeMetadata({ ...entry.metadata, incomplete: true });
        this.begun.add(entry.slot);
      }
    } catch (error) {
      if (this.mutated) throw error;
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
  snapshot(): number[] {
    this.assertLive();
    if (!this.slots.size) throw new Error('checkout context has no held slots');
    const fds = new Set<number>();
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
