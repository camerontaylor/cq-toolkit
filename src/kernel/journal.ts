// Append-only NDJSON run journal — T1.2 (durable facts, derived status).
//
// The journal is EVIDENCE, so it is deliberately dumb:
//   - The caller (the plan runner) owns runId generation; the journal only
//     asserts runIds are filesystem-safe (they become `<runId>.ndjson` file
//     names) and that the event's own `runId` matches the file it lands in.
//   - Append-only: one validated JSON line per event, never rewritten. Every
//     event is validated against the frozen JournalEventSchema BEFORE it hits
//     disk — an invalid event is a loud error, not silent evidence rot.
//   - Status is derived at READ time (`statusOf`): the file stores facts
//     (started, finished with result X); states are a fold over those facts,
//     so a corrupted or stale derived view can always be recomputed.
//
// Crash tolerance (torn-tail policy): a crash mid-append can leave an
// incomplete final line — by definition one WITHOUT its trailing newline.
// `read` tolerates exactly that: an unparsable LAST line is ignored only when
// the file does NOT end with '\n' (a torn final write), and whitespace-only
// trailing lines are dropped (no event bytes). Any other complete but
// invalid line — including last — throws, as does any unparsable middle
// line, and a line whose event.runId does not match the file's run: a hole
// or misattribution in complete evidence is corruption, not a torn write,
// and silently accepting it would poison the fold.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  appendFile,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
} from 'node:fs/promises';
import { createConnection, createServer, type Server } from 'node:net';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { LockOptions, lock } from 'proper-lockfile';
import { z } from 'zod';
import { runLadder } from './governor.js';
import { JournalEventSchema } from './schema.js';
import type { JobState, JobStatus, JournalEvent } from './types.js';

/**
 * Filesystem-safe runId: 1+ chars of [A-Za-z0-9._-], starting alphanumeric.
 * This bans path separators (both `/` and `\`), empty ids, and dot-only ids,
 * so a runId can be used verbatim as `<runId>.ndjson` with no escaping.
 */
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Throws unless `runId` is filesystem-safe (see RUN_ID_PATTERN). */
export function assertSafeRunId(runId: string): void {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new Error(
      `journal: runId must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ (no slashes, not empty): '${runId}'`,
    );
  }
}

/**
 * Longest plan id a journaled run can lock. NAME_MAX (255 bytes on the
 * supported local filesystems) bounds every lock artifact name, and the
 * longest is the release tombstone `<planId>.lock.json.<nonce>.released.tmp`
 * (planId + 60; the publication temporary, claim and aborted-claim
 * temporaries are shorter). Refused before any artifact exists, so no step
 * of the protocol can fail mid-way with ENAMETOOLONG. A longer id never
 * completed a journaled run before this bound either: its tombstone, and
 * so every release, already failed.
 */
const MAX_LOCKED_PLAN_ID = 255 - '.lock.json.'.length - 36 - '.released.tmp'.length;

const PlanLockRecordSchema = z
  .object({
    nonce: z.string().uuid(),
    socketPath: z.string().startsWith('/'),
    pid: z.number().int().positive(),
    host: z.string().min(1),
    bootId: z.string().min(1),
    runId: z.string().regex(RUN_ID_PATTERN),
    released: z.literal(true).optional(),
  })
  .strict();
type PlanLockRecord = z.infer<typeof PlanLockRecordSchema>;

/** Internal runner lease; the record beside the journal is the rendezvous. */
export interface PlanLock {
  assertHeld(): Promise<void>;
  release(): Promise<void>;
}

// Boot-identity process startup/completion only: observed sysctl max 5223ms
// (healthy windows 39–145ms). 10s adds headroom to these samples, not a
// guaranteed host bound: exceeding it still refuses. Operation and socket
// probe budgets are separate and unchanged.
const PUBLICATION_STARTUP_MS = 10_000;

/**
 * Publication guard lease (proper-lockfile, mkdir strategy). The guard is
 * held only for one acquisition — eligibility decision plus record
 * publication — never for the run; the run's lease stays the record.
 *
 * - `stale` 30s: the repo's proper-lockfile window (ledger store, git
 *   mutex). The guarded section includes the first boot lookup (bounded at
 *   10s, observed 5.2s under load) and fsyncs, so a refresh can be delayed
 *   by event-loop or threadpool saturation; 30s is 3× that bound before a
 *   live acquirer can be judged stale. It is also the recovery cost: a
 *   holder that dies mid-acquisition makes contenders refuse as busy for
 *   at most 30s (flock released on death; this lease must age out).
 * - `update` 5s: six refreshes per stale window, so 25s of consecutive
 *   missed refreshes are absorbed before staleness.
 * - `retries` 0: the flock guard was non-blocking (LOCK_NB) and contenders
 *   refuse as busy rather than queue; a STALE guard needs no retry, as the
 *   library removes it and re-attempts within the same call.
 * - `realpath` false: the guarded path is a name, not a file (realpath
 *   would demand it exist). The lock directory is a single entry inside
 *   the journal directory, so exclusion holds however that directory is
 *   reached.
 *
 * Safety does NOT rest on this lease: a stalled holder can be displaced
 * (and wall-clock steps or host sleep age a lease too), and the library's
 * unlock removes the directory unconditionally. Every publication is
 * therefore fenced independently — exclusive `link` creation, exclusive
 * succession claims ({@link claimSuccession}), and the record nonce. The
 * guard keeps contention off those paths.
 */
const GUARD_LOCK_OPTIONS: LockOptions = {
  stale: 30_000,
  update: 5_000,
  retries: 0,
  realpath: false,
};

