/**
 * Coordinator side of the repair worker boundary: `RepairDrainEffects.startWorker`
 * over a real child process (Python's `os.fork()` plus private pipe in
 * `crq_repair.drain_items`).
 *
 * - `spawn(execPath, [entry, payload])`, never `fork()`: the protocol is one raw
 *   byte per decision on fd 3 (a socketpair), not a JSON IPC channel;
 * - stdio is `['ignore', 2, 2, 'pipe']`: stdin `/dev/null`, stdout redirected to
 *   the parent's stderr (a stray write cannot corrupt the one JSON artifact on
 *   stdout; Python's child inherits stdout), stderr inherited, fd 3 the pipe.
 *   Nothing else is inherited, so no worker holds another worker's pipe;
 * - a worker is **never killed**: no `kill`, no signal, no timeout, no `detached`,
 *   no `unref`. The coordinator's `drainItems` reaps every admitted worker, and
 *   the child stays in the coordinator's process group so a unit's cgroup owns
 *   emergency shutdown, as with a Python fork;
 * - the exit comes from `'exit'` (the `waitpid` analogue), not `'close'`, which
 *   would also wait for the pipe;
 * - a launch problem knowable up front (missing entry or interpreter, oversized
 *   payload) throws synchronously, which unwinds `drainItems` after it reaps the
 *   workers already admitted, as Python's failing `os.fork()` does. A residual
 *   asynchronous spawn error is a lost exit, which latches the stop.
 *
 * Importing this module performs no I/O; nothing here installs signal handlers.
 * The coordinator CLI's SIGINT/SIGTERM policy is out of scope until a route
 * exists; {@link ownedWorkerCount} is its seam.
 */
import { currentEntryEnv } from '../../config/run-env.js';
import { spawn } from 'node:child_process';
import { accessSync, constants, readSync } from 'node:fs';
import { constants as osConstants } from 'node:os';
import { resolve } from 'node:path';
import type { Readable } from 'node:stream';
import {
  createWorkerChannel,
  type RepairDrainEffects,
  type WorkerExit,
} from '../../ops/crq/internal/repairDrain.js';

/** Below Linux's 128 KiB per-argument limit (`MAX_ARG_STRLEN`). */
export const MAX_WORKER_PAYLOAD_BYTES = 96_000;

export interface RepairWorkerLaunch {
  /** Absolute path of the built child entry (`dist/adapters/crq/repairWorkerMain.js`). */
  readonly entry: string;
  /** Defaults to `process.execPath`. */
  readonly execPath?: string;
  /** Extra Node flags before the entry. */
  readonly execArgv?: readonly string[];
  /** Child environment; defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface RepairWorkerStartOptions {
  readonly stateRoot: string;
  readonly clone: string;
  /** The exact text of the loaded `config.json`. */
  readonly configText: string;
  readonly launch: RepairWorkerLaunch;
}

let owned = 0;

/** Spawned workers that have not yet exited; the seam a future CLI signal policy reads. */
export function ownedWorkerCount(): number {
  return owned;
}

export function fileRepairWorkerStarter(
  options: RepairWorkerStartOptions,
): RepairDrainEffects['startWorker'] {
  const { launch } = options;
  return (item, jobIds) => {
    const execPath = launch.execPath ?? process.execPath;
    accessSync(launch.entry, constants.R_OK);
    accessSync(execPath, constants.X_OK);
    const payload = JSON.stringify({
      // The child starts in stateRoot, so relative paths must be fixed against this process first.
      stateRoot: resolve(options.stateRoot),
      clone: resolve(options.clone),
      configText: options.configText,
      item,
      jobIds,
    });
    if (Buffer.byteLength(payload, 'utf8') > MAX_WORKER_PAYLOAD_BYTES) {
      throw new Error('repair worker payload too large');
    }
    const child = spawn(execPath, [...(launch.execArgv ?? []), launch.entry, payload], {
      stdio: ['ignore', 2, 2, 'pipe'],
      env: { ...(launch.env ?? currentEntryEnv()) },
      cwd: resolve(options.stateRoot),
    });
    owned += 1;

    const channel = createWorkerChannel();
    const pipe = child.stdio[3] as Readable | null | undefined;
    let sawByte = false;
    // The first byte is the barrier verdict (`== b'a'`); every later byte,
    // whatever its value, is a refusal (`refusal_published`).
    const accept = (chunk: Uint8Array): void => {
      for (const byte of chunk) {
        channel.publish(!sawByte && byte === 0x61 ? 'admitted' : 'refused');
        sawByte = true;
      }
    };
    // Python's `refusal_published` does a nonblocking `os.read`. A byte can sit in the socket
    // before the event loop delivers it, so the refusal check reads the descriptor itself.
    const fd = (pipe as unknown as { _handle?: { fd?: number } } | null)?._handle?.fd;
    const drainPending = (): void => {
      if (typeof fd !== 'number' || fd < 0) return;
      const buffer = Buffer.alloc(256);
      for (;;) {
        let read: number;
        try {
          read = readSync(fd, buffer, 0, buffer.length, null);
        } catch {
          return; // EAGAIN (nothing pending), or the socket is already closed
        }
        if (read <= 0) return; // EOF is left to the 'end' event
        accept(buffer.subarray(0, read));
      }
    };
    if (pipe) {
      pipe.on('data', (chunk: Buffer) => accept(chunk));
      // EOF (or a socket error) with no byte is a dead worker: not admitted.
      pipe.on('end', () => channel.close());
      pipe.on('close', () => channel.close());
      pipe.on('error', () => channel.close());
    } else {
      channel.close();
    }

    let settled = false;
    const exit = new Promise<WorkerExit>((resolve) => {
      const settle = (value: WorkerExit): void => {
        if (settled) return;
        settled = true;
        owned -= 1;
        resolve(value);
      };
      child.once('exit', (code, signal) => {
        const signalNumber = signal === null ? undefined : osConstants.signals[signal];
        settle(
          code !== null
            ? { kind: 'exit', code }
            : signalNumber !== undefined
              ? { kind: 'signal', signal: signalNumber }
              : { kind: 'lost' },
        );
      });
      child.once('error', () => {
        channel.close();
        settle({ kind: 'lost' });
      });
    });
    return {
      admitted: channel.admitted,
      takeRefusal: () => {
        drainPending();
        return channel.takeRefusal();
      },
      exit,
    };
  };
}
