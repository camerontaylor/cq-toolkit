// fixFinding — the C1 review-finding fix op (crq repair input, 2026-11-10).
//
// One already-triaged finding in, one worker invocation out. It shares the
// worker dispatch seam with review.fixItem (./internal/fixWorker.ts) but
// differs in the two places the C1 harvest needs:
//
//   1. TYPED DISPOSITIONS. A well-formed fix contract is ALWAYS an `ok`
//      result, including `needs_human`, `no_outcome`, and
//      `unchanged_with_reason` without evidence (`evidenceMissing: true`).
//      The op returns the worker's stated disposition and evidence as typed
//      fields; no caller classifies from the needs-human reason prose.
//   2. TYPED FAILURE CLASS. A non-ok result carries the existing
//      OpResultArtifact `report` envelope with a strict `failureClass`
//      drawn ONLY from the typed dispatch source: the driver's stopReason
//      and errorClass, the contract parse verdict, or the dispatch phase.
//      No prose is inspected, and the kernel's frozen OpResult union is
//      unchanged.
//
// BINDING IS IDENTITY DATA, NOT VERIFIED HERE. `binding` is carried into the
// request (and therefore into the serialized bound) and echoed in every ok
// value for harvest/idempotent replay. The op never spawns git and never
// reads the worktree: crq verifies the git tip/blob/hash before enqueue and
// revalidates before harvest, exactly as it does today. The echo is
// explicitly UNVERIFIED.
//
// BOUNDS (this op only; review.fixItem keeps its historical truncation):
//   - item.body: at most 8000 UTF-16 code units. Over budget -> REFUSED,
//     never truncated (crq `fixer_body` semantics; D6 item 3).
//   - instructions: 1..2000 UTF-16 code units and no NUL. The caller scans
//     free text for secrets; this op enforces only the length/NUL bounds.
//   - whole request: JSON.stringify({ normalizedInput, invocation }).length
//     at most 32768 UTF-16 code units, where `invocation` is the EXACT
//     OpInvocation handed to the driver. The envelope also carries the
//     normalized input, so request data shared with the invocation prompt
//     (the item body, the composed prompt) is conservatively counted twice.
//     There is no user knob. `harness.promptBudget.maxSystemPromptChars`
//     remains the inner bound and may still head-cap the system prompt;
//     `truncated` reports that existing signal.
//   - Every bound is measured on the prepared request and REFUSED with
//     `failed` + `report: { failureClass: 'evidence' }` BEFORE driver.run.
//     Nothing is truncated to fit.
//
// SESSION/SPEND: the value returns the worker session id (review.fixItem
// keeps dropping it), and every non-ok report preserves the worker's typed
// usage, cost, denials and session id when a worker ran. No transcript is
// returned or logged and no secret is added.
import type { DriverFactory } from '../../driver/factory.js';
import type { ToolDenial, Usage, WorkerErrorClass } from '../../driver/types.js';
import type { OpResultArtifact } from '../../kernel/types.js';
import {
  normalizeReviewFixInput,
  type FixReviewItemInput,
  type ReviewFixInput,
} from './fixReviewItem.js';
import { MAX_ITEM_BODY_CHARS, runFixWorker } from './internal/fixWorker.js';
import type { FixWorkerEvidence, FixWorkerRun } from './internal/fixWorker.js';
import type { FixDisposition, FixEvidence } from './internal/fixContract.js';

/** The identity evidence crq pins for one finding attempt. Carried, not verified. */
export interface FixFindingBinding {
  /** The crq repair job id this attempt belongs to. */
  job: string;
  /** The review source commit sha (40 lowercase hex). */
  sourceSha: string;
  /** The finding's source blob sha (40 lowercase hex). */
  sourceBlobSha: string;
  /** SHA-256 of the canonical finding (64 lowercase hex). */
  findingSha256: string;
  /** The repair base commit sha (40 lowercase hex). */
  repairBase: string;
}

/**
 * Input of `review.fixFinding`: the review.fixItem request vocabulary plus
 * the carried binding and optional caller instructions. The item union is
 * shared, so a `{kind: 'finding'}` item is normalized by the same
 * `normalizeReviewFixInput` the fixItem op uses — never re-mapped here.
 */
export type FixFindingInput = ReviewFixInput & {
  binding: FixFindingBinding;
  /**
   * Caller-scanned guidance for this attempt. 1..2000 UTF-16 code units, no
   * NUL. The op enforces those bounds; it does not scan for secrets.
   */
  instructions?: string;
};

/** The typed failure classes the C1 harvest maps to its own vocabulary. */
export type FixFindingFailureClass = 'evidence' | 'exhausted' | 'transient';

/**
 * The strict report envelope on every non-ok result. `failureClass` is the
 * only required field and comes from a typed dispatch source. The worker
 * evidence fields ride along when a worker actually ran, so a failed,
 * aborted or budget-exhausted attempt still reports its spend and session
 * link without a transcript.
 */
