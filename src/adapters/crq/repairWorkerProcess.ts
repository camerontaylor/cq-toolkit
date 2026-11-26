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
 *   would also wait for the pipe. On `'exit'` the coordinator drains what the pipe
 *   already holds, then destroys its own end (no signal to anyone), so a grandchild
 *   that inherited fd 3 cannot keep the coordinator's event loop alive;
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

/**
 * The socket descriptor behind the worker pipe is unavailable, so the synchronous
 * refusal read (Python's nonblocking `os.read`) cannot be done. Failing loudly beats a
 * silent fallback that would admit one more paid item after a refusal.
 */
export class RepairWorkerFdUnavailableError extends Error {
  override readonly name = 'RepairWorkerFdUnavailableError';
  constructor(detail: string) {
    super(`repair worker pipe has no readable descriptor: ${detail}`);
  }
}

/**
 * The live descriptor of a worker pipe, or `undefined` once the pipe is destroyed or its handle
 * closed (the number may then belong to an unrelated file, so it is never kept). Reads the
 * private `_handle.fd` of Node's `net.Socket`/`Pipe` (absent from `@types/node`; verified on
 * Node v24.22.0). Throws {@link RepairWorkerFdUnavailableError} when a live pipe has none.
 */
function livePipeFd(pipe: Readable): number | undefined {
  const socket = pipe as Readable & { closed?: boolean; _handle?: { fd?: unknown } | null };
  if (socket.destroyed || socket.closed === true || socket._handle === null) return undefined;
  const fd = socket._handle?.fd;
  if (typeof fd !== 'number' || !Number.isInteger(fd) || fd < 0) {
    throw new RepairWorkerFdUnavailableError(`_handle.fd is ${String(fd)}`);
  }
  return fd;
}

/**
 * Python's `reap_completed` status: a signal is always a number. Node reports only the name, so
 * a name missing from `os.constants.signals` is still a signal death (number 0, unknown), never
 * `lost`, which is reserved for a missing status.
 */
export function workerExitFromStatus(code: number | null, signal: string | null): WorkerExit {
  if (code !== null) return { kind: 'exit', code };
  if (signal === null) return { kind: 'lost' };
  return {
    kind: 'signal',
    signal: osConstants.signals[signal as keyof typeof osConstants.signals] ?? 0,
  };
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
    // before the event loop delivers it, so the refusal check reads the descriptor itself. The
    // number is looked up on every call and never cached: it is reusable once the pipe closes.
    const drainPending = (): void => {
      if (!pipe) return;
      const fd = livePipeFd(pipe);
      if (fd === undefined) return;
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
        // The worker is gone: take what it left in the socket, then release our end so a
        // grandchild holding fd 3 cannot pin the event loop. Destroying signals nobody.
        try {
          drainPending();
        } catch {
          // an unavailable fd is reported by takeRefusal, not here
        }
        pipe?.destroy();
        settle(workerExitFromStatus(code, signal));
      });
      child.once('error', () => {
        channel.close();
        settle({ kind: 'lost' });
      });
    });
    // Startup self-check: a Node without the descriptor must fail now, not on a later refusal.
    // The child is already running and is never killed; it exits on its own and `owned` falls.
    if (pipe) {
      try {
        livePipeFd(pipe);
      } catch (error) {
        pipe.destroy();
        throw error;
      }
    }
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
