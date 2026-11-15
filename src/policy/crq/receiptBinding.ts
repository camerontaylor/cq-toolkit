/**
 * Binds the receipt layer into `pr_review_findings.deliver`: `crq._checkpoint_review_identity`
 * and the three `ReceiptHooks` (`select_receipt_identity`, `prior_receipt`, `prepare`) with
 * the caller's `injected` flag, `authenticate`, identity checkpoint and run-directory files
 * closed over. Python keeps the checkpoint callable inside the meta dict; here it is a
 * separate callback, and the request comes back as a new object instead of being mutated.
 */
import { JsonObject, type JsonValue } from './jsonValue.js';
import {
  PrReviewValueError,
  type Finding,
  type GhPort,
  type ReceiptHooks,
} from './prReviewFindings.js';
import { pythonTruthy } from './repairBinding.js';
import { priorReceipt } from './receiptEvidence.js';
import { prepare, type ReceiptFiles } from './receiptPrepare.js';
import { selectReceiptIdentity } from './reviewIdentity.js';

/**
 * `_checkpoint_review_identity`: the request to persist, or null when nothing changed.
 * A differing already-selected identity is a `ValueError`; an unset one is recorded.
 */
export function checkpointReviewIdentity(
  request: JsonObject,
  login: string,
  reason: JsonValue,
): JsonObject | null {
  const selected = request.get('posting_identity');
  if (pythonTruthy(selected ?? null) && selected !== login)
    throw new PrReviewValueError('changed CRQ posting identity');
  if (selected !== null && selected !== undefined) return null;
  const next = request.entries.map(([key, value]) =>
    key === 'posting_identity'
      ? ([key, login] as const)
      : key === 'identity_reason'
        ? ([key, reason] as const)
        : ([key, value] as const),
  );
  if (!request.has('posting_identity')) next.push(['posting_identity', login]);
  if (!request.has('identity_reason')) next.push(['identity_reason', reason]);
  return new JsonObject(next);
}

const findingObject = (finding: Finding): JsonObject =>
  new JsonObject([
    ['severity', finding.severity],
    ['path', finding.path],
    ['start', finding.start],
    ['end', finding.end],
    ['title', finding.title],
    ['text', finding.text],
  ]);

export interface ReceiptBinding {
  readonly injected: boolean;
  readonly authenticate: (repo: string) => GhPort;
  /** Persists the checkpoint before any publication (`_checkpoint_review_identity` + `save_queue`). */
  readonly checkpoint?: ((login: string, reason: JsonValue) => void) | null;
  readonly files: ReceiptFiles;
  /** The review's `review.ndjson` path. */
  readonly ndjson: string;
}

export function bindReceiptHooks(binding: ReceiptBinding): ReceiptHooks {
  return {
    selectIdentity: (gh, repo, meta, login) =>
      selectReceiptIdentity({
        repo,
        meta,
        gh,
        login,
        injected: binding.injected,
        authenticate: binding.authenticate,
        checkpoint: binding.checkpoint ?? null,
      }),
    priorReceipt: (gh, repo, pr, meta, login) => priorReceipt(gh, repo, pr, meta, login),
    prepare: (gh, repo, pr, meta, findings, login) =>
      prepare(
        gh,
        binding.files,
        repo,
        pr,
        meta,
        binding.ndjson,
        findings.map(findingObject),
        login,
      ),
  };
}
