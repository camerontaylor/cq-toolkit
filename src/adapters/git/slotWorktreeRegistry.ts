import { lstat, realpath, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { acquireSlot, readSlotMetadata, type SlotMetadata } from '../lock/slotLock.js';
import {
  CheckoutWriterContext,
  checkoutWriterContext,
} from '../../shared/checkoutWriterContext.js';

export interface SlotWorktreeRegistry {
  read(pr: number): Promise<SlotMetadata | undefined>;
  update(pr: number, metadata: SlotMetadata): Promise<void>;
  withPrLock<T>(pr: number, action: () => Promise<T>): Promise<T>;
}

/** Discovery is only a hint. Admission always reads again under the kernel lock. */
export async function discoverWorktreeSlots(
  commonDir: string,
): Promise<Map<number, SlotMetadata | undefined>> {
  const directory = join(commonDir, 'cq-review', 'slots');
  const entries = new Map<number, SlotMetadata | undefined>();
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return entries;
    throw error;
  }
  for (const name of names) {
    const match = /^pr-([1-9][0-9]*)\.json$/.exec(name);
    if (!match) continue;
    const pr = Number(match[1]);
    try {
      entries.set(pr, await readSlotMetadata(join(directory, name)));
    } catch {
      entries.set(pr, undefined);
    }
  }
  return entries;
}

/** One metadata file per PR. No aggregate map or lock is consulted. */
export function slotWorktreeRegistry(
  commonDir: string,
  opts: { legacySources?: readonly string[] } = {},
): SlotWorktreeRegistry {
  const held = new WeakMap<
    CheckoutWriterContext,
    Map<number, Awaited<ReturnType<CheckoutWriterContext['acquire']>>>
  >();
  const current = (pr: number) => {
    const context = checkoutWriterContext();
    const slot = context && held.get(context)?.get(pr);
    if (!slot) throw new Error('slot registry operation requires its live PR lock');
    return slot;
  };
  return {
    read: (pr) => current(pr).readMetadata(),
    update: (pr, metadata) => current(pr).writeMetadata(metadata),
    async withPrLock(pr, action) {
      const inherited = checkoutWriterContext();
      const context = inherited ?? new CheckoutWriterContext(acquireSlot);
      return context.run(async () => {
        const common = await realpath(commonDir);
        const slot = await context.acquire(common, pr);
        let entries = held.get(context);
        if (!entries) {
          entries = new Map();
          held.set(context, entries);
        }
        entries.set(pr, slot);
        try {
          if (!(await slot.readMetadata())) {
            for (const source of new Set((opts.legacySources ?? []).map((path) => resolve(path)))) {
              try {
                await lstat(source);
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
                throw error;
              }
              throw new Error(`legacy review registry requires migration: ${source}`);
            }
          }
          await context.begin();
          const result = await action();
          if (!inherited) await context.complete();
          return result;
        } finally {
          if (!inherited) await context.close();
        }
      });
    },
  };
}
