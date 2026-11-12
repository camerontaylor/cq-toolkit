/**
 * Pure typed dispatch-request construction for the C1 repair lane.
 *
 * Lifecycle position: after preparation has verified the historical job, the
 * current pin and the revalidation evidence and has scanned the pinned source
 * and any operator guidance; before the `review.fixFinding` op is invoked.
 * This module is the bridge between the legacy crq repair job shape and the
 * merged typed op input. It performs no dispatch, enqueue, queue write,
 * secret scan, git read, clock read or persistence. Its result is a REQUEST,
 * not permission to dispatch.
 *
 * D3 (repair is replaced, not ported): the Python repair drivers are not
 * ported. Their observable input composition is, where the typed op still
 * needs it: the pinned-source excerpt and the finding body. `legacyFixerBody`
 * is the exact `drivers/cq.py:fixer_body` port used as the Python oracle and
 * as the body half of the typed mapping.
 *
 * LEGACY FORMAT AND THE TYPED MAPPING (deliberate):
 *
 *   - `legacyFixerBody(job)` reproduces Python `fixer_body(job)` byte for
 *     byte: the complete finding body, the selected guidance block, the
 *     mechanical evidence, and the packed pinned-source snapshot, greedily
 *     expanded by WHOLE anchor-containing lines under an 8000 UTF-16 unit
 *     bound. Nothing is truncated; an oversized anchor/provenance body is a
 *     typed refusal.
 *   - `buildRepairRequest` uses the same body composition and the same
 *     whole-line expansion, but moves ALREADY-SCANNED operator guidance to
 *     the typed op's `instructions` field, which the op renders as trusted
 *     caller data outside the untrusted fence. When operator guidance is
 *     present, neither the operator block nor the legacy retry block rides in
 *     the body (Python's operator block also suppresses the retry block).
 *     When there is no operator guidance, the legacy retry guidance from
 *     `job.fix_instructions` stays in the body exactly as Python places it.
 *     An oracle case proves the typed body equals Python `fixer_body` for the
 *     same job with its guidance fields removed.
 *
 * BINDING IS EXPLICIT AND UNVERIFIED. The caller supplies all five
 * `FixFindingBinding` fields. This module checks their grammar and their
 * consistency with the prepared job/snapshot identity data; it never reads
 * git, the worktree or a blob, and it never claims the binding is current.
 * The success value says `bindingStatus: 'caller-unverified'` and carries the
 * pending revalidation/scan gates. `status: 'request-built'` is not dispatch
 * readiness.
 *
 * BOUNDS: the body is bounded at 8000 UTF-16 units (Python
 * `fixer_body`/`review.fixFinding` `MAX_ITEM_BODY_CHARS`), never truncated.
 * Instructions are bounded by the op at 1..2000 UTF-16 units with no NUL;
 * this module refuses an incompatible value rather than truncating. The
 * whole-request 32768 UTF-16 unit envelope is deliberately NOT measured here:
 * the op owns that bound over the exact serialized `{normalizedInput,
 * invocation}` object. The builder only declares the remaining
 * `invocation-size-bound` gate.
 *
 * JSON BYTES: Python `fixer_body` calls `json.dumps(packed)` with its default
 * `ensure_ascii=True`, insertion-order and `', '`/`': '` separators. That
 * encoding affects astral characters and escaping, and therefore the 8000
 * bound, so the local writer below matches it exactly. `JsonObject` preserves
 * source key order and `JsonNumber` preserves int-vs-float lexemes.
 */
import type { Budget, ModelSpec } from '../../driver/types.js';
import type { HarnessConfig } from '../../harness/config.js';
import type { FixFindingBinding, FixFindingInput } from '../../ops/review/fixFinding.js';
import { JsonNumber, JsonObject, type JsonValue } from './jsonValue.js';
import {
  checkCanonicalFindingId,
  checkSha,
  dispatchInstructionsRefusal,
  pythonTruthy,
  validateInstructions,
} from './repairBinding.js';
import { encodePythonString, pythonFloatRepr } from './pythonJson.js';

/** The fixed body bound, in UTF-16 code units. Mirrors the Python driver and the op. */
const MAX_REPAIR_BODY_CHARS = 8_000;

/**
 * The internal typed refusal vocabulary. These are policy codes, never
 * persisted and never matched as prose. They are deliberately separate from
 * `RepairRefusal`: this slice adds request-construction failures, not
 * preparation-state failures.
 */
