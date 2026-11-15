/**
 * Real file and clock bindings for `slotDeadlineHeartbeat.ts`: the
 * `next-review-at` hint, the slot calculator and the watchdog heartbeat files.
 * Filesystem failures of the heartbeat become `HeartbeatIoError` (Python's
 * OSError); everything else escapes. Inactive: nothing imports this.
 */
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { nextSlot, type VendorUsage } from '../../policy/crq/usageSlots.js';
import { liveItems } from '../../policy/crq/tickSchedule.js';
import { parseIso, utcFromMillis } from '../../policy/crq/utc.js';
import {
  HeartbeatIoError,
  type HeartbeatEffects,
  type Queue,
  type SlotDeadlineEffects,
} from '../../queue-runner/slotDeadlineHeartbeat.js';
import { atomicWrite } from './atomic.js';

const isoSeconds = (ms: number): string => `${new Date(ms).toISOString().slice(0, 19)}Z`;

export function fileSlotDeadlineEffects(input: {
  stateRoot: string;
  now?: () => number;
}): SlotDeadlineEffects {
  const now = input.now ?? Date.now;
  return {
    nowMs: () => now(),
    liveItems: (queue) => liveItems(queue as Queue) as never,
    parseIsoMs(value) {
      const parsed = parseIso(value);
      return parsed === null ? null : Number(parsed.epochMicros / 1000n);
    },
    nextSlot(starts, atMs, usage) {
      const slot = nextSlot(
        starts.map((s) => (s === null ? null : utcFromMillis(s))),
        utcFromMillis(atMs),
        usage as VendorUsage | null,
      );
      return slot === null ? null : Number(slot.epochMicros / 1000n);
    },
    async writeNext(hintMs) {
      await mkdir(input.stateRoot, { recursive: true });
      await atomicWrite(join(input.stateRoot, 'next-review-at'), `${isoSeconds(hintMs)}\n`);
    },
  };
}

/** Python's OSError: every errno-coded failure. */
const IO_CODE = /^E[A-Z0-9]+$/;

export function fileHeartbeatEffects(input: {
  watchdogHome: string;
  config: Record<string, unknown>;
  root: string;
  event: HeartbeatEffects['event'];
}): HeartbeatEffects {
  const temporary = join(input.watchdogHome, '.heartbeat.json.tmp');
  const io = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (typeof code === 'string' && IO_CODE.test(code)) throw new HeartbeatIoError(String(error));
      throw error;
    }
  };
  return {
    mkdirHome: () => io(() => mkdir(input.watchdogHome, { recursive: true }).then(() => undefined)),
    writeTemp: (text) => io(() => writeFile(temporary, text)),
    commit: () => io(() => rename(temporary, join(input.watchdogHome, 'heartbeat.json'))),
    event: input.event,
    config: input.config,
    root: input.root,
  };
}
