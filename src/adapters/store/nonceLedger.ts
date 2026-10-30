// nonceLedger — the ADR-0003 §5 operator ledger (the store adapter's nonce
// ledger; extracted from ops/analyze/approval.ts by Phase 1.4 — the approval
// authority keeps admission/exercise policy and OWNS the {@link NonceLedger}
// port type, imported from there adapters → ops (ADR-0005:27, PR #335
// review, Codex P1); this module is the single-use nonce persistence and its
// durability contract).
import {
  existsSync,
  openSync,
  closeSync,
  fdatasyncSync,
  readFileSync,
  realpathSync,
  readlinkSync,
  fsyncSync,
  writeSync,
} from 'node:fs';
import { mkdir, rmdir } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { NonceLedger } from '../../ops/analyze/approval.js';

/** A ledger that can also answer the "left UNSPENT" question the tests assert. */
export interface InspectableNonceLedger extends NonceLedger {
  /** How many nonces are spent. */
  spent(): number;
  /** True when this nonce is spent (read-only; never consumes). */
  isSpent(nonce: string): boolean;
}

/**
 * The process-local ledger. HONEST SCOPE, stated because it is the easiest
 * thing here to overclaim: it makes a token single-use for the lifetime of
 * one process and NO LONGER. A fresh process is exactly ADR §5's "same
 * host, fresh `--journal-dir`" case, which the DURABLE ledger is required
 * to block. Use {@link makeFileNonceLedger} wherever the ledger path is
 * known.
 */
export function makeInMemoryNonceLedger(): InspectableNonceLedger {
  const spent = new Set<string>();
  return {
    consume: async (nonce) => {
      if (spent.has(nonce)) return 'spent';
      spent.add(nonce);
      return 'consumed';
    },
    spent: () => spent.size,
    isSpent: (nonce) => spent.has(nonce),
  };
}

/**
 * The DURABLE operator ledger (ADR-0003 §5): an append-only NDJSON file in
 * the P1-trusted layer, one nonce per line, re-read on every consume so a
 * nonce spent by an earlier run — or by a concurrent process — is refused.
 *
 * DURABILITY, matched to the journal's own idiom (src/kernel/journal.ts,
 * `durable: true`) rather than to a hand-rolled idea: the line is written
 * through an append-mode handle and `fdatasync`ed BEFORE `consume` resolves,
 * and the ledger's DIRECTORY is fsync'd once, when this process creates the
 * file, so the directory entry is durable too. A plain `appendFileSync` was
 * the first version here and it was NOT durable in the sense the ADR's crash
 * analysis needs: it returns once the bytes are in the OS page cache, so a
 * machine crash could lose a spent nonce and leave the token REPLAYABLE —
 * precisely the outcome §4c's "a crash between step 2 and step 3 burns the
 * token (safe)" exists to prevent.
 *
 * Two residuals, stated rather than implied (both are the journal's own):
 * macOS `F_FULLFSYNC` is not issued, so a POWER-LOSS window remains where
 * the data was in the drive's cache but not on the platters — process-crash
 * durability does not depend on it, and neither does the replay window this
 * ledger closes for a same-host re-run. And the ledger is a plain file, not
 * a MAC'd one: it is trusted because it lives in the P1-trusted layer, not
 * because it is tamper-evident. An attacker who can write that layer can
 * rewrite history; that assumption is ADR §1's, not this function's.
 *
 * Concurrency: the read-then-append runs under a LEDGER-WIDE lock
 * (`<canonical path>.append.lock`), so approvals for different workspaces
 * sharing one ledger cannot interleave their appends, and two spellings of
 * one ledger (a symlink and its target) share that one lock. `consume` is
 * also still called inside the per-workspace mutation lock by
 * {@link ApprovalAuthority.exercise}, which orders it against the write.
 *
 * SHORT WRITES, and why `consume` cannot simply call `writeSync` once:
 * `fs.writeSync` RETURNS the number of bytes it wrote and does not promise
 * the whole buffer (a full disk, a signal, or a filesystem that decides to
 * write less all yield a short count). A single unchecked call would
 * therefore `fdatasync` a TRUNCATED line, report `consumed`, and leave the
 * full nonce absent from the ledger — after which the very same token
 * replays cleanly, which is the one outcome this file exists to prevent. So
 * the write loops until the whole line is out, and any write that cannot
 * make progress THROWS: the caller (`exercise`) turns a throw into a
 * `needs-human` refusal. Once a write is attempted, its persistence is
 * INDETERMINATE until inspected. A torn record left behind is NOT truncated
 * away on purpose: the file is shared, and truncating to a remembered
 * length could discard a CONCURRENT append, converting this safe failure
 * into an unsafe replay of another writer's token. Malformed records and
 * unterminated tails fail the entire read closed; even 32 valid nonce
 * characters without a newline are never accepted as committed history.
 */
