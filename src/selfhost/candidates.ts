// selfhost/candidates — PRODUCTION CANDIDATE FETCH for the repo's own PRs
// (goal T4.1 slice 1): the seam the scheduled workflows call instead of the
// live drills' scripted makeCandidateFetcher. Composition glue, not an op —
// the ONLY logic here is wire mapping (REST/GraphQL payloads → the merge
// family's MergePrsCandidate) and fail-closed bookkeeping; every judgment
// call stays downstream (classifyPr's decision table) or upstream (config).
//
// REUSE, NOT RE-IMPLEMENTATION: review-thread/review data rides the review
// family's fetchReviewState (its GraphQL pagination, page caps, and lag
// traps are already fail-closed and tested); transport and the --slurp page
// normalizer ride gh.ts's shared seam (ghJson, slurpedComments). This
// module adds exactly two new REST reads — the open-PR listing and the
// per-PR single-pull GET (the authoritative mergeable_state source) — and
// never touches GraphQL pagination itself.
//
// FAULT ISOLATION (the scheduled-run contract): one bad PR must not orphan
// the others. A PR whose enrichment (single-pull read, head-commit read, or
// fetchReviewState) fails is EXCLUDED with a one-line `fetch-failed: …`
// reason — never fabricated data, never a crashed run. The LISTING call is
// the exception: when it fails there is nothing to isolate — the throw
// propagates (an empty candidate set that pretends the forge said "nothing
// open" would be a fabricated success).
//
// THE #142 FORK CONTRACT: forked PRs are excluded outright and must be
// handled by a human — the self-hosted automation only ever works the base
// repository's own branches (its worktrees, its pushes, its review
// replies). Drafts are excluded for the same reason classifyPr rows them
// `never`: nothing merges uninvited.
import { fetchReviewState } from '../ops/review/fetchReviewState.js';
import { GhError, ghJson, ghNameOk, slurpedComments } from '../ops/review/gh.js';
import type { GhFn } from '../ops/review/gh.js';
import type { MergePrsCandidate } from '../ops/merge/runPrs.js';

/** The listing's page size (`per_page` on the REST listing read). */
const PER_PAGE = 100;

/**
 * Cap for the `fetch-failed: …` exclusion reason — an error (gh stderr, a
 * stack line) can spew pages into one line; the reason is a LOG FACT, not
 * the error itself. Mirrors review-loop's PUSH_REASON_MAX convention.
 */
const FETCH_REASON_MAX = 500;

/** A candidate rejected BEFORE enrichment, with the human-readable why. */
export interface ExcludedCandidate {
  /** The PR number (0 only when the listing row itself had no number). */
  pr: number;
  /** Stable, log-safe, title-less reason — never the PR body or error dump. */
  reason: string;
}

/**
 * The fetch's outcome: enriched candidates ready for makeMergePrsPlan's
 * input, plus every exclusion with its reason (the workflow log's audit
 * trail — a PR absent from BOTH lists would be a lie, so the pairing is
 * the contract).
 */
export interface CandidateFetchResult {
  /** Open, same-repo, non-draft PRs, fully enriched for merge.runPrs. */
  candidates: MergePrsCandidate[];
  /** Every listed PR that was NOT enriched, with the stable why. */
  excluded: ExcludedCandidate[];
}

/** The injected seams and repo coordinates. Plain data; no ambient access. */
export interface FetchMergeCandidatesDeps {
  /** The gh transport — the listing, head-commit, and review-state reads. */
  gh: GhFn;
  /** Repository owner (org or user login). */
  owner: string;
  /** Repository name. */
  repo: string;
  /**
   * The run's injected clock, reserved for the entry modules' uniform
   * time seam. The fetch itself is CLOCK-FREE (it maps wire payloads, it
   * classifies nothing) — downstream stages own every time comparison.
   */
  nowMs?: number;
}

// -- JSON-boundary helpers (structural casts, the e2e tests' pattern) -------

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const asString = (value: unknown): string => (typeof value === 'string' ? value : '');

/**
 * The PrCandidate mergeState union, from the REST `mergeable_state` wire
 * value: uppercased when the string is known, ANYTHING else — including a
 * future or misspelled state — maps to 'UNKNOWN' (which classifyPr's row 2
 * fails closed to `awaiting`). Never pass raw wire text downstream.
 */
const MERGE_STATES = ['DIRTY', 'BEHIND', 'CLEAN', 'UNKNOWN', 'HAS_HOOKS', 'BLOCKED'] as const;

const toMergeState = (raw: unknown): MergePrsCandidate['mergeState'] => {
  const upper = asString(raw).toUpperCase();
  return (MERGE_STATES as readonly string[]).includes(upper)
    ? (upper as MergePrsCandidate['mergeState'])
    : 'UNKNOWN';
};

