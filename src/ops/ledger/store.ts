// Ledger lane C4 — the novel-error ledger's flat file format and its pure
// (de)serialization. The ledger prevents re-fixing known noise: every
// recurring error signature carries a recurrence COUNT — no timestamps —
// so recurrence is count-only and every derived view is time-independent.
// The file is committed evidence, which makes two properties load-bearing:
//   - serializeLedger is BYTE-DETERMINISTIC: entries sorted by signature
//     (byte-wise ascending), keys emitted in schema order (signature, count,
//     component, note), 2-space indent, exactly one trailing newline — the
//     same ledger state always renders to the same bytes, so git diffs of
//     the committed file are reviewable.
//   - parseLedger is STRICT: invalid JSON, a wrong version, a non-object
//     entry, a count < 1, a duplicate signature, or UNSORTED entries all
//     throw LedgerFormatError. The deterministic format is load-bearing, so
//     a hand-edited unsorted file is a format error — never silently
//     normalized. Normalization happens in the ledger ops, not here: the
//     store never collapses duplicates nor reorders anything on read.
//
// File I/O stays with the consumer: everything but the OPTIONAL
// {@link pathLedgerStore} is pure, and tests inject fakes. pathLedgerStore
// is the sync node:fs adapter the registry importer binds — the only
// node:fs touch in the lane's storage (sync for v1: ledger entries are one
// small JSON file, and the ops are async at the Op boundary regardless).
import { mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { lock } from 'proper-lockfile';
import type { LockOptions } from 'proper-lockfile';
import { z } from 'zod';
// Runtime import of the canonical signature order — pulled from the pure
// decision-ops module (order.ts was folded into ledger.js for lane i's
// registry-completeness heuristic, PR 64); NO runtime cycle: ledger.js's
// store.js import is type-only and erased.
import { compareSignatures, sortEntries } from './ledger.js';
import type { LedgerStore } from './ledger.js';

/** The canonical signature order lives in the pure decision-ops module (see ledger.js). */
export { sortEntries };

/** One recurring error signature and its recurrence count (≥ 1). */
export interface LedgerEntry {
  /** The error signature — the stable identity of the recurring failure. */
  signature: string;
  /** How many times the signature was recorded; starts at 1, grows by 1. */
  count: number;
  /** Owning component (e.g. 'src/ops/ledger'); backfilled by the ledger op when first provided. */
  component?: string;
  /** Free-form human note; backfilled by the ledger op when first provided. */
  note?: string;
}

/** The persisted ledger file. Version 1 — the only version parseLedger accepts. */
export interface LedgerFile {
  version: 1;
  entries: LedgerEntry[];
}

/**
 * Thrown by {@link parseLedger} (and the write-side guards of
 * {@link serializeLedger}) on any violation of the committed format.
 */
export class LedgerFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerFormatError';
  }
}

const LedgerEntrySchema: z.ZodType<LedgerEntry> = z
  .object({
    signature: z.string().min(1),
    count: z.number().int().min(1),
    component: z.string().optional(),
    note: z.string().optional(),
  })
  .strict();

const LedgerFileSchema: z.ZodType<LedgerFile> = z
  .object({
    version: z.literal(1),
    entries: z.array(LedgerEntrySchema),
  })
  .strict();

/**
 * Serialize a ledger deterministically: entries sorted by
 * {@link sortEntries}, keys in schema order (signature, count, component,
 * note), 2-space indent, exactly one trailing newline. The write side
 * guards ONLY what its own output could not parse back — a non-integer
 * count (JSON.stringify would render NaN to null) and duplicate signatures
 * (the store never collapses them; the ledger owns normalization). It does
 * NOT re-validate the rest of the schema: a wrong version or an empty
 * signature passes through, so file-level trust is the caller's —
 * parseLedger is the strict entry for anything read back.
 */
