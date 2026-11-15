/**
 * Binds `runBody` to the ported deploy modules: the Python `Run` object.
 *
 * `runBody` (ordering) and `RunRecovery` (terminal states) each take callbacks and
 * their own copy of the run state. This module is the glue: it builds the one
 * `RunState`, supplies every `RunBodySteps` callback from the module functions
 * (target resolution, guards, run records, hold, drain, switch, post-switch, health),
 * and makes the failure classes the modules throw mean the same thing to recovery.
 * Every effect is injected; nothing here is imported by deployed code.
 *
 * Two bridging rules matter:
 * - Each module declares its own `Refused`/`FailStop`/... copy, so `instanceof` across
 *   modules is false. {@link canonical} re-wraps by class name before recovery decides
 *   between fail-stop and rollback; without it a drain `FailStop` would be rolled back.
 * - A few module effects are synchronous (`complete`, `recheckBaseline`'s phase). Their
 *   calls are recorded and replayed in order with awaits, which preserves Python's order
 *   and its "stop at the first failing write" behaviour.
 */
import {
  claimRunDir,
  complete,
  persistRecoveryReceipt,
  type ClaimRunDirEffects,
  type RecoveryReceiptEffects,
} from './runRecords.js';
import { assertClean, requireUnchangedUnitTemplates, type GitGuardEffects } from './gitGuards.js';
import { resolveTarget, type ResolveTargetEffects } from './resolveTarget.js';
import { resolveModules, type ResolveModulesEffects } from './resolveModules.js';
import {
  compatibilityReason,
  measureCqBin,
  readConfig,
  recheckBaseline,
  runtimePointerCheck,
  verifyAfterSwitch,
  type CqBinRecord,
  type LiveConfigEffects,
  type PostSwitchController,
} from './postSwitch.js';
import { drainServices, restartTriggers, stopTriggers } from './deployUnitSteps.js';
import {
  checkHealth,
  drainQueue,
  type DrainController,
  type HealthController,
} from './deployHealth.js';
import { switchCheckout, type SwitchEffects } from './deployOps.js';
import {
  FailStop,
  HealthFailed,
  Interrupted,
  OSError,
  RecoveryRequired,
  Refused,
  RunRecovery,
  type HoldLike,
  type Result,
  type RollbackController,
  type RunState,
} from './rollbackRecover.js';
import {
  runBody,
  type Health,
  type RunBodyArgs,
  type RunBodyState,
  type RunBodySteps,
} from './runBody.js';
import type { JsonObject } from '../../../policy/crq/jsonValue.js';

/** The deploy-controller module, with every call that takes the controller effects. */
export type BoundController<E> = RollbackController<E> & DrainController<E> & HealthController<E>;

/** `RealUnits`: the user-manager seam, including the inventory Python reads once. */
export interface RunUnits {
  inventory(): Promise<{ readonly triggers: string[]; readonly services: string[] }>;
  stop(units: string[]): Promise<void>;
  start(units: string[]): Promise<void>;
  state(unit: string): Promise<string>;
}

export interface RunConfig {
  /** `Path(args.root).resolve()`. */
  readonly root: string;
  readonly rootIsDir: boolean;
  readonly overlayIsFile: boolean;
  readonly tag: string | null;
  readonly targetSha: string | null;
  readonly noFetch: boolean;
  readonly recordDir: string;
  readonly json: boolean;
  readonly serviceDrainDeadlineS: number;
  readonly drainDeadlineS: number;
  readonly drainIntervalS: number;
  readonly healthTimeoutS: number;
  readonly healthIntervalS: number;
}

export interface LoadedOverlay<E> {
  readonly overlay: JsonObject;
  /** `controller.Effects(root, run_dir)`, built after `root_check`. */
  readonly effects: E;
}

