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

/** A word-bounded PASS, with no HOLD/FAIL/ITERATE verdict word and no negation ("not PASS", "isn't PASS"). */
function hasPassVerdict(body: string): boolean {
  if (!/\bPASS\b/.test(body)) return false;
  if (/\b(?:HOLD|FAIL|ITERATE)\b/.test(body)) return false;
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

const CRQ_HEADER =
  /^(?:(?:<!-- crq-findings run=[A-Za-z0-9._-]+ -->|<!-- crq-verdict-refresh head=[0-9a-f]{40} scan-run=[A-Za-z0-9._-]+ -->)\s*)(?:<!--[\s\S]*?-->\s*)*\*\*Independent review \(CodeRabbit CLI via crq\): (PASS|ITERATE) for `([0-9a-f]{40})`\*\*(?:\r?\n|$)/;

/** CRQ's own verdict namespace; finding text alone cannot create one. */
export function isCrqReviewBody(body: string): boolean {
  return CRQ_HEADER.test(body);
}

/** Keep only the latest CRQ verdict at this head, without changing other reviewers.
 * GitHub's complete paginated history need not arrive in chronological order.
 * Missing or conflicting equal timestamps fail closed for CRQ only.
 */
export function latestCrqReviewEvidence<T extends { body: string }>(
  evidence: readonly T[],
  head: string,
  submittedAt: (review: T) => string | null | undefined,
): T[] {
  const other: T[] = [];
  let latest: { review: T; at: number; verdict: string } | undefined;
  let invalidTime = false;
  let ambiguousLatest = false;
  for (const review of evidence) {
    const match = CRQ_HEADER.exec(review.body);
    if (match === null) {
      other.push(review);
      continue;
    }
    if (match[2] !== head.toLowerCase()) continue;
    const at = Date.parse(submittedAt(review) ?? '');
    if (!Number.isFinite(at)) {
      invalidTime = true;
      continue;
    }
    if (latest === undefined || at > latest.at) {
      latest = { review, at, verdict: match[1] ?? '' };
      ambiguousLatest = false;
    } else if (at === latest.at && latest.verdict !== match[1]) {
      ambiguousLatest = true;
    }
  }
  return latest !== undefined && !invalidTime && !ambiguousLatest
    ? [...other, latest.review]
    : other;
}
