/**
 * Real bindings for `runDiscoveryPhase`'s effects: the deferred author refresh
 * (forge reads through the phase's budget), the queue save, and push discovery
 * over per-repository git. Merged discovery is the one seam left to the caller
 * (its binding lives with the merged-discovery step). The caller owns
 * tick.lock. Inactive: nothing imports this from a runtime entry point.
 */
import { join } from 'node:path';
import type { GhFn } from '../forge-github/gh.js';
import type { JsonObject } from '../../policy/crq/jsonValue.js';
import { discoverPush } from '../../queue-runner/pushDiscovery.js';
import type { DiscoveryPhaseEffects } from '../../queue-runner/tickDiscoveryPhase.js';
import { atomicWrite } from './atomic.js';
import { fileDeferredRefreshEffects } from './deferredSource.js';
import {
  filePushDiscoveryEffects,
  type PushDiscoverySourceOptions,
} from './pushDiscoverySource.js';
import { queueBytes } from './queueEffects.js';

export function fileDiscoveryPhaseEffects(input: {
  repo: string;
  stateRoot: string;
  gh?: GhFn;
  now?: () => Date;
  push: Omit<PushDiscoverySourceOptions, 'stateRoot' | 'now'>;
  merged: DiscoveryPhaseEffects['merged'];
}): DiscoveryPhaseEffects {
  const now = input.now ?? (() => new Date());
  const saveQueue = (queue: JsonObject): Promise<void> =>
    atomicWrite(join(input.stateRoot, 'queue.json'), queueBytes(queue));
  return {
    nowIso: () => `${now().toISOString().slice(0, 19)}Z`,
    deferred: (budget) =>
      fileDeferredRefreshEffects({
        repo: input.repo,
        stateRoot: input.stateRoot,
        budget,
        ...(input.gh ? { gh: input.gh } : {}),
      }),
    saveQueue,
    merged: input.merged,
    async push(queue) {
      const effects = filePushDiscoveryEffects({ ...input.push, stateRoot: input.stateRoot, now });
      const result = await discoverPush(queue, input.push.repos, false, input.repo, effects);
      await saveQueue(result.queue);
      return result;
    },
  };
}
