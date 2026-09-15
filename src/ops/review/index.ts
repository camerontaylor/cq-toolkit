// review op family barrel — goal E1 (address-review fetch lane), slices
// 1–3: re-export only, no logic. ./threads.js is the shared review-thread
// vocabulary — the single surface the merge ops family counts unresolved
// threads through (WS-F imports nothing else from review/); ./gh.js is the
// injectable gh CLI runner; ./fetchReviewState.js pulls one PR's full
// review state over the gh seam.
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
