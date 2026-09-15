// review op family barrel — goal E1 slice 1 (address-review fetch lane):
// re-export only, no logic. ./threads.js is the shared review-thread
// vocabulary — the single surface the merge ops family counts unresolved
// threads through (WS-F imports nothing else from review/); ./gh.js is the
// injectable gh CLI runner. Later E1 slices add their modules here as new
// re-export lines.
export type {
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
