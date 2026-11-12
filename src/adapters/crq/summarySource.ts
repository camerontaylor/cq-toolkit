/**
 * Filesystem and process binding for the A1 summary publish route.
 *
 * This is the adapter layer: it may read files, observe mtimes and run the
 * `systemctl`/`gh` probes, but the ops route and the composer it feeds never
 * do. Every path is supplied explicitly by the caller; no environment
 * variable and no working-directory default is consulted here, so a test or a
 * future `crq` subcommand controls the roots (the caller resolves
 * `XDG_STATE_HOME`/`~` itself and passes the result).
 *
 * Python contracts mirrored exactly:
 *
 * - The previous summary read is strict UTF-8; an invalid byte raises (the
 *   producer's `UnicodeDecodeError`-shaped ValueError the cache voids),
 *   never a replacement-decoded plausible document. An absent file is
 *   `null`, not an error (`OSError` -> cache voided).
 * - The repair inbox is `state/repair/inbox/*.json`; each entry carries the
 *   exact job bytes and `st_mtime` seconds, with result bytes/existence and
 *   progress existence read on demand through the stem. An unreadable
 *   existing file raises here, the way Python's `read_text()` would.
 * - Triage rows are `state/backfill/findings/triage/*.json` in sorted
 *   filename order; the row bytes are the digest's input.
 * - `systemctl --user show --timestamp=unix --property=…` output with the
 *   realtime/monotonic pair captured at the same moment; any spawn, exit or
 *   timeout failure becomes `{error: "systemctl user show unavailable"}`.
 * - `gh api repos/<repo>/pulls/<pr> --jq .title` resolves the exact stdout
 *   or null on failure; the composer trims and swallows per row.
 * - Receipt bytes are read by validated id (`[0-9a-f]{64}`), null when the
 *   file is absent; an id-validated read is a trust boundary, so any other
 *   failure also reads as unavailable rather than leaking a path error.
 */
import { execFile } from 'node:child_process';
import { access, mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { RepairInboxEntry, RepairInboxState } from '../../policy/crq/publishEffects.js';
import {
  publishSummary,
  summaryTargetPath,
  type SummaryPublishEffects,
  type SummaryPublishResult,
} from '../../policy/crq/summaryPublish.js';
import { atomicWrite } from './atomic.js';

export interface SummaryStateRoots {
  /** The state directory: `queue.json`, `repair/`, `backfill/`, receipts. */
  readonly stateRoot: string;
  /** `XDG_STATE_HOME` resolved by the caller; '' selects the home fallback. */
  readonly xdgStateHome: string;
  /** The user's home directory, for the `~/.local/state` fallback. */
  readonly home: string;
}

/**
 * One child process, never rejecting. `argv` is fully supplied by this
 * adapter; `timeoutSeconds` mirrors Python's `command(argv, timeout)`.
 * Resolve the captured stdout on exit 0; resolve null on spawn failure,
 * non-zero exit or timeout — the failure classes the producer's
 * `except (OSError, RuntimeError, subprocess.TimeoutExpired)` clauses catch.
 */
export type RunCommand = (
  argv: readonly string[],
  timeoutSeconds: number,
) => Promise<string | null>;

/** Captured child output can be large; never truncate. */
const MAX_BUFFER = 8 * 1024 * 1024;

function runChild(argv: readonly string[], timeoutSeconds: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      argv[0] as string,
      [...argv.slice(1)],
      {
        encoding: 'utf8',
        maxBuffer: MAX_BUFFER,
        timeout: timeoutSeconds * 1000,
        killSignal: 'SIGKILL',
      },
      (error, stdout) => {
        resolve(error === null || error === undefined ? stdout : null);
      },
    );
  });
}

/** The default command port over real child processes. */
export const realRunCommand: RunCommand = runChild;

/** One strict-UTF-8 text read; raises on invalid bytes, never replaces them. */
async function readTextStrict(path: string): Promise<string> {
  const bytes = await readFile(path);
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
}

