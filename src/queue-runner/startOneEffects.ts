/**
 * The `StartOneEffects` implementer: binds the per-kind planner dispatch
 * ({@link planItem}), the admission launch ({@link launch}) and
 * `coverage_fallback` to `startOne`, and bridges the admit loop's immutable
 * `JsonObject` queue to the plain mutable records `startOne` edits in place.
 * Inactive: nothing binds it to a tick, slot or unit; `crq.ts` and the live
 * unit table are untouched.
 *
 * Steps the TS port cannot perform yet stay injected through the bundle and
 * must be left unbound (throwing) by the composer; they are never stubbed to
 * success, because a live tick with a missing step could lose queue state.
 */
import type { AdmitEnv } from '../adapters/crq/admitWiring.js';
import { JsonObject, toPlainJson } from '../policy/crq/jsonValue.js';
import { fromPlainJson } from '../policy/crq/queueDoc.js';
import type { ScheduleContext } from '../policy/crq/tickSchedule.js';
import { coverageFallback, type CoverageEffects, type Queue } from './coverageUsage.js';
import { launch, type LaunchEffects, type LaunchPlan } from './launch.js';
import { planItem, type PlanItemDeps } from './planItem.js';
import { startOne, type StartOneEffects, type StartPlan, type StartRecord } from './startOne.js';

/** Everything one `start_one` call needs from the world, bound to the live plain queue. */
export interface StartOneBundle {
  readonly context: ScheduleContext;
  readonly plan: Omit<PlanItemDeps, 'queue' | 'dry' | 'ignoreQuiet'>;
  readonly launch: LaunchEffects;
  /** Its own `launch` is replaced by the launch above. */
  readonly coverage: Omit<CoverageEffects, 'launch'>;
  event(kind: 'skipped', data: Record<string, string>): Promise<void>;
  nowIso(): string;
}

export interface StartOneRun {
  readonly dry: boolean;
  readonly only: string | null;
  readonly ignoreQuiet: boolean;
  /** The operator lines `start_one` appends; shared with `coverage_fallback`. */
  readonly log: string[];
}

export function makeStartOneEffects(
  queue: StartRecord,
  run: StartOneRun,
  bundle: StartOneBundle,
): StartOneEffects {
  const runLaunch = (item: StartRecord, plan: StartPlan): Promise<string> =>
    launch(queue, item, plan as LaunchPlan, bundle.launch);
  const coverage: CoverageEffects = {
    ...bundle.coverage,
    launch: (q, item, plan) => launch(q, item, plan as unknown as LaunchPlan, bundle.launch),
  };
  return {
    context: bundle.context,
    startsCount: () => (Array.isArray(queue.starts) ? queue.starts.length : 0),
    planItem: (item) =>
      planItem(item, {
        ...bundle.plan,
        queue: queue as Queue,
        dry: run.dry,
        ignoreQuiet: run.ignoreQuiet,
      }),
    launch: runLaunch,
    coverageFallback: async (options) => {
      const result = await coverageFallback(
        queue as Queue,
        run.log,
        run.dry,
        run.only,
        options.ordinaryEligible,
        coverage,
      );
      return { started: result.started, hasCoverage: result.available };
    },
    event: (kind, data) => bundle.event(kind, data),
    nowIso: () => bundle.nowIso(),
  };
}

/**
 * `AdmitEnv.startOne`: run one selection over a plain copy of the queue and
 * hand back the edited queue. Integers beyond the safe range stay bigints so
 * untouched extension fields survive the round trip. The int/float distinction of the JSON number
 * model survives only where `fromPlainJson` can see it: a float with an
 * integral value (`1.0`) returns as an int.
 */
export function bindStartOne(env: {
  bundle(queue: StartRecord): StartOneBundle;
}): AdmitEnv['startOne'] {
  return async (queue, context) => {
    const plain = toPlainJson(queue, { bigints: true }) as StartRecord;
    const log: string[] = [];
    const run: StartOneRun = {
      dry: context.dry,
      only: context.only,
      ignoreQuiet: context.ignoreQuiet,
      log,
    };
    const effects = makeStartOneEffects(plain, run, env.bundle(plain));
    const result = await startOne(
      { queue: plain, log, dry: context.dry, only: context.only ?? undefined },
      effects,
    );
    return {
      queue: fromPlainJson(plain) as JsonObject,
      log,
      hasCoverage: result.hasCoverage,
    };
  };
}
