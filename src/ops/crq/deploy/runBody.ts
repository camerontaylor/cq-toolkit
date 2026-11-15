/**
 * The deploy-runbook `_run` body and its `run` wrapper, over injected steps.
 *
 * Ports `Deploy._run` and `Deploy.run` from `apps/crq-python/ops/deploy-runbook.py`.
 * Every earlier piece (target resolution, hold, lock, drain, switch, health,
 * recovery) is a callback typed here, so this file imports no unmerged module
 * and is inactive: nothing imports it and no deployed behaviour changes.
 * The value it adds is the exact phase ordering, release of the lock on every
 * exit, and the routing of each failure to recovery.
 */
import { pythonJsonText } from '../../../policy/crq/pythonJson.js';
import { Refused, HealthFailed, Interrupted, RecoveryRequired } from './errors.js';
export { Refused, HealthFailed, Interrupted, RecoveryRequired };

const SHA_RE = /^[0-9a-f]{40}$/;
const TAG_RE = /^crq-runner\/[0-9]{8}-[0-9]+$/;
const SETTLED_STATES: readonly string[] = ['active', 'inactive', 'failed'];

/** `json.dumps(value, sort_keys=True)`. */
function sortedJson(value: Record<string, string>): string {
  return pythonJsonText(value, {
    asciiOnly: true,
    sortKeys: true,
    keyOrder: 'code-point',
    spacedSeparators: true,
  });
}

function require_(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Refused(message);
}

/** Python `str(exc)` for the exception shapes `_run` can raise. */
function strOf(exc: unknown): string {
  return exc instanceof Error ? exc.message : String(exc);
}

export interface RunHold {
  acquire(): Promise<void>;
  owns(): Promise<boolean>;
  release(): Promise<void>;
}

/** What recovery needs to read; the callbacks own the real values. */
export interface RunBodyState {
  priorSha: string | null;
  target: string | null;
  runDir: string | null;
  original: Record<string, string>;
  triggers: readonly string[];
  hold: RunHold | null;
  switchAttempted: boolean;
  switched: boolean;
  released: boolean;
  finalTriggers: Record<string, string> | null;
}

export function newRunBodyState(): RunBodyState {
  return {
    priorSha: null,
    target: null,
    runDir: null,
    original: {},
    triggers: [],
    hold: null,
    switchAttempted: false,
    switched: false,
    released: false,
    finalTriggers: null,
  };
}

export interface Health {
  readonly healthy?: unknown;
  readonly reason?: unknown;
}

export interface RunBodyArgs {
  /** `Path(args.root).is_dir()`, `args.overlay` is a file; both checked before the lock. */
  readonly rootIsDir: boolean;
  readonly overlayIsFile: boolean;
  /** `--tag`, `null` when absent. */
  readonly tag: string | null;
}

export interface RunBodySteps {
  readonly lock: { acquire(): Promise<void>; release(): Promise<void> };
  /** `git rev-parse HEAD` of the live checkout. */
  headSha(): Promise<string>;
  assertClean(): Promise<void>;
  resolveTarget(): Promise<string>;
  claimRunDir(): Promise<string>;
  phase(name: string, extra?: Record<string, unknown>): Promise<void>;
  narrate(message: string): void;
  /** Materialise and load the target's ops modules. */
  resolveModules(): Promise<void>;
  /** Load the overlay, run `root_check`, build the effects. */
  loadOverlay(): Promise<void>;
  /** Measure config, `cq_bin` and preserved digests; read the compatibility record. */
  measureBaseline(): Promise<{
    readonly compatible: boolean;
    readonly reason: string;
    readonly cqBin: unknown;
  }>;
  /** `units.inventory()` triggers. */
  inventoryTriggers(): Promise<readonly string[]>;
  unitState(unit: string): Promise<string>;
  requireUnchangedUnitTemplates(): Promise<void>;
  persistRecoveryReceipt(): Promise<void>;
  newHold(): RunHold;
  /** `stop_triggers` after the hold ownership check. */
  stopTriggers(): Promise<void>;
  drainServices(): Promise<void>;
  drainQueue(): Promise<void>;
  /** `recheck_baseline`, including its own `remeasured` phase. */
  recheckBaseline(): Promise<void>;
  /** `helper.switch(...)`. */
  switchCheckout(): Promise<void>;
  verifyAfterSwitch(): Promise<void>;
  /** `restart_triggers`; returns the verified final trigger states. */
  restartTriggers(): Promise<Record<string, string>>;
  checkHealth(): Promise<Health>;
  writeHealth(health: Health): Promise<void>;
  /** `complete()`: the completed record, `released` phase and narration. */
  complete(): Promise<void>;
  document(outcome: string, reason?: string): unknown;
  /** `recover(exc)`: returns the outcome (`rolled_back` on success). */
  recover(exc: unknown): Promise<string>;
}

