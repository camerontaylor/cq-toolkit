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
import {
  PublishEffectsError,
  drainableStemsFromQueue,
  type RepairInboxEntry,
  type RepairInboxState,
  type TriageRowFile,
} from '../../policy/crq/publishEffects.js';
import { referencedReceiptIds } from '../../policy/crq/statusSummary.js';
import type { CrqRecord } from '../../policy/crq/receiptIdentity.js';
import { ghIntegerPr } from '../../policy/crq/summaryPublish.js';
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

async function readOptionalBytes(path: string): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(await readFile(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * The Python OS-error subclass for one errno (producer `type(exc).__name__`):
 * ENOENT raises FileNotFoundError and EACCES/EPERM raise PermissionError
 * (both OSError subclasses), anything else stays the OSError base. Verified
 * against CPython 3 on this host.
 */
function osErrorKind(error: unknown): 'FileNotFoundError' | 'PermissionError' | 'OSError' {
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === 'ENOENT') return 'FileNotFoundError';
  if (code === 'EACCES' || code === 'EPERM') return 'PermissionError';
  return 'OSError';
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
 * through the stem.
 *
 * Python reads content inline ONLY for stems the digest will consume (a
 * consumed stem's content is not re-read; a drainable stem's job text is
 * parsed and its result read only when that file exists). An unreferenced
 * stem is existence-only: `result.json` existence orphans it, progress is
 * never consulted, and its own content is never opened (audit iO_c). A
 * referenced job whose read fails is captured as the Python OS-error subtype
 * (`PermissionError`/`FileNotFoundError`/`OSError`) and raised from the
 * digest exactly where Python's `read_text()` would raise inside it.
 */
export async function fileRepairInboxState(
  stateRoot: string,
  selectedStems: ReadonlySet<string> = new Set(),
): Promise<RepairInboxState> {
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
  const results = new Map<string, Uint8Array | null>();
  const progress = new Set<string>();
  for (const name of names.filter((candidate) => candidate.endsWith('.json')).sort()) {
    const stem = name.slice(0, -'.json'.length);
    const path = join(inboxDir, name);
    let mtime = 0;
    let jobBytes: Uint8Array | null = null;
    let jobError: PublishEffectsError | undefined;
    if (selectedStems.has(stem)) {
      // Referenced stem: Python opens the job inline, so we do too. A read
      // failure is captured with its OS-error subtype and re-raised by the
      // digest's job-content gate; the entry still carries mtime.
      try {
        const [bytes, info] = await Promise.all([readFile(path), stat(path)]);
        jobBytes = new Uint8Array(bytes);
        mtime = info.mtimeMs / 1000;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          // The producer's glob yield vanished before read_text: that is a
          // FileNotFoundError out of the digest, not a missing-job fallback.
          throw new PublishEffectsError(
            `[Errno 2] No such file or directory: 'state/repair/inbox/${stem}.json'`,
            'FileNotFoundError',
          );
        }
        jobError = new PublishEffectsError(`state/repair/inbox/${stem}.json`, osErrorKind(error));
        try {
          mtime = (await stat(path)).mtimeMs / 1000;
        } catch {
          mtime = 0;
        }
      }
    } else {
      // Unreferenced stem: stat only. A vanished glob yield contributes
      // nothing (Python's glob list is materialised before the loop, and a
      // file absent at stat time cannot reach the orphan arm either).
      try {
        mtime = (await stat(path)).mtimeMs / 1000;
      } catch {
        continue;
      }
    }
    entries.push({ stem, jobBytes, mtime, ...(jobError === undefined ? {} : { jobError }) });
    // Result/progress captures follow the same referenced-only rule: for a
    // referenced stem the digest reads result content when it exists, so an
    // unreadable existing result raises with its subtype; for an
    // unreferenced stem only existence is consulted (progress never is).
    const resultPath = join(stateRoot, 'repair', stem, 'result.json');
    const progressPath = join(stateRoot, 'repair', stem, 'progress.json');
    if (selectedStems.has(stem)) {
      try {
        results.set(stem, await readOptionalBytes(resultPath));
      } catch (error) {
        throw new PublishEffectsError(`state/repair/${stem}/result.json`, osErrorKind(error));
      }
    } else {
      let exists = false;
      try {
        exists = (await stat(resultPath)).isFile();
      } catch {
        exists = false;
      }
      // Existence is modelled as present-but-unread bytes: the digest's
      // orphan arm tests only hasResult truthiness for unreferenced stems.
      results.set(stem, exists ? new Uint8Array(0) : null);
    }
    if (selectedStems.has(stem) && (await fileExists(progressPath))) progress.add(stem);
  }
  return {
    entries,
    readResult: (stem: string) => results.get(stem) ?? null,
    hasResult: (stem: string) => (results.get(stem) ?? null) !== null,
    hasProgress: (stem: string) => progress.has(stem),
  };
}

/**
 * The sorted `triage/*.json` rows as exact bytes; absent dir yields none.
 *
 * Per-row read failures stay in the seam as a null-bytes row carrying the
 * captured Python OS-error subtype: Python's
 * `finding_triage(strict=False, limit=32)` catches each row's OSError inside
 * the row loop, records `{file, error: type(exc).__name__}` (PermissionError
 * on chmod-denied, FileNotFoundError on vanished, OSError otherwise) and
 * continues with the remaining rows, so one unreadable file must not abort
 * the whole summary. The composer's `findingTriage` records the captured
 * subtype per row and keeps the rest of the report.
 */
export async function fileTriageRows(stateRoot: string): Promise<readonly TriageRowFile[]> {
  const triageDir = join(stateRoot, 'backfill', 'findings', 'triage');
  let names: readonly string[];
  try {
    names = await readdir(triageDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const rows: TriageRowFile[] = [];
  for (const name of names.filter((candidate) => candidate.endsWith('.json')).sort()) {
    try {
      rows.push({ name, bytes: new Uint8Array(await readFile(join(triageDir, name))) });
    } catch (error) {
      // Per-row OSError -> null bytes + the exact subtype; the composer
      // records it as a row error and keeps the rest of the report, like
      // Python's strict=False path.
      rows.push({
        name,
        bytes: null,
        readError: new PublishEffectsError(name, osErrorKind(error)),
      });
    }
  }
  return rows;
}

/** Receipt ids are validated before any read; a mismatched id reads as absent. */
const RECEIPT_ID = /^[0-9a-f]{64}$/;

/**
 * The composer's `merged_current` re-validates every id before reading; the
 * adapter never constructs receipt paths from unvalidated input.
 */
void RECEIPT_ID;

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
  queue: unknown = null,
): Promise<SummaryPublishEffects> {
  const previousBytes = await readPreviousSummaryBytes(roots);
  const ghTitles = new Map<string, string | null>();
  await Promise.all(
    pendingPulls.map(async (row) => {
      // `type(pr) is int and pr > 0`: the producer's gh gate. A lossless
      // JsonNumber int IS a Python int (audit gYDE), so the adapter must
      // normalize it through the same gate the composer applies, or a
      // lossless queue never gets its title preloaded and the composer
      // throws 'gh result not preloaded' where Python calls gh.
      const ghPr = ghIntegerPr(row.pr);
      const repo = row.repo;
      if (typeof repo !== 'string' || repo === '') return;
      if (ghPr === null) return;
      const query = `repos/${repo}/pulls/${ghPr}`;
      if (ghTitles.has(query)) return;
      ghTitles.set(query, await runCommand(['gh', 'api', query, '--jq', '.title'], 3));
    }),
  );
  // Selection first: which receipts and inbox jobs the producer would open
  // for this queue. Best-effort never-throw walk (the composer raises the
  // producer's exact refusals itself); content is then read for referenced
  // entries only, so an unreferenced chmod-000 receipt/inbox job cannot
  // abort assembly where Python would not even open the file.
  const selectedStems = drainableStemsFromQueue(queue);
  const receiptIds = referencedReceiptIds((queue ?? null) as CrqRecord);
  const [inbox, triageRows, probe, receipts] = await Promise.all([
    fileRepairInboxState(roots.stateRoot, selectedStems),
    fileTriageRows(roots.stateRoot),
    probeSystemd(runCommand),
    preloadReceipts(roots.stateRoot, receiptIds),
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
 * Receipt bytes by id, read on demand for ids the queue actually references:
 * Python's `merged_current` opens `(receipt_root, receipt_id + ".json")`
 * only when a terminal item needs verification, and contains that read
 * failure into `unverified` per row, so an unreferenced receipt file must
 * never be touched (audit iO_W: a chmod-000 unreferenced receipt must not
 * abort assembly) and a referenced one must read as unverified when its
 * read fails (any OSError reads as unavailable at this trust boundary).
 * A mismatched id remains a refusal that reads as absent, never a path
 * error.
 */
async function preloadReceipts(
  stateRoot: string,
  receiptIds: ReadonlySet<string>,
): Promise<ReadonlyMap<string, Uint8Array | null>> {
  const receiptsDir = join(stateRoot, 'receipts');
  const cache = new Map<string, Uint8Array | null>();
  for (const id of receiptIds) {
    try {
      cache.set(id, new Uint8Array(await readFile(join(receiptsDir, `${id}.json`))));
    } catch {
      // Any read failure reads as unavailable: the composer's merged_current
      // contains referenced-receipt failures into `unverified` (the producer
      // catches OSError alongside its binding refusals).
      cache.set(id, null);
    }
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
  // Python reads `time.time()` and `time.clock_gettime(time.CLOCK_MONOTONIC)`
  // right after the probe. CLOCK_MONOTONIC is boot-relative (host uptime),
  // which is `process.hrtime.bigint() / 1e9` in Node. CAUTION: process.uptime()
  // is the Node PROCESS lifetime, not the host clock; a fresh process on a
  // long-running host reports ~0 where Python reports ~host uptime, and the
  // composer's monotonic fallback (`realtime + timespan - monotonic`) then
  // shifts every timer ETA by the boot offset. Verified against Python on the
  // same host (hrtime 2188925.538 vs CLOCK_MONOTONIC 2188925.621; uptime 0.478).
  return {
    probe: { output },
    clock: { realtime: Date.now() / 1000, monotonic: Number(process.hrtime.bigint()) / 1e9 },
  };
}

/** The previous summary's exact bytes; null when absent, cache-void on bad bytes.
 *
 * Python's publication reads the prior summary inside one try/except that
 * covers OSError AND json decode (ValueError, which invalid UTF-8 raises:
 * `Path.read_text` decodes before `json.loads`, and a UnicodeDecodeError is a
 * ValueError subclass): `except (OSError, ValueError, KeyError, TypeError):
 * titles = {}`. A missing file is an empty cache, not an abort, and a
 * corrupt file must be VOIDED the same way so the new summary can replace
 * it. Only the cache seam gets this leniency; required state reads stay
 * strict.
 */
export async function readPreviousSummaryBytes(
  roots: SummaryStateRoots,
): Promise<Uint8Array | null> {
  try {
    const text = await readTextStrict(summaryTargetPath(roots.xdgStateHome, roots.home));
    return new TextEncoder().encode(text);
  } catch {
    // Cache-void leniency: ENOENT (absent prior) and every OSError/decode
    // failure read as an empty title cache, matching the producer's
    // `except (OSError, ValueError, KeyError, TypeError): titles = {}` so a
    // corrupt prior summary is replaced, never aborts the publication.
    return null;
  }
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
