// forge — the ONE Forge interface over this adapter's GitHub capabilities
// (Phase 1.4, migration plan step 1.4: "one Forge interface + one gh runner").
// The ops families keep consuming their individual seams directly (GhFn,
// PrEffects, MergeEffects, BaselinePrEffects, fetchReviewState,
// snapshotPrState — each injected at the call site exactly as before); this
// module is the umbrella TYPE over those capabilities and the single
// composition point the Phase 1.6 deps bag (`ops receive { forge, git,
// store, … }`) will bind once, instead of each registry importer assembling
// its own. No op consumes Forge yet — it is declared here so the adapter
// layer owns its port shape before the wiring PR lands.
//
// Everything composes the SAME transport (makeGhRunner, the CQ_GH_BIN-
// honouring gh seam) and stays INERT at construction: no env read beyond the
// runner's own CQ_GH_BIN lookup at invocation time, no spawn, no network —
// building a Forge is closure-building only, so a composition root can
// construct it eagerly.
import type { BaselinePrEffects } from '../../ops/ratchet/proposeBaselineUpdate.js';
import type { SubprocessPrEffectsOptions } from './ghEffects.js';
import type { PrEffects } from '../../ops/pr/assemblePrs.js';
import type { RealMergeEffectsOpts } from './mergeEffects.js';
import {
  fetchReviewState,
  type FetchReviewStateCaps,
  type FetchReviewStateInput,
  type FetchedReviewState,
} from './fetchReviewState.js';
import { snapshotPrState, type PrSnapshot, type SnapshotPrStateOpts } from './snapshotPrState.js';
import { makeSubprocessPrEffects } from './ghEffects.js';
import { makeSubprocessBaselinePrEffects } from './ratchetEffects.js';
import { realMergeEffects, type MergeEffects } from './mergeEffects.js';
import { makeGhRunner, type GhFn } from './gh.js';

/** The one GitHub-facing port: the gh transport plus the forge reads and
 * effect bindings every ops family consumes, under one injectable value. */
export interface Forge {
  /** The gh transport — every read and mutation rides it. Honours
   * CQ_GH_BIN (the CLI-driven test seam) at invocation time. */
  readonly run: GhFn;
  /** Pull one PR's full review state (review threads + reviews + flat REST
   * collections) into the shared threads vocabulary. */
  readonly fetchReviewState: (
    input: FetchReviewStateInput,
    caps?: FetchReviewStateCaps,
    run?: GhFn,
  ) => Promise<FetchedReviewState>;
  /** Capture one instant of a PR's state for the anti-hallucination
   * verify (head sha, REST comment ids, resolved thread ids). */
  readonly snapshotPrState: (opts: SnapshotPrStateOpts) => Promise<PrSnapshot>;
  /** The PR-lane effects binding (search/create/edit/comment/readiness)
   * for the checkout at `repoRoot`. */
  readonly prEffects: (repoRoot: string, timeouts?: SubprocessPrEffectsOptions) => PrEffects;
  /** The ratchet propose-baseline PR effects binding scoped to `base`. */
  readonly baselinePrEffects: (repoRoot: string, base: string) => BaselinePrEffects;
  /** The merge-family effects binding (the I3-guarded git/gh mutations). */
  readonly mergeEffects: (opts: RealMergeEffectsOpts) => MergeEffects;
}

/**
 * The shipped Forge binding: the gh runner plus each family's production
 * effects factory, composed once. Inert at construction (every member is a
 * closure; subprocesses spawn only when an effect or read is called).
 */
export function makeForge(): Forge {
  return {
    run: makeGhRunner(),
    fetchReviewState,
    snapshotPrState,
    prEffects: makeSubprocessPrEffects,
    baselinePrEffects: makeSubprocessBaselinePrEffects,
    mergeEffects: realMergeEffects,
  };
}
