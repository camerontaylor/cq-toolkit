/**
 * Pure binding, identity and validation policy for crq repair preparation.
 *
 * This is the offline, side-effect-free half of the C1 repair-prepare slice.
 * It mirrors the Python oracle (`crq_repair/bounded.py` plus
 * `repair_tick.prepare_current_job`) exactly for the checks it owns, and it
 * stops at PROPOSED preparation data: binding verification and deterministic
 * job/run-record values. It performs no queue write, no secret scan, no
 * canonical handoff, no stale marking and no dispatch. Those are named
 * pending effect gates on the ops result, never implied here.
 *
 * Digests use the lossless Python-compatible serialiser. Inputs are
 * {@link JsonObject} so `1` vs `1.0`, exact large integers and evidence-key
 * extras survive into `identity()`. The only ops dependency is a TYPE-only
 * import of the merged op binding; no runtime module from `src/ops` loads.
 */
import type { FixFindingBinding, FixFindingReport } from '../../ops/review/fixFinding.js';
import { JsonNumber, JsonObject, type JsonValue } from './jsonValue.js';
import { receiptJsonDigest } from './pythonJson.js';

/** The full typed refusal vocabulary. Never persisted, never prose-matched. */
export type RepairRefusal =
  | 'old-job-unreadable'
  | 'old-job-identity-mismatch'
  | 'old-job-item-missing'
  | 'old-job-not-tick-owned'
  | 'queue-item-unreadable'
  | 'evidence-unreadable'
  | 'source-sha-invalid'
  | 'source-not-current-tip'
  | 'source-tip-unreadable'
  | 'evidence-source-sha-mismatch'
  | 'finding-path-invalid'
  | 'severity-not-repairable'
  | 'finding-digest-mismatch'
  | 'source-blob-mismatch'
  | 'source-blob-unreadable'
  | 'verdict-not-still-valid'
  | 'evidence-text-invalid'
  | 'instructions-invalid'
  | 'instructions-dispatch-incompatible'
  | 'round-count-invalid'
  | 'round-ceiling'
  | 'result-not-object'
  | 'result-identity-mismatch'
  | 'result-binding-mismatch'
  | 'legacy-source-sha-missing'
  | 'fixfinding-result-not-ok'
  | 'fixfinding-result-envelope-invalid'
  | 'fixfinding-result-binding-missing'
  | 'fixfinding-result-binding-mismatch'
  | 'canonical-finding-id-invalid';

/**
 * The caller's existing round count for the current pin, injected as typed
 * evidence. `basis` is `canonical-finding` for a canonical minor finding and
 * `pr-pin` for the PR-pin history count; the ops layer rejects a basis that
 * disagrees with the historical job.
 */
export interface RepairRoundCount {
  readonly basis: 'canonical-finding' | 'pr-pin';
  readonly count: number;
}

/** The two immutable facts an injected git seam observed at check time. */
export interface RepairObservation {
  /** `git rev-parse origin/main`, lowercase 40-hex. */
  readonly currentTip: string;
  /** `git rev-parse <source>:<path>`, lowercase 40-hex. */
  readonly blobOid: string;
}

const CHECK_SHA = /^[0-9a-f]{40}$/;
const CANONICAL_FINDING = /^[0-9a-f]{64}$/;
/** Python `source_path`'s pre-normalisation character rejection. */
const UNSAFE_PATH_CHARACTERS = new Set(['\u0000', '\n', '\r', '\t', '"', '\\']);

function hasUnsafePathCharacter(value: string): boolean {
  return [...value].some((character) => UNSAFE_PATH_CHARACTERS.has(character));
}

/** Python `str.isspace()` code points, which differ from JavaScript `trim`. */
function pythonIsSpace(codePoint: number): boolean {
  return (
    (codePoint >= 0x09 && codePoint <= 0x0d) ||
    (codePoint >= 0x1c && codePoint <= 0x1f) ||
    codePoint === 0x20 ||
    codePoint === 0x85 ||
    codePoint === 0xa0 ||
    codePoint === 0x1680 ||
    (codePoint >= 0x2000 && codePoint <= 0x200a) ||
    codePoint === 0x2028 ||
    codePoint === 0x2029 ||
    codePoint === 0x202f ||
    codePoint === 0x205f ||
    codePoint === 0x3000
  );
}

const MAX_EVIDENCE_TEXT = 4000;
const MAX_INSTRUCTIONS = 2000;

/** Python `bool(value)` over the lossless JSON model. */
export function pythonTruthy(value: JsonValue | undefined): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.length > 0;
  if (value instanceof JsonNumber) {
    return value.kind === 'int' ? value.integer !== 0n : value.float !== 0;
  }
  if (Array.isArray(value)) return value.length > 0;
  return value.entries.length > 0;
}

