/**
 * Child side of the repair worker boundary: the fd-backed `WorkerChannel` and the
 * body that runs inside the spawned process. Python's forked child writes one
 * byte (`a` admitted, `x` refused) on a private pipe and swallows `OSError`;
 * this does the same on fd 3 with a synchronous write, so the byte is on the wire
 * before the worker does anything else.
 *
 * Importing this module performs no I/O.
 */
import { writeSync } from 'node:fs';
import {
  runRepairWorker,
  type RepairDrainEffects,
  type WorkerChannel,
} from '../../ops/crq/internal/repairDrain.js';

/** The descriptor `repairWorkerProcess` hands the child as its private pipe. */
export const WORKER_PIPE_FD = 3;

/** `publish` of `crq_repair.drain_items`: `os.write(refused_w, byte)`, `except OSError: pass`. */
export function fdWorkerChannel(fd: number = WORKER_PIPE_FD): WorkerChannel {
  return {
    publish(signal) {
      try {
        writeSync(fd, signal === 'admitted' ? 'a' : 'x');
      } catch {
        // A closed or full pipe must never fail the worker (`except OSError: pass`).
      }
    },
  };
}

/** Run the worker body; resolves with the process exit code (the caller exits). */
export function runWorkerChild(
  effects: RepairDrainEffects,
  item: string,
  jobIds: readonly string[],
  channel: WorkerChannel,
): Promise<number> {
  return runRepairWorker(effects, item, jobIds, channel);
}
