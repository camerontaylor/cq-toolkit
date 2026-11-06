/** The reserved marker used to record an independent agent review. */
export const INDEPENDENT_REVIEW_MARKER = 'cq-agent-review';

export interface IndependentReviewAttestation {
  headSha: string;
  verdict: 'PASS';
}

export type ParsedIndependentReview =
  | { kind: 'absent' }
  | { kind: 'invalid' }
  | { kind: 'valid'; attestation: IndependentReviewAttestation };

/** A word-bounded PASS, with no HOLD/FAIL verdict word and no negation ("not PASS", "isn't PASS"). */
function hasPassVerdict(body: string): boolean {
  if (!/\bPASS\b/.test(body)) return false;
  if (/\b(?:HOLD|FAIL)\b/.test(body)) return false;
  return !/(?:\bnot|n't)\s+PASS\b/i.test(body);
}

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
  if (headSha === undefined || !hasPassVerdict(body)) return { kind: 'absent' };
  return {
    kind: 'valid',
    attestation: {
      headSha,
      verdict: 'PASS',
    },
  };
}
