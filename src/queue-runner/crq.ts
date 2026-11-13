#!/usr/bin/env node
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { runRepairPrepare } from '../adapters/crq/repairPreparation.js';
import { runStatusWriter } from '../adapters/crq/statusWriter.js';
import { run } from './runner.js';
import { planTick } from './tick.js';
import { runWatchdog } from './watchdog.js';

const root = process.cwd();
const stateHome = process.env.XDG_STATE_HOME;
const gitleaksPath = process.env.PATH;

/** The XDG state roots the status command writes/reads under. */
function statusRoots(stateRoot: string): {
  runnerRoot: string;
  stateRoot: string;
  xdgStateHome: string;
  home: string;
} {
  const home = homedir();
  return {
    runnerRoot: root,
    stateRoot,
    xdgStateHome: stateHome ?? '',
    home,
  };
}

const result = await run(process.argv.slice(2), {
  shadowRoot: root,
  tick: randomUUID(),
  planner: (command, args) => planTick(root, command, args),
  // Operator-only: explicit roots, no cwd/env default, never a unit command.
  operatorLive: async (command, args) => {
    if (command === 'repair-prepare') return runRepairPrepare(args, { gitleaksPath });
    if (command === 'status') {
      const parsed = parseStatusArgv(args);
      if (!parsed.ok) return usageArtifact('status', parsed.message);
      const exitCode = await runStatusWriter(statusRoots(parsed.stateRoot), {
        write: (text) => process.stdout.write(text),
        error: (text) => process.stderr.write(text),
      });
      // The runner's artifact channel is one JSON document; the status
      // command's stdout is the markdown itself, so the artifact records
      // only the outcome. Python's `crq status` prints markdown and exits.
      return {
        artifact:
          exitCode === 0
            ? { status: 'ok' as const }
            : { status: 'failed' as const, error: 'status write failed' },
        exitCode,
      };
    }
    return Promise.resolve({
      artifact: { status: 'failed' as const, error: `${command} is not implemented` },
      exitCode: 1,
    });
  },
  live: (command) => {
    if (command === 'watchdog') return runWatchdog(stateHome === undefined ? {} : { stateHome });
    return Promise.resolve({ status: 'failed', error: `${command} is not implemented` });
  },
});
process.stdout.write(`${JSON.stringify(result.artifact)}\n`);
process.exitCode = result.exitCode;

/** `crq status [--state-root <dir>]` argv; the runner root is the cwd. */
function parseStatusArgv(
  args: readonly string[],
): { readonly ok: true; readonly stateRoot: string } | { readonly ok: false; readonly message: string } {
  let stateRoot = join(root, 'state');
  let index = 0;
  while (index < args.length) {
    const flag = args[index];
    if (flag !== '--state-root') return { ok: false, message: `unknown flag: ${flag ?? ''}` };
    const value = args[index + 1];
    if (value === undefined) return { ok: false, message: 'missing value for --state-root' };
    stateRoot = value;
    index += 2;
  }
  return { ok: true, stateRoot };
}

function usageArtifact(subcommand: string, message: string) {
  return {
    artifact: { error: { kind: 'usage', subcommand, message, exitCode: 2 } },
    exitCode: 2,
  };
}
