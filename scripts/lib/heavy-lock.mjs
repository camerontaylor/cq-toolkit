// Host-wide single-flight lock for heavy local work (test-rationing plan P1;
// consumed by scripts/test-narrow.mjs). Node, not flock(1): stock macOS has
// no flock, and the lock must behave identically on macOS and Linux.
//
// Protocol (every step is synchronous, so the release can run from an
// `exit` handler):
//   - acquire = atomic mkdir of LOCK_PATH, then owner.json written via a
//     temp file + rename (a reader sees the whole record or none of it);
//     `annotate` later adds the pid of the owner's detached child group and
//     that group leader's start time (its identity);
//   - the holder is LIVE while its pid runs AND that process started no later
//     than the record (a later start time means the pid was reused), or while
//     its recorded child process group still runs;
//   - the lock is STALE when the holder is not live, when owner.json is still
//     absent MISSING_OWNER_MS after the mkdir (the owner died in between), or
//     when the record is older than MAX_HOLD_MS (last-resort ceiling;
//     test-narrow kills its own run long before that);
//   - an orphaned child group (owner dead, group still running) is killed
//     before the lock is reclaimed: nobody is left to read its result. Only
//     when its leader still has the recorded start time: a pgid can be
//     reused, so an unverifiable group (leader gone, identity changed, or a
//     record without one) is never signalled; the lock is reclaimed anyway;
//   - reclaim runs under a short-lived guard directory (one reclaimer at a
//     time) and removes the lock only if it still holds the record judged
//     stale; a lock is never renamed or removed while it might be live;
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
/** EX_TEMPFAIL (sysexits.h): the lock stayed busy for the whole wait. */
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

/** Why the current holder no longer counts, or null while it is live. */
export function staleReason(holder, dirMtimeMs, { now, isAlive: alive, groupAlive }) {
  if (holder === null) {
    return now - dirMtimeMs > MISSING_OWNER_MS ? 'no owner record' : null;
  }
  const started = Date.parse(holder.startedAt);
  if (Number.isFinite(started) && now - started > MAX_HOLD_MS) return 'held past MAX_HOLD_MS';
  if (alive(holder.pid, holder.startedAt)) return null;
  if (typeof holder.childPgid === 'number' && groupAlive(holder.childPgid)) {
    return `owner pid ${holder.pid} is gone; orphaned child group ${holder.childPgid}`;
  }
  return `owner pid ${holder.pid} is gone`;
}

export function describeHolder(holder) {
  if (holder === null) return 'an owner that has not written its record yet';
  return `pid ${holder.pid} since ${holder.startedAt} (cwd ${holder.cwd}; ${holder.command})`;
}

/**
 * Wait (bounded) for the lock. Resolves {acquired: true, waitedMs, release,
 * annotate} or {acquired: false, waitedMs, holder} once maxWaitMs has
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

  const writeRecord = () => {
    const temp = join(path, `owner.${token}.tmp`);
    fs.writeFileSync(temp, `${JSON.stringify(record)}\n`);
    fs.renameSync(temp, ownerFile(path));
  };
  const release = () => {
    if (readOwner(path, fs)?.token === token) fs.rmSync(path, { recursive: true, force: true });
  };
  /** Record our child group, and its leader's identity, while we still hold the lock. */
  const annotate = ({ childPgid }) => {
    if (readOwner(path, fs)?.token !== token) return;
    const startMs = deps.processStartMs(childPgid);
    const childStartedAt = startMs === null ? undefined : new Date(startMs).toISOString();
    record = { ...record, childPgid, childStartedAt };
    writeRecord();
  };
  /** Why the recorded group may not be signalled, or null when its leader is verified. */
  const unverified = (owner) => {
    const recorded = Date.parse(owner.childStartedAt);
    if (!Number.isFinite(recorded)) return 'the record has no leader start time';
    const actual = deps.processStartMs(owner.childPgid);
    if (actual === null) return 'its leader is gone or unreadable';
    return Math.abs(actual - recorded) <= START_SLACK_MS ? null : 'its leader was reused';
  };

  const tryCreate = () => {
    try {
      fs.mkdirSync(path);
    } catch (error) {
      if (error.code === 'EEXIST') return false;
      throw error;
    }
    record = {
      pid: deps.pid,
      token,
      host: hostname(),
      cwd: info.cwd,
      command: info.command,
      startedAt: new Date(deps.now()).toISOString(),
    };
    writeRecord();
    return true;
  };

  /** Remove the lock iff it still holds the judged record; false = retry later. */
  const reclaim = (judged, judgedMtimeMs, reason) => {
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
      if (typeof judged?.childPgid === 'number' && deps.groupAlive(judged.childPgid)) {
        const why = unverified(judged);
        if (why === null) {
          deps.killGroup(judged.childPgid);
          deps.log(`heavy-lock: killed orphaned child group ${judged.childPgid}`);
        } else {
          deps.log(
            `heavy-lock: not killing process group ${judged.childPgid}: ${why}; ` +
              'treating the lock as stale',
          );
        }
      }
      fs.rmSync(path, { recursive: true, force: true });
      deps.log(`heavy-lock: reclaimed a stale lock (${reason})`);
    } finally {
      fs.rmSync(guard, { recursive: true, force: true });
    }
  };

  for (;;) {
    if (tryCreate()) return { acquired: true, waitedMs: deps.now() - start, release, annotate };
    const holder = readOwner(path, fs);
    let dirMtimeMs;
    try {
      dirMtimeMs = fs.statSync(path).mtimeMs;
    } catch (error) {
      if (error.code === 'ENOENT') continue; // released between mkdir and stat
      throw error;
    }
    const now = deps.now();
    const reason = staleReason(holder, dirMtimeMs, { ...deps, now });
    if (reason !== null) {
      reclaim(holder, dirMtimeMs, reason);
      if (!fs.existsSync(path)) continue;
    }
    const waitedMs = now - start;
    if (waitedMs >= maxWaitMs) {
      return { acquired: false, waitedMs, holder: readOwner(path, fs) ?? holder };
    }
    if (reason === null && now - lastReport >= REPORT_EVERY_MS) {
      lastReport = now;
      deps.log(
        `heavy-lock: waiting for the host lock ${path}, held by ${describeHolder(holder)}; ` +
          `waited ${Math.round(waitedMs / 1000)}s of at most ${Math.round(maxWaitMs / 1000)}s`,
      );
    }
    await deps.sleep(Math.min(poll, maxWaitMs - waitedMs));
    poll = Math.min(poll * 2, MAX_POLL_MS);
  }
}
