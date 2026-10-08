// Fixer budget for sweep.unit — what the op accepts, and what each cap
// honestly does, whatever lane the driver factory resolves.
//
// The lanes are uneven: the subprocess lane checks Budget.maxTokens only
// after the run, leaves maxUsd to caller-side accounting, and ignores
// wallClockMs (the governor's ladder owns wall clock — but the governor's
// limits are RUN-level, not this per-invocation budget). So the op applies
// the per-invocation caps itself, lane-neutrally:
//   - wallClockMs — the ENFORCED SPEND BOUND, and REQUIRED: a deadline
//     signal composed with the governed signal and handed to driver.run; a
//     conforming driver settles 'aborted' (or throws) when it fires, and the
//     op reports the budget trip instead of a cancellation. It is the only
//     cap that stops a fixer IN FLIGHT.
//   - maxTokens / maxUsd — optional POST-RUN LANDING GATES, not spend
//     limits: checked on the settled result, a breach refuses to stage,
//     commit or push the work. maxTokens trips at a usage total at or above
//     the cap; maxUsd trips on a costUSD above the cap and on real usage
//     with NO costUSD (an unpriced model cannot be bound by a USD cap —
//     DD-9: fail loud, never fail open; the governor's rule). They become
//     spend limits only once a lane enforces them in flight, or once fixer
//     spend is reported to the run governor (follow-up).
// maxAttempts is REFUSED: one sweep.unit invocation dispatches the fixer
// once, and attempts are owned by the plan's rescue lane (each redispatch
// is its own job, so no per-invocation attempt ordinal counts them). A cap
// the op cannot enforce is rejected, never silently accepted.

import type { Budget, Usage } from '../../../driver/types.js';

/** setTimeout's ceiling: a larger delay overflows to an immediate fire. */
const MAX_TIMER_MS = 2_147_483_647;

/** The tolerance the governor applies to USD comparisons. */
const USD_EPSILON = 1e-9;

/** Σ of the frozen Usage fields — the fold the lanes check Budget.maxTokens against. */
function totalTokensOf(usage: Usage): number {
  return usage.input + usage.output + usage.cacheRead + usage.cacheWrite + (usage.reasoning ?? 0);
}

/** Why a fixer budget lacks the in-flight bound — the one cap that stops a running fixer. */
const WALL_CLOCK_REQUIRED =
  'budget.wallClockMs is required — it is the only cap enforced while the fixer runs (the in-flight spend bound); maxTokens and maxUsd are optional post-run landing gates that refuse to stage over-budget work, not spend limits';

/**
 * Why `budget` cannot bind a sweep fixer, or null when it can: a usable
 * wallClockMs (required — the enforced spend bound), usable optional
 * maxTokens/maxUsd landing gates, and no maxAttempts.
 */
export function fixerBudgetFault(budget: Budget | undefined): string | null {
  if (budget === undefined) return WALL_CLOCK_REQUIRED;
  if (budget.maxAttempts !== undefined) {
    return 'budget.maxAttempts is not enforceable per fixer invocation — attempts belong to the rescue lane (rescue.maxRedispatch); bound the fixer with wallClockMs';
  }
  if (budget.wallClockMs === undefined) return WALL_CLOCK_REQUIRED;
  if (
    !Number.isInteger(budget.wallClockMs) ||
    budget.wallClockMs < 1 ||
    budget.wallClockMs > MAX_TIMER_MS
  ) {
    return `budget.wallClockMs must be an integer in [1, ${String(MAX_TIMER_MS)}], got ${String(budget.wallClockMs)}`;
  }
  if (
    budget.maxTokens !== undefined &&
    (!Number.isFinite(budget.maxTokens) || budget.maxTokens <= 0)
  ) {
    return `budget.maxTokens must be a finite number > 0, got ${String(budget.maxTokens)}`;
  }
  if (budget.maxUsd !== undefined && (!Number.isFinite(budget.maxUsd) || budget.maxUsd < 0)) {
    return `budget.maxUsd must be a finite number >= 0, got ${String(budget.maxUsd)}`;
  }
  return null;
}

/** The fixer's deadline: the signal to hand the driver, and whether the cap fired. */
export interface FixerDeadline {
  /** The governed signal composed with the wall-clock deadline (undefined when neither exists). */
  signal: AbortSignal | undefined;
  /** True once the wallClockMs deadline (not the governed signal) has fired. */
  expired(): boolean;
  /** Clear the timer; call once the run settles. */
  dispose(): void;
}

/** Arm the wallClockMs deadline over the (optional) governed signal. */
export function startFixerDeadline(
  governed: AbortSignal | undefined,
  wallClockMs: number | undefined,
): FixerDeadline {
  if (wallClockMs === undefined) {
    return { signal: governed, expired: () => false, dispose: () => undefined };
  }
  const deadline = new AbortController();
  let fired = false;
  const timer = setTimeout(() => {
    fired = true;
    deadline.abort(new Error(`sweep fixer budget: wallClockMs ${String(wallClockMs)} elapsed`));
  }, wallClockMs);
  timer.unref();
  return {
    signal: governed === undefined ? deadline.signal : AbortSignal.any([governed, deadline.signal]),
    // A governed cancellation that landed first stays a cancellation.
    expired: () => fired && governed?.aborted !== true,
    dispose: () => clearTimeout(timer),
  };
}

/** The post-run landing gate (maxTokens/maxUsd) the settled run breached, or undefined. */
export function fixerBudgetBreach(
  budget: Budget,
  worker: { usage: Usage; costUSD?: number },
): string | undefined {
  const tokens = totalTokensOf(worker.usage);
  if (budget.maxTokens !== undefined && tokens >= budget.maxTokens) {
    return `token total ${String(tokens)} reached maxTokens ${String(budget.maxTokens)}`;
  }
  if (budget.maxUsd !== undefined) {
    if (worker.costUSD === undefined) {
      if (tokens > 0) {
        return `unpriced usage (${String(tokens)} tokens, no costUSD) under maxUsd ${String(budget.maxUsd)} — a USD cap cannot bind an unpriced model (DD-9)`;
      }
    } else if (worker.costUSD > budget.maxUsd + USD_EPSILON) {
      return `cost ${String(worker.costUSD)} USD exceeded maxUsd ${String(budget.maxUsd)}`;
    }
  }
  return undefined;
}
