#!/usr/bin/env node
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import type { OpResult } from '../kernel/types.js';
import { runRepairPrepare } from '../adapters/crq/repairPreparation.js';
import { runRepairCli } from '../adapters/crq/repairCli.js';
import { runPublishUnit } from '../adapters/crq/publishSource.js';
import {
  AUTHOR_DEADLINE_MS,
  runAuthorCapabilityMain,
} from '../adapters/crq/authorCapabilityMain.js';
import {
  REVIEW_DEADLINE_MS,
  runReviewCapabilityMain,
} from '../adapters/crq/reviewCapabilityMain.js';
import { runStatusWriter, runSummaryWriter } from '../adapters/crq/statusWriter.js';
import { runBackfillUnit } from '../adapters/crq/backfillSource.js';
import { pythonJsonText } from '../policy/crq/pythonJson.js';
import { runReconcileMergedUnit } from '../adapters/crq/reconcileSource.js';
import {
  type Capability,
  dispatchedRefusal,
  runCapabilityDispatcher,
} from '../adapters/crq/capabilityDispatcher.js';
import { MAX_REQUEST_BYTES, runQueueCapabilityMain } from '../adapters/crq/queueCapabilityMain.js';
import { REVIEW_MAX_BYTES } from '../ops/crq/reviewCapability.js';
import { AUTHOR_MAX_SNAPSHOT_BYTES } from '../policy/crq/authorWire.js';
import { run } from './runner.js';
import { planTick } from './tick.js';
import { runWatchdog } from './watchdog.js';

