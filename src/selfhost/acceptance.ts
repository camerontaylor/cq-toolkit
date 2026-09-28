// selfhost/acceptance — the I2 ACCEPTANCE judgment behind the `cq/acceptance`
// check (task W1.10, methods Decisions 10–11; ADR-0004 D-B row "I2
// acceptance": `cq-accept` runs over API reads only). Composition glue over
// the RS-3 rules in merge-recheck.ts, READ-ONLY: no settle ledger, no
// writes, no merge — the same snapshot, the same order, the same refusal
// wording as the merger's recheckOrThrow, minus what a read-only check
// cannot or must not judge.
//
// WHAT IS JUDGED, in recheckOrThrow's order: the PR's state (open for a PR
// check; closed when the promotion gate re-judges an already-merged PR at
// its merged head — the caller verifies merged-ness itself via REST), draft,
// a truncated snapshot, the head (bound to the 40-hex subject the verdict
// names), the base branch NAME, the I11 REST lag cross-check
// (checkReviewDataLag), unresolved external review threads (root author ≠
// the PR author, classify row 5's count), and head-bound trusted acceptance
// with no outstanding trusted objection (judgeAtHead).
//
// WHAT IS NOT. Settle stays in the merger's recheck: its durable
// observation is a ledger WRITE (contents: write), which this check never
// holds. Mergeability / merge state is not judged either: a required
// `cq/acceptance` keeps GitHub's merge state BLOCKED until it posts, so a
// mergeability row would be circular.
//
// TRUST (P7: built-in default → project env). The trust set comes from
// three comma-list keys plus CQ_MERGE_ALLOW_SAME_ACCOUNT_AGENT_REVIEW;
// blank (absent, empty or whitespace-only) is the conservative default — no
// bots, APPROVED only, OWNER/MEMBER/COLLABORATOR users, same-account markers
// disabled. Values map through trustPolicyFromConfig, so config
// ordinarily only NARROW the blanks; the explicit structured agent-review
// option permits a valid same-account attestation. Structural identities stay
// excluded even when listed as trusted bots. An unrecognised entry fails
// LOUDLY (a throw naming the key): a typo must never silently narrow or
// widen ordinary review trust. The PR author counts only through that opt-in.
//
// NEVER THROWS (judgeAcceptance): every throw becomes verdict 'fail' with a
// one-line, capped, log-safe reason. Report lines carry counts, actor keys
// and reasons — never review bodies or tokens.
import { pathToFileURL } from 'node:url';
import { GhError, ghNameOk, makeGhRunner } from '../ops/review/gh.js';
import type { GhFn } from '../ops/review/gh.js';
import { countUnresolvedThreads } from '../ops/review/threads.js';
import type { ReviewThread } from '../ops/review/threads.js';
import {
  checkReviewDataLag,
  fetchPrSnapshot,
  judgeAtHead,
  trustPolicyFromConfig,
} from './merge-recheck.js';
import type { PrSnapshot, SnapshotThread, TrustPolicy } from './merge-recheck.js';
import {
  ALLOW_SAME_ACCOUNT_AGENT_REVIEW_ENV,
  parseSameAccountReviewFlag,
} from '../shared/independent-review.js';

/** The check-run name the verdict posts under. */
export const ACCEPTANCE_CHECK_NAME = 'cq/acceptance';

/** P7 key: trusted bot logins (comma list); blank → no bots. */
export const TRUSTED_BOTS_ENV = 'CQ_MERGE_TRUSTED_BOTS';

/** P7 key: review states that accept (comma list); blank → APPROVED only. */
export const ACCEPT_REVIEW_STATES_ENV = 'CQ_MERGE_ACCEPT_REVIEW_STATES';

/** P7 key: trusted user associations (comma list); blank → OWNER, MEMBER, COLLABORATOR. */
export const TRUSTED_ASSOCIATIONS_ENV = 'CQ_MERGE_TRUSTED_ASSOCIATIONS';
export { ALLOW_SAME_ACCOUNT_AGENT_REVIEW_ENV };

