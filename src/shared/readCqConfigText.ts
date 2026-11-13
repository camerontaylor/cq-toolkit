// The ONE read of a repository's cq.json with the absence/fault distinction:
// only ENOENT means "no config". Any other read fault (EACCES, EISDIR, EIO,
// …) is returned to the caller with the original error, so an op can refuse
// under its own fail-closed taxonomy instead of silently applying the
// default policy to a configured-but-unreadable checkout (#1190).
import { readFile as fsReadFile } from 'node:fs/promises';
import { join } from 'node:path';
import { messageOf } from './messageOf.js';

/** One cq.json read: absent (ENOENT only), present text, or a fault. */
export type CqConfigTextRead =
  | { outcome: 'absent' }
  | { outcome: 'text'; text: string }
  | { outcome: 'fault'; error: unknown };

/** The text-file reader cq.json reads go through (injectable for seams). */
export type ReadTextFile = (path: string) => Promise<string>;

/** The string errno `code` a caught fault carries, when it carries one. */
export function errnoOf(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null || !('code' in err)) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Read `<repoRoot>/cq.json`: `{ outcome: 'absent' }` on ENOENT (the only
 * absence), `{ outcome: 'text', text }` when present, and
 * `{ outcome: 'fault', error }` carrying the original error otherwise.
 */
export async function readCqConfigText(
  repoRoot: string,
  readFile: ReadTextFile = (path) => fsReadFile(path, 'utf8'),
): Promise<CqConfigTextRead> {
  try {
    return { outcome: 'text', text: await readFile(join(repoRoot, 'cq.json')) };
  } catch (err) {
    if (errnoOf(err) === 'ENOENT') return { outcome: 'absent' };
    return { outcome: 'fault', error: err };
  }
}

/** One-line refusal text for a cq.json read fault, naming the file and errno. */
export function cqConfigFaultText(err: unknown): string {
  const code = errnoOf(err);
  return `cq.json could not be read${code === undefined ? '' : ` (${code})`} — ${messageOf(err)}`;
}
