/**
 * Host effects for the crq tick/slot scheduling pass.
 *
 * This adapter binds the scheduling policy to real state: the runner's
 * `queue.json` and `config.json`, the `runner-disabled` marker, the vendor
 * usage probe, detached-run directories, pidfile identity, process existence
 * and command lines, and one clock reading. It mirrors the Python call sites
 * (`crq.load_queue`'s reader, `usage_slots.read_usage`,
 * `usage_slots.vendor_progress`, `crq.read_pidfile`, `crq.pid_alive`,
 * `crq.group_alive`, `crq.proc_cmdline`).
 *
 * Every read is bounded and every probe is fail-closed:
 *
 * - Queue and config text is decoded as strict UTF-8 without BOM stripping, so
 *   a corrupt file is rejected instead of replacement-decoded (Python raises
 *   `UnicodeDecodeError`).
 * - `coderabbit usage --agent` runs in the configured clone with a 20-second
 *   timeout; a missing binary, a non-zero exit or a timeout is "unavailable",
 *   never a zero observation.
 * - `vendor_progress` reads at most the first 64 KiB of `review.ndjson`, the
 *   same bounded evidence Python reads, and never treats a pid, a launch
 *   record or a `review_context` as progress.
 * - `groupAlive` (from `./process.js`) treats every error other than a
 *   proved-absent group (ESRCH) as alive, so an unreadable or reused process
 *   group retains capacity. Python's own-group short circuit is equivalent:
 *   `killpg(getpgrp(), 0)` succeeds because we are in that group.
 * - `procCmdline` asks `ps`; a `ps` failure is an empty command line, which
 *   never proves a runner alive.
 */
import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { JsonObject, parseJsonValue } from '../../policy/crq/jsonValue.js';
import { isRecord } from '../../policy/crq/receiptIdentity.js';
import { groupAlive } from './process.js';
import { parseUsage, type VendorUsage } from '../../policy/crq/usageSlots.js';

/** Directories one scheduling pass reads. */
export interface TickRoots {
  /** The runner checkout: `config.json` and `state/` live here. */
  readonly runnerRoot: string;
  /** The state directory: `queue.json`, `runs/`, `runner-disabled` live here. */
  readonly stateRoot: string;
}

/** Every effect the scheduling pass performs. */
export interface TickEffects {
  readQueue(): Promise<string>;
  readConfig(): Promise<string>;
  /** `(STATE / "runner-disabled").exists()`. */
  runnerDisabled(): Promise<boolean>;
  /** `usage_slots.read_usage(clone)`: the first trustworthy observation, or null. */
  readUsage(clone: string): Promise<VendorUsage | null>;
  /** `usage_slots.vendor_progress(RUNS / run_id / "review.ndjson")`. */
  vendorProgress(runId: string): Promise<boolean>;
  /** `(RUNS / run_id / "exit.json").exists()`. */
  runExited(runId: string): Promise<boolean>;
  /** `crq.read_pidfile(RUNS / run_id)`: the parsed record, or null. */
  readPidfile(runId: string): Promise<unknown>;
  /** `crq.pid_alive`. */
  pidAlive(pid: number): boolean;
  /** `crq.group_alive`. */
  groupAlive(pgid: number): boolean;
  /** `crq.proc_cmdline`; empty when the process or `ps` is unavailable. */
  processCommand(pid: number): Promise<string>;
  /** `crq.now()` in epoch microseconds (one reading per pass). */
  nowMicros(): bigint;
}

/** Strict UTF-8 text, matching Python's locale-default read. */
async function readTextStrict(path: string): Promise<string> {
  const bytes = await readFile(path);
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (error) {
    throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** `crq.pid_alive`: gone only on a proved absence; permission denies are alive. */
function pidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/**
 * `crq.proc_cmdline`: `ps -o command= -p <pid>`, trimmed. A failure, a
 * timeout or a dead process yields the empty string, which matches Python's
 * `check=False` stdout of "".
 */
export function processCommand(pid: number): Promise<string> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return Promise.resolve('');
  return new Promise((resolve) => {
    execFile(
      'ps',
      ['-o', 'command=', '-p', String(pid)],
      { timeout: 20_000, encoding: 'utf8' },
      (error, stdout) => {
        if (error) {
          resolve('');
          return;
        }
        resolve(stdout.trim());
      },
    );
  });
}

/** `usage_slots.read_usage`: a bounded probe in the configured clone. */
function readVendorUsage(clone: string): Promise<VendorUsage | null> {
  return new Promise((resolve) => {
    execFile(
      'coderabbit',
      ['usage', '--agent'],
      { cwd: clone, timeout: 20_000, encoding: 'utf8' },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        resolve(parseUsage(stdout));
      },
    );
  });
}

const VENDOR_PROGRESS_BYTES = 65_536;

/**
 * `usage_slots.vendor_progress`: bounded positive evidence from the head of
 * the review stream. Only a `status` of reviewing/writing or a reviewing
 * heartbeat counts; unreadable or malformed input is not progress.
 */
async function vendorProgress(path: string): Promise<boolean> {
  let text: string;
  try {
    const bytes = await readFile(path);
    text = bytes.subarray(0, VENDOR_PROGRESS_BYTES).toString('utf8');
  } catch {
    return false;
  }
  for (const line of text.split('\n')) {
    if (line === '') continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(event)) continue;
    if (event.type === 'status' && (event.status === 'reviewing' || event.status === 'writing')) {
      return true;
    }
    if (event.type === 'heartbeat' && event.status === 'reviewing') return true;
  }
  return false;
}

/** `crq.read_pidfile`: the parsed record, or null when absent/malformed/not an object. */
async function readPidfile(runDir: string): Promise<unknown> {
  let text: string;
  try {
    text = await readTextStrict(join(runDir, 'review.pid'));
  } catch {
    return null;
  }
  let value: unknown;
  try {
    // Lossless: a recorded `42.0` stays a Python float and is refused as a pid.
    value = parseJsonValue(text, { duplicates: 'last' });
  } catch {
    return null;
  }
  return value instanceof JsonObject ? value : null;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Bind the scheduling pass to one runner root and one state root. */
export function fileTickEffects(roots: TickRoots, clock: () => number = Date.now): TickEffects {
  const runsRoot = join(roots.stateRoot, 'runs');
  return {
    readQueue: () => readTextStrict(join(roots.stateRoot, 'queue.json')),
    readConfig: () => readTextStrict(join(roots.runnerRoot, 'config.json')),
    runnerDisabled: () => exists(join(roots.stateRoot, 'runner-disabled')),
    readUsage: (clone: string) => readVendorUsage(clone),
    vendorProgress: (runId: string) => vendorProgress(join(runsRoot, runId, 'review.ndjson')),
    runExited: (runId: string) => exists(join(runsRoot, runId, 'exit.json')),
    readPidfile: (runId: string) => readPidfile(join(runsRoot, runId)),
    pidAlive,
    groupAlive,
    processCommand,
    nowMicros: () => BigInt(Math.trunc(clock())) * 1000n,
  };
}
