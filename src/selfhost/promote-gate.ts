// selfhost/promote-gate — the PROMOTION GATE's decision (task W1.10, ADR-0004
// D-K; methods note Decisions 1, 5, 7, 12, 13): whether the `merge-queue` tip
// may fast-forward `main`, and — with `--push` — the atomic promotion itself.
// `gate.yml`'s `decide` job (environment `promote`, sole member of concurrency
// group `promote`) runs it from the TRUST checkout.
//
// TRUST (P1). Everything that judges is the DEFAULT BRANCH's definition: this
// module, built from the trust checkout (`github.sha` on the default branch),
// and the trust ref's lists (protected paths, ratchet definitions). The gate
// RESOLVES ITS OWN SUBJECT — `tip` and `main` come from the refs API, never
// from an event payload, a PR artifact or a workflow input — and, when there
// is something to promote, refuses unless that `main` IS the trust ref (a run
// queued behind an earlier promotion would otherwise judge the new main with
// the old definitions), and it runs NO
// HEAD CODE: the queue tip is only git objects (read with the hardened
// no-shell helpers in ../ops/ratchet/git.ts, #221) and API data. Every read
// uses the job's own read-only GITHUB_TOKEN (gh reads GH_TOKEN). The
// promotion credential (CQ_PROMOTE_TOKEN: the promoter-App installation token
// minted when `vars.CQ_PROMOTER_APP_CLIENT_ID` is set — paired with
// `vars.CQ_PROMOTER_APP_ID`, gate.yml refuses exactly one of the two — else
// the interim PAT) is removed from the process env at startup and reaches
// exactly one place: the atomic push's step-scoped GIT_CONFIG_* extra-header.
// It is never logged.
//
// THE CHECKS (cheap and pure first, the waits last; every refusal is final
// for this run — the next sweep retries — and every check's outcome is
// reported):
//   1. subject: tip/main from the API; both objects present locally; the
//      fetched remote-tracking refs still equal the API values.
//   2. ancestry: tip == main or tip ⊑ main → noop (git objects only, so it
//      is decided before the trust-ref test); otherwise main equals the
//      trust ref (a run queued behind an earlier promotion trails main and
//      refuses: its code and definitions are not main's); main ⋢ tip →
//      diverged.
//   3. closure over main..tip (checkClosure): every first-parent commit is
//      the recorded merge of exactly one merged same-repo PR into
//      `merge-queue` whose final head is the merge's second parent; every
//      other commit is reachable from such a head. A direct push, an octopus,
//      a merge with no/ambiguous PR, or a commit reachable only through an
//      unadmitted path refuses.
//   4. clean merges: each first-parent merge's tree equals `git merge-tree
//      --write-tree` of its parents (no evil or conflict-resolving merge).
//   5. I2's EVIDENCE rows recomputed per admitted PR at its merged head
//      (head-bound trusted acceptance, no outstanding trusted objection, no
//      unresolved external threads, the I11 lag cross-check). I2's SETTLE
//      half (≥10 min since the head, or an all-clear postdating it) is NOT
//      judged here: only the merger's recheck (self-merge-prs,
//      merge-recheck.ts) enforces it, so a PR hand-merged into
//      `merge-queue` skips settle (methods-w1-10 Residuals; C2 owns it).
//   6. gates.policyDiff recomputed in-process over main..tip (push subject);
//      fail/needs-human refuses — D11 records are dormant until the C3
//      attestation, so a protected-path change promotes only by owner
//      break-glass (ADR-0004 D-G.4, D-H.4).
//   7. each admitted PR's `cq-override` record is LOGGED (never decisive).
//   8. a valid `cq/ratchet` verdict on tip bound to main (selectVerdict:
//      verdict-App numeric id, or the interim slug + binding + "the
//      default-branch cq-verify ran at main" form), waited for —
//      dispatching cq-verify once when none is bound to main.
//   9. the block-only head-defined runs (checkVerifiedRun, D-F.2) green: the
//      newest `merge-queue` push run of each on the tip.
//  10. promote: step 5 re-run first (a dismissal, new objection or newly
//      unresolved thread during the wait moves no ref, so the leases would
//      not catch it; any change refuses), then one no-wait re-read of steps
//      8–9 (pass 2 can itself take minutes), then `push --atomic` of tip
//      onto main — leased on the (main, tip) read at step 1, never a plain
//      force. One `ls-remote` right before the push re-reads the queue on
//      the push's own transport: still the tip (the normal case) → only
//      main is sent (D-K.6 by construction); moved → the merge-queue
//      refspec rides along as a pure lease whose failure refuses the whole
//      push, so a break-glass rewind is never re-promoted.
import { pathToFileURL } from 'node:url';
import type { OpResult } from '../kernel/types.js';
import {
  evaluateOverrideLabel,
  formatOverride,
  type OverrideEvaluation,
} from '../ops/gates/overrideRecord.js';
import { resolveProtectedPathsConfig } from '../ops/gates/policyConfig.js';
import {
  createPolicyDiff,
  type PolicyDiffInput,
  type PolicyDiffOutcome,
} from '../ops/gates/policyDiff.js';
import {
  gitFirstParentRange,
  gitIsAncestor,
  gitLsRemoteRef,
  gitMergeTreeClean,
  gitPushAtomic,
  gitRangeCommits,
  gitRevParse,
  gitTreeOf,
  type LeasedUpdate,
  type RangeCommit,
} from '../ops/ratchet/git.js';
import { GhError, ghJson, ghNameOk, makeGhRunner, slurpedComments } from '../ops/review/gh.js';
import type { GhFn } from '../ops/review/gh.js';
import {
  judgeAcceptance,
  resolveAcceptanceTrust,
  type AcceptanceInput,
  type AcceptanceResult,
} from './acceptance.js';

/** The branch promotion advances. */
export const MAIN_BRANCH = 'main';

/** The queue branch whose tip is promoted. */
export const QUEUE_BRANCH = 'merge-queue';

/** The promotion-review status context the gate trusts (PR-C). */
export const PROMOTION_REVIEW_CONTEXT = 'crq/promotion-review';

/**
 * Banned reviewer identities (PR-B's provenance incident): the stranger's
 * public App that once sat in the pin. A paste of either into the gate
 * config fails closed — never pinned, trusted or excluded.
 */
export const BANNED_REVIEWER_LOGINS: readonly string[] = ['cq-reviewer[bot]'];
export const BANNED_REVIEWER_IDS: readonly number[] = [202921479];

/** The verdict check the gate requires on the tip. */
export const VERDICT_CHECK = 'cq/ratchet';

/** The workflow that posts the verdict (dispatched once when none is bound to main). */
export const VERIFY_WORKFLOW = 'cq-verify.yml';

/** The workflow whose push run cq-verify consumes. */
export const MEASURE_WORKFLOW = 'cq-measure.yml';

/** The interim verdict poster's app slug (until the verdict App, C2). */
export const INTERIM_VERDICT_SLUG = 'github-actions';

/** The default block-only head-defined workflows (D-F.2). */
export const DEFAULT_VERIFIED_WORKFLOWS: readonly string[] = ['ci.yml', 'denylist.yml'];

/** Poll interval while waiting for verdicts and runs. */
export const POLL_MS = 30_000;

/** Default wait budget, minutes. */
export const DEFAULT_TIMEOUT_MIN = 20;

const WORKFLOWS_DIR = '.github/workflows';
const SHA_RE = /^[0-9a-f]{40}$/;
const WORKFLOW_FILE_RE = /^[A-Za-z0-9._-]+\.ya?ml$/;
const SAFE_BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const REASON_MAX = 500;

// -- wire helpers -------------------------------------------------------------

type Rec = Record<string, unknown>;