/** First line of an error message, capped — the exclusion reason's raw material. */
const oneLine = (text: string): string => {
  const line = text.split('\n', 1)[0] ?? '';
  return line.length > FETCH_REASON_MAX ? line.slice(0, FETCH_REASON_MAX) : line;
};

/**
 * The REST open-PR listing's raw result: the slurped pages flattened to row
 * records, plus the listing's truncation flag — always `false` BY CONTRACT.
 * The listing read is UNBOUNDED (`--paginate`: there is no page cap), and a
 * full last page is not a truncation signal — gh simply issues another
 * request, so a final page of exactly PER_PAGE rows is an ordinary outcome
 * (a heuristic flagging it would mislabel a fully-paginated fetch as
 * truncated forever, classifying every candidate `awaiting` on every run).
 * Truncation doubt enters a candidate only from the enrichment fetch layer
 * (fetchReviewState's page-cap/lag flags) — the one place a real cap
 * exists. The one read both consumers share: fetchMergeCandidates
 * (enrichment input) and listOpenPrs (the review-loop entry's slim view).
 */
interface OpenPullListing {
  rows: Array<Record<string, unknown>>;
  /** Always false — unbounded pagination carries no listing truncation. */
  truncated: boolean;
}

/**
 * The shared REST listing: `repos/{owner}/{repo}/pulls?state=open` at
 * `per_page=100`, `--paginate --slurp`, normalized by gh.ts's shared
 * slurpedComments guard. Owner/repo are validated against the shared
 * ghNameOk charset + dot-segment rule before any path is built. THROWS when
 * the listing itself fails (GhError or an unparseable payload) — with no
 * page of truth there is no honest result to return (the module-doc
 * fault-isolation exception).
 */
const listOpenPulls = async (deps: {
  gh: GhFn;
  owner: string;
  repo: string;
}): Promise<OpenPullListing> => {
  const { gh, owner, repo } = deps;
  if (!ghNameOk(owner) || !ghNameOk(repo)) {
    throw new Error(
      `selfhost listing: owner/repo must match the gh name charset (never "." or "..") — got owner ${JSON.stringify(owner)}, repo ${JSON.stringify(repo)}`,
    );
  }
  const listPath = `repos/${owner}/${repo}/pulls?state=open&per_page=${String(PER_PAGE)}`;
  const rawList = await ghJson<unknown>(gh, ['api', listPath, '--paginate', '--slurp']);
  const pages = slurpedComments<unknown>(rawList, listPath);
  // No truncation signal exists on this read: `--paginate` is unbounded, so
  // a full last page is simply followed by another request — the flag stays
  // false by contract (see OpenPullListing); real truncation doubt comes
  // only from the enrichment fetch layer.
  return { rows: pages.flat().map(asRecord), truncated: false };
};

/**
 * The listing fields the review-loop entry consumes — structural facts only
 * (number, head ref, head repo, draft flag), no titles or bodies. `pr` is 0
 * when the row carried no usable number (the entry skips it; never guessed).
 */
export interface OpenPrListRow {
  pr: number;
  headRefName: string;
  /** head.repo.full_name verbatim ('' when the wire omitted it). */
  headRepoFullName: string;
  draft: boolean;
}

/**
 * List the repository's open PRs — the review-loop entry's ONE listing read,
 * the SAME REST argv pattern fetchMergeCandidates rides (shared
 * {@link listOpenPulls}, so pagination, slurp normalization, charset
 * validation, and the truncation flag can never drift between the two
 * consumers). No enrichment, no review-state reads: the loop does its own
 * fetching inside runReviewLoop.
 */
export async function listOpenPrs(deps: {
  gh: GhFn;
  owner: string;
  repo: string;
}): Promise<OpenPrListRow[]> {
  const listing = await listOpenPulls(deps);
  return listing.rows.map((pull) => {
    const prNumber = pull['number'];
    return {
      pr: typeof prNumber === 'number' && Number.isSafeInteger(prNumber) ? prNumber : 0,
      headRefName: asString(asRecord(pull['head'])['ref']),
      headRepoFullName: asString(asRecord(asRecord(pull['head'])['repo'])['full_name']),
      draft: pull['draft'] === true,
    };
  });
}

