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

/**
 * Python reads queue.json, config.json and events.jsonl as locale-default text
 * (UTF-8 here), so an invalid byte raises `UnicodeDecodeError` instead of
 * becoming U+FFFD. `readFile(path, 'utf8')` would replacement-decode and let
 * the route publish a plausible summary from corrupt state. `ignoreBOM` keeps
 * a leading BOM in the text, as Python's `Path.read_text()` does; the JSON
 * parser then rejects it instead of silently stripping it.
 */
async function readTextStrict(path: string): Promise<string> {
  const bytes = await readFile(path);
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (error) {
    throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Bind the read-only route to one runner root and one state root. */
export function fileReadOnlyStatusEffects(
  roots: StatusStateRoots,
  now: () => number = () => Date.now() / 1000,
): ReadOnlyStatusEffects {
  return {
    readQueue: () => readTextStrict(join(roots.stateRoot, 'queue.json')),
    readConfig: () => readTextStrict(join(roots.runnerRoot, 'config.json')),
    readEvents: () => readTextStrict(join(roots.stateRoot, 'events.jsonl')),
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