/**
 * proper-lockfile is loaded on first guard acquisition, never at import:
 * its module body registers a `signal-exit@3` exit hook, which installs
 * SIGINT/SIGTERM/SIGHUP/… listeners and patches `process.emit`/`reallyExit`.
 * The kernel is in the driver/runCli import graph, and only executable
 * entrypoints may change signal disposition (shared/process-signals.ts).
 *
 * Once a journaled run has acquired, those listeners stay installed for the
 * process lifetime (as they already do once any ops lockfile user loads).
 * They do not disturb the runner's signal handling: a signal-exit listener
 * acts only when it is the SOLE listener for the signal, so while
 * `installProcessSignalCleanup` is installed it is a no-op and the kill
 * ladder's grace runs unchanged. When that cleanup finishes it removes its
 * listener and re-raises; signal-exit is then sole, unloads itself, runs
 * proper-lockfile's exit hook (rmdirSync of any guard still held, which
 * only shortens the ≤30s busy window), and re-raises again into the default
 * disposition, so the signal exit status is preserved. The `reallyExit`
 * patch passes the exit code through unchanged. In an embedding host with
 * no signal listeners the re-raise likewise yields the default behaviour.
 */
let lockfileModule: Promise<{ lock: typeof lock }> | undefined;

function loadLockfile(): Promise<{ lock: typeof lock }> {
  lockfileModule ??= import('proper-lockfile');
  return lockfileModule;
}

let bootIdentityPromise: Promise<string> | undefined;

function bootIdentity(): Promise<string> {
  if (bootIdentityPromise !== undefined) return bootIdentityPromise;
  const pending = readBootIdentity().then((identity) => {
    if (identity.length === 0) throw new Error('journal: cannot determine host boot identity');
    return identity;
  });
  // Share in-flight work and retain successful identity for this process.
  // A failed first lookup must not poison later independent acquisitions.
  bootIdentityPromise = pending.catch((error: unknown) => {
    bootIdentityPromise = undefined;
    throw error;
  });
  return bootIdentityPromise;
}

async function readBootIdentity(): Promise<string> {
  if (process.platform === 'linux') {
    return (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
  }
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await promisify(execFile)('/usr/sbin/sysctl', ['-n', 'kern.boottime'], {
        timeout: PUBLICATION_STARTUP_MS,
      });
      return stdout.trim();
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === null &&
        'killed' in error &&
        error.killed === true &&
        'signal' in error &&
        error.signal === 'SIGTERM'
      ) {
        throw new Error(
          `journal: boot identity startup/completion deadline exceeded after ${PUBLICATION_STARTUP_MS}ms (possible slow host)`,
          { cause: error },
        );
      }
      throw error;
    }
  }
  throw new Error(`journal: plan lock requires a supported local POSIX host (${process.platform})`);
}

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
}

async function readLockRecord(path: string): Promise<PlanLockRecord> {
  const raw = await readFile(path, 'utf8');
  const parsed = PlanLockRecordSchema.safeParse(JSON.parse(raw) as unknown);
  if (!parsed.success) throw new Error(`journal: corrupt or half-written plan lock '${path}'`);
  return parsed.data;
}

/** A full or paused socket backlog is alive; all unknown errors fail closed. */
async function socketIsAlive(path: string): Promise<boolean> {
  // The governor owns the probe deadline as well as invocation deadlines.
  // Aborting a probe is positive refusal evidence, never permission to steal.
  const outcome = await runLadder(
    ({ signal }) =>
      new Promise<boolean>((resolve, reject) => {
        const socket = createConnection(path);
        const finish = (alive: boolean): void => {
          signal.removeEventListener('abort', refuse);
          socket.destroy();
          resolve(alive);
        };
        const refuse = (): void => finish(true);
        signal.addEventListener('abort', refuse, { once: true });
        socket.once('connect', () => finish(true));
        socket.once('error', (error) => {
          const code = errorCode(error);
          if (code === 'ENOENT' || code === 'ECONNREFUSED') finish(false);
          else if (code === 'EAGAIN') finish(true);
          else {
            signal.removeEventListener('abort', refuse);
            socket.destroy();
            reject(error);
          }
        });
      }),
    { wallClockMs: 1000, abortGraceMs: 0, killGraceMs: 0 },
    { op: 'journal-lock-probe', jobKey: path, attempt: 1 },
  );
  if (outcome.outcome === 'threw') throw outcome.error;
  return outcome.outcome === 'killed' || outcome.value;
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (errorCode(error) === 'ESRCH') return false;
    // EPERM and PID reuse can only prevent reclamation, never grant it.
    return true;
  }
}

function listen(server: Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ path, backlog: 16 }, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

/**
 * ADR-0003 §2.5: exclusive record creation, recorded socket + pid/boot
 * liveness, and nonce fences. No timestamp lease on the record: SIGSTOP is
 * never death. Records are published whole (exclusive link of a synced
 * temporary, or its rename under an exclusive succession claim). Invalid/half-written
 * and unreleased foreign-host records refuse without stealing. Release
 * renames a tombstone over OUR inode only, never over or unlinking a rival's
 * replacement; the tombstone remains reclaimable.
 *
 * Acquisition runs under a publication guard lease (GUARD_LOCK_OPTIONS).
 * Its compromise is lease loss, detected at the next fence: acquisition
 * refuses with the same `lock-lost` error the runner's fence raises, and
 * anything published is rolled back. The guard only reduces contention;
 * exclusive link creation and succession claims are the fence.
 */