const asRecord = (value: unknown): Rec =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Rec) : {};

const asString = (value: unknown): string => (typeof value === 'string' ? value : '');

const asInt = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) ? value : null;

/** Any throwable → one capped, log-safe line. */
const describeError = (error: unknown): string => {
  const text =
    error instanceof GhError
      ? `gh exit ${String(error.code)}: ${error.stderr.trim().split('\n', 1)[0] ?? ''}`
      : error instanceof Error
        ? error.message
        : String(error);
  const line = text.split('\n', 1)[0] ?? '';
  return line.length > REASON_MAX ? `${line.slice(0, REASON_MAX)}…` : line;
};

/** Log-safe rendering of an API string: printable ASCII, capped. */
const clean = (value: string): string => {
  const printable = value.replace(/[^\x20-\x7e]/g, '?');
  return printable.length > 100 ? `${printable.slice(0, 100)}…` : printable;
};

/** Timestamp → ms, or NaN for anything unparseable. */
const timeOf = (value: unknown): number => (typeof value === 'string' ? Date.parse(value) : NaN);

/** Newest first: by `field` time, ties broken by the higher numeric id. */
const newestFirst =
  (field: string) =>
  (a: Rec, b: Rec): number => {
    const ta = timeOf(a[field]);
    const tb = timeOf(b[field]);
    const da = Number.isFinite(ta) ? ta : -Infinity;
    const db = Number.isFinite(tb) ? tb : -Infinity;
    if (da !== db) return db - da;
    return (asInt(b['id']) ?? -1) - (asInt(a['id']) ?? -1);
  };

// -- 3. closure (pure) ---------------------------------------------------------

/** A PR as the closure rule reads it (from `GET commits/{sha}/pulls`). */
export interface MergedPr {
  number: number;
  mergeCommitSha: string | null;
  baseRef: string;
  mergedAt: string | null;
  headSha: string;
  /** The head repository's numeric id; null for a deleted fork. */
  headRepoId: number | null;
}

/** Normalize one API pull object, or null when its identity fields are malformed. */
export function toMergedPr(wire: unknown): MergedPr | null {
  const pr = asRecord(wire);
  const number = asInt(pr['number']);
  const head = asRecord(pr['head']);
  const headSha = asString(head['sha']).toLowerCase();
  if (number === null || number <= 0 || !SHA_RE.test(headSha)) return null;
  const merge = asString(pr['merge_commit_sha']).toLowerCase();
  const mergedAt = asString(pr['merged_at']);
  return {
    number,
    mergeCommitSha: SHA_RE.test(merge) ? merge : null,
    baseRef: asString(asRecord(pr['base'])['ref']),
    mergedAt: mergedAt === '' ? null : mergedAt,
    headSha,
    headRepoId: asInt(asRecord(head['repo'])['id']),
  };
}

/** One PR the closure admitted: its number, its merge commit, its final head. */
export interface AdmittedPr {
  pr: number;
  merge: string;
  head: string;
}

export interface ClosureInput {
  /** Every commit in main..tip with its parents. */
  commits: readonly RangeCommit[];
  /** The first-parent chain of tip within the range, newest first. */
  firstParent: readonly string[];
  /** The PRs `GET commits/{M}/pulls` returned per first-parent merge commit M. */
  prs: ReadonlyMap<string, readonly MergedPr[]>;
  /** The repository's numeric id (a same-repo head). */
  repositoryId: number;
  /** The queue branch every admitted PR must have merged into. */
  queueBranch: string;
}

export interface ClosureResult {
  ok: boolean;
  admitted: AdmittedPr[];
  violations: string[];
}

/**
 * The D-K.3 closure rule over main..tip. Every commit must be either (a) a
 * first-parent-chain MERGE commit M (exactly two parents) that is the
 * recorded `merge_commit_sha` of exactly one merged, same-repository PR into
 * the queue branch whose final head is M's second parent, or (b) reachable
 * from such a PR's head within the range. First-parent commits are judged
 * ONLY by (a): a direct push the queue already carried stays a violation
 * even if a later PR branched from it (its diff never showed that commit).
 * Pure; every violation names the commit and the specific rule it broke.
 */
export function checkClosure(input: ClosureInput): ClosureResult {
  const violations: string[] = [];
  const admitted: AdmittedPr[] = [];
  const bySha = new Map(input.commits.map((c) => [c.sha, c]));
  const chain = new Set(input.firstParent);

  for (const sha of input.firstParent) {
    const commit = bySha.get(sha);
    if (commit === undefined) {
      violations.push(`${sha}: first-parent commit missing from the range listing`);
      continue;
    }
    if (commit.parents.length < 2) {
      violations.push(`${sha}: non-merge commit on the queue's first-parent chain (a direct push)`);
      continue;
    }
    if (commit.parents.length > 2) {
      violations.push(
        `${sha}: octopus merge (${String(commit.parents.length)} parents) on the first-parent chain`,
      );
      continue;
    }
    const secondParent = commit.parents[1] ?? '';
    const matches = (input.prs.get(sha) ?? []).filter((pr) => pr.mergeCommitSha === sha);
    const [pr, ...extra] = matches;
    if (pr === undefined) {
      violations.push(
        `${sha}: merge commit with no PR recorded as its merge (a direct merge push)`,
      );
      continue;
    }
    if (extra.length > 0) {
      violations.push(
        `${sha}: ambiguous — PRs ${matches.map((m) => `#${String(m.number)}`).join(', ')} all record it as their merge`,
      );
      continue;
    }
    const reasons: string[] = [];
    if (pr.baseRef !== input.queueBranch) {
      reasons.push(`merged into '${clean(pr.baseRef)}', not '${input.queueBranch}'`);
    }
    if (pr.mergedAt === null) reasons.push('is not merged');
    if (pr.headRepoId !== input.repositoryId) {
      reasons.push(
        `head repository ${pr.headRepoId === null ? '(deleted)' : String(pr.headRepoId)} is not this repository (fork)`,
      );
    }
    if (pr.headSha !== secondParent) {
      reasons.push(`final head ${pr.headSha} is not the merge's second parent ${secondParent}`);
    }
    if (reasons.length > 0) {
      violations.push(`${sha}: PR #${String(pr.number)} ${reasons.join('; ')}`);
      continue;
    }
    admitted.push({ pr: pr.number, merge: sha, head: secondParent });
  }

  // (b): everything reachable from an admitted head, within the range.
  const covered = new Set<string>();
  const stack = admitted.map((a) => a.head);
  while (stack.length > 0) {
    const sha = stack.pop() ?? '';
    if (covered.has(sha)) continue;
    const commit = bySha.get(sha);
    if (commit === undefined) continue;
    covered.add(sha);
    stack.push(...commit.parents);
  }
  for (const commit of input.commits) {
    if (chain.has(commit.sha) || covered.has(commit.sha)) continue;
    violations.push(
      `${commit.sha}: not reachable from any admitted PR head (reached only through an unadmitted path)`,
    );
  }
  return { ok: violations.length === 0, admitted, violations };
}

// -- 8. verdict selection (pure) -----------------------------------------------

export interface VerdictWant {
  tip: string;
  main: string;
  /** The verdict App's numeric id; null selects the interim form. */
  verdictAppId: number | null;
  /**
   * Interim form: whether a completed default-branch cq-verify run exists at
   * trust sha `main` (verifierRanAt). Ignored in App mode.
   */
  verifierRan: boolean;
}

export interface VerdictSelection {
  /** `missing` also covers a verdict bound to another main (dispatch-eligible). */
  state: 'success' | 'failure' | 'pending' | 'missing';
  /** The winning row's id, when one was selected. */
  winner: number | null;
  lines: string[];
}

