// Host-wide single-flight lock for heavy local work (test-rationing plan P1;
// consumed by scripts/test-narrow.mjs). Node, not flock(1): stock macOS has
// no flock, and the lock must behave identically on macOS and Linux.
//
// Protocol (every step is synchronous, so the release can run from an
// `exit` handler):
//   - acquire = atomic mkdir of LOCK_PATH, then owner.json written via a
//     temp file + rename (a reader sees the whole record or none of it);
//   - the lock is STALE when its owner pid is dead (kill(pid, 0) → ESRCH;
//     EPERM means alive), when owner.json is still absent MISSING_OWNER_MS
//     after the mkdir (the owner died in between), or when the record is
//     older than MAX_HOLD_MS (pid-reuse guard: test-narrow kills its own run
//     long before that);
//   - reclaim = rename the stale directory to a unique name (only one waiter
//     wins the rename), confirm it is the record that was judged stale, then
//     remove it; a record that changed in between is renamed back;
//   - release removes the directory only while it still holds OUR token.
// The path is fixed (not $TMPDIR, which differs between agent harnesses on
// one host): every worktree and every agent of the host contends on it.
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
const FIRST_POLL_MS = 250;
const MAX_POLL_MS = 5_000;

export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

const defaultDeps = () => ({
  fs: nodeFs,
  now: Date.now,
  isAlive,
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
export function staleReason(holder, dirMtimeMs, { now, isAlive: alive }) {
  if (holder === null) {
    return now - dirMtimeMs > MISSING_OWNER_MS ? 'no owner record' : null;
  }
  if (!alive(holder.pid)) return `owner pid ${holder.pid} is gone`;
  const started = Date.parse(holder.startedAt);
  if (Number.isFinite(started) && now - started > MAX_HOLD_MS) return 'held past MAX_HOLD_MS';
  return null;
}

export function describeHolder(holder) {
  if (holder === null) return 'an owner that has not written its record yet';
  return `pid ${holder.pid} since ${holder.startedAt} (cwd ${holder.cwd}; ${holder.command})`;
}

/**
 * Wait (bounded) for the lock. Resolves {acquired: true, waitedMs, release}
 * or {acquired: false, waitedMs, holder} once maxWaitMs has elapsed.
 * `info` = {cwd, command} is recorded for whoever waits behind us.
 */
export async function acquireLock({ path = LOCK_PATH, maxWaitMs, info, deps: overrides = {} }) {
  const deps = { ...defaultDeps(), ...overrides };
  const { fs } = deps;
  const start = deps.now();
  const token = deps.token();
  let poll = FIRST_POLL_MS;
  let lastReport = -Infinity;

  const release = () => {
    if (readOwner(path, fs)?.token === token) fs.rmSync(path, { recursive: true, force: true });
  };

  const tryCreate = () => {
    try {
      fs.mkdirSync(path);
    } catch (error) {
      if (error.code === 'EEXIST') return false;
      throw error;
    }
    const record = {
      pid: deps.pid,
      token,
      host: hostname(),
      cwd: info.cwd,
      command: info.command,
      startedAt: new Date(deps.now()).toISOString(),
    };
    const temp = join(path, `owner.${token}.tmp`);
    fs.writeFileSync(temp, `${JSON.stringify(record)}\n`);
    fs.renameSync(temp, ownerFile(path));
    return true;
  };

  const reclaim = (judged, reason) => {
    const moved = `${path}.stale-${deps.pid}-${token}`;
    try {
      fs.renameSync(path, moved);
    } catch (error) {
      if (error.code === 'ENOENT') return; // another waiter reclaimed it first
      throw error;
    }
    const seen = readOwner(moved, fs);
    if ((seen?.token ?? null) === (judged?.token ?? null)) {
      fs.rmSync(moved, { recursive: true, force: true });
      deps.log(`heavy-lock: reclaimed a stale lock (${reason})`);
      return;
    }
    // The directory changed hands between the judgement and the rename: it
    // belongs to a live owner. Put it back (fails only if yet another
    // waiter already created a fresh lock — then the moved one is left for
    // its owner's token-checked release to ignore, and is reported).
    try {
      fs.renameSync(moved, path);
    } catch {
      deps.log(`heavy-lock: WARNING could not restore ${moved}; a concurrent run may overlap`);
    }
  };

  for (;;) {
    if (tryCreate()) return { acquired: true, waitedMs: deps.now() - start, release };
    const holder = readOwner(path, fs);
    let dirMtimeMs;
    try {
      dirMtimeMs = fs.statSync(path).mtimeMs;
    } catch (error) {
      if (error.code === 'ENOENT') continue; // released between mkdir and stat
      throw error;
    }
    const now = deps.now();
    const reason = staleReason(holder, dirMtimeMs, { now, isAlive: deps.isAlive });
    if (reason !== null) {
      reclaim(holder, reason);
      continue;
    }
    const waitedMs = now - start;
    if (waitedMs >= maxWaitMs) return { acquired: false, waitedMs, holder };
    if (now - lastReport >= REPORT_EVERY_MS) {
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
