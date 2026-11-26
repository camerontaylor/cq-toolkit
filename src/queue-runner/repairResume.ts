/**
 * Candidate-worktree selection for a resumed repair job: `resume_worktree`
 * (apps/crq-python/crq_repair.py:472-483) and the missing-candidate refusal
 * `process` applies right after it (crq_repair.py:508-521).
 *
 * DECISION ONLY. The module never saves a result, removes or writes a
 * worktree, touches the queue, runs a judge or the mechanical gate, or spawns
 * anything. It asks injected, read-only {@link RepairResumeProbes} questions in
 * Python's order and answers with the worktree `process` would carry on with,
 * or a typed refusal naming the pending stage. The caller owns the effects
 * Python performs on a refusal (`result.update(...)`, popping the pending
 * keys, `atomic(result.json)`). Inactive: nothing imports this outside tests.
 *
 * Policy mirrored from Python, including its quirks:
 *
 * - resume handling runs only when `dispatch_pending`, `pending_judge` or
 *   `pending_mechanical` is truthy (Python truthiness: `0`, `""`, `[]`, `{}`
 *   and `null` are not pending);
 * - the recorded `worktree` replaces the caller's only when it resolves to a
 *   different path, is a directory and holds a `.git` entry (a file, as in a
 *   linked worktree, counts). There is no ownership check, despite the
 *   docstring: an `-A2` tree, a legacy name or any other directory qualifies;
 * - a falsy recorded value keeps the caller's tree and asks no probe; a truthy
 *   non-string raises `TypeError` before any probe, whichever stage is pending;
 * - the refusal fires for a pending judge or mechanical stage whose recorded
 *   tree still resolves differently from the (possibly replaced) tree, i.e. the
 *   candidate is absent, not a directory, or has no `.git` entry. It never fires for `dispatch_pending` alone, which only
 *   adopts the recorded tree;
 * - a judge stage is reported ahead of a mechanical one when both are pending.
 *
 * Failures Python lets escape (a non-string `worktree`, an embedded NUL in a
 * path) propagate as `PyError`s; probe failures propagate unchanged.
 */
import { pyTruthy } from '../policy/crq/queueDoc.js';
import { JsonNumber } from '../policy/crq/jsonValue.js';
import { PyError } from './pyErrors.js';
import { normalizePosixPath } from './repairCleanup.js';

type Rec = Record<string, unknown>;

/** Read-only questions about the filesystem, answered by a caller. */
export interface RepairResumeProbes {
  /** `Path(path).resolve()` (non-strict); an embedded NUL is `PyError('ValueError')`. */
  resolve(path: string): Promise<string>;
  /** `Path(path).is_dir()` (follows symlinks, answers false for a missing path). */
  isDirectory(path: string): Promise<boolean>;
  /** `Path(path).exists()` (follows symlinks): a `.git` file or directory is true. */
  exists(path: string): Promise<boolean>;
}

export type RepairPendingStage = 'judge' | 'mechanical';

export type RepairResumeDecision =
  /**
   * Carry on with `worktree`. `adopted` is true when the recorded tree replaced
   * the caller's, false when the caller's tree stays.
   */
  | { readonly kind: 'proceed'; readonly worktree: string; readonly adopted: boolean }
  /**
   * A pending stage's recorded candidate tree is not the tree in hand. Python
   * records `FAILED` with `reason`, clears both pending keys and returns the
   * result without judging or verifying.
   */
  | {
      readonly kind: 'refuse-missing-candidate';
      readonly pending: RepairPendingStage;
      readonly reason: string;
    };

/** Python's name for the value's type, as used in `Path()`'s `TypeError`. */
function pyTypeName(value: unknown): string {
  if (value === null || value === undefined) return 'NoneType';
  if (typeof value === 'boolean') return 'bool';
  if (value instanceof JsonNumber) return value.kind;
  if (typeof value === 'number') return Number.isInteger(value) ? 'int' : 'float';
  if (typeof value === 'bigint') return 'int';
  if (Array.isArray(value)) return 'list';
  return 'dict';
}

/** `Path(value)`: a truthy non-string recorded value is a `TypeError`. */
function pathArg(value: unknown): string {
  if (typeof value === 'string') return normalizePosixPath(value);
  throw new PyError(
    'TypeError',
    'argument should be a str or an os.PathLike object where __fspath__ returns a str, ' +
      `not '${pyTypeName(value)}'`,
  );
}

const recordedOf = (result: Rec): unknown =>
  Object.hasOwn(result, 'worktree') ? result.worktree : undefined;

/**
 * `resume_worktree(result, wt)`: the tree to resume in. Probe order is Python's:
 * resolve recorded, resolve `wt`, `is_dir(recorded)`, `exists(recorded/.git)`,
 * each skipped once the answer is settled.
 */
export async function selectResumeWorktree(
  result: Rec,
  worktree: string,
  probes: RepairResumeProbes,
): Promise<string> {
  return (await adopt(result, worktree, probes)) ?? worktree;
}

/** The recorded tree when Python would adopt it, else `undefined`. */
async function adopt(
  result: Rec,
  worktree: string,
  probes: RepairResumeProbes,
): Promise<string | undefined> {
  const raw = recordedOf(result);
  if (!pyTruthy(raw)) return undefined;
  const recorded = await probes.resolve(pathArg(raw));
  if (recorded === (await probes.resolve(normalizePosixPath(worktree)))) return undefined;
  if (!(await probes.isDirectory(recorded))) return undefined;
  if (!(await probes.exists(`${recorded === '/' ? '' : recorded}/.git`))) return undefined;
  return recorded;
}

/**
 * The resume preamble of `process`: adopt the recorded tree for any resume
 * state, then refuse a pending judge or mechanical stage whose candidate is
 * not the tree in hand.
 */
export async function decideResumeCandidate(
  result: Rec,
  worktree: string,
  probes: RepairResumeProbes,
): Promise<RepairResumeDecision> {
  const pendingJudge = pyTruthy(result.pending_judge);
  const pendingMechanical = pyTruthy(result.pending_mechanical);
  let current = worktree;
  let adopted = false;
  if (pyTruthy(result.dispatch_pending) || pendingJudge || pendingMechanical) {
    const recorded = await adopt(result, worktree, probes);
    if (recorded !== undefined) {
      current = recorded;
      adopted = true;
    }
  }
  const raw = recordedOf(result);
  if ((pendingJudge || pendingMechanical) && pyTruthy(raw)) {
    const recorded = await probes.resolve(pathArg(raw));
    if (recorded !== (await probes.resolve(normalizePosixPath(current)))) {
      const pending: RepairPendingStage = pendingJudge ? 'judge' : 'mechanical';
      return {
        kind: 'refuse-missing-candidate',
        pending,
        reason: `pending ${pending} worktree unavailable; needs human`,
      };
    }
  }
  return { kind: 'proceed', worktree: current, adopted };
}