export async function acquirePlanLock(
  journalDir: string,
  planId: string,
  runId: string,
): Promise<PlanLock> {
  assertSafeRunId(planId);
  assertSafeRunId(runId);
  if (planId.length > MAX_LOCKED_PLAN_ID) {
    throw new Error(
      `journal: plan id '${planId}' is ${planId.length} chars; plan lock artifact names allow at most ${MAX_LOCKED_PLAN_ID}`,
    );
  }
  await mkdir(journalDir, { recursive: true });
  // Legacy publishers recorded no owner in this directory. Neither a dead
  // record nor time proves fleet quiescence: never migrate it automatically.
  // Legacy journals need an operator-attested, separately governed migration
  // before they can run.
  const legacy = join(journalDir, `${planId}.lock.acquiring`);
  try {
    await lstat(legacy);
    throw acquisitionBusy(planId);
  } catch (error) {
    if (!isEnoent(error)) throw error;
  }
  const guard = await acquirePublicationGuard(
    join(journalDir, `${planId}.lock.guard`),
    planId,
    runId,
  );
  let acquired: PlanLock | undefined;
  try {
    acquired = await acquirePlanLockRecord(journalDir, planId, runId, guard.assertHeld);
  } catch (error) {
    // The acquisition's own failure is the root cause; a guard release that
    // fails too must not replace it.
    await guard.release().catch(() => undefined);
    throw error;
  }
  try {
    // Last fence. No compromise can land between it and the release: no
    // await separates them, and the library's release (realpath: false)
    // marks the lease released synchronously, so it cannot reject with
    // ERELEASED here. A compromise recorded once the release is under way (a
    // refresh stat already in flight sees the lease directory removed) is
    // swallowed only if the directory removal also failed; that is safe
    // because the published record is fenced by its exclusive link or
    // claim, not by the guard.
    guard.assertHeld();
    await guard.release();
  } catch (error) {
    await acquired.release();
    throw error;
  }
  return acquired;
}

function acquisitionBusy(planId: string): Error {
  return new Error(`journal: plan lock acquisition in progress or interrupted for '${planId}'`);
}

function lostWhileAcquiring(planId: string, why: string, cause?: unknown): Error {
  return new Error(
    `journal: lock-lost while acquiring plan '${planId}' — ${why}`,
    cause === undefined ? undefined : { cause },
  );
}

interface PublicationGuard {
  /** Throws the lease-loss error once the guard lease is reported compromised. */
  assertHeld(): void;
  release(): Promise<void>;
}

async function acquirePublicationGuard(
  path: string,
  planId: string,
  runId: string,
): Promise<PublicationGuard> {
  // The library default throws asynchronously from its refresh timer, outside
  // every try here (process-killing). Record compromise and surface it at the
  // acquisition's fence points as lease loss instead.
  let compromised: Error | undefined;
  let release: () => Promise<void>;
  try {
    const { lock } = await loadLockfile();
    release = await lock(path, {
      ...GUARD_LOCK_OPTIONS,
      onCompromised: (error) => {
        compromised ??= error;
      },
    });
  } catch (error) {
    if (errorCode(error) === 'ELOCKED') throw acquisitionBusy(planId);
    throw new Error(`journal: publication guard for plan '${planId}' run '${runId}' failed`, {
      cause: error,
    });
  }
  return {
    assertHeld(): void {
      if (compromised !== undefined) {
        throw lostWhileAcquiring(planId, 'publication guard lease compromised', compromised);
      }
    },
    async release(): Promise<void> {
      try {
        await release();
      } catch (error) {
        // A compromised lease is already released by the library (ERELEASED)
        // and its directory may be a successor's: nothing of ours remains.
        if (compromised === undefined) throw error;
      }
    },
  };
}

