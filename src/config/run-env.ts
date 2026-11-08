// The run's resolved CqEnv, carried to ops (config contract: resolve once).
//
// `runPlan` resolves (or receives) the validated snapshot and runs the plan
// inside this context, so an op below it reads the same snapshot instead of
// re-reading the ambient environment. Outside a run (direct library use) the
// fallback is one fresh `readCqEnv()`.
import { AsyncLocalStorage } from 'node:async_hooks';
import { readCqEnv, type CqEnv } from './env.js';

const store = new AsyncLocalStorage<CqEnv>();

/** Run `fn` with `cqEnv` as the run's snapshot. */
export function runWithCqEnv<T>(cqEnv: CqEnv, fn: () => T): T {
  return store.run(cqEnv, fn);
}

/** The enclosing run's snapshot, or a fresh read when called outside a run. */
export function currentCqEnv(): CqEnv {
  return store.getStore() ?? readCqEnv();
}
