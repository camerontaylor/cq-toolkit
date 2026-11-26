/**
 * The merged half of `CoverageEffects` (src/queue-runner/coverageUsage.ts): the
 * seams a faithful module exists for. Inactive: nothing routes it, and
 * `LIVE_UNIT_COMMANDS` and `repairUnit.ts` are untouched.
 *
 * Bound here:
 * - `mergeQueueSha`, `diffNameOnly` and `measureMerged` over one injected
 *   {@link MeasureGit} (`crq.git`, `path_exists`);
 * - `coverageCandidate`, `legacyOrigins` and `legacyRetryAllowed` over
 *   `src/policy/crq/coverageLegacy.ts` (`coverage.py`), with Python's
 *   `except (ValueError, KeyError, TypeError)` mapped onto
 *   {@link CoverageIdentityError} and every other escape left to propagate.
 *
 * - `rank4Gate`, `bindRun` and `cancelBeforeVendor` over
 *   `src/adapters/crq/coverageBackfillSeams.ts` (`backfill_runtime.rank4_gate`,
 *   `backfill_jobs.bind_run` / `cancel_before_vendor`); the gate's own effects
 *   (clock, ordinary eligibility, usage refresh, state-event outbox, queue
 *   writer) arrive as {@link Rank4Collaborators}.
 *
 * - `buildSynthetic` over `src/adapters/crq/buildSynthetic.ts` (`crq.build_synthetic`)
 *   when {@link CoverageEffectsInput.synthetic} supplies the clone's git, accounting
 *   and subject repositories; without it the caller's injected one is used, and an
 *   unbound one must throw.
 *
 * - `nowMs`, `parseIsoMs`, `liveItems`, `compareItems` and `depsMet` over
 *   `src/adapters/crq/coverageTickSeams.ts` when {@link CoverageEffectsInput.tick}
 *   supplies the injected clock and scheduling config, and
 *   `backfillDispatchConfigured` over the same file when
 *   {@link CoverageEffectsInput.dispatch} supplies the state root and policy
 *   loader; without them the caller's injected one is used.
 *
 * Left injected: `select` (its launch half builds the real ledger, artifact
 * store, outbox and publisher spool over the clone and calls `launch`, which is
 * itself unbound). A member that is neither bound nor injected must throw,
 * never succeed.
 */
import {
  bindBindRun,
  bindCancelBeforeVendor,
  bindRank4Gate,
  type Rank4Collaborators,
} from './coverageBackfillSeams.js';
import { buildSynthetic, type BuildSyntheticDeps } from './buildSynthetic.js';
import {
  bindBackfillDispatchConfigured,
  bindTickSeams,
  type DispatchSettingsInput,
  type TickSeamsInput,
} from './coverageTickSeams.js';
import {
  measureMerged,
  type MeasureGit,
  type MeasureMergedConfig,
} from '../../queue-runner/measureMerged.js';
import {
  CoverageIdentityError,
  type CoverageEffects,
  type Item,
  type Queue,
} from '../../queue-runner/coverageUsage.js';
import {
  coverageCandidate,
  legacyOrigins,
  legacyRetryAllowed,
} from '../../policy/crq/coverageLegacy.js';
import { pyTruthy } from '../../policy/crq/coverageUtilization.js';
import { PyError, type Dict } from '../../policy/crq/pyCompat.js';
import { UtcInstant } from '../../policy/crq/utc.js';

/**
 * The seams `coverage_fallback` needs that no merged module implements yet:
 * `select` is required; the tick seams, the dispatch switch and `buildSynthetic`
 * may be injected when their binding input is not supplied.
 */
export type InjectedCoverageSeams = Pick<CoverageEffects, 'select'> &
  Partial<
    Pick<
      CoverageEffects,
      | 'backfillDispatchConfigured'
      | 'liveItems'
      | 'compareItems'
      | 'nowMs'
      | 'parseIsoMs'
      | 'depsMet'
      | 'buildSynthetic'
    >
  >;

export interface CoverageEffectsInput {
  readonly git: MeasureGit;
  readonly measure: MeasureMergedConfig;
  /** `CONFIG.get("coverage", {})`: `max_paths`, `min_age_hours`, `excluded_paths`. */
  readonly coverageConfig: Dict;
  /** The effects `rank4_gate` reaches through `c`: clock, eligibility, refresh, outbox, writer. */
  readonly rank4: Rank4Collaborators;
  readonly injected: InjectedCoverageSeams;
  /** Binds `buildSynthetic` over the primary clone; absent, `injected.buildSynthetic` is used. */
  readonly synthetic?: BuildSyntheticDeps;
  /** Binds the clocks and queue helpers; absent, the injected ones are used. */
  readonly tick?: TickSeamsInput;
  /** Binds `backfillDispatchConfigured`; absent, the injected one is used. */
  readonly dispatch?: DispatchSettingsInput;
}

