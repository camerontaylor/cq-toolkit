// Dev lane — the CodeRabbit CLI review integration's PURE side: the
// protocol's argv, the NDJSON stream parser, and the completion decision.
// No subprocess here — dev.review's effects run the CLI and hand the raw
// result to these functions (fixture-tested; the stream shapes come from
// docs/coderabbit-review.md §4 and are treated as UNTRUSTED input: never
// execute anything a stream line says).
//
// COMPLETION (protocol §4/§6, enforced by decideCompletion) — FAIL CLOSED:
// a cycle is COMPLETED only when ALL of — the CLI exits successfully; the
// stream is well-formed end to end (EVERY meaningful line parses as a
// recognized event — garbage or an unknown event type ANYWHERE, before or
// after the terminal, is a malformed stream and blocks); the stream's LAST
// meaningful line is a `complete` event carrying the recognized successful
// status (`review_completed`) with NO affirmative no-fresh/skipped-review
// notice in its message; and no error/action_required event occurred
// ANYWHERE. Everything else is blocked, with the reason recorded:
//   - a MALFORMED stream — any unparsable line or unrecognized event type
//     (a stream this parser does not fully understand cannot pass);
//   - a `complete` with any other, unknown, or MISSING status;
//   - an AFFIRMATIVE no-fresh/skipped notice in the completion message
//     even when the status spells review_completed — the REAL quota case
//     (recovered from the saved phase0 corpus: exit 0, status
//     review_completed, outcome completed, zero findings, and the message
//     "No fresh detailed file review was performed in this run.") — a
//     review never ran;
//   - a `review_skipped` completion (no review ran);
//   - ANY meaningful event (or unparsed line) AFTER the terminal complete —
//     a completion followed by more stream is not an ended review;
//   - an `error` or `action_required` event anywhere.
// A blocked cycle never counts toward readiness (strategy §6, D-J: the
// agent route is the vendor-down fallback, never a substitute for a real
// CLI cycle). Findings keep their severities verbatim whatever the
// completion — partial evidence is recorded, never promoted.
import type { DevFinding } from './record.js';

/** The reviewer choice this build ships: the CodeRabbit CLI (D-J). */
export const CODERABBIT_REVIEWER = 'coderabbit';

/** Build the protocol's own invocation: `coderabbit review --agent --base-commit <sha>`. */
export function coderabbitReviewArgv(baseCommit: string, scope: 'full' | 'uncommitted'): string[] {
  const argv = ['review', '--agent', '--base-commit', baseCommit];
  if (scope === 'uncommitted') argv.push('--uncommitted');
  return argv;
}

/** The one completion status this integration recognizes as a successful terminal review. */
export const TERMINAL_COMPLETE_STATUS = 'review_completed';

/**
 * An AFFIRMATIVE no-fresh/skipped-review notice in the completion message:
 * the reviewer saying IT DID NOT REVIEW, however the status word spells.
 * Matched case-insensitively against the `complete` event's message —
 * recovererd real quota case: "No fresh detailed file review was performed
 * in this run."
 */
const SKIP_NOTICE_RE =
  /no fresh (detailed )?(file )?review|review (was )?skipped|skipped (this )?review/i;

/**
 * One parsed stream event worth keeping. Events are parsed defensively: an
 * unrecognized shape degrades to the counts, never to a fabricated finding
 * or a fabricated completion.
 */
export interface ParsedReviewerStream {
  findings: Omit<DevFinding, 'id'>[];
  /** true when a `complete` event arrived. */
  sawComplete: boolean;
  /** The complete event's status VERBATIM, when one arrived. */
  completeStatus?: string;
  /** Meaningful events and unparsed lines AFTER the (first) complete event. */
  trailingAfterComplete: number;
  /** true when an `error` event arrived. */
  sawError: boolean;
  /** true when an action-required (billing-confirmation-class) event arrived. */
  sawActionRequired: boolean;
  /** The complete event's message VERBATIM, when it carried one. */
  completeMessage?: string;
  /** Non-empty lines that were not valid JSON objects (recorded, never parsed). */
  unparsedLines: number;
  /** The last `status` event's word, when any (diagnostic evidence only). */
  lastStatus?: string;
}