/**
 * Fetch the base repository's open, same-repo, non-draft PRs as fully
 * enriched MergePrsCandidates — the input makeMergePrsPlan's run needs,
 * built from a REAL forge instead of the drills' scripted fixtures.
 *
 * Reads, per run: ONE REST listing (`repos/{owner}/{repo}/pulls?state=open`
 * at `per_page=100`, `--paginate --slurp`, normalized by gh.ts's shared
 * slurpedComments guard) and, per surviving PR, the computed mergeability
 * (REST `…/pulls/{n}` — the single-PR endpoint; the list rows carry
 * mergeable_state only as a lazily-computed value that is frequently
 * unknown), the head-commit timestamp (REST `…/commits/{sha}` — committer
 * date, author date as the fallback) and the FULL review state via
 * fetchReviewState (GraphQL threads + reviews, REST reply chains; its
 * fail-closed `truncated` flag is OR-ed into the candidate so a capped or
 * lagging read can never read as complete). The listing read itself carries
 * NO truncation signal — `--paginate` is unbounded (a full last page is
 * followed by another request, never trusted as a final page), so its
 * truncation flag is false by contract and the candidate's truncation comes
 * ONLY from the enrichment fetch layer's real caps.
 *
 * Exclusions, in order: cross-repository forks (`head.repo.full_name` ≠
 * `{owner}/{repo}` — the #142 contract, reason names the head repo) and
 * drafts, gated TWICE — cheaply on the listing row before any read (a
 * forked or draft row costs zero enrichment), then RE-BOUND inside
 * enrichment to the fresh single-PR payload (the authoritative read — a row
 * that went stale between listing and GET loses to it; see the enrichment
 * comment). A PR whose enrichment throws is excluded with
 * `fetch-failed: <one line>` — isolated, never fatal to its siblings (see
 * the module doc). Owner/repo are validated against the shared ghNameOk
 * charset + dot-segment rule before any path is built.
 *
 * Throws ONLY when the listing itself fails (GhError or an unparseable
 * payload) — with no page of truth there is no honest result to return.
 */
