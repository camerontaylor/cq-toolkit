/**
 * Forced-command entry for the review-v1 capability (`review_transport.main`).
 *
 * The frame is read bounded before any state is opened, served under the
 * operator deadline, and answered on stdout. A write whose outcome is unknown
 * is the typed retryable `unavailable` response, never a refusal that could be
 * mistaken for "nothing happened". Every other failure is the same opaque
 * stderr line with exit 2.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { JsonObject } from '../../policy/crq/jsonValue.js';
import { parseJsonValue } from '../../policy/crq/jsonValue.js';
import { runReviewCapability, safeHandle } from '../../ops/crq/reviewCapability.js';
import { createReviewEffects } from './reviewEffects.js';
import { GitPool } from './gitExec.js';

export const REVIEW_CAPABILITY = 'review-v1';
export const REVIEW_DEADLINE_MS = 120_000;

export interface ReviewCapabilityMainDeps {
  readonly argv: readonly string[];
  readonly env: (name: string) => string | undefined;
  readonly readStdin: () => Promise<Uint8Array>;
  readonly stdout: (bytes: Uint8Array) => void;
  readonly stderr: (message: string) => void;
  readonly terminate: () => void;
  readonly root: string;
  readonly deadlineMs?: number;
  readonly now?: () => Date;
  readonly pool?: GitPool;
}

const REFUSAL = 'review capability refused; no permission';

function envRequired(deps: ReviewCapabilityMainDeps, name: string): string {
  const value = deps.env(name);
  if (value === undefined || value.length === 0) throw new Error(`missing ${name}`);
  return value;
}

async function runnerConfig(root: string): Promise<JsonObject> {
  const parsed = parseJsonValue(await readFile(join(root, 'config.json'), 'utf8'), {
    duplicates: 'error',
  });
  if (!(parsed instanceof JsonObject)) throw new Error('invalid runner config');
  return parsed;
}

export async function runReviewCapabilityMain(deps: ReviewCapabilityMainDeps): Promise<number> {
  const pool = deps.pool ?? new GitPool();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  const terminate = (): void => {
    pool.killAll();
    deps.terminate();
  };
  const work = async (): Promise<number> => {
    if (deps.argv.length !== 0) return refuse(deps);
    const command = deps.env('SSH_ORIGINAL_COMMAND');
    if (command !== undefined && command !== REVIEW_CAPABILITY) return refuse(deps);
    const policyPath = envRequired(deps, 'CRQ_QUEUE_POLICY');
    const principal = envRequired(deps, 'CRQ_QUEUE_PRINCIPAL');
    const raw = await deps.readStdin();
    const config = await runnerConfig(deps.root);
    const repo = config.get('repo');
    if (typeof repo !== 'string' || repo.length === 0) throw new Error('invalid runner config');
    const policy = parseJsonValue(await readFile(policyPath, 'utf8'), { duplicates: 'error' });
    const effects = createReviewEffects({
      root: deps.root,
      repo,
      config,
      pool,
      ...(deps.now === undefined ? {} : { now: deps.now }),
    }).effects;
    let response: Uint8Array;
    try {
      response = await runReviewCapability({ raw, principal, policy }, effects);
    } catch (error) {
      try {
        response = safeHandle(error);
      } catch {
        return refuse(deps);
      }
    }
    if (expired) return 2;
    deps.stdout(response);
    return 0;
  };
  const deadline = new Promise<number>((resolve) => {
    timer = setTimeout(() => {
      expired = true;
      resolve(refuse(deps));
    }, deps.deadlineMs ?? REVIEW_DEADLINE_MS);
    timer.unref?.();
  });
  try {
    const code = await Promise.race([work().catch(() => refuse(deps)), deadline]);
    if (expired) terminate();
    return code;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function refuse(deps: ReviewCapabilityMainDeps): number {
  deps.stderr(REFUSAL);
  return 2;
}
