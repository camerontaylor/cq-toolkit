/**
 * The rung state machine of `crq_repair.process`
 * (apps/crq-python/crq_repair.py:486-789): resume handling, the A0 / A1 / A2
 * fixer rungs, the J judge stage, their resume markers (`dispatch_pending`,
 * `pending_judge`, `pending_mechanical`) and every `result.json` /
 * `progress.json` save, over injected effects.
 *
 * INJECTED EFFECTS ONLY and inactive: nothing imports this outside tests, and
 * nothing here spawns, reaches a provider, takes a lock or touches a queue. The
 * module owns the decisions and the order of effects; the caller supplies
 * `dispatch`, `mechanical`, `retain`, the git and filesystem reads, the pause
 * source and the clock ({@link RepairRungEffects}). The pure pieces it reuses
 * are `selectRepairProgress` (:486-508), `decideResumeCandidate` (:508-521) and
 * the slice-7 helpers (`failureClassForStop`, `judgeRequired`).
 *
 * Policy mirrored from Python, including its quirks:
 *
 * - `result.get('next_rung', max(<int(a['rung'][1:]) + 1 ...>, default=0))`
 *   evaluates the `max(...)` default EAGERLY, so a malformed `attempts` list
 *   raises (outside the loop's `try`, so it escapes) even when `next_rung` is
 *   recorded;
 * - everything above the `try` (role lookup, `deepcopy`, the `while rung < 3`
 *   comparison, `job.json`, `job['repair_base']`) escapes to the caller;
 *   everything inside it is caught by `except Exception` and recorded as the
 *   rung's `reason`, including a `KeyError` raised from a handler body;
 * - `report.get('driver', role['driver'])` evaluates `role['driver']` and
 *   `role['model']` eagerly, so a role lacking either fails a rung whose
 *   report names its own, and the handler's own `role['driver']` escapes;
 * - a pending judge or mechanical stage never repeats its fixer, and a
 *   `DetectorUnavailable` is the only exception that preserves a committed
 *   candidate for a mechanical-only retry;
 * - a truthy `dispatch_pending` read from `progress.json` is "worker
 *   interrupted with unknown outcome" and fails the job closed.
 *
 * Where Python lets an uncaught exception escape the port throws a
 * {@link PyError} of the same class. Documented deviations: a `next_rung`
 * that is a float or a bool (Python accepts both and builds `A1.5` / `ATrue`
 * directories) is refused with a `TypeError`; `int()` of a rung suffix accepts
 * ASCII digits only; `str()` of a container rung inside the `pending_mechanical`
 * comparison never equals a rung string.
 */
import { JsonNumber, type JsonValue } from '../policy/crq/jsonValue.js';
import { pythonRepr } from '../policy/crq/prReviewFindings.js';
import { pyTruthy } from '../policy/crq/queueDoc.js';
import { formatUtcMicros } from '../policy/crq/utc.js';
import { pyStrip, splitlines } from '../ops/crq/deploy/gitGuards.js';
import { isPyError, PyError, excText } from './pyErrors.js';
import { normalizePosixPath } from './repairCleanup.js';
import { failureClassForStop, judgeRequired } from './repairProcessHelpers.js';
import {
  get as pyGet,
  pyStrRepr,
  pyTypeName,
  selectRepairProgress,
  subscript as pySubscript,
  type RepairProgressSelectionReads,
} from './repairProgressSelection.js';
import { decideResumeCandidate, pathArg, type RepairResumeProbes } from './repairResume.js';

type Dict = Record<string, unknown>;

/** `DEFAULT_RATE_LIMIT_PAUSE` (`crq_repair.py:26`), in microseconds. */
const DEFAULT_RATE_LIMIT_PAUSE_MICROS = 30n * 60n * 1_000_000n;

