/**
 * Pure, injected repair selection policy for the C1 slice.
 *
 * This is the offline port of `crq_repair/bounded.py`'s three selection
 * functions:
 *
 * - {@link drainOrder} (`drain_order`): inbox job ids, oldest file first,
 *   filtered by the `*.json` glob, the `crq-...` id grammar and symlinks.
 * - {@link drainJob} (`drain_job`): the automatic drain's per-job `run`,
 *   `stale` or `skip` classification, including the immutable legacy binding
 *   and the prepared job's strict one-job selector.
 * - {@link selectJob} (`select_job`): exactly one explicitly named prepared
 *   job, or a typed refusal; on success it also returns the caller-computed
 *   selection facts F1 otherwise has to assert.
 *
 * Everything effectful is injected. The caller observes inbox directory
 * entries, the parsed job file, the parsed queue, the triage row text, the
 * `started` marker and the five Git facts; this module performs no read, no
 * write, no clock read, no spawn and no environment read. The `git` seam is
 * synchronous by contract and side-effect free apart from the caller's own
 * read log.
 *
 * Failure honesty:
 * - Refusals are internal TypeScript literals, never persisted and never
 *   prose-matched. Python's exact refusal messages are mapped to these codes
 *   by the oracle emitter, which aborts on an unmapped message.
 * - Where Python's helper would raise an uncaught `RuntimeError` (a missing
 *   blob at the revalidated source) or crash on a structurally corrupt queue
 *   before its guarded region, this port returns a typed `skip` instead. No
 *   job becomes selectable that Python would not select.
 * - `selectedJobId` is returned only when every check passes. A refusal never
 *   carries a selected job id.
 */
import { JsonObject, pythonNumbersEqual, type JsonValue } from './jsonValue.js';
import {
  checkSha,
  findingDigest,
  pythonLength,
  pythonStrip,
  pythonTruthy,
  severityRepairable,
  sourcePath,
  type RepairRefusal,
} from './repairBinding.js';
import { canonicalDeliveryRefusal } from './repairGates.js';

/** `runtime_target.DEFAULT_REF`; the only default-branch ref this module knows. */
export const REPAIR_DEFAULT_REF = 'origin/main';

/** `bounded.JOB_ID`, matched with `fullmatch` against an inbox file stem. */
const REPAIR_JOB_ID = /^crq-[A-Za-z0-9._-]+$/;

const MAX_EVIDENCE_TEXT = 4000;

/** One directory entry the caller observed under `state/repair/inbox`. */
export interface RepairInboxEntry {
  /** The entry's file name, e.g. `crq-run1-F1.json`. */
  readonly name: string;
  /** `stat().st_mtime` in seconds. */
  readonly mtime: number;
  /** `Path.is_symlink()`. A symlink is never read, whatever its name. */
  readonly symlink: boolean;
}

/**
 * `drain_order`: filter `*.json` entries whose stem fully matches the job-id
 * grammar and which are not symlinks, then sort by `(st_mtime, name)`.
 * Directories that match the pattern are included exactly as Python includes
 * them; the caller's read is what turns such an entry into an unreadable job.
 */
export function drainOrder(entries: readonly RepairInboxEntry[]): string[] {
  return entries
    .filter(
      (entry) =>
        entry.name.endsWith('.json') &&
        !entry.symlink &&
        REPAIR_JOB_ID.test(entry.name.slice(0, -'.json'.length)),
    )
    .sort((left, right) => {
      if (left.mtime < right.mtime) return -1;
      if (left.mtime > right.mtime) return 1;
      if (left.name < right.name) return -1;
      if (left.name > right.name) return 1;
      return 0;
    })
    .map((entry) => entry.name.slice(0, -'.json'.length));
}

/** The caller's parsed job file, or the fact that reading/parsing it failed. */
export type RepairJobFile =
  | { readonly kind: 'value'; readonly value: JsonValue }
  | { readonly kind: 'unreadable' };

