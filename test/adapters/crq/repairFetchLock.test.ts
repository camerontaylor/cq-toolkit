/**
 * `fileRepairFetchClone` / `fileRepairAdmissionLock`: Python `fetch_clone` and
 * `cooldown_write` over a temp state root. Git is a fake script on a private
 * PATH (or an injected runner); no network, forge, provider or queue host.
 */
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withLock } from '../../../src/adapters/crq/lock.js';
import {
  fileRepairAdmissionLock,
  fileRepairFetchClone,
  type FetchCallResult,
} from '../../../src/adapters/crq/repairFetchLock.js';
import { SlotBusyError } from '../../../src/adapters/lock/slotLock.js';
import { JsonNumber, JsonObject, type JsonValue } from '../../../src/policy/crq/jsonValue.js';

const BUSY = 'crq tick holds tick.lock';
type Wait = () => Promise<JsonValue | undefined>;
let root: string;
let stateRoot: string;
let clone: string;
let bin: string;
let log: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'repair-fetch-lock-'));
  stateRoot = join(root, 'state');
  clone = join(root, 'clone');
  bin = join(root, 'bin');
  log = join(root, 'git.log');
  await mkdir(clone);
  await mkdir(bin);
});
afterEach(() => rm(root, { recursive: true, force: true }));

async function fakeGit(body: string): Promise<NodeJS.ProcessEnv> {
  const script = join(bin, 'git');
  await writeFile(script, `#!/bin/sh\n${body}\n`);
  await chmod(script, 0o755);
  return { PATH: `${bin}:/usr/bin:/bin` };
}

/** A clock that only the injected sleep advances, recording every sleep. */
function fakeClock(onSleep?: (index: number) => Promise<void> | void) {
  let now = 1_000_000;
  const sleeps: number[] = [];
  return {
    sleeps,
    nowMs: () => now,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      now += ms;
      await onSleep?.(sleeps.length);
    },
  };
}

async function holdLock(): Promise<() => Promise<void>> {
  await mkdir(stateRoot, { recursive: true });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let acquired!: () => void;
  const ready = new Promise<void>((resolve) => (acquired = resolve));
  const held = withLock(join(stateRoot, 'tick.lock'), { wait: true }, async () => {
    acquired();
    await gate;
  });
  await ready;
  return async () => {
    release();
    await held;
  };
}

