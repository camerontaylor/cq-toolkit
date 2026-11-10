import { realpath, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readLegacyReviewHint, type LegacyReviewHint } from './legacyReviewRegistry.js';
import { acquireSlot, readSlotMetadata, type SlotMetadata } from '../lock/slotLock.js';
import {
  CheckoutWriterContext,
  checkoutWriterContext,
} from '../../shared/checkoutWriterContext.js';

export interface SlotWorktreeRegistry {
  read(pr: number): Promise<SlotMetadata | undefined>;
  update(pr: number, metadata: SlotMetadata): Promise<void>;
  withPrLock<T>(pr: number, action: () => Promise<T>): Promise<T>;
  legacyHint?(pr: number): LegacyReviewHint | undefined;
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
  const hints = new WeakMap<CheckoutWriterContext, Map<number, LegacyReviewHint>>();
  const current = (pr: number) => {
    const context = checkoutWriterContext();
    const slot = context && held.get(context)?.get(pr);
    if (!slot) throw new Error('slot registry operation requires its live PR lock');
    return slot;
  };
  return {
    read: (pr) => current(pr).readMetadata(),
    update: (pr, metadata) => current(pr).writeMetadata(metadata),
    legacyHint: (pr) => {
      const context = checkoutWriterContext();
      return context ? hints.get(context)?.get(pr) : undefined;
    },
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
            const hint = await readLegacyReviewHint(opts.legacySources ?? [], pr);
            if (hint) {
              let entries = hints.get(context);
              if (!entries) {
                entries = new Map();
                hints.set(context, entries);
              }
              entries.set(pr, hint);
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
