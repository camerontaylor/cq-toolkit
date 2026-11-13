#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { OpResult } from '../kernel/types.js';
import { runRepairPrepare } from '../adapters/crq/repairPreparation.js';
import { runPublishUnit } from '../adapters/crq/publishSource.js';
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
  live: (command): Promise<OpResult<unknown>> => {
    if (command === 'watchdog') return runWatchdog(stateHome === undefined ? {} : { stateHome });
    if (command === 'publish') {
      // The unit reads the runner roots from its config, mirroring Python's
      // crq.py CONFIG: explicit paths, never a cwd/env default beyond cwd.
      return readPublisherRoots(root).then(async (roots): Promise<OpResult<unknown>> => {
        if (roots === null) {
          return {
            status: 'failed',
            error: 'publisher roots unavailable: config.json clone/durable_artifact_root',
          };
        }
        return runPublishUnit(roots);
      });
    }
    return Promise.resolve({ status: 'failed', error: `${command} is not implemented` });
  },
});
process.stdout.write(`${JSON.stringify(result.artifact)}\n`);
process.exitCode = result.exitCode;

/**
 * The publisher roots from the runner's own `config.json` (Python's CONFIG:
 * `clone` and the rollout's `durable_artifact_root`), resolved against the
 * runner root. Absent or unusable config is a refusal, never a guess.
 */
async function readPublisherRoots(runnerRoot: string) {
  let config: unknown;
  try {
    config = JSON.parse(await readFile(join(runnerRoot, 'config.json'), 'utf8'));
  } catch {
    return null;
  }
  if (typeof config !== 'object' || config === null || Array.isArray(config)) return null;
  const record = config as Record<string, unknown>;
  const clone = record['clone'];
  if (typeof clone !== 'string' || clone === '') return null;
  const stateRoot =
    typeof record['state_root'] === 'string' && record['state_root'] !== ''
      ? record['state_root']
      : join(runnerRoot, 'state');
  let durableArtifactRoot: string;
  try {
    const rollout = JSON.parse(
      await readFile(join(stateRoot, 'backfill-rollout.json'), 'utf8'),
    ) as unknown;
    const durable =
      typeof rollout === 'object' && rollout !== null && !Array.isArray(rollout)
        ? (rollout as Record<string, unknown>)['durable_artifact_root']
        : undefined;
    if (typeof durable !== 'string' || durable === '') return null;
    durableArtifactRoot = durable;
  } catch {
    return null;
  }
  return { stateRoot, cloneRoot: clone, durableArtifactRoot };
}
