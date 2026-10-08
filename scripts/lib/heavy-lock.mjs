// Host-wide single-flight lock for heavy local work (test-rationing plan P1;
// consumed by scripts/test-narrow.mjs). Node, not flock(1): stock macOS has
// no flock, and the lock must behave identically on macOS and Linux.
//
// Protocol (every step is synchronous, so the release can run from an
// `exit` handler):
//   - acquire = atomically mkdir LOCK_PATH (never replace an existing directory),
//     then initialize owner.json via a token-specific temp file + rename inside
//     the directory we created, checking its identity and initialization grace.
//     A paused creator cannot publish into another holder's directory. Later
//     record writes verify our token before
//     writing the temp file and again before renaming it into place;
//     `annotate` later adds the pid of the owner's detached child group and
//     that group leader's start time (its identity);
//   - the holder is LIVE while its pid runs AND that process started no later
//     than the record (a later start time means the pid was reused);
//   - an orphaned child group (owner dead, group still running) is VERIFIED
//     when its leader still runs with the recorded start time. A verified
//     orphan is killed (nobody is left to read its result) and the lock is
//     reclaimed only once the group has exited: SIGKILL is asynchronous, so
//     a later poll re-judges it, within the bounded wait. A pgid can be reused, so an alive but UNVERIFIABLE group
//     (leader gone while workers remain, identity changed, or a record
//     without one) is never signalled and keeps the lock BUSY: waiting is
//     safe, overlapping is not;
//   - the lock is STALE when the owner is dead and no unverifiable group
//     runs, when owner.json is still absent MISSING_OWNER_MS after the mkdir
//     (the owner died in between), or when the record is older than
//     MAX_HOLD_MS with no live owner or running group. A dead owner
//     with an unrecorded pending spawn stays busy indefinitely: its child
//     cannot be identified. Only an operator who checked for stray heavy
//     processes may clear it manually (test:narrow --help).
//     An unverifiable running group stays busy even beyond that ceiling;
//   - reclaim runs under a short-lived guard directory (one reclaimer at a
//     time), re-judges the record under the guard, and removes the lock only
//     by atomically renaming it to a unique tombstone. Only a tombstone
//     with the judged token is removed; a moved fresh record is restored
//     when possible, otherwise preserved with a loud warning. Holders
//     re-check their token immediately before every heavy child spawn;
//   - release removes the directory only while it still holds OUR token.
// The path is fixed (not $TMPDIR, which differs between agent harnesses on
// one host): every worktree and every agent of the host contends on it.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as nodeFs from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';

export const LOCK_PATH =
  process.platform === 'win32'
    ? join(tmpdir(), 'cq-toolkit-heavy.lock')
    : '/tmp/cq-toolkit-heavy.lock';
/** EX_TEMPFAIL (sysexits.h): the lock stayed busy or ownership was lost before a spawn. */
export const EX_TEMPFAIL = 75;
export const MISSING_OWNER_MS = 30_000;
export const MAX_HOLD_MS = 2 * 60 * 60 * 1000;
export const REPORT_EVERY_MS = 30_000;
/** A reclaim guard older than this belongs to a reclaimer that died. */
export const GUARD_STALE_MS = 30_000;
const FIRST_POLL_MS = 250;
const MAX_POLL_MS = 5_000;
/** `ps -o lstart` has one-second resolution. */
const START_SLACK_MS = 2_000;

const signalable = (target) => {
  try {
    process.kill(target, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};

/** Start time of a running pid via `ps -o lstart=` (macOS and Linux), or null. */
function processStartMs(pid) {
  if (process.platform === 'win32') return null;
  const res = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C' }, // local time, which Date.parse also assumes
  });
  if (res.status !== 0) return null;
  const ms = Date.parse(res.stdout.trim().replace(/\s+/g, ' '));
  return Number.isFinite(ms) ? ms : null;
}

/** The recorded owner is still the process that wrote the record. */
export function isAlive(pid, startedAt) {
  if (!signalable(pid)) return false;
  const started = Date.parse(startedAt);
  const actual = processStartMs(pid);
  // Unknown start times count as alive: waiting is safe, overlapping is not.
  return actual === null || !Number.isFinite(started) || actual <= started + START_SLACK_MS;
}

const defaultDeps = () => ({
  fs: nodeFs,
  now: Date.now,
  isAlive,
  processStartMs,
  groupAlive: (pgid) => process.platform !== 'win32' && signalable(-pgid),
  killGroup: (pgid) => {
    try {
      process.kill(-pgid, 'SIGKILL');
    } catch {
      // already gone
    }
  },
  sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
  log: (line) => process.stderr.write(`${line}\n`),
  pid: process.pid,
  token: randomUUID,
});

const ownerFile = (dir) => join(dir, 'owner.json');

/** The parsed owner record, or null when absent or unreadable. */
export function readOwner(dir, fs = nodeFs) {
  try {
    const owner = JSON.parse(fs.readFileSync(ownerFile(dir), 'utf8'));
    return typeof owner?.pid === 'number' && typeof owner?.token === 'string' ? owner : null;
  } catch {
    return null;
  }
}