async function acquirePlanLockRecord(
  journalDir: string,
  planId: string,
  runId: string,
  fence: () => void,
): Promise<PlanLock> {
  const path = join(journalDir, `${planId}.lock.json`);
  const nonce = randomUUID();
  const record: PlanLockRecord = {
    nonce,
    // Keep sun_path short on macOS. Contenders always READ this path from
    // the journal record, so differing TMPDIR values cannot split the lock.
    socketPath: `/tmp/cq-j-${nonce}.sock`,
    pid: process.pid,
    host: hostname(),
    bootId: await bootIdentity(),
    runId,
  };
  if (record.bootId.length === 0) throw new Error('journal: cannot determine host boot identity');

  // Every publication is a complete, synced record: a crash can leave only
  // an unreferenced temporary, never an empty or partial canonical record.
  const temporary = `${path}.${nonce}.tmp`;
  try {
    await writeDurable(temporary, `${JSON.stringify(record)}\n`);
    await publishRecord(path, temporary, record, planId, fence);
  } finally {
    await unlink(temporary).catch((cleanupError: unknown) => {
      if (!isEnoent(cleanupError)) throw cleanupError;
    });
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  // A probe needs only a successful connect. Destroy immediately so a peer
  // withholding EOF cannot hold server.close (and lease release) forever.
  const server = createServer((socket) => socket.destroy());
  let listening = false;
  let released = false;
  const markReleased = async (): Promise<void> => {
    // Publish the tombstone atomically, and only over OUR inode: a rival's
    // replacement (lock lost) is never clobbered. A live owner's unreleased
    // record is never reclaimable, so no rival can publish between the
    // inode check and the rename: replacing it needs the succession claim
    // on our nonce, which no one can take while we are live and unreleased.
    const tombstone = `${path}.${nonce}.released.tmp`;
    try {
      await writeDurable(tombstone, `${JSON.stringify({ ...record, released: true })}\n`);
      const ours = await handle?.stat();
      const current = await stat(path).catch((error: unknown) => {
        if (isEnoent(error)) return undefined;
        throw error;
      });
      if (current === undefined) return;
      // Before the post-publication open there is no handle: our nonce in
      // the record is then the ownership proof.
      if (ours === undefined) {
        if ((await readLockRecord(path)).nonce !== nonce) return;
      } else if (current.dev !== ours.dev || current.ino !== ours.ino) return;
      await rename(tombstone, path);
      await syncDir(journalDir);
    } finally {
      await unlink(tombstone).catch((cleanupError: unknown) => {
        if (!isEnoent(cleanupError)) throw cleanupError;
      });
    }
  };
  const assertHeld = async (): Promise<void> => {
    const lost = (): Error => new Error(`journal: lock-lost for plan '${planId}' run '${runId}'`);
    const current = await readLockRecord(path).catch((error: unknown) => {
      // No canonical record is no lease (publication never empties the
      // name, so only tampering can): nothing of ours is published.
      if (isEnoent(error)) throw lost();
      throw error;
    });
    if (current.nonce !== nonce || current.released === true) throw lost();
  };
  try {
    handle = await open(path, 'r+');
    // Verify the inode opened after publication before touching it.
    const contents = await handle.readFile('utf8');
    if (PlanLockRecordSchema.parse(JSON.parse(contents) as unknown).nonce !== nonce) {
      throw lostWhileAcquiring(planId, 'the published record is not ours');
    }
    await syncDir(journalDir);
    await listen(server, record.socketPath);
    listening = true;
    // The probe socket must never keep the process alive: a detached lease
    // would otherwise hang the CLI. Liveness is still proven while the
    // process runs; release/rollback close the server explicitly.
    server.unref();
    await assertHeld();
    fence();
  } catch (error) {
    try {
      if (listening) await closeServer(server);
      // Publication and owner setup are one rollback scope; markReleased
      // only ever replaces a record that is provably ours.
      await markReleased();
    } finally {
      await handle?.close();
    }
    throw error;
  }

  const owned = handle;
  let serverClosed = false;
  return {
    assertHeld,
    async release(): Promise<void> {
      if (released) return;
      // Only a published tombstone completes release; a failure leaves the
      // handle open so a retry can still fence on our inode.
      if (!serverClosed) {
        await closeServer(server);
        serverClosed = true;
      }
      await markReleased();
      released = true;
      await owned.close();
      await unlink(record.socketPath).catch((error: unknown) => {
        if (!isEnoent(error)) throw error;
      });
    },
  };
}

async function writeDurable(path: string, contents: string): Promise<void> {
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Exclusive create via link(2); otherwise reclaim an eligible record under
 * a succession claim. `fence` is the publication guard's lease check: a
 * compromise already recorded refuses before publication is attempted; one
 * recorded during the awaited link or rename is detected at the next fence
 * (after owner setup), and anything published is rolled back.
 */
async function publishRecord(
  path: string,
  temporary: string,
  record: PlanLockRecord,
  planId: string,
  fence: () => void,
): Promise<void> {
  fence();
  try {
    await link(temporary, path);
    return;
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error;
  }
  let previous: PlanLockRecord;
  try {
    previous = await readLockRecord(path);
  } catch (readError) {
    throw new Error(`journal: corrupt or half-written plan lock '${path}' — refusing acquisition`, {
      cause: readError,
    });
  }
  // A retransmitted link (NFS) can report EEXIST for the very link that
  // published OUR record: our nonce in it is the ownership proof.
  if (previous.nonce === record.nonce) return;
  await assertReclaimable(previous, record);
  await claimSuccession(path, temporary, record, previous, planId, fence);
}

/** Refuses unless `previous` is released, or provably dead on this host. */
async function assertReclaimable(previous: PlanLockRecord, record: PlanLockRecord): Promise<void> {
  if (previous.released === true) return;
  // A foreign host's liveness evidence is unverifiable from here; only its
  // explicit release tombstone makes the record reclaimable.
  if (previous.host !== record.host) {
    throw new Error(
      `journal: plan locked by foreign host '${previous.host}' run '${previous.runId}'`,
    );
  }
  if (
    (await socketIsAlive(previous.socketPath)) ||
    (previous.bootId === record.bootId && pidIsAlive(previous.pid))
  ) {
    throw new Error(`journal: plan locked by '${previous.runId}'`);
  }
}

/**
 * Succession claims: the fence that makes a stale or stolen publication
 * guard unable to publish over a live owner. POSIX has no conditional
 * rename, and the guard lease can be taken over from a holder stalled past
 * `stale` between its eligibility decision and its publication. So every
 * replacement of a record is authorized by EXCLUSIVE creation of
 * `<lock>.<predecessor nonce>.claim` — a link of our synced temporary, so
 * the claim names its claimant whole. Each record can be claimed exactly
 * once, and claims are never removed (one per reclamation, kept as
 * evidence like seq tombstones), so the claims form one chain and the
 * canonical record only ever advances along it. A judgment that went stale
 * finds its claim taken and walks the chain forward instead of renaming
 * over whatever is canonical now. A claimant is walked past when:
 *
 *   - it is itself claimed: its claimant proved it released, aborted or
 *     dead, and those facts are permanent for a nonce, so a successor claim
 *     is proof it can never own again (no probe of a superseded claimant);
 *   - its claim is released: its publication failed and it abandoned the
 *     claim ({@link abandonClaim}); only a claimant ever marks its own claim;
 *   - its canonical record is its released tombstone, or it is provably dead
 *     (crashed between claim and publication, or after).
 *
 * Otherwise a live (or foreign-host) claimant refuses, exactly as its
 * record would; if it is not canonical it never published, and the refusal
 * names the claim file for an operator. A claim naming OUR nonce is ours (a
 * retransmitted link) and publishes. An unreadable canonical record refuses:
 * only its absence is not corruption.
 *
 * `fence` (the guard lease check) only keeps contention off this path: a
 * compromise noted after a fence still lets the awaited link or rename
 * publish, and is detected at the next fence; anything published is rolled
 * back. Claims, not the guard, are the fence.
 *
 * The canonical name is only ever replaced atomically (rename) by the
 * unique claimant of the chain's tail, or by its owner's own tombstone, so
 * it is never empty and a live owner's record is never displaced: every
 * record between the canonical one and the tail is unpublished, and each
 * was claimed on proof that it is released, aborted or dead.
 */
async function claimSuccession(
  path: string,
  temporary: string,
  record: PlanLockRecord,
  judged: PlanLockRecord,
  planId: string,
  fence: () => void,
): Promise<void> {
  let predecessor = judged;
  // Bounded like claimSeq: a chain this long is corruption, not contention.
  for (let step = 0; step < 10_000; step++) {
    // Eligibility (or the previous step's probe) awaited: re-check the lease
    // before claiming (contention only; see above).
    fence();
    const claim = claimPath(path, predecessor.nonce);
    try {
      await link(temporary, claim);
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
      let claimant: PlanLockRecord;
      try {
        claimant = await readLockRecord(claim);
      } catch (readError) {
        throw new Error(`journal: corrupt plan lock claim '${claim}' — refusing acquisition`, {
          cause: readError,
        });
      }
      // A retransmitted link (NFS) can report EEXIST for the very link that
      // created OUR claim: our nonce in it is the ownership proof.
      if (claimant.nonce !== record.nonce) {
        await assertPassable(path, claim, claimant, record);
        predecessor = claimant;
        continue;
      }
    }
    // The claim is ours alone: this rename can only replace the claimed
    // record or its dead or aborted claimants' successors, never a live owner.
    try {
      await rename(temporary, path);
    } catch (error) {
      // A retransmitted rename (NFS) can fail for the very rename that
      // published OUR record: our nonce in it is the ownership proof.
      const current = await readLockRecord(path).catch(() => undefined);
      if (current?.nonce === record.nonce) return;
      // The publication's own failure is the root cause; an abandonment
      // that fails too leaves the claim live until this process exits.
      await abandonClaim(path, claim, record).catch(() => undefined);
      throw error;
    }
    return;
  }
  throw new Error(
    `journal: plan lock succession for '${planId}' exceeds 10000 claims — refusing acquisition`,
  );
}

function claimPath(path: string, nonce: string): string {
  return `${path}.${nonce}.claim`;
}

/** Refuses unless `claimant` (the holder of `claim`) can be walked past. */
async function assertPassable(
  path: string,
  claim: string,
  claimant: PlanLockRecord,
  record: PlanLockRecord,
): Promise<void> {
  let current: PlanLockRecord | undefined;
  try {
    current = await readLockRecord(path);
  } catch (readError) {
    // Publication never empties the name, so absence is tampering, not a
    // record; anything else unreadable is corruption and fails closed.
    if (!isEnoent(readError)) {
      throw new Error(`journal: corrupt or unreadable plan lock '${path}' — refusing acquisition`, {
        cause: readError,
      });
    }
  }
  try {
    await lstat(claimPath(path, claimant.nonce));
    return; // superseded: claimed on permanent proof it can never own again
  } catch (error) {
    if (!isEnoent(error)) throw error;
  }
  if (claimant.released === true) return; // aborted by its own claimant
  if (current?.nonce === claimant.nonce && current.released === true) return;
  try {
    await assertReclaimable(claimant, record);
  } catch (refusal) {
    if (current?.nonce === claimant.nonce) throw refusal;
    // Neither canonical nor claimed: publishing it, and then being replaced,
    // both need a claim on it, so the claimant never published. Name the
    // claim: no record exists to explain the refusal.
    throw new Error(
      `journal: plan lock claim '${claim}' names run '${claimant.runId}' on host '${claimant.host}', whose record was never published (still publishing, or its publication failed) — if that run's process has exited (same host) or is known dead (foreign host), remove the claim file to unblock acquisition`,
      { cause: refusal },
    );
  }
}

/**
 * Marks OUR claim released after our publication failed, so the walk passes
 * it instead of probing a live pid that will never publish. Only a
 * claimant ever replaces its own claim, and only once it has committed to
 * never publishing under this nonce (the rename failed; the temporary is
 * then discarded). The rename keeps the claim name occupied throughout, so
 * the predecessor can never be claimed twice.
 */
async function abandonClaim(path: string, claim: string, record: PlanLockRecord): Promise<void> {
  const aborted = `${path}.${record.nonce}.aborted.tmp`;
  try {
    // Our nonce in the claim is the ownership proof.
    if ((await readLockRecord(claim)).nonce !== record.nonce) return;
    await writeDurable(aborted, `${JSON.stringify({ ...record, released: true })}\n`);
    await rename(aborted, claim);
    await syncDir(dirname(path));
  } finally {
    await unlink(aborted).catch((cleanupError: unknown) => {
      if (!isEnoent(cleanupError)) throw cleanupError;
    });
  }
}

/**
 * Tail shape of a well-formed runId: `<timestamp>--<random>` — exactly two
 * more dash-free segments after the planId prefix (base36/hex by the
 * generator; case-insensitive so operator-copied evidence is not silently
 * dropped). OWNED HERE because journal.ts owns the runId shape
 * ({@link assertSafeRunId}); every consumer of the shape shares one
 * definition.
 */
const RUN_ID_TAIL = /^[0-9a-z]+--[0-9a-f]+$/i;

/**
 * The resume/seed candidate filter shared by EVERY consumer that picks a
 * plan's runs out of a journal dir (the runner's replay fold, which also
 * seeds the governor). A candidate must carry the `<planId>--` prefix AND the
 * two-segment tail, so a planId that itself ends in `--<segment>` ('a' vs
 * 'a--b') cannot match the other plan's files and a corrupt journal of
 * ANOTHER plan cannot block this plan's reads.
 *
 * Failure direction, named: a genuine evidence file whose tail does not
 * conform (operator-renamed) is skipped — that can only cause RE-RUNS, never
 * a wrong skip, because the per-file planId check still guards every parsed
 * run. System-written runIds always conform.
 */
export function candidateRunsForPlan(runIds: readonly string[], planId: string): string[] {
  return runIds.filter(
    (candidateId) =>
      candidateId.startsWith(`${planId}--`) &&
      RUN_ID_TAIL.test(candidateId.slice(planId.length + 2)),
  );
}

/** The journal surface one open run-log directory exposes. All async, all serializable. */
export interface RunLog {
  /**
   * Append one event as a JSON line to `<journalDir>/<runId>.ndjson`,
   * creating `journalDir` recursively if needed. Validates the event against
   * JournalEventSchema (throws on invalid events) and requires
   * `event.runId === runId`. Appends are serialized through an internal
   * write chain, so lines from concurrent jobs never interleave and land in
   * append-call order. With `{ durable: true }` the line is written through
   * an append-mode file handle and `fdatasync`ed before the promise settles
   * (ADR-0003 annex §2 durability: `reservation-*`-class facts), and the
   * journal DIRECTORY is fsync'd once per run file this process created, so
   * a crash cannot lose the directory entry of a file whose lines are
   * already durable. macOS `F_FULLFSYNC` remains a recorded power-loss
   * residual; process-crash durability does not depend on it.
   */
  append(runId: string, event: JournalEvent, opts?: { durable?: boolean }): Promise<void>;
  /**
   * Parse every line of `<runId>.ndjson` in order. A missing file means "no
   * facts yet" and yields `[]`; an unparsable last line is ignored ONLY when
   * the file has no trailing newline (a torn final write), and whitespace-only
   * trailing lines are dropped as byte-less; any other complete but invalid
   * line — including last — throws (evidence corruption), as does a line
   * whose event.runId does not match the file's run.
   */
  read(runId: string): Promise<JournalEvent[]>;
  /** Run ids present in the dir, files sorted by mtime, oldest first (ties broken by id). */
  runs(): Promise<string[]>;
  /** Derive per-job status by folding this run's events — see {@link deriveJobStatuses}. */
  statusOf(runId: string): Promise<JobStatus[]>;
}

/** Open `journalDir` as a run-log directory. Pure accessor — no I/O until first use. */
export function openRunLog(journalDir: string): RunLog {
  const pathFor = (runId: string): string => join(journalDir, `${runId}.ndjson`);
  // Write chain: each append waits for the previous one, so concurrent job
  // completions produce ordered, non-interleaved lines. A failed write does
  // not poison the chain (later appends still run).
  let tail: Promise<void> = Promise.resolve();
  // Run files this process has already dir-fsynced: the directory entry is
  // durable once, at creation; later appends to a known file skip the dir
  // fsync entirely.
  const dirSynced = new Set<string>();

  return {
    async append(runId, event, opts): Promise<void> {
      assertSafeRunId(runId);
      // Validate BEFORE writing: the journal only ever contains facts that
      // parse. The parsed value is what lands on disk.
      const parsed: JournalEvent = JournalEventSchema.parse(event);
      if (parsed.runId !== runId) {
        throw new Error(
          `journal: event.runId '${parsed.runId}' does not match target run '${runId}'`,
        );
      }
      const line = `${JSON.stringify(parsed)}\n`;
      const durable = opts?.durable === true;
      const write = async (): Promise<void> => {
        await mkdir(journalDir, { recursive: true });
        const isNew = !dirSynced.has(runId);
        if (durable) {
          const handle = await open(pathFor(runId), 'a');
          try {
            await handle.writeFile(line, 'utf8');
            await handle.datasync();
          } finally {
            await handle.close();
          }
        } else {
          await appendFile(pathFor(runId), line, 'utf8');
        }
        if (isNew) {
          dirSynced.add(runId);
          await syncDir(journalDir);
        }
      };
      const next = tail.then(write, write);
      tail = next.catch(() => undefined);
      await next;
    },

    async read(runId: string): Promise<JournalEvent[]> {
      assertSafeRunId(runId);
      return readEvents(runId, pathFor(runId));
    },

    async runs(): Promise<string[]> {
      return listRuns(journalDir);
    },

    async statusOf(runId: string): Promise<JobStatus[]> {
      assertSafeRunId(runId);
      return deriveJobStatuses(await readEvents(runId, pathFor(runId)));
    },
  };
}

// ---------------------------------------------------------------------------
// Internals (also used by deriveJobStatuses tests via the RunLog surface)
// ---------------------------------------------------------------------------

function isEnoent(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'ENOENT'
  );
}

/**
 * fsync the DIRECTORY so a freshly created file's directory entry is durable
 * (annex §2: "the journal directory is fsync'd when a run file is created").
 * A read-mode directory fd + fsync is the POSIX idiom. Some exotic mounts
 * (network FS, certain container overlays) refuse it with EPERM/EACCES/
 * EINVAL/ENOSYS — on those the call is a recorded best-effort no-op: the
 * supported local-filesystem case (the only one the plan lock and resume
 * fold make claims about) gets real dirent durability, and a refusal never
 * blocks an otherwise-successful journal write. macOS F_FULLFSYNC remains a
 * power-loss residual (ADR-0003 §2.5); process-crash durability does not
 * depend on it.
 */
async function syncDir(dir: string): Promise<void> {
  const SOFT_ERRORS = new Set(['EPERM', 'EACCES', 'EINVAL', 'ENOSYS']);
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(dir, 'r');
  } catch (err) {
    if (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      SOFT_ERRORS.has((err as { code?: unknown }).code as string)
    ) {
      return;
    }
    throw err;
  }
  try {
    await handle.sync();
  } catch (err) {
    if (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      SOFT_ERRORS.has((err as { code?: unknown }).code as string)
    ) {
      return;
    }
    throw err;
  } finally {
    await handle.close();
  }
}