/**
 * The five Git observations `bounded.py` performs, split by the Python helper
 * that performed them. `currentTip` and `checkedBlob` are the raising `git`
 * helper (it raises on a non-zero exit); `blobAt` and `originBranchHead` are
 * the fail-quiet `blob_at`/branch reads.
 */
export interface RepairSelectionGit {
  /** `git rev-parse origin/main`. */
  currentTip(): string;
  /** `git rev-parse <ref>:<path>`; undefined where Python's helper raises. */
  checkedBlob(ref: string, path: string): string | undefined;
  /** `git rev-parse --verify --quiet <ref>:<path>`; undefined when absent. */
  blobAt(ref: string, path: string): string | undefined;
  /** `git merge-base --is-ancestor <ancestor> <descendant>` exit 0. */
  isAncestor(ancestor: string, descendant: string): boolean;
  /** `git rev-parse --verify --quiet refs/remotes/origin/<branch>^{commit}`. */
  originBranchHead(branch: string): string | undefined;
}

/** The typed refusal vocabulary. Never persisted, never prose-matched. */
export type RepairSelectionRefusal =
  | 'job-id-invalid'
  | 'job-unreadable'
  | 'job-identity-mismatch'
  | 'selection-malformed'
  | 'source-sha-invalid'
  | 'finding-digest-mismatch'
  | 'canonical-delivery-invalid'
  | 'canonical-delivery-unavailable'
  | 'canonical-delivery-mismatch'
  | 'prepared-source-not-tip'
  | 'source-blob-unreadable'
  | 'severity-not-repairable'
  | 'finding-path-invalid'
  | 'evidence-binding-mismatch'
  | 'evidence-text-invalid'
  | 'origin-job-missing'
  | 'no-queued-run'
  | 'pin-record-mismatch'
  | 'revalidation-lineage-mismatch'
  | 'pinned-path-missing'
  | 'pinned-path-absent'
  | 'pr-head-on-default'
  | 'pr-branch-gone'
  | 'pr-branch-source-changed'
  | 'default-source-changed';

/**
 * `drain_job`'s `(status, job, reason)`. Python returns `None` for the job
 * only when the file is unreadable or the parsed value is not a job object;
 * every later outcome keeps the parsed job (and, for refreshable legacy runs,
 * the immutable bound copy).
 */
export type RepairDrainOutcome =
  | { readonly status: 'run'; readonly job: JsonObject }
  | { readonly status: 'stale'; readonly refusal: RepairSelectionRefusal; readonly job: JsonObject }
  | {
      readonly status: 'skip';
      readonly refusal: RepairSelectionRefusal;
      readonly job: JsonObject | null;
    };

export interface RepairDrainInput {
  /** The exact id named by the inbox file; never enumerated here. */
  readonly jobId: string;
  readonly jobFile: RepairJobFile;
  /** The already-parsed `state/queue.json` value. */
  readonly queue: JsonValue;
  /** Exact text of the canonical triage row, or undefined when unreadable. */
  readonly triageRowText?: string | undefined;
  /** `result.json` or `progress.json` already exists for this job. */
  readonly started: boolean;
  readonly git: RepairSelectionGit;
}

/**
 * The caller-computed selection facts F1's dispatch bridge previously
 * asserted. They are returned only for a fully verified selection, so every
 * field is a checked fact rather than an untrusted claim. `originJob` stays
 * the job's own JSON value: Python only requires it to be truthy.
 */
export interface RepairSelectionFacts {
  readonly state: 'queued';
  readonly canonicalDelivery: 'verified';
  readonly severity: 'repairable';
  readonly base: string;
  readonly jobs: readonly string[];
  readonly originJob: JsonValue;
  readonly revalidationSha256: string;
}

export interface RepairSelectJobInput {
  readonly jobId: string;
  readonly sourceSha: string;
  readonly findingSha256: string;
  readonly jobFile: RepairJobFile;
  readonly queue: JsonValue;
  readonly triageRowText?: string | undefined;
  readonly git: RepairSelectionGit;
}