export function makeFileNonceLedger(
  ledgerPath: string,
  config: FileNonceLedgerConfig = {},
): InspectableNonceLedger {
  // ONE LEDGER, ONE IDENTITY. Every file operation AND the append lock are
  // keyed on the canonical path (symlinks resolved, a not-yet-existing file
  // resolved through its longest existing ancestor). Two processes opening
  // one ledger through two spellings — a symlinked state dir and its real
  // path — would otherwise derive two append-lock artifacts, pass absorb()
  // concurrently, and both report `consumed` for one nonce.
  const path = realpathOrSelf(ledgerPath);
  const write = config.write ?? defaultWrite;
  const known = new Set<string>();
  // The directory entry is durable once the FILE is created; later appends
  // to a known file skip the dir fsync entirely (the journal's own rule).
  let dirSynced = existsSync(path);
  const absorb = (): void => {
    // Fresh read every time: the in-process set is a CACHE of a file another
    // process may have appended since. A missing file is an empty ledger
    // (nothing spent yet); an unreadable one throws and the exercise fails
    // closed, which is the fail-closed direction ADR §4c wants.
    //
    // EVERY RECORD IS VALIDATED, and this is a correctness fix, not
    // tidiness. A torn record (a short write that wrote SOME bytes before
    // failing) leaves a partial line; because the next append is O_APPEND,
    // the following record lands IMMEDIATELY after that partial line and
    // the two fuse into one line that matches neither nonce. A fresh
    // instance would absorb the fused garbage, never see the real full
    // nonce as spent, and permit the replay this ledger exists to prevent.
    // Accepting any non-empty string as a nonce is what let that happen, so
    // a record that is not a well-formed nonce is CORRUPTION and the whole
    // read fails closed — refusing every consume beats reading history wrong.
    if (!existsSync(path)) return;
    const lines = readFileSync(path, 'utf8').split('\n');
    lines.forEach((line, index) => {
      const record = line.trim();
      if (record === '') return;
      if (!NONCE_PATTERN.test(record)) {
        throw new Error(
          `approval ledger: record ${String(index + 1)} of '${path}' is malformed (${JSON.stringify(record.slice(0, 64))}, expected ${NONCE_SHAPE}) — the ledger is fail-closed: a torn or corrupted record is never read as history, so no consume is allowed until an operator inspects it`,
        );
      }
      known.add(record);
    });
    // Validate before ANY spent lookup, including read-only inspection.
    if (hasUnterminatedTail(path)) {
      throw new Error(
        `approval ledger: '${path}' ends with an unterminated record — the ledger is fail-closed until an operator inspects and repairs it`,
      );
    }
  };
  // LEDGER-WIDE append lock. The per-workspace mutation lock does not
  // serialize two DIFFERENT workspaces that share one operator ledger, and a
  // short `writeSync` lets their append syscalls interleave into malformed
  // lines. This lock is keyed on the CANONICAL ledger path, so every
  // read-check-append sequence over one ledger is exclusive across processes
  // whatever spelling each process was handed.
  const appendLock = makeAppendLock(`${path}.append.lock`);
  const consumeLocked = async (nonce: string): Promise<'consumed' | 'spent'> => {
    absorb();
    if (known.has(nonce)) return 'spent';
    // Synchronous on purpose: the append must be COMPLETE before this
    // promise resolves, or the exercise would report "consumed" for a
    // nonce that is still only a promise of a byte on disk.
    const isNew = !dirSynced;
    const line = Buffer.from(`${nonce}\n`, 'utf8');
    const handle = openSync(path, 'a');
    try {
      // WRITE-ALL, then one fsync of the completed record: the record
      // that reaches the platter is the whole nonce, never a prefix.
      // A throwing write may already have changed the file, regardless of
      // the count it returned. Never assert UNSPENT after entering it.
      writeAll(handle, line, write, nonce);
      fdatasyncSync(handle);
    } catch (err) {
      throw new Error(
        `approval ledger: append persistence is INDETERMINATE after a write attempt — ${err instanceof Error ? err.message : String(err)}; inspect the ledger before re-approving`,
        { cause: err },
      );
    } finally {
      closeSync(handle);
    }
    if (isNew) {
      // Flagged only AFTER the fsync returns: a hard failure leaves the flag
      // clear, so the next consume retries the directory sync.
      syncDirSync(dirname(path));
      dirSynced = true;
    }
    known.add(nonce);
    return 'consumed';
  };
  return {
    consume: async (nonce) => {
      // Validate BEFORE touching the ledger: a malformed nonce appended here
      // would report `consumed`, then make the next absorb() read the new
      // record as corruption and wedge every later approval.
      if (!NONCE_PATTERN.test(nonce)) {
        throw new Error(
          `approval ledger: refusing to record a malformed nonce (${JSON.stringify(String(nonce).slice(0, 64))}, expected ${NONCE_SHAPE}) — nothing was written`,
        );
      }
      return appendLock.withLock(() => consumeLocked(nonce));
    },
    spent: () => {
      absorb();
      return known.size;
    },
    isSpent: (nonce) => {
      absorb();
      return known.has(nonce);
    },
  };
}

