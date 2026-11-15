/**
 * Sequencing of the discovery-side phases of `tick` (crq.py:3372-3396, the
 * reconcile window at ~3437 and the enroll / pr_enroll calls at ~3465).
 * Inactive: every forge read, queue save and sub-pass is injected; the caller
 * owns tick.lock. The deferred refresh and merged discovery share ONE
 * `ForgeBudget` (24 requests / 30 s); reconcile gets its own (80 / 60 s).
 * Queues are immutable here, so each sub-pass returns the queue to thread on.
 */
import { JsonObject } from '../policy/crq/jsonValue.js';
import { ForgeBudget, reconcileForgeBudget } from '../policy/crq/forgeBudget.js';
import { refreshDeferred, type DeferredRefreshEffects } from './deferredRefresh.js';

export interface DiscoveryPhaseEffects {
  nowIso(): string;
  /** Forge reads bound to this budget (Python's `forge_window(budget)`). */
  deferred(budget: ForgeBudget): Omit<DeferredRefreshEffects, 'mayContinue'>;
  saveQueue(queue: JsonObject): Promise<void>;
  /** Merged discovery under the same budget; owns its own saves. */
  merged(queue: JsonObject, budget: ForgeBudget): Promise<{ queue: JsonObject; log: string[] }>;
  /** `push_current.discover`; owns its own saves. */
  push(queue: JsonObject): Promise<{ queue: JsonObject; log: string[] }>;
}

/**
 * Only a live, unrestricted tick (`not dry and only is None`) discovers. Order:
 * deferred refresh (saved before discovery can spend the shared deadline),
 * merged discovery, push discovery. Any error abandons the tick.
 */
export async function runDiscoveryPhase(
  queue: JsonObject,
  options: { readonly dry: boolean; readonly only: string | null },
  effects: DiscoveryPhaseEffects,
): Promise<{ queue: JsonObject; log: string[] }> {
  if (options.dry || options.only !== null) return { queue, log: [] };
  const budget = new ForgeBudget();
  const log: string[] = [];
  const refreshed = await refreshDeferred(
    queue,
    effects.nowIso(),
    { ...effects.deferred(budget), mayContinue: () => budget.available() },
    20,
  );
  let current = refreshed.queue;
  if (refreshed.refreshed.length > 0) {
    // Binding/enrollment must survive a crash before reservation/dispatch.
    await effects.saveQueue(current);
    log.push(`refreshed ${String(refreshed.refreshed.length)} deferred author intent(s)`);
  }
  const merged = await effects.merged(current, budget);
  current = merged.queue;
  log.push(...merged.log);
  const push = await effects.push(current);
  return { queue: push.queue, log: [...log, ...push.log] };
}

export interface EnrollmentPhaseEffects {
  /** `enroll(q, dry)`: the primary repository's open PRs. */
  primary(queue: JsonObject, dry: boolean): Promise<{ queue: JsonObject; log: string[] }>;
  /** `pr_enroll.enroll`: configured non-primary repositories. */
  others(queue: JsonObject, dry: boolean): Promise<{ queue: JsonObject; log: string[] }>;
}

/** Primary enrollment strictly before the other repositories', logs concatenated. */
export async function runEnrollmentPhase(
  queue: JsonObject,
  dry: boolean,
  effects: EnrollmentPhaseEffects,
): Promise<{ queue: JsonObject; log: string[] }> {
  const primary = await effects.primary(queue, dry);
  const others = await effects.others(primary.queue, dry);
  return { queue: others.queue, log: [...primary.log, ...others.log] };
}

export interface ReconcilePhaseEffects {
  /** `repair_tick.reconcile_fix_prs`, reading through the supplied budget. */
  reconcile(queue: JsonObject, budget: ForgeBudget): Promise<unknown>;
  event(kind: 'reconcile_incomplete', data: Record<string, unknown>): Promise<void>;
}

function truthy(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object' && v !== null) return Object.keys(v).length > 0;
  return Boolean(v);
}
const orZero = (v: unknown): unknown => (v === undefined ? 0 : v);

/**
 * Reconcile with its own 80 request / 60 s allowance. Anything but a counts
 * object reports nothing (and must not break the tick). A pass that examined
 * work is always logged; starved or deferred work also records an event.
 */
export async function runReconcilePhase(
  queue: JsonObject,
  effects: ReconcilePhaseEffects,
  clock?: () => number,
): Promise<string[]> {
  const result = await effects.reconcile(queue, reconcileForgeBudget(clock));
  const counts: Record<string, unknown> =
    typeof result === 'object' && result !== null && !Array.isArray(result)
      ? (result as Record<string, unknown>)
      : {};
  const log: string[] = [];
  if (truthy(counts.examined)) {
    log.push(
      `reconcile: ${String(orZero(counts.examined))} examined, ${String(orZero(counts.projected))} projected, ` +
        `${String(orZero(counts.starved))} starved, ${String(orZero(counts.deferred))} deferred`,
    );
  }
  if (truthy(counts.starved) || truthy(counts.deferred)) {
    await effects.event('reconcile_incomplete', {
      examined: orZero(counts.examined),
      projected: orZero(counts.projected),
      starved: orZero(counts.starved),
      deferred: orZero(counts.deferred),
      errors: truthy(counts.errors) ? counts.errors : [],
    });
  }
  return log;
}
