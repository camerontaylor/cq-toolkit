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

/**
 * The cq-review GitHub App's login. Reviewer agents post verdicts as this bot
 * (the agents repo's `cq-review-post`); it is the one bot author whose PASS
 * comments count as review evidence.
 */
export const REVIEW_APP_LOGIN = 'cq-review[bot]';

/**
 * The cq-review App as a comment author. REST reports it as `cq-review[bot]`
 * (only Apps can hold a `[bot]` login); GraphQL reports a `Bot` actor whose
 * login is `cq-review`, which a User could also register, so that form needs
 * the Bot type too.
 */
export function isReviewAppAuthor(
  authorType: string | null | undefined,
  authorLogin: string | null | undefined,
): boolean {
  return (
    authorLogin === REVIEW_APP_LOGIN ||
    (authorType === 'Bot' && authorLogin === REVIEW_APP_LOGIN.slice(0, -'[bot]'.length))
  );
}

/** An author skipped as automation: any Bot or `[bot]` login except cq-review. */
export function isIgnoredBotAuthor(
  authorType: string | null | undefined,
  authorLogin: string | null | undefined,
): boolean {
  if (isReviewAppAuthor(authorType, authorLogin)) return false;
  return authorType === 'Bot' || (authorLogin?.toLowerCase().endsWith('[bot]') ?? false);
}

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
