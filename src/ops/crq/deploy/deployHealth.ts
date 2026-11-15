/** `Run.drain_queue` and `Run.check_health` from `apps/crq-python/ops/deploy-runbook.py`.
 * The controller (`deploy-controller.py`), clock, sleep, durable record writer and unit
 * reader are injected; nothing here reads the queue or runs systemctl, and nothing
 * imports this module yet.
 */
import { pythonJsonText } from '../../../policy/crq/pythonJson.js';

export class Refused extends Error {
  override readonly name: string = 'Refused';
}
/** A refusal that must keep the hold: recovery is an owner operation. */
export class FailStop extends Refused {
  override readonly name = 'FailStop';
}

/** A controller result: a plain record (Python dict). */
export type Result = Record<string, unknown>;

const dump = (value: unknown): string =>
  pythonJsonText(value ?? null, {
    asciiOnly: true,
    sortKeys: true,
    keyOrder: 'code-point',
    spacedSeparators: true,
  });
/** Python truthiness for JSON-shaped values. */
function truthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === 0 || v === '') return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  return true;
}
function field(result: Result, key: string): unknown {
  if (!Object.hasOwn(result, key)) throw new Error(`KeyError: '${key}'`);
  return result[key];
}

export interface DrainController<E> {
  runnerLiveness(effects: E): Promise<unknown>;
  drainCheck(effects: E, liveness: unknown): Promise<Result>;
}
export interface DrainDeps<E> {
  controller: DrainController<E>;
  effects: E;
  /** `durable_write(run_dir/<name>, value)`. */
  writeRecord(name: string, value: Result): Promise<void>;
  /** Injected single-observation drain (Python `drain_fn`); replaces the controller poll. */
  drainFn?: () => Promise<Result>;
  clock(): number;
  sleep(seconds: number): Promise<void>;
  drainDeadlineS: number;
  drainIntervalS: number;
}

export async function drainQueue<E>(deps: DrainDeps<E>, recordName = 'drain.json'): Promise<void> {
  if (deps.drainFn !== undefined) {
    const result = await deps.drainFn();
    await deps.writeRecord(recordName, {
      polls: [result],
      drained: truthy(result['drained']),
      deadline_s: null,
    });
    if (!truthy(result['drained']))
      throw new FailStop(
        `queue drain expired; hold retained, nothing killed: ${dump(result['blocked'])}`,
      );
    return;
  }
  const liveness = await deps.controller.runnerLiveness(deps.effects);
  const polls: Result[] = [];
  const deadline = deps.clock() + deps.drainDeadlineS;
  for (;;) {
    const result = await deps.controller.drainCheck(deps.effects, liveness);
    polls.push(result);
    if (truthy(field(result, 'drained'))) break;
    if (deps.clock() >= deadline) {
      await deps.writeRecord(recordName, {
        polls,
        drained: false,
        deadline_s: deps.drainDeadlineS,
      });
      throw new FailStop(
        `queue drain expired after ${String(deps.drainDeadlineS)}s; hold retained, nothing killed: ${dump(result['blocked'])}`,
      );
    }
    await deps.sleep(deps.drainIntervalS);
  }
  const last = polls.at(-1)!;
  await deps.writeRecord(recordName, {
    polls,
    drained: truthy(last['drained']),
    deadline_s: deps.drainDeadlineS,
  });
  if (!truthy(last['drained']))
    throw new Refused(`queue drain reported live or ambiguous work: ${dump(last['blocked'])}`);
}

export interface HealthController<E> {
  waitForFirstTick(
    effects: E,
    priorTick: unknown,
    timeoutS: number,
    clocks: { sleep(seconds: number): Promise<void>; clock(): number },
  ): Promise<unknown>;
  healthObservation(effects: E, priorTick: unknown): Promise<unknown>;
  twoSlotHealth(effects: E, observe: (priorTick: unknown) => Promise<unknown>): Promise<Result>;
}
export interface HealthDeps<E> {
  controller: HealthController<E>;
  effects: E;
  /** Injected health result (Python `health_fn`); returned untouched. */
  healthFn?: () => Promise<Result>;
  units: { state(unit: string): Promise<string> };
  triggers: readonly string[];
  /** Trigger states recorded at the start of the run. */
  original: Readonly<Record<string, string>>;
  clock(): number;
  sleep(seconds: number): Promise<void>;
  healthTimeoutS: number;
  healthIntervalS: number;
}

export async function checkHealth<E>(deps: HealthDeps<E>): Promise<Result> {
  if (deps.healthFn !== undefined) return deps.healthFn();
  let first = true;
  const observe = async (priorTick: unknown): Promise<unknown> => {
    if (first) {
      first = false;
      return deps.controller.waitForFirstTick(deps.effects, priorTick, deps.healthTimeoutS, {
        sleep: deps.sleep,
        clock: deps.clock,
      });
    }
    if (truthy(deps.healthIntervalS)) await deps.sleep(deps.healthIntervalS);
    return deps.controller.healthObservation(deps.effects, priorTick);
  };
  const result = { ...(await deps.controller.twoSlotHealth(deps.effects, observe)) };
  const entries: [string, string][] = [];
  for (const unit of deps.triggers) entries.push([unit, await deps.units.state(unit)]);
  const states = Object.fromEntries(entries);
  const stopped = Object.fromEntries(
    entries.filter(([unit, state]) => deps.original[unit] === 'active' && state !== 'active'),
  );
  result['unit_states'] = states;
  if (Object.keys(stopped).length > 0) {
    result['healthy'] = false;
    result['reason'] = `restarted trigger(s) not active: ${dump(stopped)}`;
  }
  return result;
}