/**
 * Claim the next fold-order ordinal for a plan (ADR-0003 annex §2/§3): `seq`
 * is ASSIGNED by exclusive create of `<journalDir>/<planId>.seq.<n>`
 * (`'wx'`), retrying `n + 1` on `EEXIST`, so two contenders can never both
 * write `n` — uniqueness holds by construction, not by lock discipline
 * (critic r2 m-b; the lock is W2.4's and this claim does not wait for it).
 * The claim file is a tombstone: it is never read back, only its existence
 * is the claim. `startAt` is the first ordinal to try — the caller passes
 * 1 + the highest seq folded from the plan's existing journals. The journal
 * dir is created recursively first (the append path's lazy-create contract:
 * a FIRST governed run over a not-yet-existing `--journal-dir` claims its
 * seq instead of failing on the missing dir).
 *
 * Bounded: 10_000 consecutive EEXISTs mean something else is writing these
 * tombstones — corruption, not contention — and throws.
 */
export async function claimSeq(
  journalDir: string,
  planId: string,
  startAt: number,
): Promise<number> {
  if (!Number.isInteger(startAt) || startAt < 1) {
    throw new Error(`journal: claimSeq startAt must be an integer >= 1, got ${startAt}`);
  }
  await mkdir(journalDir, { recursive: true });
  for (let n = startAt; n < startAt + 10_000; n++) {
    try {
      // The exclusive open IS the claim — the tombstone's existence, never
      // its content (it is not read back). Closed immediately so a claimed
      // seq does not pin the descriptor for the process lifetime.
      const handle = await open(join(journalDir, `${planId}.seq.${n}`), 'wx');
      await handle.close();
      return n;
    } catch (err) {
      if (
        typeof err === 'object' &&
        err !== null &&
        'code' in err &&
        (err as { code?: unknown }).code === 'EEXIST'
      ) {
        continue;
      }
      throw err;
    }
  }
  throw new Error(
    `journal: claimSeq could not claim a seq for plan '${planId}' after 10000 attempts starting at ${startAt}`,
  );
}

