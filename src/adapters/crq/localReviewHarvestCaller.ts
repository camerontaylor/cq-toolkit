import { JsonObject } from '../../policy/crq/jsonValue.js';
import { harvestLocalReviewExit } from '../../ops/crq/internal/localReviewExit.js';
import { republishLocalReview } from '../../ops/crq/internal/localReviewPublish.js';
import { GitPool } from './gitExec.js';
import { fileLocalHarvestEffects } from './localReviewHarvest.js';
import { fileLocalReviewPublishEffects } from './localReviewPublish.js';
import { fileLocalExitHarvestEffects } from './localReviewExit.js';
import { localReviewCleanup } from './localReviewCleanup.js';

/** Assemble real effects. The caller holds tick.lock and persists returned wait reasons. */
export function createLocalReviewHarvestCaller(options: {
  stateRoot: string;
  runnerRepo: string;
  config: JsonObject;
  pool: GitPool;
  saveQueue: (queue: JsonObject) => Promise<void>;
  rollout: () => Promise<{ durableArtifactRoot: string } | null>;
  defaultBackoffMinutes: number;
  now?: () => Date;
}) {
  const publication = fileLocalReviewPublishEffects({
    stateRoot: options.stateRoot,
    rollout: options.rollout,
    saveQueue: options.saveQueue,
  });
  const harvest = fileLocalHarvestEffects({
    stateRoot: options.stateRoot,
    saveQueue: options.saveQueue,
    republish: async (queue, item) => {
      const items = queue.get('items');
      if (!Array.isArray(items)) throw new Error('missing queue items');
      const index = items.indexOf(item);
      if (index < 0) throw new Error('publication item missing');
      return republishLocalReview(queue, index, options.runnerRepo, publication);
    },
  });
  const effects = fileLocalExitHarvestEffects({
    stateRoot: options.stateRoot,
    harvest,
    cleanup: localReviewCleanup({
      config: options.config,
      runnerRepo: options.runnerRepo,
      pool: options.pool,
    }),
    ...(options.now ? { now: options.now } : {}),
  });
  return (queue: JsonObject, item: JsonObject, dry: boolean) =>
    harvestLocalReviewExit(queue, item, dry, options.defaultBackoffMinutes, effects);
}