export function serializeLedger(file: LedgerFile): string {
  const seen = new Set<string>();
  for (const entry of file.entries) {
    if (!Number.isSafeInteger(entry.count) || entry.count < 1) {
      throw new LedgerFormatError(
        `ledger: entry '${entry.signature}' has count ${String(entry.count)} — must be an integer ≥ 1`,
      );
    }
    if (seen.has(entry.signature)) {
      throw new LedgerFormatError(
        `ledger: duplicate signature '${entry.signature}' — the store never collapses duplicates`,
      );
    }
    seen.add(entry.signature);
  }
  const ordered = {
    version: file.version,
    entries: sortEntries(file.entries).map((entry) => ({
      signature: entry.signature,
      count: entry.count,
      component: entry.component,
      note: entry.note,
    })),
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/**
 * Parse and validate ledger text; throws {@link LedgerFormatError} on any
 * schema violation, a duplicate signature, or entries out of canonical
 * order (adjacent equal signatures are already duplicates). Key order
 * WITHIN an entry is not enforced — canonical key order is a serialize
 * guarantee; content is what the format pins.
 */
export function parseLedger(text: string): LedgerFile {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new LedgerFormatError(`ledger: not valid JSON — ${(err as Error).message}`);
  }
  const parsed = LedgerFileSchema.safeParse(data);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new LedgerFormatError(`ledger: schema violation — ${issues}`);
  }
  const entries = parsed.data.entries;
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.signature)) {
      throw new LedgerFormatError(`ledger: duplicate signature '${entry.signature}'`);
    }
    seen.add(entry.signature);
  }
  for (let i = 1; i < entries.length; i++) {
    const prev = entries[i - 1] as LedgerEntry;
    const curr = entries[i] as LedgerEntry;
    if (compareSignatures(prev.signature, curr.signature) >= 0) {
      throw new LedgerFormatError(
        `ledger: entries not sorted — '${prev.signature}' must sort strictly before '${curr.signature}' (byte-wise ascending is the committed format)`,
      );
    }
  }
  return parsed.data;
}

/**
 * The OPTIONAL shipped store: a containment-checked node:fs adapter over
 * one JSON ledger inside `root`. TRUST SURFACE — two-stage containment on
 * REAL paths (the captureBaseline rule):
 *   - Stage A, at store creation: `root` must exist (realpath — a missing
 *     root refuses the store outright) and the target's nearest EXISTING
 *     ancestor must be a strict descendant of the resolved root. BOTH sides
 *     are realpathed, so a root reached THROUGH a symlinked ancestor
 *     (macOS /var → /private/var) is normalized, never refused — and a
 *     lexical check alone cannot lie about where the path really goes.
 *   - Stage B, on every save and lock AFTER mkdir -p of the target's
 *     parent: the parent is realpathed and (realParent + basename)
 *     re-verified against the resolved root — an INTERMEDIATE symlink
 *     under the root that points outside is refused (naming the escape)
 *     before anything is written or locked. Load likewise reads through
 *     the target's REAL path only, after the same re-verification.
 *
 * Load of a missing file yields the empty ledger (missing entries start
 * empty — recording is the only writer); any other read fault, or a corrupt
 * committed file (via parseLedger), throws — the ops map that to `failed`,
 * the read-only query likewise. Save is an ATOMIC publish
 * ({@link publishAtomic}): unique temp file, exclusive create, rename over
 * the target — a crash mid-write can never leave a torn ledger at the path,
 * and a pre-planted symlink there is replaced, never followed. `lock` (see
 * {@link LedgerStore.lock}) wraps the ledger path with proper-lockfile,
 * THENABLE and with bounded acquire backoff, so concurrent recorders of one
 * storePath — across processes — serialize instead of being dropped; a
 * rejected release is a fault, never a swallowed success.
 */
