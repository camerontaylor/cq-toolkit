/** Inactive file/git binding of the drain's `classifyJob` effect
 * (`bounded.drain_job`, `RepairDrainEffects.classifyJob`): reads the inbox job
 * file, the canonical triage row and the `started` markers under the state
 * root, wires the policy's synchronous git seam to the clone, and returns the
 * policy's `(status, job, reason)` with Python's prose reason.
 *
 * Reads mirror Python. `bounded.job_path` refuses a symlinked or relocated
 * target (`job path outside inbox`); a failed read or parse becomes
 * `unreadable job: <str(exc)[:200]>` with the OSError text rendered the way
 * CPython does (`[Errno 2] No such file or directory: '<path>'`). A queue
 * that is not a JSON object tree is the policy's business. Nothing imports
 * this from a runtime entry point.
 *
 * Documented prose deviations (the typed status and refusal are exact): a JSON
 * syntax error carries this parser's wording, not CPython's `Expecting ...:
 * line N column M (char K)`; an invalid UTF-8 job file carries a fixed
 * decode message. Both appear only in a skipped job's narrate line.
 */
import { spawnSync } from 'node:child_process';
import { constants } from 'node:os';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DrainJobClass } from '../../ops/crq/internal/repairDrain.js';
import { GIT_HARDEN } from '../../shared/gitHarden.js';
import {
  JsonObject,
  parseJsonValue,
  pythonNonFinite,
  type JsonValue,
} from '../../policy/crq/jsonValue.js';
import {
  drainJob,
  type RepairJobFile,
  type RepairSelectionGit,
} from '../../policy/crq/repairSelection.js';
import { gitEnv } from './publishSource.js';
import { checkRepairJobId } from './repairPreparation.js';

/**
 * One synchronous git call: the exit status and the decoded stdout. `error` is
 * set when the process could not be run to completion (spawn failure such as
 * `ENOENT`/`EAGAIN`, or the timeout): Python's `command()` raises there, so the
 * binding rejects instead of reading it as an ordinary missing ref or blob.
 */
export type RunGitSync = (args: readonly string[]) => {
  readonly status: number | null;
  readonly stdout: string;
  readonly error?: unknown;
};

export interface RepairClassifySourceOptions {
  /** The state root (`STATE`): the directory holding `queue.json` and `repair/`. */
  readonly stateRoot: string;
  readonly clone: string;
  /** Test seam; defaults to a hardened `git -C <clone>` over `spawnSync`. */
  readonly runGitSync?: RunGitSync;
}

const GIT_TIMEOUT_MS = 1_200_000; // `command(..., timeout=1200)`.
const MAX_BUFFER = 64 * 1024 * 1024;
const CANONICAL_ID = /^[0-9a-f]{64}$/u;
// `ignoreBOM` keeps a leading U+FEFF: Python's `read_text()` keeps it and
// `json.loads` then refuses the document.
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const BOM_DETAIL = 'Unexpected UTF-8 BOM (decode using utf-8-sig): line 1 column 1 (char 0)';

const ERRNO_TEXT: Readonly<Record<string, string>> = {
  ENOENT: 'No such file or directory',
  EACCES: 'Permission denied',
  EISDIR: 'Is a directory',
  ENOTDIR: 'Not a directory',
  ELOOP: 'Too many levels of symbolic links',
  ENAMETOOLONG: 'File name too long',
  EIO: 'Input/output error',
  EMFILE: 'Too many open files',
  ENFILE: 'Too many open files in system',
  EPERM: 'Operation not permitted',
  EFAULT: 'Bad address',
  EOVERFLOW: 'Value too large for defined data type',
  ENOMEM: 'Cannot allocate memory',
};

/** CPython `repr(str)` for a path: single quotes unless only the text holds one. */
function pythonStrRepr(value: string): string {
  const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
  let out = quote;
  for (const char of value) {
    if (char === quote || char === '\\') out += `\\${char}`;
    else if (char === '\n') out += '\\n';
    else if (char === '\r') out += '\\r';
    else if (char === '\t') out += '\\t';
    else out += char;
  }
  return out + quote;
}

/** `str(OSError)`: `[Errno N] <strerror>: '<path>'`. */
export function osErrorText(error: unknown, path: string): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  const known = code === undefined ? undefined : ERRNO_TEXT[code];
  const number =
    code === undefined ? undefined : (constants.errno as Readonly<Record<string, number>>)[code];
  if (known === undefined || number === undefined) {
    const message = error instanceof Error ? error.message : String(error);
    return `${message}: ${pythonStrRepr(path)}`;
  }
  return `[Errno ${String(number)}] ${known}: ${pythonStrRepr(path)}`;
}

/**
 * `json.loads(job_path(root, job_id).read_text())` as the policy's one
 * observation: the parsed value, or Python's `str(exc)` tail.
 */