const COVERAGE_KEYS = new Set(['max_paths', 'min_age_hours', 'excluded_paths']);

/** `coverage_candidate(..., **CONFIG["coverage"])`: an unknown key is a TypeError. */
function candidateParams(config: Dict, mergeQueueSha: string, nowMs: number) {
  for (const key of Object.keys(config)) {
    if (!COVERAGE_KEYS.has(key)) {
      throw new PyError(
        'TypeError',
        `coverage_candidate() got an unexpected keyword argument '${key}'`,
      );
    }
  }
  return {
    mergeQueueSha,
    ordinaryEligible: false,
    now: instantFromMs(nowMs),
    ...(config.max_paths === undefined ? {} : { maxPaths: config.max_paths }),
    ...(config.min_age_hours === undefined ? {} : { minAgeHours: config.min_age_hours }),
    ...(config.excluded_paths === undefined ? {} : { excludedPaths: config.excluded_paths }),
  };
}

/** The tick's `now()` as an aware instant (millisecond precision). */
function instantFromMs(ms: number): UtcInstant {
  return new UtcInstant(BigInt(Math.trunc(ms)) * 1000n);
}

/** `coverage.new_ledger()` as a plain record. */
function plainLedger(): Dict {
  return { schema_version: 1, paths: {}, runs: {}, observations: {} };
}

/** Map the three Python exceptions the caller catches onto {@link CoverageIdentityError}. */
function identity<T>(read: () => T): T {
  try {
    return read();
  } catch (error) {
    if (
      error instanceof PyError &&
      (error.pythonError === 'ValueError' ||
        error.pythonError === 'KeyError' ||
        error.pythonError === 'TypeError')
    ) {
      throw new CoverageIdentityError(error.message);
    }
    throw error;
  }
}

/** An unbound member throws when called, never succeeds. */
function unbound(name: string): never {
  const fail = () => {
    throw new Error(`${name} is not bound`);
  };
  return fail as never;
}

export function makeCoverageEffects(input: CoverageEffectsInput): Omit<CoverageEffects, 'launch'> {
  const { git, measure, injected } = input;
  const deps = input.synthetic;
  const synthetic = deps
    ? { buildSynthetic: (item: Item, sha: string) => buildSynthetic(deps, item, sha) }
    : {
        buildSynthetic:
          injected.buildSynthetic ??
          (() => {
            throw new Error('buildSynthetic is not bound');
          }),
      };
  const tick = input.tick ? bindTickSeams(input.tick) : undefined;
  const dispatch = input.dispatch ? bindBackfillDispatchConfigured(input.dispatch) : undefined;
  const nowMs = tick?.nowMs ?? injected.nowMs ?? unbound('nowMs');
  return {
    select: injected.select,
    nowMs,
    parseIsoMs: tick?.parseIsoMs ?? injected.parseIsoMs ?? unbound('parseIsoMs'),
    liveItems: tick?.liveItems ?? injected.liveItems ?? unbound('liveItems'),
    compareItems: tick?.compareItems ?? injected.compareItems ?? unbound('compareItems'),
    depsMet: tick?.depsMet ?? injected.depsMet ?? unbound('depsMet'),
    backfillDispatchConfigured:
      dispatch ?? injected.backfillDispatchConfigured ?? unbound('backfillDispatchConfigured'),
    ...synthetic,
    rank4Gate: bindRank4Gate(input.rank4),
    bindRun: bindBindRun,
    cancelBeforeVendor: bindCancelBeforeVendor,
    mergeQueueSha: () => git.git(['rev-parse', `${measure.defaultRef}^{commit}`]),
    diffNameOnly: (base, head) => git.git(['diff', '--name-only', base, head]),
    measureMerged: (item: Item, sha: string) => measureMerged(git, measure, item, sha),
    coverageCandidate: (q: Queue, mq: string): Item | null => {
      const ledger = pyTruthy(q.coverage) ? q.coverage : plainLedger();
      return coverageCandidate(q, ledger, candidateParams(input.coverageConfig, mq, nowMs()));
    },
    legacyOrigins: (q: Queue, item: Item) =>
      identity(() => {
        const found = legacyOrigins(q, item);
        return { source: found.source as { pr: unknown }, origins: found.origins };
      }),
    legacyRetryAllowed: (q, pr, origin, nowMs) =>
      identity(() => legacyRetryAllowed(q, pr, origin, instantFromMs(nowMs))),
  };
}
