import { readFile, realpath } from 'node:fs/promises';
import { JsonObject, parseJsonValue } from '../../policy/crq/jsonValue.js';
import { classify } from '../../policy/crq/classification.js';
import type { ReviewCapabilityEffects } from '../../ops/crq/reviewCapability.js';
import { prepareLocalReview } from '../../ops/crq/internal/localReviewPrepare.js';
import { reconcileCompletedLocalReviews } from '../../ops/crq/internal/localReviewReconcile.js';
import { completeLocalReview } from '../../ops/crq/internal/localReviewHarvest.js';
import { republishLocalReview } from '../../ops/crq/internal/localReviewPublish.js';
import { localReviewFactsEffects } from './localReviewFacts.js';
import {
  containedLocalRunArtifact,
  fileLocalHarvestEffects,
  validateLocalReviewIdentity,
} from './localReviewHarvest.js';
import { fileLocalReviewPublishEffects } from './localReviewPublish.js';

/** Caller owns tick.lock throughout preparation, completion, and queue persistence. */
export function createLocalReviewCompletedCaller(options: {
  stateRoot: string;
  runnerRepo: string;
  facts: Pick<ReviewCapabilityEffects, 'historyGit' | 'resolveIdentity'>;
  saveQueue: (queue: JsonObject) => Promise<void>;
  rollout: () => Promise<{ durableArtifactRoot: string } | null>;
  now?: () => Date;
}) {
  const publication = fileLocalReviewPublishEffects(options);
  const harvest = fileLocalHarvestEffects({
    ...options,
    republish: async (queue, item) => {
      const items = queue.get('items');
      const index = Array.isArray(items) ? items.indexOf(item) : -1;
      if (index < 0) throw new Error('publication item missing');
      return republishLocalReview(queue, index, options.runnerRepo, publication);
    },
  });
  const facts = localReviewFactsEffects(options.facts);
  const nowIso = () => `${(options.now ?? (() => new Date()))().toISOString().slice(0, 19)}Z`;
  async function prepare(
    queue: JsonObject,
    item: JsonObject,
    dry: boolean,
    completedOnly: boolean,
  ) {
    if (item.get('kind') !== 'local-review') throw new Error('unsupported review ownership');
    let classifiedBytes: Uint8Array | undefined;
    return prepareLocalReview(queue, item, options.runnerRepo, dry, completedOnly, {
      ...facts,
      validateIdentity: validateLocalReviewIdentity,
      nowIso,
      async readRunMeta(runId) {
        const value = parseJsonValue(
          await readFile(
            await containedLocalRunArtifact(options.stateRoot, runId, 'meta.json'),
            'utf8',
          ),
        );
        if (!(value instanceof JsonObject)) throw new Error('invalid run metadata');
        return value;
      },
      async classifyCompleted(runId, ndjson) {
        // Python parity: a missing retained log classifies as uncounted evidence
        // (proof_complete requires the stream to exist), so preparation falls
        // through to a fresh plan instead of retrying the same reject forever.
        // Only ENOENT is tolerated; mismatch, symlink and containment stay fail-closed.
        try {
          const canonical = await containedLocalRunArtifact(
            options.stateRoot,
            runId,
            'review.ndjson',
          );
          if ((await realpath(ndjson)) !== canonical) throw new Error('cycle artifact mismatch');
          classifiedBytes = await readFile(canonical);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT')
            return new JsonObject([
              ['counted', false],
              ['outcome', 'error'],
            ]);
          throw error;
        }
        return classify(classifiedBytes, 0);
      },
      async completeFromCycle(current, runId, classification, endedAt) {
        if (!classifiedBytes) throw new Error('missing classified artifact');
        return (
          await completeLocalReview(
            current,
            item,
            runId,
            classification,
            endedAt,
            0,
            harvest,
            classifiedBytes,
          )
        ).queue;
      },
    });
  }
  return {
    prepare,
    reconcile: (queue: JsonObject, errorBackoffMinutes: number) =>
      reconcileCompletedLocalReviews(queue, errorBackoffMinutes, {
        nowIso,
        prepareCompleted: async (current, item) =>
          (await prepare(current, item, false, true)).queue,
      }),
  };
}
