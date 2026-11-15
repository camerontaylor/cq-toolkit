/** Inactive binding of the tick's enrollment phase seam (`EnrollmentPhaseEffects`).
 * `discoverOpenPrs` is the already-ported `pr_enroll.enroll` body and
 * `openPrDiscoveryEffects` binds its forge and git reads; this wires its
 * `associate` to the pure `associateLocalReview`, and splits the configured
 * repositories into the primary pass and the non-primary pass. The tick saves the
 * returned queue; this binding writes nothing. tick.lock stays caller-owned.
 *
 * Still caller-injected: `ownRange` (primary repair proof), `event`, and the
 * local-review `facts`/`retained` reads.
 */
import type { EnrollmentPhaseEffects } from '../../queue-runner/tickDiscoveryPhase.js';
import { discoverOpenPrs } from '../../queue-runner/openPrDiscovery.js';
import {
  associateLocalReview,
  type LocalReviewAssociateEffects,
} from '../../queue-runner/localReviewAssociate.js';
import {
  openPrDiscoveryEffects,
  type OpenPrRepository,
  type OpenPrSourceOptions,
} from './openPrDiscoverySource.js';

export interface EnrollmentPhaseSourceOptions {
  readonly repos: readonly OpenPrRepository[];
  readonly primaryRepo: string;
  readonly localReview: LocalReviewAssociateEffects;
  readonly ownRange: OpenPrSourceOptions['ownRange'];
  readonly event: OpenPrSourceOptions['event'];
  readonly gh?: OpenPrSourceOptions['gh'];
  readonly git?: OpenPrSourceOptions['git'];
  readonly now?: OpenPrSourceOptions['now'];
}

export function fileEnrollmentPhaseEffects(
  options: EnrollmentPhaseSourceOptions,
): EnrollmentPhaseEffects {
  const effects = openPrDiscoveryEffects({
    repos: options.repos,
    associate: (queue, repo, pr, base, dry) =>
      associateLocalReview(queue, repo.repo, pr.number, base, pr.head, dry, options.localReview),
    ownRange: options.ownRange,
    event: options.event,
    ...(options.gh ? { gh: options.gh } : {}),
    ...(options.git ? { git: options.git } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  const pass =
    (primary: boolean) => (queue: Parameters<EnrollmentPhaseEffects['primary']>[0], dry: boolean) =>
      discoverOpenPrs(
        queue,
        options.repos.filter((repo) => repo.primary === primary),
        dry,
        options.primaryRepo,
        effects,
      );
  return { primary: pass(true), others: pass(false) };
}
