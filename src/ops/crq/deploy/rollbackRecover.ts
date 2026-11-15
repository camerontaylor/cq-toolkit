/** Rollback and recovery from `apps/crq-python/ops/deploy-runbook.py`: `compatibility_reason`,
 * `Run.fail_stop`, `Run.restore_before_switch`, `Run.rollback_to_prior`, `Run.recover`,
 * `Run.run` and the `document`/`write_record`/`phase` helpers they use. Every effect (hold,
 * units, controller, checkout helper, config reader, git, durable writer, clock) is injected;
 * the forward `_run` is an injected callback. Nothing here touches the host, and nothing
 * imports this module yet.
 */
import { createHash } from 'node:crypto';
import { pythonJsonText } from '../../../policy/crq/pythonJson.js';

export class Refused extends Error {
  override readonly name: string = 'Refused';
}
/** A refusal that must keep the hold: recovery is an owner operation. */
export class FailStop extends Refused {
  override readonly name = 'FailStop';
}
/** A health check failed after the switch: roll back, do not fail-stop. */
export class HealthFailed extends Refused {
  override readonly name = 'HealthFailed';
}
/** Python `OSError`: the only failure `fail_stop` converts into a persistence error. */
export class OSError extends Error {
  override readonly name = 'OSError';
}
/** Python `KeyboardInterrupt`: not an `Exception`, so recovery handlers pass it through. */
export class Interrupted extends Error {
  override readonly name = 'Interrupted';
}
/** The host could not be returned to a verified state; the hold is retained. */
export class RecoveryRequired extends Error {
  override readonly name = 'RecoveryRequired';
  readonly record: Record<string, unknown>;
  constructor(message: string, record?: Record<string, unknown>) {
    super(message);
    this.record = record !== undefined && truthy(record) ? record : {};
  }
}

export type Result = Record<string, unknown>;
export const DEAD_STATES: readonly string[] = ['inactive', 'failed'];

/** Python truthiness for JSON-shaped values. */
function truthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === 0 || v === '') return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  return true;
}
/** Python `s[:n]`, by code points. */
function clip(s: string, n: number): string {
  return [...s].slice(0, n).join('');
}
function dump(value: unknown): string {
  return pythonJsonText(value ?? null, {
    asciiOnly: true,
    sortKeys: true,
    keyOrder: 'code-point',
    spacedSeparators: true,
  });
}
const cmp = (a: string, b: string): number => {
  const x = [...a];
  const y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i]!.codePointAt(0)! - y[i]!.codePointAt(0)!;
    if (d !== 0) return d;
  }
  return x.length - y.length;
};
const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean => Buffer.from(a).equals(b);

function pyStrRepr(s: string): string {
  const q = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = q;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (ch === '\\') out += '\\\\';
    else if (ch === q) out += `\\${q}`;
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (c < 0x20 || c === 0x7f) out += `\\x${c.toString(16).padStart(2, '0')}`;
    else out += ch;
  }
  return out + q;
}
/** Python `repr` of a JSON-shaped value. */
export function pyRepr(v: unknown): string {
  if (v === null || v === undefined) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (typeof v === 'string') return pyStrRepr(v);
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) return `[${v.map(pyRepr).join(', ')}]`;
  if (typeof v === 'object')
    return `{${Object.entries(v)
      .map(([k, x]) => `${pyStrRepr(k)}: ${pyRepr(x)}`)
      .join(', ')}}`;
  return String(v);
}
/** Python `repr(exc)`: `Name('message')`. */
function excRepr(e: unknown): string {
  return e instanceof Error ? `${e.name}(${pyStrRepr(e.message)})` : pyRepr(e);
}
function reasonOf(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  return text !== '' ? text : e instanceof Error ? e.name : typeof e;
}
function strOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
function pyStr(v: unknown): string {
  return typeof v === 'string' ? v : pyRepr(v);
}

/** Name the evidence that denied automatic rollback, without paraphrase. */
export function compatibilityReason(record: unknown): string {
  if (
    record === null ||
    typeof record !== 'object' ||
    Array.isArray(record) ||
    (record as Result)['checked'] !== true
  )
    return 'the compatibility record was not checked';
  const r = record as Result;
  if (r['schema_marker_present'] !== false) {
    const schema = r['queue_schema'];
    if (typeof schema === 'string' && schema.startsWith('unreadable: '))
      return `the state queue could not be read (${schema.slice('unreadable: '.length)})`;
    return `the queue carries an explicit schema marker (${pyRepr(schema)}) the prior target was never proven to read`;
  }
  const observed = r['schema_observations'];
  if (truthy(observed)) {
    const items =
      typeof observed === 'string'
        ? [...observed]
        : Array.isArray(observed)
          ? (observed as unknown[])
          : Object.keys(observed as object);
    return `the queue carries state keys the prior target was never proven to read: ${items.map(pyStr).join(', ')}`;
  }
  return 'the compatibility record is not the clean shape';
}