export interface FixFindingReport {
  failureClass: FixFindingFailureClass;
  /** The driver's structured class, on a typed error stop only. */
  errorClass?: WorkerErrorClass;
  usage?: Usage;
  costUSD?: number;
  denials?: ToolDenial[];
  sessionId?: string;
}

/**
 * The `ok` value for every well-formed fix contract. `kind` says whether
 * the worker produced an outcome (only `fixed` and
 * `unchanged_with_reason`-with-evidence do); `disposition` retains the
 * worker's stated disposition. `disposition` is null ONLY for the legacy v1
 * no-change form, which states none.
 */
export interface FixFindingResult {
  kind: 'outcome' | 'no-outcome';
  disposition: FixDisposition | null;
  /** True exactly for `unchanged_with_reason` with zero evidence entries. */
  evidenceMissing: boolean;
  /** The worker's summary (head-capped by the shared contract parser). */
  summary: string;
  /** Full shas the worker created; always empty for a non-`fixed` disposition. */
  commits: string[];
  /** The code the worker cites. */
  evidence: FixEvidence[];
  /** Echoed identity evidence. UNVERIFIED by this op; crq revalidates it. */
  binding: FixFindingBinding;
  /** Worker-reported tool denials, verbatim. */
  denials: ToolDenial[];
  /** Worker-reported token usage, verbatim. */
  usage?: Usage;
  /** Driver-derived USD cost, when the price map knew the model. */
  costUSD?: number;
  /** OUR session-store id, when the worker reported a non-empty one. */
  sessionId?: string;
  /** Present (true) only when a composed-context cap fired. */
  truncated?: boolean;
  /** Present (true) only when the worker summary head-cap fired. */
  summaryTruncated?: boolean;
}

/** The op shape: it may add the OpResultArtifact `report` envelope. */
export type FixFindingOp = (input: FixFindingInput) => Promise<OpResultArtifact<FixFindingResult>>;

/** Fixed instruction bound, in UTF-16 code units. No user knob. */
export const MAX_FIX_FINDING_INSTRUCTIONS_CHARS = 2_000;

/** Fixed whole-request bound, in UTF-16 code units. No user knob. */
export const MAX_SERIALIZED_DISPATCH_CHARS = 32_768;

/** The injected seams (the driver factory plus retention policy). */
export interface FixFindingDeps {
  drivers: DriverFactory;
  retainSessions?: boolean;
}

/** The normalized input still carries the op-only fields the seam ignores. */
type NormalizedFixFindingInput = FixReviewItemInput & {
  binding: FixFindingBinding;
  instructions?: string;
};

/** A deterministic pre-dispatch refusal: failed with the evidence class. */
const refused = (error: string): OpResultArtifact<FixFindingResult> => ({
  status: 'failed',
  error: `fixFinding: ${error}`,
  report: { failureClass: 'evidence' } satisfies FixFindingReport,
});

/**
 * Preserve the worker's typed spend/session evidence on a non-ok report.
 * `denials` and `usage` are present whenever the driver produced a
 * WorkerResult; `costUSD`/`sessionId` only when the driver reported them.
 */
const failureReport = (
  failureClass: FixFindingFailureClass,
  worker: FixWorkerEvidence,
  errorClass?: WorkerErrorClass,
): FixFindingReport => ({
  failureClass,
  ...(errorClass !== undefined ? { errorClass } : {}),
  usage: worker.usage,
  ...(worker.costUSD !== undefined ? { costUSD: worker.costUSD } : {}),
  denials: worker.denials,
  ...(worker.sessionId !== undefined && worker.sessionId !== ''
    ? { sessionId: worker.sessionId }
    : {}),
});

/**
 * Cancellation detail per dispatch phase. The raw throwable message is
 * deliberately NOT copied: a driver may put the invocation, request text or
 * a secret in it, and the artifact is persisted by the CLI/runner.
 */
const cancelledDetail = (run: Extract<FixWorkerRun, { kind: 'cancelled' }>): string => {
  if (run.phase === 'resolve') {
    return 'fixFinding: the fix worker was cancelled before dispatch (driver resolution)';
  }
  if (run.phase === 'prompt') {
    return 'fixFinding: the fix worker was cancelled before dispatch (prompt preparation)';
  }
  return 'fixFinding: the driver run was cancelled';
};

/**
 * Pre-dispatch environment-gap reason per phase. Like the cancellation
 * detail, this is a fixed diagnostic: no raw throwable text, request content
 * or secret reaches the persisted artifact.
 */
const dispatchGapReason = (run: Extract<FixWorkerRun, { kind: 'dispatch-gap' }>): string => {
  if (run.phase === 'resolve') {
    return 'fixFinding: the fix worker could not dispatch (driver resolution failed)';
  }
  if (run.phase === 'prompt') {
    return 'fixFinding: the fix worker could not dispatch (prompt preparation failed)';
  }
  return 'fixFinding: the driver could not dispatch the worker';
};

/**
 * Map a typed driver error stop to a failure class. Mirrors crq's existing
 * `failure_class_for_stop` (rate-limit/configuration -> transient, else
 * exhausted) using ONLY the structured `errorClass`; the configuration case
 * is the dispatch-gap path, and no error prose is read.
 */
