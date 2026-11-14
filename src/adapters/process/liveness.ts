/**
 * Detached-run liveness for queue retry admission.
 *
 * A transient receipt is not enough to accept a retry: the recorded owner must be
 * proved finished. These predicates are the fail-closed half of that proof. Every
 * uncertainty (a malformed pidfile, an unknown marker, an unprobed process
 * group) resolves to `alive`/`ambiguous`, never to a silent release.
 *
 * Ported from `crq.read_pidfile`/`pid_alive`/`proc_cmdline`/`group_alive`/
 * `run_liveness` and `author_quota.identity_kind`/`run_state`.
 */
import { execFile } from 'node:child_process';
import { JsonNumber, JsonObject } from '../../policy/crq/jsonValue.js';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Marker written into `review.pid` by a `timeout --foreground` launcher. */
export const GROUP_OWNER_MARKER = 'foreground-v1';

/** Pidfile name inside a run directory. */
export const PIDFILE_NAME = 'review.pid';

export type IdentityKind = 'managed' | 'legacy' | 'invalid';
export type LivenessState = 'alive' | 'harvest' | 'ambiguous';

function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/**
 * A persisted queue `run` keeps numbers as `JsonNumber`; the predicates below
 * compare primitive pids, so unwrap the lossless integer first. `undefined`
 * leaves every check fail-closed exactly as an absent field does.
 */
function numeric(value: unknown): number | undefined {
  if (value instanceof JsonNumber) {
    return value.kind === 'int' ? Number(value.integer) : (value.float ?? undefined);
  }
  return typeof value === 'number' ? value : undefined;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** A run-bound identity: a record with a positive integer pid AND pgid. */
export function validIdentity(pidfile: unknown): pidfile is Record<string, unknown> {
  const file = record(pidfile);
  return file !== null && positive(file.pid) && positive(file.pgid);
}

/**
 * Classify a recorded run identity.
 *
 * `managed` requires the foreground marker, the CURRENT run id and the detached
 * session shape `pid === pgid === sid`. A markerless pidfile is `legacy` unless it
 * contradicts the persisted queue pid. Everything else is `invalid`.
 */
export function identityKind(
  pidfile: unknown,
  options: { runId?: string | null; queuePid?: unknown } = {},
): IdentityKind {
  if (!validIdentity(pidfile)) return 'invalid';
  const pid = pidfile.pid as number;
  const marker = pidfile.group_owner;
  const queuePid = options.queuePid;
  if (marker === undefined || marker === null) {
    if (positive(queuePid) && pid !== queuePid) return 'invalid';
    return 'legacy';
  }
  if (marker !== GROUP_OWNER_MARKER) return 'invalid';
  if (options.runId !== undefined && options.runId !== null && pidfile.run_id !== options.runId) {
    return 'invalid';
  }
  if (!positive(pidfile.sid) || pid !== pidfile.pgid || pid !== pidfile.sid) return 'invalid';
  if (positive(queuePid) && pid !== queuePid) return 'invalid';
  return 'managed';
}

/** Fail-closed liveness decision for one probe round. */
export function runState(input: {
  hasExit: boolean;
  identity: IdentityKind;
  runnerAlive: boolean;
  cliAlive: boolean;
  runnerGroupAlive: boolean;
  wrapperGroupAlive: boolean | null;
}): LivenessState {
  if (
    input.runnerAlive ||
    input.cliAlive ||
    input.runnerGroupAlive ||
    input.wrapperGroupAlive === true
  ) {
    return 'alive';
  }
  if (input.identity === 'invalid') return 'ambiguous';
  if (!input.hasExit) return 'ambiguous';
  if (input.identity === 'legacy' && input.wrapperGroupAlive === null) return 'ambiguous';
  return 'harvest';
}

/** `crq.pid_alive`: a live pid; permission failure still proves liveness. */
export function pidAlive(pid: unknown): boolean {
  if (!positive(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** `crq.group_alive`: true unless the recorded group is PROVED empty. */
export function groupAlive(pgid: unknown): boolean {
  if (!positive(pgid)) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** `crq.proc_cmdline`: the recorded process command line, or ''. */
export async function procCmdline(pid: number): Promise<string> {
  const { stdout } = await run('ps', ['-o', 'command=', '-p', String(pid)], {
    timeout: 20_000,
  });
  return stdout.trim();
}

/** `(rdir / "exit.json").is_file()`. */
export async function hasExit(runDir: string): Promise<boolean> {
  try {
    return (await stat(join(runDir, 'exit.json'))).isFile();
  } catch {
    return false;
  }
}

/** `crq.read_pidfile`: the recorded identity, or null when absent/unreadable. */
export async function readPidfile(runDir: string): Promise<Record<string, unknown> | null> {
  try {
    const text = await readFile(join(runDir, PIDFILE_NAME), 'utf8');
    return record(JSON.parse(text));
  } catch {
    return null;
  }
}

/**
 * `crq.run_liveness`: probe the runner pid, the CLI pid and every group that can
 * own a detached review. Absence is never asserted without proof.
 */
export async function runLiveness(
  runDir: string,
  recorded: JsonObject | Record<string, unknown>,
  hasExit: boolean,
): Promise<LivenessState> {
  const field = (key: string): unknown =>
    recorded instanceof JsonObject ? recorded.get(key) : recorded[key];
  const pidfile = await readPidfile(runDir);
  const recordedRunId = field('run_id');
  const recordedPid = numeric(field('pid'));
  const runId = typeof recordedRunId === 'string' ? recordedRunId : null;
  const kind = identityKind(pidfile, {
    runId,
    queuePid: recordedPid,
  });
  const pid =
    pidfile !== null && positive(pidfile.pid)
      ? pidfile.pid
      : positive(recordedPid)
        ? recordedPid
        : null;
  const cli = pidfile !== null && positive(pidfile.cli_pid) ? pidfile.cli_pid : null;
  const runnerAlive =
    pid !== null && pidAlive(pid) && runId !== null && (await procCmdline(pid)).includes(runId);
  const cliAlive = cli !== null && pidAlive(cli) && (await procCmdline(cli)).includes('coderabbit');
  const runnerGroupAlive = groupAlive(pidfile === null ? undefined : pidfile.pgid);
  const wrapperGroupAlive = kind === 'legacy' && cli !== null ? groupAlive(cli) : null;
  return runState({
    hasExit,
    identity: kind,
    runnerAlive,
    cliAlive,
    runnerGroupAlive,
    wrapperGroupAlive,
  });
}