export type RepairRequestRefusal =
  | 'prepared-job-unreadable'
  | 'finding-path-invalid'
  | 'source-snapshot-unreadable'
  | 'source-anchor-provenance-unavailable'
  | 'source-excerpt-incomplete-or-malformed'
  | 'item-body-budget-exceeded'
  | 'mechanical-evidence-invalid'
  | 'binding-invalid'
  | 'binding-mismatch'
  | 'guidance-unverified'
  | 'instructions-dispatch-incompatible'
  | 'request-context-invalid';

/** The anchor facts carried back for harvest/idempotent inspection. */
export interface RepairBodyAnchor {
  /** First whole line number included in the packed excerpt. */
  readonly lineStart: number;
  /** Last whole line number included in the packed excerpt. */
  readonly lineEnd: number;
  /** True when the excerpt omits any part of the pinned file. */
  readonly incomplete: boolean;
  /** Number of whole source lines included. */
  readonly lineCount: number;
}

/** The legacy `fixer_body` oracle result. */
export type LegacyFixerBodyResult =
  | { readonly ok: true; readonly body: string; readonly anchor: RepairBodyAnchor }
  | { readonly ok: false; readonly refusal: RepairRequestRefusal };

/** The prepared, already-verified data the builder consumes. */
export interface RepairRequestPrepared {
  /** The prepared job (`state/repair/inbox/<jobId>.json` shape). Never mutated. */
  readonly job: JsonObject;
  /** The pinned source snapshot the Python driver called `source_snapshot`. */
  readonly snapshot: JsonObject;
  /**
   * The caller's five-field binding. Carried UNVERIFIED; this module checks
   * grammar and consistency with `job`/`snapshot`, never git state.
   */
  readonly binding: FixFindingBinding;
  /**
   * The operator guidance already scanned by the caller. It must equal the
   * prepared job's `revalidation.fix_instructions` when that field exists,
   * and must be absent when it does not. It becomes the typed op's
   * `instructions` field, not part of the untrusted body.
   */
  readonly scannedGuidance?: string;
}

/** The request context the caller owns (config/workspace/model/budget). */
export interface RepairRequestContext {
  /** Repository as `owner/name`; the op allows omission, so this does too. */
  readonly repo?: string;
  readonly worktree: { readonly path: string; readonly branch: string };
  readonly driver: ModelSpec;
  readonly harness?: HarnessConfig;
  readonly budget?: Budget;
  readonly promptOverride?: string;
}

export interface BuildRepairRequestInput {
  readonly prepared: RepairRequestPrepared;
  readonly context: RepairRequestContext;
}

/**
 * Every effect the caller still owns after a request is built. This list is
 * deliberately explicit: `request-built` is not `dispatch-ready`.
 */
export type RepairRequestGate =
  | 'caller-binding-revalidation'
  | 'source-tip-revalidation'
  | 'source-blob-revalidation'
  | 'source-secret-scan-confirmation'
  | 'guidance-secret-scan-confirmation'
  | 'invocation-size-bound'
  | 'enqueue-dispatch'
  | 'harvest-disposition';

/** The gates that do not depend on whether guidance is present. */
const BASE_REMAINING_GATES: readonly RepairRequestGate[] = [
  'caller-binding-revalidation',
  'source-tip-revalidation',
  'source-blob-revalidation',
  'source-secret-scan-confirmation',
  'invocation-size-bound',
  'enqueue-dispatch',
  'harvest-disposition',
];

/** A built request. `bindingStatus` is deliberately not a boolean. */
export interface BuiltRepairRequest {
  readonly status: 'request-built';
  /** The exact typed op input. `input.binding` is the unverified caller binding. */
  readonly input: FixFindingInput;
  /** The binding is carried, never verified by this module. */
  readonly bindingStatus: 'caller-unverified';
  readonly itemId: string;
  /** Body length in UTF-16 code units (the bound is enforced here). */
  readonly bodyChars: number;
  /** Instructions length in UTF-16 code units, or 0 when absent. */
  readonly instructionsChars: number;
  readonly anchor: RepairBodyAnchor;
  /** Every effect still to perform; always non-empty. */
  readonly remainingGates: readonly RepairRequestGate[];
}

export type BuildRepairRequestResult =
  | { readonly ok: true; readonly value: BuiltRepairRequest }
  | { readonly ok: false; readonly refusal: RepairRequestRefusal };

interface ValidatedAnchor {
  readonly line: number;
  readonly start: number;
  readonly end: number;
  readonly lines: readonly string[];
}

