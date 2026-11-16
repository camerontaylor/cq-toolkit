/**
 * Queue-ownership and preservation guards of the deploy controller's unit
 * transaction, over an injected observation seam.
 *
 * Ports `unit_issues_queue_work`, `preserved_surfaces`, `preserved_digests`,
 * `preservation_check`, `captured_state`, `read_queue`, `drain_check` and
 * `queue_drain_gate` from `apps/crq-python/ops/deploy-controller.py`. Inactive
 * and unimported: nothing here touches the host. The unit switch and recovery
 * call these before any unit mutation, so they sit on the live
 * `switch --unit --runtime` path.
 *
 * The watchdog is the declared non-issuing unit: its gate is not observed at
 * all and its preservation scope is empty.
 */
import { pythonJsonText } from '../../../policy/crq/pythonJson.js';
import { JsonObject, type JsonValue } from '../../../policy/crq/jsonValue.js';
import { RecordRefused } from './controllerRecords.js';

/** Python `Refused` (shares the record guard's class so one catch covers both). */
export { RecordRefused as Refused };

/** `QueueDrainRefused`: a fail-closed queue ownership refusal. */
export class QueueDrainRefused extends RecordRefused {
  constructor(
    message: string,
    readonly drain: DrainObservation,
  ) {
    super(message);
  }
}

/** `PRESERVED`, in Python dict insertion order. */
export const PRESERVED: readonly string[] = ['queue.json', 'heartbeat.json'];

/** `QUEUE_NON_ISSUING_UNITS`. */
export const QUEUE_NON_ISSUING_UNITS: ReadonlySet<string> = new Set(['crq-watchdog.service']);

const RUN_ID_RE = /^(?:[0-9a-f-]{8,64}|[A-Za-z0-9][A-Za-z0-9._+-]*-[0-9]{8}T[0-9]{6}Z)$/;

export interface BlockedItem {
  item: JsonValue;
  state: string;
  reason?: string;
  run?: string;
}

export interface DrainObservation {
  blocked: BlockedItem[];
  drained: boolean | null;
  applicable?: false;
}

/** The runner's own probe (`crq.run_liveness`); result is `alive|ambiguous|harvest`. */
export type Liveness = (
  runId: string,
  item: JsonObject,
  run: JsonObject,
  hasExit: boolean,
) => Promise<unknown> | unknown;

/** The observations a guard needs; every method may throw as Python would raise. */
export interface GuardEffects {
  /** `effects.git(...)` output. */
  git(...args: string[]): Promise<string> | string;
  /** sha256 of the config file; null when it cannot be read (OSError). */
  configSha256(): Promise<string | null> | string | null;
  /** sha256 of a preserved surface; null only when it does not exist, else throws. */
  preservedDigest(rel: string): Promise<string | null> | string | null;
  /** `effects.unit_digests()`. */
  unitDigests(): Promise<unknown> | unknown;
  /** `effects.read_json("queue.json")`; throws on a missing file or invalid JSON. */
  readQueueJson(): Promise<JsonValue> | JsonValue;
  /** `(runs / run_id / "exit.json").exists()`. */
  exitExists(runId: string): Promise<boolean> | boolean;
}

/** Python `str(exc)[:n]`, sliced by code point. */
function clip(error: unknown, n: number): string {
  const text = error instanceof Error ? error.message : String(error);
  return Array.from(text).slice(0, n).join('');
}

export function unitIssuesQueueWork(unit: string): boolean {
  return !QUEUE_NON_ISSUING_UNITS.has(unit);
}

/** `preserved_surfaces`: sorted for an issuing unit, empty otherwise. */
export function preservedSurfaces(unit: string): string[] {
  return unitIssuesQueueWork(unit) ? [...PRESERVED].sort() : [];
}

/** `preserved_digests`: `preserved/<name>` -> sha256 or null. */
export async function preservedDigests(
  effects: GuardEffects,
  surfaces?: readonly string[],
): Promise<Record<string, string | null>> {
  const digests: Record<string, string | null> = {};
  for (const rel of surfaces ?? PRESERVED) {
    digests[`preserved/${rel}`] = await effects.preservedDigest(rel);
  }
  return digests;
}

