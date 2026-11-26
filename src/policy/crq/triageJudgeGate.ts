/**
 * The triage judge closure of `crq_repair.triage_phase`
 * (`apps/crq-python/crq_repair.py:895-970`): the gate sequence a judgment
 * passes before a provider is reached, around an injected `dispatch`.
 *
 * Order, exactly as Python runs it: pin the deadline, build the job and make
 * its directory, scan the context for secrets, pick the role (escalated rows
 * use the escalation role), then the runner-disabled, GLM-blackout and
 * provider-pause gates, then the deadline, then dispatch with the remaining
 * wall clock. A failing gate defers or stops with a report; it never raises.
 *
 * Every effect is injected so the gate trace is replayable against the Python
 * oracle; nothing here is routed. Python's own failures (a missing key, a
 * non-string id, a non-string provider pause) are raised as
 * {@link TriageJudgePyError} of the same class.
 *
 * Deviations from Python: a finding id that is an absolute path is refused
 * with {@link TriageJudgeGateRefusal} (`Path / absolute` would replace the
 * state directory and the oracle cannot safely vector a `mkdir` outside its
 * scratch tree); `Path.mkdir`'s own failures are whatever the injected
 * `mkdir` rejects with. The outer `triage_phase` arguments (`max_per_pass`,
 * the phase seconds) are evaluated by the caller that supplies `config`.
 */
import { pythonTruthy } from './repairBinding.js';
import { JsonNumber, JsonObject, type JsonValue } from './jsonValue.js';
import { TriageJudgePyError, getOr, subscript } from './triageJudge.js';

/** `crq_repair.RUNNER_DISABLED`. */
export const RUNNER_DISABLED = 'runner disabled for host handover (state/runner-disabled)';

/** A gate input the port refuses where Python would act outside the state tree. */
export class TriageJudgeGateRefusal extends Error {
  override readonly name = 'TriageJudgeGateRefusal';
}

type Maybe<T> = T | Promise<T>;

export interface TriageJudgeEffects {
  /** `time.monotonic()`. */
  readonly monotonic: () => number;
  /** `directory.mkdir(parents=True, exist_ok=True)`. */
  readonly mkdir: (path: string) => Maybe<void>;
  /** `triage_context_scan(c, context, output)`; its truthiness is the verdict. */
  readonly scan: (context: JsonValue, output: string) => Maybe<JsonValue>;
  /** `runner_disabled()`. */
  readonly runnerDisabled: () => Maybe<JsonValue>;
  /** `narrate(message)`. */
  readonly narrate: (message: string) => Maybe<void>;
  /** `publish_refusal()`. */
  readonly publishRefusal: () => Maybe<void>;
  /** `blocked(config['repair'])`. */
  readonly blocked: (repair: JsonValue) => Maybe<JsonValue>;
  /** `dispatch_paused(config)`: the pause-until text, or a falsy value. */
  readonly dispatchPaused: (config: JsonValue) => Maybe<JsonValue>;
  /** `dispatch(config, role, job, wt, directory, judge=True)`. */
  readonly dispatch: (call: {
    readonly config: JsonValue;
    readonly role: JsonValue;
    readonly job: JsonValue;
    readonly wt: JsonValue;
    readonly directory: string;
    readonly judge: true;
  }) => Maybe<JsonValue>;
}

export interface TriageJudgeInput {
  readonly config: JsonValue;
  /** `ROOT / 'state'`, as a POSIX path. */
  readonly stateDir: string;
  readonly effects: TriageJudgeEffects;
}

export type TriageJudge = (
  row: JsonValue,
  context: JsonValue,
  remaining: number,
) => Promise<JsonValue>;

const DEFAULT_ROLE = new JsonObject([
  ['driver', 'cq'],
  ['model', 'opencode-go/deepseek-v4.1-flash'],
]);
const EMPTY = new JsonObject([]);

/** `base / segment` for a relative POSIX segment, normalised as `pathlib` does. */
function join(base: string, segment: string): string {
  if (segment.startsWith('/')) {
    throw new TriageJudgeGateRefusal(`absolute path segment: ${JSON.stringify(segment)}`);
  }
  const parts = [...base.split('/'), ...segment.split('/')].filter(
    (part) => part !== '' && part !== '.',
  );
  return (base.startsWith('/') ? '/' : '') + parts.join('/');
}

