/**
 * Pure helpers of `crq_repair.process` (slice 7 of the CRQ completion plan):
 *
 * - {@link failureClassForStop} — `crq_repair.py:161-166`;
 * - {@link judgeRequired} — the `judge_required` expression at
 *   `crq_repair.py:670` (inline in `process`, there is no Python function);
 * - {@link validateRevalidation} with {@link checkSha},
 *   {@link repairableSeverity} and {@link sourcePath} —
 *   `crq_repair/bounded.py:34-61` (`check_sha`, `repairable_severity`,
 *   `source_path`, `validate_revalidation`).
 *
 * DECISION ONLY and inactive: nothing imports this outside tests. The only
 * effect is the injected read-only `git` seam of {@link validateRevalidation}.
 * Where Python lets an uncaught exception escape (a `report` with no `.get`, a
 * job without `finding`, a non-numeric `judge_sample_rate`, ...) the port
 * throws a {@link PyError} of the same class, and the oracle pins that class.
 *
 * Inputs are the plain JSON-shaped values `toPlainJsonRetainingNumbers`
 * produces (numbers may be {@link JsonNumber}), so truthiness and the finding
 * digest keep Python's int/float kinds.
 */
import { JsonNumber, JsonObject, comparePythonNumbers } from '../policy/crq/jsonValue.js';
import { receiptJsonDigest } from '../policy/crq/pythonJson.js';
import { pyTruthy } from '../policy/crq/queueDoc.js';
import { pyStrip } from '../ops/crq/deploy/gitGuards.js';
import { PyError } from './pyErrors.js';

/** `runtime_target.DEFAULT_REF` (`origin/` + `DEFAULT_BRANCH`). */
export const DEFAULT_REF = 'origin/main';

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict | JsonObject {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof JsonNumber)
  );
}

/** `value.get(key)`; Python `AttributeError` when `value` has no `.get`. */
function dictGet(value: unknown, key: string): unknown {
  if (!isDict(value)) throw new PyError('AttributeError', `object has no attribute 'get'`);
  if (value instanceof JsonObject) {
    for (const [k, v] of value.entries) if (k === key) return v;
    return undefined;
  }
  return Object.hasOwn(value, key) ? value[key] : undefined;
}

/** `value[key]`: `KeyError` for a missing key, `TypeError` for a non-dict. */
function dictIndex(value: unknown, key: string): unknown {
  if (!isDict(value)) throw new PyError('TypeError', 'object is not subscriptable with a str');
  const found = dictGet(value, key);
  if (found === undefined) throw new PyError('KeyError', `'${key}'`);
  return found;
}

/**
 * `crq_repair.failure_class_for_stop(config, job, report)`: the typed `stop`
 * decides, never error prose. `config` and `job` are unused in Python too.
 * A `report` without `.get` raises `AttributeError`.
 */
export function failureClassForStop(report: unknown): 'transient' | 'exhausted' {
  const stop = dictGet(report, 'stop');
  return stop === 'rate-limit' || stop === 'configuration' ? 'transient' : 'exhausted';
}

export interface JudgeRequiredInput {
  /** `result`: the rung's result dict. */
  readonly result: unknown;
  /** `job`: the repair job. */
  readonly job: unknown;
  /** `config['repair']`. */
  readonly repair: unknown;
  /** `random.random()`: consumed only when no earlier operand was truthy. */
  readonly random: () => number;
}

/**
 * The truthiness of `crq_repair.py:670`:
 * `bool(result.get('pending_judge')) or job['finding']['severity'] ==
 * 'critical' or job.get('recurrence') or random.random() <
 * repair.get('judge_sample_rate', 0)`.
 *
 * Python's `or` short-circuits, so a pending judge never reads the job, and
 * `random.random()` is drawn only when the first three operands are falsy;
 * the draw happens BEFORE `repair.get`/the comparison can raise. `process`
 * only tests the truthiness of the chain, so this returns a boolean.
 */