export function pathLedgerStore(root: string, target: string): LedgerStore {
  const { rootReal, targetAbs } = containLedgerTarget(root, target);
  const base = basename(targetAbs);

  /**
   * Stage-B containment: the parent must exist by now (mkdir -p ran);
   * realpath it and re-verify the strict descent of (realParent + basename)
   * under the resolved root. This is what closes intermediate-symlink
   * escapes, and comparing realpath-to-realpath is what keeps a symlinked
   * root prefix a normalization instead of a false refusal.
   */
  const verifyParentUnderRoot = (): void => {
    let realParent: string;
    try {
      realParent = realpathSync(dirname(targetAbs));
    } catch (err) {
      throw new Error(`ledger parent for '${target}' does not resolve — ${messageOf(err)}`, { cause: err });
    }
    const fault = strictDescendantFault(rootReal, join(realParent, base));
    if (fault !== null) {
      throw new Error(`${fault} — an intermediate symlink escapes the root; refusing to touch it`);
    }
  };

  return {
    load: () => {
      // Read through the REAL path only: a missing ledger starts empty; an
      // existing one is realpathed and containment re-verified before a
      // byte is parsed — an intermediate symlink escaping the root is a
      // refusal, never a read of outside content.
      let realFile: string;
      try {
        realFile = realpathSync(targetAbs);
      } catch (err) {
        if (isEnoent(err)) return { version: 1, entries: [] };
        throw err;
      }
      const fault = strictDescendantFault(rootReal, realFile);
      if (fault !== null) {
        throw new Error(`${fault} — an intermediate symlink escapes the root; refusing to read it`);
      }
      return parseLedger(readFileSync(realFile, 'utf8'));
    },
    save: (file) => {
      mkdirSync(dirname(targetAbs), { recursive: true });
      verifyParentUnderRoot();
      publishAtomic(targetAbs, serializeLedger(file));
    },
    lock: (fn) => {
      // The lockfile (a <target>.lock directory) needs its parent to exist
      // BEFORE acquire — without it, every attempt fails ENOENT and the
      // retry backoff burns out. On a first record the ledger file itself
      // does not exist yet; stage-B containment runs after the mkdir.
      mkdirSync(dirname(targetAbs), { recursive: true });
      verifyParentUnderRoot();
      return lock(targetAbs, LOCK_OPTIONS).then((release) =>
        Promise.resolve()
          .then(fn)
          .then(
            (value) =>
              // A rejected release is a fault, not a success: the ledger
              // op must report `failed` (naming the release failure)
              // rather than report ok while the lock is compromised.
              release()
                .then(() => value)
                .catch((releaseErr: unknown) => {
                  throw new Error(
                    `lock release failed — ${messageOf(releaseErr)}`,
                    { cause: releaseErr },
                  );
                }),
            (err) =>
              // fn already failed: its fault is primary; release is best-effort.
              release()
                .catch(() => undefined)
                .then(() => {
                  throw err;
                }),
          ),
      );
    },
  };
}

/**
 * proper-lockfile tuning: no realpath (the ledger may not exist yet on a
 * first record), bounded staleness (a crashed holder's lock is stealable
 * after 5s), and bounded acquire BACKOFF — {retries: 8, factor: 2,
 * minTimeout: 25} — so a contended recorder waits its turn instead of
 * dropping its increment.
 */
const LOCK_OPTIONS: LockOptions = {
  realpath: false,
  stale: 5000,
  retries: { retries: 8, factor: 2, minTimeout: 25 },
};

/**
 * Stage-A containment, resolved eagerly at store creation (the registry
 * binds a fresh store per dispatch, so every op call re-checks): realpath
 * the root — it must EXIST — and verify the target's nearest EXISTING
 * ancestor is a strict descendant of the resolved root. The comparison is
 * REALPATH-TO-REALPATH: a root reached through a symlinked ancestor
 * (macOS /var → /private/var) is normalized instead of refusing every
 * contained target, and an existing prefix that resolves outside the root
 * is refused before any mkdir. Stage B (after mkdir -p, per write/lock)
 * closes the remaining gap: intermediate symlinks created below that
 * prefix.
 */