function report(entries: Array<[string, JsonValue]>): JsonObject {
  return new JsonObject(entries);
}

/** `copy.deepcopy(config)` with `['repair']['budget']['wall_clock_min'] = minutes`. */
function withWallClock(config: JsonValue, minutes: number): JsonValue {
  const value = JsonNumber.float(minutes);
  const replace = (
    object: JsonValue,
    key: string,
    update: (current: JsonValue | undefined) => JsonValue,
  ): JsonValue => {
    if (!(object instanceof JsonObject)) throw new TriageJudgePyError('TypeError');
    const found = object.has(key);
    const entries = object.entries.map(([name, current]): [string, JsonValue] =>
      name === key ? [name, update(current)] : [name, current],
    );
    return new JsonObject(found ? entries : [...entries, [key, update(undefined)]]);
  };
  return replace(config, 'repair', (repair) =>
    replace(repair ?? EMPTY, 'budget', (budget) =>
      replace(budget ?? EMPTY, 'wall_clock_min', () => value),
    ),
  );
}

/**
 * The closure `triage_phase` hands to `phase`. Construction reads, in
 * Python's order, `config['clone']`, `config['repair'].get('triage', {})` and
 * the role, and refuses a role whose driver is not `cq` with the authored
 * `ValueError`.
 */
export function makeTriageJudge(input: TriageJudgeInput): TriageJudge {
  const { config, effects } = input;
  const clone = subscript(config, 'clone');
  const repair = subscript(config, 'repair');
  const options = getOr(repair, 'triage', EMPTY);
  const role = getOr(options, 'role', DEFAULT_ROLE);
  if (getOr(role, 'driver', null) !== 'cq') {
    throw new TriageJudgePyError('ValueError', 'triage requires cq structured judge bridge');
  }
  const triageRoot = join(input.stateDir, 'repair/triage');

  return async (row, context, remaining) => {
    // phase() measured `remaining` before this call; the context scan can
    // outlive it, so the deadline is pinned at entry.
    const deadline = effects.monotonic() + remaining;
    const id = subscript(subscript(row, 'finding'), 'id');
    if (typeof id !== 'string') throw new TriageJudgePyError('TypeError');
    const reviewId = subscript(row, 'review_id');
    const job = new JsonObject([
      ['job', 'crq-triage-' + id],
      ['run', reviewId],
      ['triage_context', context],
    ]);
    const directory = join(triageRoot, id);
    await effects.mkdir(directory);
    if (!pythonTruthy(await effects.scan(context, join(directory, 'context-scan.json')))) {
      return report([
        ['stop', 'ok'],
        ['verdict', 'unsure'],
        ['context_scan_refused', true],
        ['reason', 'triage context secret scan rejected'],
      ]);
    }
    // `options.get('escalation_role', <default>)` evaluates its default first.
    const selected = pythonTruthy((row as JsonObject).get('_escalate'))
      ? getOr(options, 'escalation_role', subscript(subscript(repair, 'roles'), 'judge_critical'))
      : role;
    if (pythonTruthy(await effects.runnerDisabled())) {
      await effects.narrate(RUNNER_DISABLED + ': triage judgment deferred');
      await effects.publishRefusal();
      return report([
        ['stop', 'deferred'],
        ['errorClass', 'runner-disabled'],
        ['reason', 'runner disabled for host handover; triage judge deferred'],
      ]);
    }
    if (pythonTruthy(await effects.blocked(repair))) {
      return report([
        ['stop', 'deferred'],
        ['errorClass', 'blackout'],
        ['reason', 'GLM peak blackout; triage judge deferred'],
      ]);
    }
    const until = await effects.dispatchPaused(config);
    if (pythonTruthy(until)) {
      if (typeof until !== 'string') throw new TriageJudgePyError('TypeError');
      return report([
        ['stop', 'deferred'],
        ['errorClass', 'rate-limit'],
        ['reason', 'provider dispatch paused until ' + until + '; triage judge deferred'],
      ]);
    }
    const left = deadline - effects.monotonic();
    if (left <= 0) {
      return report([
        ['stop', 'deadline'],
        ['reason', 'phase deadline elapsed before triage provider dispatch'],
      ]);
    }
    return effects.dispatch({
      config: withWallClock(config, left / 60),
      role: selected,
      job,
      wt: clone,
      directory,
      judge: true,
    });
  };
}
