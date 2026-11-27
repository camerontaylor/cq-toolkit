/**
 * The `recover_job` shell of `crq_repair` (apps/crq-python/crq_repair.py:1395-1528):
 * the CQ-critical-judge precondition, the tick-lock ownership check, and the
 * three closures (`judge`, `prepare`, `scan`) handed to `recovery.recover`, over
 * injected effects.
 *
 * INJECTED EFFECTS ONLY and inactive: nothing imports this outside tests, and
 * nothing here locks, spawns, reaches a provider or touches a queue. The
 * module owns the order of the gates and the closure bodies; the caller
 * supplies the tick lock, the queue and inbox reads, `dispatch`, the
 * preparation call, the secret scanner and `recovery.recover` itself
 * ({@link RecoverJobEffects}). It composes the already-ported pieces:
 * {@link decideRecoveryOwner} for `check_owner` and
 * {@link triageContextScanPatch} for `triage_context_safe`.
 *
 * Mirrored from Python, including its quirks:
 *
 * - the judge-role check reads `config['repair']['roles']['judge_critical']`
 *   before anything else, so a missing key is a `KeyError` and a non-dict role
 *   an `AttributeError`; only a role whose `driver` is exactly `'cq'` passes;
 * - the job file is read BEFORE the tick lock, and a missing or unparsable file
 *   escapes (`OSError` / `ValueError`);
 * - `check_owner` runs under the lock twice, once up front and once inside
 *   `prepare`'s own lock; either refusal is a `ValueError` whose text is
 *   Python's, a busy lock a `RuntimeError`;
 * - the judge closure re-checks the runner marker and the GLM blackout (both
 *   can start while the lock was awaited) and answers a `configuration` stop
 *   without a model call; `old['job']` and `old['run']` are read only after both
 *   gates pass;
 * - the scan closure scans, in order: the retained patch, every attempt's
 *   patches (indexed `recovery-attempt-<i>-<j>-scan.json`), the current
 *   contract as a synthetic diff, then the whole context; the first unclean
 *   answer returns `False` without scanning the rest.
 *
 * Where Python lets an uncaught exception escape the port throws a
 * {@link PyError} of the same class. The final `triage_context_safe` step reuses
 * {@link triageContextScanPatch}, whose malformed-context failures are a
 * {@link TriageContextScanRefusal} naming the Python class in a trailing
 * `(Kind)`; {@link refusalAsPyError} re-types it. Its message is Python's only
 * for the `KeyError` (`'finding'`); the `AttributeError` and `TypeError` texts
 * are the builder's own wording.
 */
import { JsonNumber, JsonObject, type JsonValue } from '../policy/crq/jsonValue.js';
import { pyTruthy } from '../policy/crq/queueDoc.js';
import { RUNNER_DISABLED } from '../policy/crq/triageJudgeGate.js';
import {
  TriageContextScanRefusal,
  triageContextScanPatch,
} from '../policy/crq/triageContextScan.js';
import { splitlines } from '../ops/crq/deploy/gitGuards.js';
import { PyError } from './pyErrors.js';
import { decideRecoveryOwner, type RepairRecoveryOwnerReads } from './repairRecoveryOwner.js';
import { get as pyGet, pyTypeName, subscript as pySubscript } from './repairProgressSelection.js';

type Dict = Record<string, unknown>;

/** What `recovery.recover` is handed and may call. */
export interface RecoverClosures {
  /** `judge(old, context, directory)`. */
  judge(old: unknown, context: unknown, directory: string): Promise<unknown>;
  /** `prepare(old_id, tip, evidence)`. */
  prepare(oldId: unknown, tip: unknown, evidence: unknown): Promise<unknown>;
  /** `scan(context, output)`. */
  scan(context: unknown, output: string): Promise<unknown>;
}

