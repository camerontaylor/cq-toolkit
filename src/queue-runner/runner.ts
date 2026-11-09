import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { OpResult } from '../kernel/types.js';

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
export type RunnerResult = {
  artifact:
    | OpResult<unknown>
    | { error: { kind: string; subcommand: string; message: string; exitCode: number } };
  exitCode: number;
};

/** Planners describe effects; only the dry-run recorder is implemented in this skeleton. */
export async function run(
  args: string[],
  options: { shadowRoot: string; tick: string; planner?: Planner },
): Promise<RunnerResult> {
  const command = args[0] ?? '';
  const usage = (message: string): RunnerResult => ({
    artifact: { error: { kind: 'usage', subcommand: command, message, exitCode: 2 } },
    exitCode: 2,
  });
  if (!commands.has(command)) return usage('Unknown or missing subcommand');
  if (command === 'backfill' && !backfillCommands.has(args[1] ?? ''))
    return usage('Unknown or missing backfill subcommand');
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
        artifact: { status: 'indeterminate', detail: 'Shadow plan is incomplete and cannot be used for parity comparison' },
        exitCode: 1,
      };
    }
    return { artifact: { status: 'ok', value: plan.value }, exitCode: 0 };
  } catch (error) {
    return {
      artifact: { status: 'failed', error: error instanceof Error ? error.message : String(error) },
      exitCode: 1,
    };
  }
}
