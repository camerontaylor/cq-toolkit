// review-loop — E4 slice 2 (goal E4; ws-e item 8): the SHIPPED review-loop
// plan wiring. Sequential stages, each a DIRECT call to the shipped atomic
// op; ONLY the fix fan-out rides runPlan (bounded, governor applies — the
// I8/I9 seam), because that is the one stage with N independent worker
// invocations. Everything else is plain sequential composition:
//
//   1. resolvePrWorktree       — THE per-PR worktree (origin head is truth)
//   2. snapshotPrState(before) — the anti-hallucination baseline
//      fetchReviewState → classifyThreads → planReviewBatch
//      (a TRUNCATED classification refuses here → needs-human with the
//      truncatedBecause reasons — an environment condition, never a crash;
//      any OTHER pure-stage throw propagates — a bug must look like one)
//   3. enrichment              — ClassifiedItem.id correlated against the
//      fetched state into FixableReviewItems (thread body + prior comments);
//      an id that no longer correlates (race) is recorded ('item-vanished')
//      and the unprocessed remainder of its batch is recorded too
//      ('batch-abandoned-item-vanished') — never silently dropped, never
//      fixed from suspect data; already-correlated siblings keep their fix
//      jobs. Races are NOT failures.
//   4. fix fan-out             — one runPlan job per ITEM (the fix op is
//      single-item by contract; the default isolated batches are one item
//      each, and a shared batch fans into per-item jobs dispatched at the
//      FORCED concurrency 1 — the sequencing contract planReviewBatch
//      asserts), op 'review.fixItem', ids fix-<n>, stopOnError false (one
//      bad item must not orphan the others' replies)
//   5. publish + verify        — when any fix produced commits, the loop
//      PUSHES `HEAD:<headRefName>` from the worktree first (git argv
//      composed exactly the way prWorktree composes argv: leading '-C',
//      worktree path; the refspec targets the PR'S REAL HEAD — the
//      worktree branch sits at the fetched origin sha, so the push is a
//      fast-forward), THEN takes the after-snapshot and runs
//      verifyPrOutcome — the push must precede the snapshot or the
//      verifier could never see the fix's own commit.
//      VERIFY STILL PRECEDES ANY POST: no gh mutation (reply/resolve) may
//      run before the after-snapshot argv (asserted by the smoke test's gh
//      call log). Skipped entirely when zero fix jobs ran (a re-run no-op
//      must not manufacture a NO PROGRESS verdict).
//   6. actions                 — per fix row, ok+changed+commits →
//      review_reply on its thread (summary + commit refs) + resolve_thread;
//      ok+unchanged → review_reply only (the honest "no change made"
//      answer), never a resolve; failed/needs-human/indeterminate rows →
//      no action, they feed hasFailures. RESOLVES ARE GATED PER ITEM on
//      locally-verified commits (rev-parse --verify + STRICT descendant of
//      the before-snapshot head + ancestor of the pushed HEAD, via the git
//      seam): origin REST lag cannot block a genuinely verified fix, and a
//      sibling's progress cannot prove another thread. The PR-wide
//      VerifyOutcome rides the outcome payload for OBSERVABILITY only — it
//      does not gate resolves and does not feed hasFailures.
//   7. replyAndResolve         — push-before-post (its push argv is the
//      same composed worktree push: an idempotent re-assertion against
//      origin races between the two moments), dispatch-log deduped.
//   8. outcome                 — any fix row not ok, a NO PROGRESS verify
//      (when fixes were attempted), reply failures/withheld, or the step-2
//      refusal → needs-human with reasons[]; a clean loop → ok. Unexpected
//      throws PROPAGATE — never swallowed into ok (I5).
//
// WHY A BUILDER + THIS WIRING (the src/plans convention, recorded for lane
// E): the frozen Job schema has no cross-job data channel — a Job's input is
// static JSON — so a review-loop plan for a REAL PR cannot exist before its
// review state is fetched. Shipped plans are therefore parameterized
// BUILDERS (buildReviewLoopPlan over enriched fix inputs) plus this wiring
// (runReviewLoop); the registry entry carries the one valid degenerate
// instance — the empty plan — so discovery, parsing, and the run-plan
// subcommand all have an honest artifact for the name.
//
// Seams (all injected): gh (the review/mutation transport), git (the
// worktree/push transport — the caller composes makeGhRunner({bin:'git'})),
// the WorktreeRegistry, and an optional driver OpRegistryView (the fix op
// comes from a registry so the governed runner dispatches it exactly like
// the CLI does; the default view is the central registry built exactly the
// way run-plan builds its view).
import type { Budget, ModelSpec } from '../driver/types.js';
import type { HarnessConfig } from '../harness/config.js';
import {
  BudgetGovernor,
  governRegistry,
  governorConfig,
  withBudgetStop,
} from '../kernel/governor.js';
import { runPlan, type OpRegistryView } from '../kernel/runner.js';
import type {
  Job,
  OpRegistryEntry,
  Plan,
  PlanRegistryEntry,
  RunOptions,
  RunReport,
} from '../kernel/types.js';
import { list } from '../registry/index.js';
import type { ClassifyConfig } from '../ops/review/classify.config.js';
import { defaultClassifyConfig } from '../ops/review/classify.config.js';
import type { ClassifiedItem } from '../ops/review/classifyThreads.js';
import { classifyThreads } from '../ops/review/classifyThreads.js';
import type { FetchedReviewState } from '../ops/review/fetchReviewState.js';
import { fetchReviewState } from '../ops/review/fetchReviewState.js';
import type { GhFn } from '../ops/review/gh.js';
import type {
  FixableReviewItem,
  FixReviewItemInput,
  FixReviewItemResult,
} from '../ops/review/fixReviewItem.js';
import type { PlanBatchConfig, PlannedBatch } from '../ops/review/planReviewBatch.js';
import { defaultPlanBatchConfig, planReviewBatch } from '../ops/review/planReviewBatch.js';
import type { WorktreeRegistry } from '../ops/review/prWorktree.js';
import { resolvePrWorktree } from '../ops/review/prWorktree.js';
import type { ReplyAndResolveResult, ReviewAction } from '../ops/review/replyAndResolve.js';
import { fileDispatchLog, replyAndResolve } from '../ops/review/replyAndResolve.js';
import type { VerifyOutcome } from '../ops/review/verifyReviewOutcome.js';
import { snapshotPrState, verifyPrOutcome } from '../ops/review/verifyReviewOutcome.js';