/** The interim workflow path the verdict must be posted from. */
const VERIFY_PATH = `${WORKFLOWS_DIR}/${VERIFY_WORKFLOW}`;

export interface VerifierWant {
  /** The trust sha the default-branch verifier must have run at. */
  main: string;
  defaultBranch: string;
  repositoryId: number;
}

/**
 * Interim form (Decision 5): the id of the newest COMPLETED default-branch
 * cq-verify run at trust sha `main` among `runs` (from `GET
 * actions/workflows/cq-verify.yml/runs?head_sha=<main>&branch=<default>`),
 * or null. A run counts when its path is `.github/workflows/cq-verify.yml`,
 * its event `workflow_run`|`workflow_dispatch`, its head branch the default
 * branch, its head sha `main` and its head repository this repository. Pure.
 */
export function verifierRanAt(runs: readonly unknown[], want: VerifierWant): number | null {
  const ran = runs
    .map(asRecord)
    .filter((r) => {
      const event = r['event'];
      return (
        r['path'] === VERIFY_PATH &&
        (event === 'workflow_run' || event === 'workflow_dispatch') &&
        r['head_branch'] === want.defaultBranch &&
        r['head_sha'] === want.main &&
        asInt(asRecord(r['head_repository'])['id']) === want.repositoryId &&
        r['status'] === 'completed'
      );
    })
    .sort(newestFirst('created_at'));
  return asInt(ran[0]?.['id']);
}

/**
 * Select the `cq/ratchet` verdict on `tip` bound to `main` from check-run
 * rows (D-F.1, methods note Decision 5). A row is VALID when its poster is
 * authoritative, `head_sha === tip`, `external_id === '<main>:<tip>'` and it
 * is completed:
 *   - App mode (`verdictAppId` set): `app.id === verdictAppId`, a NUMERIC
 *     compare — never the slug; rows from any other app are ignored.
 *   - Interim mode: `app.slug === 'github-actions'`, and the default-branch
 *     verifier actually ran at trust sha `main` (`verifierRan`, see
 *     verifierRanAt). The row itself cannot be tied to that run: a check run
 *     posted through the API lands in the check suite of whichever workflow
 *     run owns the tip's suite (observed: the cq-signal push run's), never
 *     the cq-verify run's. Forgeable (RS-4 T-13); ends at C2.
 * The newest valid row (by `completed_at`, ties → higher id) wins and must
 * be `success`. With no valid row: `pending` when an authoritative row bound
 * to main is still running, else `missing` — including every interim row
 * while no default-branch verifier run at `main` has completed.
 */
export function selectVerdict(rows: readonly unknown[], want: VerdictWant): VerdictSelection {
  const lines: string[] = [];
  const interim = want.verdictAppId === null;
  if (interim) {
    lines.push(
      'interim verdict selection (app slug + binding + a completed default-branch cq-verify run at main; forgeable per RS-4 T-13; ends at C2)',
    );
    if (!want.verifierRan) {
      lines.push(`no completed ${VERIFY_WORKFLOW} run on the default branch at ${want.main}`);
    }
  } else {
    lines.push(`verdict selection: app id ${String(want.verdictAppId)}`);
  }
  const binding = `${want.main}:${want.tip}`;
  const authoritative = (row: Rec): boolean => {
    const app = asRecord(row['app']);
    if (!interim) return asInt(app['id']) === want.verdictAppId;
    return app['slug'] === INTERIM_VERDICT_SLUG && want.verifierRan;
  };
  let ignored = 0;
  let otherBase = 0;
  const running: Rec[] = [];
  const valid: Rec[] = [];
  for (const raw of rows) {
    const row = asRecord(raw);
    if (!authoritative(row) || row['head_sha'] !== want.tip) {
      ignored += 1;
      continue;
    }
    if (row['external_id'] !== binding) {
      otherBase += 1;
      continue;
    }
    if (row['status'] !== 'completed' || !Number.isFinite(timeOf(row['completed_at']))) {
      running.push(row);
      continue;
    }
    valid.push(row);
  }
  lines.push(
    `rows: ${String(rows.length)} (valid ${String(valid.length)}, running ${String(running.length)}, bound to another main ${String(otherBase)}, ignored ${String(ignored)})`,
  );
  const winner = [...valid].sort(newestFirst('completed_at'))[0];
  if (winner !== undefined) {
    const id = asInt(winner['id']);
    const conclusion = clean(asString(winner['conclusion']));
    lines.push(`winner: check run ${String(id)} conclusion ${conclusion || '(none)'}`);
    return {
      state: conclusion === 'success' ? 'success' : 'failure',
      winner: id,
      lines,
    };
  }
  if (running.length > 0) return { state: 'pending', winner: null, lines };
  lines.push(`no ${VERDICT_CHECK} verdict bound to ${binding}`);
  return { state: 'missing', winner: null, lines };
}

// -- 9. verified head-defined runs (pure) ---------------------------------------

export interface VerifiedWant {
  /** The workflow file name (under .github/workflows/). */
  file: string;
  tip: string;
  repositoryId: number;
}

export interface VerifiedRunCheck {
  state: 'success' | 'failure' | 'pending' | 'missing';
  reason: string;
}

/**
 * Judge the newest push run of a block-only head-defined workflow on `tip`
 * (D-F.2): path `.github/workflows/<file>`, event `push`, head branch
 * `merge-queue` (a push of the same sha to another branch is not the
 * queue's run), head repository = this repository, `head_sha === tip`,
 * completed with conclusion `success`,
 * and at least one job, every job completed `success` (a `skipped` job is
 * NOT success — I4: a skipped required check is missing), with a non-null
 * `runner_id` and a non-empty `steps` list (a job that never ran on a
 * runner proves nothing). `jobs` is null until the run is known green.
 */
export function checkVerifiedRun(
  run: unknown,
  jobs: readonly unknown[] | null,
  want: VerifiedWant,
): VerifiedRunCheck {
  if (run === null || run === undefined) return { state: 'missing', reason: 'no push run on tip' };
  const r = asRecord(run);
  const id = String(asInt(r['id']));
  const fail = (why: string): VerifiedRunCheck => ({
    state: 'failure',
    reason: `run ${id}: ${why}`,
  });
  const path = `${WORKFLOWS_DIR}/${want.file}`;
  if (r['path'] !== path) return fail(`path '${clean(asString(r['path']))}' is not '${path}'`);
  if (r['event'] !== 'push') return fail(`event '${clean(asString(r['event']))}' is not 'push'`);
  if (r['head_branch'] !== QUEUE_BRANCH) {
    return fail(`head branch '${clean(asString(r['head_branch']))}' is not '${QUEUE_BRANCH}'`);
  }
  if (asInt(asRecord(r['head_repository'])['id']) !== want.repositoryId) {
    return fail('head repository is not this repository');
  }
  if (r['head_sha'] !== want.tip) return fail('head_sha is not the tip');
  if (r['status'] !== 'completed') {
    return {
      state: 'pending',
      reason: `run ${id}: ${clean(asString(r['status'])) || 'not completed'}`,
    };
  }
  if (r['conclusion'] !== 'success') {
    return fail(`conclusion '${clean(asString(r['conclusion']))}'`);
  }
  if (jobs === null) return { state: 'pending', reason: `run ${id}: jobs not read yet` };
  if (jobs.length === 0) return fail('no jobs');
  for (const raw of jobs) {
    const job = asRecord(raw);
    const name = clean(asString(job['name'])) || String(asInt(job['id']));
    if (job['status'] !== 'completed' || job['conclusion'] !== 'success') {
      return fail(
        `job '${name}' is ${clean(asString(job['status']))}/${clean(asString(job['conclusion'])) || 'none'}, not completed/success`,
      );
    }
    if (asInt(job['runner_id']) === null) return fail(`job '${name}' has no runner_id`);
    const steps = job['steps'];
    if (!Array.isArray(steps) || steps.length === 0) return fail(`job '${name}' has no steps`);
  }
  return {
    state: 'success',
    reason: `run ${id}: ${String(jobs.length)} job(s) green`,
  };
}