export interface HoldLike {
  readonly acquired: boolean;
  acquire(): Promise<void>;
  owns(): Promise<boolean>;
  release(): Promise<void>;
}
export interface UnitsLike {
  stop(units: string[]): Promise<void>;
  start(units: string[]): Promise<void>;
  state(unit: string): Promise<string>;
}
export interface RollbackController<E> {
  compatibilityRecord(effects: E, priorSha: string): Promise<Result>;
  rollbackCompatible(record: Result): boolean;
  preservedDigests(effects: E): Promise<Record<string, unknown>>;
}
export interface RecoveryDeps<E> {
  controller: RollbackController<E>;
  effects: E;
  units: UnitsLike;
  /** `Hold(root)`: a fresh admission marker handle. */
  newHold(): HoldLike;
  /** `helper.switch(root, overlay, overlay_raw, sha, None)`. */
  switchCheckout(sha: string): Promise<void>;
  /** `git rev-parse HEAD`. */
  headSha(): Promise<string>;
  /** Live config bytes. */
  readConfig(): Promise<Uint8Array>;
  runtimePointerCheck(): Promise<void>;
  drainServices(): Promise<void>;
  drainQueue(recordName: string): Promise<void>;
  /** `durable_write(run_dir/<name>, value)`; throw `OSError` on storage failure. */
  durableWrite(name: string, value: Result): Promise<void>;
  now(): string;
  narrate(message: string): void;
  releaseLock(): Promise<void> | void;
  /** The forward deploy path (`Run._run`). */
  innerRun(): Promise<Result>;
}
/** The mutable `Run` fields recovery reads and writes. */
export interface RunState {
  tag: string | null;
  runDir: string | null;
  target: string | null;
  priorSha: string | null;
  original: Record<string, string> | null;
  originalConfig: Uint8Array | null;
  cqBin: unknown;
  preserved: Record<string, unknown> | null;
  triggers: string[] | null;
  hold: HoldLike | null;
  switchAttempted: boolean;
  switched: boolean;
  released: boolean;
  finalTriggers: Record<string, string> | null;
  rollback: Result | null;
  postCompatibility: Result | null;
  moduleDigests: unknown;
}

function require_(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Refused(message);
}

export class RunRecovery<E> {
  constructor(
    readonly state: RunState,
    private readonly deps: RecoveryDeps<E>,
  ) {}

