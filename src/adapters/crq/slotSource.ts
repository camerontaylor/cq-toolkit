/** Filesystem bindings for the slot timer preflight. No runner is imported here. */
import { mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { SlotBusyError } from '../lock/slotLock.js';
import type { SlotPreflightEffects } from '../../queue-runner/slot.js';
import { withLock } from './lock.js';

/** Python strptime's UTC hint format, including its unpadded components. */
export function futureSlotHint(text: string, now: number): boolean {
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})T(\d{1,2}):(\d{1,2}):(\d{1,2})Z$/.exec(text.trim());
  if (!match) return false;
  const [, y, m, d, h, min, s] = match;
  const [year, month, day, hour, minute, second] = [y, m, d, h, min, s].map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  if (!year || !month || !day || month > 12 || hour > 23 || minute > 59 || second > 59)
    return false;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    return false;
  return date.getTime() > now;
}

/** Read at most 64 UTF-8 characters, just like the Python fast path. */
async function readHint(path: string): Promise<string | null> {
  let file;
  try {
    file = await open(path, 'r');
  } catch (error) {
    if (error instanceof Error && 'code' in error) return null;
    throw error;
  }
  try {
    const bytes = Buffer.alloc(256);
    let size = 0;
    while (size < bytes.length) {
      const result = await file.read(bytes, size, bytes.length - size, size);
      if (!result.bytesRead) break;
      size += result.bytesRead;
    }
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    return [...decoder.decode(bytes.subarray(0, size), { stream: size === bytes.length })]
      .slice(0, 64)
      .join('');
  } catch (error) {
    if (error instanceof Error && 'code' in error) return null;
    throw error;
  } finally {
    await file.close();
  }
}

export function fileSlotPreflightEffects(
  stateRoot: string,
  runScheduledSlot: () => Promise<string[]>,
  now: () => number = Date.now,
): SlotPreflightEffects {
  return {
    async hintIsFuture() {
      const text = await readHint(join(stateRoot, 'next-review-at'));
      return text !== null && futureSlotHint(text, now());
    },
    async withTickLock(work) {
      await mkdir(stateRoot, { recursive: true });
      try {
        const value = await withLock(join(stateRoot, 'tick.lock'), { wait: false }, work);
        return { acquired: true, value };
      } catch (error) {
        if (error instanceof SlotBusyError) return { acquired: false };
        throw error;
      }
    },
    runScheduledSlot,
  };
}
