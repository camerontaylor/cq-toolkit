/**
 * crq identifiers and content digests.
 *
 * The IDs are derived from the same canonical bytes as the Python writers:
 *
 * - `current-<digest[:32]>` is `review_receipt.enroll`'s merged-current item id,
 *   hashed over `{repo, pr, merge_sha, target_selector, policy}` with receipt
 *   (ASCII, code-point-sorted) canonical JSON.
 * - `<item>-<YYYYMMDDTHHMMSSZ>` is `crq.launch`'s run id.
 * - `crq-<run>-F<n>` is `repair_tick`'s repair job id.
 * - `crq-backfill-<key>` is `finding_delivery`'s backfill job id.
 *
 * Validation schemas stay separate from policy item-id grammar: the phase 0.2
 * queue schema admits every historical item id, so only the common digest/sha
 * and request/repository grammars are asserted here.
 */
import { z } from 'zod';
import {
  ledgerJsonDigest,
  receiptJsonDigest,
  sha256Hex,
  type PythonJsonInput,
} from './pythonJson.js';
import { compactUtc, utcFromMillis, UtcInstant } from './utc.js';

export const CrqSha40 = z.string().regex(/^[0-9a-f]{40}$/);
export const CrqDigest64 = z.string().regex(/^[0-9a-f]{64}$/);
export const CrqRequestId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/);
export const CrqRepository = z.string().regex(/^[\p{L}\p{N}_.-]+\/[\p{L}\p{N}_.-]+$/u);
export const CrqTargetSelector = z.enum(['promoted-main', 'merge-queue']);

export type CrqTargetSelector = z.infer<typeof CrqTargetSelector>;

/** `review_receipt.POLICY`: the only current-scope policy this port ships. */
export const MERGED_CURRENT_POLICY = 'affected-current-additions-v1';

export interface MergedCurrentBindingInput {
  readonly repo: string;
  readonly pr: number;
  readonly merge_sha: string;
  readonly target_selector: CrqTargetSelector;
}

/** SHA-256 of the receipt-canonical bytes, lowercase hex. */
export function receiptDigest(value: PythonJsonInput): string {
  return receiptJsonDigest(value);
}

/** SHA-256 of the ledger-canonical bytes, lowercase hex. */
export function ledgerDigest(value: PythonJsonInput): string {
  return ledgerJsonDigest(value);
}

/** SHA-256 of arbitrary bytes, lowercase hex. */
export function contentDigest(bytes: Uint8Array): string {
  return sha256Hex(bytes);
}

/**
 * `review_receipt.enroll`'s merged-current item id.
 *
 * The caller must have verified forge provenance and the merge SHA before
 * deriving the id; this function only binds the documented fields.
 */
export function currentItemId(binding: MergedCurrentBindingInput): string {
  CrqRepository.parse(binding.repo);
  if (!Number.isInteger(binding.pr) || binding.pr <= 0) {
    throw new Error('merged-current binding requires a positive integer PR');
  }
  CrqSha40.parse(binding.merge_sha);
  CrqTargetSelector.parse(binding.target_selector);
  const digest = receiptDigest({
    repo: binding.repo,
    pr: binding.pr,
    merge_sha: binding.merge_sha,
    target_selector: binding.target_selector,
    policy: MERGED_CURRENT_POLICY,
  });
  return `current-${digest.slice(0, 32)}`;
}

/** `crq.launch`'s run id: `<item id>-<compact UTC launch time>`. */
export function reviewRunId(itemId: string, at: UtcInstant | Date | number): string {
  if (itemId.length === 0) throw new Error('run id requires a non-empty item id');
  return `${itemId}-${compactUtc(toInstant(at))}`;
}

/** `repair_tick`'s repair job id. */
export function repairJobId(runId: string, findingNumber = 1): string {
  if (runId.length === 0) throw new Error('repair job id requires a non-empty run id');
  if (!Number.isInteger(findingNumber) || findingNumber < 1) {
    throw new Error('repair finding number must be a positive integer');
  }
  return `crq-${runId}-F${String(findingNumber)}`;
}

/** `finding_delivery`'s backfill job id. */
export function backfillJobId(key: string): string {
  if (key.length === 0) throw new Error('backfill job id requires a non-empty key');
  return `crq-backfill-${key}`;
}

/**
 * `finding_delivery`'s delivery key: the canonical finding id, or the ledger
 * digest of canonical id + confirmation event when a confirmation is present.
 */
export function findingDeliveryKey(canonicalId: string, confirmationId?: string | null): string {
  CrqDigest64.parse(canonicalId);
  if (confirmationId === undefined || confirmationId === null) return canonicalId;
  CrqDigest64.parse(confirmationId);
  return ledgerDigest({ canonical: canonicalId, confirmation: confirmationId });
}

function toInstant(at: UtcInstant | Date | number): UtcInstant {
  if (at instanceof UtcInstant) return at;
  if (at instanceof Date) return utcFromMillis(at.getTime());
  return utcFromMillis(at);
}