function containLedgerTarget(root: string, target: string): { rootReal: string; targetAbs: string } {
  let rootReal: string;
  try {
    rootReal = realpathSync(root);
  } catch (err) {
    if (isEnoent(err)) throw new Error(`root does not resolve: '${root}' does not exist`, { cause: err });
    throw err;
  }
  const targetAbs = resolve(target);
  // Nearest existing ancestor: realpath fails ENOENT only while segments
  // are missing; walk up until something resolves (worst case '/'). The
  // ancestor is a PREFIX, so it may BE the root (all segments between root
  // and the target are missing) — only an escape is refused here; the
  // strictness (never the root itself) is the target's own business and is
  // re-checked strictly at stage B and on read.
  let ancestor = dirname(targetAbs);
  for (;;) {
    try {
      ancestor = realpathSync(ancestor);
      break;
    } catch (err) {
      if (!isEnoent(err)) throw err;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw err; // pathological: even '/' unresolved
      ancestor = parent;
    }
  }
  const rel = relative(rootReal, ancestor);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(
      `'${target}' does not resolve inside root '${rootReal}' — refusing to touch it`,
    );
  }
  return { rootReal, targetAbs };
}

/**
 * The captureBaseline descent rule, on REAL paths: `candidate` must be a
 * strict descendant of `rootReal` — the relative form non-empty (never the
 * root itself), never escaping upward ('..' — compared against the
 * separator so a root-child literally named '..foo' stays legal), never
 * absolute. Returns the fault message naming both paths, or null when
 * contained.
 */
function strictDescendantFault(rootReal: string, candidate: string): string | null {
  const rel = relative(rootReal, candidate);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return `'${candidate}' does not resolve to a strict descendant of root '${rootReal}'`;
  }
  return null;
}

/** Error message of an unknown throwable, for fault messages. */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Temp-name salt: uniqueness within a process; EEXIST collisions advance the counter, bounded. */
let tempFileCounter = 0;

/**
 * Atomic publish (the ratchet lane's captureBaseline pattern, implemented
 * fresh for this family): bytes land in a unique temp file in the SAME
 * directory — created EXCLUSIVELY ('wx'), so a pre-planted symlink at the
 * temp path fails the open (EEXIST) instead of being followed — then rename
 * over the target. rename swaps the directory ENTRY, so a symlink at the
 * target is replaced, never written through, and a crash mid-write can
 * never leave a torn file at the target path. Bounded EEXIST retries, then
 * the fault surfaces; a failed publish removes only a temp THIS call
 * created (best-effort) and rethrows the primary fault.
 */
function publishAtomic(targetPath: string, bytes: string): void {
  mkdirSync(dirname(targetPath), { recursive: true });
  let tempPath: string | undefined;
  let tempCreated = false;
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      tempPath = join(
        dirname(targetPath),
        `.${basename(targetPath)}.${process.pid}.${++tempFileCounter}.tmp`,
      );
      try {
        writeFileSync(tempPath, bytes, { flag: 'wx' });
        tempCreated = true;
        break;
      } catch (err) {
        if (!isEexist(err) || attempt === 4) throw err;
      }
    }
    if (tempCreated === false || tempPath === undefined) {
      throw new Error('all temp candidates already existed');
    }
    renameSync(tempPath, targetPath);
  } catch (err) {
    if (tempPath !== undefined && tempCreated) {
      try {
        unlinkSync(tempPath);
      } catch {
        // Best-effort cleanup: the primary fault is rethrown below.
      }
    }
    throw err;
  }
}

/** True when a thrown value is a node:fs ENOENT (the missing-file case). */
function isEnoent(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null && 'code' in err && (err as { code?: unknown }).code === 'ENOENT'
  );
}

/** True when a thrown value is a node:fs EEXIST (temp-name collision). */
function isEexist(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null && 'code' in err && (err as { code?: unknown }).code === 'EEXIST'
  );
}
