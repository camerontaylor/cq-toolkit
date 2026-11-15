/**
 * Binds `runMergedDiscoveryStep`'s `discover` seam to one locked rolling
 * merged-discovery pass: `discoverRolling` over `fileDiscoveryEffects`. The
 * caller owns tick.lock and supplies the shared forge budget. Inactive.
 */
import type { ForgeBudget } from '../../policy/crq/forgeBudget.js';
import { discoverRolling } from '../../queue-runner/discovery.js';
import type { TickMergedDiscoveryEffects } from '../../queue-runner/tickMergedDiscovery.js';
import { fileDiscoveryEffects } from './discoverySource.js';
import type { ReconcileSourceOptions } from './reconcileSource.js';

export function fileTickMergedDiscoveryEffects(
  options: ReconcileSourceOptions & { readonly budget: ForgeBudget },
): TickMergedDiscoveryEffects {
  const effects = fileDiscoveryEffects(options);
  return {
    now: effects.now,
    discover: (interval) => discoverRolling(interval, effects),
  };
}
