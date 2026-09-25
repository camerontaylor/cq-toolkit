// classify.config.ts — the R3 landing site for merge-classification policy
// (goal F1, ws-f): the I2 merge-acceptance doctrine as DATA.
//
// I8 placement, merge edition: every judgement call classifyPr's decision
// table makes — how long a clean PR must settle after its last commit, what
// reads as an explicit human all-clear, what is a bot skip/failure notice
// rather than a review — lives HERE as data, never as code constants inside
// the table. The STRUCTURE is frozen (this interface is the contract); R3
// refines the VALUES by editing defaultClassifyPrConfig or passing an
// override — never by touching the decision table.
//
// The skipPatterns below are DUPLICATED DELIBERATELY from
// ../review/classify.config.ts (ws-e): the lane contract forbids
// cross-family imports, so ws-f owns its own copy of the pattern data. The
// copy must keep ws-e's anchoring rule — every pattern anchors on a
// bot/tool identity at LINE START (every line, `m`), never on generic
// "review failed"/"not reviewing" phrasing, which is exactly how human
// feedback reads. Converging the two lists (or diverging them on purpose)
// is an R3/recorded-deviation decision, never an import.
//
// Conservative defaults: wherever the data is ambiguous the table fails
// toward `awaiting` (a human looks at the PR) rather than toward `eligible`
// (something merges unchecked) — the same fail-closed bias as the
// threads.ts vocabulary the table consumes.

/**
 * The configuration the merge-acceptance decision table reads. Shape
 * frozen: R3 tuning lands as new/changed VALUES against these same fields.
 */
export interface ClassifyPrConfig {
  /**
   * How long a mergeable PR must sit UNTOUCHED after its last commit
   * before quiet counts as acceptance (row 8): review feedback has had its
   * chance to land, and silence past this window is read as consent. The
   * I2 doctrine number is ten minutes. An explicit all-clear (row 7)
   * bypasses the wait; anything shorter than the default is R3 tuning AS
   * DATA (structure frozen).
   */
  settleWindowMs: number;
  /**
   * A review or top-level conversation comment body matching this pattern,
   * authored by a NON-author and timestamped STRICTLY AFTER the PR's last
   * commit, is an explicit all-clear (row 7) — the reviewer looked at the
   * final code and said so, so the settle wait is unnecessary. The
   * all-clear bypasses ONLY the settle wait; it never substitutes for
   * row 6's review-of-the-last-commit requirement. Conservative default,
   * built to be negation- AND caveat-proof:
   *   - EVERY alternative is anchored at the WHOLE BODY's start AND end
   *     — NO multiline flag: `^` matches only the body's first character
   *     (`^\s*` still admits leading blank lines — `\s` spans newlines)
   *     and `$` only the body's end. A caveat continuation on the NEXT
   *     line therefore cannot resurrect a match: "LGTM\nbut fix the
   *     retry loop first" is a rejection of the head state, not an
   *     all-clear (with a multiline flag, "LGTM" alone on line 1 would
   *     have matched — round 3 closed that hole).
   *   - a `not` IMMEDIATELY BEFORE the phrase kills the match ((?!not\b)
   *     right after the anchor) — "Not LGTM …" at line start is a
   *     rejection, not an approval;
   *   - EVERY alternative must reach END OF BODY (modulo ONE trailing
   *     !/,/.): any continuation after the phrase — on the same line or
   *     the next — is a caveat or a coda that changes its meaning — "lgtm
   *     but fix the retry loop first", "all clear, but the retry loop is
   *     still broken", "no further issues, but the tests are red", and
   *     courteous codas alike ("all clear, thanks", "LGTM — ship it") do
   *     NOT match. Strict on purpose: where a short coda would have been
   *     harmless, the miss fails toward awaiting (a longer settle), never
   *     toward merging unchecked. (Round 1 anchored only "looks good" to
   *     end-of-line; round 2 extended the guard to all four alternatives;
   *     round 3 lifted it to the whole body by dropping the multiline
   *     flag.)
   * A null or unparseable timestamp never qualifies: an un-timestamped
   * all-clear cannot be shown to postdate the commit, so it fails closed
   * (falls through to the settle rows). R3 tunes this AS DATA (structure
   * frozen).
   */
  allClearPattern: RegExp;
  /**
   * Bodies matching ANY of these patterns are bot skip/failure notices,
   * not reviews (the I2 rule: "CodeRabbit skipped this run", a tool
   * erroring out, …) — they carry no reviewer judgement, so a PR whose
   * only reviews are skip notices has NO acceptable review (row 6 fires).
   * Deliberate duplicate of ws-e's list (see the file header — cross-family
   * import is forbidden by the lane contract). EVERY pattern MUST anchor on
   * a bot/tool identity at LINE START (every line, `m`); R3 refines the
   * list AS DATA (structure frozen) under the same anchoring rule.
   */
  skipPatterns: RegExp[];
  /** Logins eligible to grant acceptance; undefined retains the legacy SDK surface. */
  trustedBots?: readonly string[] | undefined;
  /** Repository associations eligible to grant acceptance. */
  trustedAssociations?: readonly string[] | undefined;
  /** Automation identity; it is never trusted and alone may carry a skip marker. */
  automationLogin?: string | null | undefined;
  /** Additional logins removed from the trust set. */
  excludedLogins?: readonly string[] | undefined;
  /** Accepted opinionated states; the legacy blank SDK default is APPROVED and COMMENTED. */
  acceptReviewStates?:
    | readonly ('APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED')[]
    | undefined;
}