interface GuidanceSelection {
  readonly operator?: string;
  readonly guidance: string;
}

type GuidanceMode = 'legacy' | 'typed-extracted';

function refusal(value: RepairRequestRefusal): {
  readonly ok: false;
  readonly refusal: RepairRequestRefusal;
} {
  return { ok: false, refusal: value };
}

/** Python `isinstance(value, int) and not isinstance(value, bool)`. */
function pythonInt(value: JsonValue | undefined): number | undefined {
  if (!(value instanceof JsonNumber) || value.kind !== 'int') return undefined;
  const integer = value.integer as bigint;
  if (integer > BigInt(Number.MAX_SAFE_INTEGER) || integer < BigInt(Number.MIN_SAFE_INTEGER)) {
    return undefined;
  }
  return Number(integer);
}

/** Python `{**object, **overrides}`: overridden keys keep their old position. */
function mergeObject(
  object: JsonObject,
  overrides: ReadonlyArray<readonly [string, JsonValue]>,
): JsonObject {
  const replacement = new Map(overrides);
  const entries: Array<readonly [string, JsonValue]> = [];
  const seen = new Set<string>();
  for (const [key, value] of object.entries) {
    const overridden = replacement.get(key);
    entries.push([key, overridden === undefined ? value : overridden]);
    seen.add(key);
  }
  for (const [key, value] of overrides) {
    if (!seen.has(key)) entries.push([key, value]);
  }
  return new JsonObject(entries);
}

/**
 * Python `json.dumps(value)` defaults: `ensure_ascii=True`, insertion order,
 * `', '` and `': '` separators, no sorting, and Python float `repr`.
 */
function pythonJsonDumpsDefault(value: JsonValue): string {
  if (value === null) return 'null';
  if (value === true) return 'true';
  if (value === false) return 'false';
  if (typeof value === 'string') return encodePythonString(value, true, false);
  if (value instanceof JsonNumber) {
    return value.kind === 'int'
      ? (value.integer as bigint).toString()
      : pythonFloatRepr(value.float as number);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => pythonJsonDumpsDefault(entry)).join(', ')}]`;
  }
  const entries = value.entries.map(
    ([key, entry]) => `${encodePythonString(key, true, false)}: ${pythonJsonDumpsDefault(entry)}`,
  );
  return `{${entries.join(', ')}}`;
}

/** Python `len(text.encode('utf-16-le', errors='surrogatepass')) // 2`. */
function utf16Length(text: string): number {
  // JavaScript string length counts UTF-16 code units, including lone
  // surrogates, exactly like Python's surrogatepass encoding.
  return text.length;
}

/**
 * The combined anchor/provenance check, in Python's exact order:
 * line/start/end int-ness and range, source string, snapshot path equality,
 * then `source_sha`/`source_blob_sha`/`finding_sha256` non-empty strings.
 */
function validateAnchor(
  job: JsonObject,
  snapshot: JsonObject,
):
  | { readonly ok: true; readonly anchor: ValidatedAnchor }
  | { readonly ok: false; readonly refusal: RepairRequestRefusal } {
  const finding = job.get('finding');
  if (!(finding instanceof JsonObject)) return refusal('prepared-job-unreadable');
  const line = pythonInt(finding.get('line'));
  const start = pythonInt(snapshot.get('line_start'));
  const end = pythonInt(snapshot.get('line_end'));
  const source = snapshot.get('source');
  const pathMatches = snapshot.get('path') === finding.get('path');
  const provenance = ['source_sha', 'source_blob_sha', 'finding_sha256'] as const;
  let provenanceOk = true;
  for (const key of provenance) {
    const value = snapshot.get(key);
    if (typeof value !== 'string' || value.length === 0) provenanceOk = false;
  }
  if (
    line === undefined ||
    start === undefined ||
    end === undefined ||
    !(1 <= start && start <= line && line <= end) ||
    typeof source !== 'string' ||
    !pathMatches ||
    !provenanceOk
  ) {
    return refusal('source-anchor-provenance-unavailable');
  }
  const lines = source.split('\n');
  if (
    lines.length !== end - start + 1 ||
    lines.some((text, offset) => !text.startsWith(`${start + offset}: `))
  ) {
    return refusal('source-excerpt-incomplete-or-malformed');
  }
  return { ok: true, anchor: { line, start, end, lines } };
}

/**
 * Python `fixer_body`'s guidance selection. The typed mapping extracts
 * operator guidance into the trusted `instructions` channel, so when it is
 * present that block is removed from the body (and the legacy retry fallback
 * stays suppressed, exactly as Python's operator branch suppresses it).
 */
