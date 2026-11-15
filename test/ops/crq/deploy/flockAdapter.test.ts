import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import {
  BUSY_EXIT,
  flockArgs,
  flockLockFs,
  type FlockProc,
} from '../../../../src/ops/crq/deploy/flockAdapter.js';

function fake() {
  const s = {
    args: [] as string[][],
    stdoutCb: undefined as unknown as (chunk: string) => void,
    exitCb: undefined as unknown as (code: number | null) => void,
    errCb: undefined as unknown as (e: Error) => void,
    closed: 0,
    killed: 0,
  };
  const spawnFn = (args: readonly string[]): FlockProc => {
    s.args.push([...args]);
    return {
      onStdout: (cb) => void (s.stdoutCb = cb),
      onExit: (cb) => void (s.exitCb = cb),
      onError: (cb) => void (s.errCb = cb),
      closeStdin: () => void s.closed++,
      kill: () => void s.killed++,
    };
  };
  return { s, fs: (grace = 5_000) => flockLockFs({ spawn: spawnFn, releaseGraceMs: grace }) };
}

describe('flockLockFs with a fake process', () => {
  test('runs flock -x -n with a distinct busy status on the lock path', async () => {
    const f = fake();
    const p = f.fs().tryLock('/x/deploy.lock');
    f.s.exitCb(BUSY_EXIT);
    await p;
    expect(f.s.args[0]!.slice(0, 5)).toEqual([
      '-x',
      '-n',
      '-E',
      String(BUSY_EXIT),
      '/x/deploy.lock',
    ]);
    expect(f.s.args[0]).toEqual(flockArgs('/x/deploy.lock'));
  });
  test('resolves a handle only after the child prints held, even across chunks', async () => {
    const f = fake();
    let settled = false;
    const p = f
      .fs()
      .tryLock('/l')
      .then((h) => ((settled = true), h));
    f.s.stdoutCb('he');
    await Promise.resolve();
    expect(settled).toBe(false);
    f.s.stdoutCb('ld\n');
    expect(await p).not.toBeNull();
  });
  test('busy exit is null; any other exit or a spawn error rejects', async () => {
    const a = fake();
    const pa = a.fs().tryLock('/l');
    a.s.exitCb(BUSY_EXIT);
    expect(await pa).toBeNull();
    const b = fake();
    const pb = b.fs().tryLock('/l');
    b.s.exitCb(1);
    await expect(pb).rejects.toThrow('flock(1) exited 1 before acquiring /l');
    const c = fake();
    const pc = c.fs().tryLock('/l');
    c.s.errCb(new Error('spawn flock ENOENT'));
    await expect(pc).rejects.toThrow('cannot run flock(1) for /l: spawn flock ENOENT');
  });
  test('release closes stdin, waits for the exit, and is idempotent', async () => {
    const f = fake();
    const p = f.fs().tryLock('/l');
    f.s.stdoutCb('held\n');
    const h = (await p)!;
    let done = false;
    const r1 = h.release().then(() => (done = true));
    const r2 = h.release();
    await Promise.resolve();
    expect(f.s.closed).toBe(1);
    expect(done).toBe(false);
    f.s.exitCb(0);
    await Promise.all([r1, r2]);
    expect(f.s.closed).toBe(1);
    expect(f.s.killed).toBe(0);
  });
  test('release after the child already exited resolves without hanging', async () => {
    const f = fake();
    const p = f.fs(10_000).tryLock('/l');
    f.s.stdoutCb('held\n');
    const h = (await p)!;
    f.s.exitCb(1);
    await h.release();
    expect(f.s.closed).toBe(0);
  });
  test('a child that ignores EOF is killed after the grace period', async () => {
    const f = fake();
    const p = f.fs(10).tryLock('/l');
    f.s.stdoutCb('held\n');
    const h = (await p)!;
    const r = h.release();
    await new Promise((res) => setTimeout(res, 40));
    expect(f.s.killed).toBe(1);
    f.s.exitCb(null);
    await r;
  });
});

const has = (cmd: string, args: string[]): boolean =>
  spawnSync(cmd, args, { stdio: 'ignore' }).status === 0;
const flockOk = has('flock', ['--version']);
const pythonOk = flockOk && has('python3', ['-I', '-c', 'import fcntl']);
const dir = mkdtempSync(join(tmpdir(), 'flock-adapter-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe.skipIf(!flockOk)('flockLockFs with real flock(1)', () => {
  test('a second adapter refuses while held and acquires after release', async () => {
    const path = join(dir, 'a.lock');
    const first = (await flockLockFs().tryLock(path))!;
    expect(first).not.toBeNull();
    expect(await flockLockFs().tryLock(path)).toBeNull();
    await first.release();
    const again = await flockLockFs().tryLock(path);
    expect(again).not.toBeNull();
    await again!.release();
  });
  test('the lock dies with the holder: closing stdin of a killed parent frees it', async () => {
    const path = join(dir, 'b.lock');
    const holder = spawn('flock', flockArgs(path) as string[], {
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    await new Promise((res) => holder.stdout.once('data', res));
    expect(await flockLockFs().tryLock(path)).toBeNull();
    holder.stdin.end();
    await new Promise((res) => holder.once('exit', res));
    const free = await flockLockFs().tryLock(path);
    expect(free).not.toBeNull();
    await free!.release();
  });
});

const PY_HOLD =
  'import fcntl,sys\nf=open(sys.argv[1],"a+")\nfcntl.flock(f.fileno(),fcntl.LOCK_EX|fcntl.LOCK_NB)\nprint("held",flush=True)\nsys.stdin.read()\n';
const PY_TRY =
  'import fcntl,sys\nf=open(sys.argv[1],"a+")\ntry:\n    fcntl.flock(f.fileno(),fcntl.LOCK_EX|fcntl.LOCK_NB)\nexcept OSError:\n    sys.exit(0)\nsys.exit(1)\n';

describe.skipIf(!pythonOk)('interop with Python fcntl.flock', () => {
  test('TypeScript refuses while Python holds, and acquires once Python exits', async () => {
    const path = join(dir, 'py-holds.lock');
    const py = spawn('python3', ['-I', '-c', PY_HOLD, path], {
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    await new Promise((res) => py.stdout.once('data', res));
    expect(await flockLockFs().tryLock(path)).toBeNull();
    py.stdin.end();
    await new Promise((res) => py.once('exit', res));
    const h = await flockLockFs().tryLock(path);
    expect(h).not.toBeNull();
    await h!.release();
  });
  test('Python refuses while TypeScript holds, and acquires after release', async () => {
    const path = join(dir, 'ts-holds.lock');
    const h = (await flockLockFs().tryLock(path))!;
    const r = spawnSync('python3', ['-I', '-c', PY_TRY, path]);
    expect(r.status).toBe(0); // exit 0 = Python was refused
    await h.release();
    expect(spawnSync('python3', ['-I', '-c', PY_TRY, path]).status).toBe(1);
  });
});