// -- the promotion review (pure, PR-C) -------------------------------------------

export interface ReviewerWant {
  /** The pinned reviewer bot's login (creator.login, a `[bot]` user). */
  login: string;
  /** The pinned reviewer bot's numeric user id (creator.id, numeric compare). */
  id: number;
}

export interface PromotionReviewSelection {
  /** A trusted success without a usable `main=` binding is a `failure`. */
  state: 'success' | 'failure' | 'pending' | 'missing';
  /** The winning status's id, when one was selected. */
  winner: number | null;
  /** The `main=<40-hex>` base the success's description binds (success only). */
  base: string | null;
  /** Promotion-review statuses from creators other than the pinned reviewer. */
  others: number;
  lines: string[];
}

const REVIEW_BASE_RE = /(^|\s)main=([0-9a-f]{40})(\s|$)/;

/**
 * Select the newest trusted `crq/promotion-review` status from commit-status
 * rows — the same rules the merge-queue gate's REVIEW_JQ applies. Trusted is
 * creator.type "Bot" AND creator.login AND creator.id, a numeric compare: a
 * commit status carries no app id, so the bot user is the identity, and any
 * other creator (the owner's User login, GITHUB_TOKEN, every App) is
 * untrusted. The newest trusted row by (created_at, id) wins; a success must
 * bind the reviewed base as `main=<40-hex>` in its description — the caller
 * checks that base into main. `others` counts untrusted promotion-review
 * statuses; the caller turns others-without-a-selected-review on the gated
 * sha into a red refusal. Pure.
 */
export function selectPromotionReview(
  statuses: readonly unknown[],
  want: ReviewerWant,
): PromotionReviewSelection {
  const lines: string[] = [];
  let others = 0;
  const trusted: Rec[] = [];
  for (const raw of statuses) {
    const row = asRecord(raw);
    if (asString(row['context']) !== PROMOTION_REVIEW_CONTEXT) continue;
    const creator = asRecord(row['creator']);
    const ok =
      creator['type'] === 'Bot' &&
      creator['login'] === want.login &&
      asInt(creator['id']) === want.id;
    if (ok) trusted.push(row);
    else others += 1;
  }
  const winner = [...trusted].sort(newestFirst('created_at'))[0];
  if (winner === undefined) {
    lines.push(
      `no promotion-review status from the pinned reviewer (${want.login}/${String(want.id)})`,
    );
    if (others > 0) {
      lines.push(`${String(others)} promotion-review status(es) from other creators`);
    }
    return { state: 'missing', winner: null, base: null, others, lines };
  }
  const id = asInt(winner['id']);
  const state = asString(winner['state']);
  const description = asString(winner['description']);
  if (state !== 'success') {
    lines.push(`review ${String(id)}: ${clean(state) || '(no state)'} — ${clean(description)}`);
    return {
      state: state === 'pending' ? 'pending' : 'failure',
      winner: id,
      base: null,
      others,
      lines,
    };
  }
  const base = REVIEW_BASE_RE.exec(description)?.[2] ?? null;
  if (base === null) {
    lines.push(
      `review ${String(id)}: success without a main=<sha> binding — refusing as malformed`,
    );
    return { state: 'failure', winner: id, base: null, others, lines };
  }
  lines.push(`review ${String(id)}: success, base ${base} — ${clean(description)}`);
  return { state: 'success', winner: id, base, others, lines };
}

// -- the orchestrator ------------------------------------------------------------

/** The hardened git helpers the gate uses (injected so tests can fake them). */
export interface GateGit {
  revParse(repo: string, rev: string): Promise<string>;
  isAncestor(repo: string, a: string, b: string): Promise<boolean>;
  rangeCommits(repo: string, from: string, to: string): Promise<RangeCommit[]>;
  firstParentRange(repo: string, from: string, to: string): Promise<string[]>;
  treeOf(repo: string, commit: string): Promise<string>;
  mergeTreeClean(repo: string, p1: string, p2: string): Promise<string | null>;
  lsRemoteRef(repo: string, url: string, ref: string, token: string): Promise<string | null>;
  pushAtomic(
    repo: string,
    url: string,
    updates: readonly LeasedUpdate[],
    token: string,
  ): Promise<{ ok: boolean; output: string }>;
}

/** The real helpers from ../ops/ratchet/git.ts. */
export const realGateGit: GateGit = {
  revParse: gitRevParse,
  isAncestor: gitIsAncestor,
  rangeCommits: gitRangeCommits,
  firstParentRange: gitFirstParentRange,
  treeOf: gitTreeOf,
  mergeTreeClean: gitMergeTreeClean,
  lsRemoteRef: gitLsRemoteRef,
  pushAtomic: gitPushAtomic,
};

export interface GateDeps {
  /** Read-only transport (the job's GITHUB_TOKEN); the one write is the cq-verify dispatch. */
  gh: GhFn;
  git: GateGit;
  /** judgeAcceptance bound to the trust set. Must never throw. */
  acceptance(input: AcceptanceInput): Promise<AcceptanceResult>;
  /** gates.policyDiff bound to the resolved posture. */
  policyDiff(input: PolicyDiffInput): Promise<OpResult<PolicyDiffOutcome>>;
  sleep(ms: number): Promise<void>;
  nowMs(): number;
}

export interface GateConfig {
  /** The trust checkout (holds refs/remotes/origin/{main,merge-queue} and the tip's objects). */
  repo: string;
  owner: string;
  name: string;
  repositoryId: number;
  /** The trust ref sha (the default-branch commit this definition was built from). */
  trustRef: string;
  defaultBranch: string;
  verdictAppId: number | null;
  verifiedWorkflows: readonly string[];
  /** The pinned promotion reviewer (PR-C): creator type Bot + login + id. */
  reviewer: ReviewerWant;
  timeoutMin: number;
  /** Promote for real; otherwise the verdict is `would-promote`. */
  push: boolean;
  /** The push credential; required when `push`. */
  pushToken: string | null;
  /** The push target (`<server>/<owner>/<name>.git`, or a local path in tests). */
  remoteUrl: string;
}

export interface GateResult {
  verdict: 'promoted' | 'would-promote' | 'noop' | 'awaiting' | 'refused';
  /** The queue tip as read from the API (the walk's starting point). */
  tip: string | null;
  /** The reviewed sha the gate judged and would promote (PR-C). */
  subject: string | null;
  main: string | null;
  report: string[];
}

/** A refusal thrown inside runGate's body; caught into a `refused` result. */
class Refusal extends Error {}

/** Flatten a `--paginate --slurp` payload of OBJECT pages to `key`'s arrays. */
function pagesOf(payload: unknown, key: string, path: string): unknown[] {
  if (!Array.isArray(payload)) throw new Error(`gh api ${path} returned a non-array payload`);
  const out: unknown[] = [];
  for (const page of payload as unknown[]) {
    const list = asRecord(page)[key];
    if (!Array.isArray(list)) throw new Error(`gh api ${path} page has no '${key}' array`);
    out.push(...(list as unknown[]));
  }
  return out;
}

/**
 * Run the gate. Never throws: any fault is a `refused` result whose report
 * says which check failed and why (the next sweep retries).
 */