  private sorted(): string[] {
    const t = this.state.triggers;
    if (t === null) throw new TypeError("'NoneType' object is not iterable");
    return [...t].sort(cmp);
  }
  private async observe(): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const unit of this.state.triggers ?? []) out[unit] = await this.deps.units.state(unit);
    return out;
  }
  private active(): string[] {
    return Object.entries(this.state.original ?? {})
      .filter(([, s]) => s === 'active')
      .map(([u]) => u)
      .sort(cmp);
  }

  document(outcome: string, extra: Result = {}): Result {
    const s = this.state;
    return {
      operation: 'deploy',
      outcome,
      released: s.released,
      target: s.target,
      prior_sha: s.priorSha,
      tag: s.tag,
      run_dir: truthy(s.runDir) ? s.runDir : null,
      cq_bin: s.cqBin,
      original_triggers: s.original,
      final_triggers: s.finalTriggers,
      rollback: s.rollback,
      ...extra,
    };
  }
  async writeRecord(outcome: string, extra: Result = {}): Promise<Result> {
    const document = this.document(outcome, extra);
    document['written_at'] = this.deps.now();
    document['module_digests'] = this.state.moduleDigests ?? null;
    await this.deps.durableWrite('deploy.json', document);
    return document;
  }
  async phase(name: string, extra: Result = {}): Promise<void> {
    await this.deps.durableWrite('phase.json', {
      operation: 'deploy',
      phase: name,
      at: this.deps.now(),
      target: this.state.target,
      prior_sha: this.state.priorSha,
      ...extra,
    });
  }

  /** Keep the hold and leave the host inert; owner recovery. */
  async failStop(reason: unknown): Promise<never> {
    const s = this.state;
    const text = pyStr(reason);
    if (s.hold !== null && (await s.hold.owns())) {
      try {
        await this.deps.units.stop(this.sorted());
      } catch (exc) {
        if (exc instanceof Interrupted) throw exc;
        this.deps.narrate(`fail-stop could not stop triggers: ${excRepr(exc)}`);
      }
    }
    const record = this.document('recovery_required', { reason: clip(text, 400) });
    record['written_at'] = this.deps.now();
    if (s.runDir !== null) {
      try {
        await this.deps.durableWrite('deploy.json', record);
        await this.phase('recovery_required', { reason: clip(text, 400), triggers: s.original });
      } catch (exc) {
        if (!(exc instanceof OSError)) throw exc;
        record['persistence_error'] = clip(excRepr(exc), 400);
        throw new RecoveryRequired(
          `${text}; the recovery record could not be persisted (${clip(excRepr(exc), 200)})`,
          record,
        );
      }
    }
    throw new RecoveryRequired(text, record);
  }

  /** Nothing live was switched: verify the pre-switch measurements still hold, restart what
   * this run stopped and release this run's own marker. A restore failure is a fail-stop. */
  async restoreBeforeSwitch(reason: string): Promise<void> {
    const s = this.state;
    const hold = s.hold;
    if (hold === null || !hold.acquired) return;
    try {
      const config = await this.deps.readConfig();
      require_(
        s.originalConfig !== null && bytesEqual(config, s.originalConfig),
        'live config no longer matches the pre-switch measurement',
      );
      require_(
        dump(await this.deps.controller.preservedDigests(this.deps.effects)) === dump(s.preserved),
        'preserved queue identity no longer matches the pre-switch measurement',
      );
      await this.deps.runtimePointerCheck();
      if (truthy(s.original)) {
        await this.deps.units.start(this.active());
        const observed = await this.observe();
        require_(
          dump(observed) === dump(s.original),
          `pre-switch restore mismatch: observed ${dump(observed)}`,
        );
      }
      if (await hold.owns()) await hold.release();
    } catch (exc) {
      if (exc instanceof Interrupted) throw exc;
      await this.failStop(
        `pre-switch restore failed after refusal (${clip(reason, 200)}): ${excRepr(exc)}`,
      );
      return;
    }
    if (s.runDir !== null) {
      try {
        await this.writeRecord('refused', { reason: clip(reason, 400) });
        await this.phase('refused', { reason: clip(reason, 400) });
      } catch (exc) {
        if (!(exc instanceof OSError)) throw exc;
        await this.failStop(
          `the refused record could not be persisted (${clip(excRepr(exc), 200)}) after: ${clip(reason, 200)}`,
        );
      }
    }
  }

  /** Automatic rollback after a failed switch, verification or health check. */
  async rollbackToPrior(reason: string): Promise<void> {
    const s = this.state;
    const d = this.deps;
    const prior = s.priorSha!;
    // Admission was released for the health window: reclaim it before any refusal can
    // fail-stop, or a disabled rollback leaves the failed target's triggers unheld.
    if (s.hold === null || !s.hold.acquired) {
      const hold = d.newHold();
      try {
        await hold.acquire();
      } catch (exc) {
        if (exc instanceof Refused)
          await this.failStop(
            `cannot reacquire admission for rollback: ${exc.message}; the failed target is still installed and its triggers may be running (after: ${clip(reason, 200)})`,
          );
        throw exc;
      }
      s.hold = hold;
    }
    require_(await s.hold.owns(), 'hold lost before rollback');
    const record =
      s.postCompatibility ?? (await d.controller.compatibilityRecord(d.effects, prior));
    if (!d.controller.rollbackCompatible(record))
      await this.failStop(
        `automatic rollback is disabled: ${compatibilityReason(record)}; the hold is retained and the owner must recover (after: ${clip(reason, 200)})`,
      );
    const current = await d.controller.compatibilityRecord(d.effects, prior);
    if (!d.controller.rollbackCompatible(current))
      await this.failStop(
        `automatic rollback is disabled by the queue's current shape: ${compatibilityReason(current)}; the hold is retained (after: ${clip(reason, 200)})`,
      );
    d.narrate(`rolling back to ${prior.slice(0, 12)}: ${reason}`);
    await d.units.stop(this.sorted());
    const stopped = await this.observe();
    require_(
      Object.values(stopped).every((state) => DEAD_STATES.includes(state)),
      `rollback trigger stop did not settle: ${dump(stopped)}`,
    );
    await d.drainServices();
    await d.drainQueue('rollback-drain.json');
    // After a released health window a completed tick legitimately advanced the queue and
    // heartbeat: re-measure and require the switch to preserve those bytes. Before release
    // the pre-deploy baseline is still the invariant.
    const baseline = s.released ? await d.controller.preservedDigests(d.effects) : s.preserved!;
    // The rollback drain can change the queue's shape: the earlier permission is stale.
    const afterDrain = await d.controller.compatibilityRecord(d.effects, prior);
    if (!d.controller.rollbackCompatible(afterDrain))
      await this.failStop(
        `automatic rollback is disabled after the rollback drain: ${compatibilityReason(afterDrain)}; the hold is retained (after: ${clip(reason, 200)})`,
      );
    await d.switchCheckout(prior);
    s.switched = false;
    require_((await d.headSha()) === prior, 'helper returned but HEAD is not the prior SHA');
    const live = await d.readConfig();
    require_(
      s.originalConfig !== null && bytesEqual(live, s.originalConfig),
      'rolled-back config bytes differ from the measured pre-deploy bytes; the cq_bin pointer was not restored exactly',
    );
    const after = await d.controller.preservedDigests(d.effects);
    const changed = Object.keys(baseline)
      .filter((key) => !Object.hasOwn(after, key) || dump(after[key]) !== dump(baseline[key]))
      .sort(cmp);
    require_(
      changed.length === 0,
      `shared queue state changed during rollback: ${changed.join(', ')}`,
    );
    // The checkout switch does not restore an external runtime entry: re-verify before start.
    await d.runtimePointerCheck();
    await d.units.start(this.active());
    const restarted = await this.observe();
    require_(
      dump(restarted) === dump(s.original),
      `rollback trigger restart mismatch: observed ${dump(restarted)} expected ${dump(s.original)}`,
    );
    s.finalTriggers = restarted;
    s.rollback = {
      permitted: true,
      to: prior,
      reason: clip(reason, 400),
      cq_bin: s.cqBin,
      restored_config_sha256: sha256Hex(live),
    };
    if (s.hold.acquired) {
      await s.hold.release();
      s.released = true;
    }
    await this.writeRecord('rolled_back', { released: true, reason: clip(reason, 400) });
    await this.phase('rolled_back', { triggers: s.finalTriggers });
    d.narrate(`rolled back to ${prior.slice(0, 12)}; triggers restored`);
  }

  private async rollbackOrFailStop(reason: string): Promise<void> {
    try {
      await this.rollbackToPrior(reason);
    } catch (err) {
      if (err instanceof RecoveryRequired || err instanceof Interrupted) throw err;
      await this.failStop(
        `automatic rollback failed (${excRepr(err)}) after: ${clip(reason, 200)}`,
      );
    }
  }

  /** Route a failure to the safe terminal state. */
  async recover(exc: unknown): Promise<'rolled_back' | 'refused'> {
    if (exc instanceof RecoveryRequired) throw exc;
    const s = this.state;
    const reason = reasonOf(exc);
    // A drain that expired means work may still be running against this checkout: keep the
    // hold and leave recovery to the owner.
    if (exc instanceof FailStop && !s.switched) await this.failStop(reason);
    if (s.switched) {
      await this.rollbackOrFailStop(reason);
      return 'rolled_back';
    }
    if (s.switchAttempted) {
      const head = await this.deps.headSha();
      if (head === s.target) {
        await this.rollbackOrFailStop(reason);
        return 'rolled_back';
      }
      if (head !== s.priorSha)
        await this.failStop(
          `switch failed and HEAD is neither the prior nor the target SHA (${head}): ${reason}`,
        );
    }
    await this.restoreBeforeSwitch(reason);
    return 'refused';
  }

  async run(): Promise<Result> {
    try {
      return await this.deps.innerRun();
    } catch (exc) {
      if (exc instanceof HealthFailed) {
        await this.recover(exc);
        return this.document('rolled_back', { reason: clip(exc.message, 400) });
      }
      if (exc instanceof Interrupted) {
        // An interrupted health window still owns a switched checkout and a released marker.
        await this.recover(new Refused('interrupted by the operator'));
        throw exc;
      }
      // Any host or helper failure must reach the safe terminal state, not escape with the
      // hold, units or checkout half-moved.
      const outcome = await this.recover(exc);
      if (outcome === 'rolled_back')
        return this.document('rolled_back', { reason: clip(strOf(exc), 400) });
      throw new Refused(strOf(exc), { cause: exc });
    } finally {
      await this.deps.releaseLock();
    }
  }
}