/**
 * Resolve a path for a CONTAINMENT comparison, tolerating a tail that does
 * not exist yet. Plain `realpathSync` throws on a missing path and the
 * obvious fallback (return the raw string) then compares an unresolved
 * `/var/...` against a resolved `/private/var/...` and MISSES the nesting —
 * silently, and exactly for the common case of a ledger directory created
 * on first write. So: walk up to the longest existing ancestor, resolve
 * THAT, and re-join the remaining segments. Every existing segment is
 * therefore symlink-resolved, and the answer does not depend on whether the
 * last component happens to exist.
 */
export function realpathOrSelf(path: string): string {
  const segments: string[] = [];
  let current = resolve(path);
  const links = new Set<string>();
  for (;;) {
    try {
      const resolved = realpathSync(current);
      return segments.length === 0 ? resolved : join(resolved, ...segments.reverse());
    } catch {
      let link: string | undefined;
      try {
        link = readlinkSync(current);
      } catch {
        // Not a symlink: resolve the longest existing ancestor below.
      }
      if (link !== undefined) {
        if (links.has(current) || links.size >= 40) {
          throw new Error('approval ledger: symlink cycle or excessive symlink depth');
        }
        links.add(current);
        current = resolve(realpathSync(dirname(current)), link);
        continue;
      }
      const parent = dirname(current);
      if (parent === current) return path; // reached the root without resolving
      segments.push(basename(current));
      current = parent;
    }
  }
}

/**
 * An append owner never expires by age. Synchronous read/write/fsync can
 * block heartbeat timers indefinitely, so a timed lease cannot serialize
 * this section. Acquisition is bounded; after a crash the artifact stays
 * fail-closed. An operator must verify all ledger users are stopped before
 * removing it. Never recover it merely because its mtime is old.
 */
function makeAppendLock(artifact: string): {
  withLock<T>(fn: () => Promise<T>): Promise<T>;
} {
  return {
    async withLock<T>(fn: () => Promise<T>): Promise<T> {
      await mkdir(dirname(artifact), { recursive: true });
      for (let attempt = 0; ; attempt++) {
        try {
          await mkdir(artifact);
          break;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'EEXIST' || attempt >= 9) {
            throw new Error('approval ledger: append lock unavailable; never reclaim by age', {
              cause: err,
            });
          }
          await delay(100 * 2 ** attempt);
        }
      }
      let value: T;
      try {
        value = await fn();
      } catch (err) {
        // Keep the section's original fault primary if release also fails.
        await rmdir(artifact).catch(() => undefined);
        throw err;
      }
      await rmdir(artifact);
      return value;
    },
  };
}