export async function runGate(deps: GateDeps, cfg: GateConfig): Promise<GateResult> {
  const report: string[] = [];
  let tip: string | null = null;
  let subject: string | null = null;
  let main: string | null = null;
  const refuse = (why: string): never => {
    throw new Refusal(why);
  };
  try {
    const result = await gateBody(
      deps,
      cfg,
      report,
      (t, m, s) => {
        tip = t;
        main = m;
        subject = s;
      },
      refuse,
    );
    return { ...result, tip, subject, main, report };
  } catch (error) {
    const why = error instanceof Refusal ? error.message : `gate error: ${describeError(error)}`;
    report.push(`refused: ${why}`);
    return { verdict: 'refused', tip, subject, main, report };
  }
}

async function gateBody(
  deps: GateDeps,
  cfg: GateConfig,
  report: string[],
  setSubject: (tip: string, main: string, subject: string | null) => void,
  refuse: (why: string) => never,
): Promise<{ verdict: GateResult['verdict'] }> {
  const { gh, git } = deps;
  const repoPath = `repos/${cfg.owner}/${cfg.name}`;
  const getJson = (path: string): Promise<unknown> => ghJson<unknown>(gh, ['api', path]);
  const getSlurp = (path: string): Promise<unknown> =>
    ghJson<unknown>(gh, ['api', path, '--paginate', '--slurp']);

  // 1. Subject, resolved by the gate itself.
  const refSha = async (branch: string): Promise<string> => {
    const wire = asRecord(await getJson(`${repoPath}/git/ref/heads/${branch}`));
    const object = asRecord(wire['object']);
    const sha = asString(object['sha']).toLowerCase();
    if (object['type'] !== 'commit' || !SHA_RE.test(sha)) {
      refuse(`subject: refs/heads/${branch} did not resolve to a commit sha`);
    }
    return sha;
  };
  const tip = await refSha(QUEUE_BRANCH);
  const main = await refSha(MAIN_BRANCH);
  setSubject(tip, main, null);
  report.push(`subject: tip ${tip} (${QUEUE_BRANCH}), main ${main} (API)`);
  for (const [sha, what] of [
    [tip, 'tip'],
    [main, 'main'],
  ] as const) {
    try {
      await git.revParse(cfg.repo, sha);
    } catch (error) {
      refuse(`subject: ${what} ${sha} is not present locally (${describeError(error)})`);
    }
  }
  const localTip = await git.revParse(cfg.repo, `refs/remotes/origin/${QUEUE_BRANCH}`);
  if (localTip !== tip) refuse('tip moved since fetch; next sweep retries');
  const localMain = await git.revParse(cfg.repo, `refs/remotes/origin/${MAIN_BRANCH}`);
  if (localMain !== main) refuse('main moved since fetch; next sweep retries');

  // 2. Ancestry.
  if (tip === main || (await git.isAncestor(cfg.repo, tip, main))) {
    report.push('ancestry: tip is already contained in main');
    return { verdict: 'noop' };
  }
  // A run queued behind another promotion keeps its trust checkout
  // (`github.sha`) at the OLD main while the API already shows the new one:
  // its code and definitions are not main's, so it must not judge. Checked
  // only once there is something to promote: the noop test above reads git
  // objects alone, so the second carrier's run after a promotion (ci and
  // cq-measure both wake the gate) stays a green noop, not a red refusal.
  if (main !== cfg.trustRef.toLowerCase()) {
    refuse(
      `trust ref ${cfg.trustRef} trails main ${main}: this run's code and definitions are not main's; the next sweep retries`,
    );
  }
  if (!(await git.isAncestor(cfg.repo, main, tip))) {
    refuse('diverged: main is not an ancestor of the tip');
  }
  report.push('ancestry: main is an ancestor of the tip (fast-forward)');

  // 2b. Subject: the newest queue commit whose newest trusted promotion
  //     review is a success bound into main (PR-C). Walk the first-parent
  //     line main..tip newest-first; everything below judges and promotes
  //     the SUBJECT, not the tip — a tip ahead of the reviewed sha simply
  //     waits for its own review. Untrusted promotion-review statuses on
  //     the TIP with no selected review refuse (a foreign or forged
  //     signal); on older commits they are history and inert, because the
  //     subject — never the tip — is what promotes.
  const walk = await git.firstParentRange(cfg.repo, main, tip);
  if (walk[0] !== tip) refuse('subject: the first-parent chain does not start at the tip');
  let subject: string | null = null;
  let subjectBase: string | null = null;
  let othersOnTip = 0;
  for (const sha of walk) {
    const statusesPath = `${repoPath}/commits/${sha}/statuses?per_page=100`;
    const review = selectPromotionReview(
      slurpedComments(await getSlurp(statusesPath), statusesPath).flat(),
      cfg.reviewer,
    );
    if (sha === tip) othersOnTip = review.others;
    if (review.state !== 'success' || review.base === null) {
      report.push(`  review walk ${sha}: ${review.state}`, ...review.lines.map((l) => `  ${l}`));
      continue;
    }
    const baseInMain = review.base === main || (await git.isAncestor(cfg.repo, review.base, main));
    if (!baseInMain) {
      report.push(
        `  review walk ${sha}: success base ${review.base} is not contained in main`,
        ...review.lines.map((l) => `  ${l}`),
      );
      continue;
    }
    subject = sha;
    subjectBase = review.base;
    report.push(`  review walk ${sha}: SELECTED`, ...review.lines.map((l) => `  ${l}`));
    break;
  }
  if (subject === null) {
    if (othersOnTip > 0) {
      refuse(
        `promotion review: the tip carries ${String(othersOnTip)} crq/promotion-review status(es) from creators other than the pinned reviewer (${cfg.reviewer.login}/${String(cfg.reviewer.id)})`,
      );
    }
    report.push('awaiting promotion review: no reviewed commit on the queue');
    return { verdict: 'awaiting' };
  }
  setSubject(tip, main, subject);
  report.push(
    `subject: reviewed sha ${subject} (base ${subjectBase} in main)${
      subject === tip ? ' — the queue tip itself' : ` — queue tip ${tip} waits for its own review`
    }`,
  );

  // 3. Closure over main..subject.
  const commits = await git.rangeCommits(cfg.repo, main, subject);
  const firstParent = await git.firstParentRange(cfg.repo, main, subject);
  if (firstParent[0] !== subject) {
    refuse('closure: the first-parent chain does not start at the subject');
  }
  const prs = new Map<string, MergedPr[]>();
  const bySha = new Map(commits.map((c) => [c.sha, c]));
  for (const sha of firstParent) {
    if ((bySha.get(sha)?.parents.length ?? 0) !== 2) continue;
    const path = `${repoPath}/commits/${sha}/pulls?per_page=100`;
    const wire = slurpedComments(await getSlurp(path), path).flat();
    prs.set(
      sha,
      wire.map(toMergedPr).filter((pr): pr is MergedPr => pr !== null),
    );
  }
  const closure = checkClosure({
    commits,
    firstParent,
    prs,
    repositoryId: cfg.repositoryId,
    queueBranch: QUEUE_BRANCH,
  });
  report.push(
    `closure: ${String(commits.length)} commit(s), ${String(firstParent.length)} on the first-parent chain, ${String(closure.admitted.length)} admitted PR(s)`,
  );
  for (const a of closure.admitted) {
    report.push(`  admitted PR #${String(a.pr)}: merge ${a.merge} head ${a.head}`);
  }
  for (const v of closure.violations) report.push(`  violation: ${v}`);
  if (!closure.ok) refuse('closure: main..tip contains commits no accepted PR admits');

  // 4. Clean first-parent merges.
  for (const a of closure.admitted) {
    const commit = bySha.get(a.merge);
    const [p1 = '', p2 = ''] = commit?.parents ?? [];
    const merged = await git.mergeTreeClean(cfg.repo, p1, p2);
    const actual = await git.treeOf(cfg.repo, a.merge);
    if (merged === null || merged !== actual) {
      report.push(
        `  merge-tree ${a.merge}: ${merged === null ? 'parents conflict' : `tree ${actual} != clean merge ${merged}`}`,
      );
      refuse(
        `merge ${a.merge}: evil or conflict-resolving merge on the queue's first-parent chain`,
      );
    }
  }
  report.push(`merges: ${String(closure.admitted.length)} first-parent merge(s) clean`);

  // 5. I2 evidence (not settle — see the header) per admitted PR, at its
  //    merged head. Re-judged in step 10a after the waits (a dismissal, new
  //    objection or reopened thread moves no ref, so the leases cannot see it).
  const rejected = await judgeAdmitted(deps, closure.admitted, report, 'pass 1');
  if (rejected.length > 0) {
    refuse(
      `acceptance: PR(s) ${rejected.map((n) => `#${String(n)}`).join(', ')} lack I2 acceptance evidence`,
    );
  }

  // 6. Policy recompute over main..subject (push subject).
  const policy = await deps.policyDiff({
    repo: cfg.repo,
    trustRef: cfg.trustRef,
    subject,
    subjectKind: 'push',
    base: `refs/remotes/origin/${MAIN_BRANCH}`,
  });
  let policyRefusal: string | null = null;
  if (policy.status !== 'ok') {
    const detail =
      policy.status === 'failed'
        ? policy.error
        : policy.status === 'needs-human'
          ? policy.reason
          : policy.status === 'indeterminate'
            ? policy.detail
            : policy.status;
    report.push(`policy: ${policy.status} — ${clean(detail)}`);
    policyRefusal = 'policy: gates.policyDiff could not judge the range';
  } else {
    report.push(`policy: ${policy.value.verdict}`);
    for (const line of policy.value.report) report.push(`  ${line}`);
    if (policy.value.verdict !== 'pass') {
      policyRefusal = `policy: ${policy.value.verdict} — D11 records are dormant until the C3 attestation, so a protected-path change promotes only by owner break-glass (ADR-0004 D-G.4, D-H.4)`;
    }
  }

  // 7. Log each admitted PR's cq-override record (never decisive here).
  await logOverrides(deps, cfg, closure.admitted, report);
  if (policyRefusal !== null) refuse(policyRefusal);

  // 8–9. Verdicts and verified runs on the SUBJECT, waited for within one
  //      deadline.
  await awaitVerdicts(deps, cfg, subject, main, report, refuse);

  // 10a. I2 evidence again, now that the waits are over: the wait can take up
  //      to timeoutMin, and a change in acceptance moves no ref.
  const changed = await judgeAdmitted(deps, closure.admitted, report, 'pass 2');
  if (changed.length > 0) {
    refuse(
      `acceptance: ${changed.map((n) => `PR #${String(n)}`).join(', ')}: acceptance changed during the wait`,
    );
  }

  // 10b. Verdicts and verified runs once more, without waiting: pass 2 can
  //      itself take minutes, and a failed rerun or a newly posted verdict
  //      moves no ref. One poll; anything short of green refuses.
  await awaitVerdicts(deps, cfg, subject, main, report, refuse, 'recheck');

  // 10. Promote.
  if (!cfg.push) {
    report.push('push: dry run (no --push)');
    return { verdict: 'would-promote' };
  }
  const pushToken = cfg.pushToken;
  if (pushToken === null) refuse('push: no push credential');
  // The main lease is the step-1 read: main must still be `main`. The
  // SUBJECT is what promotes (PR-C): a queue that ADVANCED past it is fine —
  // those commits simply wait for their own review. Any OTHER queue movement
  // must stop this promotion — a break-glass rewind below the tip in
  // particular puts the subject off the queue, and promoting an off-queue
  // commit from a stale read is exactly the equal-OID/lease hole. So the
  // last pre-push observation, on the same transport the push uses, is the
  // queue ref as the remote serves it NOW. Still the run-start tip — the
  // normal case, which step 1 pinned the local mirror to — ONLY main is
  // sent (D-K.6 by construction, not by git's equal-OID skip). Moved — the
  // merge-queue refspec rides along as a pure lease: leased at the tip it
  // can never land, and --atomic refuses main with it, so a rewound queue
  // can never re-promote the subject, and an advanced one (the rewind
  // window's other half) makes the next sweep retry from fresh reads.
  const queueNow = await git.lsRemoteRef(cfg.repo, cfg.remoteUrl, QUEUE_BRANCH, pushToken);
  const updates: LeasedUpdate[] = [
    { refspec: `${subject}:refs/heads/${MAIN_BRANCH}`, expected: main },
  ];
  if (queueNow !== tip) {
    updates.push({
      refspec: `${tip}:refs/heads/${QUEUE_BRANCH}`,
      expected: tip,
    });
  }
  const pushed = await git.pushAtomic(cfg.repo, cfg.remoteUrl, updates, pushToken);
  if (!pushed.ok) {
    report.push(...pushed.output.split('\n').map((line) => `  push: ${clean(line)}`));
    refuse(
      'push: the atomic leased push was rejected (main or the queue moved since the read); next sweep retries',
    );
  }
  report.push(`push: main at ${subject} (reviewed sha, base ${subjectBase})`);
  return { verdict: 'promoted' };
}

