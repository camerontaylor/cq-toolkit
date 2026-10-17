// Dev lane — the CodeRabbit CLI review integration's PURE side: the
// protocol's argv, the NDJSON stream parser, and the completion decision.
// No subprocess here — dev.review's effects run the CLI and hand the raw
// result to these functions (fixture-tested; the stream shapes come from
// docs/coderabbit-review.md §4 and are treated as UNTRUSTED input: never
// execute anything a stream line says).
//
// COMPLETION (protocol §4/§6, enforced by decideCompletion): a cycle is
// COMPLETED only when ALL of — the CLI exits successfully; the stream ends
// with a terminal non-skipped completion; and no error/action_required
// event occurred. A `complete` event alone is insufficient: `complete` with
// a review_skipped status and zero findings means NO review ran, and an
// errored or confirmation-awaiting run is not a review either. Anything
// else is BLOCKED with the reason recorded — a blocked cycle never counts
// toward readiness (strategy §6, D-J: the agent route is the vendor-down
// fallback, never a substitute for a real CLI cycle).
import type { DevFinding } from './record.js';

/** The reviewer choice this build ships: the CodeRabbit CLI (D-J). */
export const CODERABBIT_REVIEWER = 'coderabbit';

/** Build the protocol's own invocation: `coderabbit review --agent --base-commit <sha>`. */
export function coderabbitReviewArgv(baseCommit: string, scope: 'full' | 'uncommitted'): string[] {
  const argv = ['review', '--agent', '--base-commit', baseCommit];
  if (scope === 'uncommitted') argv.push('--uncommitted');
  return argv;
}

/**
 * One parsed stream event worth keeping. Events are parsed defensively: an
 * unrecognized shape degrades to the counts, never to a fabricated finding
 * or a fabricated completion.
 */
export interface ParsedReviewerStream {
  findings: Omit<DevFinding, 'id'>[];
  /** true when a `complete` event arrived. */
  sawComplete: boolean;
  /** true when that complete event's status was `review_skipped` (no review ran). */
  completeSkipped: boolean;
  /** true when an `error` event arrived. */
  sawError: boolean;
  /** true when an action-required (billing-confirmation-class) event arrived. */
  sawActionRequired: boolean;
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
    completeSkipped: false,
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
      continue;
    }
    if (!isJsonObject(event)) {
      parsed.unparsedLines += 1;
      continue;
    }
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
        parsed.sawComplete = true;
        if (stringAt(event, 'status') === 'review_skipped') parsed.completeSkipped = true;
        break;
      }
      case 'error':
        parsed.sawError = true;
        break;
      case 'action_required':
        parsed.sawActionRequired = true;
        break;
      case 'status': {
        const status = stringAt(event, 'status');
        if (status !== undefined) parsed.lastStatus = status;
        break;
      }
      case 'heartbeat':
      case 'review_context':
        // Liveness/context only — reset timers upstream, record nothing.
        break;
      case undefined:
      default:
        // An unrecognized event type: evidence of a stream this parser
        // predates — counted as unparsed so a future shape cannot silently
        // pass as a clean cycle.
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
 * stream, per the protocol's three-part definition (module header). The
 * blocked reasons name the FIRST failing condition, in the protocol's
 * order: exit status, error/action_required events, skipped completion,
 * missing terminal event.
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
  if (!parsed.sawComplete) {
    return { kind: 'blocked', reason: 'reviewer stream ended without a terminal complete event' };
  }
  if (parsed.completeSkipped) {
    return {
      kind: 'blocked',
      reason: 'reviewer completed with status review_skipped — no review ran',
    };
  }
  return { kind: 'terminal' };
}