export function judgeRequired(input: JudgeRequiredInput): boolean {
  if (pyTruthy(dictGet(input.result, 'pending_judge'))) return true;
  const finding = dictIndex(input.job, 'finding');
  if (dictIndex(finding, 'severity') === 'critical') return true;
  if (pyTruthy(dictGet(input.job, 'recurrence'))) return true;
  const draw = input.random();
  const configured = dictGet(input.repair, 'judge_sample_rate');
  const rate = configured === undefined ? 0 : configured;
  const order = comparePythonNumbers(JsonNumber.float(draw), rate);
  if (order === null) {
    throw new PyError('TypeError', `'<' not supported between 'float' and the sample rate`);
  }
  // `comparePythonNumbers` returns 0 for NaN as well as for equality; both
  // make `<` false.
  return order < 0;
}

/** `bounded.check_sha`: a full lower-case 40-hex string. */
export function checkSha(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/.test(value)) {
    throw new PyError('ValueError', 'full immutable source SHA required');
  }
  return value;
}

const CANONICAL_ID = /^[0-9a-f]{64}$/;

/** `bounded.repairable_severity(job)`. */
export function repairableSeverity(job: unknown): boolean {
  const present = dictGet(job, 'finding');
  const finding = present === undefined ? {} : present;
  const severity = dictGet(finding, 'severity');
  if (severity === 'critical' || severity === 'major') return true;
  const id = dictGet(job, 'canonical_finding_id');
  return severity === 'minor' && typeof id === 'string' && CANONICAL_ID.test(id);
}

/**
 * `bounded.source_path(finding)`: the repository-relative path, normalised as
 * `str(PurePosixPath(value))` does (empty and `.` segments dropped).
 */
export function sourcePath(finding: unknown): string {
  const value = dictGet(finding, 'path');
  if (typeof value !== 'string' || value === '' || /[\0\n\r\t"\\]/.test(value)) {
    throw new PyError('ValueError', 'finding path required');
  }
  const parts = value.split('/').filter((part) => part !== '' && part !== '.');
  const normalised = parts.length === 0 ? '.' : parts.join('/');
  if (value.startsWith('/') || parts.includes('..') || normalised === '.') {
    throw new PyError('ValueError', 'finding path must be repository-relative');
  }
  return normalised;
}

/** `bounded.identity(value)`: SHA-256 of the canonical (sorted, compact, ASCII) JSON. */
export function identity(value: unknown): string {
  return receiptJsonDigest(value);
}

export interface RevalidationExpected {
  readonly source_sha: string;
  readonly finding_sha256: string;
  readonly source_blob_sha: string;
  readonly verdict: 'still-valid';
}

/**
 * `bounded.validate_revalidation(config, old, source_sha, evidence)`.
 *
 * `git(...args)` is Python's `git(config['clone'], *args)`: stripped stdout,
 * throwing a `RuntimeError` {@link PyError} on a non-zero exit. Reads happen in
 * Python's order: the current default-branch tip first, then the source blob.
 */
export function validateRevalidation(
  git: (...args: string[]) => string,
  old: unknown,
  sourceSha: unknown,
  evidence: unknown,
  defaultRef: string = DEFAULT_REF,
): RevalidationExpected {
  const sha = checkSha(sourceSha);
  if (git('rev-parse', defaultRef) !== sha) {
    throw new PyError('ValueError', 'source SHA is not the observed current default-branch tip');
  }
  if (!repairableSeverity(old)) {
    throw new PyError(
      'ValueError',
      'only critical/major or canonical minor findings can be prepared',
    );
  }
  const finding = dictIndex(old, 'finding');
  const blob = git('rev-parse', `${sha}:${sourcePath(finding)}`);
  const expected: RevalidationExpected = {
    source_sha: sha,
    finding_sha256: identity(finding),
    source_blob_sha: blob,
    verdict: 'still-valid',
  };
  for (const [key, value] of Object.entries(expected)) {
    if (dictGet(evidence, key) !== value) {
      throw new PyError(
        'ValueError',
        'revalidation does not bind source, finding, blob and verdict',
      );
    }
  }
  for (const key of ['reviewer', 'reason']) {
    const text = dictGet(evidence, key);
    if (typeof text !== 'string' || pyStrip(text) === '' || Array.from(text).length > 4000) {
      throw new PyError('ValueError', 'named revalidation reviewer and concrete reason required');
    }
  }
  return expected;
}
