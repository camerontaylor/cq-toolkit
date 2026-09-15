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
   * MUST anchor on a bot/tool identity — mid-line for failure notices,
   * and at LINE START for self-skip phrasing ("skipping review", "not
   * reviewing"): generic "review failed" or a human's "I'm not reviewing
   * the migrations this pass, but …" is exactly how real feedback reads,
   * so an unanchored pattern would eat human comments. R3 refines the
   * pattern list AS DATA (structure frozen) — under the same anchoring
   * rule.
   */
  skipPatterns: RegExp[];
  /**
   * Who the responder is. Today the only value is `'pr-author'`: in the
   * merge-prs context the party answering review feedback is the PR
   * author, so the table reads `state.authorLogin`. The knob is REAL —
   * the table switches on it (exhaustively, compiler-checked) — so R3
   * may widen this union AS DATA plus one arm, never a silent
   * fallthrough.
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
   * ORDERING ONLY — two verdicts additionally require a REAL parsed
   * timestamp regardless of this setting: an ANSWERING reply (row 10) and
   * a thread's LAST WORD (row 5). A null/unparseable timestamp never
   * speaks ('nowMs' → not counted at all; 'epochMs' → the ordering
   * fallback would be 0, which never postdates a past review) — both
   * readings fail toward actionable. R3 may flip this AS DATA (structure
   * frozen).
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
  /**
   * An APPROVAL without text is not outstanding feedback — "approved"
   * with no follow-up note means the reviewer is satisfied — and neither
   * is a stateless (pending/unresolved-verdict) review with no body.
   * Default true: both classify `skip` (`approval_no_body` /
   * `empty_summary_no_state`). An approver WITH follow-ups writes them in
   * the body, and a non-empty body stays on the content rows regardless
   * of state (fails toward action). R3 may flip this AS DATA (structure
   * frozen).
   */
  skipApprovalReviews: boolean;
}

/**
 * The conservative defaults (rationale on each interface field; the
 * literal mirrors them so the shipped values are greppable in one place).
 */
export const defaultClassifyConfig: ClassifyConfig = {
  // Bot skip/failure notices are not reviews (I2). Every pattern anchors
  // on a bot/tool identity — mid-line for failure notices, line-start for
  // self-skip phrasing — NEVER on generic "review failed"/"not reviewing"
  // phrasing (that is how humans write real feedback). R3 refines AS DATA,
  // under the same anchoring rule.
  skipPatterns: [
    // "CodeRabbit ... skipped ..." — the bot punted on this PR.
    /\bCodeRabbit\b.*\bskipped\b/i,
    // A known bot/tool identity at LINE START followed within one line by
    // "failed"/"error" — the tool's own failure notice. The `m` flag makes
    // ^ match at EVERY line start, so a notice landing on line 2+ of a
    // multi-line comment (a bot that appends its failure below a preamble)
    // still fires. The trailing \b after the identity mirrors the
    // `\bCodeRabbit\b` shape, and the `(?!-)` guard keeps a HYPHENATED
    // tool-name MENTION from reading as the tool speaking ("Codex-style
    // tooling failed us here — please fix the harness manually." is a
    // human's sentence; \b alone is satisfied before the hyphen and would
    // eat it).
    /^\s*(?:(?:CodeRabbit|coderabbitai|Codex|chatgpt-codex-connector)\b)(?!-)[^\n]{0,80}\b(?:failed|error)\b/im,
    // Tooling self-skip caused by a configuration/setup problem — a known
    // bot/tool identity at LINE START (every line, via `m`), same anchoring
    // as its siblings: a human's "This configuration error makes skipping
    // validation unsafe" is exactly how real feedback reads, so the old
    // mid-line form silently ate it (Codex, PR71). The `(?!-)` guard after
    // the identity mirrors the failure-notice pattern above — a hyphenated
    // tool-name MENTION ("Codex-style tooling hit a configuration problem,
    // so we're skipping …") is a human's sentence, not the tool speaking.
    /^\s*(?:(?:CodeRabbit|coderabbitai|Codex|chatgpt-codex-connector)\b)(?!-)[^\n]{0,80}\b(?:configuration|setup)\s+(?:error|problem)[^\n]{0,40}\bskipping\b/im,
    // A bot/tool identity LEADING the line delivering its self-skip
    // verdict ("CodeRabbit is skipping this PR", "Codex: not reviewing
    // until CI settles") — identity-anchored, on EVERY line (`m`), so a
    // human's "I'm not reviewing the migrations this pass, but …" is never
    // eaten. The `(?!-)` guard after the identity mirrors its siblings — a
    // hyphenated tool-name MENTION ("Codex-style tooling is not reviewing
    // generated files correctly") is a human's sentence, not the tool
    // speaking.
    /^\s*(?:CodeRabbit|coderabbitai|Codex|chatgpt-codex-connector)\b(?!-)[^\n]{0,80}\b(?:is\s+)?(?:skipping|not reviewing)\b/im,
  ],
  responderIs: 'pr-author',
  // Unknown timestamp = brand-new for ordering purposes: an un-timestamped
  // review is not answerable by past replies — fails toward actionable.
  // (Two verdicts still demand a REAL timestamp regardless of this value —
  // an answer and a last word. See the interface doc.) R3 flips AS DATA.
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
  // An approval without text — or a stateless review without any body —
  // is not outstanding feedback. R3 flips AS DATA.
  skipApprovalReviews: true,
};