/** The previous summary's exact text; null when absent, raise on bad bytes. */
async function readPreviousText(path: string): Promise<string | null> {
  try {
    return await readTextStrict(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function readOptionalBytes(path: string): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(await readFile(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * `repair_tick.digest`'s inbox seam over real files: one entry per
 * `inbox/*.json` in sorted filename order (the digest is order-independent),
 * the job's exact bytes and `st_mtime` seconds, and result/progress state
 * through the stem. A job unreadable at scan time raises here, exactly where
 * Python's `read_text()` would raise inside the digest.
 */
export async function fileRepairInboxState(stateRoot: string): Promise<RepairInboxState> {
  const inboxDir = join(stateRoot, 'repair', 'inbox');
  let names: readonly string[];
  try {
    names = await readdir(inboxDir);
  } catch (error) {
    // An absent inbox is an empty glob yield, not an error.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        entries: [],
        readResult: () => null,
        hasResult: () => false,
        hasProgress: () => false,
      };
    }
    throw error;
  }
  const entries: RepairInboxEntry[] = [];
  for (const name of names.filter((candidate) => candidate.endsWith('.json')).sort()) {
    const path = join(inboxDir, name);
    const bytes = await readFile(path);
    const info = await stat(path);
    entries.push({
      stem: name.slice(0, -'.json'.length),
      jobBytes: new Uint8Array(bytes),
      // `Path.stat().st_mtime` seconds; `mtimeMs` keeps sub-second precision.
      mtime: info.mtimeMs / 1000,
    });
  }
  const jobDir = (stem: string): string => join(stateRoot, 'repair', stem);
  // The digest seams are synchronous: result bytes and existence are read
  // eagerly per entry (Python reads them inline inside the same loop), so
  // the adapter captures them up front instead of promising later I/O.
  const results = new Map<string, Uint8Array | null>();
  const progress = new Set<string>();
  for (const entry of entries) {
    results.set(entry.stem, await readOptionalBytes(join(jobDir(entry.stem), 'result.json')));
    if (await fileExists(join(jobDir(entry.stem), 'progress.json'))) progress.add(entry.stem);
  }
  return {
    entries,
    readResult: (stem: string) => results.get(stem) ?? null,
    hasResult: (stem: string) => results.get(stem) !== undefined && results.get(stem) !== null,
    hasProgress: (stem: string) => progress.has(stem),
  };
}

/** The sorted `triage/*.json` rows as exact bytes; absent dir yields none. */
export async function fileTriageRows(
  stateRoot: string,
): Promise<readonly { readonly name: string; readonly bytes: Uint8Array }[]> {
  const triageDir = join(stateRoot, 'backfill', 'findings', 'triage');
  let names: readonly string[];
  try {
    names = await readdir(triageDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const rows: { name: string; bytes: Uint8Array }[] = [];
  for (const name of names.filter((candidate) => candidate.endsWith('.json')).sort()) {
    rows.push({ name, bytes: new Uint8Array(await readFile(join(triageDir, name))) });
  }
  return rows;
}

/** Receipt ids are validated before any read; a mismatched id reads as absent. */
const RECEIPT_ID = /^[0-9a-f]{64}$/;

/**
 * Assemble every composer seam from one state root, one command port and
 * the queue whose pending rows drive the gh lookups.
 *
 * All reads happen at assembly time; the returned effects hold captured
 * values so the composer still sees one immutable snapshot. The gh port is
 * synchronous in the composer (Python runs it inline in the enrich loop),
 * so the adapter pre-resolves every pending row's query here: each query
 * runs once, and the seam serves the captured stdout (null on failure).
 */
export async function summaryStateEffects(
  roots: SummaryStateRoots,
  runCommand: RunCommand,
  pendingPulls: readonly { readonly repo: unknown; readonly pr: unknown }[] = [],
  now: () => number = () => Date.now() / 1000,
): Promise<SummaryPublishEffects> {
  const previousBytes = await readPreviousSummaryBytes(roots);
  const ghTitles = new Map<string, string | null>();
  await Promise.all(
    pendingPulls.map(async (row) => {
      const repo = row.repo;
      const pr = row.pr;
      if (typeof repo !== 'string' || repo === '') return;
      if (typeof pr !== 'number' || !Number.isInteger(pr) || pr <= 0) return;
      const query = `repos/${repo}/pulls/${pr}`;
      if (ghTitles.has(query)) return;
      ghTitles.set(query, await runCommand(['gh', 'api', query, '--jq', '.title'], 3));
    }),
  );
  const [inbox, triageRows, probe, receipts] = await Promise.all([
    fileRepairInboxState(roots.stateRoot),
    fileTriageRows(roots.stateRoot),
    probeSystemd(runCommand),
    preloadReceipts(roots.stateRoot),
  ]);
  return {
    root: roots.stateRoot,
    xdgStateHome: roots.xdgStateHome,
    now: now(),
    previousBytes,
    inbox,
    triageRows,
    systemd: probe.probe,
    systemdClock: probe.clock,
    ghTitle: (repo: string, pr: number): string | null => {
      const query = `repos/${repo}/pulls/${pr}`;
      if (!ghTitles.has(query)) {
        throw new Error(`summary adapter: gh result not preloaded for ${query}`);
      }
      return ghTitles.get(query) ?? null;
    },
    readReceipt: (receiptId: string): Uint8Array | null => receipts.get(receiptId) ?? null,
  };
}

/**
 * Receipt bytes by id, pre-loaded like the status route: the composer reads
 * them repeatedly, and one snapshot keeps the digest consistent. Only valid
 * ids are ever consulted; a mismatched id is a trust-boundary refusal that
 * reads as absent, never a path error.
 */
async function preloadReceipts(stateRoot: string): Promise<ReadonlyMap<string, Uint8Array | null>> {
  const receiptsDir = join(stateRoot, 'receipts');
  const cache = new Map<string, Uint8Array | null>();
  let names: readonly string[];
  try {
    names = await readdir(receiptsDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return cache;
    throw error;
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -'.json'.length);
    if (!RECEIPT_ID.test(id)) continue;
    cache.set(id, await readOptionalBytes(join(receiptsDir, name)));
  }
  return cache;
}

/** The `systemctl` probe plus the clock pair captured with it. */
async function probeSystemd(runCommand: RunCommand): Promise<{
  probe: { error?: string; output?: string };
  clock: { realtime: number; monotonic: number };
}> {
  const output = await runCommand(
    [
      'systemctl',
      '--user',
      'show',
      '--timestamp=unix',
      '--property=Id,LoadState,ActiveState,LastTriggerUSec,NextElapseUSecRealtime,NextElapseUSecMonotonic',
      'crq-tick.timer',
      'crq-watchdog.timer',
      'crq-slot.timer',
      'crq-backfill.timer',
      'crq-repair.timer',
    ],
    5,
  );
  if (output === null) {
    return {
      probe: { error: 'systemctl user show unavailable' },
      clock: { realtime: 0, monotonic: 0 },
    };
  }
  // Python reads `time.time()` and CLOCK_MONOTONIC right after the probe.
  return { probe: { output }, clock: { realtime: Date.now() / 1000, monotonic: 0 } };
}

export async function readPreviousSummaryBytes(
  roots: SummaryStateRoots,
): Promise<Uint8Array | null> {
  const text = await readPreviousText(summaryTargetPath(roots.xdgStateHome, roots.home));
  return text === null ? null : new TextEncoder().encode(text);
}

/** The exact XDG target path for one caller-resolved root pair. */
export function summaryPublishTarget(roots: SummaryStateRoots): string {
  return summaryTargetPath(roots.xdgStateHome, roots.home);
}

export interface PublishSummaryOutcome {
  /** The composer's result: document, exact bytes, compact text. */
  readonly result: SummaryPublishResult;
  /** The path the bytes now live at (or the attempt failed on). */
  readonly target: string;
}

/**
 * The A1 publish route: compose the summary from real state, then write the
 * exact bytes atomically to the XDG target.
 *
 * Python's write is `mkstemp(prefix=".summary-")` -> dump+newline -> fsync
 * -> `os.replace` -> finally-unlink. `atomicWrite` gives the same durable
 * swap (unique temp, fsync, rename, dir fsync, cleanup), so a failure before
 * the rename leaves the prior summary intact and no temp path ever leaks.
 * The target directory is created first, like Python's
 * `target.parent.mkdir(parents=True, exist_ok=True)`.
 */
export async function publishSummaryAtomically(
  core: Parameters<typeof publishSummary>[0],
  queue: Parameters<typeof publishSummary>[1],
  config: Parameters<typeof publishSummary>[2],
  scheduleProbe: Parameters<typeof publishSummary>[3],
  effects: SummaryPublishEffects,
  home: string,
): Promise<PublishSummaryOutcome> {
  const target = summaryTargetPath(effects.xdgStateHome, home);
  const result = publishSummary(core, queue, config, scheduleProbe, effects);
  await mkdir(dirname(target), { recursive: true });
  await atomicWrite(target, result.bytes);
  return { result, target };
}