export interface RecoverJobEffects {
  /** The ownership reads `check_owner` makes (queue, triage row, retained events, prepared retry). */
  readonly owner: RepairRecoveryOwnerReads;
  /**
   * `json.loads(job_path(ROOT, job_id).read_text())`: a grammar or symlink refusal is
   * `PyError('ValueError')`, an unreadable file `PyError('OSError')`.
   */
  readJob(jobId: string): Promise<unknown>;
  /**
   * `c.ran_locked(fn)`: runs `fn` under the tick lock and answers true, or answers false
   * when the tick is busy. An exception from `fn` propagates.
   */
  ranLocked(fn: () => Promise<void>): Promise<boolean>;
  /** `c.load_queue()`, read inside `prepare`'s lock. */
  loadQueue(): Promise<unknown>;
  /** `runner_disabled()`. */
  runnerDisabled(): Promise<unknown>;
  /** `narrate(message)`. */
  narrate(message: string): Promise<void>;
  /** `publish_refusal()`. */
  publishRefusal(): Promise<void>;
  /** `blocked(config['repair'])`. */
  blocked(repair: unknown): Promise<unknown>;
  /** `dispatch(config, role, request, config['clone'], directory, judge=True)`. */
  dispatch(
    role: unknown,
    request: Dict,
    clone: unknown,
    directory: string,
    judge: true,
  ): Promise<unknown>;
  /** `repair_tick.prepare_current_job(c, queue, old_id, tip, evidence, preserve_worktree=True)`. */
  prepareCurrentJob(
    queue: unknown,
    oldId: unknown,
    tip: unknown,
    evidence: unknown,
  ): Promise<unknown>;
  /** `c.secret_scan_diff(diff, output)[0]`: the clean verdict (its truthiness is what counts). */
  secretScanDiff(diff: unknown, output: string): Promise<unknown>;
  /** `recovery.recover(ROOT, config, job_id, scan, judge, prepare)`. */
  recover(jobId: string, closures: RecoverClosures): Promise<unknown>;
}

export interface RecoverJobRequest {
  /** The loaded crq config; `repair`, `repair.roles` and `clone` are read. */
  readonly config: unknown;
  /** The explicit `--recover-job` id. */
  readonly jobId: string;
}

const isDict = (value: unknown): value is Dict =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  !(value instanceof JsonNumber) &&
  !(value instanceof JsonObject);

/** `for member in value`: a list yields its members, a dict its keys, a str its characters. */
function iterate(value: unknown): readonly unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') return [...value];
  if (isDict(value)) return Object.keys(value);
  throw new PyError('TypeError', `'${pyTypeName(value)}' object is not iterable`);
}

/** `path.with_name(name)` for the absolute, normalised POSIX paths `recover` yields. */
function withName(path: string, name: string): string {
  return `${path.slice(0, path.lastIndexOf('/') + 1)}${name}`;
}

/** Plain JSON (numbers retained) back to the {@link JsonValue} the scan-patch builder reads. */
function toJsonValue(value: unknown): JsonValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean' || typeof value === 'string') return value;
  if (value instanceof JsonNumber || value instanceof JsonObject) return value;
  if (typeof value === 'bigint') return JsonNumber.int(value);
  if (typeof value === 'number') {
    return Number.isInteger(value) ? JsonNumber.int(value) : JsonNumber.float(value);
  }
  if (Array.isArray(value)) return value.map(toJsonValue);
  return new JsonObject(Object.entries(value as Dict).map(([k, v]) => [k, toJsonValue(v)]));
}

/** The Python class a {@link TriageContextScanRefusal} names in its trailing `(Kind)`. */
function refusalAsPyError(refusal: TriageContextScanRefusal): PyError {
  const kind = /\((KeyError|AttributeError|TypeError)\)$/.exec(refusal.message)?.[1];
  if (kind === 'KeyError') return new PyError('KeyError', "'finding'");
  if (kind === 'AttributeError' || kind === 'TypeError') return new PyError(kind, refusal.message);
  return new PyError('RuntimeError', refusal.message);
}

const isString = (value: unknown): value is string => typeof value === 'string';

