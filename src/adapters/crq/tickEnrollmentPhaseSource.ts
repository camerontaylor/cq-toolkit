/** Inactive binding of the tick's enrollment phase seam (`EnrollmentPhaseEffects`).
 * `discoverOpenPrs` is the already-ported `pr_enroll.enroll` body and
 * `openPrDiscoveryEffects` binds its forge and git reads; this wires its
 * `associate` to the pure `associateLocalReview`, and splits the configured
 * repositories into the primary pass and the non-primary pass. The tick saves the
 * returned queue; this binding writes nothing. tick.lock stays caller-owned.
 *
 * Still caller-injected: `event` and the
 * local-review `facts`/`retained` reads; `ownRange` may be overridden.
 */
import type { EnrollmentPhaseEffects } from '../../queue-runner/tickDiscoveryPhase.js';
import { discoverOpenPrs } from '../../queue-runner/openPrDiscovery.js';
import {
  associateLocalReview,
  type LocalReviewAssociateEffects,
} from '../../queue-runner/localReviewAssociate.js';
import { repairOwnRange } from '../../queue-runner/repairOwnRange.js';
import { runGitIn } from './publishSource.js';
import {
  openPrDiscoveryEffects,
  type OpenPrRepository,
  type OpenPrSourceOptions,
} from './openPrDiscoverySource.js';

export interface EnrollmentPhaseSourceOptions {
  readonly repos: readonly OpenPrRepository[];
  readonly primaryRepo: string;
  readonly localReview: LocalReviewAssociateEffects;
  /** Defaults to `repair_tick.own_range` over `git rev-list` in the primary clone. */
  readonly ownRange?: OpenPrSourceOptions['ownRange'];
  readonly event: OpenPrSourceOptions['event'];
  readonly gh?: OpenPrSourceOptions['gh'];
  readonly git?: OpenPrSourceOptions['git'];
  readonly now?: OpenPrSourceOptions['now'];
}

export function fileEnrollmentPhaseEffects(
  options: EnrollmentPhaseSourceOptions,
): EnrollmentPhaseEffects {
  const primaryClone = options.repos.find((repo) => repo.primary)?.clone;
  const ownRange: OpenPrSourceOptions['ownRange'] =
    options.ownRange ??
    (async (queue, previousHead, head) => {
      const sha = /^[0-9a-f]{40}$/;
      if (!primaryClone || !sha.test(previousHead) || !sha.test(head))
        throw new Error('invalid repair range');
      const run =
        options.git?.(options.repos.find((repo) => repo.primary) as OpenPrRepository) ??
        runGitIn(primaryClone);
      const result = await run(['rev-list', `${previousHead}..${head}`]);
      if (result.code !== 0) throw new Error('repair range unavailable');
      const commits = new TextDecoder()
        .decode(result.stdout)
        .split('\n')
        .filter((line) => line.length > 0);
      return repairOwnRange(queue, commits);
    });
  const effects = openPrDiscoveryEffects({
    repos: options.repos,
    associate: (queue, repo, pr, base, dry) =>
      associateLocalReview(queue, repo.repo, pr.number, base, pr.head, dry, options.localReview),
    ownRange,
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
