/** Pass-level runner-disabled gates of the repair drain (Python `crq_repair`).
 *
 * `state/runner-disabled` is a host-handover marker. Python reads it only at
 * admission points, never inside a running job (that would abandon paid work):
 * the start of a pass, after the pre-triage fetch, before each item, before each
 * serial job, and before each judge call. The marker read and every effect are
 * injected; nothing here forks, fetches or activates anything. Run-level
 * refusal of a single dispatch lives in `repairDispatch.ts`.
 */
export const RUNNER_DISABLED = 'runner disabled for host handover (state/runner-disabled)';
/** Distinct from a rate-limit stop, so a refusal ends the pass instead of looking normal. */
export const RUNNER_DISABLED_OUTCOME = 'runner-disabled';

export interface PassGateEffects {
  runnerDisabled(): Promise<boolean>;
  narrate(message: string): void;
}

export type GateStage =
  | { readonly stage: 'pass-start' }
  | { readonly stage: 'before-triage' }
  | { readonly stage: 'before-item'; readonly item: string }
  | { readonly stage: 'item-not-admitted'; readonly item: string }
  | { readonly stage: 'before-job'; readonly job: string }
  | { readonly stage: 'triage-judge' }
  | { readonly stage: 'recovery-judge' }
  | { readonly stage: 'cli-dispatch' }
  | { readonly stage: 'recover-after-fetch'; readonly job: string };

/** The line Python narrates for each stage. */
export function gateMessage(gate: GateStage): string {
  switch (gate.stage) {
    case 'pass-start':
      return `${RUNNER_DISABLED}: pass not started`;
    case 'before-triage':
      return `${RUNNER_DISABLED}: pass stopped before triage`;
    case 'before-item':
      return `${RUNNER_DISABLED}: pass stopped before ${gate.item}`;
    case 'item-not-admitted':
      return `${RUNNER_DISABLED}: item ${gate.item} not admitted`;
    case 'before-job':
      return `${RUNNER_DISABLED}: job ${gate.job} not admitted`;
    case 'triage-judge':
      return `${RUNNER_DISABLED}: triage judgment deferred`;
    case 'recovery-judge':
      return `${RUNNER_DISABLED}: recovery judge deferred`;
    case 'cli-dispatch':
      return `${RUNNER_DISABLED}: dispatch refused`;
    case 'recover-after-fetch':
      return `${RUNNER_DISABLED}: recovery deferred for ${gate.job}`;
  }
}

/** True when the stage may proceed; otherwise narrates once and returns false. */
export async function admit(gate: GateStage, effects: PassGateEffects): Promise<boolean> {
  if (!(await effects.runnerDisabled())) return true;
  effects.narrate(gateMessage(gate));
  return false;
}

/** What a judge call returns while the runner is disabled: no model call is made. */
export function disabledJudgeResult(kind: 'triage' | 'recovery'): {
  readonly stop: 'deferred' | 'configuration';
  readonly errorClass: 'runner-disabled';
  readonly reason: string;
} {
  return kind === 'triage'
    ? {
        stop: 'deferred',
        errorClass: RUNNER_DISABLED_OUTCOME,
        reason: 'runner disabled for host handover; triage judge deferred',
      }
    : {
        stop: 'configuration',
        errorClass: RUNNER_DISABLED_OUTCOME,
        reason: 'runner disabled for host handover; recovery judge deferred',
      };
}

/** Run a judge unless the runner is disabled at the moment of the call. */
export async function gatedJudge<T>(
  kind: 'triage' | 'recovery',
  effects: PassGateEffects,
  judge: () => Promise<T>,
): Promise<T | ReturnType<typeof disabledJudgeResult>> {
  if (!(await admit({ stage: kind === 'triage' ? 'triage-judge' : 'recovery-judge' }, effects)))
    return disabledJudgeResult(kind);
  return judge();
}

export interface DrainPassEffects extends PassGateEffects {
  /** `fetch_clone`: an error string skips the pass. */
  fetchClone(): Promise<string | null>;
  triage(): Promise<void>;
  /** Items in drain order. */
  items(): Promise<readonly string[]>;
  /** Blackout or provider pause: stop admitting. */
  halted(): Promise<boolean>;
  /** One item; resolves with its outcome (`rate-limit`, `runner-disabled`, anything else). */
  drainItem(item: string): Promise<string | null>;
}
export type DrainPassResult =
  | {
      readonly status: 'refused';
      readonly stage: 'pass-start' | 'before-triage' | 'before-item';
      readonly admitted: readonly string[];
    }
  | { readonly status: 'skipped'; readonly reason: string }
  | { readonly status: 'done'; readonly admitted: readonly string[] };

/** Serial drain admission: refused with no effect when disabled at the start, re-checked
 * after the fetch and before each item. An item already admitted is never interrupted. */
export async function runDrainPass(effects: DrainPassEffects): Promise<DrainPassResult> {
  if (!(await admit({ stage: 'pass-start' }, effects)))
    return { status: 'refused', stage: 'pass-start', admitted: [] };
  const error = await effects.fetchClone();
  if (error !== null) return { status: 'skipped', reason: error.slice(0, 200) };
  if (!(await admit({ stage: 'before-triage' }, effects)))
    return { status: 'refused', stage: 'before-triage', admitted: [] };
  await effects.triage();
  const admitted: string[] = [];
  for (const item of await effects.items()) {
    if (!(await admit({ stage: 'before-item', item }, effects)))
      return { status: 'refused', stage: 'before-item', admitted };
    if (await effects.halted()) break;
    admitted.push(item);
    const outcome = await effects.drainItem(item);
    if (outcome === 'rate-limit' || outcome === RUNNER_DISABLED_OUTCOME) break;
  }
  return { status: 'done', admitted };
}

/** Serial jobs of one item: the in-flight job finishes, the next is not started. */
export async function runItemJobs<J extends { readonly job: string }>(
  jobs: readonly J[],
  effects: PassGateEffects & { runJob(job: J): Promise<void> },
): Promise<{ readonly ran: readonly string[]; readonly outcome: string | null }> {
  const ran: string[] = [];
  for (const job of jobs) {
    if (!(await admit({ stage: 'before-job', job: job.job }, effects)))
      return { ran, outcome: RUNNER_DISABLED_OUTCOME };
    await effects.runJob(job);
    ran.push(job.job);
  }
  return { ran, outcome: null };
}