export type RepairSelectJobResult =
  | {
      readonly ok: true;
      readonly selectedJobId: string;
      readonly job: JsonObject;
      readonly selection: RepairSelectionFacts;
    }
  | { readonly ok: false; readonly refusal: RepairSelectionRefusal };

/** A structural shape Python would reach with a dict/list attribute or key. */
class ShapeError extends Error {
  override readonly name: string = 'ShapeError';
}

function refusal(refusalCode: RepairSelectionRefusal): {
  ok: false;
  refusal: RepairSelectionRefusal;
} {
  return { ok: false, refusal: refusalCode };
}

function drainSkip(
  refusalCode: RepairSelectionRefusal,
  job: JsonObject | null,
): RepairDrainOutcome {
  return { status: 'skip', refusal: refusalCode, job };
}

function drainStale(refusalCode: RepairSelectionRefusal, job: JsonObject): RepairDrainOutcome {
  return { status: 'stale', refusal: refusalCode, job };
}

function getOr(object: JsonObject, key: string, fallback: JsonValue): JsonValue {
  return object.has(key) ? (object.get(key) as JsonValue) : fallback;
}

/** Python `value in container` over a JSON string, array or object. */
function pythonContains(container: JsonValue, item: string): boolean {
  if (typeof container === 'string') return container.includes(item);
  if (Array.isArray(container)) return container.some((entry) => entry === item);
  if (container instanceof JsonObject) return container.has(item);
  throw new ShapeError('membership');
}

/**
 * `next((i.get('repair_runs', {}).get(job['run']) for i in queue['items']
 * if i['id'] == job['item']), None)`: only the FIRST queue item whose id
 * matches is inspected. `drain_job` reads `i.get('id')` while `select_job`
 * reads `i['id']`; the policy keeps that difference. The id comparison is
 * Python `==`, so `1`, `1.0` and `true` name the same id (see
 * {@link pythonEqual}).
 */
function queueRecord(
  queue: JsonValue,
  itemId: JsonValue | undefined,
  run: JsonValue | undefined,
  missingId: 'ignore' | 'malformed',
): JsonValue | undefined {
  if (!(queue instanceof JsonObject)) throw new ShapeError('queue');
  const items = queue.get('items');
  if (!Array.isArray(items)) throw new ShapeError('items');
  for (const item of items) {
    if (!(item instanceof JsonObject)) throw new ShapeError('item');
    if (!item.has('id')) {
      if (missingId === 'malformed') throw new ShapeError('item.id');
    }
    // Python compares `i.get('id') == job.get('item')`, where a missing key
    // and an explicit JSON null are both None.
    if (!pythonEqual(item.has('id') ? item.get('id') : null, itemId ?? null)) continue;
    const runs = getOr(item, 'repair_runs', new JsonObject([]));
    if (!(runs instanceof JsonObject)) throw new ShapeError('repair_runs');
    if (Array.isArray(run) || run instanceof JsonObject) throw new ShapeError('run');
    return typeof run === 'string' ? runs.get(run) : undefined;
  }
  return undefined;
}

/** Python truthiness gate before `record.get(...)`; non-objects are malformed. */
function recordObject(record: JsonValue | undefined): JsonObject | undefined {
  if (!pythonTruthy(record)) return undefined;
  if (!(record instanceof JsonObject)) throw new ShapeError('record');
  return record;
}

function jobsExactlyOne(jobs: JsonValue | undefined, jobId: string): boolean {
  return Array.isArray(jobs) && jobs.length === 1 && jobs[0] === jobId;
}

function validEvidenceText(value: JsonValue | undefined): boolean {
  return (
    typeof value === 'string' &&
    pythonLength(value) <= MAX_EVIDENCE_TEXT &&
    pythonStrip(value).length > 0
  );
}

function canonicalRefusal(value: RepairRefusal | undefined): RepairSelectionRefusal | undefined {
  if (value === undefined) return undefined;
  if (
    value === 'canonical-delivery-invalid' ||
    value === 'canonical-delivery-unavailable' ||
    value === 'canonical-delivery-mismatch'
  ) {
    return value;
  }
  throw new Error(`unexpected canonical refusal ${value}`);
}

