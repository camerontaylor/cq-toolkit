import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { OpResult } from '../kernel/types.js';
import { LIVE_UNIT_COMMANDS } from './capabilities.js';

const commands = new Set([
  'init',
  'measure',
  'repair-prepare',
  'tick',
  'start',
  'push-recover',
  'author-enroll',
  'author-lease',
  'author-fallback',
  'author-observe',
  'enqueue-merged',
  'reconcile-merged',
  'report',
  'status',
  'summary',
  'synth',
  'pause',
  'resume',
  'requeue',
  'skip',
  'block',
  'prioritize',
  'deprioritize',
  'selfcheck',
  '_review',
  'slot',
  'repair',
  'publish',
  'backfill',
  'dispatch',
  'watchdog',
]);
const liveCommands = new Set<string>(LIVE_UNIT_COMMANDS);

/**
 * Operator-live commands: explicit, argument-bearing commands an operator runs
 * by hand. Deliberately separate from `LIVE_UNIT_COMMANDS`/`capabilities.json`
 * so no unit adapter can select one. Each handler parses its own argv and
 * returns the single JSON artifact plus its own exit code (3 for a busy tick
 * lock, Python parity).
 */
export const LIVE_OPERATOR_COMMANDS = ['repair-prepare', 'status', 'backfill'] as const;
const operatorLiveCommands = new Set<string>(LIVE_OPERATOR_COMMANDS);
const backfillCommands = new Set([
  'inventory',
  'publish',
  'baseline',
  'import-history',
  'collect-history',
  'release',
  'quarantine-release',
  'reconcile-no-launch',
  'triage',
  'deliver',
]);

export interface Mutation {
  operation: string;
  target: string;
  value: unknown;
}
export interface Plan {
  mutations: Mutation[];
  value: unknown;
}
export type Planner = (command: string, args: string[]) => Promise<Plan>;
/**
 * A live unit's result, optionally carrying an explicit exit code. Python's
 * publisher exits 1 when only the coverage refresh failed: publication
 * succeeded and is still reported, but the unit must be visibly unhealthy.
 * The runner strips `exitCode` from the artifact it prints.
 */
export type LiveDispatchResult = OpResult<unknown> & { readonly exitCode?: number };

export type LiveDispatch = (command: string, args: string[]) => Promise<LiveDispatchResult>;
export type OperatorLiveDispatch = (command: string, args: string[]) => Promise<RunnerResult>;

/**
 * A planner's argv refusal. The runner reports it as the usage artifact
 * (exit 2) instead of the generic thrown-error artifact (exit 1), so doctrine
 * I1's arg-error code survives the planner boundary.
 */
export class PlannerUsageError extends Error {
  override name = 'PlannerUsageError';
}

/**
 * A structured operator artifact. It is the runner's one JSON document, not a
 * new op status: the typed fields (`refusal`, `detail`, `steps`, ...) are
 * evidence for the operator and never persisted state.
 */
export interface OperatorArtifact {
  readonly status: 'ok' | 'failed' | 'indeterminate';
  readonly value?: unknown;
  readonly error?: string;
  readonly refusal?: string;
  readonly detail?: string;
  readonly diagnostic?: unknown;
  readonly step?: string;
  readonly steps?: readonly unknown[];
  readonly effects?: readonly unknown[];
  readonly lockExit?: 'unconfirmed';
}

export type RunnerArtifact =
  | OpResult<unknown>
  | { error: { kind: string; subcommand: string; message: string; exitCode: number } }
  | OperatorArtifact;

export type RunnerResult = {
  artifact: RunnerArtifact;
  exitCode: number;
};

/** Planners describe effects; only the dry-run recorder is implemented in this skeleton. */
export async function run(
  args: string[],
  options: {
    shadowRoot: string;
    tick: string;
    planner?: Planner;
    live?: LiveDispatch;
    operatorLive?: OperatorLiveDispatch;
  },
): Promise<RunnerResult> {
  const command = args[0] ?? '';
  const usage = (message: string): RunnerResult => ({
    artifact: { error: { kind: 'usage', subcommand: command, message, exitCode: 2 } },
    exitCode: 2,
  });
  if (!commands.has(command)) return usage('Unknown or missing subcommand');
  if (command === 'backfill' && !backfillCommands.has(args[1] ?? ''))
    return usage('Unknown or missing backfill subcommand');
  if (operatorLiveCommands.has(command)) {
    if (!options.operatorLive)
      return {
        artifact: { status: 'failed', error: `${command} is not implemented` },
        exitCode: 1,
      };
    try {
      // The handler owns its argv and its exit code; the runner only carries
      // the one JSON artifact to stdout.
      return await options.operatorLive(command, args.slice(1));
    } catch (error) {
      return {
        artifact: {
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
        },
        exitCode: 1,
      };
    }
  }
  if (liveCommands.has(command)) {
    if (args.length !== 1) return usage(`${command} does not accept arguments`);
    if (!options.live)
      return {
        artifact: { status: 'failed', error: `${command} is not implemented` },
        exitCode: 1,
      };
    try {
      const result = await options.live(command, []);
      const { exitCode, ...artifact } = result;
      return {
        artifact,
        exitCode: exitCode ?? (result.status === 'ok' ? 0 : 1),
      };
    } catch (error) {
      return {
        artifact: {
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
        },
        exitCode: 1,
      };
    }
  }
  if (!options.planner)
    return { artifact: { status: 'failed', error: `${command} is not implemented` }, exitCode: 1 };
  if (!args.includes('--dry-run'))
    return {
      artifact: { status: 'failed', error: 'Live execution is not implemented' },
      exitCode: 1,
    };
  if (!/^[A-Za-z0-9_-]+$/.test(options.tick)) return usage('Invalid shadow tick identifier');
  try {
    const plan = await options.planner(
      command,
      args.slice(1).filter((arg) => arg !== '--dry-run'),
    );
    const dir = join(options.shadowRoot, 'shadow');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, `${options.tick}.json`),
      `${JSON.stringify({ command, value: plan.value, mutations: plan.mutations }, null, 2)}\n`,
      { flag: 'wx' },
    );
    if (
      typeof plan.value === 'object' &&
      plan.value !== null &&
      'complete' in plan.value &&
      plan.value.complete === false
    ) {
      return {
        artifact: {
          status: 'indeterminate',
          detail: 'Shadow plan is incomplete and cannot be used for parity comparison',
        },
        exitCode: 1,
      };
    }
    return { artifact: { status: 'ok', value: plan.value }, exitCode: 0 };
  } catch (error) {
    if (error instanceof PlannerUsageError) return usage(error.message);
    return {
      artifact: { status: 'failed', error: error instanceof Error ? error.message : String(error) },
      exitCode: 1,
    };
  }
}