export interface RunDeps<E, H, C extends BoundController<E>> {
  readonly config: RunConfig;
  readonly lock: { acquire(): Promise<void>; release(): Promise<void> };
  newHold(): HoldLike;
  headSha(): Promise<string>;
  guard: GitGuardEffects;
  targetEffects: ResolveTargetEffects;
  claim: ClaimRunDirEffects;
  receipt: RecoveryReceiptEffects;
  modules: ResolveModulesEffects<H, C>;
  /** `helper.load_overlay` then `helper.root_check`, then the controller effects. */
  loadOverlay(helper: H, controller: C, runDir: string): Promise<LoadedOverlay<E>>;
  live: LiveConfigEffects;
  units: RunUnits;
  switchEffects: SwitchEffects;
  /** An injected single-observation drain (`drain_fn`); omit for the real poll. */
  drainFn?: () => Promise<Result>;
  /** An injected health result (`health_fn`); omit for the real observation. */
  healthFn?: () => Promise<Result>;
  /** An injected helper/controller (tests); `resolveModules` loads whichever is absent. */
  helper?: H;
  controller?: C;
  durableWrite(path: string, value: Result): Promise<void>;
  nowIso(): string;
  clock(): number;
  sleep(seconds: number): Promise<void>;
  narrate(message: string): void;
}

const CLASSES: Record<string, new (message: string, options?: ErrorOptions) => Error> = {
  Refused,
  FailStop,
  HealthFailed,
  OSError,
  Interrupted,
};

/**
 * Re-wrap a module's copy of a deploy error class as the class recovery and
 * `RunRecovery.run` test with `instanceof`. Unknown errors pass through unchanged.
 */
export function canonical(exc: unknown): unknown {
  if (!(exc instanceof Error) || exc instanceof RecoveryRequired) return exc;
  const err: Error = exc;
  const Wanted = CLASSES[err.name];
  const asUnknown: unknown = err;
  if (Wanted === undefined || asUnknown instanceof Wanted) return err;
  return new Wanted(err.message, { cause: err });
}

async function canon<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (exc) {
    throw canonical(exc);
  }
}

export function newRunState(tag: string | null): RunState {
  return {
    tag,
    runDir: null,
    target: null,
    priorSha: null,
    original: null,
    originalConfig: null,
    cqBin: null,
    preserved: null,
    triggers: null,
    hold: null,
    switchAttempted: false,
    switched: false,
    released: false,
    finalTriggers: null,
    rollback: null,
    postCompatibility: null,
    moduleDigests: null,
  };
}

/**
 * `runBody` reads a state whose maps are non-null; recovery reads Python's `None`.
 * One object serves both: this view writes through to the single `RunState`.
 */
function bodyView(state: RunState): RunBodyState {
  return {
    get priorSha() {
      return state.priorSha;
    },
    set priorSha(v) {
      state.priorSha = v;
    },
    get target() {
      return state.target;
    },
    set target(v) {
      state.target = v;
    },
    get runDir() {
      return state.runDir;
    },
    set runDir(v) {
      state.runDir = v;
    },
    get original() {
      return state.original ?? {};
    },
    set original(v) {
      state.original = v;
    },
    get triggers() {
      return state.triggers ?? [];
    },
    set triggers(v) {
      state.triggers = [...v];
    },
    get hold() {
      return state.hold;
    },
    set hold(v) {
      state.hold = v as HoldLike | null;
    },
    get switchAttempted() {
      return state.switchAttempted;
    },
    set switchAttempted(v) {
      state.switchAttempted = v;
    },
    get switched() {
      return state.switched;
    },
    set switched(v) {
      state.switched = v;
    },
    get released() {
      return state.released;
    },
    set released(v) {
      state.released = v;
    },
    get finalTriggers() {
      return state.finalTriggers;
    },
    set finalTriggers(v) {
      state.finalTriggers = v;
    },
  };
}

function need<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new TypeError(`run state: ${what} is not set`);
  return value;
}

export interface BoundRun {
  readonly state: RunState;
  /** `Run.run`: the forward path, routed to recovery, releasing the lock on every exit. */
  run(): Promise<unknown>;
}

