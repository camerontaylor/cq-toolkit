// classify.config.ts — the R3 landing site for classifyThreads (goal E2,
// ws-e items 2–3): tie-break heuristics and thresholds as DATA.
//
// I8 placement, review edition: every judgement call the pure decision
// table makes — what counts as a bot skip notice, who the responder is,
// how unknown timestamps lean — lives HERE as data, never as code
// constants inside the engine. The STRUCTURE is frozen (this interface is
// the contract); R3 refines the VALUES by editing defaultClassifyConfig or
// passing an override — never by touching the decision table.
//
// Conservative defaults: wherever the data is ambiguous, classification
// fails toward `actionable` (a human looks at it) rather than toward
// `skip` (nobody does) — the same fail-closed bias as the threads.ts
// vocabulary this table consumes.

/**
 * The configuration the classify decision table reads. Shape frozen:
 * R3 tuning lands as new/changed VALUES against these same fields.
 */
export interface ClassifyConfig {
  /**
   * Bodies matching ANY of these patterns are bot skip/failure notices,
   * not reviews (the I2 rule: "CodeRabbit skipped this run", "review
   * failed", …) — they carry no feedback to answer. R3 refines the
   * pattern list AS DATA (structure frozen).
   */
  skipPatterns: RegExp[];
  /**
   * Who the responder is. Frozen to `'pr-author'`: in the merge-prs
   * context the party answering review feedback is the PR author, so
   * classifyThreads reads `state.authorLogin`. R3 may widen this union
   * AS DATA (structure frozen) if a lane ever answers as someone else.
   */
  responderIs: 'pr-author';
  /**
   * How a null or unparseable timestamp leans:
   *   - `'nowMs'` — treated as brand-new: it can never count as "already
   *     answered" or "older than the reviewer's word", so it fails toward
   *     `actionable` / `responded` (nobody silently skips on missing data).
   *   - `'epochMs'` — treated as ancient: the conservative "assume the
   *     worst about recency" reading.
   * R3 may flip this AS DATA (structure frozen); the default is the
   * fail-toward-actionable reading.
   */
  treatNullCreatedAtAs: 'nowMs' | 'epochMs';
  /**
   * An OUTDATED unresolved thread cannot be fixed by a head-of-branch
   * commit — the diff it anchors to is gone, so only a human (re-review,
   * resolve, or reopen on the new diff) can settle it: `blocked`
   * (human/awaiting), never `actionable`. R3 may flip this AS DATA
   * (structure frozen).
   */
  blockOnOutdatedThreads: boolean;
  /**
   * Threads and conversation comments the RESPONDER opened on their own
   * PR are not outstanding review feedback — nobody else is waiting on
   * them — so they classify `skip` (mirrors countUnresolvedThreads'
   * external-threads rule). R3 may flip this AS DATA (structure frozen).
   */
  skipResponderAuthoredThreads: boolean;
}

/**
 * The conservative defaults (rationale on each interface field; the
 * literal mirrors them so the shipped values are greppable in one place).
 */
export const defaultClassifyConfig: ClassifyConfig = {
  // Bot skip/failure notices are not reviews (I2): each pattern matches a
  // distinct real-world phrasing class. R3 refines AS DATA.
  skipPatterns: [
    // "CodeRabbit ... skipped ..." — the bot punted on this PR.
    /\bCodeRabbit\b.*\bskipped\b/i,
    // "review ... failed" — a review tool errored out.
    /\breview\b.*\bfailed\b/i,
    // "skipping review" — an explicit pass.
    /\bskipping review\b/i,
    // "not reviewing" — an explicit refusal.
    /\bnot reviewing\b/i,
  ],
  responderIs: 'pr-author',
  // Unknown timestamp = brand-new: it can never be "already answered" —
  // fails toward actionable. R3 flips AS DATA.
  treatNullCreatedAtAs: 'nowMs',
  // An outdated unresolved thread needs a human, not a head-of-branch
  // commit. R3 flips AS DATA.
  blockOnOutdatedThreads: true,
  // The responder's own threads/comments are not outstanding feedback.
  // R3 flips AS DATA.
  skipResponderAuthoredThreads: true,
};