/**
 * fsync a DIRECTORY so a freshly created file's directory entry is durable
 * (ADR-0003 annex §2: "the journal directory is fsync'd when a run file is
 * created"), using the same best-effort policy as the journal's `syncDir`:
 * exotic mounts (network FS, some container overlays) refuse a read-mode
 * directory fsync with EPERM/EACCES/EINVAL/ENOSYS, and on those the call
 * is a recorded no-op rather than a blocker — the supported local
 * filesystem, the only case these claims are made about, gets real
 * dirent durability. A refusal here is deliberately NOT fatal: the nonce
 * line itself is already fdatasync'd, so the worst case is a lost directory
 * ENTRY on a filesystem that cannot promise one, not a lost spend record on
 * the file.
 */
function syncDirSync(dir: string): void {
  const SOFT_ERRORS = new Set(['EPERM', 'EACCES', 'EINVAL', 'ENOSYS']);
  let handle: number | undefined;
  try {
    handle = openSync(dir, 'r');
    fsyncSync(handle);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === undefined || !SOFT_ERRORS.has(code)) throw err;
  } finally {
    if (handle !== undefined) closeSync(handle);
  }
}

/**
 * The write seam of {@link makeFileNonceLedger}, injectable so the
 * short-write case is REPRODUCIBLE in a test rather than asserted about in
 * prose. The default is `fs.writeSync`, whose return value is a byte count
 * that may be smaller than the buffer — the default writer is what the
 * write-all loop exists to cope with.
 */
export interface FileNonceLedgerConfig {
  /**
   * Write up to `length` bytes from `buffer` at `offset` to `handle`,
   * returning how many were written. Defaults to `fs.writeSync`.
   */
  write?: (handle: number, buffer: Buffer, offset: number, length: number) => number;
}

/**
 * The nonce shape ADR-0003 §2 specifies: 128 bits of randomness, 32
 * lowercase hex characters. The DURABLE ledger validates every record
 * against it, which is what turns a torn record into a detectable fault
 * instead of a silently merged line.
 */
const NONCE_PATTERN = /^[0-9a-f]{32}$/;

/** The same shape, as prose, for error messages. */
const NONCE_SHAPE = '32 lowercase hex characters';

/** True when the ledger file exists, is non-empty, and lacks its final newline. */
function hasUnterminatedTail(path: string): boolean {
  if (!existsSync(path)) return false;
  const contents = readFileSync(path, 'utf8');
  return contents !== '' && !contents.endsWith('\n');
}

/** The default write seam: node:fs, whose short-count behaviour is the reason for the loop. */
const defaultWrite: NonNullable<FileNonceLedgerConfig['write']> = (
  handle,
  buffer,
  offset,
  length,
) => writeSync(handle, buffer, offset, length);

/**
 * Write the WHOLE line, looping over short writes, and throw rather than
 * claim success on a partial record. A non-positive count means the write
 * can make no progress (a full disk, a closed handle); a count larger than
 * what was asked for means the writer is not honouring the contract. Either
 * way the throw propagates to `exercise`, which refuses the mutation;
 * attempted writes leave persistence indeterminate.
 */
function writeAll(
  handle: number,
  line: Buffer,
  write: NonNullable<FileNonceLedgerConfig['write']>,
  nonce: string,
): void {
  let written = 0;
  while (written < line.length) {
    const count = write(handle, line, written, line.length - written);
    if (!Number.isInteger(count) || count <= 0) {
      throw new Error(
        `approval ledger: the append of nonce '${nonce}' made no progress (${String(count)} bytes written of ${String(line.length - written)} remaining) — the record is incomplete and persistence is INDETERMINATE`,
      );
    }
    if (written + count > line.length) {
      throw new Error(
        `approval ledger: the append of nonce '${nonce}' reported ${String(count)} bytes written but only ${String(line.length - written)} were requested — the writer is not honouring the write contract and persistence is INDETERMINATE`,
      );
    }
    written += count;
  }
}
