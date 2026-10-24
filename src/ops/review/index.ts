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
export { attachRestReplies, countUnresolvedThreads } from './threads.js';
export type { GhFn, GhResult } from '../../adapters/forge-github/gh.js';
export { GhError, ghJson, makeGhRunner } from '../../adapters/forge-github/gh.js';
export type {
  FetchReviewStateCaps,
  FetchReviewStateInput,
  FetchedReviewState,
} from '../../adapters/forge-github/fetchReviewState.js';
export { fetchReviewState } from '../../adapters/forge-github/fetchReviewState.js';
export type { ClassifyConfig } from './classify.config.js';
export { defaultClassifyConfig } from './classify.config.js';
export type { ClassifiedItem, Classification, ThreadVerdict } from './classifyThreads.js';
export { classifyThreads } from './classifyThreads.js';
export type { PlanBatchConfig, PlannedBatch } from './planReviewBatch.js';
export { defaultPlanBatchConfig, planReviewBatch } from './planReviewBatch.js';
// E3 — the close-out half of the review loop: batch actions as data with
// push-before-post ordering + dispatch replay (replyAndResolve), the
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
export { fileDispatchLog } from '../../adapters/store/dispatchLog.js';
export { replyAndResolve } from './replyAndResolve.js';
export type {
  PrSnapshot,
  SnapshotPrStateOpts,
} from '../../adapters/forge-github/snapshotPrState.js';
export type { ProgressReason, VerifyOutcome } from './verifyReviewOutcome.js';
export { snapshotPrState } from '../../adapters/forge-github/snapshotPrState.js';
export { verifyPrOutcome } from './verifyReviewOutcome.js';
export type {
  PrWorktreeOpts,
  RegistryMap,
  WorktreeRegistry,
  WorktreeRegistryEntry,
} from '../../adapters/git/prWorktree.js';
export {
  fileWorktreeRegistry,
  removePrWorktree,
  resolvePrWorktree,
} from '../../adapters/git/prWorktree.js';
// E4 — the agentic fix half of the loop: fixReviewItem drives ONE worker
// over ONE review item in the resolved per-PR worktree through the injected
// Driver seam (conservative harness-derived tool allowlist, head-capped
// system prompt, single-line JSON contract). fix.default.md is the canonical
// shipped prompt asset, loaded beside its compiled loader module.
export type {
  FixableReviewItem,
  FixReviewItemInput,
  FixReviewItemResult,
  FindingReviewItemInput,
  ReviewFixInput,
} from './fixReviewItem.js';
export { makeFixReviewItem } from './fixReviewItem.js';
export { defaultFixPrompt } from './prompts/defaultFixPrompt.js';
export { makeReviewAddress, addressBatches } from './address.js';
export type {
  ReviewAddressInput,
  ReviewAddressReport,
  ReviewAddressResult,
  ReviewAddressDeps,
} from './address.js';
