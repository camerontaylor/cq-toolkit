// Review family registry — E4 slices 1 + 1b: the SIX review-loop op entries
// (`review.fixItem`, `review.fetchReviewState`, `review.classifyThreads`,
// `review.planReviewBatch`, `review.replyAndResolve`,
// `review.verifyReviewOutcome`), typed against the FROZEN OpRegistryEntry
// (src/kernel/types.ts), mirroring src/ops/gates/registry.ts. The zod
// schemas are registry-time mirrors of the ops' inputs and live HERE (the
// shared spot — the gates precedent, src/ops/README.md's family-registry
// convention) because `inputSchema` must exist eagerly while the ops may be
// lazy. Module scope imports only zod, kernel types, and TYPES from the
// family modules (type-only imports are erased at compile time): loading
// the registry never loads an op module, the driver, or the gh transport.
//
// ADAPTER RULE — the §5 loop ops are LIBRARY functions, not Op-shaped: they
// take several parameters, throw their fail-loud contracts, and return
// plain values. Each importer therefore wraps its library call in a minimal
// adapter op ({@link awaitOp}): JSON input in → library call → `ok` with
// the value; a THROWN error is that module's DESIGNED fail-loud contract
// (input validation, planReviewBatch's truncated-classification refusal, a
// GhError) → `failed` carrying the message verbatim. No adapter invents
// policy beyond that mechanical fold, and no failure these adapters can
// observe is a "could not tell" — every throw is a definitive refusal — so
// `indeterminate` is reserved away (a crashed driver/worker is fixItem's
// business, not these pure/transport folds).
//
// RUNTIME DEPENDENCIES ARE BOUND AT IMPORTER TIME from JSON data on the
// input (the gates importer-binds-dependencies precedent — no op wiring at
// registry module scope): gh-consuming ops get `makeGhRunner()`, and
// replyAndResolve gets `fileDispatchLog(<input.dispatchLogPath>)` plus its
// optional push argv. BOTH constructions are inert by source: makeGhRunner
// returns a closure (it reads CQ_GH_BIN and spawns only when the returned
// runner is CALLED) and fileDispatchLog closes over the path (I/O only on
// load/record) — so resolving any entry never touches env, the network, or
// the filesystem.
//
// REGEXP-AS-DATA: ClassifyConfig.skipPatterns is RegExp[] upstream — not
// JSON-serializable — so the classifyThreads mirror carries regex SOURCES
// ({pattern, flags}) and the adapter compiles them exactly the way the
// table reads them: `g`/`y` stripped (a stateful RegExp carries lastIndex
// across .test() calls — the same strip classifyThreads itself applies) and
// default flags 'im' (the shipped patterns' line-anchoring flags). A source
// that does not compile throws SyntaxError inside the adapter → `failed`
// (the hackDetector precedent for non-compiling regex config).
//
// FAMILY SURFACE, NOT OPS: ./threads.js is the shared thread vocabulary
// (mirrored here as schemas), ./classify.config.js the R3 tuning data the
// classify mirror shapes, and ./prWorktree.js — the per-PR worktree
// resolver — is PLAN-WIRING SURFACE, deliberately not a registry op:
// worktree resolution is dispatched around fix jobs by the plan layer, it
// is not a JSON-dispatchable operation. (The './prWorktree.js' specifier in
// this paragraph is the family-completeness reference: a module the family
// explicitly declares surface, per the coverage heuristic's
// referenced-module rule.)
import { z } from 'zod';
import { HarnessConfigSchema } from '../../harness/config.js';
import type { Op, OpRegistryEntry } from '../../kernel/types.js';
import type { ClassifyConfig } from './classify.config.js';
import type { ClassifiedItem, Classification } from './classifyThreads.js';
import type { FixableReviewItem, FixReviewItemInput } from './fixReviewItem.js';
import type { FetchedReviewState } from './fetchReviewState.js';
import type { PlanBatchConfig } from './planReviewBatch.js';
import type { ReviewAction } from './replyAndResolve.js';
import type { RestComment, ReviewSummary, ReviewThread, ThreadComment } from './threads.js';
import type { PrSnapshot } from './verifyReviewOutcome.js';

