#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import type { OpResult } from '../kernel/types.js';
import { runRepairPrepare } from '../adapters/crq/repairPreparation.js';
import { runPublishUnit } from '../adapters/crq/publishSource.js';
import { MAX_REQUEST_BYTES, runQueueCapabilityMain } from '../adapters/crq/queueCapabilityMain.js';
import { run } from './runner.js';
import { planTick } from './tick.js';
import { runWatchdog } from './watchdog.js';

/** Read at most one wire frame plus the byte that proves it is over-long. */
async function readFrame(): Promise<Uint8Array> {
  const limit = MAX_REQUEST_BYTES + 1;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = chunk as Buffer;
    const take = Math.min(buffer.length, limit - size);
    chunks.push(buffer.subarray(0, take));
    size += take;
    if (size >= limit) break;
  }
  return Buffer.concat(chunks, size);
}

const root = process.cwd();
const [command, ...rest] = process.argv.slice(2);
if (command === 'queue-capability') {
  // The forced-command route: policy and identity come from the environment,
  // the request frame from stdin, and nothing else is accepted.
  process.exitCode = await runQueueCapabilityMain({
    argv: rest,
    env: (name) => process.env[name],
    readStdin: readFrame,
    stdout: (bytes) => {
      process.stdout.write(bytes);
    },
    stderr: (message) => {
      process.stderr.write(`${message}\n`);
    },
    // The deadline must end the process, not just the race: a pending stdin
    // read or a held queue lock would otherwise outlive the refusal.
    terminate: () => process.exit(2),
    root,
  });
} else {
  const stateHome = process.env.XDG_STATE_HOME;
  const gitleaksPath = process.env.PATH;
  const result = await run(process.argv.slice(2), {
    shadowRoot: root,
    tick: randomUUID(),
    planner: (planCommand, args) => planTick(root, planCommand, args),
    // Operator-only: explicit roots, no cwd/env default, never a unit command.
    operatorLive: (liveCommand, args) =>
      liveCommand === 'repair-prepare'
        ? runRepairPrepare(args, { gitleaksPath })
        : Promise.resolve({
            artifact: { status: 'failed' as const, error: `${liveCommand} is not implemented` },
            exitCode: 1,
          }),
    live: async (liveCommand): Promise<OpResult<unknown>> => {
      if (liveCommand === 'watchdog') {
        return runWatchdog(stateHome === undefined ? {} : { stateHome });
      }
      if (liveCommand === 'publish') {
        // The unit reads the runner roots from its config, mirroring Python's
        // crq.py CONFIG: explicit paths, never a cwd/env default beyond cwd.
        // Python's run(): `config = runtime.settings(c.STATE); if not config:
        // return {"publication": "disabled"}`. settings returns None only for
        // a missing rollout file; a malformed rollout raises IntegrityError,
        // and a missing config.json/clone raises before settings runs.
        // Configuration is therefore validated before any disabled outcome:
        // a missing or malformed config.json, a missing clone, or an unusable
        // rollout read is the IntegrityError path (failure), never disabled.
        const validated = await readPublisherRoots(root);
        if (validated === null) {
          const stateRoot = await publisherStateRoot(root);
          if (await isRolloutAbsent(join(stateRoot, 'backfill-rollout.json'))) {
            // A usable configuration whose rollout file is missing: Python's
            // settings() returns None, run() reports {"publication":"disabled"}.
            // A config.json with a clone but absent rollout reaches here.
            return { status: 'ok', value: { publication: 'disabled' } };
          }
          return {
            status: 'failed',
            error: 'backfill rollout prerequisites incomplete',
          };
        }
        return runPublishUnit(validated);
      }
      return Promise.resolve({ status: 'failed', error: `${liveCommand} is not implemented` });
    },
  });
  process.stdout.write(`${JSON.stringify(result.artifact)}\n`);
  process.exitCode = result.exitCode;
}

/**
 * The publisher roots from the runner's own `config.json` (Python's CONFIG:
 * `clone` and the rollout's `durable_artifact_root`), resolved against the
 * runner root. Absent or unusable config is a refusal, never a guess.
 */
async function isRolloutAbsent(path: string): Promise<boolean> {
  try {
    await stat(path);
    return false;
  } catch (error) {
    // Only a missing file is "absent". EACCES/EIO and friends must surface:
    // reporting a disabled success for an inaccessible rollout would stop a
    // live publisher with exit 0.
    if (
      error instanceof Error &&
      'code' in error &&
      (error as { code?: string }).code === 'ENOENT'
    ) {
      return true;
    }
    throw error;
  }
}

/** The state root `readPublisherRoots` would use: config.state_root or default. */
export async function publisherStateRoot(runnerRoot: string): Promise<string> {
  // Mirrors readPublisherRoots' derivation, including resolving a relative
  // configured state_root against the runner root, so the rollout-absence
  // probe and the effects binding always target the same directory.
  try {
    const config = JSON.parse(await readFile(join(runnerRoot, 'config.json'), 'utf8')) as unknown;
    const stateRoot =
      typeof config === 'object' && config !== null && !Array.isArray(config)
        ? (config as Record<string, unknown>)['state_root']
        : undefined;
    if (typeof stateRoot === 'string' && stateRoot !== '') {
      return isAbsolute(stateRoot) ? stateRoot : resolve(runnerRoot, stateRoot);
    }
  } catch {
    // fall through to the default
  }
  return join(runnerRoot, 'state');
}

/** The publisher roots from the runner's own config.json, state_root resolved. */
export async function readPublisherRoots(runnerRoot: string) {
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
  // A configured state_root may be relative (Python resolves paths against
  // cwd); resolve it against the runner root so the effects always bind an
  // absolute root (a relative root makes git -C init into publisher.git/
  // <relative> instead of the intended directory).
  const configuredStateRoot =
    typeof record['state_root'] === 'string' && record['state_root'] !== ''
      ? record['state_root']
      : join(runnerRoot, 'state');
  const stateRoot = isAbsolute(configuredStateRoot)
    ? configuredStateRoot
    : resolve(runnerRoot, configuredStateRoot);
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
