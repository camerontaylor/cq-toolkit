/** Inactive binding for one locked rolling merged-discovery pass. */
import { reconcileMerged } from '../../ops/crq/reconcileMerged.js';
import type { ForgeBudget } from '../../policy/crq/forgeBudget.js';
import type { DiscoveryEffects } from '../../queue-runner/discovery.js';
import { fileReconcileMergedEffects, type ReconcileSourceOptions } from './reconcileSource.js';
import { pruneRollingWrappers } from './rollingPrune.js';

/** The caller owns tick.lock and supplies a shared forge budget in options. */
export function fileDiscoveryEffects(
  options: ReconcileSourceOptions & { readonly budget: ForgeBudget },
): DiscoveryEffects {
  const source = fileReconcileMergedEffects(options);
  return {
    loadQueue: source.loadQueue,
    saveQueue: source.saveQueue,
    reconcile: (interval) => reconcileMerged({ ...interval, pageBudget: 4, recent: true }, source),
    prune: (queue, cutoff) => pruneRollingWrappers(options.stateRoot, options.repo, queue, cutoff),
    now: options.now ?? (() => new Date()),
  };
}