/** Everything `process` does besides deciding: read, save, run and wait. */
export interface RepairRungEffects {
  /** Result/progress file reads and the clock (`utc()`, `datetime.now`). */
  readonly reads: RepairProgressSelectionReads;
  /** Read-only filesystem questions behind `resume_worktree` and the `Path(...).resolve()` calls. */
  readonly probes: RepairResumeProbes;
  /** `directory.mkdir(parents=True, exist_ok=True)`. */
  ensureDirectory(path: string): Promise<void>;
  /** `Path(path).exists()`. */
  pathExists(path: string): Promise<boolean>;
  /** `atomic(path, value)`: the value is serialised at call time (later mutation must not leak). */
  writeJson(path: string, value: unknown): Promise<void>;
  /** `blocked(repair)`. */
  blocked(repair: unknown): Promise<boolean>;
  /** `rate_limit_pause(report, job_id)`: writes the global pause and returns its stamp. */
  rateLimitPause(report: unknown, jobId: unknown): Promise<string>;
  /** `retain(wt, base, directory[, include_clean=True])`. */
  retain(
    worktree: string,
    base: unknown,
    directory: string,
    options?: { readonly includeClean: true },
  ): Promise<void>;
  /** `retain_preserving_nested(wt, base, directory)`. */
  retainPreservingNested(worktree: string, base: unknown, directory: string): Promise<void>;
  /** `git(cwd, *args)`: stdout stripped; a failing git is a `RuntimeError`. */
  git(cwd: unknown, ...args: readonly string[]): Promise<string>;
  /** `command(['git', 'cat-file', 'blob', ref], cwd=wt)`: the exit code and stdout. */
  catFileBlob(
    cwd: string,
    ref: string,
  ): Promise<{ readonly returncode: number; readonly stdout: string }>;
  /**
   * `dispatch(config, role, current, wt, directory[, judge=True])`.
   *
   * The returned report must carry numbers as `JsonNumber`: a plain JS number cannot say
   * `1.0` from `1`, so a native number is read as an int when integral (a citation `line`
   * of `1.0` would then be accepted, where Python refuses it) and as a float otherwise.
   */
  dispatch(
    role: unknown,
    current: Dict,
    worktree: string,
    directory: string,
    judge: boolean,
  ): Promise<unknown>;
  /** `mechanical(config, wt, base, commits, job_id, directory)`; numbers as for `dispatch`. */
  mechanical(
    worktree: string,
    base: unknown,
    commits: unknown,
    jobId: unknown,
    directory: string,
  ): Promise<unknown>;
  /** `random.random()`. */
  random(): number;
}

export interface RepairRungRequest {
  /** The loaded crq config; `repair`, `repair.roles` and `clone` are read. */
  readonly config: unknown;
  /** `json.loads` of the job's inbox file. */
  readonly job: unknown;
  /** `str(wt)`: the worktree the first rung runs in. */
  readonly worktree: string;
  /** `ROOT`: the state root whose `state/repair/<job>` holds this job's directory. */
  readonly root: string;
}

const isDict = (value: unknown): value is Dict =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  !(value instanceof JsonNumber);

/** `value.get(key, default)`: the default only when the key is absent (a present `null` wins). */
function getDefault(value: unknown, key: string, fallback: unknown): unknown {
  pyGet(value, key);
  return Object.hasOwn(value as Dict, key) ? (value as Dict)[key] : fallback;
}

/** `dict.update(...)` with keyword arguments: Python's insertion order. */
function update(result: Dict, entries: ReadonlyArray<readonly [string, unknown]>): void {
  for (const [key, value] of entries) result[key] = value;
}

/** Python's `a or b`: `b` only when `a` is falsy. */
function orElse(a: unknown, b: () => unknown): unknown {
  return pyTruthy(a) ? a : b();
}

/** `result.pop(key, None)`. */
function pop(result: Dict, key: string): void {
  delete result[key];
}

/** `copy.deepcopy` of parsed JSON; numbers are immutable and shared. */
function deepcopy<T>(value: T): T {
  if (Array.isArray(value)) return value.map(deepcopy) as T;
  if (isDict(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, deepcopy(v)])) as T;
  }
  return value;
}

/** `str(value)[:limit]`, sliced by code point. */
function clipPoints(text: string, limit: number): string {
  const points = Array.from(text);
  return points.length <= limit ? text : points.slice(0, limit).join('');
}

/** `'A' + str(rung)` for the rung kinds the machine accepts. */
const rungName = (rung: bigint): string => `A${rung.toString()}`;