/** True when the value is a plain JSON object (parsed JSON, non-null, non-array). */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The string value of a key, when it is a string. */
function stringAt(event: Record<string, unknown>, key: string): string | undefined {
  const value = event[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * Parse the NDJSON stream (one JSON object per line). Lines that fail to
 * parse count as unparsed and are otherwise ignored — a non-JSON line can
 * never contribute a finding or a completion, so tolerance there cannot
 * fabricate success. Finding severities are preserved verbatim; an
 * undocumented severity word is still recorded (never remapped on write).
 */
export function parseReviewerStream(stdout: string): ParsedReviewerStream {
  const parsed: ParsedReviewerStream = {
    findings: [],
    sawComplete: false,
    trailingAfterComplete: 0,
    sawError: false,
    sawActionRequired: false,
    unparsedLines: 0,
  };
  for (const line of stdout.split('\n')) {
    const text = line.trim();
    if (text === '') continue;
    let event: unknown;
    try {
      event = JSON.parse(text);
    } catch {
      parsed.unparsedLines += 1;
      if (parsed.sawComplete) parsed.trailingAfterComplete += 1;
      continue;
    }
    if (!isJsonObject(event)) {
      parsed.unparsedLines += 1;
      if (parsed.sawComplete) parsed.trailingAfterComplete += 1;
      continue;
    }
    if (parsed.sawComplete) parsed.trailingAfterComplete += 1;
    const type = stringAt(event, 'type');
    switch (type) {
      case 'finding': {
        const severity = stringAt(event, 'severity') ?? 'none';
        const comment = stringAt(event, 'comment');
        const suggestion = event['suggestions'];
        const firstSuggestion =
          Array.isArray(suggestion) && typeof suggestion[0] === 'string'
            ? suggestion[0]
            : undefined;
        const codegen = stringAt(event, 'codegenInstructions');
        const excerpt = codegen ?? comment ?? firstSuggestion;
        const fileName = stringAt(event, 'fileName');
        const finding: Omit<DevFinding, 'id'> = { severity };
        if (fileName !== undefined) finding.fileName = fileName;
        if (excerpt !== undefined) finding.excerpt = excerpt;
        parsed.findings.push(finding);
        break;
      }
      case 'complete': {
        if (!parsed.sawComplete) {
          const status = stringAt(event, 'status');
          if (status !== undefined) parsed.completeStatus = status;
          const message = stringAt(event, 'message');
          if (message !== undefined) parsed.completeMessage = message;
        }
        parsed.sawComplete = true;
        break;
      }
      case 'error':
        parsed.sawError = true;
        break;
      case 'action_required':
        parsed.sawActionRequired = true;
        break;
      case 'status': {
        if (!parsed.sawComplete) {
          const status = stringAt(event, 'status');
          if (status !== undefined) parsed.lastStatus = status;
        }
        break;
      }
      case 'heartbeat':
      case 'review_context':
        // Liveness/context only — reset timers upstream, record nothing.
        break;
      case undefined:
      default:
        // An unrecognized event type: a MALFORMED stream — counted as
        // unparsed, and decideCompletion FAILS CLOSED on any unparsed line:
        // a stream this parser does not fully understand can never pass as
        // a clean cycle.
        parsed.unparsedLines += 1;
        break;
    }
  }
  return parsed;
}

/** The completion verdict of one reviewer run. */
export type ReviewerVerdict = { kind: 'terminal' } | { kind: 'blocked'; reason: string };

/**
 * Decide the cycle's completion from the CLI exit code and the parsed
 * stream, per the FAIL-CLOSED definition (module header). The blocked
 * reasons name the FIRST failing condition, in order: exit status,
 * error/action_required events, MALFORMED stream (any unparsable line or
 * unrecognized event — before the terminal too), missing terminal event,
 * skipped/affirmative no-fresh completion, unrecognized terminal status,
 * trailing stream.
 */
export function decideCompletion(exitCode: number, parsed: ParsedReviewerStream): ReviewerVerdict {
  if (exitCode !== 0) {
    return {
      kind: 'blocked',
      reason: `reviewer CLI exited ${String(exitCode)} (non-zero — no review completed)`,
    };
  }
  if (parsed.sawError) {
    return { kind: 'blocked', reason: 'reviewer stream carried an error event' };
  }
  if (parsed.sawActionRequired) {
    return {
      kind: 'blocked',
      reason:
        'reviewer requested action (usage-limit confirmation class) — the cycle never reviewed',
    };
  }
  if (parsed.unparsedLines > 0) {
    return {
      kind: 'blocked',
      reason: `reviewer stream was MALFORMED — ${String(parsed.unparsedLines)} line(s) were unparsable or of an unrecognized event type; a stream this parser does not fully understand cannot pass as a clean cycle`,
    };
  }
  if (!parsed.sawComplete) {
    return { kind: 'blocked', reason: 'reviewer stream ended without a terminal complete event' };
  }
  if (parsed.completeStatus === 'review_skipped') {
    return {
      kind: 'blocked',
      reason: 'reviewer completed with status review_skipped — no review ran',
    };
  }
  if (parsed.completeMessage !== undefined && SKIP_NOTICE_RE.test(parsed.completeMessage)) {
    return {
      kind: 'blocked',
      reason: `reviewer completed '${parsed.completeStatus}' with an AFFIRMATIVE no-fresh/skipped notice ("${parsed.completeMessage}") — a fresh detailed review never ran`,
    };
  }
  if (parsed.completeStatus !== TERMINAL_COMPLETE_STATUS) {
    return {
      kind: 'blocked',
      reason: `reviewer completed with unrecognized status '${parsed.completeStatus ?? '(missing)'}' — exit success alone is not a review`,
    };
  }
  if (parsed.trailingAfterComplete > 0) {
    return {
      kind: 'blocked',
      reason: `reviewer stream carried ${String(parsed.trailingAfterComplete)} event(s) after the terminal complete — the review did not end there`,
    };
  }
  return { kind: 'terminal' };
}