/**
 * Steps 5 and 10a: judge I2 evidence for every admitted PR at its merged head,
 * reporting each outcome under `pass`; returns the PRs that did not pass.
 */
async function judgeAdmitted(
  deps: GateDeps,
  admitted: readonly AdmittedPr[],
  report: string[],
  pass: string,
): Promise<number[]> {
  const rejected: number[] = [];
  for (const a of admitted) {
    const result = await deps.acceptance({
      pr: a.pr,
      subject: a.head,
      base: QUEUE_BRANCH,
      state: 'merged',
    });
    report.push(
      `acceptance ${pass} PR #${String(a.pr)} (I2 evidence; settle not judged): ${result.verdict}`,
    );
    for (const line of result.report) report.push(`  ${line}`);
    if (result.verdict !== 'pass') rejected.push(a.pr);
  }
  return rejected;
}

/** Step 7: evaluate and log each admitted PR's cq-override record. Never throws. */
async function logOverrides(
  deps: GateDeps,
  cfg: GateConfig,
  admitted: readonly AdmittedPr[],
  report: string[],
): Promise<void> {
  if (admitted.length === 0) return;
  const repoPath = `repos/${cfg.owner}/${cfg.name}`;
  let ownerId: number | null = null;
  try {
    ownerId = asInt(
      asRecord(asRecord(await ghJson<unknown>(deps.gh, ['api', repoPath]))['owner'])['id'],
    );
  } catch (error) {
    report.push(`override: owner id unreadable (${describeError(error)})`);
  }
  for (const a of admitted) {
    let evaluation: OverrideEvaluation;
    try {
      const path = `${repoPath}/issues/${String(a.pr)}/timeline?per_page=100`;
      const events = slurpedComments(
        await ghJson<unknown>(deps.gh, ['api', path, '--paginate', '--slurp']),
        path,
      )
        .flat()
        .filter((e) => {
          const event = asRecord(e)['event'];
          return event === 'labeled' || event === 'unlabeled';
        });
      // No settle-ledger epoch is read here, so a present label is logged
      // `invalid` (no durable head observation) — never honoured by the gate.
      evaluation = evaluateOverrideLabel({
        events,
        ownerId: ownerId ?? 0,
        subject: a.head,
        headObservedAt: undefined,
        attested: false,
      });
    } catch (error) {
      evaluation = {
        status: 'invalid',
        reasons: [`label events unreadable: ${describeError(error)}`],
      };
    }
    report.push(`override PR #${String(a.pr)} (logged only):`);
    for (const line of formatOverride(evaluation)) report.push(`  ${line}`);
  }
}