/**
 * `str(value)` over parsed JSON: containers render as Python reprs (`['x']`), floats keep
 * their Python spelling. Native integers are ints, so they render as such.
 */
function pyStrOfValue(value: unknown): string {
  return typeof value === 'string' ? value : pyReprOfValue(value);
}

/** `repr(value)` over parsed JSON with plain objects as dicts. */
function pyReprOfValue(value: unknown): string {
  if (value === undefined) return 'None';
  if (typeof value === 'number' && Number.isInteger(value)) return String(value);
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return `[${value.map(pyReprOfValue).join(', ')}]`;
  if (isDict(value)) {
    return `{${Object.entries(value)
      .map(([key, entry]) => `${pyReprOfValue(key)}: ${pyReprOfValue(entry)}`)
      .join(', ')}}`;
  }
  return pythonRepr(value as JsonValue);
}

/** `int(text)` for a `str`: surrounding whitespace, a sign and underscores between digits. */
function pyIntOfString(text: string): bigint {
  const trimmed = pyStrip(text);
  if (!/^[+-]?[0-9]+(?:_[0-9]+)*$/.test(trimmed)) {
    throw new PyError('ValueError', `invalid literal for int() with base 10: ${pyStrRepr(text)}`);
  }
  return BigInt(trimmed.replaceAll('_', ''));
}

/** `int(a['rung'][1:]) + 1` for one attempt record. */
function nextRungAfter(attempt: unknown): bigint {
  const rung = pySubscript(attempt, 'rung');
  if (typeof rung === 'string') return pyIntOfString(Array.from(rung).slice(1).join('')) + 1n;
  if (Array.isArray(rung)) {
    throw new PyError(
      'TypeError',
      "int() argument must be a string, a bytes-like object or a real number, not 'list'",
    );
  }
  if (isDict(rung)) throw new PyError('TypeError', "unhashable type: 'slice'");
  throw new PyError('TypeError', `'${pyTypeName(rung)}' object is not subscriptable`);
}

/**
 * `max((int(a['rung'][1:]) + 1 for a in result['attempts']), default=0)`:
 * iterating a dict or a string yields strings, which `a['rung']` rejects.
 */
function nextRungFromAttempts(attempts: unknown): bigint {
  let best: bigint | undefined;
  let items: readonly unknown[];
  if (Array.isArray(attempts)) items = attempts;
  else if (isDict(attempts)) items = Object.keys(attempts);
  else if (typeof attempts === 'string') items = Array.from(attempts);
  else throw new PyError('TypeError', `'${pyTypeName(attempts)}' object is not iterable`);
  for (const item of items) {
    const next = nextRungAfter(item);
    if (best === undefined || next > best) best = next;
  }
  return best ?? 0n;
}

/** A recorded `next_rung` as the loop counter; Python's `<` refuses non-numbers. */
function rungOf(value: unknown): bigint {
  if (value instanceof JsonNumber && value.kind === 'int') return value.integer as bigint;
  if (typeof value === 'number' && Number.isInteger(value)) return BigInt(value);
  if (typeof value === 'bigint') return value;
  if (typeof value === 'boolean' || (value instanceof JsonNumber && value.kind === 'float')) {
    throw new PyError('TypeError', 'port: a float or bool next_rung is not supported');
  }
  throw new PyError(
    'TypeError',
    `'<' not supported between instances of '${pyTypeName(value)}' and 'int'`,
  );
}

const rungValue = (rung: bigint): JsonNumber => JsonNumber.int(rung);

/** `ROOT / 'state/repair' / job_id` (an absolute `job_id` replaces the prefix, as in pathlib). */
function jobDirectory(root: string, jobId: unknown): string {
  const name = pathArg(jobId);
  if (name.startsWith('/')) return normalizePosixPath(name);
  return normalizePosixPath(`${root}/state/repair/${name}`);
}

/** `datetime.strftime('%Y-%m-%dT%H:%M:%SZ')` of an instant. */
function stampOf(micros: bigint): string {
  return formatUtcMicros(micros).replace(/\.\d{6}Z$/, 'Z');
}