// ---------------------------------------------------------------------------
// Adapter helpers — the one fold every library op rides (module doc)
// ---------------------------------------------------------------------------

/** Error message of an unknown throwable, for `failed` adapters. */
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Wrap one library call as an Op (the ADAPTER RULE, module doc): the
 * returned value → `ok`; a thrown fail-loud contract → `failed` with the
 * message verbatim. Accepts sync and async library functions alike.
 */
const awaitOp =
  <I, R>(fn: (input: I) => R | Promise<R>): Op<I, R> =>
  async (input: I) => {
    try {
      return { status: 'ok', value: await fn(input) };
    } catch (err) {
      return { status: 'failed', error: messageOf(err) };
    }
  };

// ---------------------------------------------------------------------------
// Shared vocabulary mirrors — the threads.ts shapes, field-derived
// ---------------------------------------------------------------------------

/** Registry-time mirror of {@link ThreadComment}: the full comment, and only it. */
const ThreadCommentSchema: z.ZodType<ThreadComment> = z
  .object({
    authorLogin: z.string().nullable(),
    // NO min(1): the mirror must accept what the family actually produces.
    body: z.string(),
    createdAt: z.string().nullable(),
  })
  .strict();

/** Registry-time mirror of {@link RestComment}: the full REST comment, and only it. */
const RestCommentSchema: z.ZodType<RestComment> = z
  .object({
    id: z.number().int(),
    nodeId: z.string().nullable(),
    authorLogin: z.string().nullable(),
    body: z.string(),
    createdAt: z.string().nullable(),
    inReplyToId: z.number().int().nullable(),
  })
  .strict();

/**
 * Registry-time mirror of {@link ReviewThread}: the full thread, and only
 * it. `body` carries NO min(1) on purpose — fetchReviewState maps a thread
 * whose root comment was deleted to `body: ''`, and the mirror must accept
 * what the fetch actually produces (round-trip honesty, not the ideal
 * shape).
 */
const ReviewThreadSchema: z.ZodType<ReviewThread> = z
  .object({
    id: z.string().min(1),
    rootDatabaseId: z.number().int().nullable(),
    path: z.string().nullable(),
    line: z.number().int().nullable(),
    isResolved: z.boolean(),
    isOutdated: z.boolean(),
    authorLogin: z.string().nullable(),
    createdAt: z.string().nullable(),
    body: z.string(),
    replies: z.array(ThreadCommentSchema),
  })
  .strict();

/**
 * Registry-time mirror of {@link ReviewSummary}: the full review, and only
 * it. `body` accepts the empty string (a bare verdict carries no text by
 * design); `state` is the frozen four-verdict vocabulary or null (pending),
 * exactly the upstream type.
 */
const ReviewSummarySchema: z.ZodType<ReviewSummary> = z
  .object({
    id: z.string().min(1),
    authorLogin: z.string().nullable(),
    state: z.enum(['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED']).nullable(),
    body: z.string(),
    submittedAt: z.string().nullable(),
  })
  .strict();

/**
 * Registry-time mirror of {@link FetchedReviewState} — the classifyThreads
 * op's `state` input: the FULL fetched state, and only it, composed from
 * the vocabulary mirrors above (never z.unknown hand-waving). The field set
 * is derived from the type definition so the mirror accepts verbatim what
 * fetchReviewState produces.
 */
const FetchedReviewStateSchema: z.ZodType<FetchedReviewState> = z
  .object({
    repo: z.object({ owner: z.string().min(1), name: z.string().min(1) }).strict(),
    pr: z.number().int().positive(),
    authorLogin: z.string().nullable(),
    headRefName: z.string().nullable(),
    headRefOid: z.string().nullable(),
    threads: z.array(ReviewThreadSchema),
    reviews: z.array(ReviewSummarySchema),
    restReviewComments: z.array(RestCommentSchema),
    restIssueComments: z.array(RestCommentSchema),
    truncated: z.boolean(),
    truncatedBecause: z.array(z.string().min(1)),
  })
  .strict();

