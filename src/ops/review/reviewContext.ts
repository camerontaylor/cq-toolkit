// review family — the ONE shared bounded review-context extraction (Q5,
// #499): the commit intent and the changed-file list that travel to the
// session reviewer as PROMPT EVIDENCE, never as coverage. Extracted from
// review.run's inline collection so the dev.review agent route can send the
// identical bounded context without a second spelling of the rules.
//
// BOUNDS (the reviewPlan context caps, mirrored at collection so a giant
// intent or numstat is truncated once here and never re-measured downstream):
// the intent carries a visible truncation marker INSIDE the cap; the file
// list is capped identically. The cap numbers are duplicated values, not
// imports: reviewPlan owns its prompt-budget arithmetic, this module owns
// collection-time truncation, and neither may silently drift its semantics.
//
// SCOPE TRUTH: the caller names the comparison. A FULL scope passes the
// pinned base (committed diff `base..head`); an UNCOMMITTED scope passes
// 'HEAD' (staged+unstaged, run.ts's existing comparison point), so the file
// list ALWAYS describes the scope it is collected in — committed history
// never masquerades as dirty-work context, and vice versa.
//
// UNTRUSTED INPUT: both products come from git subprocesses and flow into a
// prompt that the engine scans before upload, exactly like the diff. The
// helper adds nothing to them — no interpretation, no filtering beyond the
// caps — so the existing scan-before-upload gate keeps covering every byte.
import type { DevEffects } from '../dev/effects.js';
import { HARDENED_DIFF_FLAGS } from '../../shared/gitHarden.js';

/** The commit-intent cap; the truncation marker fits inside it. */
export const REVIEW_CONTEXT_INTENT_CAP = 4_000;

/** The changed-file list cap (numstat text), truncated with the same rule. */
export const REVIEW_CONTEXT_FILE_LIST_CAP = 4_000;

/** The git read wall-clock cap for one context read (run.ts's 60s ceiling). */
const CONTEXT_READ_TIMEOUT_MS = 60_000;

/**
 * The guaranteed room for the truncation marker: kept = cap minus this,
 * so `result.length <= cap` ALWAYS holds and the omission count equals
 * the characters the reader will not see.
 */
const TRUNCATION_MARKER_FLOOR = 64;

/**
 * Truncate to `cap` with a visible marker inside the cap. The marker's
 * omission count is the number of characters NOT PRESENT in the result
 * (original length minus the kept prefix), so the marker is truthful about
 * what the reader will not see, whatever the marker's own length.
 */
export function capBoundedContext(text: string, cap: number): string {
  if (text.length <= cap) return text;
  const kept = Math.max(0, cap - TRUNCATION_MARKER_FLOOR);
  const marker = `\n[truncated: ${String(text.length - kept)} characters omitted]`;
  return text.slice(0, kept) + marker;
}

/** Which diff the context describes. The file list must match this scope. */
export type ReviewContextScope = 'full' | 'uncommitted';

/** The bounded reviewer context: prompt evidence only, never coverage. */
export interface BoundedReviewContext {
  /** The commit subject+body of `comparison..head`, capped. */
  intent: string;
  /** The numstat file list of `comparison`, capped. */
  fileList: string;
  /** The scope both fields were collected in (echoed for the caller's log). */
  scope: ReviewContextScope;
}

/** A context collection that did not complete. */
export type ReviewContextFault = {
  ok: false;
  /**
   * true when the CALLER's own deadline/signal stopped the read (an abort
   * or exhausted budget must fail the whole review path, never degrade to
   * a contextless run); false for a per-read git exit that run.ts records
   * as a blocked agent source.
   */
  fatal: boolean;
  reason: string;
};

/**
 * Collect the bounded commit intent and numstat file list for ONE
 * comparison — the exact reads review.run performs today, extracted
 * verbatim (same argv shapes, same hardened diff flags, same
 * deadline/signal sharing, same exit-to-reason mapping), pure in the
 * effects seam and capped at the boundary.
 *
 * @param comparison the diff point: the pinned immutable base for a full
 *   scope, 'HEAD' for uncommitted — chosen BY THE CALLER so the list
 *   cannot describe a different scope than the review covers.
 */
export async function collectBoundedReviewContext(
  effects: DevEffects,
  comparison: string,
  head: string,
  scope: ReviewContextScope,
  deadline: { signal?: AbortSignal; remainingWallMs: () => number },
): Promise<{ ok: true; context: BoundedReviewContext } | ReviewContextFault> {
  const callOptions = (): { timeoutMs: number; signal?: AbortSignal } => ({
    timeoutMs: Math.max(1, Math.min(CONTEXT_READ_TIMEOUT_MS, deadline.remainingWallMs())),
    ...(deadline.signal === undefined ? {} : { signal: deadline.signal }),
  });
  // A DEADLINE GUARD, not a clamp: an exhausted (<= 0) or non-finite
  // remaining budget is FATAL before and after every await. A successful
  // git exit must never settle a context read the caller's budget could
  // not cover — the wall budget, not the subprocess exit, is the gate.
  const budgetGuard = (when: string): ReviewContextFault | null => {
    const remaining = deadline.remainingWallMs();
    if (!Number.isFinite(remaining) || remaining > 0) return null;
    return {
      ok: false,
      fatal: true,
      reason: `review wall budget ${when} — review context not collected (${String(remaining)}ms remaining)`,
    };
  };
  try {
    const before = budgetGuard('was exhausted before the context reads');
    if (before !== null) return before;
    deadline.signal?.throwIfAborted();
    const log = await effects.runCommand(
      'git',
      ['log', '--format=%s%n%n%b', `${comparison}..${head}`],
      callOptions(),
    );
    if (log.exitCode !== 0) {
      return {
        ok: false,
        fatal: false,
        reason: `could not collect review intent (exit ${log.exitCode === null ? 'none (killed)' : String(log.exitCode)})`,
      };
    }
    deadline.signal?.throwIfAborted();
    const afterLog = budgetGuard('was exhausted after the intent read');
    if (afterLog !== null) return afterLog;
    deadline.signal?.throwIfAborted();
    const numstat = await effects.runCommand(
      'git',
      ['diff', '--numstat', ...HARDENED_DIFF_FLAGS, comparison],
      callOptions(),
    );
    if (numstat.exitCode !== 0) {
      return {
        ok: false,
        fatal: false,
        reason: `could not list review diff stats (exit ${numstat.exitCode === null ? 'none (killed)' : String(numstat.exitCode)})`,
      };
    }
    deadline.signal?.throwIfAborted();
    const afterNumstat = budgetGuard('was exhausted after the file-list read');
    if (afterNumstat !== null) return afterNumstat;
    return {
      ok: true,
      context: {
        intent: capBoundedContext(log.stdout, REVIEW_CONTEXT_INTENT_CAP),
        fileList: capBoundedContext(numstat.stdout, REVIEW_CONTEXT_FILE_LIST_CAP),
        scope,
      },
    };
  } catch (error) {
    return {
      ok: false,
      fatal: true,
      reason: `could not collect review context — ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