/** The dispatch report's `worker_disposition or disposition`. */
function dispositionOf(report: unknown): unknown {
  return orElse(pyGet(report, 'worker_disposition'), () => pyGet(report, 'disposition'));
}

/** `str(value or '').strip()` is non-empty. */
function hasSummaryText(summary: unknown): boolean {
  if (!pyTruthy(summary)) return false;
  return typeof summary !== 'string' || pyStrip(summary) !== '';
}

/** `attempts.append(item)`: only a list has `append`. */
function appendAttempt(attempts: unknown, item: Dict): void {
  if (!Array.isArray(attempts)) {
    throw new PyError(
      'AttributeError',
      `'${pyTypeName(attempts)}' object has no attribute 'append'`,
    );
  }
  attempts.push(item);
}

/** A citation `line` as Python's `isinstance(line, int)` (bool excluded): native or lossless ints. */
function citationLine(line: unknown): bigint | null {
  if (line instanceof JsonNumber) return line.kind === 'int' ? (line.integer as bigint) : null;
  if (typeof line === 'bigint') return line;
  if (typeof line === 'number' && Number.isSafeInteger(line)) return BigInt(line);
  return null;
}

/** One `unchanged_with_reason` citation, verified against `base:path` (`:655-667`). */
async function verifyCitation(
  citation: unknown,
  base: unknown,
  worktree: string,
  effects: RepairRungEffects,
): Promise<Dict> {
  const path = pySubscript(citation, 'path');
  const line = pySubscript(citation, 'line');
  const lineValue = citationLine(line);
  if (
    typeof path !== 'string' ||
    path.startsWith('/') ||
    path.split('/').includes('..') ||
    lineValue === null ||
    lineValue < 1n
  ) {
    throw new PyError('ValueError', 'invalid unchanged evidence anchor');
  }
  if (typeof base !== 'string') {
    throw new PyError('TypeError', `can only concatenate str (not "${pyTypeName(base)}") to str`);
  }
  const blob = await effects.catFileBlob(worktree, `${base}:${path}`);
  if (blob.returncode) throw new PyError('ValueError', 'unchanged evidence blob absent');
  const source = splitlines(blob.stdout);
  if (lineValue > BigInt(source.length)) {
    throw new PyError('ValueError', 'unchanged evidence line absent');
  }
  return {
    path,
    line,
    quoted_text: source[Number(lineValue) - 1],
    target: base,
  };
}

/**
 * `process(config, job, wt)`: run (or resume) one repair job to a result.
 *
 * Returns the result `process` returns (the prior one untouched when it is
 * final or still deferred). Every file save goes through
 * {@link RepairRungEffects.writeJson} in Python's order.
 */
