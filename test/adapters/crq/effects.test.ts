import { afterEach, expect, test } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, open, readFile, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withLock } from '../../../src/adapters/crq/lock.js';
import { atomicWrite, cleanupAtomicTemps } from '../../../src/adapters/crq/atomic.js';
import { groupAlive, launchDetached } from '../../../src/adapters/crq/process.js';
import { review, usage } from '../../../src/adapters/crq/coderabbit.js';

const dirs: string[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await once(child, 'exit');
    }
  }
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function dir() {
  const path = await mkdtemp(join(tmpdir(), 'crq-effects-'));
  dirs.push(path);
  return path;
}

test('shares flock with Python and blocking acquisition leaves the event loop responsive', async () => {
  const path = join(await dir(), 'tick.lock');
  const child = spawn(
    'python3',
    [
      '-u',
      '-c',
      'import fcntl,sys,time; f=open(sys.argv[1],"w"); fcntl.flock(f,fcntl.LOCK_EX); print("ready",flush=True); time.sleep(30)',
      path,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  children.push(child);
  await once(child.stdout, 'data');
  await expect(withLock(path, { wait: false }, async () => 1)).rejects.toThrow('busy');
  let entered = false;
  const pending = withLock(path, { wait: true }, async () => {
    entered = true;
    return 42;
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(entered).toBe(false);
  child.kill('SIGKILL');
  await once(child, 'exit');
  expect(await pending).toBe(42);
  await expect(
    withLock(path, { wait: false }, async () => {
      throw new Error('callback');
    }),
  ).rejects.toThrow('callback');
  expect(await withLock(path, { wait: false }, async () => 3)).toBe(3);
});

test('atomic replacement preserves bytes and removes temporary files after rename failure', async () => {
  const root = await dir();
  const path = join(root, 'state');
  await atomicWrite(path, 'hello\n');
  expect(await readFile(path, 'utf8')).toBe('hello\n');
  await expect(atomicWrite(root, 'cannot replace directory')).rejects.toThrow();
  expect(
    (await readdir(join(root, '..'))).filter((name) =>
      name.startsWith(`.${root.split('/').at(-1)}.`),
    ),
  ).toEqual([]);
});

test('detached group remains live after launch and disappears after termination', async () => {
  const root = await dir();
  const out = await open(join(root, 'log'), 'w');
  const pid = await launchDetached(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
    cwd: root,
    stdout: out.fd,
    stderr: out.fd,
  });
  await out.close();
  try {
    expect(groupAlive(pid)).toBe(true);
    process.kill(-pid, 'SIGKILL');
    for (let n = 0; n < 100 && groupAlive(pid); n++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(groupAlive(pid)).toBe(false);
  } finally {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
  await expect(
    launchDetached(join(root, 'missing'), [], { cwd: root, stdout: 1, stderr: 2 }),
  ).rejects.toThrow();
});

test('fake CLI receives exact arguments and review stream is classified', async () => {
  const root = await dir();
  const binary = join(root, 'fake-cli');
  await writeFile(
    binary,
    '#!/usr/bin/env node\nconsole.error(JSON.stringify(process.argv.slice(2))); console.log(JSON.stringify(process.argv[2] === "usage" ? {includedReviews:{remaining:2}} : {type:"complete",status:"review_completed"}));\n',
    { mode: 0o755 },
  );
  const u = await usage({ cwd: root, binary });
  expect(JSON.parse(u.stderr)).toEqual(['usage', '--agent']);
  const result = await review(['--agent', '--deep', '--base-commit', 'abc'], { cwd: root, binary });
  expect(JSON.parse(result.stderr)).toEqual([
    'review',
    '--agent',
    '--deep',
    '--base-commit',
    'abc',
  ]);
  expect(result.verdict).toEqual({ kind: 'terminal' });
});

test('cleanup removes only old adapter temps under the writer lock', async () => {
  const root = await dir();
  const target = join(root, 'queue.json');
  const old = join(root, '.queue.json.11111111-1111-4111-8111-111111111111.tmp');
  const recent = join(root, '.queue.json.22222222-2222-4222-8222-222222222222.tmp');
  const link = join(root, '.queue.json.33333333-3333-4333-8333-333333333333.tmp');
  const unrelated = join(root, '.queue.json.other.tmp');
  const pythonTemp = join(root, '.queue.jsonabcdefgh');
  await Promise.all([
    writeFile(old, 'old'),
    writeFile(recent, 'recent'),
    writeFile(unrelated, 'other'),
    writeFile(pythonTemp, 'python'),
  ]);
  await symlink(unrelated, link);
  await utimes(old, new Date(0), new Date(0));
  await utimes(pythonTemp, new Date(0), new Date(0));
  expect(
    await withLock(join(root, 'tick.lock'), { wait: true }, () =>
      cleanupAtomicTemps(target, Date.now() - 1000),
    ),
  ).toBe(1);
  expect(await readdir(root)).toEqual(
    expect.arrayContaining(['queue.json.other.tmp'].map((n) => `.${n}`)),
  );
  expect(await readFile(pythonTemp, 'utf8')).toBe('python');
  expect(
    await withLock(join(root, 'tick.lock'), { wait: true }, () =>
      cleanupAtomicTemps(target, Date.now() - 1000, { includePythonTemps: true }),
    ),
  ).toBe(1);
  expect(await readFile(recent, 'utf8')).toBe('recent');
  expect(await readFile(link, 'utf8')).toBe('other');
});

test('group remains alive when its leader exits but a descendant remains', async () => {
  const root = await dir();
  const log = await open(join(root, 'log'), 'w');
  const script = `const {spawn}=require('node:child_process'); const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); console.log(c.pid); c.unref(); setTimeout(()=>process.exit(0),100);`;
  const pid = await launchDetached(process.execPath, ['-e', script], {
    cwd: root,
    stdout: log.fd,
    stderr: log.fd,
  });
  await log.close();
  try {
    for (let n = 0; n < 100 && !(await readFile(join(root, 'log'), 'utf8')).trim(); n++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(groupAlive(pid)).toBe(true);
  } finally {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      /* gone */
    }
  }
});

test('no fresh review stays blocked with the migration reason', async () => {
  const root = await dir();
  const binary = join(root, 'fake-cli');
  await writeFile(
    binary,
    '#!/usr/bin/env node\nconsole.log(JSON.stringify({type:"complete",status:"review_completed",message:"No fresh detailed file review was performed in this run."}));\n',
    { mode: 0o755 },
  );
  const result = await review(['--agent'], { cwd: root, binary });
  expect(result.verdict.kind).toBe('blocked');
  expect(result.reason).toBe('skipped:no-fresh');
});

test('multiple blocking waiters do not starve the holder filesystem release', async () => {
  const path = join(await dir(), 'tick.lock');
  let release!: () => void;
  let held!: () => void;
  const ready = new Promise<void>((resolve) => {
    held = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const holder = withLock(path, { wait: true }, async () => {
    held();
    await gate;
  });
  await ready;
  let running = 0;
  let count = 0;
  const waiters = Array.from({ length: 5 }, () =>
    withLock(path, { wait: true }, async () => {
      expect(++running).toBe(1);
      await new Promise((resolve) => setTimeout(resolve, 10));
      count++;
      running--;
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  release();
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      Promise.all([holder, ...waiters]),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('waiters deadlocked')), 3000);
      }),
    ]);
    expect(count).toBe(5);
  } finally {
    if (timer) clearTimeout(timer);
  }
});

test('timed-out CLI ignores SIGTERM but is killed and drained', async () => {
  const root = await dir();
  const binary = join(root, 'fake-cli');
  const pidfile = join(root, 'pid');
  await writeFile(
    binary,
    `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(pidfile)},String(process.pid)); process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);\n`,
    { mode: 0o755 },
  );
  await expect(usage({ cwd: root, binary, timeoutMs: 500 })).rejects.toThrow('timed out');
  const pid = Number(await readFile(pidfile, 'utf8'));
  expect(() => process.kill(pid, 0)).toThrow();
});