const failureClassForError = (errorClass: WorkerErrorClass | undefined): FixFindingFailureClass =>
  errorClass === 'rate-limit' ? 'transient' : 'exhausted';

/** Refuse an over-bound item body or instructions before any dispatch work. */
const boundRefusal = (input: NormalizedFixFindingInput): string | undefined => {
  if (input.item.body.length > MAX_ITEM_BODY_CHARS) {
    return `item body is ${input.item.body.length} UTF-16 units, over the fixed ${MAX_ITEM_BODY_CHARS} bound; refusing before dispatch`;
  }
  const instructions = input.instructions;
  if (instructions === undefined) return undefined;
  if (instructions.length === 0) {
    return 'instructions must be 1..2000 UTF-16 units (got 0); refusing before dispatch';
  }
  if (instructions.length > MAX_FIX_FINDING_INSTRUCTIONS_CHARS) {
    return `instructions are ${instructions.length} UTF-16 units, over the fixed ${MAX_FIX_FINDING_INSTRUCTIONS_CHARS} bound; refusing before dispatch`;
  }
  if (instructions.includes('\u0000')) {
    return 'instructions must not contain NUL; refusing before dispatch';
  }
  return undefined;
};

/**
 * Build the `review.fixFinding` op over the injected DriverFactory. The op
 * is caller-driven and does exactly one worker invocation per call, like
 * review.fixItem (I6 — no session reuse, no retries; attempt policy is the
 * caller's).
 */
export function makeFixFinding(deps: FixFindingDeps): FixFindingOp {
  return async (input: FixFindingInput) => {
    // Reuse the shared finding-item normalization rather than re-mapping.
    // The spread/identity in normalizeReviewFixInput preserves the op-only
    // `binding` and `instructions` fields, which ride the serialized bound.
    const normalized = normalizeReviewFixInput(input) as NormalizedFixFindingInput;
    const refusal = boundRefusal(normalized);
    if (refusal !== undefined) return refused(refusal);

    const run = await runFixWorker(normalized, deps, {
      ...(normalized.instructions !== undefined ? { instructions: normalized.instructions } : {}),
      // No truncated review content: prior comments ride whole, and an
      // oversized request is refused by the bound below before dispatch.
      capComments: false,
      maxSerializedChars: MAX_SERIALIZED_DISPATCH_CHARS,
      serializedInput: normalized,
    });

    if (run.kind === 'request-refused') {
      return {
        status: 'failed',
        error: `fixFinding: prepared request is ${run.serializedChars} UTF-16 units, over the fixed ${run.maxChars} dispatch budget; refusing before dispatch`,
        report: { failureClass: 'evidence' } satisfies FixFindingReport,
      };
    }
    if (run.kind === 'cancelled') {
      return {
        status: 'indeterminate',
        detail: cancelledDetail(run),
        report: { failureClass: 'transient' } satisfies FixFindingReport,
      };
    }
    if (run.kind === 'dispatch-gap') {
      return {
        status: 'needs-human',
        reason: dispatchGapReason(run),
        report: { failureClass: 'transient' } satisfies FixFindingReport,
      };
    }
    if (run.kind === 'budget') {
      return {
        status: 'budget-exhausted',
        report: failureReport('exhausted', run.worker),
      };
    }
    if (run.kind === 'aborted') {
      return {
        status: 'indeterminate',
        detail: 'fixFinding: driver aborted the run',
        report: failureReport('transient', run.worker),
      };
    }
    if (run.kind === 'error') {
      const classText = run.errorClass === undefined ? '' : `; errorClass=${run.errorClass}`;
      return {
        status: 'failed',
        // Typed class only: the driver's raw error text may contain request
        // content or a secret, and this error is persisted.
        error: `fixFinding: driver reported an error stop${classText}`,
        report: failureReport(failureClassForError(run.errorClass), run.worker, run.errorClass),
      };
    }

    const contract = run.contract;
    if (contract.kind === 'invalid') {
      return {
        status: 'failed',
        error: 'fixFinding: complete run carried no parseable fix contract',
        report: failureReport('evidence', run.worker),
      };
    }
    return {
      status: 'ok',
      value: {
        kind: contract.kind === 'outcome' ? 'outcome' : 'no-outcome',
        disposition: contract.disposition,
        evidenceMissing: contract.kind === 'no-outcome' ? contract.evidenceMissing : false,
        summary: contract.summary,
        commits: contract.commits,
        evidence: contract.evidence,
        binding: input.binding,
        denials: run.worker.denials,
        usage: run.worker.usage,
        ...(run.worker.costUSD !== undefined ? { costUSD: run.worker.costUSD } : {}),
        ...(run.worker.sessionId !== undefined && run.worker.sessionId !== ''
          ? { sessionId: run.worker.sessionId }
          : {}),
        ...(run.contextTruncated ? { truncated: true } : {}),
        ...(contract.kind === 'outcome' && contract.summaryTruncated
          ? { summaryTruncated: true }
          : {}),
      },
    };
  };
}
