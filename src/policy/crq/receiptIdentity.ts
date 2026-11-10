/**
 * Receipt identity used by the read-only status projection.
 *
 * This is the subset of `review_receipt` that `status_summary.merged_current`
 * needs: the content digest, `current_equivalence` and `reusable_current`.
 * It deliberately does NOT define the receipt wire contract (chunks, cursors,
 * enrollment). The A2 capability-server lane owns that port; this module can
 * be replaced by it once it lands.
 *
 * Canonical bytes are the existing receipt-canonical form from `pythonJson`
 * (ASCII, code-point-sorted keys, `(",", ":")`) so a digest here equals the
 * Python digest for the same document. Nothing here touches the filesystem,
 * the environment or a process: receipt bytes are supplied by the caller.
 */
import { MERGED_CURRENT_POLICY } from './ids.js';
import { receiptJsonDigest } from './pythonJson.js';

/** `review_receipt.VERSION`; only version 1 is countable evidence. */
export const RECEIPT_VERSION = 1;

/** `review_receipt.KIND`: the only queue kind with receipt evidence. */
export const MERGED_CURRENT_KIND = 'merged-current';

const CURRENT_PROJECTION = 'current-affected-files/full-file-addition-projection';
const CURRENT_REVIEWER = 'coderabbit-review-agent-committed-v1';
const CAPTURE_FIELDS = [
  'target',
  'tree',
  'paths',
  'scope_digest',
  'policy',
  'projection',
  'reviewer',
  'reviewer_version',
] as const;

/** A Python `ValueError` for an unsupported or incomplete capture. */
export class ReceiptIdentityError extends Error {
  override readonly name = 'ReceiptIdentityError';
  readonly pythonError = 'ValueError';

  constructor(message: string) {
    super(message);
  }
}

export type CrqRecord = Readonly<Record<string, unknown>>;

/** True for a plain JSON object (not null, not an array). */
export function isRecord(value: unknown): value is CrqRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Python `==` for JSON-shaped values.
 *
 * Numbers compare by value (so `1` equals `1.0`, as in Python), booleans also
 * compare equal to their integer value (`True == 1`), mappings ignore key
 * order and sequences keep it. Values that only Python would consider equal
 * through custom `__eq__` never appear in capture documents.
 */
export function pythonEqual(left: unknown, right: unknown): boolean {
  if (typeof left === 'boolean') return pythonEqual(Number(left), right);
  if (typeof right === 'boolean') return pythonEqual(left, Number(right));
  if (typeof left === 'number' || typeof right === 'number') {
    if (typeof left !== 'number' || typeof right !== 'number') return false;
    if (Number.isNaN(left) || Number.isNaN(right)) return false;
    return left === right;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    return left.every((value, index) => pythonEqual(value, right[index]));
  }
  if (isRecord(left) || isRecord(right)) {
    if (!isRecord(left) || !isRecord(right)) return false;
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(right, key) && pythonEqual(left[key], right[key]),
    );
  }
  return left === right;
}

/**
 * `review_receipt.current_equivalence`: exact current-content identity that is
 * independent of the request and synthetic ids.
 *
 * Raises {@link ReceiptIdentityError} for an incomplete or legacy capture.
 * Source path dispositions stay in the identity, so reuse is refused when
 * their provenance differs.
 */
export function currentEquivalence(capture: unknown): string {
  if (!isRecord(capture)) throw new ReceiptIdentityError('incomplete current capture');
  if (CAPTURE_FIELDS.some((field) => !Object.prototype.hasOwnProperty.call(capture, field))) {
    throw new ReceiptIdentityError('incomplete current capture');
  }
  for (const field of ['target', 'tree'] as const) {
    const value = capture[field];
    if (typeof value !== 'string' || !/^[0-9a-f]{40}$/.test(value)) {
      throw new ReceiptIdentityError('invalid current target/tree');
    }
  }
  const paths = capture.paths;
  const reviewerVersion = capture.reviewer_version;
  if (
    !Array.isArray(paths) ||
    capture.scope_digest !== receiptJsonDigest(paths) ||
    capture.policy !== MERGED_CURRENT_POLICY ||
    capture.projection !== CURRENT_PROJECTION ||
    capture.reviewer !== CURRENT_REVIEWER ||
    typeof reviewerVersion !== 'string' ||
    reviewerVersion.length === 0
  ) {
    throw new ReceiptIdentityError('unsupported current scope/policy/reviewer');
  }
  const identity: Record<string, unknown> = {};
  for (const field of CAPTURE_FIELDS) identity[field] = capture[field];
  return receiptJsonDigest(identity);
}

/**
 * `review_receipt.reusable_current`: countable equivalent v1 current-only
 * evidence. It is a semantic predicate, not an integrity or authorization
 * check; the caller still verifies the retained receipt bytes.
 */
export function reusableCurrent(document: unknown, capture: unknown): boolean {
  try {
    if (!isRecord(document)) return false;
    const wanted = currentEquivalence(capture);
    const retained = currentEquivalence(document.capture);
    const classification = document.classification;
    const retainedCapture = document.capture;
    return (
      document.version === RECEIPT_VERSION &&
      wanted === retained &&
      isRecord(retainedCapture) &&
      retainedCapture.equivalence === retained &&
      document.counted === true &&
      isRecord(classification) &&
      classification.counted === true &&
      classification.outcome === 'completed' &&
      (document.outcome === 'terminal-clean' ||
        document.outcome === 'terminal-with-findings' ||
        document.outcome === 'partial-scope')
    );
  } catch (error) {
    if (error instanceof ReceiptIdentityError) return false;
    throw error;
  }
}
