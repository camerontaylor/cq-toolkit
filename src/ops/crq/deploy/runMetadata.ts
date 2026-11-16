/**
 * The retained-run metadata sample the health observation reports, over
 * injected read-only filesystem seams.
 *
 * Ports `_newest`, `run_metadata_problem` and `run_metadata_sample` from
 * `apps/crq-python/ops/deploy-controller.py`. Inactive and unimported: nothing
 * here touches the filesystem; the caller supplies every read.
 */
import { JsonObject, parseJsonValue } from '../../../policy/crq/jsonValue.js';
import { OSError } from './errors.js';
export { OSError };

/** `RECEIPT_SAMPLE`: how many of the newest entries are sampled. */
export const RECEIPT_SAMPLE = 10;

/**
 * Artifacts `crq.launch()` writes before `meta.json`: a run directory holding
 * only these is a review that never launched, not lost metadata.
 */
export const PRELAUNCH_ARTIFACTS: ReadonlySet<string> = new Set([
  'secret-scan.json',
  'context-secret-scan.json',
]);

export interface DirEntry {
  readonly name: string;
  /** Python `entry.is_dir()` (follows symlinks, false on error). */
  readonly isDir: boolean;
}

export interface RunMetadataEffects {
  /** `Effects.state_dir()`. */
  stateDir(): string;
  /** `Path.is_dir()`. */
  isDir(path: string): Promise<boolean>;
  /** `Path.is_file()`. */
  isFile(path: string): Promise<boolean>;
  /** `Path.iterdir()` with `is_dir()` per entry; throws `OSError`. */
  listDir(path: string): Promise<readonly DirEntry[]>;
  /** `Path.stat().st_mtime_ns`; throws `OSError` when unstattable. */
  mtimeNs(path: string): Promise<bigint>;
  /** `Path.read_bytes()`; throws `OSError`. */
  readFile(path: string): Promise<Uint8Array>;
}

export interface UnreadableRun {
  readonly run: string;
  readonly reason: string;
}

export interface RunMetadataSample {
  readonly sampled: number;
  readonly readable: number;
  readonly prelaunch: number;
  readonly unreadable: readonly UnreadableRun[];
  readonly ignored_entries: number;
}

/** Python `str` ordering: by code point, not UTF-16 unit. */
function codePointCompare(left: string, right: string): number {
  const a = Array.from(left, (c) => c.codePointAt(0) ?? 0);
  const b = Array.from(right, (c) => c.codePointAt(0) ?? 0);
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return a.length - b.length;
}

/** Python `s[:n]`: the first `n` code points. */
function head(text: string, n: number): string {
  return Array.from(text).slice(0, n).join('');
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Python `_newest`: the `limit` most recently modified entries (ties by name),
 * so a sample taken after a switch covers what the new runner wrote. An
 * unstattable entry sorts as mtime -1: still sampleable, never preferred.
 */
export async function newest<T extends { readonly name: string; readonly path: string }>(
  entries: readonly T[],
  limit: number,
  mtimeNs: (path: string) => Promise<bigint>,
): Promise<T[]> {
  const keyed: { entry: T; mtime: bigint }[] = [];
  for (const entry of entries) {
    let mtime: bigint;
    try {
      mtime = await mtimeNs(entry.path);
    } catch (error) {
      if (!(error instanceof OSError)) throw error;
      mtime = -1n;
    }
    keyed.push({ entry, mtime });
  }
  keyed.sort((a, b) =>
    a.mtime === b.mtime ? codePointCompare(a.entry.name, b.entry.name) : a.mtime > b.mtime ? -1 : 1,
  );
  return keyed.slice(0, Math.max(0, limit)).map((k) => k.entry);
}

/** Python `json.loads(bytes.decode())`: a `ValueError` is any decode or parse failure. */
function loadJson(data: Uint8Array): ReturnType<typeof parseJsonValue> {
  // `ignoreBOM` keeps a leading BOM so the parser rejects it, as Python does.
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data);
  // Python accepts NaN/Infinity/-Infinity; the value is irrelevant here.
  return parseJsonValue(text, { parseConstant: () => null });
}

class NotJson extends Error {}

function parse(data: Uint8Array): ReturnType<typeof parseJsonValue> {
  try {
    return loadJson(data);
  } catch (error) {
    if (error instanceof OSError) throw error;
    throw new NotJson(messageOf(error));
  }
}

/**
 * Python `run_metadata_problem`: why a run directory's metadata is unusable;
 * `null` when `meta.json` parses; `"prelaunch"` for an expected pre-launch stop.
 */
export async function runMetadataProblem(
  entry: string,
  effects: Pick<RunMetadataEffects, 'isFile' | 'listDir' | 'readFile'>,
): Promise<string | null> {
  const metaPath = `${entry}/meta.json`;
  try {
    if (await effects.isFile(metaPath)) {
      parse(await effects.readFile(metaPath));
      return null;
    }
    const names = new Set((await effects.listDir(entry)).map((child) => child.name));
    if (names.size === 0) return 'missing meta.json: empty run directory';
    const sorted = [...names].sort(codePointCompare);
    if (sorted.every((n) => PRELAUNCH_ARTIFACTS.has(n)) && names.has('secret-scan.json')) {
      for (const name of sorted) {
        if (!(parse(await effects.readFile(`${entry}/${name}`)) instanceof JsonObject))
          return `corrupt pre-launch artifact: ${name}`;
      }
      return 'prelaunch';
    }
    return `missing meta.json alongside ${head(sorted.join(','), 120)}`;
  } catch (error) {
    if (error instanceof NotJson)
      // Python re-evaluates `meta.is_file()` while building this message.
      return `corrupt: unparseable ${(await effects.isFile(metaPath)) ? 'meta.json' : 'pre-launch artifact'}`;
    if (error instanceof OSError) return `unreadable: ${head(error.message, 80)}`;
    throw error;
  }
}

/**
 * Python `run_metadata_sample`: the newest run directories' metadata
 * (`state/runs`). Non-directory entries (e.g. AppleDouble `._*` copies) are
 * counted under `ignored_entries` and never sampled. `null` when there is no
 * `state/runs` directory.
 */
export async function runMetadataSample(
  effects: RunMetadataEffects,
): Promise<RunMetadataSample | null> {
  const runs = `${effects.stateDir()}/runs`;
  if (!(await effects.isDir(runs))) return null;
  const entries: { name: string; path: string }[] = [];
  let ignored = 0;
  for (const entry of await effects.listDir(runs)) {
    if (entry.isDir) entries.push({ name: entry.name, path: `${runs}/${entry.name}` });
    else ignored += 1;
  }
  let readable = 0;
  let prelaunch = 0;
  const unreadable: UnreadableRun[] = [];
  for (const entry of await newest(entries, RECEIPT_SAMPLE, effects.mtimeNs)) {
    const problem = await runMetadataProblem(entry.path, effects);
    if (problem === null) readable += 1;
    else if (problem === 'prelaunch') prelaunch += 1;
    else unreadable.push({ run: entry.name, reason: problem });
  }
  return {
    sampled: readable + prelaunch + unreadable.length,
    readable,
    prelaunch,
    unreadable,
    ignored_entries: ignored,
  };
}