/** Python `str.strip()` (default whitespace) over a JavaScript string. */
export function pythonStrip(value: string): string {
  const characters = [...value];
  let start = 0;
  while (start < characters.length) {
    const codePoint = characters[start]?.codePointAt(0);
    if (codePoint === undefined || !pythonIsSpace(codePoint)) break;
    start += 1;
  }
  let end = characters.length;
  while (end > start) {
    const codePoint = characters[end - 1]?.codePointAt(0);
    if (codePoint === undefined || !pythonIsSpace(codePoint)) break;
    end -= 1;
  }
  return characters.slice(start, end).join('');
}

/** Python `len(value)`: code points, not UTF-16 units. */
export function pythonLength(value: string): number {
  return [...value].length;
}

/** `bounded.check_sha`: exactly 40 lowercase hex. */
export function checkSha(value: unknown): boolean {
  return typeof value === 'string' && CHECK_SHA.test(value);
}

/** `bounded.require_canonical_delivery`'s identity grammar. */
export function checkCanonicalFindingId(value: unknown): value is string {
  return typeof value === 'string' && CANONICAL_FINDING.test(value);
}

/** `bounded.identity`: the Python canonical JSON digest. */
export function findingDigest(finding: JsonValue): string {
  return receiptJsonDigest(finding);
}

/**
 * `bounded.source_path` with `PurePosixPath` normalisation: reject empty,
 * unsafe characters, absolute paths, `.` and any `..` part; collapse `//` and
 * `.` segments. `a/` normalises to `a`; `a/./b` to `a/b`.
 */
export function sourcePath(
  finding: JsonValue,
):
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly refusal: 'finding-path-invalid' } {
  const path = finding instanceof JsonObject ? finding.get('path') : undefined;
  if (
    typeof path !== 'string' ||
    path.length === 0 ||
    hasUnsafePathCharacter(path) ||
    path.startsWith('/')
  ) {
    return { ok: false, refusal: 'finding-path-invalid' };
  }
  const parts = path.split('/').filter((part) => part !== '' && part !== '.');
  if (parts.length === 0 || parts.includes('..')) {
    return { ok: false, refusal: 'finding-path-invalid' };
  }
  return { ok: true, path: parts.join('/') };
}

/**
 * `bounded.repairable_severity`: critical/major, or minor with a 64-hex
 * lowercase canonical finding id.
 */
export function severityRepairable(job: JsonObject): boolean {
  const finding = job.get('finding');
  const severity = finding instanceof JsonObject ? finding.get('severity') : undefined;
  if (severity === 'critical' || severity === 'major') return true;
  if (severity !== 'minor') return false;
  return checkCanonicalFindingId(job.get('canonical_finding_id'));
}

function validEvidenceText(value: JsonValue | undefined): boolean {
  return (
    typeof value === 'string' &&
    pythonLength(value) <= MAX_EVIDENCE_TEXT &&
    pythonStrip(value).length > 0
  );
}

/**
 * `bounded.validate_revalidation` after the injected git seam supplied the
 * two observed facts. The order matches Python: source-sha grammar, observed
 * tip, severity, path, blob, then the evidence fields.
 */
export function validateEvidenceBinding(input: {
  readonly oldJob: JsonObject;
  readonly sourceSha: string;
  readonly evidence: JsonObject;
  readonly observed: RepairObservation;
}): RepairRefusal | undefined {
  if (!checkSha(input.sourceSha)) return 'source-sha-invalid';
  if (input.observed.currentTip !== input.sourceSha) return 'source-not-current-tip';
  if (!severityRepairable(input.oldJob)) return 'severity-not-repairable';
  const path = sourcePath(input.oldJob.get('finding') ?? null);
  if (!path.ok) return path.refusal;
  if (input.observed.blobOid !== input.evidence.get('source_blob_sha')) {
    return 'source-blob-mismatch';
  }
  if (input.evidence.get('source_sha') !== input.sourceSha) {
    return 'evidence-source-sha-mismatch';
  }
  const finding = input.oldJob.get('finding');
  if (finding === undefined || input.evidence.get('finding_sha256') !== findingDigest(finding)) {
    return 'finding-digest-mismatch';
  }
  if (input.evidence.get('verdict') !== 'still-valid') return 'verdict-not-still-valid';
  if (
    !validEvidenceText(input.evidence.get('reviewer')) ||
    !validEvidenceText(input.evidence.get('reason'))
  ) {
    return 'evidence-text-invalid';
  }
  return undefined;
}