/** Python `_run`: every phase in the order the host sees it. */
export async function runBody(
  args: RunBodyArgs,
  steps: RunBodySteps,
  state: RunBodyState,
): Promise<unknown> {
  require_(args.rootIsDir, '--root must name the deployment checkout');
  require_(args.overlayIsFile, '--overlay must name the private host overlay');
  await steps.lock.acquire();
  const prior = await steps.headSha();
  state.priorSha = prior;
  require_(SHA_RE.test(prior), `live HEAD is not a full commit SHA: ${pyRepr(prior)}`);
  await steps.assertClean();
  const target = await steps.resolveTarget();
  state.target = target;
  require_(target !== prior, `target ${target} is already the checked-out HEAD`);
  if (args.tag !== null) require_(TAG_RE.test(args.tag), '--tag must be crq-runner/YYYYMMDD-N');
  state.runDir = await steps.claimRunDir();
  await steps.phase('resolved');
  await steps.resolveModules();
  await steps.loadOverlay();
  const baseline = await steps.measureBaseline();
  require_(
    baseline.compatible,
    'the live queue disables automatic rollback, so this deploy would have no fallback: ' +
      baseline.reason +
      '. Drain or reconcile the queue with the owner first.',
  );
  const triggers = await steps.inventoryTriggers();
  state.triggers = triggers;
  require_(
    triggers.length > 0,
    'no installed crq-*.timer or crq-*.path units found; refusing to deploy against an empty inventory',
  );
  const original: Record<string, string> = {};
  for (const unit of triggers) original[unit] = await steps.unitState(unit);
  state.original = original;
  const unsettled: Record<string, string> = {};
  for (const [unit, st] of Object.entries(original))
    if (!SETTLED_STATES.includes(st)) unsettled[unit] = st;
  require_(
    Object.keys(unsettled).length === 0,
    `trigger state is unsettled; refusing to guess: ${sortedJson(unsettled)}`,
  );
  await steps.phase('prepared', { triggers: original, cq_bin: baseline.cqBin });
  await steps.requireUnchangedUnitTemplates();
  await steps.persistRecoveryReceipt();
  const hold = steps.newHold();
  state.hold = hold;
  await hold.acquire();
  await steps.phase('held');
  steps.narrate('hold acquired; stopping triggers');
  require_(await hold.owns(), 'hold lost before trigger stop');
  await steps.stopTriggers();
  await steps.phase('stopped', { triggers: original });
  await steps.drainServices();
  await steps.drainQueue();
  await steps.recheckBaseline();
  await steps.phase('drained');

  steps.narrate(`switching to ${target}`);
  state.switchAttempted = true;
  await steps.switchCheckout();
  state.switched = true;
  require_((await steps.headSha()) === target, 'helper returned but HEAD is not the target');
  await steps.phase('switched');
  await steps.verifyAfterSwitch();
  // Health cannot be observed while the marker holds the runner; release just
  // before the restart and let recovery re-acquire if health fails.
  require_(
    (await state.hold.owns()) === true,
    "cannot release admission: the marker is not this run's",
  );
  await state.hold.release();
  state.released = true;
  await steps.phase('admission_released');
  const finalTriggers = await steps.restartTriggers();
  state.finalTriggers = finalTriggers;
  await steps.phase('restarted', { triggers: finalTriggers });
  const health = await steps.checkHealth();
  await steps.writeHealth(health);
  if (!truthy(health.healthy)) {
    const reason = truthy(health.reason) ? strOf(health.reason) : 'not healthy';
    throw new HealthFailed(`health check failed: ${reason}`);
  }
  await steps.complete();
  return steps.document('completed');
}

/** Python `run`: route every failure to recovery, and always release the lock. */
export async function runWithRecovery(
  args: RunBodyArgs,
  steps: RunBodySteps,
  state: RunBodyState,
): Promise<unknown> {
  try {
    return await runBody(args, steps, state);
  } catch (exc) {
    if (exc instanceof HealthFailed) {
      await steps.recover(exc);
      return steps.document('rolled_back', clip(strOf(exc), 400));
    }
    if (exc instanceof Interrupted) {
      await steps.recover(new Refused('interrupted by the operator'));
      throw exc;
    }
    const outcome = await steps.recover(exc);
    if (outcome === 'rolled_back') return steps.document('rolled_back', clip(strOf(exc), 400));
    throw new Refused(strOf(exc), { cause: exc });
  } finally {
    await steps.lock.release();
  }
}

/** Python truthiness for the values a health record may carry. */
function truthy(value: unknown): boolean {
  if (value === undefined || value === null || value === false || value === 0 || value === '')
    return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value as object).length > 0;
  return true;
}

/** Python `str[:n]` by code points. */
function clip(text: string, n: number): string {
  return Array.from(text).slice(0, n).join('');
}

/** Python `repr` of a string. */
function pyRepr(text: string): string {
  const q = text.includes("'") && !text.includes('"') ? '"' : "'";
  const escaped = text
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    .split(q)
    .join('\\' + q);
  return q + escaped + q;
}
