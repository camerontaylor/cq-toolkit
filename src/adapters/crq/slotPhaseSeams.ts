/**
 * Real file, lock and clock bindings for the slot orchestrator's seams
 * (`queue-runner/slotOrchestrator.ts`). Only the seams that are plain state
 * access are bound here: the runner-disabled marker, `queue.json` load and
 * save, `tick.lock`, queue equality and the clock. `collectFinished`, usage
 * reads, admission and the deadline refresh stay injected by the caller.
 * Nothing here is imported by a runtime entry point.
 */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  ScheduledSlotPhases,
  SlotLock,
  SlotPhases,
} from '../../queue-runner/slotOrchestrator.js';
import { ledgerValueEqual } from '../../policy/crq/ledger.js';
import { SlotBusyError } from '../lock/slotLock.js';
import { atomicWrite } from './atomic.js';
import { withLock } from './lock.js';
import { loadQueueDocument, queueBytes } from './queueEffects.js';
import { access } from 'node:fs/promises';

type Injected = 'collectFinished' | 'readSlotUsage' | 'admit' | 'refreshSlotDeadline';

/** `tick.lock` without waiting: `ran: false` when another holder has it. */
export function slotTickLock(stateRoot: string): SlotLock {
  return {
    async withLock<T>(fn: () => Promise<T>) {
      await mkdir(stateRoot, { recursive: true });
      try {
        return {
          ran: true as const,
          value: await withLock(join(stateRoot, 'tick.lock'), { wait: false }, fn),
        };
      } catch (error) {
        if (error instanceof SlotBusyError) return { ran: false as const };
        throw error;
      }
    },
  };
}

/** The slot seams that are plain state access, plus the caller's heavy phases. */
export function fileSlotPhases(input: {
  stateRoot: string;
  heavy: Pick<SlotPhases, Injected>;
  now?: () => number;
}): ScheduledSlotPhases {
  const queuePath = join(input.stateRoot, 'queue.json');
  const now = input.now ?? Date.now;
  return {
    ...input.heavy,
    async runnerDisabled() {
      try {
        await access(join(input.stateRoot, 'runner-disabled'));
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
    },
    loadQueue: () => loadQueueDocument(queuePath),
    saveQueue: (queue) => atomicWrite(queuePath, queueBytes(queue)),
    nowMs: () => now(),
    sameQueue: (left, right) => ledgerValueEqual(left, right),
  };
}
