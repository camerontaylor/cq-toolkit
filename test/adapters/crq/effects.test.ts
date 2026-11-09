import { afterEach, expect, test } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withLock } from '../../../src/adapters/crq/lock.js';
import { atomicWrite } from '../../../src/adapters/crq/atomic.js';
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
