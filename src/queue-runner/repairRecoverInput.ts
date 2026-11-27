/**
 * Input preflight for `crq_repair.recovery.recover`
 * (apps/crq-python/crq_repair/recovery.py, from `root = Path(root)` to the
 * `only terminal failed jobs can be recovered` check): which immutable job and
 * which terminal failed result a recovery would work on, taken from the job's
 * inbox file and its `result.json` (or, when the worker was interrupted before
 * writing one, its `progress.json`).
 *
 * DECISION ONLY and inactive: nothing imports this outside tests. It stops
 * where Python stops being a pure function of those three files, before
 * `source_path(job['finding'])`: no Git, no source or contract read, no
 * worktree, no retained-attempt archives, no scans, no judge, and no write to
 * `recovery.json`. Every fact is an injected read ({@link RecoverInputReads}),
 * asked in Python's order and lazily, so a refusal never asks a later question.
 *
 * Python raises a `ValueError` with a fixed message for each refusal. The
 * decision names it as a typed {@link RecoverInputRefusal} and carries that
 * exact text as `reason`. Failures Python lets escape are not refusals and
 * propagate as `PyError`s of the same class:
 *
 * - a job id outside `bounded.JOB_ID` is `job_path`'s `ValueError`, raised
 *   before any read; a symlinked or relocated job path is the same class from
 *   `readJob`, an unreadable or unparsable file `OSError` / `ValueError`;
 * - a job that is not an object is `AttributeError` at `job.get('job')`;
 * - a missing or unparsable `progress.json` (only read when no `result.json`
 *   exists) is `OSError` / `ValueError`;
 * - a `result.json` that is not an object is the identity refusal, not an error.
 *
 * Quirks mirrored deliberately:
 *
 * - the interrupted-dispatch result is `{**progress, 'verdict': 'FAILED',
 *   'reason': ...}`, so a `retry_after` the progress record carries still
 *   refuses it, and a progress record without `job` or `item` fails identity
 *   exactly as a result would;
 * - `result.get('item') != job.get('item')` compares with Python `==`: a job
 *   and a result that both lack `item` match (`None == None`), `1 == 1.0`, and
 *   a decoded `NaN` member of a list or dict equals itself (identity shortcut);
 * - which file is read is decided by `exists()` alone, so a `result.json` that
 *   is a directory is read (and fails `IsADirectoryError`), never replaced by
 *   the progress fallback.
 */
import { JsonNumber } from '../policy/crq/jsonValue.js';
import { pyTruthy } from '../policy/crq/queueDoc.js';
import { PyError } from './pyErrors.js';
import { pyEqual } from './repairRecoveryOwner.js';
import { get } from './repairProgressSelection.js';

type Rec = Record<string, unknown>;

/** `bounded.JOB_ID` fullmatch: one exact CRQ job id, never a path. */
const JOB_ID = /^crq-[A-Za-z0-9._-]+$/;

/** The reason `recover` writes into a result it synthesises from `progress.json`. */
export const INTERRUPTED_REASON = 'worker interrupted with unknown outcome';

export type RecoverInputRefusal =
  /** `job identity mismatch` */
  | 'job-identity-mismatch'
  /** `no interrupted dispatch or terminal result` */
  | 'no-interrupted-dispatch'
  /** `result identity mismatch` */
  | 'result-identity-mismatch'
  /** `only terminal failed jobs can be recovered` */
  | 'not-terminal-failed';

const REASONS: Readonly<Record<RecoverInputRefusal, string>> = {
  'job-identity-mismatch': 'job identity mismatch',
  'no-interrupted-dispatch': 'no interrupted dispatch or terminal result',
  'result-identity-mismatch': 'result identity mismatch',
  'not-terminal-failed': 'only terminal failed jobs can be recovered',
};

export type RecoverInputDecision =
  | {
      readonly ok: true;
      /** The job file as `json.loads` yields it (always an object here). */
      readonly job: Rec;
      /** `result.json`, or the result synthesised from an interrupted dispatch. */
      readonly result: Rec;
      /** True when `result` came from `progress.json` rather than `result.json`. */
      readonly interrupted: boolean;
    }
  | {
      readonly ok: false;
      readonly refusal: RecoverInputRefusal;
      /** Python's `ValueError` message. */
      readonly reason: string;
    };

const refuse = (refusal: RecoverInputRefusal): RecoverInputDecision => ({
  ok: false,
  refusal,
  reason: REASONS[refusal],
});

/**
 * Read-only questions answered by the caller. Values are parsed JSON as
 * Python's `json.loads` yields them; supply `toPlainJsonRetainingNumbers`
 * output so an int/float kind survives where it reaches a comparison.
 */
export interface RecoverInputReads {
  /**
   * `json.loads(job_path(root, jobId).read_text())`, called only for an id that
   * already passed the grammar. A symlink or relocation refusal is
   * `PyError('ValueError')`, an unreadable file `PyError('OSError')`.
   */
  readJob(jobId: string): Promise<unknown>;
  /** `(root / 'state/repair' / jobId / 'result.json').exists()`. */
  resultExists(jobId: string): Promise<boolean>;
  /** `json.loads((root / 'state/repair' / jobId / 'result.json').read_text())`. */
  readResult(jobId: string): Promise<unknown>;
  /** `json.loads((root / 'state/repair' / jobId / 'progress.json').read_text())`. */
  readProgress(jobId: string): Promise<unknown>;
}

const isDict = (value: unknown): value is Rec =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  // A retained-number wrapper is a scalar, not a mapping.
  !(value instanceof JsonNumber);

/**
 * `{**progress, 'verdict': 'FAILED', 'reason': INTERRUPTED_REASON}`: own
 * properties are defined, never assigned, so a `__proto__` key stays data.
 */
function interruptedResult(progress: Rec): Rec {
  const result: Rec = {};
  const set = (key: string, value: unknown): void => {
    Object.defineProperty(result, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  };
  for (const [key, value] of Object.entries(progress)) set(key, value);
  set('verdict', 'FAILED');
  set('reason', INTERRUPTED_REASON);
  return result;
}

/** The input prefix of `recovery.recover`: the job, and the terminal failed result to recover. */
export async function decideRecoverInput(
  request: { readonly jobId: string },
  reads: RecoverInputReads,
): Promise<RecoverInputDecision> {
  const { jobId } = request;
  if (typeof jobId !== 'string' || !JOB_ID.test(jobId)) {
    throw new PyError('ValueError', 'expected one exact CRQ job id');
  }
  const job = await reads.readJob(jobId);
  if (get(job, 'job') !== jobId) return refuse('job-identity-mismatch');

  let result: unknown;
  let interrupted = false;
  if (await reads.resultExists(jobId)) {
    result = await reads.readResult(jobId);
  } else {
    const progress = await reads.readProgress(jobId);
    if (!isDict(progress) || !pyTruthy(get(progress, 'dispatch_pending'))) {
      return refuse('no-interrupted-dispatch');
    }
    result = interruptedResult(progress);
    interrupted = true;
  }
  if (
    !isDict(result) ||
    get(result, 'job') !== jobId ||
    !pyEqual(get(result, 'item'), get(job, 'item'))
  ) {
    return refuse('result-identity-mismatch');
  }
  if (get(result, 'verdict') !== 'FAILED' || pyTruthy(get(result, 'retry_after'))) {
    return refuse('not-terminal-failed');
  }
  return { ok: true, job: job as Rec, result, interrupted };
}