/** Why a recorded child group may not be signalled, or null when its leader is the recorded one. */
function unverifiedGroup(holder, processStartMs) {
  const recorded = Date.parse(holder.childStartedAt);
  if (!Number.isFinite(recorded)) return 'the record has no leader start time';
  const actual = processStartMs(holder.childPgid);
  if (actual === null) return 'its leader is gone or unreadable';
  return Math.abs(actual - recorded) <= START_SLACK_MS ? null : 'its leader was reused';
}

/** Signal only an extant group whose live leader has the recorded identity. */
export function canSignalGroup(holder, deps = defaultDeps()) {
  const pgid = holder?.childPgid;
  if (typeof pgid !== 'number' || !deps.groupAlive(pgid)) return false;
  if (!deps.isAlive(pgid)) return false;
  return unverifiedGroup(holder, deps.processStartMs) === null;
}

/** The reclaim reason (null while busy), verified orphan to kill, and busy note. */
export function judgeHolder(holder, dirMtimeMs, deps) {
  const { now, isAlive: alive, groupAlive, processStartMs } = deps;
  if (holder === null) {
    return { reason: now - dirMtimeMs > MISSING_OWNER_MS ? 'no owner record' : null };
  }
  const started = Date.parse(holder.startedAt);
  const expired = Number.isFinite(started) && now - started > MAX_HOLD_MS;
  if (alive(holder.pid, holder.startedAt)) return { reason: null };
  const pgid = holder.childPgid;
  if (holder.childPending && typeof pgid !== 'number') {
    return {
      reason: null,
      note:
        `owner ${holder.pid} died between spawning a child and recording it; the child cannot be identified, so the lock is kept; ` +
        'manual recovery requires pausing callers and checking for stray heavy processes before removing the lock (see pnpm test:narrow --help)',
    };
  }
  if (typeof pgid !== 'number' || !groupAlive(pgid)) {
    return { reason: expired ? 'held past MAX_HOLD_MS' : `owner pid ${holder.pid} is gone` };
  }
  const why = alive(pgid)
    ? unverifiedGroup(holder, processStartMs)
    : 'its leader is gone or unreadable';
  if (why === null) {
    const owner = expired ? 'held past MAX_HOLD_MS' : `owner pid ${holder.pid} is gone`;
    return { reason: `${owner}; orphaned child group ${pgid}`, kill: pgid };
  }
  return {
    reason: null,
    note: `owner pid ${holder.pid} is gone, but its child group ${pgid} still runs and cannot be verified (${why}); never killed, the lock stays busy`,
  };
}

export function describeHolder(holder) {
  if (holder === null) return 'an owner that has not written its record yet';
  return `pid ${holder.pid} since ${holder.startedAt} (cwd ${holder.cwd}; ${holder.command})`;
}

/**
 * Wait (bounded) for the lock. Resolves {acquired: true, waitedMs, release,
 * annotate, stillHeld} or {acquired: false, waitedMs, holder} once maxWaitMs has
 * elapsed. `info` = {cwd, command} is recorded for whoever waits behind us.
 */