/**
 * `bounded.validate_revalidation` after the caller supplied the observed tip
 * and blob. Order matches Python: source-sha grammar, observed tip, severity,
 * path, then the checked blob, then the evidence binding and text.
 */
function validateRevalidation(input: {
  readonly job: JsonObject;
  readonly finding: JsonObject;
  readonly sourceSha: string;
  readonly evidence: JsonObject;
  readonly git: RepairSelectionGit;
}): RepairSelectionRefusal | undefined {
  if (!checkSha(input.sourceSha)) return 'source-sha-invalid';
  if (input.git.currentTip() !== input.sourceSha) return 'prepared-source-not-tip';
  if (!severityRepairable(input.job)) return 'severity-not-repairable';
  const path = sourcePath(input.finding);
  if (!path.ok) return 'finding-path-invalid';
  const blob = input.git.checkedBlob(input.sourceSha, path.path);
  if (blob === undefined) return 'source-blob-unreadable';
  const digest = findingDigest(input.finding);
  if (
    input.evidence.get('source_sha') !== input.sourceSha ||
    input.evidence.get('finding_sha256') !== digest ||
    input.evidence.get('source_blob_sha') !== blob ||
    input.evidence.get('verdict') !== 'still-valid'
  ) {
    return 'evidence-binding-mismatch';
  }
  if (
    !validEvidenceText(input.evidence.get('reviewer')) ||
    !validEvidenceText(input.evidence.get('reason'))
  ) {
    return 'evidence-text-invalid';
  }
  return undefined;
}

/**
 * `bounded.select_job`: exactly one named, prepared, queued job or a typed
 * refusal. The job file is the caller's single observation; this function
 * never re-reads it.
 */
export function selectJob(input: RepairSelectJobInput): RepairSelectJobResult {
  if (!checkSha(input.sourceSha)) return refusal('source-sha-invalid');
  if (!REPAIR_JOB_ID.test(input.jobId)) return refusal('job-id-invalid');
  if (input.jobFile.kind === 'unreadable') return refusal('job-unreadable');
  const job = input.jobFile.value;
  if (!(job instanceof JsonObject)) return refusal('job-identity-mismatch');
  if (
    job.get('job') !== input.jobId ||
    job.get('source_sha') !== input.sourceSha ||
    job.get('repair_base') !== input.sourceSha
  ) {
    return refusal('job-identity-mismatch');
  }
  const finding = job.get('finding');
  if (!(finding instanceof JsonObject)) return refusal('selection-malformed');
  if (
    findingDigest(finding) !== input.findingSha256 ||
    job.get('finding_sha256') !== input.findingSha256
  ) {
    return refusal('finding-digest-mismatch');
  }
  const canonical = canonicalRefusal(
    canonicalDeliveryRefusal({ rowText: input.triageRowText, job }),
  );
  if (canonical !== undefined) return refusal(canonical);
  const revalidation = job.get('revalidation');
  const evidence = pythonTruthy(revalidation) ? (revalidation as JsonValue) : new JsonObject([]);
  if (!(evidence instanceof JsonObject)) return refusal('selection-malformed');
  const binding = validateRevalidation({
    job,
    finding,
    sourceSha: input.sourceSha,
    evidence,
    git: input.git,
  });
  if (binding !== undefined) return refusal(binding);
  if (!pythonTruthy(job.get('origin_job'))) return refusal('origin-job-missing');
  if (!job.has('item') || !job.has('run')) return refusal('selection-malformed');

  let record: JsonObject | undefined;
  try {
    record = recordObject(queueRecord(input.queue, job.get('item'), job.get('run'), 'malformed'));
  } catch (error) {
    if (error instanceof ShapeError) return refusal('selection-malformed');
    throw error;
  }
  if (
    record === undefined ||
    record.get('base') !== input.sourceSha ||
    !jobsExactlyOne(record.get('jobs'), input.jobId) ||
    record.get('state') !== 'queued'
  ) {
    return refusal('no-queued-run');
  }
  const revalidationSha256 = findingDigest(evidence);
  if (
    !pythonEqual(record.get('origin_job'), job.get('origin_job')) ||
    record.get('revalidation_sha256') !== revalidationSha256
  ) {
    return refusal('revalidation-lineage-mismatch');
  }
  return {
    ok: true,
    selectedJobId: input.jobId,
    job,
    selection: {
      state: 'queued',
      canonicalDelivery: 'verified',
      severity: 'repairable',
      base: input.sourceSha,
      jobs: [input.jobId],
      originJob: job.get('origin_job') as JsonValue,
      revalidationSha256,
    },
  };
}

