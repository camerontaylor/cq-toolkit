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
   * not reviews (the I2 rule: "CodeRabbit skipped this run", a tool
   * erroring out, …) — they carry no feedback to answer. EVERY pattern
   * MUST anchor on a bot/tool identity or an explicit tooling self-skip
   * (see the defaults): generic "review failed" phrasing is how HUMANS
   * write real feedback ("the review failed to consider X"), so an
   * unanchored pattern would eat human comments. R3 refines the pattern
   * list AS DATA (structure frozen) — under the same anchoring rule.
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
   * How a null or unparseable timestamp leans where timestamps ORDER
   * things — a thread's last-word comparison, and a review's
   * submittedAt side:
   *   - `'nowMs'` — treated as brand-new: an un-timestamped review counts
   *     as submitted just now, so PAST replies do not answer it (fails
   *     toward actionable).
   *   - `'epochMs'` — treated as ancient: the conservative "assume the
   *     worst about recency" reading.
   * SEPARATELY — and regardless of this setting — a reply counts as
   * ANSWERING a review only when its own createdAt parses for REAL: a
   * null/unparseable reply never answers (under 'nowMs' it is not counted
   * at all; under 'epochMs' the ordering fallback would be 0, which never
   * postdates a past review). Both readings fail toward actionable. R3
   * may flip this AS DATA (structure frozen).
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
   * Threads, reviews, and conversation comments the RESPONDER opened on
   * their own PR are not outstanding review feedback — nobody else is
   * waiting on them — so they classify `skip` (`responder_authored`;
   * mirrors countUnresolvedThreads' external-threads rule). R3 may flip
   * this AS DATA (structure frozen).
   */
  skipResponderAuthoredThreads: boolean;
  /**
   * A DISMISSED review's verdict was voided by downstream events (a
   * pushed fix, a re-review, the reviewer retracting) — re-surfacing it
   * would plan fixer batches for noise. Default true: dismissed reviews
   * classify `skip` (`review_dismissed`). R3 may flip this AS DATA
   * (structure frozen).
   */
  skipDismissedReviews: boolean;
}

/**
 * The conservative defaults (rationale on each interface field; the
 * literal mirrors them so the shipped values are greppable in one place).
 */
export const defaultClassifyConfig: ClassifyConfig = {
  // Bot skip/failure notices are not reviews (I2). Each pattern anchors on
  // a bot/tool identity or an explicit tooling self-skip — NEVER on
  // generic "review failed" phrasing (that is how humans write real
  // feedback). R3 refines AS DATA, under the same anchoring rule.
  skipPatterns: [
    // "CodeRabbit ... skipped ..." — the bot punted on this PR.
    /\bCodeRabbit\b.*\bskipped\b/i,
    // A known bot/tool identity followed within one line by
    // "failed"/"error" — the tool's own failure notice.
    /(?:CodeRabbit|Codex|coderabbitai|chatgpt-codex-connector)[^\n]{0,80}\b(?:failed|error)\b/i,
    // Tooling self-skip caused by a configuration/setup problem.
    /\b(?:configuration|setup)\s+(?:error|problem)[^\n]{0,40}\bskipping\b/i,
    // "skipping review" — an explicit pass.
    /\bskipping review\b/i,
    // "not reviewing" — an explicit refusal.
    /\bnot reviewing\b/i,
  ],
  responderIs: 'pr-author',
  // Unknown timestamp = brand-new for ordering purposes: an un-timestamped
  // review is not answerable by past replies — fails toward actionable.
  // (Answering replies additionally need a REAL timestamp regardless of
  // this value — see the interface doc.) R3 flips AS DATA.
  treatNullCreatedAtAs: 'nowMs',
  // An outdated unresolved thread needs a human, not a head-of-branch
  // commit. R3 flips AS DATA.
  blockOnOutdatedThreads: true,
  // The responder's own threads/reviews/comments are not outstanding
  // feedback. R3 flips AS DATA.
  skipResponderAuthoredThreads: true,
  // A dismissed verdict is void — do not plan batches for it.
  // R3 flips AS DATA.
  skipDismissedReviews: true,
};