export async function acquireLock({ path = LOCK_PATH, maxWaitMs, info, deps: overrides = {} }) {
  const deps = { ...defaultDeps(), ...overrides };
  const { fs } = deps;
  const start = deps.now();
  const token = deps.token();
  const guard = `${path}.reclaim`;
  let poll = FIRST_POLL_MS;
  let lastReport = -Infinity;
  let record = null;

  const stillHeld = () => readOwner(path, fs)?.token === token;
  const writeRecord = (ownsDirectory = stillHeld) => {
    if (!ownsDirectory()) return false;
    const temp = join(path, `owner.${token}.tmp`);
    try {
      fs.writeFileSync(temp, `${JSON.stringify(record)}\n`, { flag: 'wx' });
      if (!ownsDirectory()) return false;
      fs.renameSync(temp, ownerFile(path));
      return stillHeld();
    } finally {
      fs.rmSync(temp, { force: true });
    }
  };
  const release = () => {
    if (readOwner(path, fs)?.token === token) fs.rmSync(path, { recursive: true, force: true });
  };
  /**
   * Record our current child group, and its leader's identity, while we
   * still hold the lock; `childPgid: null` clears it once the group is gone.
   */
  const annotate = ({ childPgid, childPending = false }) => {
    if (!stillHeld()) return;
    const startMs = typeof childPgid === 'number' ? deps.processStartMs(childPgid) : null;
    const childStartedAt = startMs === null ? undefined : new Date(startMs).toISOString();
    record = {
      ...record,
      childPgid: childPgid ?? undefined,
      childStartedAt,
      childPending: childPending || undefined,
      childPendingAt: childPending ? new Date(deps.now()).toISOString() : undefined,
    };
    if (writeRecord()) return record;
  };

  const tryCreate = () => {
    const createdAt = deps.now();
    try {
      // mkdir is exclusive even when a legacy caller just created an empty
      // directory: POSIX rename, unlike mkdir, could replace that directory.
      fs.mkdirSync(path);
    } catch (error) {
      if (error.code === 'EEXIST' || error.code === 'ENOTEMPTY') return false;
      throw error;
    }
    // If paused before recording identity, the empty directory could already
    // have passed the legacy grace and been reclaimed. Never initialize then.
    if (deps.now() - createdAt >= MISSING_OWNER_MS) return false;
    // Initialization failures leave the directory for the legacy grace/reclaim
    // path; never remove a path whose owner token we have not published.
    try {
      const created = fs.statSync(path);
      const ownsInitialization = () => {
        if (deps.now() - createdAt >= MISSING_OWNER_MS) return false;
        const current = fs.statSync(path);
        return (
          current.dev === created.dev &&
          current.ino === created.ino &&
          current.birthtimeMs === created.birthtimeMs &&
          readOwner(path, fs) === null
        );
      };
      record = {
        pid: deps.pid,
        token,
        host: hostname(),
        cwd: info.cwd,
        command: info.command,
        startedAt: new Date(deps.now()).toISOString(),
      };
      // Only this successful mkdir authorizes an absent-owner initialization.
      // Recheck identity before the temp write and before its rename. If a
      // reclaimer moves the directory after the latter check, it also moves
      // our unique temp file, so publication into a replacement fails closed.
      return writeRecord(ownsInitialization);
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  };

  /** Remove the lock iff it still holds the judged record and is still stale. */
  const reclaim = (judged, judgedMtimeMs) => {
    try {
      fs.mkdirSync(guard);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        if (deps.now() - fs.statSync(guard).mtimeMs > GUARD_STALE_MS) {
          fs.rmSync(guard, { recursive: true, force: true });
        }
      } catch {
        // the guard went away meanwhile
      }
      return;
    }
    try {
      const current = readOwner(path, fs);
      let mtimeMs;
      try {
        mtimeMs = fs.statSync(path).mtimeMs;
      } catch {
        return; // released or reclaimed already
      }
      const same =
        judged === null
          ? current === null && mtimeMs === judgedMtimeMs
          : current?.token === judged.token;
      if (!same) return;
      // Re-judged under the guard: the group may have changed since.
      const verdict = judgeHolder(current, mtimeMs, { ...deps, now: deps.now() });
      if (verdict.reason === null) return;
      if (verdict.kill !== undefined) {
        if (!canSignalGroup(current, deps)) return;
        // SIGKILL lands asynchronously: keep the lock until the group is gone
        // (a later poll finds it dead and reclaims).
        deps.killGroup(verdict.kill);
        deps.log(
          `heavy-lock: killed orphaned child group ${verdict.kill}; reclaiming once it exits`,
        );
        return;
      }
      const tombstone = `${path}.reclaim-${deps.token()}`;
      try {
        fs.renameSync(path, tombstone);
      } catch (error) {
        if (error.code === 'ENOENT') return;
        throw error;
      }
      const moved = readOwner(tombstone, fs);
      const matches =
        judged === null
          ? moved === null && fs.statSync(tombstone).mtimeMs === judgedMtimeMs
          : moved?.token === judged.token;
      if (!matches) {
        try {
          fs.renameSync(tombstone, path);
        } catch (error) {
          deps.log(
            `heavy-lock: WARNING: moved a fresh holder's lock; restore failed (${error.code}); preserved ${tombstone}; holder must stop before spawning`,
          );
        }
        return;
      }
      fs.rmSync(tombstone, { recursive: true, force: true });
      deps.log(`heavy-lock: reclaimed a stale lock (${verdict.reason})`);
    } finally {
      fs.rmSync(guard, { recursive: true, force: true });
    }
  };

  for (;;) {
    if (tryCreate())
      return { acquired: true, waitedMs: deps.now() - start, release, annotate, stillHeld };
    const holder = readOwner(path, fs);
    let dirMtimeMs;
    try {
      dirMtimeMs = fs.statSync(path).mtimeMs;
    } catch (error) {
      if (error.code === 'ENOENT') continue; // released between mkdir and stat
      throw error;
    }
    const now = deps.now();
    const { reason, note } = judgeHolder(holder, dirMtimeMs, { ...deps, now });
    if (reason !== null) {
      reclaim(holder, dirMtimeMs);
      if (!fs.existsSync(path)) continue;
    }
    const waitedMs = now - start;
    if (reason === null && now - lastReport >= REPORT_EVERY_MS) {
      lastReport = now;
      deps.log(
        `heavy-lock: waiting for the host lock ${path}, held by ${describeHolder(holder)}; ` +
          (note === undefined ? '' : `${note}; `) +
          `waited ${Math.round(waitedMs / 1000)}s of at most ${Math.round(maxWaitMs / 1000)}s`,
      );
    }
    if (waitedMs >= maxWaitMs) {
      return { acquired: false, waitedMs, holder: readOwner(path, fs) ?? holder };
    }
    await deps.sleep(Math.min(poll, maxWaitMs - waitedMs));
    poll = Math.min(poll * 2, MAX_POLL_MS);
  }
}