function selectGuidance(
  job: JsonObject,
  mode: GuidanceMode,
):
  | { readonly ok: true; readonly value: GuidanceSelection }
  | { readonly ok: false; readonly refusal: RepairRequestRefusal } {
  const revalidation = job.get('revalidation');
  let operator: string | undefined;
  if (revalidation !== undefined) {
    if (!(revalidation instanceof JsonObject)) return refusal('prepared-job-unreadable');
    if (mode === 'typed-extracted') {
      const checked = validateInstructions(revalidation);
      if (!checked.ok) return refusal('instructions-dispatch-incompatible');
      operator = checked.instructions;
    }
  }
  const retryValue = job.get('fix_instructions');
  const retry = typeof retryValue === 'string' && retryValue.length > 0 ? retryValue : undefined;

  // The legacy oracle follows Python's `or` and `isinstance` exactly,
  // including a truthy non-string operator value (which selects the operator
  // label but contributes no guidance text). The typed path validates the
  // prepared evidence instead, because it must not dispatch malformed
  // guidance through the trusted instructions channel.
  if (mode === 'legacy') {
    const operatorRaw =
      revalidation instanceof JsonObject ? revalidation.get('fix_instructions') : undefined;
    const operatorChosen = pythonTruthy(operatorRaw) ? operatorRaw : undefined;
    const chosen = operatorChosen ?? (pythonTruthy(retryValue) ? retryValue : undefined);
    if (chosen === undefined) return { ok: true, value: { guidance: '' } };
    const label =
      operatorChosen === undefined
        ? 'Retry guidance from the previous attempt'
        : 'Operator fix guidance';
    const text = typeof chosen === 'string' && chosen.length > 0 ? chosen : undefined;
    const guidance =
      text === undefined
        ? ''
        : '\n' + label + ' (subject to normal scope and safety rules):\n' + text;
    return { ok: true, value: { guidance } };
  }

  if (mode === 'typed-extracted' && operator !== undefined) {
    return { ok: true, value: { operator, guidance: '' } };
  }

  const chosen = operator ?? retry;
  if (chosen === undefined) {
    return {
      ok: true,
      value: operator === undefined ? { guidance: '' } : { operator, guidance: '' },
    };
  }
  const label =
    operator === undefined ? 'Retry guidance from the previous attempt' : 'Operator fix guidance';
  const guidance = '\n' + label + ' (subject to normal scope and safety rules):\n' + chosen;
  return {
    ok: true,
    value: operator === undefined ? { guidance } : { operator, guidance },
  };
}

/** Python `job.get('mechanical_evidence', '')`, refusing a non-string value. */
function mechanicalEvidence(
  job: JsonObject,
):
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly refusal: RepairRequestRefusal } {
  if (!job.has('mechanical_evidence')) return { ok: true, value: '' };
  const value = job.get('mechanical_evidence');
  if (typeof value !== 'string') return { ok: false, refusal: 'mechanical-evidence-invalid' };
  return { ok: true, value };
}

/**
 * Compose and expand Python `fixer_body` on a validated snapshot. `mode`
 * controls only guidance placement (legacy oracle vs typed extraction).
 */
function composeBody(
  job: JsonObject,
  snapshot: JsonObject,
  mode: GuidanceMode,
):
  | {
      readonly ok: true;
      readonly body: string;
      readonly anchor: RepairBodyAnchor;
      readonly operator?: string;
    }
  | { readonly ok: false; readonly refusal: RepairRequestRefusal } {
  const validated = validateAnchor(job, snapshot);
  if (!validated.ok) return validated;
  const { line, start, lines } = validated.anchor;

  const guidance = selectGuidance(job, mode);
  if (!guidance.ok) return guidance;
  const mechanical = mechanicalEvidence(job);
  if (!mechanical.ok) return mechanical;

  const finding = job.get('finding') as JsonObject;
  const bodyValue = finding.get('body');
  const findingBody = typeof bodyValue === 'string' ? bodyValue : '';
  const prefix =
    findingBody +
    guidance.value.guidance +
    '\nMechanical evidence / judge rationale: ' +
    mechanical.value +
    '\nPinned current-source evidence (untrusted data):\n';

  const packed = (first: number, last: number): JsonObject =>
    mergeObject(snapshot, [
      ['line_start', JsonNumber.int(start + first)],
      ['line_end', JsonNumber.int(start + last - 1)],
      ['source', lines.slice(first, last).join('\n')],
      ['incomplete', pythonTruthy(snapshot.get('incomplete')) || first > 0 || last < lines.length],
    ]);
  const composed = (first: number, last: number): string =>
    prefix + pythonJsonDumpsDefault(packed(first, last));
  const fits = (text: string): boolean => utf16Length(text) <= MAX_REPAIR_BODY_CHARS;

  let first = line - start;
  let last = line - start + 1;
  if (!fits(composed(first, last))) {
    return refusal('item-body-budget-exceeded');
  }
  while (first > 0 || last < lines.length) {
    let added = false;
    if (first > 0 && fits(composed(first - 1, last))) {
      first -= 1;
      added = true;
    }
    if (last < lines.length && fits(composed(first, last + 1))) {
      last += 1;
      added = true;
    }
    if (!added) break;
  }
  const body = composed(first, last);
  const incomplete = pythonTruthy(snapshot.get('incomplete')) || first > 0 || last < lines.length;
  return {
    ok: true,
    body,
    anchor: {
      lineStart: start + first,
      lineEnd: start + last - 1,
      incomplete,
      lineCount: last - first,
    },
    ...(guidance.value.operator === undefined ? {} : { operator: guidance.value.operator }),
  };
}