/** Cap for the composed push-failure reason — a push can spew pages of output. */
const PUSH_REASON_MAX = 500;

/** Everything runReviewLoop needs — plain data plus the injected seams. */
export interface ReviewLoopOpts {
  /** Repository owner (org or user login). */
  owner: string;
  /** Repository name. */
  repo: string;
  /** Pull request number. */
  pr: number;
  /** The PR's head branch name (origin truth, from the fetch upstream). */
  headRefName: string;
  /** The checked-out repository root resolvePrWorktree anchors to. */
  repoRoot: string;
  /** The gh transport — review reads, replies, and resolves ride it. */
  gh: GhFn;
  /** The git transport — worktree resolution and pushes (makeGhRunner({bin:'git'})). */
  git: GhFn;
  /** The PR → worktree registry (persistence seam behind the worktree stage). */
  registry: WorktreeRegistry;
  /**
   * Model identity for the fix workers (ModelSpec data on every fix input).
   * Caller-chosen — the loop never bakes in a vendor choice (I1).
   */
  driver: ModelSpec;
  /**
   * The op registry the fix jobs dispatch through. Default: the central
   * registry view, built exactly the way run-plan builds it. Tests inject a
   * view whose 'review.fixItem' binds a scripted Driver — a dispatch through
   * the default view would spawn a real worker.
   */
  driverRegistryView?: OpRegistryView;
  /** Classify tuning (R3 data). Default: defaultClassifyConfig. */
  classifyConfig?: ClassifyConfig;
  /** Batch planning config. Default: defaultPlanBatchConfig (isolated, I6). */
  planBatchConfig?: PlanBatchConfig;
  /** Per-op harness config riding every fix input (R4 data). Default: the fix op's own. */
  harness?: HarnessConfig;
  /** Replaces the shipped fixer prompt wholesale (R3 data), when set. */
  promptOverride?: string;
  /** Budget caps attached to every fix invocation. */
  fixBudget?: Budget;
  /**
   * RunOptions overlay for the fix run. `concurrency` is NOT settable — the
   * loop forces 1 (the shared-per-PR-worktree sequencing contract); there is
   * no resume in v1 wiring (journalDir is an audit trail, not a resume key).
   */
  runOptions?: { journalDir?: string; maxUsd?: number; maxTokens?: number };
  /** The responder login for verify's strict attribution (null/absent = author-blind). */
  responderLogin?: string | null;
  /** The injected clock stamping snapshots, registry entries, and dispatch records. */
  nowMs: number;
  /** Path of the file-backed dispatch log (the reply/resolve dedupe memory). */
  dispatchLogPath: string;
  /** Root for the PR worktree (default: resolvePrWorktree's own). */
  worktreeRoot?: string;
}

