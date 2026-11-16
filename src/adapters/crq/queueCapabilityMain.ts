/**
 * Forced-command entry for the queue-v1 capability (`capability_dispatcher.py`).
 *
 * The operator owns identity and policy through the environment; SSH request
 * text may only select an exact allowlisted capability. Nothing here reads a
 * command, a path or a principal from the request frame.
 *
 * The frame is read bounded, served under a wall-clock deadline, and answered on
 * stdout. Any refusal is the same opaque stderr line with exit 2, so a caller
 * cannot distinguish "denied" from "malformed".
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { GhFn } from '../forge-github/gh.js';
import { JsonObject, parseJsonValue } from '../../policy/crq/jsonValue.js';
import { QUEUE_WIRE_BYTES } from '../../policy/crq/queueWire.js';
import { runQueueCapability } from '../../ops/crq/queueCapability.js';
import { createQueueEffects, queueEffectPaths } from './queueEffects.js';

/** The only capability this entrypoint serves. */
export const QUEUE_CAPABILITY = 'queue-v1';
/** `queue_transport.MAX_BYTES`: the largest accepted request frame. */
export const MAX_REQUEST_BYTES = QUEUE_WIRE_BYTES;
/** `queue_main`'s `signal.alarm(30)`. */
export const QUEUE_DEADLINE_MS = 30_000;

export interface QueueCapabilityMainDeps {
  /** Arguments after the command name; any extra argument is a refusal. */
  readonly argv: readonly string[];
  readonly env: (name: string) => string | undefined;
  /** Reads at most `MAX_REQUEST_BYTES + 1` bytes from the caller's frame. */
  readonly readStdin: () => Promise<Uint8Array>;
  readonly stdout: (bytes: Uint8Array) => void;
  readonly stderr: (message: string) => void;
  /**
   * Ends the process when the deadline wins. A refusal must also STOP the
   * pending work: stdin may still be open and an effect may still be holding a
   * lock, so without a hard exit a late success could be written after the
   * refusal (or the process could outlive the bound entirely).
   */
  readonly terminate: () => void;
  /** The runner root holding `config.json`, `state/` and `runs/`. */
  readonly root: string;
  readonly deadlineMs?: number;
  readonly now?: () => Date;
  readonly gh?: GhFn;
}

const REFUSAL = 'queue capability refused; no permission';

function envRequired(deps: QueueCapabilityMainDeps, name: string): string {
  const value = deps.env(name);
  if (value === undefined || value.length === 0) throw new Error(`missing ${name}`);
  return value;
}

/** `crq.REPO` and `CONFIG.queue.project_fixed` for the runner being served. */
async function runnerConfig(root: string): Promise<{ repo: string; projectFixed: boolean }> {
  const parsed = parseJsonValue(await readFile(join(root, 'config.json'), 'utf8'), {
    duplicates: 'error',
  });
  if (!(parsed instanceof JsonObject)) throw new Error('invalid runner config');
  const repo = parsed.get('repo');
  if (typeof repo !== 'string' || repo.length === 0) throw new Error('invalid runner config');
  const queue = parsed.get('queue');
  const projectFixed = queue instanceof JsonObject && queue.get('project_fixed') === true;
  return { repo, projectFixed };
}

/**
 * Serve one forced-command invocation and return the process exit code.
 *
 * `0` writes the canonical response to stdout; `2` is the single opaque refusal.
 */
export async function runQueueCapabilityMain(deps: QueueCapabilityMainDeps): Promise<number> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  const work = async (): Promise<number> => {
    // `len(sys.argv) != 1`: the forced command carries no arguments.
    if (deps.argv.length !== 0) return refuse(deps);
    const command = deps.env('SSH_ORIGINAL_COMMAND');
    if (command !== undefined && command !== QUEUE_CAPABILITY) return refuse(deps);
    const policyPath = envRequired(deps, 'CRQ_QUEUE_POLICY');
    const principal = envRequired(deps, 'CRQ_QUEUE_PRINCIPAL');
    const config = await runnerConfig(deps.root);
    const raw = await deps.readStdin();
    const policy = parseJsonValue(await readFile(policyPath, 'utf8'), { duplicates: 'error' });
    const response = await runQueueCapability(
      { raw, principal, policy, runnerRepo: config.repo },
      createQueueEffects({
        repo: config.repo,
        ...queueEffectPaths(deps.root),
        projectFixed: config.projectFixed,
        ...(deps.gh === undefined ? {} : { gh: deps.gh }),
        ...(deps.now === undefined ? {} : { now: deps.now }),
      }),
    );
    // The deadline may have won while the effects ran; the refusal stands.
    if (expired) return 2;
    deps.stdout(response);
    return 0;
  };
  const deadline = new Promise<number>((resolve) => {
    timer = setTimeout(() => {
      expired = true;
      resolve(refuse(deps));
    }, deps.deadlineMs ?? QUEUE_DEADLINE_MS);
    timer.unref?.();
  });
  try {
    const code = await Promise.race([work().catch(() => refuse(deps)), deadline]);
    if (expired) deps.terminate();
    return code;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function refuse(deps: QueueCapabilityMainDeps): number {
  deps.stderr(REFUSAL);
  return 2;
}