/** Registry-time mirror of {@link ClassifiedItem}: one verdict row, and only it. */
const ClassifiedItemSchema: z.ZodType<ClassifiedItem> = z
  .object({
    kind: z.enum(['thread', 'review', 'comment']),
    id: z.string().min(1),
    verdict: z.enum(['actionable', 'responded', 'resolved', 'blocked', 'skip']),
    path: z.string().nullable(),
    reason: z.string().min(1),
  })
  .strict();

/** Registry-time mirror of {@link Classification}: the full classification, and only it. */
const ClassificationSchema: z.ZodType<Classification> = z
  .object({
    items: z.array(ClassifiedItemSchema),
    truncated: z.boolean(),
    truncatedBecause: z.array(z.string().min(1)),
  })
  .strict();

/**
 * Registry-time mirror of {@link PlanBatchConfig}: the full config, and
 * only it. The shared-mode cap's `>= 1` semantics are the LIBRARY's
 * contract (planReviewBatch refuses a bad cap loudly at call time); the
 * boundary mirror keeps only the shape.
 */
const PlanBatchConfigSchema: z.ZodType<PlanBatchConfig> = z
  .object({
    worktreeMode: z.enum(['isolated', 'shared']),
    sharedGroupBy: z.enum(['file', 'none']),
    maxItemsPerSharedBatch: z.number().int(),
  })
  .strict();

/**
 * Registry-time mirror of {@link ReviewAction}: the strict three-kind
 * dispatch union, and only it. The library re-validates the semantic
 * details at call time (whitespace-only bodies, positive REST ids); the
 * boundary carries the shapes plus the non-empty keys.
 */
const ReviewActionSchema: z.ZodType<ReviewAction> = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('review_reply'),
      actionId: z.string().min(1),
      threadRootRestId: z.number().int().positive(),
      body: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('issue_comment'),
      actionId: z.string().min(1),
      body: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('resolve_thread'),
      actionId: z.string().min(1),
      threadId: z.string().min(1),
    })
    .strict(),
]);

/**
 * Registry-time mirror of {@link PrSnapshot}: the full snapshot, and only
 * it. `headSha` is non-empty (snapshotPrState REFUSES to snapshot headless,
 * so a captured snapshot always carries one); comment authors are non-empty
 * or null (an empty login maps to null at capture, the strict direction).
 */
const PrSnapshotSchema: z.ZodType<PrSnapshot> = z
  .object({
    at: z.number().int(),
    headSha: z.string().min(1),
    reviewComments: z.array(
      z.object({ id: z.number().int(), author: z.string().min(1).nullable() }).strict(),
    ),
    issueComments: z.array(
      z.object({ id: z.number().int(), author: z.string().min(1).nullable() }).strict(),
    ),
    resolvedThreadIds: z.array(z.string().min(1)),
  })
  .strict();

// ---------------------------------------------------------------------------
// ClassifyThreads config, RegExp-as-data (module doc)
// ---------------------------------------------------------------------------

/**
 * The JSON-carried shape of {@link ClassifyConfig}: identical fields except
 * `skipPatterns`, which upstream is RegExp[] — not JSON-serializable — and
 * here is regex SOURCES (`{pattern, flags}`), compiled by the
 * classifyThreads adapter exactly the way the table reads them (g/y
 * stripped; default flags 'im'). Widen `responderIs` ONLY together with
 * ClassifyConfig and classifyThreads' exhaustive switch — the literal below
 * is the same frozen union.
 */