/** Read at most one wire frame plus the byte that proves it is over-long. */
async function readFrame(limit: number = MAX_REQUEST_BYTES + 1): Promise<Uint8Array> {
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
/** The three forced-command capabilities, shared by their direct routes and `dispatch`. */
const stdio = {
  env: (name: string) => process.env[name],
  stdout: (bytes: Uint8Array) => {
    process.stdout.write(bytes);
  },
  stderr: (message: string) => {
    process.stderr.write(`${message}\n`);
  },
};
const serveQueue = (
  argv: readonly string[],
  stderr: (message: string) => void = stdio.stderr,
): Promise<number> =>
  // The forced-command route: policy and identity come from the environment,
  // the request frame from stdin, and nothing else is accepted.
  runQueueCapabilityMain({
    ...stdio,
    stderr,
    argv,
    readStdin: readFrame,
    // The deadline must end the process, not just the race: a pending stdin
    // read or a held queue lock would otherwise outlive the refusal.
    terminate: () => process.exit(2),
    root,
  });
const serveReview = (
  argv: readonly string[],
  stderr: (message: string) => void = stdio.stderr,
): Promise<number> =>
  runReviewCapabilityMain({
    ...stdio,
    stderr,
    argv,
    readStdin: () => readFrame(REVIEW_MAX_BYTES + 1),
    terminate: (code = 2) => process.exit(code),
    root,
    deadlineMs: REVIEW_DEADLINE_MS,
  });
const serveAuthor = (
  argv: readonly string[],
  stderr: (message: string) => void = stdio.stderr,
): Promise<number> =>
  runAuthorCapabilityMain({
    ...stdio,
    stderr,
    argv,
    readStdin: () => readFrame(AUTHOR_MAX_SNAPSHOT_BYTES + 1),
    terminate: () => process.exit(2),
    root,
    deadlineMs: AUTHOR_DEADLINE_MS,
  });

/** Under `dispatch` every refusal line is the one the Python dispatcher prints. */
const rewritten = (capability: Capability) => (): void => {
  stdio.stderr(dispatchedRefusal(capability));
};

if (command === 'queue-capability') {
  process.exitCode = await serveQueue(rest);
} else if (command === 'review-capability') {
  process.exitCode = await serveReview(rest);
} else if (command === 'author-capability') {
  process.exitCode = await serveAuthor(rest);
} else if (command === 'dispatch') {
  // `capability_dispatcher.py`: the one SSH forced command. The request text
  // selects an exact capability and nothing else.
  process.exitCode = await runCapabilityDispatcher({
    argv: rest,
    env: stdio.env,
    stderr: stdio.stderr,
    handlers: {
      'author-v1': () => serveAuthor([], rewritten('author-v1')),
      'queue-v1': () => serveQueue([], rewritten('queue-v1')),
      'review-v1': () => serveReview([], rewritten('review-v1')),
    },
  });
} else if (command === 'repair') {
  // `crq_repair.py`'s CLI: it owns its argv and its one Python-shaped JSON
  // document. Admission (usage, the #1716 runner-disabled refusal, config and
  // selector refusals) is ported; the drain is not, so `repair` is not a live
  // unit command and crq-repair.service stays on Python.
  const result = await runRepairCli(rest, { root, stderr: stdio.stderr });
  process.stdout.write(result.stdout);
  process.exitCode = result.exitCode;
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
      if (liveCommand === 'backfill') {
        // The backfill route reads and writes the same state root the publisher
        // resolves (config.state_root, default `<runner>/state`).
        const roots = await readPublisherRoots(root);
        if (roots === null) {
          return {
            artifact: {
              status: 'failed' as const,
              error: 'runner config.json missing, malformed, or has no clone path',
            },
            exitCode: 3,
          };
        }
        return runBackfillUnit(args, {
          stateRoot: roots.stateRoot,
          cloneRoot: roots.cloneRoot,
          runnerRoot: root,
        });
      }
      if (liveCommand === 'reconcile-merged') {
        // Python's `reconcile-merged` takes the tick lock, reads the persisted
        // wrapper under `<state>/reconcile` and stages enrollment in queue.json.
        // The repository and the state root come from ONE config.json read: two
        // reads could pair repository A with a state root rewritten in between
        // (and the second read's default would hide an unreadable file).
        const targets = await readReconcileTargets(root);
        if (targets === null) {
          return {
            artifact: {
              status: 'failed' as const,
              error: 'runner config.json missing, malformed, or has no repo',
            },
            exitCode: 1,
          };
        }
        return runReconcileMergedUnit(args, {
          repo: targets.repo,
          stateRoot: targets.stateRoot,
        });
      }
      if (liveCommand === 'status' || liveCommand === 'summary') {
        const parsed = parseStatusArgv(args);
        if (!parsed.ok) return usageArtifact(liveCommand, parsed.message);
        // The queue-runner binary's stdout is exactly one JSON document for
        // every command; the operator-readable markdown travels in the
        // artifact's `value` field, not the stdout channel. The writer's
        // refusal text rides the same artifact (the `error` field), so this
        // route keeps stderr empty under doctrine I1.
        let statusText = '';
        let statusError = '';
        const writer = liveCommand === 'summary' ? runSummaryWriter : runStatusWriter;
        const exitCode = await writer(statusRoots(parsed.stateRoot), {
          write: (text) => {
            statusText = text;
          },
          error: (text) => {
            statusError = text;
          },
        });
        return {
          artifact:
            exitCode === 0
              ? {
                  status: 'ok' as const,
                  value:
                    liveCommand === 'summary' ? { path: statusText } : { markdown: statusText },
                }
              : {
                  status: 'failed' as const,
                  error: statusError.trimEnd() || `${liveCommand} write failed`,
                },
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
  const output =
    command === 'backfill'
      ? pythonJsonText(result.artifact, {
          asciiOnly: true,
          sortKeys: true,
          keyOrder: 'code-point',
          spacedSeparators: true,
        })
      : JSON.stringify(result.artifact);
  process.stdout.write(`${output}\n`);
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
 * The reconcile route's two targets from ONE config.json read: `crq.REPO` and
 * the state root the publisher would use. Returns null when the configuration
 * is unusable (missing, malformed or without a repo) instead of falling back to
 * a guessed state root, so the route can never pair repository A with a root
 * derived from a rewritten file, or with `<runner>/state` after a read failure.
 */
async function readReconcileTargets(
  runnerRoot: string,
): Promise<{ readonly repo: string; readonly stateRoot: string } | null> {
  let config: unknown;
  try {
    config = JSON.parse(await readFile(join(runnerRoot, 'config.json'), 'utf8'));
  } catch {
    return null;
  }
  if (typeof config !== 'object' || config === null || Array.isArray(config)) return null;
  const record = config as Record<string, unknown>;
  const repo = record['repo'];
  if (typeof repo !== 'string' || repo === '') return null;
  // Same derivation as {@link publisherStateRoot}/{@link readPublisherRoots},
  // including resolving a relative configured root against the runner root.
  const configuredStateRoot =
    typeof record['state_root'] === 'string' && record['state_root'] !== ''
      ? record['state_root']
      : join(runnerRoot, 'state');
  const stateRoot = isAbsolute(configuredStateRoot)
    ? configuredStateRoot
    : resolve(runnerRoot, configuredStateRoot);
  return { repo, stateRoot };
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
