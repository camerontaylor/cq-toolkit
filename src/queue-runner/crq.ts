#!/usr/bin/env node
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import type { OpResult } from '../kernel/types.js';
import { runRepairPrepare } from '../adapters/crq/repairPreparation.js';
import { runPublishUnit } from '../adapters/crq/publishSource.js';
import { runStatusWriter } from '../adapters/crq/statusWriter.js';
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
    planner: (planCommand, args) => planTick(root, planCommand, args),
    // Operator-only: explicit roots, no cwd/env default, never a unit command.
    operatorLive: async (liveCommand, args) => {
      if (liveCommand === 'repair-prepare') return runRepairPrepare(args, { gitleaksPath });
      if (liveCommand === 'status') {
        const parsed = parseStatusArgv(args);
        if (!parsed.ok) return usageArtifact('status', parsed.message);
        // The queue-runner binary's stdout is exactly one JSON document for
        // every command; the operator-readable markdown travels in the
        // artifact's `value` field, not the stdout channel.
        let statusMarkdown = '';
        const exitCode = await runStatusWriter(statusRoots(parsed.stateRoot), {
          write: (text) => {
            statusMarkdown = text;
          },
          error: (text) => process.stderr.write(text),
        });
        return {
          artifact:
            exitCode === 0
              ? { status: 'ok' as const, value: { markdown: statusMarkdown } }
              : { status: 'failed' as const, error: 'status write failed' },
          exitCode,
        };
      }
      return Promise.resolve({
        artifact: { status: 'failed' as const, error: `${liveCommand} is not implemented` },
        exitCode: 1,
      });
    },
    live: async (liveCommand): Promise<OpResult<unknown> & { readonly exitCode?: number }> => {
      if (liveCommand === 'watchdog') {
        return runWatchdog(stateHome === undefined ? {} : { stateHome });
      }
      if (liveCommand === 'publish') {
        return publishLiveCommand(root);
      }
      return Promise.resolve({ status: 'failed', error: `${liveCommand} is not implemented` });
    },
  });
  process.stdout.write(`${JSON.stringify(result.artifact)}\n`);
  process.exitCode = result.exitCode;
}

/**
 * The `publish` live unit over the runner's own roots. Mirrors Python's
 * crq.py: the CONFIG load (config.json with a clone path) happens before
 * `runtime.settings`, so a missing or clone-less config.json is a failure
 * (Python raises at import), never a disabled outcome. Every other outcome is
 * the unit's own: an absent rollout reports `publication`/`coverage` disabled
 * (exit 0) after the notification drain, a present-but-incomplete rollout is
 * the integrity refusal, and a failed coverage refresh exits 1 while still
 * reporting the publication result.
 */
export async function publishLiveCommand(
  runnerRoot: string,
): Promise<OpResult<unknown> & { readonly exitCode?: number }> {
  if (!(await readRunnerConfig(runnerRoot))) {
    return {
      status: 'failed',
      error: 'runner config.json missing, malformed, or has no clone path',
    };
  }
  const validated = await readPublisherRoots(runnerRoot);
  if (validated === null) {
    return {
      status: 'failed',
      error: 'runner config.json missing, malformed, or has no clone path',
    };
  }
  return runPublishUnit(validated);
}

/**
 * Only the runner's own `config.json` shape (Python's CONFIG load): an object
 * with a nonempty `clone` string. Everything else — the state_root resolution
 * and the rollout read — is {@link readPublisherRoots}' concern; this gate
 * exists so the disabled probe cannot run against a guessed state root after
 * the configuration Python would have raised on is gone.
 */
async function readRunnerConfig(runnerRoot: string): Promise<boolean> {
  let config: unknown;
  try {
    config = JSON.parse(await readFile(join(runnerRoot, 'config.json'), 'utf8'));
  } catch {
    return false;
  }
  if (typeof config !== 'object' || config === null || Array.isArray(config)) return false;
  const clone = (config as Record<string, unknown>)['clone'];
  return typeof clone === 'string' && clone !== '';
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

/**
 * The publisher roots from the runner's own config.json, state_root resolved.
 * Returns null only when config.json is unusable (missing, malformed or without
 * a clone path): Python raises at import in that case. The durable artifact
 * root is null when the rollout file is absent or unusable, which the unit
 * itself reports as `disabled` or as the integrity refusal.
 */
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
  let durableArtifactRoot: string | null = null;
  try {
    const rollout = JSON.parse(
      await readFile(join(stateRoot, 'backfill-rollout.json'), 'utf8'),
    ) as unknown;
    const durable =
      typeof rollout === 'object' && rollout !== null && !Array.isArray(rollout)
        ? (rollout as Record<string, unknown>)['durable_artifact_root']
        : undefined;
    if (typeof durable === 'string' && durable !== '') durableArtifactRoot = durable;
  } catch {
    durableArtifactRoot = null;
  }
  return { stateRoot, cloneRoot: clone, runnerRoot, durableArtifactRoot };
}

/** `crq status [--state-root <dir>]` argv; the runner root is the cwd. */
function parseStatusArgv(
  args: readonly string[],
):
  | { readonly ok: true; readonly stateRoot: string }
  | { readonly ok: false; readonly message: string } {
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
