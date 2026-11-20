/**
 * Config-driven bindings for the tick's discovery-side phases (S6-d). Inactive:
 * nothing imports this from a runtime entry point, and tick.lock stays
 * caller-owned. It turns the decoded runner config into the three `TickPhases`
 * members that need it:
 *
 * - `discovery(queue)`: deferred refresh -> merged discovery -> push discovery;
 * - `enrollPrimary` / `enrollOthers`: open-PR enrollment from `REPOS`;
 * - `mergedDiscoveryEnabled()`: `CONFIG["merged_discovery"]` is a dict with
 *   `enabled is True`.
 *
 * Merged discovery needs one binding of its own. Python's `discover_merged`
 * works on the caller's in-memory `q` and saves it; the ported
 * `discoverRolling` reloads the queue from disk. So the in-memory queue is
 * saved before the first reload, but only once the rolling interval is known to
 * be valid, so Python's "merged discovery disabled: invalid configured
 * interval" fallback still persists nothing.
 */
import type { GhFn } from '../forge-github/gh.js';
import type { ForgeBudget } from '../../policy/crq/forgeBudget.js';
import { JsonObject } from '../../policy/crq/jsonValue.js';
import type { LocalReviewAssociateEffects } from '../../queue-runner/localReviewAssociate.js';
import type { PhaseResult } from '../../queue-runner/tickOrchestrator.js';
import {
  runDiscoveryPhase,
  type DiscoveryPhaseEffects,
  type EnrollmentPhaseEffects,
} from '../../queue-runner/tickDiscoveryPhase.js';
import { runMergedDiscoveryStep } from '../../queue-runner/tickMergedDiscovery.js';
import { buildDiscoveryRepos } from './discoveryRepos.js';
import { fileDiscoveryEffects } from './discoverySource.js';
import { discoverRolling } from '../../queue-runner/discovery.js';
import type { OpenPrSourceOptions } from './openPrDiscoverySource.js';
import type { PushDiscoverySourceOptions } from './pushDiscoverySource.js';
import { fileDiscoveryPhaseEffects } from './tickDiscoveryPhaseSource.js';
import { fileEnrollmentPhaseEffects } from './tickEnrollmentPhaseSource.js';

/** `isinstance(CONFIG.get("merged_discovery"), dict) and ...["enabled"] is True`. */
export function mergedDiscoveryEnabled(config: JsonObject): boolean {
  const merged = config.get('merged_discovery');
  return merged instanceof JsonObject && merged.get('enabled') === true;
}

export interface MergedBindingOptions {
  readonly repo: string;
  readonly stateRoot: string;
  readonly gh?: GhFn;
  readonly now?: () => Date;
}

/** The `DiscoveryPhaseEffects['merged']` binding for one config. */
export function mergedDiscoveryBinding(
  config: JsonObject,
  options: MergedBindingOptions,
): DiscoveryPhaseEffects['merged'] {
  return async (queue, budget: ForgeBudget) => {
    const effects = fileDiscoveryEffects({ ...options, budget });
    // Python's `if after >= before: return []` cannot be reached: `rollingInterval`
    // refuses an empty interval, which is the "invalid configured interval" fallback.
    return runMergedDiscoveryStep(queue, config.get('merged_discovery'), {
      now: effects.now,
      async discover(interval) {
        // `discoverRolling` reloads from disk: make the threaded queue the disk queue first.
        await effects.saveQueue(queue);
        return discoverRolling(interval, effects);
      },
    });
  };
}

export interface TickDiscoveryBindingOptions extends MergedBindingOptions {
  /** The decoded runner config: `repo`, `clone`, `quiet_minutes`, `repos`, `merged_discovery`. */
  readonly config: JsonObject;
  readonly push: Pick<PushDiscoverySourceOptions, 'event' | 'git'>;
  readonly enroll: {
    readonly localReview: LocalReviewAssociateEffects;
    readonly event: OpenPrSourceOptions['event'];
    readonly ownRange?: OpenPrSourceOptions['ownRange'];
    readonly git?: OpenPrSourceOptions['git'];
  };
}

export interface TickDiscoveryBinding {
  discovery(queue: JsonObject): Promise<PhaseResult>;
  enrollPrimary(queue: JsonObject, dry: boolean): Promise<PhaseResult>;
  enrollOthers(queue: JsonObject, dry: boolean): Promise<PhaseResult>;
  mergedDiscoveryEnabled(): boolean;
}

/** Parses `repos` once (fail-closed) and binds the three phases to it. */
export function tickDiscoveryBinding(options: TickDiscoveryBindingOptions): TickDiscoveryBinding {
  const { config } = options;
  const repos = buildDiscoveryRepos(config);
  const primaryRepo = options.repo;
  const discoveryEffects = fileDiscoveryPhaseEffects({
    repo: primaryRepo,
    stateRoot: options.stateRoot,
    ...(options.gh ? { gh: options.gh } : {}),
    ...(options.now ? { now: options.now } : {}),
    push: {
      repos: repos.push,
      event: options.push.event,
      ...(options.push.git ? { git: options.push.git } : {}),
    },
    merged: mergedDiscoveryBinding(config, options),
  });
  let enrollment: EnrollmentPhaseEffects | undefined;
  const enroll = (): EnrollmentPhaseEffects =>
    (enrollment ??= fileEnrollmentPhaseEffects({
      repos: repos.pr,
      primaryRepo,
      localReview: options.enroll.localReview,
      event: options.enroll.event,
      ...(options.enroll.ownRange ? { ownRange: options.enroll.ownRange } : {}),
      ...(options.enroll.git ? { git: options.enroll.git } : {}),
      ...(options.gh ? { gh: options.gh } : {}),
      ...(options.now ? { now: options.now } : {}),
    }));
  return {
    // `TickPhases.discovery` is called only for live, unrestricted ticks.
    discovery: (queue) => runDiscoveryPhase(queue, { dry: false, only: null }, discoveryEffects),
    enrollPrimary: (queue, dry) => enroll().primary(queue, dry),
    enrollOthers: (queue, dry) => enroll().others(queue, dry),
    mergedDiscoveryEnabled: () => mergedDiscoveryEnabled(config),
  };
}