function readJobFile(stateRoot: string, jobId: string): RepairJobFile {
  const inbox = join(stateRoot, 'repair', 'inbox');
  const target = join(inbox, `${jobId}.json`);
  let linked = false;
  try {
    linked = lstatSync(target).isSymbolicLink();
  } catch {
    // Python `is_symlink()` is False on a missing path or an OS error; the
    // read below then fails with the real errno text.
  }
  if (linked) return { kind: 'unreadable', detail: 'job path outside inbox' };
  let relocated = false;
  try {
    relocated = dirname(realpathSync(target)) !== realpathSync(inbox);
  } catch {
    // A missing target or inbox resolves non-strictly to the inbox itself.
  }
  if (relocated) return { kind: 'unreadable', detail: 'job path outside inbox' };
  let bytes: Buffer;
  try {
    bytes = readFileSync(target);
  } catch (error) {
    return { kind: 'unreadable', detail: osErrorText(error, target) };
  }
  let text: string;
  try {
    text = utf8.decode(bytes);
  } catch {
    return { kind: 'unreadable', detail: "'utf-8' codec can't decode the job file" };
  }
  // CPython's `JSONDecodeError` text for a document that starts with a BOM.
  if (text.startsWith('\uFEFF')) return { kind: 'unreadable', detail: BOM_DETAIL };
  try {
    return { kind: 'value', value: parseJsonValue(text, { parseConstant: pythonNonFinite }) };
  } catch (error) {
    return { kind: 'unreadable', detail: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The canonical triage row text for the job, or `undefined` when there is
 * none to read. Python only reads it for a well-formed `canonical_finding_id`;
 * the policy refuses a malformed id before it consults the text, and a read
 * or decode failure is its `canonical delivery state unavailable`.
 */
function readTriageRow(stateRoot: string, job: JsonValue | undefined): string | undefined {
  if (!(job instanceof JsonObject)) return undefined;
  const fid = job.get('canonical_finding_id');
  if (typeof fid !== 'string' || !CANONICAL_ID.test(fid)) return undefined;
  try {
    return utf8.decode(
      readFileSync(join(stateRoot, 'backfill', 'findings', 'triage', `${fid}.json`)),
    );
  } catch {
    return undefined;
  }
}

/** `bounded.started`: `result.json` or `progress.json` exists for the job. */
function started(stateRoot: string, jobId: string): boolean {
  const directory = join(stateRoot, 'repair', jobId);
  return existsSync(join(directory, 'result.json')) || existsSync(join(directory, 'progress.json'));
}

function spawnGitSync(clone: string): RunGitSync {
  return (args) => {
    const call = spawnSync('git', ['-C', clone, ...GIT_HARDEN, ...args], {
      env: gitEnv(),
      encoding: 'utf8',
      maxBuffer: MAX_BUFFER,
      timeout: GIT_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });
    return { status: call.status, stdout: call.stdout ?? '', error: call.error };
  };
}

/** The policy's git seam over one synchronous runner (`bounded.py`'s five reads). */
function selectionGit(run: RunGitSync): RepairSelectionGit {
  // A git that could not run (spawn failure, timeout) is Python's raised
  // `command()` error: the drain errors and the job stays queued. Only a
  // completed non-zero exit is the ordinary "absent" observation, so a
  // transient failure can never reach `markStale`.
  const call = (args: readonly string[]): ReturnType<RunGitSync> => {
    const result = run(args);
    if (result.error !== undefined && result.error !== null) {
      throw new Error(`git ${args[0] ?? ''} could not run`, { cause: result.error });
    }
    return result;
  };
  const out = (args: readonly string[]): string | undefined => {
    const result = call(args);
    return result.status === 0 ? result.stdout.trim() : undefined;
  };
  return {
    currentTip() {
      const tip = out(['rev-parse', 'origin/main']);
      if (tip === undefined) throw new Error('git rev-parse failed');
      return tip;
    },
    checkedBlob: (ref, path) => out(['rev-parse', `${ref}:${path}`]),
    blobAt: (ref, path) => out(['rev-parse', '--verify', '--quiet', `${ref}:${path}`]),
    isAncestor: (ancestor, descendant) =>
      call(['merge-base', '--is-ancestor', ancestor, descendant]).status === 0,
    originBranchHead: (branch) =>
      out(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}^{commit}`]),
  };
}

/** `bounded.drain_job` against the queue the drain just read. */
export function fileRepairClassifyJob(
  options: RepairClassifySourceOptions,
): (queue: JsonValue, jobId: string) => Promise<DrainJobClass> {
  const git = selectionGit(options.runGitSync ?? spawnGitSync(options.clone));
  return (queue, jobId) =>
    new Promise((resolveClass) => {
      const validId = checkRepairJobId(jobId);
      // `job_path` raises before any read for an invalid id; the policy refuses
      // it first, so nothing below touches the filesystem.
      const jobFile: RepairJobFile = validId
        ? readJobFile(options.stateRoot, jobId)
        : { kind: 'unreadable' };
      const job = jobFile.kind === 'value' ? jobFile.value : undefined;
      const outcome = drainJob({
        jobId,
        jobFile,
        queue,
        triageRowText: readTriageRow(options.stateRoot, job),
        started: validId && started(options.stateRoot, jobId),
        git,
      });
      resolveClass({ status: outcome.status, job: outcome.job, reason: outcome.reason });
    });
}