export async function fetchMergeCandidates(
  deps: FetchMergeCandidatesDeps,
): Promise<CandidateFetchResult> {
  const { gh, owner, repo } = deps;
  // The ONE listing read (shared with listOpenPrs): validation, pagination,
  // and slurp normalization all live there. Its truncation flag is false by
  // contract (unbounded --paginate — see OpenPullListing) and is
  // deliberately NOT read here: the candidate's fail-closed truncation
  // comes only from the enrichment layer below.
  const { rows } = await listOpenPulls({ gh, owner, repo });

  const candidates: MergePrsCandidate[] = [];
  const excluded: ExcludedCandidate[] = [];

  for (const pull of rows) {
    const prNumber = pull['number'];
    const pr = typeof prNumber === 'number' && Number.isSafeInteger(prNumber) ? prNumber : 0;
    if (pr === 0) {
      excluded.push({ pr: 0, reason: 'fetch-failed: listing row without a PR number' });
      continue;
    }

    // Fork gate FIRST (the #142 contract), then the draft gate — both are
    // pre-enrichment so a forked or draft PR costs zero review-state reads.
    // These bind to the LISTING row (a cheap short-circuit); the same gates
    // re-bind to the authoritative single-PR payload below, inside
    // enrichment, because a row can go stale between listing and GET.
    const headRepoFullName = asString(asRecord(asRecord(pull['head'])['repo'])['full_name']);
    if (headRepoFullName !== `${owner}/${repo}`) {
      const shown = headRepoFullName === '' ? 'unknown' : headRepoFullName;
      excluded.push({
        pr,
        reason: `forked-pr (head repo ${shown}) — #142 contract: forked PRs are excluded and must be handled by a human`,
      });
      continue;
    }
    if (pull['draft'] === true) {
      excluded.push({ pr, reason: 'draft' });
      continue;
    }

    // Enrichment under per-PR fault isolation: a bad PR is excluded with a
    // one-line reason; the run (and its sibling PRs) carries on.
    try {
      // The SINGLE-PR endpoint (mirroring the live drill's fetchOne) is the
      // AUTHORITATIVE payload for every per-PR eligibility field: head
      // SHA/ref, base ref, draft flag, the fork gate's head repo,
      // mergeable_state, the PR's open/closed state, and the author login.
      // The LIST-pulls rows carry these only as-of listing
      // time — and mergeable_state there is additionally lazy (often
      // null/unknown until GitHub computes it) — so the mapping below rides
      // `pullWire`, never the row; a stale row (rebase, draft conversion,
      // fork retarget) loses to the fresh read, and convergence comes from
      // the next scheduled run re-reading it. `mergeable` rides the same
      // payload; a null/absent/uncomputed state needs no separate handling —
      // the mapping fails closed to 'UNKNOWN'.
      const pullWire = asRecord(
        await ghJson<unknown>(gh, ['api', `repos/${owner}/${repo}/pulls/${String(pr)}`]),
      );
      // The fork and draft gates RE-BOUND to the fresh payload (same
      // reasons, the authoritative fields): a PR that became a fork head or
      // a draft after the listing is excluded here, before any further
      // enrichment read.
      const wireHead = asRecord(pullWire['head']);
      const wireHeadRepo = asString(asRecord(wireHead['repo'])['full_name']);
      if (wireHeadRepo !== `${owner}/${repo}`) {
        const shown = wireHeadRepo === '' ? 'unknown' : wireHeadRepo;
        excluded.push({
          pr,
          reason: `forked-pr (head repo ${shown}) — #142 contract: forked PRs are excluded and must be handled by a human`,
        });
        continue;
      }
      if (pullWire['draft'] === true) {
        excluded.push({ pr, reason: 'draft' });
        continue;
      }
      const sha = asString(wireHead['sha']);
      let lastCommitAt: string | null = null;
      if (sha !== '') {
        const commitWire = asRecord(
          await ghJson<unknown>(gh, ['api', `repos/${owner}/${repo}/commits/${sha}`]),
        );
        const commitRecord = asRecord(commitWire['commit']);
        // Committer date is the drills' convention; the author date is the
        // fallback for wires that omit the committer block. Neither present
        // → null (PrCandidate's documented "unresolvable" case — classifyPr
        // row 4 fails closed on it; nothing is invented).
        lastCommitAt =
          asString(asRecord(commitRecord['committer'])['date']) ||
          asString(asRecord(commitRecord['author'])['date']) ||
          null;
      }

      const reviewState = await fetchReviewState({ owner, repo, pr }, undefined, gh);

      candidates.push({
        pr,
        // The author login rides the payload too (classifyPr's
        // external-thread/self-review rows key on it): a login re-authored
        // between listing and GET loses to the fresh read, same as every
        // other eligibility field above.
        authorLogin: asString(asRecord(pullWire['user'])['login']) || null,
        // Post-gate the payload's draft flag is false — but it rides the
        // authoritative payload, never a hardcoded assumption.
        draft: pullWire['draft'] === true,
        mergeState: toMergeState(pullWire['mergeable_state']),
        // Truncated is true ONLY from an actual truncation signal —
        // fetchReviewState's cap/lag flags, the one layer with a real page
        // cap. The listing read is unbounded (--paginate), so it carries no
        // listing truncation and nothing rides in from it (see
        // OpenPullListing's contract).
        truncated: reviewState.truncated,
        threads: reviewState.threads,
        reviews: reviewState.reviews,
        // The PR's flat general conversation (row 7's evidence); the flat
        // REST review comments are already folded into the threads' reply
        // chains by fetchReviewState itself.
        issueComments: reviewState.restIssueComments,
        lastCommitAt,
        headRefName: asString(wireHead['ref']),
        baseRefName: asString(asRecord(pullWire['base'])['ref']),
        // State rides the payload as well: a PR closed or merged between
        // the listing and this GET must not enter as open.
        state: asString(pullWire['state']) === 'open' ? 'open' : 'closed',
      });
    } catch (error) {
      const reason =
        error instanceof GhError
          ? `gh exit ${String(error.code)}: ${oneLine(error.stderr)}`
          : oneLine(error instanceof Error ? error.message : String(error));
      excluded.push({ pr, reason: `fetch-failed: ${reason}` });
    }
  }

  return { candidates, excluded };
}

/**
 * The workflow log's one-line-per-PR summary of a fetch result: STRUCTURAL
 * FACTS ONLY (numbers, flags, counts, refs, timestamps) — no titles, no
 * bodies, no author logins, no error dumps, so the lines are safe to emit
 * verbatim into scheduled-run logs. One string per candidate, then one per
 * exclusion, in result order; the caller joins with newlines.
 */
export function summarizeForLog(result: CandidateFetchResult): string[] {
  const lines = result.candidates.map(
    (candidate) =>
      `#${String(candidate.pr)} candidate state=${candidate.state} mergeState=${candidate.mergeState} ` +
      `draft=${String(candidate.draft)} truncated=${String(candidate.truncated)} ` +
      `threads=${String(candidate.threads.length)} reviews=${String(candidate.reviews.length)} ` +
      `issueComments=${String(candidate.issueComments.length)} ` +
      `head=${candidate.headRefName} base=${candidate.baseRefName} ` +
      `lastCommitAt=${candidate.lastCommitAt ?? 'unknown'}`,
  );
  for (const row of result.excluded) {
    lines.push(`#${String(row.pr)} excluded ${row.reason}`);
  }
  return lines;
}
