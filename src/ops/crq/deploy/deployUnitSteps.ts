/** The unit-state steps of `Run` in `apps/crq-python/ops/deploy-runbook.py`:
 * `stop_triggers`, `drain_services`, `restart_triggers`. Units, clock, sleep and the hold
 * check are injected; nothing here runs systemctl, and nothing imports this module yet.
 */
import { pythonJsonText, compareCodePoints } from '../../../policy/crq/pythonJson.js';
import { Refused, FailStop, DEAD_STATES } from './errors.js';
export { Refused, FailStop, DEAD_STATES };

export interface UnitControl {
  stop(units: readonly string[]): Promise<void>;
  start(units: readonly string[]): Promise<void>;
  state(unit: string): Promise<string>;
}
export type UnitStates = Readonly<Record<string, string>>;

/** Python `json.dumps(obj, sort_keys=True)`. */
export function dumpSorted(value: unknown): string {
  return pythonJsonText(value, {
    asciiOnly: true,
    sortKeys: true,
    keyOrder: 'code-point',
    spacedSeparators: true,
  });
}

async function observe(units: UnitControl, names: readonly string[]): Promise<UnitStates> {
  const out: [string, string][] = [];
  for (const unit of names) out.push([unit, await units.state(unit)]);
  return Object.fromEntries(out);
}
const sameStates = (a: UnitStates, b: UnitStates): boolean => {
  const ka = Object.keys(a);
  return (
    ka.length === Object.keys(b).length && ka.every((k) => Object.hasOwn(b, k) && a[k] === b[k])
  );
};

export async function stopTriggers(deps: {
  holdOwns(): Promise<boolean>;
  units: UnitControl;
  triggers: readonly string[];
}): Promise<void> {
  if (!(await deps.holdOwns())) throw new Refused('hold lost before trigger stop');
  await deps.units.stop([...deps.triggers].sort(compareCodePoints));
  const observed = await observe(deps.units, deps.triggers);
  if (!Object.values(observed).every((s) => DEAD_STATES.includes(s)))
    throw new Refused(`trigger stop did not settle: ${dumpSorted(observed)}`);
}

export async function drainServices(deps: {
  units: UnitControl;
  services: readonly string[];
  deadlineS: number;
  clock(): number;
  sleep(seconds: number): Promise<void>;
}): Promise<void> {
  const deadline = deps.clock() + deps.deadlineS;
  for (;;) {
    const observed = await observe(deps.units, deps.services);
    if (Object.values(observed).every((s) => DEAD_STATES.includes(s))) return;
    if (deps.clock() >= deadline)
      throw new FailStop(
        `service drain expired after ${String(deps.deadlineS)}s; hold retained, nothing killed: ${dumpSorted(observed)}`,
      );
    await deps.sleep(5);
  }
}

/** Starts the originally-active triggers and verifies twice; returns the verified map. */
export async function restartTriggers(deps: {
  units: UnitControl;
  triggers: readonly string[];
  original: UnitStates;
}): Promise<UnitStates> {
  const active = Object.keys(deps.original)
    .filter((u) => deps.original[u] === 'active')
    .sort(compareCodePoints);
  await deps.units.start(active);
  const observed = await observe(deps.units, deps.triggers);
  if (!sameStates(observed, deps.original))
    throw new Refused(
      `trigger restart mismatch: observed ${dumpSorted(observed)} expected ${dumpSorted(deps.original)}`,
    );
  const verified = await observe(deps.units, deps.triggers);
  if (!sameStates(verified, deps.original))
    throw new Refused(`trigger restart verification mismatch: second read ${dumpSorted(verified)}`);
  return verified;
}
