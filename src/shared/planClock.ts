// The plan-clock guard shared by every dispatched op that takes a plan- or
// op-input-supplied clock reading (`nowMs`): merge.classifyPrs, merge.runPrs,
// review.classifyThreads and review.replyAndResolve.
import { DispatchError } from '../driver/errors.js';

/**
 * A plan/op-input clock must be a finite, non-negative number no later than
 * the real clock; anything else fails with `config` (the value is never
 * echoed). Rejecting, not clamping, keeps the dispatched ops deterministic for
 * every accepted clock reading: a later clock would shorten a wait or mark evidence as
 * older than it is, an earlier one only lengthens it.
 */
export function assertPlanClock(op: string, nowMs: unknown): number {
  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs) || nowMs < 0 || nowMs > Date.now()) {
    throw new DispatchError(
      'config',
      `${op}: input.nowMs must be a finite, non-negative clock reading no later than the current time (value not echoed)`,
    );
  }
  return nowMs;
}