/**
 * `prepare_current_job`'s raw `fix_instructions` check: a present key must be
 * a Python-valid string (1..2000 code points, non-blank, no NUL). The op's
 * UTF-16 bound is a separate dispatch-boundary check.
 */
export function validateInstructions(
  evidence: JsonObject,
):
  | { readonly ok: true; readonly instructions?: string }
  | { readonly ok: false; readonly refusal: 'instructions-invalid' } {
  if (!evidence.has('fix_instructions')) return { ok: true };
  const value = evidence.get('fix_instructions');
  if (
    typeof value !== 'string' ||
    value.includes('\u0000') ||
    pythonLength(value) > MAX_INSTRUCTIONS ||
    pythonStrip(value).length === 0
  ) {
    return { ok: false, refusal: 'instructions-invalid' };
  }
  return { ok: true, instructions: value };
}

/**
 * The deterministic prepared identity:
 * `token = identity({origin_job, source_sha, evidence[, preserve_worktree]})[:24]`,
 * `run = 'revalidated-' + token`, `job = 'crq-' + run + '-F1'`. The
 * revalidation digest covers the whole evidence object, extras included.
 */
export function preparedIdentity(input: {
  readonly oldJobId: string;
  readonly sourceSha: string;
  readonly evidence: JsonObject;
  readonly preserveWorktree?: boolean;
}): { readonly run: string; readonly jobId: string; readonly revalidationSha256: string } {
  const entries: Array<readonly [string, JsonValue]> = [
    ['origin_job', input.oldJobId],
    ['source_sha', input.sourceSha],
    ['evidence', input.evidence],
  ];
  if (input.preserveWorktree === true) entries.push(['preserve_worktree', true]);
  const token = receiptJsonDigest(new JsonObject(entries)).slice(0, 24);
  const run = `revalidated-${token}`;
  return {
    run,
    jobId: `crq-${run}-F1`,
    revalidationSha256: receiptJsonDigest(input.evidence),
  };
}

/** Python `{**old, **overrides}`: overridden keys keep their old position. */
function mergeObject(
  old: JsonObject,
  overrides: ReadonlyArray<readonly [string, JsonValue]>,
): JsonObject {
  const replacement = new Map(overrides);
  const entries: Array<readonly [string, JsonValue]> = [];
  for (const [key, value] of old.entries) {
    const overridden = replacement.get(key);
    entries.push([key, overridden === undefined ? value : overridden]);
  }
  for (const [key, value] of overrides) {
    if (!old.has(key)) entries.push([key, value]);
  }
  return new JsonObject(entries);
}

/**
 * The new prepared job, in Python's exact insertion order, WITHOUT writing
 * or scanning it. `oldJob` and its nested values are never mutated.
 */
export function proposedPreparedJob(input: {
  readonly oldJob: JsonObject;
  readonly oldJobId: string;
  readonly sourceSha: string;
  readonly evidence: JsonObject;
  readonly findingSha256: string;
  readonly round: number;
  readonly run: string;
  readonly jobId: string;
  readonly preserveWorktree?: boolean;
}): JsonObject {
  const oldSource = input.oldJob.get('source');
  if (oldSource !== undefined && !(oldSource instanceof JsonObject)) {
    throw new TypeError('historical job source is not an object');
  }
  const source = oldSource instanceof JsonObject ? oldSource : new JsonObject([]);
  const oldRun = input.oldJob.get('run');
  const sourceRun = source.has('run') ? source.get('run') : oldRun;
  if (sourceRun === undefined) throw new TypeError('historical job has no run identity');
  const mergedSource = mergeObject(source, [['run', sourceRun]]);
  const overrides: Array<readonly [string, JsonValue]> = [
    ['job', input.jobId],
    ['run', input.run],
    ['cycle', null],
    ['kind', 'merged'],
    ['repair_base', input.sourceSha],
    ['branch', null],
    ['repair_round', JsonNumber.int(input.round)],
    ['origin_job', input.oldJobId],
    ['source_sha', input.sourceSha],
    ['finding_sha256', input.findingSha256],
    ['revalidation', input.evidence],
    ['prior', null],
    ['recurrence', false],
    ['source', mergedSource],
  ];
  if (input.preserveWorktree === true) overrides.push(['recovery_worktree', true]);
  return mergeObject(input.oldJob, overrides);
}

/** The new run record, in Python's exact insertion order. */
export function proposedRunRecord(input: {
  readonly jobId: string;
  readonly sourceSha: string;
  readonly round: number;
  readonly originJobId: string;
  readonly revalidationSha256: string;
  readonly canonicalFindingId?: string;
}): JsonObject {
  const entries: Array<readonly [string, JsonValue]> = [
    ['jobs', [input.jobId]],
    ['pin', input.sourceSha],
    ['base', input.sourceSha],
    ['branch', null],
    ['open_pr', false],
    ['round', JsonNumber.int(input.round)],
    ['state', 'queued'],
    ['origin_job', input.originJobId],
    ['revalidation_sha256', input.revalidationSha256],
  ];
  if (input.canonicalFindingId !== undefined) {
    entries.push(['canonical_finding_id', input.canonicalFindingId]);
  }
  return new JsonObject(entries);
}

