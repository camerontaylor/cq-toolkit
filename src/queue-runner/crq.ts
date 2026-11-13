#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { runRepairPrepare } from '../adapters/crq/repairPreparation.js';
import { run } from './runner.js';
import { planTick } from './tick.js';
import { runWatchdog } from './watchdog.js';

const root = process.cwd();
const stateHome = process.env.XDG_STATE_HOME;
const gitleaksPath = process.env.PATH;
const result = await run(process.argv.slice(2), {
  shadowRoot: root,
  tick: randomUUID(),
  planner: (command, args) => planTick(root, command, args),
  // Operator-only: explicit roots, no cwd/env default, never a unit command.
  operatorLive: (command, args) =>
    command === 'repair-prepare'
      ? runRepairPrepare(args, { gitleaksPath })
      : Promise.resolve({
          artifact: { status: 'failed' as const, error: `${command} is not implemented` },
          exitCode: 1,
        }),
  live: (command) => {
    if (command === 'watchdog') return runWatchdog(stateHome === undefined ? {} : { stateHome });
    return Promise.resolve({ status: 'failed', error: `${command} is not implemented` });
  },
});
process.stdout.write(`${JSON.stringify(result.artifact)}\n`);
process.exitCode = result.exitCode;