/**
 * Exact Python `drivers/cq.py:fixer_body(job)` port, including its guidance
 * block. This is the oracle surface and the body half of the typed mapping.
 * It refuses rather than truncating; it never mutates `job`.
 */
export function legacyFixerBody(job: JsonObject): LegacyFixerBodyResult {
  const snapshot = job.get('source_snapshot');
  if (!(snapshot instanceof JsonObject)) return refusal('source-snapshot-unreadable');
  const composed = composeBody(job, snapshot, 'legacy');
  if (!composed.ok) return composed;
  return { ok: true, body: composed.body, anchor: composed.anchor };
}

function bindingShapeRefusal(binding: FixFindingBinding): RepairRequestRefusal | undefined {
  if (typeof binding.job !== 'string' || binding.job.length === 0) return 'binding-invalid';
  if (!checkSha(binding.sourceSha)) return 'binding-invalid';
  if (!checkSha(binding.sourceBlobSha)) return 'binding-invalid';
  if (!checkCanonicalFindingId(binding.findingSha256)) return 'binding-invalid';
  if (!checkSha(binding.repairBase)) return 'binding-invalid';
  return undefined;
}

/**
 * Identity consistency only: the caller's binding must name the prepared
 * job and snapshot it claims. This is not git verification, so a matching
 * binding remains `caller-unverified`.
 */