/** `captured_state`: prior identity plus preservation digests. */
export async function capturedState(
  effects: GuardEffects,
  unit?: string,
): Promise<Record<string, unknown>> {
  const state: Record<string, unknown> = {
    prior_head: await effects.git('rev-parse', 'HEAD'),
    prior_config_sha256: await effects.configSha256(),
  };
  Object.assign(
    state,
    await preservedDigests(effects, unit === undefined ? undefined : preservedSurfaces(unit)),
  );
  state['checkout_status'] = await effects.git('status', '--porcelain', '--untracked-files=all');
  state['units'] = await effects.unitDigests();
  return state;
}

/** `read_queue`: the JSON-object root, or a ValueError-equivalent. */
export async function readQueue(effects: GuardEffects): Promise<JsonObject> {
  const queue = await effects.readQueueJson();
  if (!(queue instanceof JsonObject)) {
    throw new Error(`queue.json root is ${pythonTypeName(queue)}, not a JSON object`);
  }
  if (queue.has('items') && !Array.isArray(queue.get('items'))) {
    throw new Error('queue.json items is not a JSON array');
  }
  return queue;
}

function pythonTypeName(value: JsonValue): string {
  if (value === null) return 'NoneType';
  if (typeof value === 'boolean') return 'bool';
  if (typeof value === 'string') return 'str';
  if (Array.isArray(value)) return 'list';
  if (value instanceof JsonObject) return 'dict';
  return value.kind === 'int' ? 'int' : 'float';
}

/** `drain_check`: observe queue-owned runs; never signals a process. */
export async function drainCheck(
  effects: GuardEffects,
  liveness: Liveness,
): Promise<DrainObservation> {
  let queue: JsonObject;
  try {
    queue = await readQueue(effects);
  } catch (error) {
    throw new RecordRefused(
      `queue unreadable, refusing to reason about drain: ${clip(error, 160)}`,
    );
  }
  const blocked: BlockedItem[] = [];
  const items = (queue.has('items') ? queue.get('items') : []) as JsonValue[];
  for (const item of items) {
    if (!(item instanceof JsonObject)) {
      blocked.push({ item: null, state: 'ambiguous', reason: 'malformed queue item' });
      continue;
    }
    const run = item.get('run') ?? null;
    if (run === null) continue; // unstarted, or the runner's consumed marker
    const id = item.get('id') ?? null;
    if (!(run instanceof JsonObject)) {
      blocked.push({ item: id, state: 'ambiguous', reason: 'malformed recorded run metadata' });
      continue;
    }
    const runId = run.get('run_id');
    if (typeof runId !== 'string' || runId.length > 255 || !RUN_ID_RE.test(runId)) {
      blocked.push({ item: id, state: 'ambiguous', reason: 'malformed run id' });
      continue;
    }
    const hasExit = await effects.exitExists(runId);
    let state: unknown;
    try {
      state = await liveness(runId, item, run, hasExit);
    } catch (error) {
      blocked.push({
        item: id,
        state: 'ambiguous',
        reason: `liveness probe failed: ${clip(error, 120)}`,
      });
      continue;
    }
    if (state === 'alive' || state === 'ambiguous') blocked.push({ item: id, state, run: runId });
  }
  return { blocked, drained: blocked.length === 0 };
}

/** `queue_drain_gate`: refuse a unit transaction while queue work is live. */
export async function queueDrainGate(
  effects: GuardEffects,
  unit: string,
  liveness: Liveness,
): Promise<DrainObservation> {
  if (!unitIssuesQueueWork(unit)) return { drained: null, blocked: [], applicable: false };
  const drain = await drainCheck(effects, liveness);
  if (!drain.drained) {
    throw new QueueDrainRefused(
      'queue-owned work is alive or ambiguous; refusing unit transaction before activation: ' +
        Array.from(
          pythonJsonText(drain.blocked, {
            sortKeys: true,
            asciiOnly: true,
            spacedSeparators: true,
          }),
        )
          .slice(0, 400)
          .join(''),
      drain,
    );
  }
  return drain;
}

/** `preservation_check`: byte-identical preserved surfaces across the helper. */
export async function preservationCheck(
  effects: GuardEffects,
  before: Record<string, unknown>,
  surfaces?: readonly string[],
): Promise<{ preserved: true; checked: string[] }> {
  const scope = surfaces ?? PRESERVED;
  const after = await preservedDigests(effects, scope);
  const diffs = scope.filter(
    (rel) => after[`preserved/${rel}`] !== (before[`preserved/${rel}`] ?? null),
  );
  if (diffs.length > 0) {
    throw new RecordRefused(
      `preserved surfaces changed during deployment: ${diffs.join(', ')}; fail stopped, owner recovery required`,
    );
  }
  return { preserved: true, checked: [...scope].sort() };
}