/** `recover_job(config, job_id)`: revalidate one failed job; the tick still owns preparation and handoff. */
export async function recoverJob(
  request: RecoverJobRequest,
  effects: RecoverJobEffects,
): Promise<unknown> {
  const { config, jobId } = request;
  const repair = pySubscript(config, 'repair');
  const judgeRole = pySubscript(pySubscript(repair, 'roles'), 'judge_critical');
  if (pyGet(judgeRole, 'driver') !== 'cq') {
    throw new PyError('ValueError', 'recovery requires the CQ structured critical judge');
  }
  const job = await effects.readJob(jobId);

  const checkOwner = async (): Promise<void> => {
    const decision = await decideRecoveryOwner({ job, jobId }, effects.owner);
    if (!decision.ok) throw new PyError('ValueError', decision.reason);
  };

  if (!(await effects.ranLocked(checkOwner))) {
    throw new PyError('RuntimeError', 'tick busy; recovery deferred');
  }

  const judge: RecoverClosures['judge'] = async (old, context, directory) => {
    if (pyTruthy(await effects.runnerDisabled())) {
      // A handover can start during the tick-lock wait above; the attempt stays
      // deferred, spends no budget and starts no model call.
      await effects.narrate(`${RUNNER_DISABLED}: recovery judge deferred`);
      await effects.publishRefusal();
      return {
        stop: 'configuration',
        errorClass: 'runner-disabled',
        reason: 'runner disabled for host handover; recovery judge deferred',
      };
    }
    if (pyTruthy(await effects.blocked(pySubscript(config, 'repair')))) {
      // The blackout can start during the tick-lock wait above; recover() holds
      // the attempt budget and defers the judgment, never a model call.
      return {
        stop: 'configuration',
        errorClass: 'blackout',
        reason: 'GLM peak blackout; recovery judge deferred',
      };
    }
    const triageRequest: Dict = {
      job: pySubscript(old, 'job'),
      run: pySubscript(old, 'run'),
      triage_context: context,
    };
    const role = pySubscript(pySubscript(pySubscript(config, 'repair'), 'roles'), 'judge_critical');
    return effects.dispatch(
      role,
      triageRequest,
      pySubscript(config, 'clone'),
      `${directory}/recovery-judge`,
      true,
    );
  };

  const prepare: RecoverClosures['prepare'] = async (oldId, tip, evidence) => {
    const output: unknown[] = [];
    const locked = async (): Promise<void> => {
      await checkOwner();
      output.push(await effects.prepareCurrentJob(await effects.loadQueue(), oldId, tip, evidence));
    };
    if (!(await effects.ranLocked(locked))) {
      throw new PyError('RuntimeError', 'tick busy; recovery preparation deferred');
    }
    return output[0];
  };

  const scan: RecoverClosures['scan'] = async (context, output) => {
    const patch = pySubscript(context, 'retained_patch');
    if (
      pyTruthy(patch) &&
      !pyTruthy(await effects.secretScanDiff(patch, withName(output, 'recovery-patch-scan.json')))
    ) {
      return false;
    }
    const attempts = iterate(pySubscript(context, 'retained_attempts'));
    for (const [index, retained] of attempts.entries()) {
      const patches = iterate(pySubscript(retained, 'patches'));
      for (const [part, attemptPatch] of patches.entries()) {
        if (
          pyTruthy(attemptPatch) &&
          !pyTruthy(
            await effects.secretScanDiff(
              attemptPatch,
              withName(output, `recovery-attempt-${index}-${part}-scan.json`),
            ),
          )
        ) {
          return false;
        }
      }
    }
    const contract = pySubscript(context, 'current_contract');
    const text = pySubscript(contract, 'text');
    if (pyTruthy(text)) {
      const path = pySubscript(contract, 'path');
      if (!isString(path)) {
        throw new PyError(
          'TypeError',
          `can only concatenate str (not "${pyTypeName(path)}") to str`,
        );
      }
      if (!isString(text)) {
        throw new PyError(
          'AttributeError',
          `'${pyTypeName(text)}' object has no attribute 'splitlines'`,
        );
      }
      const lines = splitlines(text).map((line) => `+${line}`);
      const diff = `diff --git a/${path} b/${path}\n@@ -0,0 +1 @@\n${lines.join('\n')}\n`;
      if (
        !pyTruthy(
          await effects.secretScanDiff(diff, withName(output, 'recovery-contract-scan.json')),
        )
      ) {
        return false;
      }
    }
    let patchText: string;
    try {
      patchText = triageContextScanPatch(toJsonValue(context));
    } catch (e) {
      if (e instanceof TriageContextScanRefusal) throw refusalAsPyError(e);
      throw e;
    }
    return effects.secretScanDiff(patchText, output);
  };

  return effects.recover(jobId, { judge, prepare, scan });
}