const ClassifyThreadsConfigDataSchema = z
  .object({
    skipPatterns: z.array(
      z
        .object({
          pattern: z.string().min(1),
          // May legitimately be '' — a no-flags source is valid RegExp input.
          flags: z.string().exactOptional(),
        })
        .strict(),
    ),
    responderIs: z.literal('pr-author'),
    treatNullCreatedAtAs: z.enum(['nowMs', 'epochMs']),
    blockOnOutdatedThreads: z.boolean(),
    skipResponderAuthoredThreads: z.boolean(),
    skipDismissedReviews: z.boolean(),
    skipApprovalReviews: z.boolean(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Op-input mirrors — one per entry (the eagerly-required surface)
// ---------------------------------------------------------------------------

/**
 * Registry-time input of `review.fetchReviewState`: the library's
 * FetchReviewStateInput fields plus the optional caps as a sibling object
 * (the library validates caps semantically — nonnegative-safe-integer — at
 * call time; the boundary keeps the shape).
 */
export const FetchReviewStateOpInputSchema = z
  .object({
    owner: z.string().min(1),
    repo: z.string().min(1),
    pr: z.number().int().positive(),
    caps: z
      .object({
        reviewThreadPages: z.number().int().min(0).exactOptional(),
        reviewPages: z.number().int().min(0).exactOptional(),
        restPages: z.number().int().min(0).exactOptional(),
      })
      .strict()
      .exactOptional(),
  })
  .strict();

/**
 * Registry-time input of `review.classifyThreads`: the fetched state, the
 * injected clock, and the optional RegExp-as-data config (omitted → the
 * library's shipped defaultClassifyConfig applies).
 */
export const ClassifyThreadsOpInputSchema = z
  .object({
    state: FetchedReviewStateSchema,
    nowMs: z.number().int(),
    config: ClassifyThreadsConfigDataSchema.exactOptional(),
  })
  .strict();

/**
 * Registry-time input of `review.planReviewBatch`: the full Classification
 * plus the optional batch config (omitted → the library's isolated-by-
 * default defaultPlanBatchConfig applies). A TRUNCATED classification is
 * accepted here and refused by the LIBRARY at call time — its designed
 * fail-loud contract, folded to `failed` by the adapter with the message
 * naming every truncatedBecause cause.
 */
export const PlanReviewBatchOpInputSchema = z
  .object({
    classification: ClassificationSchema,
    config: PlanBatchConfigSchema.exactOptional(),
  })
  .strict();

/**
 * Registry-time input of `review.replyAndResolve`: the DATA half of
 * ReplyAndResolveOpts (owner/repo/pr/nowMs) plus the actions, the dispatch
 * log's file path (the file-backed log the importer binds), and the
 * optional push argv (present → a push that must exit 0 before anything
 * posts; absent → no push). The RUNTIME seams — the gh runner and the
 * DispatchLog — are bound by the importer, never carried as input.
 */
export const ReplyAndResolveOpInputSchema = z
  .object({
    owner: z.string().min(1),
    repo: z.string().min(1),
    pr: z.number().int().positive(),
    actions: z.array(ReviewActionSchema),
    nowMs: z.number().int(),
    dispatchLogPath: z.string().min(1),
    pushArgs: z.array(z.string().min(1)).min(1).exactOptional(),
  })
  .strict();

/**
 * Registry-time input of `review.verifyReviewOutcome`: the PURE diff's
 * before/after snapshots plus the responder login (null = author-blind,
 * exactly the library's option shape). Snapshot CAPTURE is
 * snapshotPrState's I/O and stays a library call of the loop around this
 * op — the entry exposes the verdict, not the fetch.
 */
export const VerifyReviewOutcomeOpInputSchema = z
  .object({
    before: PrSnapshotSchema,
    after: PrSnapshotSchema,
    responderLogin: z.string().nullable(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Inferred op-input aliases (the adapters' input types)
// ---------------------------------------------------------------------------

type FetchReviewStateOpInput = z.infer<typeof FetchReviewStateOpInputSchema>;
type ClassifyThreadsOpInput = z.infer<typeof ClassifyThreadsOpInputSchema>;
type PlanReviewBatchOpInput = z.infer<typeof PlanReviewBatchOpInputSchema>;
type ReplyAndResolveOpInput = z.infer<typeof ReplyAndResolveOpInputSchema>;
type VerifyReviewOutcomeOpInput = z.infer<typeof VerifyReviewOutcomeOpInputSchema>;

// ---------------------------------------------------------------------------
// Registry-time mirror of FixReviewItemInput (slice 1)
// ---------------------------------------------------------------------------

/**
 * Registry-time mirror of {@link FixableReviewItem}: the full item, and
 * only it. Bounds are the conservative JSON-boundary set: ids and comment
 * bodies non-empty, at most 100 prior comments (a comment flood is a
 * fetch/classification bug, not a fixer prompt), path/line nullable the way
 * the thread vocabulary carries unanchored items. `item.body` accepts the
 * EMPTY string on purpose — fetchReviewState maps a thread whose root
 * comment was deleted to `body: ''`, and the registry must accept what the
 * fetch actually produces (round-trip honesty: a real item would otherwise
 * be undispatchable through the JSON boundary).
 */
const FixableReviewItemSchema: z.ZodType<FixableReviewItem> = z
  .object({
    id: z.string().min(1),
    path: z.string().min(1).nullable(),
    line: z.number().int().nullable(),
    body: z.string(),
    comments: z
      .array(
        z
          .object({
            authorLogin: z.string().nullable(),
            body: z.string().min(1),
            createdAt: z.string().min(1).nullable(),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();

/**
 * Registry-time mirror of {@link FixReviewItemInput}: the full input, and
 * only it. `pr` is a positive integer (PR numbers start at 1); worktree
 * path/branch and the driver's model/provider handles are non-empty. The
 * budget mirror keeps the frozen Budget fields positive — a non-positive
 * cap would disable or invert the bound it names (the subprocess driver
 * throws pre-dispatch on a non-positive maxTokens; failing at the JSON
 * boundary is earlier and clearer). Strict throughout: an unknown key (a
 * typo'd field) must fail loudly, never be silently stripped.
 */
export const FixReviewItemInputSchema: z.ZodType<FixReviewItemInput> = z
  .object({
    repo: z.string().min(1).exactOptional(),
    pr: z.number().int().positive(),
    item: FixableReviewItemSchema,
    worktree: z.object({ path: z.string().min(1), branch: z.string().min(1) }).strict(),
    driver: z.object({ model: z.string().min(1), provider: z.string().min(1) }).strict(),
    harness: HarnessConfigSchema.exactOptional(),
    promptOverride: z.string().min(1).exactOptional(),
    budget: z
      .object({
        maxUsd: z.number().positive().exactOptional(),
        maxTokens: z.number().int().positive().exactOptional(),
        wallClockMs: z.number().int().positive().exactOptional(),
        maxAttempts: z.number().int().positive().exactOptional(),
      })
      .strict()
      .exactOptional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// The family registry — one entry per §5 loop op
// ---------------------------------------------------------------------------

/** Review family op registry (E4: the full fetch → classify → plan → fix → reply/resolve → verify loop). */
export const registry: OpRegistryEntry[] = [
  {
    name: 'review.fixItem',
    inputSchema: FixReviewItemInputSchema,
    // The dispatch seam re-validates input through inputSchema.parseAsync
    // before invoking the op, so the erased op typing is safe here (gates
    // precedent). The importer resolves BOTH the op module and the
    // subprocess driver and binds the driver there — the SubprocessDriver
    // constructor is env-free and spawns nothing (env reads and processes
    // are run()-time), so resolving this entry is inert.
    importer: () =>
      Promise.all([import('./fixReviewItem.js'), import('../../driver/subprocess/index.js')]).then(
        ([m, subprocess]) =>
          m.makeFixReviewItem({
            driver: new subprocess.SubprocessDriver(),
          }) as Op<unknown, unknown>,
      ),
  },
  {
    name: 'review.fetchReviewState',
    inputSchema: FetchReviewStateOpInputSchema,
    // The importer resolves the op module AND the gh transport and binds
    // the default runner there: makeGhRunner() is closure-only at
    // construction (gh.ts reads CQ_GH_BIN and spawns only when the returned
    // runner is CALLED), so resolving this entry never touches env/network.
    importer: () =>
      Promise.all([import('./fetchReviewState.js'), import('./gh.js')]).then(
        ([m, gh]) =>
          awaitOp((input: FetchReviewStateOpInput) =>
            m.fetchReviewState(
              { owner: input.owner, repo: input.repo, pr: input.pr },
              input.caps,
              gh.makeGhRunner(),
            ),
          ) as Op<unknown, unknown>,
      ),
  },
  {
    name: 'review.classifyThreads',
    inputSchema: ClassifyThreadsOpInputSchema,
    // Pure decision table — no runtime dependency to bind. The adapter
    // compiles JSON-carried skip patterns into RegExps exactly the way the
    // table reads them (module doc, REGEXP-AS-DATA); a non-compiling source
    // throws SyntaxError inside the adapter → failed (the hackDetector
    // precedent for non-compiling regex config).
    importer: () =>
      import('./classifyThreads.js').then(
        (m) =>
          awaitOp((input: ClassifyThreadsOpInput) => {
            const config: ClassifyConfig | undefined =
              input.config === undefined
                ? undefined
                : {
                    skipPatterns: input.config.skipPatterns.map(
                      (pattern) =>
                        new RegExp(pattern.pattern, (pattern.flags ?? 'im').replace(/[gy]/g, '')),
                    ),
                    responderIs: input.config.responderIs,
                    treatNullCreatedAtAs: input.config.treatNullCreatedAtAs,
                    blockOnOutdatedThreads: input.config.blockOnOutdatedThreads,
                    skipResponderAuthoredThreads: input.config.skipResponderAuthoredThreads,
                    skipDismissedReviews: input.config.skipDismissedReviews,
                    skipApprovalReviews: input.config.skipApprovalReviews,
                  };
            // An undefined config triggers the library's shipped default.
            return m.classifyThreads(input.state, input.nowMs, config);
          }) as Op<unknown, unknown>,
      ),
  },
  {
    name: 'review.planReviewBatch',
    inputSchema: PlanReviewBatchOpInputSchema,
    // Pure planner — no binding. The library's truncated-classification
    // refusal (it THROWS naming every truncatedBecause cause) folds to
    // `failed` in the adapter, message verbatim — the refusal stays the
    // caller-visible contract, never silently emptied.
    importer: () =>
      import('./planReviewBatch.js').then(
        (m) =>
          awaitOp((input: PlanReviewBatchOpInput) =>
            m.planReviewBatch(input.classification, input.config),
          ) as Op<unknown, unknown>,
      ),
  },
  {
    name: 'review.replyAndResolve',
    inputSchema: ReplyAndResolveOpInputSchema,
    // The importer binds the op's two runtime seams from JSON data: the
    // default gh runner (closure-only at construction) serves both the
    // post/mutation seam and the optional push, and the dispatch memory is
    // the module's file-backed log at the INPUT's path (closure-only at
    // construction). pushArgs present → a push that must exit 0 before
    // anything posts; absent → null (no push), exactly the library's
    // option shape.
    importer: () =>
      Promise.all([import('./replyAndResolve.js'), import('./gh.js')]).then(
        ([m, gh]) =>
          awaitOp(async (input: ReplyAndResolveOpInput) => {
            const run = gh.makeGhRunner();
            return m.replyAndResolve(input.actions, {
              owner: input.owner,
              repo: input.repo,
              pr: input.pr,
              run,
              push: input.pushArgs === undefined ? null : { run, args: input.pushArgs },
              dispatchLog: m.fileDispatchLog(input.dispatchLogPath),
              nowMs: input.nowMs,
            });
          }) as Op<unknown, unknown>,
      ),
  },
  {
    name: 'review.verifyReviewOutcome',
    inputSchema: VerifyReviewOutcomeOpInputSchema,
    // The PURE snapshot diff (ws-e item 6: verifyReviewOutcome(before,
    // after)) — no binding. Snapshot capture is snapshotPrState's I/O and
    // stays a library call of the loop around this op; the entry exposes
    // the verdict (including the exact literal "NO PROGRESS").
    importer: () =>
      import('./verifyReviewOutcome.js').then(
        (m) =>
          awaitOp((input: VerifyReviewOutcomeOpInput) =>
            m.verifyPrOutcome(input.before, input.after, {
              responderLogin: input.responderLogin,
            }),
          ) as Op<unknown, unknown>,
      ),
  },
];
