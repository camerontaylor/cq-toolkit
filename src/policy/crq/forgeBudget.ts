/**
 * The aggregate forge request/deadline allowance (`crq.ForgeBudget`).
 *
 * One budget bounds a whole recovery pass, not one request: the deadline starts
 * at the FIRST read, is never restarted, and requests are never replenished.
 * `take` is therefore the only mutator, and callers translate its
 * {@link RefreshExhausted} refusal into their own typed partial result instead
 * of retrying (Python `deferred_refresh.RefreshExhausted`).
 *
 * The two allowances in use:
 *
 * - the tick's shared recovery window: 24 requests over 30 seconds, spent by
 *   deferred refresh and merged/push discovery before reconcile runs;
 * - reconcile's own window: 80 requests over 60 seconds (`crq.py` around
 *   `repair_tick.reconcile_fix_prs`), because the tick allowance is already
 *   gone when the reconcile pass starts.
 */
export const DEFAULT_FORGE_REQUESTS = 24;
export const DEFAULT_FORGE_SECONDS = 30;
export const RECONCILE_FORGE_REQUESTS = 80;
export const RECONCILE_FORGE_SECONDS = 60;
/** `ForgeBudget.take`'s per-request ceiling, in seconds. */
export const MAX_TAKE_SECONDS = 10;

/** `deferred_refresh.RefreshExhausted`: the aggregate allowance ended. */
export class RefreshExhausted extends Error {
  override readonly name = 'RefreshExhausted';
  readonly pythonError = 'RefreshExhausted';

  constructor(message: string) {
    super(message);
  }
}

export interface ForgeBudgetOptions {
  readonly requests?: number;
  readonly seconds?: number;
  /** Python `time.monotonic`; seconds may be fractional. */
  readonly clock?: () => number;
}

/**
 * A single-use allowance. `deadline` is `null` until the first request, then a
 * monotonic instant; a budget cannot be reused after it expires because neither
 * field is ever reset.
 */
export class ForgeBudget {
  readonly clock: () => number;
  readonly seconds: number;
  deadline: number | null = null;
  remaining: number;

  constructor(options: ForgeBudgetOptions = {}) {
    this.clock = options.clock ?? (() => performance.now() / 1000);
    this.seconds = options.seconds ?? DEFAULT_FORGE_SECONDS;
    this.remaining = options.requests ?? DEFAULT_FORGE_REQUESTS;
  }

  available(): boolean {
    return (
      this.remaining > 0 &&
      this.seconds > 0 &&
      (this.deadline === null || this.clock() < this.deadline)
    );
  }

  /**
   * Spend one request and return the timeout the effect may use. The deadline
   * starts once, at the first read; the return is clamped to
   * `[0.001, MAX_TAKE_SECONDS]` so a nearly-expired window still yields a usable
   * positive timeout.
   */
  take(): number {
    if (this.deadline === null) this.deadline = this.clock() + this.seconds;
    if (!this.available()) {
      throw new RefreshExhausted('aggregate forge budget exhausted; debt retained');
    }
    this.remaining -= 1;
    return Math.max(0.001, Math.min(MAX_TAKE_SECONDS, this.deadline - this.clock()));
  }
}

/** The reconcile pass's own allowance. */
export function reconcileForgeBudget(clock?: () => number): ForgeBudget {
  return new ForgeBudget({
    requests: RECONCILE_FORGE_REQUESTS,
    seconds: RECONCILE_FORGE_SECONDS,
    ...(clock === undefined ? {} : { clock }),
  });
}
