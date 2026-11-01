/** The reserved marker used to record an independent agent review. */
export const INDEPENDENT_REVIEW_MARKER = 'cq-agent-review';
export const ALLOW_SAME_ACCOUNT_AGENT_REVIEW_ENV = 'CQ_MERGE_ALLOW_SAME_ACCOUNT_AGENT_REVIEW';

export interface IndependentReviewAttestation {
  headSha: string;
  verdict: 'PASS';
}

export type ParsedIndependentReview =
  | { kind: 'absent' }
  | { kind: 'invalid' }
  | { kind: 'valid'; attestation: IndependentReviewAttestation };

/** A plain comment containing a full head SHA and PASS is review evidence.
 * The merging agent judges independence; comment formatting is not a gate.
 */
export function parseIndependentReview(
  body: string,
  expectedHead?: string,
): ParsedIndependentReview {
  const headSha =
    expectedHead === undefined
      ? body.match(/\b[0-9a-f]{40}\b/i)?.[0]
      : body
          .match(/\b[0-9a-f]{40}\b/gi)
          ?.find((sha) => sha.toLowerCase() === expectedHead.toLowerCase());
  if (headSha === undefined || !body.includes('PASS')) return { kind: 'absent' };
  return {
    kind: 'valid',
    attestation: {
      headSha,
      verdict: 'PASS',
    },
  };
}

/** Strict optional boolean env value; blank means false. */
export function parseSameAccountReviewFlag(value: string | undefined, key: string): boolean {
  const normalized = value?.trim() ?? '';
  if (normalized === '' || normalized === 'false') return false;
  if (normalized === 'true') return true;
  throw new Error(`${key}: expected true or false`);
}