/** Python `{**job, **overrides}`: existing keys keep their position. */
function mergeBinding(
  job: JsonObject,
  overrides: ReadonlyArray<readonly [string, JsonValue]>,
): JsonObject {
  const replacement = new Map(overrides);
  const entries: Array<readonly [string, JsonValue]> = job.entries.map(([key, value]) => [
    key,
    replacement.has(key) ? (replacement.get(key) as JsonValue) : value,
  ]);
  for (const [key, value] of overrides) {
    if (!job.has(key)) entries.push([key, value]);
  }
  return new JsonObject(entries);
}

/**
 * Python `==` between two decoded JSON values.
 *
 * This is the module's one value-equality primitive, shared by the queue item
 * id comparison (`i['id'] == job['item']`) and the revalidation lineage
 * comparison (`record['origin_job'] != job['origin_job']`). It compares by
 * Python value, not by canonical text and not by instance identity:
 *
 * - integers and floats compare numerically (`1 == 1.0`) without rounding an
 *   exact integer; `NaN` is equal to nothing while `±Infinity` equals itself,
 *   as in Python;
 * - booleans compare as Python's `int` subclass (`True == 1`, `False == 0`),
 *   so a boolean never equals a string and does equal its numeric peer;
 * - strings compare by value and never equal a number or a boolean;
 * - lists compare elementwise, recursively, and only with lists; dicts compare
 *   by key set and value, ignoring key order, and only with dicts;
 * - `null` (Python `None`) equals only `null`, and a missing key reads as
 *   `None`, as `.get` does.
 *
 * Python `bool` is an `int` subclass, so reproducing this can select a pair a
 * stricter type check would refuse. Fidelity is this module's contract and the
 * state schema refuses such documents upstream; the oracle's non-string id and
 * boolean/numeric lineage cases are generated from Python for exactly this
 * reason. Python `Decimal` and other custom `__eq__` types cannot arise: the
 * port holds JSON values only.
 */
function pythonEqual(left: JsonValue | undefined, right: JsonValue | undefined): boolean {
  const a = left ?? null;
  const b = right ?? null;
  const numbers = pythonNumbersEqual(a, b);
  if (numbers !== null) return numbers;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((entry, index) => pythonEqual(entry, b[index]));
  }
  if (a instanceof JsonObject || b instanceof JsonObject) {
    if (!(a instanceof JsonObject) || !(b instanceof JsonObject)) return false;
    if (a.entries.length !== b.entries.length) return false;
    return a.entries.every(([key, value]) => b.has(key) && pythonEqual(value, b.get(key)));
  }
  return a === b;
}

/**
 * `bounded.drain_job`: classify one inbox job. A `run` outcome is either the
 * raw prepared job (the strict selector already verified it) or the legacy
 * job bound to its immutable pin, finding digest and source blob.
 */
