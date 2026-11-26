// Process mechanism of `startWorker`: real `spawn`ed children running the stub
// entry (test/helpers/repairWorkerStub.mjs). Every scenario ends with the child
// exiting on its own; the tests await `exit` and never signal a child. The only
// signal is a stub killing itself, to reach the signal-death branch.
import { existsSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, test, vi } from 'vitest';
import { closeSync, openSync, readSync } from 'node:fs';
import {
  fileRepairWorkerStarter,
  RepairWorkerFdUnavailableError,
  workerExitFromStatus,
  MAX_WORKER_PAYLOAD_BYTES,
  ownedWorkerCount,
  type RepairWorkerLaunch,
} from '../../../src/adapters/crq/repairWorkerProcess.js';
import {
  drainItems,
  type RepairDrainEffects,
  type RepairWorkerHandle,
} from '../../../src/ops/crq/internal/repairDrain.js';

const fsSpy = vi.hoisted(() => ({ reads: [] as number[] }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readSync: ((fd: number, ...rest: unknown[]) => {
      fsSpy.reads.push(fd);
      return (actual.readSync as (...a: unknown[]) => number)(fd, ...rest);
    }) as typeof actual.readSync,
  };
});
const spawnHook = vi.hoisted(() => ({ tweak: null as null | ((pipe: unknown) => void) }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: ((...args: Parameters<typeof actual.spawn>) => {
      const child = actual.spawn(...args);
      spawnHook.tweak?.(child.stdio[3]);
      return child;
    }) as typeof actual.spawn,
  };
});

const STUB = fileURLToPath(new URL('../../helpers/repairWorkerStub.mjs', import.meta.url));
const SOURCE = fileURLToPath(
  new URL('../../../src/adapters/crq/repairWorkerProcess.ts', import.meta.url),
);

interface Scenario {
  publish?: string[];
  exit?: number;
  signal?: string;
  fdsTo?: string;
  holdUntil?: string;
  afterRelease?: string[];
  reportTo?: string;
  grandchild?: boolean;
}

const dirs: string[] = [];
async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'repair-worker-'));
  dirs.push(dir);
  return dir;
}
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

const starter = (
  scenarios: Record<string, Scenario>,
  launch: Partial<RepairWorkerLaunch> = {},
  stateRoot = tmpdir(),
) =>
  fileRepairWorkerStarter({
    stateRoot,
    clone: join(stateRoot, 'clone'),
    configText: JSON.stringify(scenarios),
    launch: { entry: STUB, ...launch },
  });

