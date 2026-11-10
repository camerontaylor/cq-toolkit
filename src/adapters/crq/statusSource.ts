/**
 * Filesystem and stdio binding for the A1 read-only status route.
 *
 * This is the adapter layer: it may read files and the clock, but the ops
 * route it feeds never does. Every path is supplied explicitly by the caller;
 * no environment variable and no working-directory default is consulted, so a
 * test or a future `crq` subcommand controls the roots.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  runReadOnlyStatus,
  type CommandResult,
  type ReadOnlyStatusEffects,
} from '../../ops/crq/readOnlyStatus.js';

export interface StatusStateRoots {
  /** The runner checkout: `config.json` lives here. */
  readonly runnerRoot: string;
  /** The state directory: `queue.json`, `events.jsonl` and `receipts/` live here. */
  readonly stateRoot: string;
}

export interface StatusCliIo {
  write(text: string): void;
  error(text: string): void;
}

/** Bind the read-only route to one runner root and one state root. */
export function fileReadOnlyStatusEffects(
  roots: StatusStateRoots,
  now: () => number = () => Date.now() / 1000,
): ReadOnlyStatusEffects {
  return {
    readQueue: () => readFile(join(roots.stateRoot, 'queue.json'), 'utf8'),
    readConfig: () => readFile(join(roots.runnerRoot, 'config.json'), 'utf8'),
    readEvents: () => readFile(join(roots.stateRoot, 'events.jsonl'), 'utf8'),
    async readReceipt(receiptId: string): Promise<Uint8Array | null> {
      // `merged_current` validates the id before asking, but a reader is a
      // trust boundary: an unexpected id becomes "unavailable", never a path.
      if (!/^[0-9a-f]{64}$/.test(receiptId)) return null;
      try {
        return new Uint8Array(
          await readFile(join(roots.stateRoot, 'receipts', `${receiptId}.json`)),
        );
      } catch {
        return null;
      }
    },
    now,
  };
}

/**
 * The CLI seam: run the route and write its streams through the supplied io.
 * Returns the same exit code the route chose.
 */
export async function runStatusCli(
  argv: readonly string[],
  roots: StatusStateRoots,
  io: StatusCliIo,
  now?: () => number,
): Promise<number> {
  const result: CommandResult = await runReadOnlyStatus(
    argv,
    fileReadOnlyStatusEffects(roots, now),
  );
  if (result.stdout !== '') io.write(result.stdout);
  if (result.stderr !== '') io.error(result.stderr);
  return result.exitCode;
}
