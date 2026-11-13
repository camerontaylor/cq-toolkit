// The run's resolved environment, carried to ops (config contract: resolve once).
//
// `runPlan` resolves (or receives) the validated CQ_* snapshot and runs the plan
// inside this context, so an op below it reads the same snapshot instead of
// re-reading the ambient environment. The SAME context carries the entry's
// environment record (every name, `CQ_*` and foreign): a reader that needs a
// foreign name (PATH, XDG_STATE_HOME, GH_REPOSITORY, a provider base URL) reads
// the run's frozen copy through `currentEntryEnv()`, so an ambient change after
// entry cannot move a mid-run read. Outside a run (direct library use) both
// fallbacks are one fresh read — the documented last resort.
import { AsyncLocalStorage } from 'node:async_hooks';
import { readCqEnv, type CqEnv } from './env.js';

/** The environment record a reader sees: one entry-time (or fresh) snapshot. */
export type EntryEnv = Readonly<Record<string, string | undefined>>;

interface RunEnvironment {
  readonly cqEnv: CqEnv;
  readonly env: EntryEnv;
}

const store = new AsyncLocalStorage<RunEnvironment>();

/**
 * Run `fn` with `cqEnv` as the run's snapshot and `env` as its environment
 * record. The record is copied and frozen, so an in-place `process.env`
 * mutation after entry cannot move a read inside the run. A nested run that
 * omits `env` inherits the enclosing run's record.
 */
export function runWithCqEnv<T>(cqEnv: CqEnv, fn: () => T, env: EntryEnv = currentEntryEnv()): T {
  return store.run({ cqEnv, env: Object.freeze({ ...env }) }, fn);
}

/** The enclosing run's snapshot, or a fresh read when called outside a run. */
export function currentCqEnv(): CqEnv {
  return store.getStore()?.cqEnv ?? readCqEnv();
}

/**
 * The enclosing run's environment record (frozen at run entry), or the live
 * process environment when called outside a run. This is the ONE sanctioned
 * ambient read below an entry point: entry helpers capture the record once and
 * `runWithCqEnv` pins it for the whole run.
 */
export function currentEntryEnv(): EntryEnv {
  return store.getStore()?.env ?? process.env;
}