/** One parsed run of a plan, for fold ordering. */
export interface FoldRun {
  runId: string;
  events: readonly JournalEvent[];
}

/**
 * THE HIGHEST-CLAIM CHECK — the reader-side check for {@link claimSeq}.
 * Called with the highest `seq` folded from run-started events: a claim
 * tombstone (`<planId>.seq.<n>`) beyond it means a seq was claimed but its
 * run is gone. Refuse that trailing gap instead of silently lowering the
 * seeded spend. This max-only comparison does NOT detect deletion of an
 * interior run when a higher-seq run remains; it is not a contiguity check.
 *
 * Fail-closed trade, named: a crash between `claimSeq` and the first append
 * leaves an ORPHAN tombstone that also trips this check — the next run
 * refuses with this error until the operator deletes the named tombstone
 * (nothing was dispatched under a claimed-but-unstarted seq, so deleting it
 * is safe and the claim retries at that ordinal). That is the honest
 * direction: a one-file operator fix beats a ledger that silently forgets
 * spend.
 */
export async function assertNoSeqGap(
  journalDir: string,
  planId: string,
  maxFoldedSeq: number,
): Promise<void> {
  let names: string[];
  try {
    names = await readdir(journalDir);
  } catch (err) {
    if (isEnoent(err)) return; // no dir yet — no tombstones exist
    throw err;
  }
  const prefix = `${planId}.seq.`;
  let maxTombstone = 0;
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const ordinal = Number(name.slice(prefix.length));
    if (Number.isInteger(ordinal) && ordinal > maxTombstone) maxTombstone = ordinal;
  }
  if (maxTombstone > maxFoldedSeq) {
    throw new Error(
      `journal: corrupt — seq gap for plan '${planId}': claim tombstone '${prefix}${maxTombstone}' exists ` +
        `but the highest folded run-started seq is ${maxFoldedSeq} — a claimed run's file is missing, so its ` +
        `spend cannot seed the ledger. If the tombstone is an orphaned claim (a crash between claimSeq and ` +
        `the first append), delete '${prefix}${maxTombstone}' and re-run.`,
    );
  }
}