/** Build the run: one state, one recovery, one set of steps over the injected modules. */
export function bindRun<E, H, C extends BoundController<E>>(deps: RunDeps<E, H, C>): BoundRun {
  const cfg = deps.config;
  const state = newRunState(cfg.tag);
  let helper: H | null = deps.helper ?? null;
  let controller: C | null = deps.controller ?? null;
  let loaded: LoadedOverlay<E> | null = null;
  let services: readonly string[] = [];
  let cqBin: CqBinRecord | null = null;

  const narrate = (message: string): void => {
    if (!cfg.json) deps.narrate(message);
  };
  const runPath = (name: string): string => `${need(state.runDir, 'runDir')}/${name}`;
  const effects = (): E => need(loaded, 'effects').effects;
  const ctrl = (): C => need(controller, 'controller');
  const post = (): PostSwitchController => ({
    preservedDigests: async () =>
      (await ctrl().preservedDigests(effects())) as Record<string, string | null>,
    compatibilityRecord: (sha) => ctrl().compatibilityRecord(effects(), sha),
    rollbackCompatible: (record) => ctrl().rollbackCompatible(record as Result),
  });

  const recovery = new RunRecovery<E>(state, {
    // Late-bound: recovery can start before the modules and effects exist.
    get controller() {
      return ctrl();
    },
    get effects() {
      return effects();
    },
    units: deps.units,
    newHold: () => deps.newHold(),
    switchCheckout: (sha) =>
      canon(async () => {
        await switchCheckout(deps.switchEffects, cfg.root, need(loaded, 'overlay').overlay, sha);
      }),
    headSha: () => deps.headSha(),
    readConfig: () => canon(() => readConfig(deps.live, cfg.root)),
    runtimePointerCheck: () =>
      canon(() => runtimePointerCheck(deps.live, cfg.root, need(cqBin, 'cqBin'))),
    drainServices: () => canon(() => steps.drainServices()),
    drainQueue: (name) => canon(() => steps.drainQueueAs(name)),
    durableWrite: (name, value) => deps.durableWrite(runPath(name), value),
    now: () => deps.nowIso(),
    narrate,
    releaseLock: () => deps.lock.release(),
    innerRun: () => canon(async () => (await runBody(args, steps, bodyView(state))) as Result),
  });

  const args: RunBodyArgs = {
    rootIsDir: cfg.rootIsDir,
    overlayIsFile: cfg.overlayIsFile,
    tag: cfg.tag,
  };

  const steps: RunBodySteps & { drainQueueAs(name: string): Promise<void> } = {
    lock: deps.lock,
    headSha: () => deps.headSha(),
    assertClean: () => assertClean(deps.guard),
    resolveTarget: () => resolveTarget(cfg.targetSha, !cfg.noFetch, deps.targetEffects),
    claimRunDir: async () => claimRunDir(deps.claim, cfg.recordDir, cfg.root),
    phase: (name, extra) => recovery.phase(name, extra ?? {}),
    narrate,
    resolveModules: async () => {
      const r = await resolveModules<H, C>(
        deps.modules,
        need(state.target, 'target'),
        runPath('candidate-ops'),
        { helper, controller },
      );
      state.moduleDigests = r.digests;
      helper = r.helper;
      controller = r.controller;
    },
    loadOverlay: async () => {
      loaded = await deps.loadOverlay(need(helper, 'helper'), ctrl(), runPath(''));
    },
    measureBaseline: async () => {
      state.originalConfig = await readConfig(deps.live, cfg.root);
      cqBin = await measureCqBin(deps.live, state.originalConfig);
      state.cqBin = cqBin;
      state.preserved = await ctrl().preservedDigests(effects());
      const record = await ctrl().compatibilityRecord(effects(), need(state.target, 'target'));
      const compatible = ctrl().rollbackCompatible(record);
      return { compatible, reason: compatible ? '' : compatibilityReason(record), cqBin };
    },
    inventoryTriggers: async () => {
      const inv = await deps.units.inventory();
      services = inv.services;
      return inv.triggers;
    },
    unitState: (unit) => deps.units.state(unit),
    requireUnchangedUnitTemplates: () =>
      requireUnchangedUnitTemplates(
        deps.guard,
        need(state.priorSha, 'priorSha'),
        need(state.target, 'target'),
      ),
    persistRecoveryReceipt: async () =>
      persistRecoveryReceipt(deps.receipt, {
        runDir: need(state.runDir, 'runDir'),
        target: need(state.target, 'target'),
        priorSha: need(state.priorSha, 'priorSha'),
        originalTriggers: need(state.original, 'original'),
        cqBin: state.cqBin,
        originalConfig: need(state.originalConfig, 'originalConfig'),
        preserved: state.preserved,
      }),
    newHold: () => deps.newHold(),
    // `runBody` has just asked the hold; Python asks once, so this does not ask again.
    stopTriggers: () =>
      stopTriggers({
        holdOwns: async () => true,
        units: deps.units,
        triggers: need(state.triggers, 'triggers'),
      }),
    drainServices: () =>
      drainServices({
        units: deps.units,
        services,
        deadlineS: cfg.serviceDrainDeadlineS,
        clock: deps.clock,
        sleep: deps.sleep,
      }),
    drainQueue: () => steps.drainQueueAs('drain.json'),
    drainQueueAs: (name) =>
      drainQueue(
        {
          controller: ctrl(),
          effects: effects(),
          writeRecord: (file, value) => deps.durableWrite(runPath(file), value),
          ...(deps.drainFn === undefined ? {} : { drainFn: deps.drainFn }),
          clock: deps.clock,
          sleep: deps.sleep,
          drainDeadlineS: cfg.drainDeadlineS,
          drainIntervalS: cfg.drainIntervalS,
        },
        name,
      ),
    recheckBaseline: async () => {
      // The module's `phase` is its last act, so recording it and writing afterwards
      // keeps Python's order exactly.
      let pending: [string, Record<string, unknown>] | null = null;
      const preserved = await recheckBaseline({
        effects: deps.live,
        controller: post(),
        root: cfg.root,
        originalConfig: need(state.originalConfig, 'originalConfig'),
        cqBin: need(cqBin, 'cqBin'),
        target: need(state.target, 'target'),
        phase: (name, extra) => {
          pending = [name, extra];
        },
      });
      state.preserved = preserved;
      const [name, extra] = need(pending as [string, Record<string, unknown>] | null, 'phase');
      await recovery.phase(name, extra);
    },
    switchCheckout: async () => {
      await switchCheckout(
        deps.switchEffects,
        cfg.root,
        need(loaded, 'overlay').overlay,
        need(state.target, 'target'),
        cfg.tag,
      );
    },
    verifyAfterSwitch: async () => {
      const r = await verifyAfterSwitch({
        effects: deps.live,
        controller: post(),
        root: cfg.root,
        cqBin: need(cqBin, 'cqBin'),
        preserved: need(state.preserved, 'preserved') as Record<string, string | null>,
        priorSha: need(state.priorSha, 'priorSha'),
      });
      state.postCompatibility = r.postCompatibility as Result;
    },
    restartTriggers: async () =>
      restartTriggers({
        units: deps.units,
        triggers: need(state.triggers, 'triggers'),
        original: need(state.original, 'original'),
      }),
    checkHealth: async (): Promise<Health> =>
      checkHealth({
        controller: ctrl(),
        effects: effects(),
        ...(deps.healthFn === undefined ? {} : { healthFn: deps.healthFn }),
        units: deps.units,
        triggers: need(state.triggers, 'triggers'),
        original: need(state.original, 'original'),
        clock: deps.clock,
        sleep: deps.sleep,
        healthTimeoutS: cfg.healthTimeoutS,
        healthIntervalS: cfg.healthIntervalS,
      }),
    writeHealth: (health) => deps.durableWrite(runPath('health.json'), health as Result),
    complete: async () => {
      const ops: Array<() => Promise<unknown>> = [];
      complete(
        {
          setRollback: (r) => ops.push(async () => (state.rollback = r)),
          writeRecord: (outcome, extra) => ops.push(() => recovery.writeRecord(outcome, extra)),
          phase: (name, extra) => ops.push(() => recovery.phase(name, extra)),
          narrate: (message) => ops.push(async () => narrate(message)),
        },
        {
          priorSha: need(state.priorSha, 'priorSha'),
          target: need(state.target, 'target'),
          cqBin: state.cqBin,
          finalTriggers: need(state.finalTriggers, 'finalTriggers'),
        },
      );
      for (const op of ops) await op();
    },
    document: (outcome, reason) =>
      recovery.document(outcome, reason === undefined ? {} : { reason }),
    recover: (exc) => recovery.recover(exc),
  };

  return { state, run: () => recovery.run() };
}
