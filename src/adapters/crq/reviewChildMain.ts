/**
 * `crq.py _review <run_id>` (`crq.cmd_review_child`, `crq.py:2264`; argparse
 * `_review` at `crq.py:4115`, dispatch at `:4149`) for the TypeScript runner.
 *
 * INTERNAL: the detached child that `launch` spawns (`crq.py:2212`). It is not
 * a systemd unit command, so it is never in `LIVE_UNIT_COMMANDS`: only the
 * `launch` spawn and an operator rerun invoke it. The body is
 * {@link runReviewChild}, which requires an already detached session leader.
 *
 * Python reads `CONFIG["review_timeout_min"]` (a `KeyError` traceback, exit 1,
 * when absent) and `CONFIG.get("timeout_bin", "timeout")`. Argument errors are
 * argparse's exit 2; the usage text here is not argparse's byte for byte.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runReviewChild } from './reviewProcess.js';

export interface ReviewChildMainDeps {
  readonly argv: readonly string[];
  /** The runner root holding `config.json`. */
  readonly root: string;
  /** The state root holding `runs/<run_id>`. */
  readonly stateRoot: string;
  readonly env: NodeJS.ProcessEnv;
  readonly stderr: (message: string) => void;
  /** Test seam: the child body. */
  readonly child?: typeof runReviewChild;
}

async function readConfig(root: string): Promise<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(await readFile(join(root, 'config.json'), 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw new Error('runner config must be an object');
  return parsed as Record<string, unknown>;
}

export async function runReviewChildMain(deps: ReviewChildMainDeps): Promise<number> {
  const [runId, ...extra] = deps.argv;
  if (runId === undefined || runId === '' || extra.length > 0) {
    deps.stderr('usage: crq _review run_id');
    deps.stderr(
      runId === undefined || runId === ''
        ? 'crq _review: error: the following arguments are required: run_id'
        : `crq _review: error: unrecognized arguments: ${extra.join(' ')}`,
    );
    return 2;
  }
  let config: Record<string, unknown>;
  try {
    config = await readConfig(deps.root);
  } catch (error) {
    deps.stderr(`crq _review: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const minutes = config['review_timeout_min'];
  if (typeof minutes !== 'number' || !Number.isSafeInteger(minutes) || minutes <= 0) {
    deps.stderr('crq _review: config review_timeout_min must be a positive integer');
    return 1;
  }
  const timeoutBinary = config['timeout_bin'];
  if (timeoutBinary !== undefined && (typeof timeoutBinary !== 'string' || timeoutBinary === '')) {
    deps.stderr('crq _review: config timeout_bin must be a non-empty string');
    return 1;
  }
  try {
    return await (deps.child ?? runReviewChild)({
      stateRoot: deps.stateRoot,
      runId,
      timeoutMinutes: minutes,
      ...(timeoutBinary === undefined ? {} : { timeoutBinary }),
      env: deps.env,
    });
  } catch (error) {
    // Python would traceback (exit 1): the run keeps whatever artifacts exist.
    deps.stderr(`crq _review: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