/**
 * The I2 doctrine settle window: ten minutes, in ms. Exported so callers
 * and tests can derive from the named number instead of a bare literal.
 */
export const REVIEW_ACCEPT_SETTLE_MS = 600_000;

/**
 * The conservative defaults (rationale on each interface field; the
 * literal mirrors them so the shipped values are greppable in one place).
 */
export const defaultClassifyPrConfig: ClassifyPrConfig = {
  // The I2 doctrine number: a clean PR merges once ten quiet minutes have
  // passed since its last commit. R3 tunes AS DATA.
  settleWindowMs: REVIEW_ACCEPT_SETTLE_MS,
  // Anchored to the WHOLE body (no multiline flag — `^`/`$` bind the
  // body's start/end; `^\s*` still admits leading blank lines),
  // negation-proof, end-of-body-anchored approval phrasing,
  // case-insensitive — the anchoring rules are documented on the
  // interface field. R3 tunes AS DATA.
  allClearPattern:
    /^\s*(?:(?!not\b)(?:all\s*clear|lgtm\b|no\s+further\s+(?:issues|changes)|looks\s+good[!,.]?))\s*[!,.]?\s*$/i,
  // Bot skip/failure notices are not reviews (I2) — deliberate duplicate of
  // ws-e's list (src/ops/review/classify.config.ts), kept IN SYNC with it
  // by hand (the lane contract forbids cross-family imports, so the
  // duplication is two-directional: a window/anchor change lands in BOTH
  // files in the same commit). R3 refines AS DATA.
  skipPatterns: [
    // "CodeRabbit ... skipped ..." — the bot punted on this PR. Identity at
    // LINE START (every line, `m`), the `(?!-)` hyphenated-mention guard,
    // and a bounded [\s\S]{0,80} window before the skip verb. The window
    // spans line breaks (round 3: [^\n] → [\s\S]) so a notice rendered as
    // "CodeRabbit" alone on its line — verb on the next — still reads as
    // the tool's verdict; it stays bounded so a distant human "skipped"
    // can never be swallowed.
    /^\s*(?:(?:CodeRabbit|coderabbitai|Codex|chatgpt-codex-connector)\b)(?!-)[\s\S]{0,80}\bskipped\b/im,
    // A known bot/tool identity at LINE START followed within a bounded
    // 80-char window (line breaks allowed) by "failed"/"error" — the
    // tool's own failure notice. The `(?!-)` guard keeps a HYPHENATED
    // tool-name MENTION ("Codex-style tooling failed us here") reading as
    // the tool speaking.
    /^\s*(?:(?:CodeRabbit|coderabbitai|Codex|chatgpt-codex-connector)\b)(?!-)[\s\S]{0,80}\b(?:failed|error)\b/im,
    // Tooling self-skip caused by a configuration/setup problem — same
    // identity-at-line-start anchoring: a human's "This configuration error
    // makes skipping validation unsafe" is exactly how real feedback reads.
    /^\s*(?:(?:CodeRabbit|coderabbitai|Codex|chatgpt-codex-connector)\b)(?!-)[\s\S]{0,80}\b(?:configuration|setup)\s+(?:error|problem)[^\n]{0,40}\bskipping\b/im,
    // A bot/tool identity LEADING the line delivering its self-skip verdict
    // ("CodeRabbit is skipping this PR", "Codex: not reviewing until CI
    // settles") — identity-anchored on every line, so a human's "I'm not
    // reviewing the migrations this pass, but …" is never eaten.
    /^\s*(?:CodeRabbit|coderabbitai|Codex|chatgpt-codex-connector)\b(?!-)[\s\S]{0,80}\b(?:is\s+)?(?:skipping|not reviewing)\b/im,
  ],
};