describe('fileRepairFetchClone: the fetch call', () => {
  it('runs `git fetch --prune --quiet origin` in the clone and returns null on success', async () => {
    const env = await fakeGit(`echo "$@" > "${log}"; pwd >> "${log}"; exit 0`);
    const fetch = fileRepairFetchClone({ stateRoot, clone, env });
    expect(await fetch()).toBeNull();
    const [argv, cwd] = (await readFile(log, 'utf8')).trim().split('\n');
    expect(argv).toBe('fetch --prune --quiet origin');
    expect(realpathSync(cwd ?? '')).toBe(realpathSync(clone));
    expect(existsSync(join(stateRoot, 'tick.lock'))).toBe(true);
  });

  it('reports a non-zero exit as `clone fetch failed: <stderr.strip()>`', async () => {
    const env = await fakeGit(`printf '  fatal: no route\\n\\n' >&2; exit 128`);
    expect(await fileRepairFetchClone({ stateRoot, clone, env })()).toBe(
      'clone fetch failed: fatal: no route',
    );
  });

  it('reports a failure with empty stderr as the bare prefix', async () => {
    const env = await fakeGit('exit 1');
    expect(await fileRepairFetchClone({ stateRoot, clone, env })()).toBe('clone fetch failed: ');
  });

  it('reports a signal death as a failed fetch', async () => {
    const env = await fakeGit(`echo killed >&2; kill -9 $$`);
    expect(await fileRepairFetchClone({ stateRoot, clone, env })()).toBe(
      'clone fetch failed: killed',
    );
  });

  it("renders Python's TimeoutExpired text and kills the whole process group", async () => {
    const pidFile = join(root, 'child.pid');
    const env = await fakeGit(`sleep 30 & echo $! > "${pidFile}"; wait`);
    const result = await fileRepairFetchClone({
      stateRoot,
      clone,
      env,
      fetchTimeoutMs: 150,
      termGraceMs: 2_000,
    })();
    expect(result).toBe(
      "clone fetch failed: Command '['git', 'fetch', '--prune', '--quiet', 'origin']' timed out after 0.15 seconds",
    );
    const grandchild = Number((await readFile(pidFile, 'utf8')).trim());
    await expect.poll(() => alive(grandchild), { timeout: 2_000 }).toBe(false);
  });

  it('escalates to SIGKILL when the fetch ignores SIGTERM', async () => {
    const env = await fakeGit(`trap '' TERM; sleep 30`);
    const started = Date.now();
    const result = await fileRepairFetchClone({
      stateRoot,
      clone,
      env,
      fetchTimeoutMs: 100,
      termGraceMs: 150,
    })();
    expect(result).toMatch(/^clone fetch failed: Command '.*' timed out after 0\.1 seconds$/u);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("renders Python's OSError text for a missing git, missing clone and file clone", async () => {
    const emptyBin = join(root, 'empty');
    await mkdir(emptyBin);
    expect(await fileRepairFetchClone({ stateRoot, clone, env: { PATH: emptyBin } })()).toBe(
      "clone fetch failed: [Errno 2] No such file or directory: 'git'",
    );
    const env = await fakeGit('exit 0');
    const missing = join(root, 'absent');
    expect(await fileRepairFetchClone({ stateRoot, clone: missing, env })()).toBe(
      `clone fetch failed: [Errno 2] No such file or directory: '${missing}'`,
    );
    const file = join(root, 'a-file');
    await writeFile(file, '');
    expect(await fileRepairFetchClone({ stateRoot, clone: file, env })()).toBe(
      `clone fetch failed: [Errno 20] Not a directory: '${file}'`,
    );
  });

  it.skipIf(process.getuid?.() === 0)(
    'names the clone for an unsearchable clone and git for an inaccessible git',
    async () => {
      const env = await fakeGit('exit 0');
      const sealed = join(root, 'sealed');
      await mkdir(sealed);
      await chmod(sealed, 0o000);
      try {
        expect(await fileRepairFetchClone({ stateRoot, clone: sealed, env })()).toBe(
          `clone fetch failed: [Errno 13] Permission denied: '${sealed}'`,
        );
      } finally {
        await chmod(sealed, 0o755);
      }
      // Only `bin` on PATH: a non-executable `git` is otherwise skipped for a later one.
      await chmod(join(bin, 'git'), 0o644);
      expect(await fileRepairFetchClone({ stateRoot, clone, env: { PATH: bin } })()).toBe(
        "clone fetch failed: [Errno 13] Permission denied: 'git'",
      );
    },
  );

  it('turns an injected runner that throws into `clone fetch failed: <message>`', async () => {
    const fetch = fileRepairFetchClone({
      stateRoot,
      clone,
      runFetch: () => Promise.reject(new Error('boom')),
    });
    expect(await fetch()).toBe('clone fetch failed: boom');
  });

  it('creates the state directory like `lock_path.parent.mkdir(parents=True)`', async () => {
    const nested = join(root, 'deep', 'er', 'state');
    const fetch = fileRepairFetchClone({
      stateRoot: nested,
      clone,
      runFetch: async () => ({ code: 0, stderr: '' }),
    });
    expect(await fetch()).toBeNull();
    expect(existsSync(join(nested, 'tick.lock'))).toBe(true);
  });
});

describe('fileRepairFetchClone: the lock', () => {
  it('holds tick.lock across the whole fetch and releases it afterwards', async () => {
    let busyDuringFetch = false;
    const fetch = fileRepairFetchClone({
      stateRoot,
      clone,
      runFetch: async () => {
        await withLock(join(stateRoot, 'tick.lock'), { wait: false }, async () => undefined).catch(
          (error: unknown) => {
            busyDuringFetch = error instanceof SlotBusyError;
          },
        );
        return { code: 0, stderr: '' };
      },
    });
    expect(await fetch()).toBeNull();
    expect(busyDuringFetch).toBe(true);
    // Released: a second non-blocking take succeeds.
    await withLock(join(stateRoot, 'tick.lock'), { wait: false }, async () => undefined);
  });

  it('releases the lock when the fetch fails', async () => {
    const fetch = fileRepairFetchClone({
      stateRoot,
      clone,
      runFetch: () => Promise.reject(new Error('nope')),
    });
    expect(await fetch()).toBe('clone fetch failed: nope');
    await withLock(join(stateRoot, 'tick.lock'), { wait: false }, async () => undefined);
  });

  it('skips with the busy text and never runs git when the wait is 0', async () => {
    const env = await fakeGit(`echo ran > "${log}"`);
    const release = await holdLock();
    try {
      const fetch = fileRepairFetchClone({
        stateRoot,
        clone,
        env,
        tickLockWait: async () => JsonNumber.int(0),
      });
      expect(await fetch()).toBe(BUSY);
      expect(existsSync(log)).toBe(false);
    } finally {
      await release();
    }
  });

  it('polls in sleeps of min(5 s, remaining) and gives up at the deadline', async () => {
    const release = await holdLock();
    try {
      const clock = fakeClock();
      const fetch = fileRepairFetchClone({
        stateRoot,
        clone,
        tickLockWait: async () => JsonNumber.int(12),
        runFetch: () => Promise.reject(new Error('must not run')),
        ...clock,
      });
      expect(await fetch()).toBe(BUSY);
      expect(clock.sleeps).toEqual([5_000, 5_000, 2_000]);
    } finally {
      await release();
    }
  });

  it('fetches once the tick releases the lock mid-wait', async () => {
    const release = await holdLock();
    let released = false;
    const clock = fakeClock(async (index) => {
      if (index === 2 && !released) {
        released = true;
        await release();
      }
    });
    let fetches = 0;
    const fetch = fileRepairFetchClone({
      stateRoot,
      clone,
      tickLockWait: async () => JsonNumber.int(60),
      runFetch: async () => {
        fetches += 1;
        return { code: 0, stderr: '' };
      },
      ...clock,
    });
    expect(await fetch()).toBeNull();
    expect(clock.sleeps).toEqual([5_000, 5_000]);
    expect(fetches).toBe(1);
  });

  it('defaults the wait to 300 s when the key is absent', async () => {
    const release = await holdLock();
    try {
      const clock = fakeClock();
      const fetch = fileRepairFetchClone({
        stateRoot,
        clone,
        runFetch: () => Promise.reject(new Error('must not run')),
        ...clock,
      });
      expect(await fetch()).toBe(BUSY);
      expect(clock.sleeps).toHaveLength(60);
      expect(clock.sleeps.every((ms) => ms === 5_000)).toBe(true);
    } finally {
      await release();
    }
  });

  it('accepts a float wait, a bool wait and a negative wait like Python arithmetic', async () => {
    const release = await holdLock();
    try {
      const run = async (value: Wait) => {
        const clock = fakeClock();
        const result = await fileRepairFetchClone({
          stateRoot,
          clone,
          tickLockWait: value,
          runFetch: () => Promise.reject(new Error('must not run')),
          ...clock,
        })();
        return { result, sleeps: clock.sleeps };
      };
      expect(await run(async () => JsonNumber.float(0.3))).toEqual({ result: BUSY, sleeps: [300] });
      expect(await run(async () => true)).toEqual({ result: BUSY, sleeps: [1_000] });
      expect(await run(async () => false)).toEqual({ result: BUSY, sleeps: [] });
      expect(await run(async () => JsonNumber.int(-5))).toEqual({ result: BUSY, sleeps: [] });
    } finally {
      await release();
    }
  });

  it("raises Python's TypeError text for a wait that cannot be added to a float", async () => {
    const cases: [Wait, string][] = [
      [async () => null, 'NoneType'],
      [async () => '10', 'str'],
      [async () => [JsonNumber.int(1)], 'list'],
      [async () => new JsonObject([]), 'dict'],
    ];
    for (const [tickLockWait, kind] of cases) {
      const fetch = fileRepairFetchClone({
        stateRoot,
        clone,
        tickLockWait,
        runFetch: async () => ({ code: 0, stderr: '' }),
      });
      await expect(fetch()).rejects.toThrow(
        `unsupported operand type(s) for +: 'float' and '${kind}'`,
      );
    }
    await expect(
      fileRepairFetchClone({
        stateRoot,
        clone,
        tickLockWait: async () => JsonNumber.int(`1${'0'.repeat(400)}`),
      })(),
    ).rejects.toThrow('int too large to convert to float');
  });

  it('rejects, rather than skipping the pass, when the lock itself cannot be opened', async () => {
    await mkdir(join(stateRoot, 'tick.lock'), { recursive: true });
    const fetch = fileRepairFetchClone({
      stateRoot,
      clone,
      runFetch: async () => ({ code: 0, stderr: '' }),
    });
    await expect(fetch()).rejects.toMatchObject({ code: 'EISDIR' });
  });

  it('does not retry an error the held fetch section throws', async () => {
    let calls = 0;
    const fetch = fileRepairFetchClone({
      stateRoot,
      clone,
      runFetch: async (): Promise<FetchCallResult> => {
        calls += 1;
        throw new SlotBusyError('inner');
      },
    });
    // A thrown SlotBusyError is a fetch failure (Python `except Exception`), once.
    expect(await fetch()).toBe('clone fetch failed: inner');
    expect(calls).toBe(1);
  });
});

describe('fileRepairAdmissionLock', () => {
  it('returns the admission value and creates the state directory', async () => {
    const lock = fileRepairAdmissionLock({ stateRoot: join(root, 'nested', 'state') });
    expect(await lock(async () => 42)).toBe(42);
    expect(existsSync(join(root, 'nested', 'state', 'tick.lock'))).toBe(true);
  });

  it('holds tick.lock for exactly the admission and releases it on rejection', async () => {
    const lock = fileRepairAdmissionLock({ stateRoot });
    let busyInside = false;
    await expect(
      lock(async () => {
        await withLock(join(stateRoot, 'tick.lock'), { wait: false }, async () => undefined).catch(
          (error: unknown) => {
            busyInside = error instanceof SlotBusyError;
          },
        );
        throw new Error('admission failed');
      }),
    ).rejects.toThrow('admission failed');
    expect(busyInside).toBe(true);
    await withLock(join(stateRoot, 'tick.lock'), { wait: false }, async () => undefined);
  });

  it('serialises admissions: the second starts only after the first returns', async () => {
    const lock = fileRepairAdmissionLock({ stateRoot });
    const events: string[] = [];
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const first = lock(async () => {
      events.push('first:in');
      await gate;
      events.push('first:out');
    });
    await expect.poll(() => events.length).toBe(1);
    const second = lock(async () => {
      events.push('second:in');
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(events).toEqual(['first:in']);
    open();
    await Promise.all([first, second]);
    expect(events).toEqual(['first:in', 'first:out', 'second:in']);
  });

  it('waits without a bound while the tick holds the lock, then admits', async () => {
    const release = await holdLock();
    const lock = fileRepairAdmissionLock({ stateRoot });
    let admitted = false;
    const pending = lock(async () => {
      admitted = true;
      return 'ok';
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(admitted).toBe(false);
    await release();
    expect(await pending).toBe('ok');
    expect(admitted).toBe(true);
  });

  it('excludes a fetch while admitting, and the fetch then proceeds', async () => {
    const lock = fileRepairAdmissionLock({ stateRoot });
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    let inside!: () => void;
    const entered = new Promise<void>((resolve) => (inside = resolve));
    const admission = lock(async () => {
      inside();
      await gate;
    });
    await entered;
    const clock = fakeClock();
    const busy = await fileRepairFetchClone({
      stateRoot,
      clone,
      tickLockWait: async () => JsonNumber.int(0),
      runFetch: () => Promise.reject(new Error('must not run')),
      ...clock,
    })();
    expect(busy).toBe(BUSY);
    open();
    await admission;
    const after = await fileRepairFetchClone({
      stateRoot,
      clone,
      runFetch: async () => ({ code: 0, stderr: '' }),
    })();
    expect(after).toBeNull();
  });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