describe('startWorker process mechanism', () => {
  test('an admitted worker that exits 0', async () => {
    const h = starter({ i: { publish: ['a'] } })('i', ['j']);
    expect(await h.admitted).toBe(true);
    expect(await h.exit).toEqual({ kind: 'exit', code: 0 });
    expect(h.takeRefusal()).toBe(false);
  });

  test('a first refusal byte is not admitted', async () => {
    const h = starter({ i: { publish: ['x'], exit: 3 } })('i', ['j']);
    expect(await h.admitted).toBe(false);
    expect(await h.exit).toEqual({ kind: 'exit', code: 3 });
    expect(h.takeRefusal()).toBe(false);
  });

  test('any byte after the first is a refusal, taken once', async () => {
    for (const second of ['x', 'q']) {
      const h = starter({ i: { publish: ['a', second] } })('i', ['j']);
      expect(await h.admitted).toBe(true);
      await h.exit;
      // The bytes are written before exit, but delivery is an event-loop turn away.
      for (let spins = 0; spins < 200 && !h.takeRefusal(); spins += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (spins === 199) throw new Error('refusal never delivered');
      }
      expect(h.takeRefusal()).toBe(false);
    }
  });

  test('a first byte other than a is a refusal', async () => {
    const h = starter({ i: { publish: ['z'] } })('i', ['j']);
    expect(await h.admitted).toBe(false);
    await h.exit;
  });

  test('exit before any byte reads as end-of-file: not admitted', async () => {
    const h = starter({ i: { exit: 1 } })('i', ['j']);
    expect(await h.admitted).toBe(false);
    expect(await h.exit).toEqual({ kind: 'exit', code: 1 });
  });

  test.each([1, 2, 3, 7])('exit code %i is reported as that code', async (code) => {
    const h = starter({ i: { publish: ['a'], exit: code } })('i', ['j']);
    expect(await h.exit).toEqual({ kind: 'exit', code });
  });

  test('a worker that kills itself is reported by signal number', async () => {
    const h = starter({ i: { publish: ['a'], signal: 'SIGKILL' } })('i', ['j']);
    expect(await h.exit).toEqual({ kind: 'signal', signal: 9 });
  });

  test('relative stateRoot and clone reach the child absolute, and the child runs in stateRoot', async () => {
    const dir = await tmp();
    const report = join(dir, 'report.json');
    const rel = relative(process.cwd(), dir);
    const h = starter({ i: { publish: ['a'], reportTo: report } }, {}, rel)('i', ['j']);
    await h.exit;
    const seen = JSON.parse(await readFile(report, 'utf8')) as Record<string, string>;
    expect(seen['stateRoot']).toBe(dir);
    expect(seen['clone']).toBe(join(dir, 'clone'));
    expect(await realpath(seen['cwd'] ?? '')).toBe(await realpath(dir));
  });

  test('takeRefusal sees a refusal already in the socket before the loop delivers it', async () => {
    const dir = await tmp();
    const release = join(dir, 'release');
    const done = join(dir, 'done');
    const h = starter({
      i: { publish: ['a'], holdUntil: release, afterRelease: ['x'], reportTo: done },
    })('i', ['j']);
    expect(await h.admitted).toBe(true);
    await writeFile(release, '');
    // Wait (blocking the loop, bounded) until the child has written the byte and exited its body.
    const cell = new Int32Array(new SharedArrayBuffer(4));
    for (let spins = 0; spins < 400 && !existsSync(done); spins += 1) Atomics.wait(cell, 0, 0, 10);
    expect(existsSync(done)).toBe(true);
    // No await since the byte was written: only a direct socket read can see it.
    expect(h.takeRefusal()).toBe(true);
    await h.exit;
  });

  test('a missing entry or interpreter throws synchronously', () => {
    expect(() => starter({}, { entry: '/nonexistent/entry.mjs' })('i', ['j'])).toThrow(/ENOENT/);
    expect(() => starter({}, { execPath: '/nonexistent/node' })('i', ['j'])).toThrow(/ENOENT/);
  });

  test('an oversized payload throws before any spawn', () => {
    const before = ownedWorkerCount();
    const big = 'x'.repeat(MAX_WORKER_PAYLOAD_BYTES);
    expect(() => starter({ i: { publish: [big] } })('i', ['j'])).toThrow(
      'repair worker payload too large',
    );
    expect(ownedWorkerCount()).toBe(before);
  });

  test('ownedWorkerCount tracks spawned workers until they exit', async () => {
    const dir = await tmp();
    const release = join(dir, 'release');
    const before = ownedWorkerCount();
    const h = starter({ i: { publish: ['a'], holdUntil: release } })('i', ['j']);
    expect(ownedWorkerCount()).toBe(before + 1);
    expect(await h.admitted).toBe(true);
    await writeFile(release, '');
    await h.exit;
    expect(ownedWorkerCount()).toBe(before);
  });

  test("a worker inherits no other worker's pipe, and its cwd is the state root", async () => {
    const dir = await tmp();
    const release = join(dir, 'release');
    const fdsTo = join(dir, 'fds.json');
    const start = starter(
      { a: { publish: ['a'], holdUntil: release }, b: { publish: ['a'], fdsTo } },
      {},
      dir,
    );
    const first = start('a', ['j']);
    expect(await first.admitted).toBe(true);
    const second = start('b', ['j']);
    await second.exit;
    await writeFile(release, '');
    await first.exit;
    const fds = JSON.parse(await readFile(fdsTo, 'utf8')) as { fd: number; target: string }[];
    expect(fds.slice(0, 4).map((f) => f.fd)).toEqual([0, 1, 2, 3]);
    expect(fds[0]!.target).toBe('/dev/null');
    expect(fds[3]!.target).toMatch(/^socket:/);
    // Node's own descriptors are anon inodes and pipes; any other socket would be a leaked pipe.
    expect(fds.slice(4).filter((f) => f.target.startsWith('socket:'))).toEqual([]);
  });

  test('the module has no kill, signal or timeout path', async () => {
    const source = (await readFile(SOURCE, 'utf8'))
      .split('\n')
      .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
      .join('\n');
    expect(source).not.toMatch(
      /\.kill\(|process\.kill|SIGTERM|SIGKILL|\btimeout\s*:|AbortController|AbortSignal|detached|unref/,
    );
  });
});

describe('drainItems over real workers', () => {
  const effects = (starterFn: RepairDrainEffects['startWorker'], said: string[]) =>
    ({
      runnerDisabled: async () => false,
      narrate: (m: string) => void said.push(m),
      maxConcurrentItems: async () => undefined,
      dispatchPaused: async () => null,
      blocked: () => false,
      withAdmissionLock: async <T>(admission: () => Promise<T>) => admission(),
      startWorker: starterFn,
    }) as unknown as RepairDrainEffects;
  const groups = (...items: string[]) => new Map(items.map((i) => [i, [`${i}-job`]]));

  test('a worker whose pipe has no descriptor is registered and reaped, not orphaned', async () => {
    spawnHook.tweak = (pipe) =>
      Object.defineProperty((pipe as { _handle: object })._handle, 'fd', { value: undefined });
    const before = ownedWorkerCount();
    const base = starter({ a: { publish: ['a'] }, b: { publish: ['a'] } });
    const started: string[] = [];
    const said: string[] = [];
    let failures: string[];
    try {
      failures = await drainItems(
        effects((item, ids) => {
          started.push(item);
          return base(item, ids);
        }, said),
        groups('a', 'b'),
        ['a', 'b'],
        2,
      );
    } finally {
      spawnHook.tweak = null;
    }
    // Returns the failure (Python's stop-and-reap), rather than rejecting.
    expect(started).toEqual(['a']);
    expect(failures).toEqual(['a']);
    expect(said.join('\n')).toContain('worker exit status lost');
    expect(ownedWorkerCount()).toBe(before);
  });

  test('a crash stops further admission, the other worker is reaped, the failure is returned', async () => {
    const dir = await tmp();
    const release = join(dir, 'release');
    const started: string[] = [];
    const base = starter({
      a: { publish: ['a'], holdUntil: release },
      b: { publish: ['a'], exit: 9 },
      c: { publish: ['a'] },
    });
    const said: string[] = [];
    const run = drainItems(
      effects((item, ids) => {
        started.push(item);
        return base(item, ids);
      }, said),
      groups('a', 'b', 'c'),
      ['a', 'b', 'c'],
      2,
    );
    // b crashes while a is still held; c must never start.
    for (
      let spins = 0;
      spins < 400 && !said.includes('repair item b: worker exited with code 9');
      spins += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await writeFile(release, '');
    expect(await run).toEqual(['b']);
    expect(started).toEqual(['a', 'b']);
    expect(ownedWorkerCount()).toBe(0);
  });

  test('a launch failure on the second worker still reaps the first', async () => {
    const dir = await tmp();
    const release = join(dir, 'release');
    const good = starter({ a: { publish: ['a'], holdUntil: release } });
    let exited = false;
    let first: RepairWorkerHandle | undefined;
    const said: string[] = [];
    const run = drainItems(
      effects((item, ids) => {
        if (item === 'b') {
          // Let `a` finish only after the failure has been raised.
          writeFileSync(release, '');
          throw new Error('fork failed');
        }
        first = good(item, ids);
        first.exit
          .then(() => {
            exited = true;
          })
          .catch(() => undefined);
        return first;
      }, said),
      groups('a', 'b'),
      ['a', 'b'],
      2,
    );
    await expect(run).rejects.toThrow('fork failed');
    expect(exited).toBe(true);
    expect(ownedWorkerCount()).toBe(0);
  });
});

describe('pipe descriptor lifecycle', () => {
  const settle = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));

  test('takeRefusal never reads after the pipe is closed, even if the number was reused', async () => {
    const h = starter({ i: { publish: ['a'] } })('i', ['j']);
    expect(await h.admitted).toBe(true);
    fsSpy.reads.length = 0;
    h.takeRefusal();
    const fd = fsSpy.reads[0];
    await h.exit;
    await settle();
    // Hold files open until one receives the closed pipe's old number.
    const probe = join(await tmp(), 'f');
    writeFileSync(probe, 'unrelated file contents');
    const opened: number[] = [];
    let reused = -1;
    for (let i = 0; i < 64 && reused !== fd; i += 1) {
      reused = openSync(probe, 'r');
      opened.push(reused);
    }
    try {
      fsSpy.reads.length = 0;
      expect(h.takeRefusal()).toBe(false);
      expect(fsSpy.reads).toEqual([]);
      if (reused === fd) {
        const rest = Buffer.alloc(64);
        expect(readSync(reused, rest, 0, 64, null)).toBe(23); // none of it was consumed
      }
    } finally {
      for (const f of opened) closeSync(f);
    }
  });

  test('a grandchild holding fd 3 does not keep the coordinator end open after the exit', async () => {
    const handles = () =>
      process.getActiveResourcesInfo().filter((name) => name === 'PipeWrap').length;
    const before = handles();
    const h = starter({ i: { publish: ['a'], grandchild: true } })('i', ['j']);
    expect(await h.admitted).toBe(true);
    expect(await h.exit).toEqual({ kind: 'exit', code: 0 });
    await settle();
    expect(handles()).toBe(before);
  });

  test('a byte written just before exit is still delivered when the end is destroyed', async () => {
    const h = starter({ i: { publish: ['a', 'x'] } })('i', ['j']);
    expect(await h.admitted).toBe(true);
    await h.exit;
    expect(h.takeRefusal()).toBe(true);
  });

  test('a pipe with no descriptor at start still yields a reapable handle that fails loudly', async () => {
    spawnHook.tweak = (pipe) =>
      Object.defineProperty((pipe as { _handle: object })._handle, 'fd', { value: undefined });
    const before = ownedWorkerCount();
    let h: RepairWorkerHandle;
    try {
      h = starter({ i: { publish: ['a'] } })('i', ['j']);
    } finally {
      spawnHook.tweak = null;
    }
    expect(ownedWorkerCount()).toBe(before + 1);
    expect(h.takeRefusal()).toBe(true); // latches the stop; never throws into the drain
    expect(await h.exit).toEqual({ kind: 'lost' });
    expect(ownedWorkerCount()).toBe(before);
  });

  test('a descriptor lost while the pipe is live stops admission and ends lost, without throwing', async () => {
    const dir = await tmp();
    const release = join(dir, 'release');
    let captured: { _handle: object } | undefined;
    spawnHook.tweak = (pipe) => {
      captured = pipe as { _handle: object };
    };
    const h = starter({ i: { publish: ['a'], holdUntil: release } })('i', ['j']);
    spawnHook.tweak = null;
    expect(await h.admitted).toBe(true);
    expect(h.takeRefusal()).toBe(false);
    Object.defineProperty(captured!._handle, 'fd', { value: undefined });
    expect(h.takeRefusal()).toBe(true);
    await writeFile(release, '');
    expect(await h.exit).toEqual({ kind: 'lost' });
  });

  test('an unrecognised signal name is a signal death, not a lost exit', () => {
    expect(workerExitFromStatus(null, 'SIGNOPE')).toEqual({ kind: 'signal', signal: 0 });
    expect(workerExitFromStatus(null, 'SIGKILL')).toEqual({ kind: 'signal', signal: 9 });
    expect(workerExitFromStatus(null, null)).toEqual({ kind: 'lost' });
    expect(workerExitFromStatus(3, null)).toEqual({ kind: 'exit', code: 3 });
  });
});
