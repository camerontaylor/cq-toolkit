/**
 * Forced-command entry for the author-v1 capability (`author_transport.main`).
 *
 * Any failure is one opaque refusal on stderr with exit 2: host paths,
 * policy contents and scan diagnostics never cross the wire. A successful
 * response is the canonical sorted JSON decision.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { JsonObject } from '../../policy/crq/jsonValue.js';
import { parseJsonValue } from '../../policy/crq/jsonValue.js';
import { AUTHOR_MAX_SNAPSHOT_BYTES } from '../../policy/crq/authorWire.js';
import { runAuthorCapability } from '../../ops/crq/authorCapability.js';
import { createAuthorEffects } from './authorEffects.js';
import { GitPool } from './gitExec.js';

export const AUTHOR_CAPABILITY = 'author-v1';
export const AUTHOR_DEADLINE_MS = 30_000;

export interface AuthorCapabilityMainDeps {
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

const REFUSAL = 'author capability refused; no permission';

export async function runAuthorCapabilityMain(deps: AuthorCapabilityMainDeps): Promise<number> {
  const pool = deps.pool ?? new GitPool();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  const work = async (): Promise<number> => {
    if (deps.argv.length !== 0) return refuse(deps);
    const command = deps.env('SSH_ORIGINAL_COMMAND');
    if (command !== undefined && command !== AUTHOR_CAPABILITY) return refuse(deps);
    const policyPath = deps.env('CRQ_AUTHOR_REVIEW_POLICY') ?? '';
    const reviewer = deps.env('CRQ_AUTHOR_FALLBACK_REVIEWER') ?? '';
    const approvedTarget = deps.env('CRQ_AUTHOR_TARGET') ?? '';
    const raw = await deps.readStdin();
    if (raw.length > AUTHOR_MAX_SNAPSHOT_BYTES) return refuse(deps);
    const config = await runnerConfig(deps.root);
    const bundle = createAuthorEffects({
      root: deps.root,
      config,
      pool,
      ...(deps.now === undefined ? {} : { now: deps.now }),
    });
    const response = await runAuthorCapability(
      { raw, policyPath, reviewer, approvedTarget },
      bundle.effects,
    );
    if (expired) return 2;
    deps.stdout(response);
    return 0;
  };
  const deadline = new Promise<number>((resolve) => {
    timer = setTimeout(() => {
      expired = true;
      resolve(refuse(deps));
    }, deps.deadlineMs ?? AUTHOR_DEADLINE_MS);
    timer.unref?.();
  });
  try {
    const code = await Promise.race([work().catch(() => refuse(deps)), deadline]);
    if (expired) {
      pool.killAll();
      deps.terminate();
    }
    return code;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function runnerConfig(root: string): Promise<JsonObject> {
  const parsed = parseJsonValue(await readFile(join(root, 'config.json'), 'utf8'), {
    duplicates: 'error',
  });
  if (!(parsed instanceof JsonObject)) throw new Error('invalid runner config');
  return parsed;
}

function refuse(deps: AuthorCapabilityMainDeps): number {
  deps.stderr(REFUSAL);
  return 2;
}