/** The loop's terminal report. Plain JSON; `ok` only when every stage came back clean. */
export interface ReviewLoopOutcome {
  /** 'ok' only when no stage recorded a failure; 'needs-human' otherwise. */
  status: 'ok' | 'needs-human';
  /** One human-readable line per failure (empty when ok). */
  reasons: string[];
  /** The resolved per-PR worktree. */
  worktree: { path: string; branch: string; reused: boolean };
  /** The planned batches (as planReviewBatch produced them, pre-enrichment). */
  batches: PlannedBatch[];
  /** Batches dropped at enrichment, with the reason ('item-vanished' races). NOT failures. */
  skipped: Array<{ id: string; reason: string }>;
  /** The fix plan the loop built (empty jobs when nothing was actionable). */
  plan: Plan;
  /**
   * The governed fix-run report. Absent ONLY when the loop refused before
   * the fix stage (the step-2 truncated-classification refusal) — no fix
   * run existed to report on, and a fabricated zero-report would pretend
   * one did.
   */
  fixReport?: RunReport;
  /**
   * The before/after verdict — present exactly when at least one fix job
   * ran. OBSERVABILITY ONLY: it rides the payload for humans; resolve
   * gating is per-item commit verification, and this verdict never feeds
   * `reasons`.
   */
  verify?: VerifyOutcome;
  /** The reply/resolve dispatch result — present when any action was dispatched. */
  reply?: ReplyAndResolveResult;
  /** How many actions replyAndResolve actually posted (its `posted` length). */
  actionsPosted: number;
}

/**
 * What the loop remembers per fix job so the action builder can map a row
 * back to its conversation: the item's kind, and — for threads — the ROOT
 * REST id a review_reply must anchor to (ReviewThread.rootDatabaseId; null
 * = unanchorable, recorded as a failure reason, never guessed around).
 */
export interface EnrichedSource {
  itemId: string;
  kind: ClassifiedItem['kind'];
  threadRootRestId: number | null;
}

/** One correlation result: the fixer payload plus the action-builder source. */
export interface EnrichedFixItem {
  source: EnrichedSource;
  item: FixableReviewItem;
}

/**
 * Correlate one ClassifiedItem against the fetched state and build the
 * fixer's FixableReviewItem (the prompt payload: body + prior comments).
 * Thread items carry the thread body and its replies; review-summary and
 * top-level-comment items carry their body with no comment thread (they are
 * whole-PR feedback, not conversations). Null when the id no longer
 * correlates — a race between fetch and fix (the item vanished upstream).
 */
const enrichItem = (item: ClassifiedItem, state: FetchedReviewState): FixableReviewItem | null => {
  if (item.kind === 'thread') {
    const thread = state.threads.find((candidate) => candidate.id === item.id);
    if (thread === undefined) {
      return null;
    }
    return {
      id: thread.id,
      path: thread.path,
      line: thread.line,
      body: thread.body,
      comments: thread.replies,
    };
  }
  if (item.kind === 'review') {
    const review = state.reviews.find((candidate) => candidate.id === item.id);
    if (review === undefined) {
      return null;
    }
    return { id: review.id, path: null, line: null, body: review.body, comments: [] };
  }
  const comment = state.restIssueComments.find((candidate) => String(candidate.id) === item.id);
  if (comment === undefined) {
    return null;
  }
  return { id: String(comment.id), path: null, line: null, body: comment.body, comments: [] };
};

/**
 * Correlate every planned item of every batch against the fetched state
 * (stage 3 of the module doc), batch by batch, in order. Per batch:
 *   - a correlated item joins `items` — it gets a fix job;
 *   - an item that no longer correlates (a race — it vanished upstream) is
 *     recorded with reason 'item-vanished', and every item AFTER it in the
 *     same batch is recorded with reason 'batch-abandoned-item-vanished':
 *     the race makes the rest of the batch's correlation data suspect, so
 *     unprocessed siblings are recorded, never silently dropped, and never
 *     fixed from suspect data (the next run re-plans them) — while
 *     ALREADY-correlated siblings keep their fix jobs;
 *   - then the batch is done (the vanished item terminates it).
 * A 1:1 isolated batch that vanishes therefore yields exactly one
 * 'item-vanished' row and no jobs — a no-op against the previous
 * wholesale-skip behavior, by construction.
 */