export async function runRepairProcess(
  request: RepairRungRequest,
  effects: RepairRungEffects,
): Promise<unknown> {
  const { config, job } = request;
  const repair = pySubscript(config, 'repair');
  const directory = jobDirectory(request.root, pySubscript(job, 'job'));
  await effects.ensureDirectory(directory);
  const resultPath = `${directory}/result.json`;
  const progressPath = `${directory}/progress.json`;

  const selection = await selectRepairProgress(
    { config, job, worktree: request.worktree },
    effects.reads,
  );
  if (selection.kind === 'preserved') return selection.result;
  const roles = deepcopy(pySubscript(repair, 'roles'));
  const resultValue = selection.result;
  const resumeProgress = selection.source === 'progress';

  // `result.get('dispatch_pending') or ...` raises for a non-object progress file.
  pyGet(resultValue, 'dispatch_pending');
  const result = resultValue as Dict;
  let wt = normalizePosixPath(request.worktree);
  const decision = await decideResumeCandidate(result, wt, effects.probes);
  if (decision.kind === 'refuse-missing-candidate') {
    update(result, [
      ['verdict', 'FAILED'],
      ['reason', decision.reason],
      ['finished_at', effects.reads.utc()],
    ]);
    pop(result, 'pending_judge');
    pop(result, 'pending_mechanical');
    await effects.writeJson(resultPath, result);
    return result;
  }
  wt = decision.worktree;

  if (resumeProgress && pyTruthy(pyGet(result, 'dispatch_pending'))) {
    const recorded = Object.hasOwn(result, 'worktree') ? result.worktree : '';
    const saved = await effects.probes.resolve(pathArg(recorded));
    if (saved === (await effects.probes.resolve(normalizePosixPath(wt)))) {
      try {
        await effects.retain(saved, pySubscript(job, 'repair_base'), `${directory}/interrupted`);
      } catch (e) {
        if (!(e instanceof Error)) throw e;
        update(result, [
          ['verdict', 'FAILED'],
          ['reason', `interrupted worktree retention failed: ${clipPoints(excText(e), 600)}`],
          ['finished_at', effects.reads.utc()],
        ]);
        pop(result, 'dispatch_pending');
        await effects.writeJson(resultPath, result);
        return result;
      }
    }
    update(result, [
      ['verdict', 'FAILED'],
      ['reason', 'worker interrupted with unknown outcome; needs human'],
      ['finished_at', effects.reads.utc()],
    ]);
    pop(result, 'dispatch_pending');
    await effects.writeJson(resultPath, result);
    return result;
  }

  await effects.writeJson(`${directory}/job.json`, job);
  const base = pySubscript(job, 'repair_base');
  let evidence: unknown = getDefault(result, 'evidence', '');
  // The `max(...)` default is built before `.get` can return a recorded value.
  const derivedRung = nextRungFromAttempts(pySubscript(result, 'attempts'));
  let rung = Object.hasOwn(result, 'next_rung') ? rungOf(result.next_rung) : derivedRung;

  const defer = async (reason: string, rateLimit?: unknown): Promise<Dict> => {
    if (rateLimit !== undefined) {
      // Global pause marker first: no model call anywhere until it expires.
      result.retry_after = await effects.rateLimitPause(rateLimit, pySubscript(job, 'job'));
    } else {
      result.retry_after = stampOf(effects.reads.nowMicros() + DEFAULT_RATE_LIMIT_PAUSE_MICROS);
    }
    result.reason = reason;
    await effects.writeJson(resultPath, result);
    return result;
  };

  rungLoop: while (rung < 3n) {
    const roleName = rung < 2n ? 'fixer' : 'fixer_escalation';
    const role = pySubscript(roles, roleName);
    const attemptDirectory = `${directory}/${rungName(rung)}`;
    const current = deepcopy(job) as Dict;
    current.mechanical_evidence = evidence;
    try {
      let reason: unknown;
      if (pyTruthy(pyGet(result, 'pending_judge'))) {
        reason = pySubscript(result.pending_judge, 'fixer_reason');
      } else if (pyTruthy(pyGet(result, 'pending_mechanical'))) {
        // A committed candidate whose detector verification was deferred:
        // resume mechanical verification over the preserved tree without
        // repeating this rung's fixer.
        const pendingMechanical: unknown = result.pending_mechanical;
        reason = pySubscript(pendingMechanical, 'fixer_reason');
        const attempts: unknown = pyGet(result, 'attempts');
        const last: unknown = Array.isArray(attempts) ? attempts[attempts.length - 1] : undefined;
        if (
          !pyTruthy(attempts) ||
          pyGet(last, 'rung') !== `A${pyStrOfValue(pySubscript(pendingMechanical, 'rung'))}`
        ) {
          // FIXED must never be reachable without a verification attempt.
          throw new PyError(
            'ValueError',
            'pending_mechanical rung does not match the last attempt; needs revalidation',
          );
        }
        const commits = pySubscript(pendingMechanical, 'commits');
        const verified = await effects.mechanical(
          wt,
          base,
          commits,
          pySubscript(job, 'job'),
          attemptDirectory,
        );
        (last as Dict).mechanical = verified;
        pop(result, 'pending_mechanical');
        update(result, [
          ['verdict', 'FIXED'],
          ['reason', reason],
          ['commits', commits],
        ]);
        break rungLoop;
      } else {
        if (await effects.blocked(repair)) {
          result.next_rung = rungValue(rung);
          return await defer('GLM peak blackout; attempt deferred');
        }
        await effects.retain(wt, base, `${directory}/before-${rungName(rung)}`);
        if (rung === 2n) {
          // Preserve the previous tree (including ignored files) and give
          // escalation a separate fresh checkout.
          wt = normalizePosixPath(`${wt}-A2`);
          if (await effects.pathExists(wt)) {
            await effects.retain(wt, base, `${directory}/before-A2-existing`);
            await effects.git(wt, 'reset', '--hard', base as string);
            await effects.git(wt, 'clean', '-fd');
          } else {
            await effects.git(
              pySubscript(config, 'clone'),
              'worktree',
              'add',
              '--detach',
              wt,
              base as string,
            );
          }
          result.worktree = wt;
        } else {
          await effects.git(wt, 'reset', '--hard', base as string);
          await effects.git(wt, 'clean', '-fd');
        }
        result.worktree = wt;
        result.dispatch_pending = { rung: rungName(rung), role };
        await effects.writeJson(progressPath, result);
        const report = await effects.dispatch(role, current, wt, attemptDirectory, false);
        pop(result, 'dispatch_pending');
        if (pyGet(report, 'stop') === 'blackout') {
          // The window opened while this rung prepared its worktree; no
          // provider call started, so keep the rung and defer the attempt.
          result.next_rung = rungValue(rung);
          return await defer('GLM peak blackout; attempt deferred');
        }
        const disposition = dispositionOf(report);
        const stop = pyGet(report, 'stop');
        if (
          (stop === 'ok' || stop === 'error') &&
          disposition === 'needs_human' &&
          hasSummaryText(pyGet(report, 'summary'))
        ) {
          update(result, [
            ['verdict', 'FAILED'],
            ['failure_class', 'owner-decision'],
            ['reason', orElse(pyGet(report, 'summary'), () => 'worker requested owner decision')],
          ]);
          break rungLoop;
        }
        result.failure_class = failureClassForStop(report);
        if (
          stop !== 'rate-limit' &&
          stop !== 'configuration' &&
          stop !== 'budget' &&
          (disposition === 'no_outcome' || disposition === 'unchanged_with_reason') &&
          !pyTruthy(pyGet(report, 'evidence'))
        ) {
          result.failure_class = 'exhausted';
        }
        pop(result, 'unchanged_evidence');
        if (stop === 'rate-limit') {
          await effects.retainPreservingNested(wt, base, attemptDirectory);
          result.next_rung = rungValue(rung);
          return await defer('provider rate limit; attempt deferred', report);
        }
        const attempt: Dict = {
          rung: rungName(rung),
          role: roleName,
          driver: getDefault(report, 'driver', pySubscript(role, 'driver')),
          model: getDefault(report, 'model', pySubscript(role, 'model')),
          stop,
          changed: getDefault(report, 'changed', false),
        };
        appendAttempt(pySubscript(result, 'attempts'), attempt);
        if (stop === 'configuration') {
          result.reason = getDefault(report, 'summary', 'driver prerequisite missing; needs human');
          break rungLoop;
        }
        if (stop !== 'ok') {
          throw new PyError(
            'ValueError',
            `driver stop ${pyStrOfValue(stop)}: ${clipPoints(
              pyTruthy(pyGet(report, 'summary'))
                ? pyStrOfValue(pyGet(report, 'summary'))
                : 'no detail',
              600,
            )}`,
          );
        }
        if (pyTruthy(pyGet(report, 'truncated'))) {
          throw new PyError('ValueError', 'driver failure or truncated context');
        }
        if (pyTruthy(pyGet(report, 'changed'))) {
          try {
            attempt.mechanical = await effects.mechanical(
              wt,
              base,
              pyGet(report, 'commits'),
              pySubscript(job, 'job'),
              attemptDirectory,
            );
          } catch (e) {
            if (!(e instanceof PyError) || e.kind !== 'DetectorUnavailable') throw e;
            // No verdict was rendered over this committed candidate; keep it
            // for a mechanical-only retry instead of spending another rung.
            attempt.mechanical = { failure: clipPoints(excText(e), 1000), tests: 'suspended' };
            result.pending_mechanical = {
              rung: rungValue(rung),
              commits: pySubscript(report, 'commits'),
              fixer_reason: getDefault(report, 'summary', ''),
            };
            throw e;
          }
          update(result, [
            ['verdict', 'FIXED'],
            ['reason', getDefault(report, 'summary', '')],
            ['commits', pySubscript(report, 'commits')],
          ]);
          break rungLoop;
        }
        if (
          pyTruthy(await effects.git(wt, 'status', '--porcelain')) ||
          (await effects.git(wt, 'rev-parse', 'HEAD')) !== base
        ) {
          throw new PyError('ValueError', 'unchanged report left repository changes');
        }
        reason = orElse(pyGet(report, 'summary'), () => 'no change proposed');
        if (disposition === 'unchanged_with_reason') {
          const citations = pyGet(report, 'evidence');
          if (!Array.isArray(citations) || citations.length === 0) {
            throw new PyError('ValueError', 'unchanged outcome requires source evidence');
          }
          const verified: Dict[] = [];
          for (const citation of citations) {
            verified.push(await verifyCitation(citation, base, wt, effects));
          }
          result.unchanged_evidence = verified;
        }
      }

      if (
        judgeRequired({ result, job, repair, random: () => effects.random() }) &&
        pySubscript(result, 'judge') === null
      ) {
        const critical = pySubscript(pySubscript(job, 'finding'), 'severity') === 'critical';
        const judgeRole = pySubscript(roles, critical ? 'judge_critical' : 'judge');
        current.fixer_reason = reason;
        current.review_diff = getDefault(job, 'review_diff', '');
        result.pending_judge = { fixer_reason: reason, rung: rungValue(rung) };
        result.next_rung = rungValue(rung);
        if (await effects.blocked(repair)) {
          return await defer('GLM peak blackout; judge deferred without repeating fixer');
        }
        result.dispatch_pending = { rung: 'J', role: judgeRole };
        await effects.writeJson(progressPath, result);
        let judged: unknown;
        try {
          judged = await effects.dispatch(judgeRole, current, wt, `${directory}/J`, true);
        } catch (e) {
          // Unknown outcome cannot be retried as a fresh paid judgement.
          result.judge = {
            stop: 'error',
            verdict: 'unsure',
            reason: 'judge dispatch failed; needs human',
          };
          throw e;
        } finally {
          pop(result, 'dispatch_pending');
        }
        const judgeStop = pyGet(judged, 'stop');
        if (judgeStop === 'blackout') {
          // The recorded pending_judge keeps the judge resumable after the
          // blackout without repeating this rung's fixer.
          return await defer('GLM peak blackout; judge deferred without repeating fixer');
        }
        if (judgeStop === 'rate-limit') {
          return await defer('judge rate limit; resume judge without repeating fixer', judged);
        }
        pop(result, 'pending_judge');
        result.judge = judged;
        const verdict = pyGet(judged, 'verdict');
        if (verdict === 'valid' && judgeStop === 'ok') {
          if (rung === 2n) {
            update(result, [
              ['verdict', 'FAILED'],
              ['reason', 'judge-confirmed defect; escalation already exhausted; needs human'],
            ]);
            break rungLoop;
          }
          evidence = getDefault(judged, 'reason', '');
          result.evidence = evidence;
          result.next_rung = rungValue(2n);
          await effects.writeJson(progressPath, result);
          rung = 2n;
          continue rungLoop;
        }
        if (
          judgeStop === 'ok' &&
          verdict === 'unsure' &&
          pyTruthy(pyGet(judged, 'reason')) &&
          rung < 2n
        ) {
          evidence = pySubscript(judged, 'reason');
          result.evidence = evidence;
          result.next_rung = rungValue(2n);
          await effects.writeJson(progressPath, result);
          rung = 2n;
          continue rungLoop;
        }
        update(result, [
          ['verdict', verdict === 'invalid' && judgeStop === 'ok' ? 'NOT-FIXED' : 'FAILED'],
          ['reason', orElse(pyGet(judged, 'reason'), () => 'judge unsure; needs human')],
        ]);
        if (judgeStop === 'rate-limit' || judgeStop === 'configuration') {
          result.failure_class = 'transient';
        } else {
          result.failure_class =
            judgeStop === 'ok' && verdict === 'unsure' ? 'evidence' : 'exhausted';
        }
        break rungLoop;
      }
      const judge = pyGet(result, 'judge');
      const priorVerdict = pyTruthy(judge) ? pyGet(judge, 'verdict') : null;
      if (priorVerdict === 'valid') {
        update(result, [
          ['verdict', 'FAILED'],
          ['reason', 'judge-confirmed defect unresolved after A2; needs human'],
        ]);
      } else if (priorVerdict === 'unsure') {
        // The stored verdict judged an earlier rung; A2's unchanged claim was
        // never judged, so it must not dismiss the finding.
        update(result, [
          ['verdict', 'FAILED'],
          ['failure_class', 'evidence'],
          ['reason', 'judge unsure and A2 unchanged; needs human'],
        ]);
      } else {
        update(result, [
          ['verdict', 'NOT-FIXED'],
          ['reason', reason],
        ]);
      }
      break rungLoop;
    } catch (e) {
      if (!(e instanceof Error)) throw e;
      pop(result, 'dispatch_pending');
      const text = excText(e);
      evidence = clipPoints(text, 1000);
      result.reason = evidence;
      if (pyTruthy(pyGet(result, 'pending_judge'))) {
        pop(result, 'pending_judge');
        result.reason = 'judge outcome unavailable; needs human';
        break rungLoop;
      }
      if (isPyError(e, 'ValueError') && text.includes('pending_mechanical rung does not match')) {
        // A corrupted progress/result binding must fail the job closed, not
        // advance to a fresh fixer rung as if nothing was pending.
        pop(result, 'pending_mechanical');
        update(result, [
          ['verdict', 'FAILED'],
          ['failure_class', 'evidence'],
        ]);
        break rungLoop;
      }
      if (
        e instanceof PyError &&
        e.kind === 'DetectorUnavailable' &&
        pyTruthy(pyGet(result, 'pending_mechanical'))
      ) {
        // The detector outage hit this rung's committed candidate: preserve it
        // and resume mechanical verification alone instead of advancing.
        try {
          await effects.retain(wt, base, attemptDirectory);
        } catch (captureError) {
          if (!(captureError instanceof Error)) throw captureError;
          result.reason = `worktree retention failed: ${clipPoints(excText(captureError), 600)}`;
          break rungLoop;
        }
        result.evidence = evidence;
        result.next_rung = rungValue(rung);
        return await defer(
          'hack detector unavailable; resume mechanical verification without repeating fixer',
        );
      }
      pop(result, 'pending_mechanical');
      const attempts = pySubscript(result, 'attempts');
      const tail = pyTruthy(attempts)
        ? (attempts as unknown[])[(attempts as unknown[]).length - 1]
        : undefined;
      if (tail === undefined || pySubscript(tail, 'rung') !== rungName(rung)) {
        appendAttempt(attempts, {
          rung: rungName(rung),
          driver: pySubscript(role, 'driver'),
          model: pySubscript(role, 'model'),
          stop: 'error',
          changed: false,
        });
      } else {
        (tail as Dict).mechanical = { failure: evidence, tests: 'suspended' };
      }
      // If capture fails, never advance to a reset that could erase work.
      try {
        await effects.retain(wt, base, attemptDirectory);
      } catch (captureError) {
        if (!(captureError instanceof Error)) throw captureError;
        result.reason = `worktree retention failed: ${clipPoints(excText(captureError), 600)}`;
        break rungLoop;
      }
    }
    result.evidence = evidence;
    result.next_rung = rungValue(rung + 1n);
    await effects.writeJson(progressPath, result);
    rung += 1n;
  }

  try {
    // Even a clean, unchanged terminal tree needs a verifiable snapshot:
    // harvest may retire it only after this capture succeeds.
    await effects.retain(wt, base, `${directory}/final`, { includeClean: true });
  } catch (e) {
    if (!(e instanceof Error)) throw e;
    result.verdict = 'FAILED';
    result.reason = `worktree retention failed: ${clipPoints(excText(e), 600)}`;
  }
  result.finished_at = effects.reads.utc();
  await effects.writeJson(resultPath, result);
  return result;
}