/**
 * Steps 8–9: poll until the verdict and every verified run are green ON THE
 * SUBJECT, or refuse. In `recheck` mode (step 10b) it reads once, never
 * dispatches, and refuses anything short of green.
 */
async function awaitVerdicts(
  deps: GateDeps,
  cfg: GateConfig,
  subject: string,
  main: string,
  report: string[],
  refuse: (why: string) => never,
  mode: 'wait' | 'recheck' = 'wait',
): Promise<void> {
  const recheck = mode === 'recheck';
  const repoPath = `repos/${cfg.owner}/${cfg.name}`;
  const getSlurp = (path: string): Promise<unknown> =>
    ghJson<unknown>(deps.gh, ['api', path, '--paginate', '--slurp']);
  const deadline = recheck ? deps.nowMs() : deps.nowMs() + cfg.timeoutMin * 60_000;
  let verifierRun: number | null = null;
  let dispatched = false;
  let polls = 0;

  for (;;) {
    polls += 1;
    const lines: string[] = recheck ? ['recheck before push:'] : [];

    // 8. The verdict.
    const checksPath = `${repoPath}/commits/${subject}/check-runs?check_name=${encodeURIComponent(VERDICT_CHECK)}&filter=all&per_page=100`;
    const rows = pagesOf(await getSlurp(checksPath), 'check_runs', checksPath);
    if (cfg.verdictAppId === null && verifierRun === null) {
      // Interim: did the default-branch verifier run at trust sha `main`?
      const verifyPath = `${repoPath}/actions/workflows/${VERIFY_WORKFLOW}/runs?head_sha=${main}&branch=${encodeURIComponent(cfg.defaultBranch)}&per_page=100`;
      verifierRun = verifierRanAt(
        pagesOf(await getSlurp(verifyPath), 'workflow_runs', verifyPath),
        {
          main,
          defaultBranch: cfg.defaultBranch,
          repositoryId: cfg.repositoryId,
        },
      );
      if (verifierRun !== null) {
        report.push(`interim: ${VERIFY_WORKFLOW} run ${String(verifierRun)} completed at ${main}`);
      }
    }
    const verdict = selectVerdict(rows, {
      tip: subject,
      main,
      verdictAppId: cfg.verdictAppId,
      verifierRan: verifierRun !== null,
    });
    lines.push(`verdict ${VERDICT_CHECK}: ${verdict.state}`, ...verdict.lines.map((l) => `  ${l}`));
    if (verdict.state === 'failure') {
      report.push(...lines);
      refuse(`verdict: the newest valid ${VERDICT_CHECK} verdict on the subject is not success`);
    }
    if (verdict.state === 'missing' && !dispatched && !recheck) {
      const outcome = await dispatchVerify(deps, cfg, subject);
      if (outcome.dispatched) dispatched = true;
      report.push(`dispatch ${VERIFY_WORKFLOW}: ${outcome.line}`);
    }

    // 9. Verified head-defined runs.
    let allGreen = verdict.state === 'success';
    for (const file of cfg.verifiedWorkflows) {
      const runsPath = `${repoPath}/actions/workflows/${file}/runs?head_sha=${subject}&event=push&branch=${QUEUE_BRANCH}&per_page=100`;
      const runs = pagesOf(await getSlurp(runsPath), 'workflow_runs', runsPath).map(asRecord);
      const newest = [...runs].sort(newestFirst('created_at'))[0] ?? null;
      let check = checkVerifiedRun(newest, null, {
        file,
        tip: subject,
        repositoryId: cfg.repositoryId,
      });
      if (check.state === 'pending' && newest !== null && newest['status'] === 'completed') {
        const id = asInt(newest['id']);
        const jobsPath = `${repoPath}/actions/runs/${String(id)}/jobs?per_page=100`;
        const jobs = pagesOf(await getSlurp(jobsPath), 'jobs', jobsPath);
        check = checkVerifiedRun(newest, jobs, {
          file,
          tip: subject,
          repositoryId: cfg.repositoryId,
        });
      }
      lines.push(`verified ${file}: ${check.state} — ${check.reason}`);
      if (check.state === 'failure') {
        report.push(...lines);
        refuse(`verified run ${file}: not green on the tip`);
      }
      if (check.state !== 'success') allGreen = false;
    }

    if (allGreen) {
      report.push(...lines);
      if (!recheck) report.push(`waited: ${String(polls)} poll(s)`);
      return;
    }
    if (recheck) {
      report.push(...lines);
      refuse('recheck: verdicts or verified runs are no longer green after the acceptance pass');
    }
    if (deps.nowMs() >= deadline) {
      report.push(...lines, `waited: ${String(polls)} poll(s)`);
      refuse(`timeout: verdicts not green within ${String(cfg.timeoutMin)} minute(s)`);
    }
    await deps.sleep(POLL_MS);
  }
}

/**
 * Dispatch cq-verify on the default ref for the SUBJECT's completed
 * cq-measure push run (ADR-0004 D-K.5, R2-5). Never throws; `dispatched` is
 * true only when the dispatch call succeeded (a subject with no completed
 * measure run yet is retried on the next poll).
 */
async function dispatchVerify(
  deps: GateDeps,
  cfg: GateConfig,
  subject: string,
): Promise<{ dispatched: boolean; line: string }> {
  const repoPath = `repos/${cfg.owner}/${cfg.name}`;
  try {
    const path = `${repoPath}/actions/workflows/${MEASURE_WORKFLOW}/runs?head_sha=${subject}&event=push&per_page=100`;
    const runs = pagesOf(
      await ghJson<unknown>(deps.gh, ['api', path, '--paginate', '--slurp']),
      'workflow_runs',
      path,
    )
      .map(asRecord)
      .filter(
        (r) =>
          r['path'] === `${WORKFLOWS_DIR}/${MEASURE_WORKFLOW}` &&
          r['event'] === 'push' &&
          r['head_sha'] === subject &&
          asInt(asRecord(r['head_repository'])['id']) === cfg.repositoryId &&
          r['status'] === 'completed',
      )
      .sort(newestFirst('created_at'));
    const measureId = asInt(runs[0]?.['id']);
    if (measureId === null)
      return {
        dispatched: false,
        line: 'waiting (no completed cq-measure push run on subject)',
      };
    const res = await deps.gh([
      'api',
      '-X',
      'POST',
      `${repoPath}/actions/workflows/${VERIFY_WORKFLOW}/dispatches`,
      '-f',
      `ref=${cfg.defaultBranch}`,
      '-f',
      `inputs[measure_run_id]=${String(measureId)}`,
    ]);
    if (res.code !== 0) {
      return {
        dispatched: false,
        line: `failed (gh exit ${String(res.code)}: ${clean(res.stderr.trim().split('\n', 1)[0] ?? '')})`,
      };
    }
    return {
      dispatched: true,
      line: `dispatched on ${cfg.defaultBranch} for cq-measure run ${String(measureId)}`,
    };
  } catch (error) {
    return { dispatched: false, line: `failed (${describeError(error)})` };
  }
}

// -- the CLI entry ---------------------------------------------------------------

/** parseGateArgs's answer (everything but the env-derived parts of GateConfig). */
export interface GateArgs {
  repo: string;
  owner: string;
  name: string;
  repositoryId: number;
  trustRef: string;
  defaultBranch: string;
  verdictAppId: number | null;
  verifiedWorkflows: string[];
  /** The pinned promotion reviewer bot (PR-C), from the registration record. */
  reviewer: ReviewerWant;
  timeoutMin: number;
  push: boolean;
}

