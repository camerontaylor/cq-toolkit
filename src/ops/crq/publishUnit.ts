/**
 * Python's `backfill_publisher.main`: one publisher run's full tick, not just
 * the publication body.
 *
 * Order and failure semantics, kept exactly:
 *
 * 1. `review_notify.drain` runs first. A drain failure is reported as
 *    `retry-pending` and never blocks the publication that follows.
 * 2. `run` publishes and reconciles. Its failure propagates with the failure
 *    marker and queue halt already persisted under the publisher lock.
 * 3. `backfill_coverage.run(published_head=...)` refreshes the off-lock
 *    snapshots selection reads. A refresh failure is demoted to a
 *    `failed: <message>` result; publication has already succeeded and must
 *    still be journalled.
 * 4. `coverageFailed` decides the unit's exit status: a failed refresh or any
 *    errored/invalid target fails the unit visibly, so an operator sees the
 *    stale-coverage defect even though publication succeeded.
 *
 * The outcome JSON is `{publication|ledger_head, notifications?, coverage}`;
 * `notifications` is present only when a drain ran (a positive count) or
 * failed (`retry-pending`), exactly Python's truthiness gate.
 */
import { coverageFailed } from '../../policy/crq/coverageSnapshot.js';
import {
  PublishRolloutDisabled,
  runPublish,
  type PublishRunEffects,
  type PublishRunResult,
} from './publishRun.js';

/** Python's `str(exc)[:300]` truncation for the persisted failure text. */
const ERROR_CHARS = 300;

function truncated(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return [...text].slice(0, ERROR_CHARS).join('');
}

/** The unit's injected effects: publication plus the two daemon phases. */
export interface PublishUnitEffects extends PublishRunEffects {
  /** `review_notify.drain(c)`: rows delivered this run. */
  drainNotifications(): Promise<number>;
  /** `backfill_coverage.run(c, published_head=...)`. */
  refreshCoverage(publishedHead: string | undefined): Promise<unknown>;
}

/** `backfill_publisher.main`'s result document. */
export interface PublishUnitOutcome {
  readonly ledger_head?: string;
  readonly publication: PublishRunResult['publication'];
  readonly notifications?: number | 'retry-pending';
  readonly coverage: unknown;
}

/**
 * `backfill_publisher.main`: notifications, publication, coverage refresh.
 * Throws only when publication itself fails (Python's `run` propagates).
 */
export async function runPublishMain(effects: PublishUnitEffects): Promise<PublishUnitOutcome> {
  let notifications: number | 'retry-pending';
  try {
    notifications = await effects.drainNotifications();
  } catch {
    notifications = 'retry-pending';
  }
  const result: PublishRunResult = await runPublish(effects).catch((error: unknown) => {
    // Python's `run(c)` reports an absent rollout as `{"publication":
    // "disabled"}`; the coverage phase below still runs and reports disabled
    // from the same absent rollout, so main() keeps its single shape.
    if (error instanceof PublishRolloutDisabled) return { publication: 'disabled' };
    throw error;
  });
  let coverage: unknown;
  try {
    coverage = await effects.refreshCoverage(result.ledger_head);
  } catch (error) {
    // A refresh failure never hides the publication result.
    coverage = `failed: ${truncated(error)}`;
  }
  return {
    ...(result.ledger_head === undefined ? {} : { ledger_head: result.ledger_head }),
    publication: result.publication,
    // Python's `if notifications:` skips a zero count; a failed drain string is
    // always reported.
    ...(notifications === 0 ? {} : { notifications }),
    coverage,
  };
}

/** `backfill_publisher.coverage_failed(outcome)`: the unit's exit status. */
export function publishUnitFailed(outcome: PublishUnitOutcome): boolean {
  return coverageFailed(outcome.coverage);
}
