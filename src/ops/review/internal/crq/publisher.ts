/**
 * Review-ledger publication driver, behind injected remote and effect seams.
 *
 * This is the effect half of `review_ledger.GitLedger.publish` without any
 * real Git, network or signer: the remote fetches validated history and
 * publishes one planned batch; the driver never trusts a publish outcome as
 * remote acknowledgement. After a successful publish it performs a fresh
 * `fetch()`, validates that exact history, and only then acknowledges the
 * batch. A push that timed out after the remote accepted it is therefore
 * reconciled by the next fetch, exactly as Python's retry loop does.
 *
 * Only {@link PublicationPushError} is retried. Validation, artifact,
 * creditable-review and fetch failures propagate immediately and leave the
 * outbox intact; Python's loop breaks only around `self.push` and lets the
 * other refusals escape.
 *
 * The exclusive publisher lock around the whole attempt loop and the outbox
 * lock are injected; this module invents no lock file and no new policy.
 */
import { JsonObject, type JsonValue } from '../../../../policy/crq/jsonValue.js';
import {
  LedgerIntegrityError,
  ledgerCreditable,
  ledgerValidateSequence,
} from '../../../../policy/crq/ledger.js';
import {
  PUBLICATION_ATTEMPTS,
  PublicationPlanError,
  planPublication,
  type PublicationPlan,
} from '../../../../policy/crq/publication.js';
import type { Outbox } from './outbox.js';

/**
 * A retryable publication push failure: transport unavailability, a rejected
 * push race, or an ambiguous accept-then-timeout. The remote must use this
 * class only for those cases; a local validation defect is not a push failure.
 */
export class PublicationPushError extends Error {
  override readonly name = 'PublicationPushError';

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

/** One validated remote ledger snapshot. */
export interface PublicationSnapshot {
  readonly head: string;
  readonly values: readonly JsonValue[];
}

/** The publication transport seam. The real Git/signer adapter binds this later. */
export interface PublicationRemote {
  /** Fetch and validate the remote ledger. The driver validates again. */
  fetch(): Promise<PublicationSnapshot>;
  /**
   * Create and push one commit for `batch` on top of `baseHead`. The outcome is
   * only a commit/push result: it is never used as remote acknowledgement.
   */
  publish(batch: readonly JsonValue[], baseHead: string): Promise<{ commit: string }>;
}

/**
 * Injected effects the driver requires. `verifyArtifact` and
 * `verifyCreditableReview` are mandatory: a creditable review is never
 * published without the same repository verification Python performs.
 */
export interface PublicationEffects {
  verifyArtifact(reference: JsonValue): Promise<void>;
  verifyCreditableReview(value: JsonValue): Promise<void>;
  /** Hold Python's `review-ledger-publisher.lock` around the attempt loop. */
  withPublisherLock<T>(fn: () => Promise<T>): Promise<T>;
}

export interface PublishOptions {
  readonly attempts?: number;
}

function record(value: JsonValue): JsonObject {
  if (!(value instanceof JsonObject)) throw new LedgerIntegrityError('record is not an object');
  return value;
}

function artifactsOf(value: JsonValue): readonly JsonValue[] {
  const payload = record(value).get('payload');
  if (!(payload instanceof JsonObject))
    throw new LedgerIntegrityError('record payload is not an object');
  const artifacts = payload.get('artifacts');
  if (artifacts === undefined) return [];
  if (!Array.isArray(artifacts)) throw new LedgerIntegrityError('record artifacts is not an array');
  return artifacts;
}

/**
 * Publish every pending outbox record, or refuse with the exact Python
 * pending-publication error. Returns the head observed by the last fresh fetch.
 *
 * Effect order per attempt mirrors `GitLedger.publish`: fetch and validate the
 * ledger, plan causal order (refusing a missing predecessor before any ack),
 * acknowledge records the remote already holds, then for each batch verify the
 * batch's artifacts and creditable reviews, validate the batch extension, push,
 * fresh-fetch, validate that history, and acknowledge the batch. A retryable
 * push failure ends the attempt; the next attempt replans from a fresh fetch.
 */
export async function publish(
  remote: PublicationRemote,
  outbox: Outbox,
  effects: PublicationEffects,
  options: PublishOptions = {},
): Promise<{ head: string }> {
  const attempts = options.attempts ?? PUBLICATION_ATTEMPTS;
  return effects.withPublisherLock(async () => {
    for (let attempt = 0; attempt < attempts; attempt++) {
      const fetched = await remote.fetch();
      let head = fetched.head;
      let values = fetched.values;
      let ids = ledgerValidateSequence(values);
      let ackIds = new Set(ids.keys());
      let plan: PublicationPlan;
      try {
        plan = planPublication({ ledgerValues: values, pending: await outbox.pending() });
      } catch (error) {
        if (error instanceof PublicationPlanError) {
          // Python acknowledges remote-held records as it scans causal order,
          // so a later refusal must not suppress the prefix it already wrote.
          for (const value of error.acks) await outbox.acknowledge(value, ackIds);
        }
        throw error;
      }

      // Python acknowledges already-published records while planning, before
      // any batch effect. Missing causal dependencies have already refused.
      for (const value of plan.acks) await outbox.acknowledge(value, ackIds);

      for (const batch of plan.batches) {
        // Per-batch work runs immediately before this batch's effects. It is
        // deliberately not hoisted: an invalid later batch must not suppress
        // an earlier accepted batch and its acknowledgements.
        for (const value of batch.values) {
          for (const reference of artifactsOf(value)) await effects.verifyArtifact(reference);
          if (ledgerCreditable(value)) await effects.verifyCreditableReview(value);
        }
        ledgerValidateSequence([...values, ...batch.values]);

        try {
          await remote.publish(batch.values, head);
        } catch (error) {
          if (error instanceof PublicationPushError) break;
          throw error;
        }

        // Only a fresh validated fetch is acknowledgement authority. The push
        // outcome may describe a commit the remote never accepted (or accepted
        // after a timeout), so its return value is not used here.
        const fresh = await remote.fetch();
        head = fresh.head;
        values = fresh.values;
        ids = ledgerValidateSequence(values);
        ackIds = new Set(ids.keys());
        for (const value of batch.values) await outbox.acknowledge(value, ackIds);
      }

      if ((await outbox.pending()).length === 0) return { head };
    }
    throw new LedgerIntegrityError('publication pending; retain scope ownership and reconcile');
  });
}
