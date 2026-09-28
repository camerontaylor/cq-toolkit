/** The reserved marker used to record an independent agent review. */
export const INDEPENDENT_REVIEW_MARKER = 'cq-agent-review';
export const ALLOW_SAME_ACCOUNT_AGENT_REVIEW_ENV = 'CQ_MERGE_ALLOW_SAME_ACCOUNT_AGENT_REVIEW';

export interface IndependentReviewAttestation {
  version: 1;
  reviewerAgentId: string;
  authorAgentId: string;
  headSha: string;
  verdict: 'PASS' | 'HOLD' | 'RETRACT';
  independent: true;
}

export type ParsedIndependentReview =
  | { kind: 'absent' }
  | { kind: 'invalid' }
  | { kind: 'valid'; attestation: IndependentReviewAttestation };

const SHA_RE = /^[0-9a-f]{40}$/i;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MARKER_RE = /<!--\s*cq-agent-review\b[\s\S]*?-->/g;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Parse exactly one strict marker; malformed or duplicate markers fail closed. */
export function parseIndependentReview(body: string): ParsedIndependentReview {
  const prefixes = [...body.matchAll(/<!--\s*cq-agent-review\b/g)];
  if (prefixes.length === 0) return { kind: 'absent' };
  const comments = [...body.matchAll(MARKER_RE)];
  if (comments.length !== 1 || prefixes.length !== 1) return { kind: 'invalid' };
  const comment = comments[0]?.[0];
  if (comment === undefined) return { kind: 'invalid' };
  const match = /^<!--\s*cq-agent-review:\s*(\{[\s\S]*\})\s*-->$/.exec(comment);
  if (match?.[1] === undefined) return { kind: 'invalid' };
  let value: unknown;
  try {
    value = JSON.parse(match[1]);
  } catch {
    return { kind: 'invalid' };
  }
  if (!isRecord(value)) return { kind: 'invalid' };
  const keys = Object.keys(value).sort();
  const expectedKeys = [
    'authorAgentId',
    'headSha',
    'independent',
    'reviewerAgentId',
    'verdict',
    'version',
  ];
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index])
  ) {
    return { kind: 'invalid' };
  }
  const { version, reviewerAgentId, authorAgentId, headSha, verdict, independent } = value;
  if (
    version !== 1 ||
    typeof reviewerAgentId !== 'string' ||
    !ID_RE.test(reviewerAgentId) ||
    typeof authorAgentId !== 'string' ||
    !ID_RE.test(authorAgentId) ||
    reviewerAgentId === authorAgentId ||
    typeof headSha !== 'string' ||
    !SHA_RE.test(headSha) ||
    (verdict !== 'PASS' && verdict !== 'HOLD' && verdict !== 'RETRACT') ||
    independent !== true
  ) {
    return { kind: 'invalid' };
  }
  return {
    kind: 'valid',
    attestation: { version, reviewerAgentId, authorAgentId, headSha, verdict, independent },
  };
}

/** Strict optional boolean env value; blank means false. */
export function parseSameAccountReviewFlag(value: string | undefined, key: string): boolean {
  const normalized = value?.trim() ?? '';
  if (normalized === '' || normalized === 'false') return false;
  if (normalized === 'true') return true;
  throw new Error(`${key}: expected true or false`);
}