export function drainJob(input: RepairDrainInput): RepairDrainOutcome {
  if (!REPAIR_JOB_ID.test(input.jobId)) return drainSkip('job-id-invalid', null);
  if (input.jobFile.kind === 'unreadable') return drainSkip('job-unreadable', null);
  const value = input.jobFile.value;
  if (!(value instanceof JsonObject) || value.get('job') !== input.jobId) {
    return drainSkip('job-identity-mismatch', null);
  }
  const job = value;

  let record: JsonObject | undefined;
  try {
    record = recordObject(queueRecord(input.queue, job.get('item'), job.get('run'), 'ignore'));
  } catch (error) {
    if (error instanceof ShapeError) return drainSkip('selection-malformed', job);
    throw error;
  }
  if (record === undefined) return drainSkip('no-queued-run', job);
  let queued: boolean;
  try {
    queued =
      pythonContains(getOr(record, 'jobs', []), input.jobId) && record.get('state') === 'queued';
  } catch (error) {
    if (error instanceof ShapeError) return drainSkip('selection-malformed', job);
    throw error;
  }
  if (!queued) return drainSkip('no-queued-run', job);

  const resume = input.started;
  try {
    const canonical = canonicalRefusal(
      canonicalDeliveryRefusal({ rowText: input.triageRowText, job }),
    );
    if (canonical !== undefined) return drainSkip(canonical, job);
    const findingValue = job.get('finding');
    if (!(findingValue instanceof JsonObject)) throw new ShapeError('finding');
    const finding = findingValue;
    if (!severityRepairable(job)) return drainSkip('severity-not-repairable', job);
    const normalized = sourcePath(finding);
    if (!normalized.ok) return drainSkip('finding-path-invalid', job);
    const path = normalized.path;

    if (pythonTruthy(job.get('revalidation'))) {
      if (!resume) {
        const sourceSha = job.get('source_sha');
        if (typeof sourceSha !== 'string' || !checkSha(sourceSha)) {
          return drainSkip('source-sha-invalid', job);
        }
        const findingSha256 = job.get('finding_sha256');
        const selected = selectJob({
          jobId: input.jobId,
          sourceSha,
          findingSha256: typeof findingSha256 === 'string' ? findingSha256 : '',
          jobFile: { kind: 'value', value: job },
          queue: input.queue,
          triageRowText: input.triageRowText,
          git: input.git,
        });
        if (!selected.ok) {
          return selected.refusal === 'prepared-source-not-tip'
            ? drainStale(selected.refusal, job)
            : drainSkip(selected.refusal, job);
        }
      }
      return { status: 'run', job };
    }

    const pinValue = job.get('repair_base');
    if (typeof pinValue !== 'string' || !checkSha(pinValue)) {
      return drainSkip('source-sha-invalid', job);
    }
    if (record.get('base') !== pinValue) return drainSkip('pin-record-mismatch', job);

    const pin = pinValue;
    const blob = input.git.blobAt(pin, path);
    if (blob === undefined) {
      return resume ? drainSkip('pinned-path-missing', job) : drainStale('pinned-path-absent', job);
    }
    if (!resume) {
      if (pythonTruthy(record.get('open_pr'))) {
        if (input.git.isAncestor(pin, REPAIR_DEFAULT_REF)) {
          return drainStale('pr-head-on-default', job);
        }
        const branch = record.get('branch');
        const head =
          typeof branch === 'string' && branch.length > 0 && !branch.startsWith('-')
            ? input.git.originBranchHead(branch)
            : undefined;
        if (head === undefined) return drainStale('pr-branch-gone', job);
        if (head !== pin && input.git.blobAt(head, path) !== blob) {
          return drainStale('pr-branch-source-changed', job);
        }
      } else if (input.git.blobAt(REPAIR_DEFAULT_REF, path) !== blob) {
        return drainStale('default-source-changed', job);
      }
    }

    const bound = mergeBinding(job, [
      ['source_sha', pin],
      ['finding_sha256', findingDigest(finding)],
      ['source_blob_sha', blob],
    ]);
    return {
      status: 'run',
      job: bound.has('origin_job')
        ? bound
        : new JsonObject([...bound.entries, ['origin_job', null]]),
    };
  } catch (error) {
    if (error instanceof ShapeError) return drainSkip('selection-malformed', job);
    throw error;
  }
}
