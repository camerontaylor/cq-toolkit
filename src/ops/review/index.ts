// review op family barrel — goals E1+E2+E3 (address-review fetch + classify
// lanes): re-export only, no logic. ./threads.js is the shared review-thread
// vocabulary — the single surface the merge ops family counts unresolved
// threads through (WS-F imports nothing else from review/); ./gh.js is the
// injectable gh CLI runner; ./fetchReviewState.js pulls one PR's full
// review state over the gh seam (E1). E2 adds the pure classification and
// planning layer: ./classifyThreads.js is the verdict decision table over a
// FetchedReviewState (frozen five-word ThreadVerdict vocabulary), backed by
// the R3 config site ./classify.config.js, and ./planReviewBatch.js groups
// actionable items into fixer batches (per-item isolation default, I6).
export type {
  AttachReport,
  RestComment,
  ReviewSummary,
  ReviewThread,
  ThreadComment,
  TruncationFlag,
} from './threads.js';
export {
  attachRestReplies,
  countUnresolvedThreads,
} from './threads.js';
export type { GhFn, GhResult } from './gh.js';
export { GhError, ghJson, makeGhRunner } from './gh.js';
export type {
  FetchReviewStateCaps,
  FetchReviewStateInput,
  FetchedReviewState,
} from './fetchReviewState.js';
export { fetchReviewState } from './fetchReviewState.js';
export type { ClassifyConfig } from './classify.config.js';
export { defaultClassifyConfig } from './classify.config.js';
export type { ClassifiedItem, Classification, ThreadVerdict } from './classifyThreads.js';
export { classifyThreads } from './classifyThreads.js';
export type { PlanBatchConfig, PlannedBatch } from './planReviewBatch.js';
export { defaultPlanBatchConfig, planReviewBatch } from './planReviewBatch.js';
// E3 — the close-out half of the review loop: batch actions as data with
// push-before-post atomicity + dispatch tracking (replyAndResolve), the
// REST-counted anti-hallucination verify with its explicit NO PROGRESS
// contract (verifyReviewOutcome), and per-PR worktree resolution with the
// registry (prWorktree — origin branch is truth, never the sweep worktree).
export type {
  DispatchLog,
  DispatchRecord,
  IssueCommentAction,
  ReplyAndResolveOpts,
  ReplyAndResolveResult,
  ResolveThreadAction,
  ReviewAction,
  ReviewReplyAction,
} from './replyAndResolve.js';
export { fileDispatchLog, replyAndResolve } from './replyAndResolve.js';
export type {
  PrSnapshot,
  ProgressReason,
  SnapshotPrStateOpts,
  VerifyOutcome,
} from './verifyReviewOutcome.js';
export { snapshotPrState, verifyPrOutcome } from './verifyReviewOutcome.js';
export type {
  PrWorktreeOpts,
  RegistryMap,
  WorktreeRegistry,
  WorktreeRegistryEntry,
} from './prWorktree.js';
export {
  fileWorktreeRegistry,
  removePrWorktree,
  resolvePrWorktree,
} from './prWorktree.js';