/** Where a resolved trust key came from (P7 layering). */
export type ConfigLayer = 'default' | 'env';

/** resolveAcceptanceTrust's answer. */
export interface AcceptanceTrustConfig {
  /** The trust set judgeAtHead applies. */
  policy: TrustPolicy;
  /** The layer each key resolved from. */
  layers: {
    trustedBots: ConfigLayer;
    acceptReviewStates: ConfigLayer;
    trustedAssociations: ConfigLayer;
    allowSameAccountAgentReview: ConfigLayer;
  };
  /** One log line per key: `<ENV_KEY>=<resolved value> (<layer>)`. */
  report: string[];
}

/** A GitHub login, optionally `[bot]`-suffixed — the only bot entry shape accepted. */
const BOT_ENTRY_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\[bot\])?$/;
const ACCEPT_STATES: readonly string[] = ['APPROVED', 'COMMENTED'];
const ASSOCIATIONS: readonly string[] = ['OWNER', 'MEMBER', 'COLLABORATOR'];

/**
 * One P7 comma-list key: entries trimmed, empties dropped, every entry
 * checked by `valid` (a throw naming the key on the first bad one). A key
 * with no entries (absent, blank, whitespace-only, or only commas) resolves
 * from the 'default' layer.
 */
const readListKey = (
  env: Readonly<Record<string, string | undefined>>,
  key: string,
  valid: (entry: string) => boolean,
  expected: string,
): { entries: string[]; layer: ConfigLayer } => {
  const entries = (env[key] ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  const bad = entries.find((entry) => !valid(entry));
  if (bad !== undefined) {
    throw new Error(
      `${key}: unrecognised entry ${JSON.stringify(bad)} (expected ${expected}; comma-separated)`,
    );
  }
  return { entries, layer: entries.length === 0 ? 'default' : 'env' };
};

/** A resolved set for a log line: sorted, comma-joined; '(none)' when empty. */
const listed = (values: Iterable<string>): string => [...values].sort().join(',') || '(none)';

/**
 * Resolve the acceptance trust set from the P7 keys in `env` (built-in
 * default → project env; blank or whitespace-only = the conservative
 * default). Entries are trimmed and empties dropped, then mapped through
 * trustPolicyFromConfig — which drops a trusted bot naming a structural
 * automation identity. THROWS, naming the key, on an unrecognised entry: an
 * accept state other than APPROVED/COMMENTED (case-insensitive), an
 * association other than OWNER/MEMBER/COLLABORATOR (case-insensitive), or
 * a bot entry that is not a login (optionally `[bot]`-suffixed).
 */
export function resolveAcceptanceTrust(
  env: Readonly<Record<string, string | undefined>>,
): AcceptanceTrustConfig {
  const bots = readListKey(
    env,
    TRUSTED_BOTS_ENV,
    (entry) => BOT_ENTRY_RE.test(entry),
    'a login such as coderabbitai[bot]',
  );
  const states = readListKey(
    env,
    ACCEPT_REVIEW_STATES_ENV,
    (entry) => ACCEPT_STATES.includes(entry.toUpperCase()),
    ACCEPT_STATES.join(' or '),
  );
  const associations = readListKey(
    env,
    TRUSTED_ASSOCIATIONS_ENV,
    (entry) => ASSOCIATIONS.includes(entry.toUpperCase()),
    ASSOCIATIONS.join(', '),
  );
  const allowSameAccountAgentReview = parseSameAccountReviewFlag(
    env[ALLOW_SAME_ACCOUNT_AGENT_REVIEW_ENV],
    ALLOW_SAME_ACCOUNT_AGENT_REVIEW_ENV,
  );
  const policy = trustPolicyFromConfig({
    trustedBots: bots.entries,
    acceptReviewStates: states.entries,
    trustedAssociations: associations.entries,
    allowSameAccountAgentReview,
  });
  return {
    policy,
    layers: {
      trustedBots: bots.layer,
      acceptReviewStates: states.layer,
      trustedAssociations: associations.layer,
      allowSameAccountAgentReview: env[ALLOW_SAME_ACCOUNT_AGENT_REVIEW_ENV]?.trim()
        ? 'env'
        : 'default',
    },
    report: [
      `${TRUSTED_BOTS_ENV}=${listed(policy.trustedBots)} (${bots.layer})`,
      `${ACCEPT_REVIEW_STATES_ENV}=${listed(policy.acceptStates)} (${states.layer})`,
      `${TRUSTED_ASSOCIATIONS_ENV}=${listed(policy.trustedAssociations)} (${associations.layer})`,
      `${ALLOW_SAME_ACCOUNT_AGENT_REVIEW_ENV}=${String(policy.allowSameAccountAgentReview)} (${env[ALLOW_SAME_ACCOUNT_AGENT_REVIEW_ENV]?.trim() ? 'env' : 'default'})`,
    ],
  };
}

/** What one acceptance judgment is asked. */
export interface AcceptanceInput {
  pr: number;
  /** The 40-hex head the verdict is bound to. */
  subject: string;
  /** The PR's required base branch name (normally 'merge-queue'). */
  base: string;
  /** 'open' for a PR check; 'merged' when the promotion gate re-judges an already-merged PR at its merged head. */
  state: 'open' | 'merged';
}

/** judgeAcceptance's verdict. */
export interface AcceptanceResult {
  verdict: 'pass' | 'fail';
  pr: number;
  subject: string;
  /** Actor keys whose head-bound acceptance counted (empty on fail). */
  acceptedBy: string[];
  /** Log-safe lines (counts, actor keys, reasons — never review bodies). */
  report: string[];
}

/** judgeAcceptance's seams: a read-only gh transport and the trust set. */
export interface AcceptanceDeps {
  gh: GhFn;
  owner: string;
  repo: string;
  policy: TrustPolicy;
}

/** Reason cap: a reason is a log fact, not an error dump (merge-recheck's cap). */
const REASON_MAX = 500;

const SHA_RE = /^[0-9a-f]{40}$/i;

/** First line of a message, capped. */
const oneLine = (text: string): string => {
  const line = text.split('\n', 1)[0] ?? '';
  return line.length > REASON_MAX ? line.slice(0, REASON_MAX) : line;
};

/** Any throwable → one capped line (gh failures keep exit code + stderr). */
const describeError = (error: unknown): string =>
  error instanceof GhError
    ? `gh exit ${String(error.code)}: ${oneLine(error.stderr.trim() === '' ? error.message : error.stderr)}`
    : oneLine(error instanceof Error ? error.message : String(error));

/** A snapshot thread in the shared vocabulary (only the rule-read fields are real). */
const asReviewThread = (thread: SnapshotThread): ReviewThread => ({
  id: '',
  rootDatabaseId: thread.rootDatabaseId,
  path: null,
  line: null,
  isResolved: thread.isResolved,
  isOutdated: false,
  authorLogin: thread.rootAuthorLogin,
  createdAt: null,
  body: '',
  replies: [],
});

/** The trust set as one log-safe line. */
const trustSummary = (policy: TrustPolicy): string =>
  `trust: bots=${listed(policy.trustedBots)} acceptStates=${listed(policy.acceptStates)} associations=${listed(policy.trustedAssociations)} sameAccountAgentReview=${String(policy.allowSameAccountAgentReview === true)} excluded=${String(policy.excludedLogins.size)}`;

/** A failed rule: its name and the one-line reason. */
interface RuleFailure {
  rule: string;
  reason: string;
}

/**
 * The judgment body over a fetched snapshot, in recheckOrThrow's order
 * (settle and the base pin/protected-branch rows excluded — see the module
 * doc). Returns the failed rule, or the accepting actor keys.
 */
const judgeSnapshot = async (
  deps: AcceptanceDeps,
  input: AcceptanceInput,
  subject: string,
  snapshot: PrSnapshot,
): Promise<RuleFailure | { by: string[] }> => {
  if (input.state === 'open' && !snapshot.open) return { rule: 'state', reason: 'pr is not open' };
  if (input.state === 'merged' && snapshot.open) {
    return { rule: 'state', reason: 'pr is still open (expected merged)' };
  }
  if (snapshot.draft) return { rule: 'draft', reason: 'pr is a draft' };
  if (snapshot.truncated) {
    return {
      rule: 'truncated',
      reason:
        'snapshot truncated: reviews, review threads or force-push timeline incomplete, or the pr moved mid-read',
    };
  }
  if (snapshot.headRefOid !== subject) {
    return {
      rule: 'head',
      reason: `head moved: expected ${subject} but the forge reports ${snapshot.headRefOid ?? 'no valid head oid'}`,
    };
  }
  if (snapshot.baseRefName === null) return { rule: 'base', reason: 'base name unavailable' };
  if (snapshot.baseRefName !== input.base) {
    return {
      rule: 'base',
      reason: `wrong base: required ${input.base} but the forge reports ${snapshot.baseRefName}`,
    };
  }
  const lag = await checkReviewDataLag(deps, input.pr, snapshot);
  if (lag !== null) return { rule: 'lag', reason: lag };
  const unresolved = countUnresolvedThreads(snapshot.threads.map(asReviewThread), {
    excludeAuthorLogin: snapshot.authorLogin,
  });
  if (unresolved > 0) {
    return { rule: 'threads', reason: `unresolved external threads: ${String(unresolved)}` };
  }
  const judgment = judgeAtHead(snapshot, subject, deps.policy);
  if (!judgment.accepted) {
    return { rule: 'acceptance', reason: `${judgment.reason}: ${judgment.detail}` };
  }
  return { by: judgment.by };
};

/**
 * Judge I2 acceptance for PR `input.pr` bound to `input.subject`, read-only:
 * validate the input (40-hex subject, positive safe-integer pr, a base name,
 * a known state), fetch the snapshot, then fail on — in order — the wrong
 * PR state, draft, truncated, head ≠ subject, base name ≠ `input.base`, the
 * I11 REST lag cross-check, unresolved external threads, and no head-bound
 * trusted acceptance or an outstanding trusted objection. Pass carries
 * `acceptedBy` (judgeAtHead's actor keys). The report opens with the PR,
 * the subject and the trust summary, then `fail (<rule>): <reason>` or
 * `pass: accepted by …`.
 * Never throws: any throw becomes verdict 'fail' with a one-line capped reason.
 */
export async function judgeAcceptance(
  deps: AcceptanceDeps,
  input: AcceptanceInput,
): Promise<AcceptanceResult> {
  const subject = typeof input.subject === 'string' ? input.subject.toLowerCase() : '';
  const report: string[] = [];
  const fail = (rule: string, reason: string): AcceptanceResult => {
    report.push(`fail (${rule}): ${oneLine(reason)}`);
    return { verdict: 'fail', pr: input.pr, subject, acceptedBy: [], report };
  };
  try {
    report.push(
      `pr #${String(input.pr)} subject ${subject} base ${String(input.base)} state ${String(input.state)}`,
    );
    report.push(trustSummary(deps.policy));
    if (!Number.isSafeInteger(input.pr) || input.pr <= 0) {
      return fail('input', `pr must be a positive safe integer — got ${String(input.pr)}`);
    }
    if (!SHA_RE.test(subject)) return fail('input', 'subject is not a 40-hex commit sha');
    if (typeof input.base !== 'string' || input.base === '') {
      return fail('input', 'no required base branch name');
    }
    if (input.state !== 'open' && input.state !== 'merged') {
      return fail('input', `state must be open or merged — got ${String(input.state)}`);
    }
    let snapshot: PrSnapshot;
    try {
      snapshot = await fetchPrSnapshot(deps, input.pr);
    } catch (error) {
      return fail('fetch', `acceptance fetch failed: ${describeError(error)}`);
    }
    report.push(
      `snapshot: reviews=${String(snapshot.reviews.length)} threads=${String(snapshot.threads.length)}`,
    );
    const outcome = await judgeSnapshot(deps, input, subject, snapshot);
    if ('rule' in outcome) return fail(outcome.rule, outcome.reason);
    report.push(`pass: accepted by ${outcome.by.join(', ')}`);
    return { verdict: 'pass', pr: input.pr, subject, acceptedBy: outcome.by, report };
  } catch (error) {
    return fail('error', `acceptance failed: ${describeError(error)}`);
  }
}

// -- the CLI entry ------------------------------------------------------------

/** parseAcceptanceArgs's answer: the coordinates and the judgment input. */
export interface AcceptanceArgs {
  owner: string;
  repo: string;
  input: AcceptanceInput;
}

const FLAGS: readonly string[] = ['repository', 'pr', 'subject', 'base', 'state'];

/**
 * Strict `--name=value` parsing for the CLI entry: `--repository=<owner>/<name>`,
 * `--pr=<n>` and `--subject=<40-hex>` are required; `--base` defaults to
 * 'merge-queue' and `--state` (open|merged) to 'open'. THROWS on an unknown,
 * repeated, value-less or malformed flag, or a positional argument. Pure.
 */
export function parseAcceptanceArgs(argv: readonly string[]): AcceptanceArgs {
  const values = new Map<string, string>();
  for (const arg of argv) {
    const match = /^--([a-z]+)=(.*)$/s.exec(arg);
    const name = match?.[1];
    const value = match?.[2];
    if (name === undefined || value === undefined || !FLAGS.includes(name)) {
      throw new Error(
        `unknown argument ${JSON.stringify(arg)} (expected --${FLAGS.join('=, --')}=)`,
      );
    }
    if (values.has(name)) throw new Error(`--${name} given more than once`);
    if (value === '') throw new Error(`--${name} needs a value`);
    values.set(name, value);
  }
  const repository = values.get('repository') ?? '';
  const [owner = '', repo = '', ...extra] = repository.split('/');
  if (extra.length > 0 || !ghNameOk(owner) || !ghNameOk(repo)) {
    throw new Error(`--repository must be <owner>/<name> — got ${JSON.stringify(repository)}`);
  }
  const prRaw = values.get('pr') ?? '';
  const pr = /^[1-9][0-9]*$/.test(prRaw) ? Number(prRaw) : Number.NaN;
  if (!Number.isSafeInteger(pr)) {
    throw new Error(`--pr must be a positive integer — got ${JSON.stringify(prRaw)}`);
  }
  const subject = values.get('subject') ?? '';
  if (!SHA_RE.test(subject)) {
    throw new Error(`--subject must be a 40-hex commit sha — got ${JSON.stringify(subject)}`);
  }
  const state = values.get('state') ?? 'open';
  if (state !== 'open' && state !== 'merged') {
    throw new Error(`--state must be open or merged — got ${JSON.stringify(state)}`);
  }
  return {
    owner,
    repo,
    input: { pr, subject: subject.toLowerCase(), base: values.get('base') ?? 'merge-queue', state },
  };
}

/**
 * The CLI entry: parse args, resolve the trust set from the environment,
 * judge over the real gh runner (GH_TOKEN, read-only, is gh's own), and
 * print ONE JSON line. A verdict — pass or fail — is `status: ok` at exit 0;
 * only bad args or a bad trust config are `status: failed` at exit 1.
 */
async function main(): Promise<void> {
  let line: string;
  try {
    const args = parseAcceptanceArgs(process.argv.slice(2));
    const trust = resolveAcceptanceTrust(process.env);
    const result = await judgeAcceptance(
      { gh: makeGhRunner(), owner: args.owner, repo: args.repo, policy: trust.policy },
      args.input,
    );
    line = JSON.stringify({ status: 'ok', value: { ...result, trust: trust.report } });
  } catch (error) {
    line = JSON.stringify({ status: 'failed', error: describeError(error) });
    process.exitCode = 1;
  }
  process.stdout.write(`${line}\n`);
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) await main();