function bindingConsistencyRefusal(
  job: JsonObject,
  snapshot: JsonObject,
  binding: FixFindingBinding,
): RepairRequestRefusal | undefined {
  if (job.get('job') !== binding.job) return 'binding-mismatch';
  if (snapshot.get('source_sha') !== binding.sourceSha) return 'binding-mismatch';
  if (snapshot.get('source_blob_sha') !== binding.sourceBlobSha) return 'binding-mismatch';
  if (snapshot.get('finding_sha256') !== binding.findingSha256) return 'binding-mismatch';
  if (job.has('source_sha') && job.get('source_sha') !== binding.sourceSha) {
    return 'binding-mismatch';
  }
  if (job.has('finding_sha256') && job.get('finding_sha256') !== binding.findingSha256) {
    return 'binding-mismatch';
  }
  if (job.has('repair_base') && job.get('repair_base') !== binding.repairBase) {
    return 'binding-mismatch';
  }
  return undefined;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function contextRefusal(context: RepairRequestContext): RepairRequestRefusal | undefined {
  const worktree = context.worktree as { readonly path?: unknown; readonly branch?: unknown };
  if (!nonEmptyString(worktree.path) || !nonEmptyString(worktree.branch)) {
    return 'request-context-invalid';
  }
  const driver = context.driver as { readonly provider?: unknown; readonly model?: unknown };
  if (!nonEmptyString(driver.provider) || !nonEmptyString(driver.model)) {
    return 'request-context-invalid';
  }
  if (context.repo !== undefined && !nonEmptyString(context.repo)) {
    return 'request-context-invalid';
  }
  if (context.promptOverride !== undefined && !nonEmptyString(context.promptOverride)) {
    return 'request-context-invalid';
  }
  return undefined;
}

/**
 * The prepared job's positive `pr`, exactly as Python includes it: an int,
 * not a bool, greater than zero. Zero, floats and a missing key are omitted.
 */
function positivePr(
  job: JsonObject,
):
  | { readonly ok: true; readonly value?: number }
  | { readonly ok: false; readonly refusal: RepairRequestRefusal } {
  const value = job.get('pr');
  if (!(value instanceof JsonNumber) || value.kind !== 'int') return { ok: true };
  const integer = value.integer as bigint;
  if (integer <= 0n) return { ok: true };
  if (integer > BigInt(Number.MAX_SAFE_INTEGER)) return refusal('prepared-job-unreadable');
  return { ok: true, value: Number(integer) };
}

function remainingGates(hasGuidance: boolean): readonly RepairRequestGate[] {
  if (!hasGuidance) return [...BASE_REMAINING_GATES];
  return [
    'caller-binding-revalidation',
    'source-tip-revalidation',
    'source-blob-revalidation',
    'source-secret-scan-confirmation',
    'guidance-secret-scan-confirmation',
    'invocation-size-bound',
    'enqueue-dispatch',
    'harvest-disposition',
  ];
}

/**
 * Build the exact `review.fixFinding` input for one prepared repair job.
 *
 * The result is a request, not a dispatch decision: the binding is marked
 * `caller-unverified`, and `remainingGates` names every revalidation, scan,
 * invocation-bound and effect still owned by the caller. The whole-request
 * 32768 UTF-16 unit envelope is not measured here; the op owns it.
 */
export function buildRepairRequest(input: BuildRepairRequestInput): BuildRepairRequestResult {
  const { prepared, context } = input;
  if (!(prepared.job instanceof JsonObject)) return refusal('prepared-job-unreadable');
  if (!(prepared.snapshot instanceof JsonObject)) return refusal('source-snapshot-unreadable');

  const jobId = prepared.job.get('job');
  if (!nonEmptyString(jobId)) return refusal('prepared-job-unreadable');
  const finding = prepared.job.get('finding');
  if (!(finding instanceof JsonObject)) return refusal('prepared-job-unreadable');
  const path = finding.get('path');
  if (!nonEmptyString(path)) return refusal('finding-path-invalid');

  const bindingRefusal = bindingShapeRefusal(prepared.binding);
  if (bindingRefusal !== undefined) return refusal(bindingRefusal);
  const consistencyRefusal = bindingConsistencyRefusal(
    prepared.job,
    prepared.snapshot,
    prepared.binding,
  );
  if (consistencyRefusal !== undefined) return refusal(consistencyRefusal);

  const contextFailure = contextRefusal(context);
  if (contextFailure !== undefined) return refusal(contextFailure);

  const composed = composeBody(prepared.job, prepared.snapshot, 'typed-extracted');
  if (!composed.ok) return composed;

  const operator = composed.operator;
  if (operator !== undefined) {
    if (prepared.scannedGuidance !== operator) return refusal('guidance-unverified');
    if (dispatchInstructionsRefusal(operator) !== undefined) {
      return refusal('instructions-dispatch-incompatible');
    }
  } else if (prepared.scannedGuidance !== undefined) {
    return refusal('guidance-unverified');
  }

  const pr = positivePr(prepared.job);
  if (!pr.ok) return pr;

  const line = pythonInt(finding.get('line'));
  if (line === undefined) return refusal('source-anchor-provenance-unavailable');

  const typedInput: FixFindingInput = {
    ...(context.repo === undefined ? {} : { repo: context.repo }),
    ...(pr.value === undefined ? {} : { pr: pr.value }),
    item: {
      // The legacy driver uses the prepared job id, which the repair verifier
      // requires in every fix commit subject; it is not finding.id.
      id: jobId,
      path,
      line,
      body: composed.body,
      comments: [],
    },
    worktree: { path: context.worktree.path, branch: context.worktree.branch },
    driver: context.driver,
    ...(context.harness === undefined ? {} : { harness: context.harness }),
    ...(context.budget === undefined ? {} : { budget: context.budget }),
    ...(context.promptOverride === undefined ? {} : { promptOverride: context.promptOverride }),
    binding: prepared.binding,
    ...(operator === undefined ? {} : { instructions: operator }),
  };

  return {
    ok: true,
    value: {
      status: 'request-built',
      input: typedInput,
      bindingStatus: 'caller-unverified',
      itemId: jobId,
      bodyChars: utf16Length(composed.body),
      instructionsChars: operator === undefined ? 0 : utf16Length(operator),
      anchor: composed.anchor,
      remainingGates: remainingGates(operator !== undefined),
    },
  };
}