export function enrichBatches(
  batches: PlannedBatch[],
  state: FetchedReviewState,
): { items: EnrichedFixItem[]; skipped: Array<{ id: string; reason: string }> } {
  const items: EnrichedFixItem[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  for (const batch of batches) {
    let index = 0;
    for (const planned of batch.items) {
      const item = enrichItem(planned, state);
      if (item === null) {
        skipped.push({ id: planned.id, reason: 'item-vanished' });
        for (const rest of batch.items.slice(index + 1)) {
          skipped.push({ id: rest.id, reason: 'batch-abandoned-item-vanished' });
        }
        break;
      }
      const threadRootRestId =
        planned.kind === 'thread'
          ? (state.threads.find((candidate) => candidate.id === planned.id)?.rootDatabaseId ?? null)
          : null;
      items.push({
        item,
        source: { itemId: planned.id, kind: planned.kind, threadRootRestId },
      });
      index += 1;
    }
  }
  return { items, skipped };
}

/**
 * Build the fix plan: one job per fix input, op 'review.fixItem', ids
 * `fix-<n>` (1-based, input order). The builder is the parameterized plan
 * (module doc, WHY A BUILDER); runReviewLoop calls it with the enriched
 * per-item inputs, and the registry entry calls it with the empty list.
 */
export function buildReviewLoopPlan(fixInputs: FixReviewItemInput[]): Plan {
  return {
    id: 'review-loop',
    jobs: fixInputs.map((input, index): Job => ({
      id: `fix-${index + 1}`,
      op: 'review.fixItem',
      input,
    })),
  };
}

/**
 * The default driver view: the central registry, adapted exactly the way
 * run-plan adapts it (src/cli/run-plan.ts — the view is typed at the bottom
 * instantiation <never, never> while registry entries are <unknown,
 * unknown>, and unknown does not widen down to never; the runner only ever
 * calls parseAsync/importer through the bottom instantiation).
 */
const centralRegistryView = async (): Promise<OpRegistryView> => {
  const entries = await list();
  const entryByName = new Map(entries.map((entry) => [entry.name, entry]));
  return {
    get: (name) => entryByName.get(name) as OpRegistryEntry<never, never> | undefined,
  };
};

/**
 * The composed worktree push — the git argv that publishes the fix,
 * mirroring prWorktree's argv composition exactly: a leading `-C <path>`
 * (the runner spawns with the process cwd; effect comes only from the
 * explicit prefix), then `push origin HEAD:<headRefName>` — the PR'S REAL
 * HEAD (finding: the internal `cq-review/pr-<n>` worktree label would leave
 * origin's PR untouched, so the verifier could never see the fix, and a
 * stray branch accumulates on origin). The worktree branch sits AT the
 * fetched origin sha, so the push is a fast-forward; a raced origin refuses
 * it — the push failure feeds the existing push-before-post retriable path.
 * Used BOTH for the fix-stage publish (so the verifier can see the fix's
 * own commit) and as replyAndResolve's push-before-post args (an idempotent
 * re-assertion).
 */
const worktreePushArgs = (worktreePath: string, headRefName: string): string[] => [
  '-C',
  worktreePath,
  'push',
  'origin',
  `HEAD:${headRefName}`,
];

/**
 * Verify one claimed commit through the git seam IN THE PUSHED WORKTREE,
 * strictly mechanically (exit codes only): the sha must resolve to a commit
 * (`rev-parse --verify <sha>^{commit}`) AND be an ancestor of the worktree
 * HEAD (`merge-base --is-ancestor <sha> HEAD`) — the worktree HEAD is the
 * exact tree the stage-5 publish pushed. The per-item resolve gate rides
 * THIS check, never the global snapshot: a hallucinated sha must not hide
 * its thread, and a real one must not wait on a lagging origin read.
 */
const COMMIT_SHA_RE = /^[0-9a-f]{40}$/i;

/**
 * Verify one claimed commit through the git seam IN THE PUSHED WORKTREE,
 * strictly mechanically (exit codes only), hardened against spoofing
 * (round-2 finding 2):
 *   - the candidate must BE a full 40-hex sha — the literal "HEAD" and
 *     short shas are rejected before any git call;
 *   - `rev-parse --verify <sha>^{commit}` must succeed (it exists here);
 *   - `merge-base --is-ancestor <before.headSha> <sha>` must exit 0 with
 *     the sha DISTINCT from the before-snapshot head — a STRICT descendant:
 *     the pre-existing base commit is not a fix;
 *   - `merge-base --is-ancestor <sha> HEAD` must exit 0 (the worktree HEAD
 *     is the exact tree the stage-5 publish pushed).
 */
const commitInPushedHead = async (
  git: GhFn,
  worktreePath: string,
  sha: string,
  baseSha: string,
): Promise<boolean> => {
  if (!COMMIT_SHA_RE.test(sha)) {
    return false;
  }
  if (sha.toLowerCase() === baseSha.toLowerCase()) {
    return false; // STRICT descendant: the before-head itself is not a fix
  }
  const verify = await git(['-C', worktreePath, 'rev-parse', '--verify', `${sha}^{commit}`]);
  if (verify.code !== 0) {
    return false;
  }
  const descendant = await git(['-C', worktreePath, 'merge-base', '--is-ancestor', baseSha, sha]);
  if (descendant.code !== 0) {
    return false;
  }
  const ancestor = await git(['-C', worktreePath, 'merge-base', '--is-ancestor', sha, 'HEAD']);
  return ancestor.code === 0;
};

/**
 * Run the full review loop (module doc, stage table). Sequential and
 * fail-toward-human: every recorded failure lands in `reasons` and the
 * outcome degrades to needs-human; nothing here invents progress or hides
 * a thread that was not verifiably addressed. Unexpected throws propagate —
 * a bug must look like one (I5).
 */
export async function runReviewLoop(opts: ReviewLoopOpts): Promise<ReviewLoopOutcome> {
  const reasons: string[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];

  // (1) THE per-PR worktree — origin head is truth, re-verified inside.
  const worktree = await resolvePrWorktree({
    repoRoot: opts.repoRoot,
    pr: opts.pr,
    headRefName: opts.headRefName,
    run: opts.git,
    registry: opts.registry,
    nowMs: opts.nowMs,
    ...(opts.worktreeRoot !== undefined ? { worktreeRoot: opts.worktreeRoot } : {}),
  });

  // (2) Baseline snapshot, then the pure pipeline. The truncation refusal is
  // a fail-closed ENVIRONMENT condition (fresh threads are missing from the
  // verdict set): needs-human with the recorded causes — never a crash, and
  // never planned-upon. Every other pure-stage throw propagates.
  const before = await snapshotPrState({
    owner: opts.owner,
    repo: opts.repo,
    pr: opts.pr,
    run: opts.gh,
    nowMs: opts.nowMs,
  });
  const state = await fetchReviewState(
    { owner: opts.owner, repo: opts.repo, pr: opts.pr },
    undefined,
    opts.gh,
  );
  const classification = classifyThreads(
    state,
    opts.nowMs,
    opts.classifyConfig ?? defaultClassifyConfig,
  );
  if (classification.truncated) {
    return {
      status: 'needs-human',
      reasons: [...classification.truncatedBecause],
      worktree: { path: worktree.path, branch: worktree.branch, reused: worktree.reused },
      batches: [],
      skipped,
      plan: buildReviewLoopPlan([]),
      actionsPosted: 0,
    };
  }
  const batches = planReviewBatch(classification, opts.planBatchConfig ?? defaultPlanBatchConfig);

  // (3) Enrich every planned item into the fixer payload. One job per ITEM
  // (the fix op is single-item by contract); vanished races are RECORDED,
  // never silently dropped (see enrichBatches for the per-batch policy).
  const { items: correlated, skipped: vanishedRows } = enrichBatches(batches, state);
  skipped.push(...vanishedRows);
  const fixInputs: FixReviewItemInput[] = [];
  const sources = new Map<string, EnrichedSource>();
  for (const entry of correlated) {
    sources.set(`fix-${fixInputs.length + 1}`, entry.source);
    fixInputs.push({
      repo: `${opts.owner}/${opts.repo}`,
      pr: opts.pr,
      item: entry.item,
      worktree: { path: worktree.path, branch: worktree.branch },
      driver: opts.driver,
      ...(opts.harness !== undefined ? { harness: opts.harness } : {}),
      ...(opts.promptOverride !== undefined ? { promptOverride: opts.promptOverride } : {}),
      ...(opts.fixBudget !== undefined ? { budget: opts.fixBudget } : {}),
    });
  }

  // (4) The governed fix run. concurrency is FORCED to 1 (the shared
  // per-PR-worktree sequencing contract) and stopOnError is false (one bad
  // item must not orphan the others' replies). No resume in v1: journalDir
  // is an audit trail only.
  const plan = buildReviewLoopPlan(fixInputs);
  const view = opts.driverRegistryView ?? (await centralRegistryView());
  const runOptions: RunOptions = {
    concurrency: 1,
    stopOnError: false,
    ...(opts.runOptions?.journalDir !== undefined
      ? { journalDir: opts.runOptions.journalDir }
      : {}),
    ...(opts.runOptions?.maxUsd !== undefined ? { maxUsd: opts.runOptions.maxUsd } : {}),
    ...(opts.runOptions?.maxTokens !== undefined ? { maxTokens: opts.runOptions.maxTokens } : {}),
  };
  const governor = new BudgetGovernor(governorConfig(runOptions, {}));
  const fixReport = withBudgetStop(
    await runPlan(plan, runOptions, governRegistry(view, governor)),
    plan,
    governor,
  );

  // (5) Publish, then verify. The fix commits are LOCAL until pushed, so the
  // loop pushes the worktree branch BEFORE the after-snapshot — otherwise
  // the verifier could never observe the fix's own commit (and would
  // condemn every honest fix to NO PROGRESS). VERIFY STILL PRECEDES ANY
  // POST: the gh mutation log must start only after this snapshot (the
  // smoke test pins the order). Skipped when zero fix jobs ran — a re-run
  // no-op must not manufacture a verdict.
  const commits = fixReport.jobs.flatMap((row) =>
    row.result.status === 'ok' ? (row.result.value as FixReviewItemResult).commits : [],
  );
  if (commits.length > 0) {
    const push = await opts.git(worktreePushArgs(worktree.path, opts.headRefName));
    if (push.code !== 0) {
      const stderr = push.stderr.trim();
      reasons.push(
        `push failed (exit ${String(push.code)})${stderr === '' ? '' : `: ${stderr.slice(0, PUSH_REASON_MAX)}`}`,
      );
    }
  }
  const fixJobsRan = plan.jobs.length > 0;
  let verify: VerifyOutcome | undefined;
  if (fixJobsRan) {
    const after = await snapshotPrState({
      owner: opts.owner,
      repo: opts.repo,
      pr: opts.pr,
      run: opts.gh,
      nowMs: opts.nowMs,
    });
    verify = verifyPrOutcome(before, after, { responderLogin: opts.responderLogin ?? null });
    // VerifyOutcome is OBSERVABILITY ONLY (round-2 finding 6): it rides the
    // outcome payload and never feeds hasFailures — resolve gating is the
    // per-item commit verification, and one thread's missing PR-wide signal
    // (REST lag, an unrelated sibling) must not condemn the whole loop.
  }

  // (6) Actions from the fix rows. ok+changed+commits → reply + resolve;
  // ok+unchanged → reply only (the honest no-change answer), never a
  // resolve; non-ok rows → nothing, they feed hasFailures. RESOLVES ARE
  // GATED PER ITEM on locally-verified commits (see the module doc) — the
  // PR-wide VerifyOutcome is observability only. actionIds are stable
  // coordinates (pr + item id) so a re-run dedupes against the dispatch
  // log.
  const actions: ReviewAction[] = [];
  for (const row of fixReport.jobs) {
    if (row.result.status !== 'ok') {
      const detail =
        row.result.status === 'failed'
          ? row.result.error
          : row.result.status === 'needs-human'
            ? row.result.reason
            : row.result.status === 'indeterminate'
              ? row.result.detail
              : 'budget cap hit';
      reasons.push(`fix job ${row.jobId} ended ${row.result.status}: ${detail}`);
      continue;
    }
    const source = sources.get(row.jobId);
    if (source === undefined) {
      continue; // unreachable: one source per built job, same order
    }
    const value = row.result.value as FixReviewItemResult;
    const body =
      value.changed && value.commits.length > 0
        ? `${value.summary}\n\nCommits: ${value.commits.join(' ')}`
        : value.summary;
    if (source.kind === 'thread') {
      // A reply must anchor to the thread's ROOT REST id; a thread whose
      // root is unanchorable (null rootDatabaseId) is recorded as a failure
      // reason — never guessed around (no reply, no resolve).
      if (source.threadRootRestId === null) {
        reasons.push(
          `thread ${source.itemId} has no root REST id — the conversation cannot be anchored for a reply`,
        );
        continue;
      }
      actions.push({
        kind: 'review_reply',
        actionId: `review-loop:${String(opts.pr)}:reply:${source.itemId}`,
        threadRootRestId: source.threadRootRestId,
        body,
      });
      // Only a THREAD can resolve (a review summary / top-level comment has
      // no resolvable thread node) — and only through the PER-ITEM gate:
      // at least one reported commit must be verifiable in the pushed
      // worktree (commitInPushedHead). The resolve never rides the global
      // snapshot alone: a hallucinated sha must not hide its thread (the
      // reply still posts — the summary reports what the worker claimed),
      // and the withheld resolve is recorded as a per-item failure reason.
      if (value.changed && value.commits.length > 0) {
        let verified = false;
        for (const sha of value.commits) {
          if (await commitInPushedHead(opts.git, worktree.path, sha, before.headSha)) {
            verified = true;
            break;
          }
        }
        if (verified) {
          actions.push({
            kind: 'resolve_thread',
            actionId: `review-loop:${String(opts.pr)}:resolve:${source.itemId}`,
            threadId: source.itemId,
          });
        } else {
          reasons.push(
            `thread ${source.itemId}: unverified-commits — no reported commit resolves in the pushed worktree HEAD; resolve withheld, reply posted`,
          );
        }
      }
    } else {
      // Whole-PR feedback (review summary / top-level comment): the honest
      // reply rides the top-level issues collection; nothing to resolve.
      actions.push({
        kind: 'issue_comment',
        actionId: `review-loop:${String(opts.pr)}:reply:${source.itemId}`,
        body,
      });
    }
  }

  // (7) Reply + resolve over the gh seam — push-before-post (the same
  // composed worktree push: an idempotent re-assertion against origin races
  // between the fix-stage publish and this moment), dispatch-log deduped.
  // Zero actions → nothing to run: a re-run no-op stays a true no-op (no
  // push, no log writes).
  let reply: ReplyAndResolveResult | undefined;
  if (actions.length > 0) {
    reply = await replyAndResolve(actions, {
      owner: opts.owner,
      repo: opts.repo,
      pr: opts.pr,
      run: opts.gh,
      push:
        commits.length > 0
          ? { run: opts.git, args: worktreePushArgs(worktree.path, opts.headRefName) }
          : null,
      dispatchLog: fileDispatchLog(opts.dispatchLogPath),
      nowMs: opts.nowMs,
    });
    for (const failure of reply.failed) {
      reasons.push(
        `dispatch failed (${failure.action.kind} ${failure.action.actionId}): ${failure.error}`,
      );
    }
    if (reply.withheld > 0) {
      reasons.push(
        `dispatch withheld ${String(reply.withheld)} resolve(s) — a sibling reply failed; they retry once the reply lands`,
      );
    }
    // A failed reply-stage push means NOTHING posted (push-before-post) —
    // silently returning ok here would report a dispatched loop that
    // answered nobody (Codex P1): needs-human, retriable on the next run.
    if (reply.pushed === false) {
      reasons.push(`dispatch push failed: ${reply.pushError ?? 'unknown error'}`);
    }
  }

  // (8) The verdict: clean stages → ok; anything recorded → needs-human.
  return {
    status: reasons.length === 0 ? 'ok' : 'needs-human',
    reasons,
    worktree: { path: worktree.path, branch: worktree.branch, reused: worktree.reused },
    batches,
    skipped,
    plan,
    fixReport,
    ...(verify !== undefined ? { verify } : {}),
    ...(reply !== undefined ? { reply } : {}),
    actionsPosted: reply === undefined ? 0 : reply.posted.length,
  };
}

/**
 * The plan-registry entry (src/plans/registry.ts convention): the named,
 * valid, EMPTY instance of the review-loop plan (module doc, WHY A BUILDER).
 * Real plans are built per-run by buildReviewLoopPlan over enriched fix
 * inputs — the frozen Job schema has no cross-job data channel, so a
 * parameterized PR's plan cannot exist before its review state is fetched.
 */
export const plan: PlanRegistryEntry = {
  name: 'review-loop',
  importer: async () => buildReviewLoopPlan([]),
};