/**
 * Legacy Python artifact parity (`repair_tick.harvest`): result `job`/`item`
 * identity, then, when the prepared job carries a truthy `source_sha`, the
 * result `source_sha`/`finding_sha256`/`origin_job` binding. A missing
 * prepared `source_sha` skips the binding check only under the explicit
 * caller opt-in; this slice never infers legacy compatibility.
 */
export function legacyPythonResultRefusal(input: {
  readonly prepared: JsonObject;
  readonly result: JsonValue;
  readonly allowMissingPreparedSourceSha: boolean;
}): RepairRefusal | undefined {
  if (!(input.result instanceof JsonObject)) return 'result-not-object';
  if (
    input.result.get('job') !== input.prepared.get('job') ||
    input.result.get('item') !== input.prepared.get('item')
  ) {
    return 'result-identity-mismatch';
  }
  const preparedSourceSha = input.prepared.get('source_sha');
  if (!pythonTruthy(preparedSourceSha)) {
    return input.allowMissingPreparedSourceSha ? undefined : 'legacy-source-sha-missing';
  }
  if (
    input.result.get('source_sha') !== preparedSourceSha ||
    input.result.get('finding_sha256') !== input.prepared.get('finding_sha256') ||
    input.result.get('origin_job') !== input.prepared.get('origin_job')
  ) {
    return 'result-binding-mismatch';
  }
  return undefined;
}

const BINDING_FIELDS = [
  'job',
  'sourceSha',
  'sourceBlobSha',
  'findingSha256',
  'repairBase',
] as const satisfies ReadonlyArray<keyof FixFindingBinding>;

/**
 * A `review.fixFinding` artifact whose frozen `OpResult` envelope and
 * op-specific report were already validated at the ops boundary with the
 * canonical `OpResultArtifactSchema`. The pure check never re-parses an
 * unvalidated envelope.
 */
export type ValidatedFixFindingArtifact =
  | { readonly status: 'ok'; readonly value: JsonValue }
  | { readonly status: 'failed'; readonly error: string; readonly report: FixFindingReport }
  | {
      readonly status: 'needs-human';
      readonly reason: string;
      readonly report: FixFindingReport;
    }
  | { readonly status: 'budget-exhausted'; readonly report: FixFindingReport }
  | {
      readonly status: 'indeterminate';
      readonly detail: string;
      readonly report: FixFindingReport;
    };

/**
 * The new typed `review.fixFinding` artifact is an `OpResult` envelope. An
 * `ok` envelope's `value` MUST echo a COMPLETE binding equal to all five
 * prepared fields. Missing, non-object and mismatch refuse; there is no
 * optional-echo bypass for new artifacts (unlike legacy Python results, which
 * predate the binding). A validated non-ok status is reported truthfully as
 * non-harvestable rather than flattened into a missing-binding failure.
 */
export function typedFixFindingResultRefusal(input: {
  readonly prepared: FixFindingBinding;
  readonly artifact: ValidatedFixFindingArtifact;
}): RepairRefusal | undefined {
  if (input.artifact.status !== 'ok') return 'fixfinding-result-not-ok';
  const echo =
    input.artifact.value instanceof JsonObject ? input.artifact.value.get('binding') : undefined;
  if (!(echo instanceof JsonObject)) return 'fixfinding-result-binding-missing';
  for (const field of BINDING_FIELDS) {
    if (!echo.has(field)) return 'fixfinding-result-binding-missing';
  }
  for (const field of BINDING_FIELDS) {
    if (echo.get(field) !== input.prepared[field]) return 'fixfinding-result-binding-mismatch';
  }
  return undefined;
}

/**
 * Receiving-boundary gate for the op's UTF-16 instruction bound. Python
 * validation counts code points; a non-BMP instruction can pass Python and
 * exceed the op's 2000 UTF-16 units. Refuse explicitly rather than truncate.
 */
export function dispatchInstructionsRefusal(
  instructions: string | undefined,
): RepairRefusal | undefined {
  if (instructions === undefined) return undefined;
  if (
    instructions.length < 1 ||
    instructions.length > MAX_INSTRUCTIONS ||
    instructions.includes('\u0000')
  ) {
    return 'instructions-dispatch-incompatible';
  }
  return undefined;
}