/**
 * THE FOLD ORDER (ADR-0003 annex §3, r1 m4): v1 runs (run-started without
 * `journalVersion`) ordered by `at` then runId, ALL before every v2 run; v2
 * runs ordered by `seq`. The injected clock can no longer reorder the fold —
 * `at` is display-only for v2 runs. Corruption is loud: a v2 run without
 * `seq`, two v2 runs of the plan sharing one `seq`, or a SURVIVING run file
 * whose line count disagrees with its `run-finished.eventCount` all throw
 * (annex §2 — uniqueness holds by construction for writers; a violation on
 * READ is a corrupted dir, never silently folded).
 */
export function foldOrderRuns(runs: readonly FoldRun[]): FoldRun[] {
  const v1: Array<{ run: FoldRun; at: string }> = [];
  const v2: Array<{ run: FoldRun; seq: number }> = [];
  for (const run of runs) {
    const started = run.events.find(
      (event): event is Extract<JournalEvent, { type: 'run-started' }> =>
        event.type === 'run-started',
    );
    if (started === undefined) {
      throw new Error(
        `journal: fold order requires a run-started event; run '${run.runId}' has none`,
      );
    }
    // THE LINE-COUNT CHECK (W2.3 fix round, comp 2): a line DELETED from a
    // surviving run file is the one corruption the paired-line throws cannot
    // see — deleting a crashed dispatch's `reservation-opened` would drop
    // the run out of the reservation era entirely (its full charge vanishes
    // and the quarantine never fires). A run-finished that survived carries
    // the file's total line count; a mismatch is loud. A torn TAIL loses
    // run-finished itself, so the check is skipped exactly where the crash
    // windows live; v1 runs and journal-less shapes carry no count.
    const finished = run.events.find((event) => event.type === 'run-finished');
    const eventCount =
      finished !== undefined && finished.type === 'run-finished' ? finished.eventCount : undefined;
    if (eventCount !== undefined && eventCount !== run.events.length) {
      throw new Error(
        `journal: corrupt — run '${run.runId}' journalled ${eventCount} events but folds ${run.events.length}: ` +
          `a line was deleted from (or inserted into) a surviving run file — its spend evidence is untrustworthy, ` +
          `never silently folded`,
      );
    }
    if (started.journalVersion === undefined) {
      v1.push({ run, at: started.at });
    } else {
      if (started.seq === undefined) {
        throw new Error(
          `journal: corrupt — v2 run '${run.runId}' (plan '${started.planId}') has no seq`,
        );
      }
      v2.push({ run, seq: started.seq });
    }
  }
  v1.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.run.runId < b.run.runId ? -1 : 1));
  v2.sort((a, b) => a.seq - b.seq);
  let previous: { run: FoldRun; seq: number } | undefined;
  for (const entry of v2) {
    if (previous !== undefined && entry.seq === previous.seq) {
      throw new Error(
        `journal: corrupt — duplicate seq ${entry.seq} across runs '${previous.run.runId}' and '${entry.run.runId}'`,
      );
    }
    previous = entry;
  }
  return [...v1.map((entry) => entry.run), ...v2.map((entry) => entry.run)];
}