const VALUE_FLAGS: readonly string[] = [
  'repo',
  'repository',
  'repositoryId',
  'trustRef',
  'defaultBranch',
  'verdictAppId',
  'verifiedWorkflows',
  'reviewerBotLogin',
  'reviewerBotId',
  'timeoutMin',
];

const BOT_LOGIN_RE = /^[A-Za-z0-9-]+\[bot\]$/;

const positiveInt = (raw: string, flag: string): number => {
  const n = /^[1-9][0-9]*$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(n))
    throw new Error(`--${flag} must be a positive integer — got ${JSON.stringify(raw)}`);
  return n;
};

/**
 * Strict flag parsing: `--name=value` for the value flags, bare `--push`.
 * Throws on an unknown, repeated or value-less flag, a positional argument,
 * or a malformed value. `--repo`, `--repository`, `--repositoryId`,
 * `--trustRef` and `--defaultBranch` are required. Pure.
 */
export function parseGateArgs(argv: readonly string[]): GateArgs {
  const values = new Map<string, string>();
  let push = false;
  for (const arg of argv) {
    if (arg === '--push') {
      if (push) throw new Error('--push given more than once');
      push = true;
      continue;
    }
    const match = /^--([A-Za-z]+)=(.*)$/s.exec(arg);
    const flag = match?.[1];
    const value = match?.[2];
    if (flag === undefined || value === undefined || !VALUE_FLAGS.includes(flag)) {
      throw new Error(`unknown argument ${JSON.stringify(arg)}`);
    }
    if (values.has(flag)) throw new Error(`--${flag} given more than once`);
    if (value === '') throw new Error(`--${flag} needs a value`);
    values.set(flag, value);
  }
  const required = (flag: string): string => {
    const value = values.get(flag);
    if (value === undefined) throw new Error(`--${flag} is required`);
    return value;
  };
  const repo = required('repo');
  const repository = required('repository');
  const [owner = '', name = '', ...extra] = repository.split('/');
  if (extra.length > 0 || !ghNameOk(owner) || !ghNameOk(name)) {
    throw new Error(`--repository must be <owner>/<name> — got ${JSON.stringify(repository)}`);
  }
  const repositoryId = positiveInt(required('repositoryId'), 'repositoryId');
  const trustRef = required('trustRef').toLowerCase();
  if (!SHA_RE.test(trustRef)) throw new Error('--trustRef must be a 40-hex commit sha');
  const defaultBranch = required('defaultBranch');
  if (!SAFE_BRANCH_RE.test(defaultBranch) || defaultBranch.includes('..')) {
    throw new Error(
      `--defaultBranch is not a safe branch name — got ${JSON.stringify(defaultBranch)}`,
    );
  }
  const appRaw = values.get('verdictAppId');
  const verdictAppId = appRaw === undefined ? null : positiveInt(appRaw, 'verdictAppId');
  const verifiedRaw = values.get('verifiedWorkflows');
  const verifiedWorkflows =
    verifiedRaw === undefined
      ? [...DEFAULT_VERIFIED_WORKFLOWS]
      : verifiedRaw.split(',').map((f) => f.trim());
  for (const file of verifiedWorkflows) {
    if (!WORKFLOW_FILE_RE.test(file)) {
      throw new Error(
        `--verifiedWorkflows entry ${JSON.stringify(file)} is not a workflow file name`,
      );
    }
  }
  const timeoutRaw = values.get('timeoutMin');
  const timeoutMin =
    timeoutRaw === undefined ? DEFAULT_TIMEOUT_MIN : positiveInt(timeoutRaw, 'timeoutMin');
  // The pinned reviewer (PR-C): required, well-formed, and never a banned
  // identity — an UNSET or malformed pin refuses before any read (fail
  // closed), the same posture as the merge-queue gate's UNSET guard.
  const login = required('reviewerBotLogin');
  if (!BOT_LOGIN_RE.test(login) || BANNED_REVIEWER_LOGINS.includes(login)) {
    throw new Error(
      `--reviewerBotLogin is not a pinnable bot login — got ${JSON.stringify(login)}`,
    );
  }
  const id = positiveInt(required('reviewerBotId'), 'reviewerBotId');
  if (BANNED_REVIEWER_IDS.includes(id)) {
    throw new Error(`--reviewerBotId ${String(id)} is a banned identity — refusing`);
  }
  return {
    repo,
    owner,
    name,
    repositoryId,
    trustRef,
    defaultBranch,
    verdictAppId,
    verifiedWorkflows,
    reviewer: { login, id },
    timeoutMin,
    push,
  };
}

/** The push target for `<server>/<owner>/<name>.git`; the server must be a bare https origin. */
export function remoteUrlFor(server: string, owner: string, name: string): string {
  if (!/^https:\/\/[A-Za-z0-9.-]+$/.test(server)) {
    throw new Error(
      `GITHUB_SERVER_URL must be a bare https origin — got ${JSON.stringify(server)}`,
    );
  }
  return `${server}/${owner}/${name}.git`;
}

/** The token env var (read once, then removed from process.env). */
export const PROMOTE_TOKEN_ENV = 'CQ_PROMOTE_TOKEN';

/** What {@link mainWith} runs over (the seam main() fills with the real ones). */
export interface MainDeps {
  /** Build the gh transport. Called only AFTER the token is out of the env. */
  makeGh(): GhFn;
  git: GateGit;
  sleep(ms: number): Promise<void>;
  nowMs(): number;
  /** Receives the ONE JSON result line (newline-terminated). */
  write(line: string): void;
}

/**
 * The CLI body over an explicit argv, env and deps. Takes the push
 * credential out of `env` FIRST — `env` is process.env in main(), which every
 * gh and git child inherits — so no child sees it; parses flags and config;
 * refuses `--push` without the credential before any read; runs the gate and
 * writes ONE JSON line. Returns the exit code: 0 for promoted /
 * would-promote / noop, 1 for refused or failed.
 */
export async function mainWith(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  deps: MainDeps,
): Promise<number> {
  const token = env[PROMOTE_TOKEN_ENV];
  delete env[PROMOTE_TOKEN_ENV];
  let line: string;
  let code = 0;
  try {
    const args = parseGateArgs(argv);
    const pushToken = token === undefined || token === '' ? null : token;
    if (args.push && pushToken === null) {
      throw new Error(`--push requires ${PROMOTE_TOKEN_ENV}`);
    }
    const remoteUrl = remoteUrlFor(
      env['GITHUB_SERVER_URL'] ?? 'https://github.com',
      args.owner,
      args.name,
    );
    const trust = resolveAcceptanceTrust(env);
    const policyDiff = createPolicyDiff(resolveProtectedPathsConfig({ env }));
    const gh = deps.makeGh();
    const result = await runGate(
      {
        gh,
        git: deps.git,
        acceptance: (input) =>
          judgeAcceptance({ gh, owner: args.owner, repo: args.name, policy: trust.policy }, input),
        policyDiff,
        sleep: deps.sleep,
        nowMs: deps.nowMs,
      },
      { ...args, pushToken, remoteUrl },
    );
    const report = [...trust.report.map((l) => `trust: ${l}`), ...result.report];
    line = JSON.stringify({ status: 'ok', value: { ...result, report } });
    if (result.verdict === 'refused') code = 1;
  } catch (error) {
    line = JSON.stringify({ status: 'failed', error: describeError(error) });
    code = 1;
  }
  deps.write(`${line}\n`);
  return code;
}

/** The CLI entry: {@link mainWith} over process.argv, process.env and the real deps. */
async function main(): Promise<void> {
  const code = await mainWith(process.argv.slice(2), process.env, {
    makeGh: () => makeGhRunner(),
    git: realGateGit,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    nowMs: () => Date.now(),
    write: (line) => process.stdout.write(line),
  });
  if (code !== 0) process.exitCode = code;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) await main();