/** Parse one journal line: JSON.parse then JournalEventSchema; null when either fails. */
function parseLine(line: string): JournalEvent | null {
  let data: unknown;
  try {
    data = JSON.parse(line);
  } catch {
    return null;
  }
  const result = JournalEventSchema.safeParse(data);
  return result.success ? result.data : null;
}

async function readEvents(fileRunId: string, path: string): Promise<JournalEvent[]> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if (isEnoent(err)) return []; // no facts yet for this runId
    throw err;
  }
  if (raw === '') return [];
  // Torn-tail detection BEFORE splitting: tolerance applies only when the
  // final write never completed (no trailing newline). A file that ends with
  // '\n' consists solely of complete lines — an invalid one is corruption,
  // even in last position. Whitespace-only trailing lines are the one
  // exception: they carry no event bytes (benign `echo '' >>` damage, not a
  // torn write of an event), so they are dropped, while a whitespace line in
  // the MIDDLE still throws — there it is a hole in the evidence.
  const tornTail = !raw.endsWith('\n');
  const lines = raw.split('\n');
  if (lines[lines.length - 1] === '') {
    lines.pop(); // file ended with a complete newline; the '' split artifact is not an event
  }
  while (lines.at(-1)?.trim() === '') {
    lines.pop();
  }
  const events: JournalEvent[] = [];
  for (const [i, line] of lines.entries()) {
    const parsed = parseLine(line);
    if (parsed !== null) {
      // The file name is the run identity (append enforces the same match at
      // write time), so a line claiming another runId is misattributed
      // evidence — e.g. operator-concatenated journals — and must throw, not
      // silently fold into the wrong run.
      if (parsed.runId !== fileRunId) {
        throw new Error(
          `journal: corrupt line ${i + 1} of ${path} — event.runId '${parsed.runId}' does not ` +
            `match this file's run '${fileRunId}'`,
        );
      }
      events.push(parsed);
      continue;
    }
    if (i === lines.length - 1 && tornTail) {
      break; // torn tail: crash mid-append, only an UNTERMINATED last line may be lost
    }
    throw new Error(
      `journal: corrupt line ${i + 1} of ${path} — a complete but invalid line is corruption; ` +
        'only a trailing torn line (one without a trailing newline) is tolerated',
    );
  }
  return events;
}

async function listRuns(journalDir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(journalDir);
  } catch (err) {
    if (isEnoent(err)) return []; // no runs yet
    throw err;
  }
  const runIds = names
    .filter((name) => name.endsWith('.ndjson'))
    .map((name) => name.slice(0, -'.ndjson'.length));
  const mtimeMs = new Map<string, number>();
  await Promise.all(
    runIds.map(async (runId) => {
      const stats = await stat(join(journalDir, `${runId}.ndjson`));
      mtimeMs.set(runId, stats.mtimeMs);
    }),
  );
  // Oldest first; ties broken by id so the order is deterministic.
  return runIds.sort((a, b) => (mtimeMs.get(a) ?? 0) - (mtimeMs.get(b) ?? 0) || (a < b ? -1 : 1));
}

/**
 * THE derivation rules (status is a fold over journal facts, in file order —
 * later facts win; output order is first appearance of each job):
 *
 *   - `job-started`                → `running` (a retry after a finish puts the
 *                                    job back to `running`).
 *   - `job-finished` result `ok`   → `done`
 *   - `job-finished` result `failed` → `failed`
 *   - `job-finished` result `budget-exhausted` → `budget-exhausted`
 *   - `job-finished` result `needs-human` or `indeterminate` → no frozen
 *     JobState is faithful (JobState has no needs-human value; `blocked`
 *     means waiting on dependencies; `failed` would overstate). The job
 *     KEEPS ITS LAST DERIVED STATE (typically `running`), so a resumed run
 *     re-dispatches it — the honest posture for an outcome that is not a
 *     verdict. KNOWN FRICTION with the T1.1 freeze (worked around, not
 *     edited): reported for the types-freeze owners.
 *   - Jobs never started do not appear at all: a journal only records facts
 *     about work actually dispatched, so the missing ids ARE the "to run"
 *     list for resume. `queued` and `blocked` are likewise not derivable —
 *     job-started events carry no dependency info.
 *   - `run-started` / `run-finished` carry no per-job facts here. Run-level
 *     budget-exhausted marking arrives with T1.3's run-level events.
 */
export function deriveJobStatuses(events: readonly JournalEvent[]): JobStatus[] {
  const states = new Map<string, JobState>();
  for (const event of events) {
    switch (event.type) {
      case 'job-started':
        states.set(event.jobId, 'running');
        break;
      case 'job-finished':
        switch (event.result.status) {
          case 'ok':
            states.set(event.jobId, 'done');
            break;
          case 'failed':
            states.set(event.jobId, 'failed');
            break;
          case 'budget-exhausted':
            states.set(event.jobId, 'budget-exhausted');
            break;
          case 'needs-human':
          case 'indeterminate':
            // No faithful frozen state — keep the last derived state.
            break;
        }
        break;
      case 'run-started':
      case 'run-finished':
      case 'reservation-opened':
      case 'reservation-settled':
      case 'reservation-refused':
      case 'job-quarantined':
      case 'quarantine-released':
      case 'budget-tripped':
        break; // no per-job VERDICT facts (a quarantine is not a terminal verdict; the governed runner owns it)
    }
  }
  return [...states].map(([jobId, state]) => ({ jobId, state }));
}
